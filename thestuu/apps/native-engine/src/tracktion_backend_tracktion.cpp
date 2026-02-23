#include "tracktion_backend.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cmath>
#include <functional>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <tracktion_engine/tracktion_engine.h>
#include <tracktion_core/utilities/tracktion_Tempo.h>
#include <tracktion_core/utilities/tracktion_TimeRange.h>

namespace thestuu::native {

class GlobalSpectrumAnalyzerTap;

struct BackendState {
  std::unique_ptr<juce::ScopedJuceInitialiser_GUI> juce;
  std::unique_ptr<tracktion::engine::Engine> engine;
  std::unique_ptr<tracktion::engine::Edit> edit;
  double sampleRate = 48000.0;
  int bufferSize = 256;
  std::unordered_map<std::string, juce::PluginDescription> pluginByUid;
  std::unordered_map<std::string, std::vector<PluginParameterInfo>> parameterCacheByUid;
  std::unique_ptr<GlobalSpectrumAnalyzerTap> spectrumAnalyzerTap;
};

std::unique_ptr<BackendState> gState;

tracktion::engine::AudioTrack* getAudioTrackByIndex(int32_t trackId);
void transportRebuildGraphOnly();

namespace {

constexpr int32_t kDefaultTrackCount = 16;
constexpr const char* kUltrasoundUid = "internal:ultrasound";
struct TracktionCorePluginSpec {
  const char* uid;
  const char* displayName;
  const char* xmlTypeName;
  bool isInstrument;
};

constexpr std::array<TracktionCorePluginSpec, 10> kTracktionCorePluginSpecs = {{
  {"internal:tracktion:4bandEq", "Tracktion Equaliser", "4bandEq", false},
  {"internal:tracktion:compressor", "Tracktion Compressor/Limiter", "compressor", false},
  {"internal:tracktion:reverb", "Tracktion Reverb", "reverb", false},
  {"internal:tracktion:delay", "Tracktion Delay", "delay", false},
  {"internal:tracktion:chorus", "Tracktion Chorus", "chorus", false},
  {"internal:tracktion:phaser", "Tracktion Phaser", "phaser", false},
  {"internal:tracktion:pitchShifter", "Tracktion Pitch Shifter", "pitchShifter", false},
  {"internal:tracktion:lowpass", "Tracktion Low Pass", "lowpass", false},
  {"internal:tracktion:4osc", "Tracktion Four Osc", "4osc", true},
  {"internal:tracktion:sampler", "Tracktion Sampler", "sampler", true},
}};

const TracktionCorePluginSpec* findTracktionCorePluginSpecByUid(const std::string& uid) {
  const auto it = std::find_if(
    kTracktionCorePluginSpecs.begin(),
    kTracktionCorePluginSpecs.end(),
    [&uid](const TracktionCorePluginSpec& spec) {
      return uid == spec.uid;
    }
  );
  if (it == kTracktionCorePluginSpecs.end()) {
    return nullptr;
  }
  return &(*it);
}

juce::PluginDescription createTracktionCorePluginDescription(const TracktionCorePluginSpec& spec) {
  juce::PluginDescription description;
  description.name = juce::String::fromUTF8(spec.displayName);
  description.pluginFormatName = tracktion::engine::PluginManager::builtInPluginFormatName;
  description.category = spec.isInstrument ? "Synth" : "Effect";
  description.manufacturerName = "Tracktion Software Corporation";
  description.fileOrIdentifier = spec.xmlTypeName;
  return description;
}

double estimateBeatsPerBar() {
  if (!gState || !gState->edit) {
    return 4.0;
  }
  auto timeZero = tracktion::core::TimePosition::fromSeconds(0.0);
  const int num = gState->edit->tempoSequence.getTimeSigAt(timeZero).numerator.get();
  return static_cast<double>(std::max(1, num));
}

tracktion::core::TimePosition convertBeatsToTime(double beats) {
  if (!gState || !gState->edit) {
    return tracktion::core::TimePosition::fromSeconds(0.0);
  }
  const auto& sequence = gState->edit->tempoSequence.getInternalSequence();
  return sequence.toTime(tracktion::core::BeatPosition::fromBeats(beats));
}

}  // namespace

class GlobalSpectrumAnalyzerTap final : public juce::AudioIODeviceCallback {
 public:
  static constexpr int kCaptureRingSize = 1 << 16;
  static constexpr int kWindowSize = 2048;
  static constexpr int kBinCount = 96;

  void audioDeviceAboutToStart(juce::AudioIODevice* device) override {
    if (device != nullptr) {
      sampleRateHz.store(device->getCurrentSampleRate(), std::memory_order_relaxed);
      outputChannels.store(device->getActiveOutputChannels().countNumberOfSetBits(), std::memory_order_relaxed);
    }
  }

  void audioDeviceStopped() override {}

  void audioDeviceIOCallbackWithContext(
    const float* const* /*inputChannelData*/,
    int /*numInputChannels*/,
    float* const* outputChannelData,
    int numOutputChannels,
    int numSamples,
    const juce::AudioIODeviceCallbackContext& /*context*/
  ) override {
    if (outputChannelData == nullptr || numOutputChannels <= 0 || numSamples <= 0) {
      return;
    }

    outputChannels.store(numOutputChannels, std::memory_order_relaxed);
    uint64_t writePos = writeCounter.load(std::memory_order_relaxed);
    for (int sample = 0; sample < numSamples; ++sample) {
      float mono = 0.0F;
      int contributingChannels = 0;
      for (int channel = 0; channel < numOutputChannels; ++channel) {
        const float* channelData = outputChannelData[channel];
        if (channelData == nullptr) {
          continue;
        }
        mono += channelData[sample];
        ++contributingChannels;
      }
      if (contributingChannels > 1) {
        mono /= static_cast<float>(contributingChannels);
      }

      ringBuffer[static_cast<size_t>(writePos & (kCaptureRingSize - 1))] = mono;
      ++writePos;
    }

    writeCounter.store(writePos, std::memory_order_release);
    lastWriteTimestampMs.store(
      static_cast<int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count()),
      std::memory_order_relaxed
    );
  }

  bool getSnapshot(SpectrumAnalyzerSnapshot& out) {
    out = {};
    const double sampleRate = sampleRateHz.load(std::memory_order_relaxed);
    const uint64_t writePos = writeCounter.load(std::memory_order_acquire);
    if (!std::isfinite(sampleRate) || sampleRate <= 0.0 || writePos < static_cast<uint64_t>(kWindowSize)) {
      return false;
    }

    std::array<float, kWindowSize> window{};
    for (int i = 0; i < kWindowSize; ++i) {
      const uint64_t idx = writePos - static_cast<uint64_t>(kWindowSize) + static_cast<uint64_t>(i);
      window[static_cast<size_t>(i)] = ringBuffer[static_cast<size_t>(idx & (kCaptureRingSize - 1))];
    }

    // Hann window for a smoother analyzer curve (reduces leakage).
    for (int i = 0; i < kWindowSize; ++i) {
      const double phase = static_cast<double>(i) / static_cast<double>(kWindowSize - 1);
      const float hann = static_cast<float>(0.5 - 0.5 * std::cos(juce::MathConstants<double>::twoPi * phase));
      window[static_cast<size_t>(i)] *= hann;
    }

    prepareTargetFrequencies(sampleRate);
    if (targetFrequenciesHz.empty()) {
      return false;
    }

    const std::vector<float> rawDb = computeSpectrumDb(window, sampleRate);
    if (rawDb.empty()) {
      return false;
    }

    if (smoothedDb.size() != rawDb.size()) {
      smoothedDb = rawDb;
    } else {
      constexpr float riseAlpha = 0.34F;
      constexpr float fallAlpha = 0.16F;
      for (size_t i = 0; i < rawDb.size(); ++i) {
        const float target = rawDb[i];
        const float current = smoothedDb[i];
        const float alpha = target > current ? riseAlpha : fallAlpha;
        smoothedDb[i] = current + ((target - current) * alpha);
      }
    }

    out.available = true;
    out.preMirrorsPost = true;
    out.scope = "master";
    out.channels = "mono";
    out.sampleRate = sampleRate;
    out.fftSize = kWindowSize;
    out.minDb = -96.0;
    out.maxDb = 6.0;
    out.timestamp = lastWriteTimestampMs.load(std::memory_order_relaxed);
    out.freqsHz = targetFrequenciesHz;
    out.postDb = smoothedDb;
    out.preDb = out.postDb;
    return true;
  }

 private:
  void prepareTargetFrequencies(double sampleRate) {
    const double nyquist = std::max(1000.0, sampleRate * 0.5);
    const double maxFreq = std::min(20000.0, nyquist * 0.92);
    const double minFreq = 20.0;
    const bool needsRebuild = targetFrequenciesHz.size() != kBinCount
      || !std::isfinite(cachedSampleRate)
      || std::abs(cachedSampleRate - sampleRate) > 1.0
      || !std::isfinite(cachedMaxFreq)
      || std::abs(cachedMaxFreq - maxFreq) > 1.0;
    if (!needsRebuild) {
      return;
    }

    cachedSampleRate = sampleRate;
    cachedMaxFreq = maxFreq;
    targetFrequenciesHz.clear();
    targetFrequenciesHz.reserve(kBinCount);

    const double ratio = maxFreq / minFreq;
    for (int i = 0; i < kBinCount; ++i) {
      const double t = kBinCount <= 1 ? 0.0 : static_cast<double>(i) / static_cast<double>(kBinCount - 1);
      const double freq = minFreq * std::pow(ratio, t);
      targetFrequenciesHz.push_back(static_cast<float>(freq));
    }
  }

  std::vector<float> computeSpectrumDb(const std::array<float, kWindowSize>& window, double sampleRate) const {
    std::vector<float> out;
    out.reserve(targetFrequenciesHz.size());

    for (float freqHz : targetFrequenciesHz) {
      const double omega = juce::MathConstants<double>::twoPi * static_cast<double>(freqHz) / sampleRate;
      const double coeff = 2.0 * std::cos(omega);
      double sPrev = 0.0;
      double sPrev2 = 0.0;
      for (float sample : window) {
        const double s = static_cast<double>(sample) + (coeff * sPrev) - sPrev2;
        sPrev2 = sPrev;
        sPrev = s;
      }
      const double power = std::max(0.0, (sPrev * sPrev) + (sPrev2 * sPrev2) - (coeff * sPrev * sPrev2));
      const double magnitude = std::sqrt(power) / static_cast<double>(kWindowSize);
      const double db = 20.0 * std::log10(std::max(1.0e-6, magnitude));
      out.push_back(static_cast<float>(juce::jlimit(-96.0, 6.0, db)));
    }

    return out;
  }

  std::array<float, kCaptureRingSize> ringBuffer{};
  std::atomic<uint64_t> writeCounter{0};
  std::atomic<double> sampleRateHz{48000.0};
  std::atomic<int> outputChannels{0};
  std::atomic<int64_t> lastWriteTimestampMs{0};
  double cachedSampleRate = 0.0;
  double cachedMaxFreq = 0.0;
  std::vector<float> targetFrequenciesHz;
  std::vector<float> smoothedDb;
};

namespace {

class UltrasoundPlugin final : public tracktion::engine::FourOscPlugin {
 public:
  explicit UltrasoundPlugin(tracktion::engine::PluginCreationInfo info)
    : tracktion::engine::FourOscPlugin(std::move(info)) {}

  static const char* getPluginName() {
    return NEEDS_TRANS("Ultrasound");
  }

  static const char* xmlTypeName;

  juce::String getName() const override {
    return TRANS("Ultrasound");
  }

  juce::String getPluginType() override {
    return xmlTypeName;
  }

  juce::String getShortName(int) override {
    return "Ultra";
  }

  juce::String getSelectableDescription() override {
    return TRANS("Ultrasound Plugin");
  }
};

const char* UltrasoundPlugin::xmlTypeName = "ultrasound";

#if JUCE_LINUX
constexpr bool kShouldAddPluginWindowToDesktop = false;
#else
constexpr bool kShouldAddPluginWindowToDesktop = true;
#endif

juce::String buildPlainLanguageHint(const tracktion::engine::AutomatableParameter& parameter) {
  const juce::String searchText = (parameter.getParameterName() + " " + parameter.paramID).toLowerCase();

  if (searchText.contains("freq") || searchText.contains("hz")) {
    return "Wo im Klang du eingreifst (tiefe bis hohe Toene).";
  }
  if (searchText.contains("gain") || searchText.contains("level") || searchText.contains("db")) {
    return "Wie stark der Bereich angehoben oder abgesenkt wird.";
  }
  if (searchText.contains("q") || searchText.contains("width") || searchText.contains("band")) {
    return "Wie breit oder eng der Eingriff klingt.";
  }
  if (searchText.contains("threshold")) {
    return "Ab welchem Pegel der Effekt aktiv wird.";
  }
  if (searchText.contains("ratio")) {
    return "Wie stark die Kompression wirkt.";
  }
  if (searchText.contains("attack")) {
    return "Wie schnell der Effekt einsetzt.";
  }
  if (searchText.contains("release")) {
    return "Wie schnell der Effekt wieder loslaesst.";
  }
  if (searchText.contains("mix") || searchText.contains("dry") || searchText.contains("wet")) {
    return "Mischung aus Originalsignal und Effekt.";
  }
  if (searchText.contains("time") || searchText.contains("delay")) {
    return "Zeit bis das Echo oder die Wirkung hoerbar ist.";
  }
  return "Direkt hoerbar einstellen: bewegen und vergleichen.";
}

class EqualiserFallbackEditor final : public tracktion::engine::Plugin::EditorComponent,
                                      private juce::AsyncUpdater,
                                      private tracktion::engine::AutomatableParameter::Listener {
 public:
  enum class ViewMode {
    easy,
    pro,
  };

  enum class EasyPreset {
    cleanUp,
    vocalClarity,
    bassTight,
    airBrilliance,
  };

  explicit EqualiserFallbackEditor(tracktion::engine::EqualiserPlugin& pluginToControl)
    : equaliser(pluginToControl),
      bands({
        Band{pluginToControl.loFreq, pluginToControl.loGain, pluginToControl.loQ, "Low", juce::Colour(0xFF5FE28A)},
        Band{pluginToControl.midFreq1, pluginToControl.midGain1, pluginToControl.midQ1, "Mid 1", juce::Colour(0xFF74C0FF)},
        Band{pluginToControl.midFreq2, pluginToControl.midGain2, pluginToControl.midQ2, "Mid 2", juce::Colour(0xFFFFC658)},
        Band{pluginToControl.hiFreq, pluginToControl.hiGain, pluginToControl.hiQ, "High", juce::Colour(0xFFFF8AA5)},
      }) {
    titleLabel.setText("Equalizer", juce::dontSendNotification);
    titleLabel.setFont(juce::Font(juce::FontOptions(18.0F, juce::Font::bold)));
    titleLabel.setJustificationType(juce::Justification::centredLeft);
    addAndMakeVisible(titleLabel);

    subtitleLabel.setJustificationType(juce::Justification::centredLeft);
    subtitleLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.78F));
    addAndMakeVisible(subtitleLabel);

    configureModeButton(easyModeButton, "Easy");
    easyModeButton.setClickingTogglesState(true);
    easyModeButton.setRadioGroupId(88041);
    easyModeButton.setToggleState(true, juce::dontSendNotification);
    easyModeButton.onClick = [safe = juce::Component::SafePointer<EqualiserFallbackEditor>(this)] {
      if (safe != nullptr) {
        safe->setViewMode(ViewMode::easy);
      }
    };
    addAndMakeVisible(easyModeButton);

    configureModeButton(proModeButton, "Pro");
    proModeButton.setClickingTogglesState(true);
    proModeButton.setRadioGroupId(88041);
    proModeButton.onClick = [safe = juce::Component::SafePointer<EqualiserFallbackEditor>(this)] {
      if (safe != nullptr) {
        safe->setViewMode(ViewMode::pro);
      }
    };
    addAndMakeVisible(proModeButton);

    modeHintLabel.setJustificationType(juce::Justification::centredLeft);
    modeHintLabel.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.88F));
    addAndMakeVisible(modeHintLabel);

    configurePresetButton(presetCleanUpButton, "Clean Up", EasyPreset::cleanUp);
    configurePresetButton(presetVocalButton, "Vocal Klarheit", EasyPreset::vocalClarity);
    configurePresetButton(presetBassButton, "Bass Tight", EasyPreset::bassTight);
    configurePresetButton(presetAirButton, "Air / Brillanz", EasyPreset::airBrilliance);

    configureEasyMacroSlider(mudSlider, mudSliderLabel, mudSliderValueLabel, "Weniger dumpf");
    mudSlider.onValueChange = [safe = juce::Component::SafePointer<EqualiserFallbackEditor>(this)] {
      if (safe != nullptr) {
        safe->handleEasyMacroSliderChanged();
      }
    };

    configureEasyMacroSlider(presenceSlider, presenceSliderLabel, presenceSliderValueLabel, "Mehr Praesenz");
    presenceSlider.onValueChange = [safe = juce::Component::SafePointer<EqualiserFallbackEditor>(this)] {
      if (safe != nullptr) {
        safe->handleEasyMacroSliderChanged();
      }
    };

    configureEasyMacroSlider(softnessSlider, softnessSliderLabel, softnessSliderValueLabel, "Weicher");
    softnessSlider.onValueChange = [safe = juce::Component::SafePointer<EqualiserFallbackEditor>(this)] {
      if (safe != nullptr) {
        safe->handleEasyMacroSliderChanged();
      }
    };

    subtitleLabel.setText("Easy: Presets + wenige starke Regler. Pro: Nodes ziehen, Wheel fuer Q.", juce::dontSendNotification);
    subtitleLabel.setJustificationType(juce::Justification::centredLeft);

    infoLabel.setJustificationType(juce::Justification::centredLeft);
    addAndMakeVisible(infoLabel);

    for (auto& band : bands) {
      if (band.freq != nullptr) band.freq->addListener(this);
      if (band.gain != nullptr) band.gain->addListener(this);
      if (band.q != nullptr) band.q->addListener(this);
    }

    setSize(860, 650);
    syncEasyMacroControlsFromEqState();
    updateModeUi();
    updateInfoLabel();
  }

  ~EqualiserFallbackEditor() override {
    cancelPendingUpdate();
    for (auto& band : bands) {
      if (band.freq != nullptr) band.freq->removeListener(this);
      if (band.gain != nullptr) band.gain->removeListener(this);
      if (band.q != nullptr) band.q->removeListener(this);
    }
  }

  bool allowWindowResizing() override { return true; }
  juce::ComponentBoundsConstrainer* getBoundsConstrainer() override { return {}; }

  void resized() override {
    auto area = getLocalBounds().reduced(14);
    titleLabel.setBounds(area.removeFromTop(26));
    subtitleLabel.setBounds(area.removeFromTop(20));
    area.removeFromTop(6);

    modePanelBounds = area.removeFromTop(34);
    auto modeInner = modePanelBounds.reduced(6, 4);
    proModeButton.setBounds(modeInner.removeFromRight(78));
    modeInner.removeFromRight(6);
    easyModeButton.setBounds(modeInner.removeFromRight(78));
    modeInner.removeFromRight(10);
    modeHintLabel.setBounds(modeInner);

    presetPanelBounds = {};
    easyControlsPanelBounds = {};

    if (viewMode == ViewMode::easy) {
      area.removeFromTop(6);
      presetPanelBounds = area.removeFromTop(34);
      auto presetInner = presetPanelBounds.reduced(6, 4);
      auto layoutPresetButton = [&](juce::TextButton& button, int width) {
        button.setBounds(presetInner.removeFromLeft(width));
        if (presetInner.getWidth() > 0) {
          presetInner.removeFromLeft(4);
        }
      };
      layoutPresetButton(presetCleanUpButton, 104);
      layoutPresetButton(presetVocalButton, 128);
      layoutPresetButton(presetBassButton, 104);
      presetAirButton.setBounds(presetInner);

      area.removeFromTop(6);
      easyControlsPanelBounds = area.removeFromTop(126);
      auto controlsArea = easyControlsPanelBounds.reduced(10, 8);
      layoutEasyMacroRow(controlsArea.removeFromTop(34), mudSliderLabel, mudSlider, mudSliderValueLabel);
      controlsArea.removeFromTop(4);
      layoutEasyMacroRow(controlsArea.removeFromTop(34), presenceSliderLabel, presenceSlider, presenceSliderValueLabel);
      controlsArea.removeFromTop(4);
      layoutEasyMacroRow(controlsArea.removeFromTop(34), softnessSliderLabel, softnessSlider, softnessSliderValueLabel);
    }

    area.removeFromTop(6);
    infoLabel.setBounds(area.removeFromBottom(30));
    graphBounds = area.toFloat().reduced(2.0F);
  }

  void paint(juce::Graphics& g) override {
    const auto bounds = getLocalBounds().toFloat();
    g.setGradientFill(juce::ColourGradient(
      juce::Colour(0xFF121827), bounds.getTopLeft(),
      juce::Colour(0xFF0E1320), bounds.getBottomRight(),
      false
    ));
    g.fillAll();
    drawPanel(g, modePanelBounds.toFloat(), 8.0F, juce::Colour(0x18000000), juce::Colour(0x18FFFFFF));
    if (viewMode == ViewMode::easy) {
      drawPanel(g, presetPanelBounds.toFloat(), 8.0F, juce::Colour(0x14000000), juce::Colour(0x16FFFFFF));
      drawPanel(g, easyControlsPanelBounds.toFloat(), 8.0F, juce::Colour(0x12000000), juce::Colour(0x14FFFFFF));
    }
    drawGraphBackground(g, graphBounds);
    drawResponseCurve(g, graphBounds);
    drawBandNodes(g, graphBounds);
  }

  void mouseMove(const juce::MouseEvent& event) override {
    const int nextHover = graphBounds.contains(event.position) ? findNearestBand(event.position, 24.0F) : -1;
    if (nextHover != hoverBandIndex) {
      hoverBandIndex = nextHover;
      repaint();
    }
  }

  void mouseExit(const juce::MouseEvent&) override {
    hoverBandIndex = -1;
    repaint();
  }

  void mouseDown(const juce::MouseEvent& event) override {
    if (!graphBounds.contains(event.position)) return;
    activeBandIndex = findNearestBand(event.position, 32.0F);
    if (activeBandIndex < 0) activeBandIndex = findNearestBand(event.position, std::numeric_limits<float>::max());
    if (activeBandIndex < 0) return;
    beginBandGesture(activeBandIndex);
    dragInProgress = true;
    applyDragToActiveBand(event.position);
  }

  void mouseDrag(const juce::MouseEvent& event) override {
    if (!dragInProgress || activeBandIndex < 0) return;
    applyDragToActiveBand(event.position);
  }

  void mouseUp(const juce::MouseEvent&) override {
    if (dragInProgress && activeBandIndex >= 0) endBandGesture(activeBandIndex);
    dragInProgress = false;
  }

  void mouseWheelMove(const juce::MouseEvent& event, const juce::MouseWheelDetails& wheel) override {
    if (!graphBounds.contains(event.position)) return;
    int bandIndex = activeBandIndex >= 0 ? activeBandIndex : findNearestBand(event.position, 32.0F);
    if (bandIndex < 0 || bandIndex >= static_cast<int>(bands.size()) || bands[bandIndex].q == nullptr) return;

    const auto qRange = bands[bandIndex].q->getValueRange();
    const float qCurrent = bands[bandIndex].q->getCurrentValue();
    const float qSpan = qRange.getEnd() - qRange.getStart();
    const float delta = static_cast<float>(wheel.deltaY != 0.0F ? wheel.deltaY : wheel.deltaX);
    const float sensitivity = event.mods.isShiftDown() ? 0.08F : 0.2F;
    const float nextQ = juce::jlimit(qRange.getStart(), qRange.getEnd(), qCurrent + (delta * qSpan * sensitivity));

    bands[bandIndex].q->parameterChangeGestureBegin();
    bands[bandIndex].q->setParameter(nextQ, juce::sendNotificationSync);
    bands[bandIndex].q->parameterChangeGestureEnd();

    activeBandIndex = bandIndex;
    updateInfoLabel();
    repaint();
  }

 private:
  struct Band {
    tracktion::engine::AutomatableParameter::Ptr freq;
    tracktion::engine::AutomatableParameter::Ptr gain;
    tracktion::engine::AutomatableParameter::Ptr q;
    juce::String name;
    juce::Colour colour;
  };

  static constexpr float kMinFreq = 20.0F;
  static constexpr float kMaxFreq = 20000.0F;
  static constexpr float kMinGain = -20.0F;
  static constexpr float kMaxGain = 20.0F;
  static constexpr float kEasyMaxMud = 6.0F;
  static constexpr float kEasyMaxPresence = 5.0F;
  static constexpr float kEasyMaxSoftness = 5.0F;

  static float clamp01(float value) {
    return juce::jlimit(0.0F, 1.0F, value);
  }

  static juce::String formatFrequency(float hz) {
    if (hz >= 1000.0F) {
      const float khz = hz / 1000.0F;
      return khz >= 10.0F ? juce::String(khz, 1) + " kHz" : juce::String(khz, 2) + " kHz";
    }
    return juce::String(juce::roundToInt(hz)) + " Hz";
  }

  static juce::String formatGain(float gain) {
    return (gain >= 0.0F ? "+" : "") + juce::String(gain, 1) + " dB";
  }

  static juce::String formatQ(float q) {
    return "Q " + juce::String(q, 2);
  }

  static juce::String formatMacroAmount(float value) {
    const int percent = juce::roundToInt(clamp01(value) * 100.0F);
    return juce::String(percent) + "%";
  }

  static void drawPanel(
    juce::Graphics& g,
    juce::Rectangle<float> bounds,
    float cornerRadius,
    juce::Colour fill,
    juce::Colour stroke
  ) {
    if (bounds.isEmpty()) {
      return;
    }
    g.setColour(fill);
    g.fillRoundedRectangle(bounds, cornerRadius);
    g.setColour(stroke);
    g.drawRoundedRectangle(bounds, cornerRadius, 1.0F);
  }

  static float lerp(float start, float end, float amount) {
    return start + ((end - start) * amount);
  }

  Band* bandForIndex(int index) {
    if (index < 0 || index >= static_cast<int>(bands.size())) return nullptr;
    return &bands[static_cast<size_t>(index)];
  }

  const Band* bandForIndex(int index) const {
    if (index < 0 || index >= static_cast<int>(bands.size())) return nullptr;
    return &bands[static_cast<size_t>(index)];
  }

  float bandFrequency(int index) const {
    if (const auto* band = bandForIndex(index); band != nullptr && band->freq != nullptr) return band->freq->getCurrentValue();
    return 1000.0F;
  }

  float bandGain(int index) const {
    if (const auto* band = bandForIndex(index); band != nullptr && band->gain != nullptr) return band->gain->getCurrentValue();
    return 0.0F;
  }

  float bandQ(int index) const {
    if (const auto* band = bandForIndex(index); band != nullptr && band->q != nullptr) return band->q->getCurrentValue();
    return 1.0F;
  }

  float frequencyToX(float frequency, const juce::Rectangle<float>& graph) const {
    const float clamped = juce::jlimit(kMinFreq, kMaxFreq, frequency);
    const float norm = std::log(clamped / kMinFreq) / std::log(kMaxFreq / kMinFreq);
    return graph.getX() + (norm * graph.getWidth());
  }

  float gainToY(float gain, const juce::Rectangle<float>& graph) const {
    const float clamped = juce::jlimit(kMinGain, kMaxGain, gain);
    const float norm = (kMaxGain - clamped) / (kMaxGain - kMinGain);
    return graph.getY() + (norm * graph.getHeight());
  }

  float xToFrequency(float x, const juce::Rectangle<float>& graph) const {
    const float clampedX = juce::jlimit(graph.getX(), graph.getRight(), x);
    const float norm = (clampedX - graph.getX()) / graph.getWidth();
    return kMinFreq * std::pow((kMaxFreq / kMinFreq), norm);
  }

  float yToGain(float y, const juce::Rectangle<float>& graph) const {
    const float clampedY = juce::jlimit(graph.getY(), graph.getBottom(), y);
    const float norm = (clampedY - graph.getY()) / graph.getHeight();
    return kMaxGain - (norm * (kMaxGain - kMinGain));
  }

  juce::Point<float> bandPoint(int index, const juce::Rectangle<float>& graph) const {
    return { frequencyToX(bandFrequency(index), graph), gainToY(bandGain(index), graph) };
  }

  int findNearestBand(juce::Point<float> position, float maxDistance) const {
    if (graphBounds.isEmpty()) return -1;
    int nearestIndex = -1;
    float nearestDistance = maxDistance;
    for (size_t i = 0; i < bands.size(); ++i) {
      const int bandIndex = static_cast<int>(i);
      const float distance = bandPoint(bandIndex, graphBounds).getDistanceFrom(position);
      if (distance <= nearestDistance) {
        nearestDistance = distance;
        nearestIndex = bandIndex;
      }
    }
    return nearestIndex;
  }

  void beginBandGesture(int index) {
    auto* band = bandForIndex(index);
    if (band == nullptr) return;
    if (band->freq != nullptr) band->freq->parameterChangeGestureBegin();
    if (band->gain != nullptr) band->gain->parameterChangeGestureBegin();
  }

  void endBandGesture(int index) {
    auto* band = bandForIndex(index);
    if (band == nullptr) return;
    if (band->freq != nullptr) band->freq->parameterChangeGestureEnd();
    if (band->gain != nullptr) band->gain->parameterChangeGestureEnd();
  }

  static void setParameterValue(tracktion::engine::AutomatableParameter::Ptr& parameter, float value) {
    if (parameter == nullptr) {
      return;
    }
    const auto range = parameter->getValueRange();
    const float clamped = juce::jlimit(range.getStart(), range.getEnd(), value);
    parameter->setParameter(clamped, juce::sendNotificationSync);
  }

  void applyBandTarget(int index, float frequency, float gain, float q) {
    auto* band = bandForIndex(index);
    if (band == nullptr) {
      return;
    }

    if (band->freq != nullptr) band->freq->parameterChangeGestureBegin();
    if (band->gain != nullptr) band->gain->parameterChangeGestureBegin();
    if (band->q != nullptr) band->q->parameterChangeGestureBegin();

    setParameterValue(band->freq, frequency);
    setParameterValue(band->gain, gain);
    setParameterValue(band->q, q);

    if (band->q != nullptr) band->q->parameterChangeGestureEnd();
    if (band->gain != nullptr) band->gain->parameterChangeGestureEnd();
    if (band->freq != nullptr) band->freq->parameterChangeGestureEnd();
  }

  void applyDragToActiveBand(juce::Point<float> position) {
    auto* band = bandForIndex(activeBandIndex);
    if (band == nullptr || graphBounds.isEmpty()) return;
    const float nextFreq = xToFrequency(position.x, graphBounds);
    const float nextGain = yToGain(position.y, graphBounds);
    if (band->freq != nullptr) {
      const auto range = band->freq->getValueRange();
      band->freq->setParameter(juce::jlimit(range.getStart(), range.getEnd(), nextFreq), juce::sendNotificationSync);
    }
    if (band->gain != nullptr) {
      const auto range = band->gain->getValueRange();
      band->gain->setParameter(juce::jlimit(range.getStart(), range.getEnd(), nextGain), juce::sendNotificationSync);
    }
    updateInfoLabel();
    repaint();
  }

  void configureModeButton(juce::TextButton& button, const juce::String& text) {
    button.setButtonText(text);
    button.setColour(juce::TextButton::buttonColourId, juce::Colour(0x2C141A22));
    button.setColour(juce::TextButton::buttonOnColourId, juce::Colour(0xFF1F7CFF));
    button.setColour(juce::TextButton::textColourOffId, juce::Colours::white.withAlpha(0.92F));
    button.setColour(juce::TextButton::textColourOnId, juce::Colours::white);
  }

  void configurePresetButton(juce::TextButton& button, const juce::String& text, EasyPreset preset) {
    button.setButtonText(text);
    button.setColour(juce::TextButton::buttonColourId, juce::Colour(0x20151B26));
    button.setColour(juce::TextButton::buttonOnColourId, juce::Colour(0x20151B26));
    button.setColour(juce::TextButton::textColourOffId, juce::Colours::white.withAlpha(0.9F));
    button.setColour(juce::TextButton::textColourOnId, juce::Colours::white.withAlpha(0.9F));
    button.onClick = [safe = juce::Component::SafePointer<EqualiserFallbackEditor>(this), preset] {
      if (safe != nullptr) {
        safe->applyEasyPreset(preset);
      }
    };
    addAndMakeVisible(button);
  }

  void configureEasyMacroSlider(
    juce::Slider& slider,
    juce::Label& label,
    juce::Label& valueLabel,
    const juce::String& labelText
  ) {
    label.setText(labelText, juce::dontSendNotification);
    label.setJustificationType(juce::Justification::centredLeft);
    label.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.92F));
    addAndMakeVisible(label);

    valueLabel.setJustificationType(juce::Justification::centredRight);
    valueLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.9F));
    addAndMakeVisible(valueLabel);

    slider.setSliderStyle(juce::Slider::LinearHorizontal);
    slider.setTextBoxStyle(juce::Slider::NoTextBox, false, 0, 0);
    slider.setRange(0.0, 1.0, 0.01);
    slider.setColour(juce::Slider::trackColourId, juce::Colour(0xFF52B3FF));
    slider.setColour(juce::Slider::backgroundColourId, juce::Colour(0x2AFFFFFF));
    slider.setColour(juce::Slider::thumbColourId, juce::Colour(0xFFF5F8FF));
    addAndMakeVisible(slider);
  }

  void layoutEasyMacroRow(
    juce::Rectangle<int> row,
    juce::Label& label,
    juce::Slider& slider,
    juce::Label& valueLabel
  ) {
    auto left = row.removeFromLeft(154);
    label.setBounds(left);
    auto right = row.removeFromRight(54);
    valueLabel.setBounds(right);
    row.removeFromRight(4);
    slider.setBounds(row);
  }

  void setViewMode(ViewMode nextMode) {
    if (viewMode == nextMode) {
      updateModeUi();
      return;
    }
    viewMode = nextMode;
    updateModeUi();
    resized();
    repaint();
  }

  void updateModeUi() {
    const bool easy = viewMode == ViewMode::easy;
    easyModeButton.setToggleState(easy, juce::dontSendNotification);
    proModeButton.setToggleState(!easy, juce::dontSendNotification);

    presetCleanUpButton.setVisible(easy);
    presetVocalButton.setVisible(easy);
    presetBassButton.setVisible(easy);
    presetAirButton.setVisible(easy);
    mudSliderLabel.setVisible(easy);
    mudSlider.setVisible(easy);
    mudSliderValueLabel.setVisible(easy);
    presenceSliderLabel.setVisible(easy);
    presenceSlider.setVisible(easy);
    presenceSliderValueLabel.setVisible(easy);
    softnessSliderLabel.setVisible(easy);
    softnessSlider.setVisible(easy);
    softnessSliderValueLabel.setVisible(easy);

    if (easy) {
      subtitleLabel.setText(
        "Easy: Presets + Alltagssprache. Pro: Wechseln fuer volle Direktkontrolle im Graph.",
        juce::dontSendNotification
      );
      modeHintLabel.setText("Schnell gute Startpunkte: Preset waehlen, dann 3 Regler nach Gehoer.", juce::dontSendNotification);
    } else {
      subtitleLabel.setText(
        "Pro: Nodes ziehen = Frequenz/Gain, Mousewheel = Q, Shift = feinere Schritte.",
        juce::dontSendNotification
      );
      modeHintLabel.setText("Volle Kontrolle direkt im EQ-Graph. Easy-Presets bleiben als Ausgangslage erhalten.", juce::dontSendNotification);
    }
  }

  void handleEasyMacroSliderChanged() {
    if (ignoreEasyMacroCallbacks) {
      return;
    }
    updateEasyMacroValueLabels();
    applyEasyMacros();
    updateInfoLabel();
    repaint();
  }

  void updateEasyMacroValueLabels() {
    mudSliderValueLabel.setText(formatMacroAmount(static_cast<float>(mudSlider.getValue())), juce::dontSendNotification);
    presenceSliderValueLabel.setText(formatMacroAmount(static_cast<float>(presenceSlider.getValue())), juce::dontSendNotification);
    softnessSliderValueLabel.setText(formatMacroAmount(static_cast<float>(softnessSlider.getValue())), juce::dontSendNotification);
  }

  void syncEasyMacroControlsFromEqState() {
    const juce::ScopedValueSetter<bool> guard(ignoreEasyMacroCallbacks, true);

    const float mud = clamp01(-bandGain(1) / kEasyMaxMud);
    const float presence = clamp01(bandGain(2) / kEasyMaxPresence);
    const float softness = clamp01(-bandGain(3) / kEasyMaxSoftness);

    mudSlider.setValue(mud, juce::dontSendNotification);
    presenceSlider.setValue(presence, juce::dontSendNotification);
    softnessSlider.setValue(softness, juce::dontSendNotification);
    updateEasyMacroValueLabels();
  }

  void applyEasyMacros() {
    const float mud = static_cast<float>(mudSlider.getValue());
    const float presence = static_cast<float>(presenceSlider.getValue());
    const float softness = static_cast<float>(softnessSlider.getValue());

    // Easy macros intentionally target mostly separate bands to stay predictable.
    applyBandTarget(0, lerp(95.0F, 125.0F, mud), lerp(0.0F, -2.2F, mud), lerp(0.65F, 0.9F, mud));
    applyBandTarget(1, lerp(220.0F, 340.0F, mud), lerp(0.0F, -kEasyMaxMud, mud), lerp(0.8F, 1.35F, mud));
    applyBandTarget(2, lerp(2200.0F, 3600.0F, presence), lerp(0.0F, kEasyMaxPresence, presence), lerp(0.85F, 1.55F, presence));
    applyBandTarget(3, lerp(14000.0F, 9000.0F, softness), lerp(0.0F, -kEasyMaxSoftness, softness), lerp(0.7F, 1.05F, softness));
  }

  void setEasyMacroValues(float mud, float presence, float softness) {
    const juce::ScopedValueSetter<bool> guard(ignoreEasyMacroCallbacks, true);
    mudSlider.setValue(clamp01(mud), juce::dontSendNotification);
    presenceSlider.setValue(clamp01(presence), juce::dontSendNotification);
    softnessSlider.setValue(clamp01(softness), juce::dontSendNotification);
    updateEasyMacroValueLabels();
  }

  void applyEasyPreset(EasyPreset preset) {
    // Presets shape all four bands first, then sync the Easy controls to the resulting curve.
    switch (preset) {
      case EasyPreset::cleanUp:
        applyBandTarget(0, 110.0F, -1.0F, 0.75F);
        applyBandTarget(1, 290.0F, -3.0F, 1.15F);
        applyBandTarget(2, 3200.0F, 1.2F, 1.05F);
        applyBandTarget(3, 11500.0F, 1.0F, 0.75F);
        activeBandIndex = 1;
        break;
      case EasyPreset::vocalClarity:
        applyBandTarget(0, 115.0F, -1.4F, 0.75F);
        applyBandTarget(1, 300.0F, -2.5F, 1.1F);
        applyBandTarget(2, 3100.0F, 3.6F, 1.35F);
        applyBandTarget(3, 12500.0F, 2.4F, 0.78F);
        activeBandIndex = 2;
        break;
      case EasyPreset::bassTight:
        applyBandTarget(0, 85.0F, -1.4F, 0.82F);
        applyBandTarget(1, 190.0F, -4.0F, 1.2F);
        applyBandTarget(2, 1100.0F, 1.0F, 0.95F);
        applyBandTarget(3, 9500.0F, 0.0F, 0.75F);
        activeBandIndex = 1;
        break;
      case EasyPreset::airBrilliance:
        applyBandTarget(0, 100.0F, 0.0F, 0.7F);
        applyBandTarget(1, 330.0F, -0.8F, 0.95F);
        applyBandTarget(2, 4600.0F, 2.1F, 0.95F);
        applyBandTarget(3, 13200.0F, 4.5F, 0.72F);
        activeBandIndex = 3;
        break;
    }

    syncEasyMacroControlsFromEqState();
    updateInfoLabel();
    repaint();
  }

  void drawGraphBackground(juce::Graphics& g, const juce::Rectangle<float>& graph) const {
    g.setColour(juce::Colour(0xFF0C1018));
    g.fillRoundedRectangle(graph, 8.0F);
    g.setColour(juce::Colour(0x26FFFFFF));
    g.drawRoundedRectangle(graph, 8.0F, 1.0F);

    static constexpr std::array<float, 7> gainLines = {-18.0F, -12.0F, -6.0F, 0.0F, 6.0F, 12.0F, 18.0F};
    for (float gain : gainLines) {
      const float y = gainToY(gain, graph);
      g.setColour(gain == 0.0F ? juce::Colour(0x55A9E8FF) : juce::Colour(0x18FFFFFF));
      g.drawHorizontalLine(juce::roundToInt(y), graph.getX(), graph.getRight());
      g.setColour(juce::Colours::lightgrey.withAlpha(0.45F));
      g.drawText(formatGain(gain), juce::Rectangle<int>(juce::roundToInt(graph.getX()) + 4, juce::roundToInt(y) - 10, 60, 20), juce::Justification::centredLeft, false);
    }

    static constexpr std::array<float, 10> freqLines = {20.0F, 50.0F, 100.0F, 200.0F, 500.0F, 1000.0F, 2000.0F, 5000.0F, 10000.0F, 20000.0F};
    for (float hz : freqLines) {
      const float x = frequencyToX(hz, graph);
      g.setColour(juce::Colour(0x14FFFFFF));
      g.drawVerticalLine(juce::roundToInt(x), graph.getY(), graph.getBottom());
      g.setColour(juce::Colours::lightgrey.withAlpha(0.45F));
      g.drawText(formatFrequency(hz), juce::Rectangle<int>(juce::roundToInt(x) - 26, juce::roundToInt(graph.getBottom()) - 18, 52, 16), juce::Justification::centred, false);
    }
  }

  void drawResponseCurve(juce::Graphics& g, const juce::Rectangle<float>& graph) {
    if (graph.getWidth() <= 2.0F || graph.getHeight() <= 2.0F) return;
    juce::Path path;
    const int widthPixels = juce::roundToInt(graph.getWidth());
    for (int i = 0; i < widthPixels; ++i) {
      const float x = graph.getX() + static_cast<float>(i);
      const float freq = xToFrequency(x, graph);
      const float db = juce::jlimit(kMinGain, kMaxGain, equaliser.getDBGainAtFrequency(freq));
      const float y = gainToY(db, graph);
      if (i == 0) path.startNewSubPath(x, y);
      else path.lineTo(x, y);
    }

    juce::Path fill(path);
    fill.lineTo(graph.getRight(), gainToY(0.0F, graph));
    fill.lineTo(graph.getX(), gainToY(0.0F, graph));
    fill.closeSubPath();
    g.setColour(juce::Colour(0x441BC9FF));
    g.fillPath(fill);

    g.setColour(juce::Colour(0xFF49D2FF));
    g.strokePath(path, juce::PathStrokeType(2.0F, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
  }

  void drawBandNodes(juce::Graphics& g, const juce::Rectangle<float>& graph) const {
    for (size_t i = 0; i < bands.size(); ++i) {
      const int bandIndex = static_cast<int>(i);
      const bool active = bandIndex == activeBandIndex;
      const bool hover = bandIndex == hoverBandIndex;
      const float radius = active ? 8.0F : (hover ? 7.0F : 6.0F);
      const auto p = bandPoint(bandIndex, graph);
      const auto& band = bands[i];

      g.setColour(band.colour.withAlpha(active ? 0.30F : 0.20F));
      g.fillEllipse(p.x - radius - 5.0F, p.y - radius - 5.0F, (radius + 5.0F) * 2.0F, (radius + 5.0F) * 2.0F);

      g.setColour(band.colour);
      g.fillEllipse(p.x - radius, p.y - radius, radius * 2.0F, radius * 2.0F);
      g.setColour(juce::Colours::white.withAlpha(0.95F));
      g.drawEllipse(p.x - radius, p.y - radius, radius * 2.0F, radius * 2.0F, 1.0F);

      g.setColour(juce::Colours::white.withAlpha(0.92F));
      g.drawFittedText(band.name, juce::Rectangle<int>(juce::roundToInt(p.x - 24.0F), juce::roundToInt(p.y - 26.0F), 48, 16), juce::Justification::centred, 1);
    }
  }

  void updateInfoLabel() {
    const int index = juce::jlimit(0, static_cast<int>(bands.size()) - 1, activeBandIndex);
    const auto& band = bands[static_cast<size_t>(index)];
    const juce::String modeHint = viewMode == ViewMode::easy
      ? "Easy: Preset + 3 Regler. Pro: fuer direkte Feinarbeit."
      : "Pro: Ziehen fuer Klangform, Wheel fuer Breite (Q).";
    infoLabel.setText(
      band.name
      + "  |  " + formatFrequency(bandFrequency(index))
      + "  |  " + formatGain(bandGain(index))
      + "  |  " + formatQ(bandQ(index))
      + "  |  Tipp: " + modeHint,
      juce::dontSendNotification
    );
  }

  void handleAsyncUpdate() override {
    syncEasyMacroControlsFromEqState();
    updateInfoLabel();
    repaint();
  }

  void curveHasChanged(tracktion::engine::AutomatableParameter&) override {}
  void currentValueChanged(tracktion::engine::AutomatableParameter&) override { triggerAsyncUpdate(); }
  void parameterChanged(tracktion::engine::AutomatableParameter&, float) override { triggerAsyncUpdate(); }

  tracktion::engine::EqualiserPlugin& equaliser;
  std::array<Band, 4> bands;
  juce::Label titleLabel;
  juce::Label subtitleLabel;
  juce::TextButton easyModeButton;
  juce::TextButton proModeButton;
  juce::Label modeHintLabel;
  juce::TextButton presetCleanUpButton;
  juce::TextButton presetVocalButton;
  juce::TextButton presetBassButton;
  juce::TextButton presetAirButton;
  juce::Label mudSliderLabel;
  juce::Slider mudSlider;
  juce::Label mudSliderValueLabel;
  juce::Label presenceSliderLabel;
  juce::Slider presenceSlider;
  juce::Label presenceSliderValueLabel;
  juce::Label softnessSliderLabel;
  juce::Slider softnessSlider;
  juce::Label softnessSliderValueLabel;
  juce::Label infoLabel;
  juce::Rectangle<float> graphBounds;
  juce::Rectangle<int> modePanelBounds;
  juce::Rectangle<int> presetPanelBounds;
  juce::Rectangle<int> easyControlsPanelBounds;
  ViewMode viewMode = ViewMode::easy;
  int activeBandIndex = 1;
  int hoverBandIndex = -1;
  bool dragInProgress = false;
  bool ignoreEasyMacroCallbacks = false;
};

class ChorusFallbackEditor final : public tracktion::engine::Plugin::EditorComponent,
                                   private juce::Timer,
                                   private juce::AsyncUpdater,
                                   private tracktion::engine::AutomatableParameter::Listener {
 public:
  enum class StylePreset {
    smooth,
    wide,
    tight,
    dream,
  };

  explicit ChorusFallbackEditor(tracktion::engine::ChorusPlugin& pluginToControl)
    : chorus(pluginToControl) {
    depthParam = findParameterByIds({"depthMs", "depth"});
    rateParam = findParameterByIds({"speedHz", "speed"});
    widthParam = findParameterByIds({"width"});
    mixParam = findParameterByIds({"mixProportion", "mix"});

    configureHeaderLabel(titleLabel, "Chorus");
    titleLabel.setFont(juce::Font(juce::FontOptions(20.0F, juce::Font::bold)));
    addAndMakeVisible(titleLabel);

    configureSubLabel(subtitleLabel);
    subtitleLabel.setText(
      "TheStuu Chorus Hero UI: Breite, Bewegung und Blend schnell formen (Fallback fuer Tracktion Chorus).",
      juce::dontSendNotification
    );
    addAndMakeVisible(subtitleLabel);

    configurePanelTitle(motionTitleLabel, "VOICE FIELD");
    addAndMakeVisible(motionTitleLabel);
    configurePanelTitle(modTitleLabel, "MODULATION");
    addAndMakeVisible(modTitleLabel);
    configurePanelTitle(spaceTitleLabel, "SPACE");
    addAndMakeVisible(spaceTitleLabel);
    configurePanelTitle(styleTitleLabel, "STYLE");
    addAndMakeVisible(styleTitleLabel);
    configurePanelTitle(mixTitleLabel, "DRY / WET");
    addAndMakeVisible(mixTitleLabel);

    configureDial(depthDial, "Depth", juce::Colour(0xFF62C7FF));
    configureDial(rateDial, "Rate", juce::Colour(0xFF88A4FF));
    configureDial(widthDial, "Width", juce::Colour(0xFFAE86FF));
    configureDial(mixDial, "Mix", juce::Colour(0xFF7AE9D0));
    configureDialCallbacks();

    configureStyleButton(styleSmoothButton, "Smooth", StylePreset::smooth);
    configureStyleButton(styleWideButton, "Wide", StylePreset::wide);
    configureStyleButton(styleTightButton, "Tight", StylePreset::tight);
    configureStyleButton(styleDreamButton, "Dream", StylePreset::dream);

    readoutLabel.setJustificationType(juce::Justification::topLeft);
    readoutLabel.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.90F));
    readoutLabel.setFont(juce::Font(juce::FontOptions(13.0F)));
    addAndMakeVisible(readoutLabel);

    readoutHintLabel.setJustificationType(juce::Justification::topLeft);
    readoutHintLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.72F));
    readoutHintLabel.setFont(juce::Font(juce::FontOptions(12.0F)));
    readoutHintLabel.setText("Presets setzen musikalische Startpunkte. Danach Width + Mix nach Gehoer einstellen.", juce::dontSendNotification);
    addAndMakeVisible(readoutHintLabel);

    mixBarSlider.setSliderStyle(juce::Slider::LinearHorizontal);
    mixBarSlider.setTextBoxStyle(juce::Slider::NoTextBox, false, 0, 0);
    mixBarSlider.setColour(juce::Slider::trackColourId, juce::Colour(0xFF74E8D4));
    mixBarSlider.setColour(juce::Slider::backgroundColourId, juce::Colour(0x22FFFFFF));
    mixBarSlider.setColour(juce::Slider::thumbColourId, juce::Colour(0xFFF4FCFF));
    mixBarSlider.onDragStart = [safe = juce::Component::SafePointer<ChorusFallbackEditor>(this)] {
      if (safe != nullptr && safe->mixParam != nullptr) {
        safe->mixParam->parameterChangeGestureBegin();
      }
    };
    mixBarSlider.onDragEnd = [safe = juce::Component::SafePointer<ChorusFallbackEditor>(this)] {
      if (safe != nullptr && safe->mixParam != nullptr) {
        safe->mixParam->parameterChangeGestureEnd();
      }
    };
    mixBarSlider.onValueChange = [safe = juce::Component::SafePointer<ChorusFallbackEditor>(this)] {
      if (safe == nullptr || safe->ignoreControlCallbacks) {
        return;
      }
      safe->setParamActual(safe->mixParam, static_cast<float>(safe->mixBarSlider.getValue()));
      safe->updateValueLabels();
      safe->updateReadout();
      safe->repaint();
    };
    addAndMakeVisible(mixBarSlider);

    mixDryLabel.setJustificationType(juce::Justification::centredLeft);
    mixDryLabel.setText("Dry", juce::dontSendNotification);
    mixDryLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.8F));
    addAndMakeVisible(mixDryLabel);

    mixWetLabel.setJustificationType(juce::Justification::centredRight);
    mixWetLabel.setText("Wet", juce::dontSendNotification);
    mixWetLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.8F));
    addAndMakeVisible(mixWetLabel);

    bottomInfoLabel.setJustificationType(juce::Justification::centredLeft);
    bottomInfoLabel.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.78F));
    bottomInfoLabel.setFont(juce::Font(juce::FontOptions(12.0F)));
    addAndMakeVisible(bottomInfoLabel);

    addParameterListener(depthParam);
    addParameterListener(rateParam);
    addParameterListener(widthParam);
    addParameterListener(mixParam);

    configureSliderRangeFromParameter(depthDial.slider, depthParam, 0.1);
    configureSliderRangeFromParameter(rateDial.slider, rateParam, 0.01);
    configureSliderRangeFromParameter(widthDial.slider, widthParam, 0.01);
    configureSliderRangeFromParameter(mixDial.slider, mixParam, 0.01);
    configureSliderRangeFromParameter(mixBarSlider, mixParam, 0.01);

    if (mixParam != nullptr) {
      const auto defaultValue = mixParam->getDefaultValue();
      if (defaultValue.has_value()) {
        mixBarSlider.setDoubleClickReturnValue(true, defaultValue.value());
        mixDial.slider.setDoubleClickReturnValue(true, defaultValue.value());
      }
    }

    setSize(980, 640);
    syncControlsFromParameters();
    updateReadout();
    startTimerHz(30);
  }

  ~ChorusFallbackEditor() override {
    stopTimer();
    removeParameterListener(depthParam);
    removeParameterListener(rateParam);
    removeParameterListener(widthParam);
    removeParameterListener(mixParam);
  }

  bool allowWindowResizing() override { return true; }
  juce::ComponentBoundsConstrainer* getBoundsConstrainer() override { return {}; }

  void resized() override {
    auto area = getLocalBounds().reduced(14);

    titleLabel.setBounds(area.removeFromTop(28));
    subtitleLabel.setBounds(area.removeFromTop(20));
    area.removeFromTop(8);

    motionPanelBounds = area.removeFromTop(180);
    area.removeFromTop(8);

    auto lower = area.removeFromTop(juce::jmax(280, area.getHeight() - 82));
    modPanelBounds = lower.removeFromLeft(220);
    lower.removeFromLeft(8);
    stylePanelBounds = lower.removeFromRight(230);
    lower.removeFromRight(8);
    spacePanelBounds = lower;

    area.removeFromTop(8);
    mixPanelBounds = area;

    auto motionInner = motionPanelBounds.reduced(10);
    motionTitleLabel.setBounds(motionInner.removeFromTop(22));
    motionGraphBounds = motionInner.reduced(2).toFloat();

    auto modInner = modPanelBounds.reduced(10);
    modTitleLabel.setBounds(modInner.removeFromTop(22));
    modWaveBounds = modInner.removeFromTop(104).toFloat().reduced(0.0F, 2.0F);
    modInner.removeFromTop(8);
    layoutDial(depthDial, modInner.removeFromTop(juce::jmin(170, modInner.getHeight())));

    auto spaceInner = spacePanelBounds.reduced(10);
    spaceTitleLabel.setBounds(spaceInner.removeFromTop(22));
    spaceInner.removeFromTop(8);
    const int rowHeight = juce::jmin(220, spaceInner.getHeight());
    auto knobRow = spaceInner.removeFromTop(rowHeight);
    auto leftSmall = knobRow.removeFromLeft(juce::jmax(120, knobRow.getWidth() / 4));
    knobRow.removeFromLeft(8);
    auto rightSmall = knobRow.removeFromRight(juce::jmax(120, knobRow.getWidth() / 3));
    knobRow.removeFromRight(8);
    layoutDial(rateDial, leftSmall);
    layoutDial(widthDial, knobRow);
    layoutDial(mixDial, rightSmall);
    stereoFieldBounds = spaceInner.reduced(4).toFloat();

    auto styleInner = stylePanelBounds.reduced(10);
    styleTitleLabel.setBounds(styleInner.removeFromTop(22));
    styleInner.removeFromTop(6);
    auto styleButtonsGrid = styleInner.removeFromTop(88);
    auto topButtons = styleButtonsGrid.removeFromTop(40);
    auto bottomButtons = styleButtonsGrid.removeFromTop(40);
    layoutTwoButtons(topButtons, styleSmoothButton, styleWideButton);
    layoutTwoButtons(bottomButtons, styleTightButton, styleDreamButton);
    styleInner.removeFromTop(8);
    readoutLabel.setBounds(styleInner.removeFromTop(92));
    readoutHintLabel.setBounds(styleInner.removeFromTop(54));

    auto mixInner = mixPanelBounds.reduced(10);
    mixTitleLabel.setBounds(mixInner.removeFromTop(20));
    mixInner.removeFromTop(4);
    auto mixRow = mixInner.removeFromTop(28);
    mixDryLabel.setBounds(mixRow.removeFromLeft(42));
    mixWetLabel.setBounds(mixRow.removeFromRight(42));
    mixRow.removeFromLeft(6);
    mixRow.removeFromRight(6);
    mixBarSlider.setBounds(mixRow);
    mixInner.removeFromTop(4);
    bottomInfoLabel.setBounds(mixInner.removeFromTop(20));
  }

  void paint(juce::Graphics& g) override {
    const auto bounds = getLocalBounds().toFloat();
    g.setGradientFill(juce::ColourGradient(
      juce::Colour(0xFF0D1320), bounds.getTopLeft(),
      juce::Colour(0xFF090D16), bounds.getBottomRight(),
      false
    ));
    g.fillAll();

    drawBackdropGrid(g, bounds);
    drawPanel(g, motionPanelBounds.toFloat(), 10.0F, juce::Colour(0x1419232E), juce::Colour(0x1CFFFFFF));
    drawPanel(g, modPanelBounds.toFloat(), 10.0F, juce::Colour(0x141A2430), juce::Colour(0x18FFFFFF));
    drawPanel(g, spacePanelBounds.toFloat(), 10.0F, juce::Colour(0x1419232E), juce::Colour(0x18FFFFFF));
    drawPanel(g, stylePanelBounds.toFloat(), 10.0F, juce::Colour(0x1419232E), juce::Colour(0x18FFFFFF));
    drawPanel(g, mixPanelBounds.toFloat(), 10.0F, juce::Colour(0x1218202A), juce::Colour(0x14FFFFFF));

    drawMotionDisplay(g, motionGraphBounds);
    drawModWaveDisplay(g, modWaveBounds);
    drawStereoField(g, stereoFieldBounds);
    drawKnobGlow(g, widthDial.slider, juce::Colour(0x6A9B7CFF));
    drawKnobGlow(g, mixDial.slider, juce::Colour(0x5578F0DA));
    drawKnobGlow(g, rateDial.slider, juce::Colour(0x507EA5FF));
    drawKnobGlow(g, depthDial.slider, juce::Colour(0x504BC5FF));
  }

 private:
  struct DialControl {
    juce::Label nameLabel;
    juce::Slider slider;
    juce::Label valueLabel;
    juce::Colour accent = juce::Colour(0xFF74C0FF);
  };

  static float clamp01(float value) {
    return juce::jlimit(0.0F, 1.0F, value);
  }

  static float lerp(float a, float b, float t) {
    return a + ((b - a) * t);
  }

  static void drawPanel(juce::Graphics& g, juce::Rectangle<float> bounds, float radius, juce::Colour fill, juce::Colour stroke) {
    if (bounds.isEmpty()) {
      return;
    }
    g.setGradientFill(juce::ColourGradient(fill.brighter(0.08F), bounds.getTopLeft(), fill.darker(0.22F), bounds.getBottomLeft(), false));
    g.fillRoundedRectangle(bounds, radius);
    g.setColour(stroke);
    g.drawRoundedRectangle(bounds, radius, 1.0F);
  }

  static void configureHeaderLabel(juce::Label& label, const juce::String& text) {
    label.setText(text, juce::dontSendNotification);
    label.setJustificationType(juce::Justification::centredLeft);
    label.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.95F));
  }

  static void configureSubLabel(juce::Label& label) {
    label.setJustificationType(juce::Justification::centredLeft);
    label.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.78F));
    label.setFont(juce::Font(juce::FontOptions(12.5F)));
  }

  static void configurePanelTitle(juce::Label& label, const juce::String& text) {
    label.setText(text, juce::dontSendNotification);
    label.setJustificationType(juce::Justification::centredLeft);
    label.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.88F));
    label.setFont(juce::Font(juce::FontOptions(12.0F, juce::Font::bold)));
  }

  void configureDial(DialControl& dial, const juce::String& name, juce::Colour accent) {
    dial.accent = accent;

    dial.nameLabel.setText(name.toUpperCase(), juce::dontSendNotification);
    dial.nameLabel.setJustificationType(juce::Justification::centred);
    dial.nameLabel.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.9F));
    dial.nameLabel.setFont(juce::Font(juce::FontOptions(12.0F, juce::Font::bold)));
    addAndMakeVisible(dial.nameLabel);

    dial.valueLabel.setJustificationType(juce::Justification::centred);
    dial.valueLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.82F));
    dial.valueLabel.setFont(juce::Font(juce::FontOptions(12.0F)));
    addAndMakeVisible(dial.valueLabel);

    dial.slider.setSliderStyle(juce::Slider::RotaryHorizontalVerticalDrag);
    dial.slider.setTextBoxStyle(juce::Slider::NoTextBox, false, 0, 0);
    dial.slider.setRotaryParameters(juce::MathConstants<float>::pi * 1.16F, juce::MathConstants<float>::pi * 2.84F, true);
    dial.slider.setColour(juce::Slider::rotarySliderFillColourId, accent);
    dial.slider.setColour(juce::Slider::rotarySliderOutlineColourId, juce::Colour(0x28FFFFFF));
    dial.slider.setColour(juce::Slider::thumbColourId, juce::Colours::white.withAlpha(0.96F));
    addAndMakeVisible(dial.slider);
  }

  void configureDialCallbacks() {
    connectDialToParam(depthDial, [&]() -> tracktion::engine::AutomatableParameter::Ptr& { return depthParam; }());
    connectDialToParam(rateDial, [&]() -> tracktion::engine::AutomatableParameter::Ptr& { return rateParam; }());
    connectDialToParam(widthDial, [&]() -> tracktion::engine::AutomatableParameter::Ptr& { return widthParam; }());
    connectDialToParam(mixDial, [&]() -> tracktion::engine::AutomatableParameter::Ptr& { return mixParam; }());
  }

  void connectDialToParam(DialControl& dial, tracktion::engine::AutomatableParameter::Ptr& parameter) {
    dial.slider.onDragStart = [safe = juce::Component::SafePointer<ChorusFallbackEditor>(this), ptr = &parameter]() {
      if (safe != nullptr && ptr != nullptr && *ptr != nullptr) {
        (*ptr)->parameterChangeGestureBegin();
      }
    };
    dial.slider.onDragEnd = [safe = juce::Component::SafePointer<ChorusFallbackEditor>(this), ptr = &parameter]() {
      if (safe != nullptr && ptr != nullptr && *ptr != nullptr) {
        (*ptr)->parameterChangeGestureEnd();
      }
    };
    dial.slider.onValueChange = [safe = juce::Component::SafePointer<ChorusFallbackEditor>(this), ptr = &parameter, slider = &dial.slider]() {
      if (safe == nullptr || safe->ignoreControlCallbacks || ptr == nullptr || *ptr == nullptr || slider == nullptr) {
        return;
      }
      safe->setParamActual(*ptr, static_cast<float>(slider->getValue()));
      if (*ptr == safe->mixParam) {
        const juce::ScopedValueSetter<bool> guard(safe->ignoreControlCallbacks, true);
        safe->mixBarSlider.setValue(safe->mixDial.slider.getValue(), juce::dontSendNotification);
      }
      safe->updateValueLabels();
      safe->updateReadout();
      safe->repaint();
    };
  }

  void configureStyleButton(juce::TextButton& button, const juce::String& text, StylePreset preset) {
    button.setButtonText(text);
    button.setClickingTogglesState(true);
    button.setRadioGroupId(88420);
    button.setColour(juce::TextButton::buttonColourId, juce::Colour(0x1CFFFFFF));
    button.setColour(juce::TextButton::buttonOnColourId, juce::Colour(0xFF233A67));
    button.setColour(juce::TextButton::textColourOffId, juce::Colours::white.withAlpha(0.88F));
    button.setColour(juce::TextButton::textColourOnId, juce::Colours::white);
    button.onClick = [safe = juce::Component::SafePointer<ChorusFallbackEditor>(this), preset] {
      if (safe != nullptr) {
        safe->applyStylePreset(preset);
      }
    };
    addAndMakeVisible(button);
  }

  void layoutTwoButtons(juce::Rectangle<int> row, juce::TextButton& left, juce::TextButton& right) {
    auto leftArea = row.removeFromLeft((row.getWidth() - 4) / 2);
    row.removeFromLeft(4);
    left.setBounds(leftArea);
    right.setBounds(row);
  }

  void layoutDial(DialControl& dial, juce::Rectangle<int> bounds) {
    auto area = bounds.reduced(4);
    dial.nameLabel.setBounds(area.removeFromTop(18));
    dial.valueLabel.setBounds(area.removeFromBottom(18));
    dial.slider.setBounds(area.reduced(4));
  }

  void configureSliderRangeFromParameter(
    juce::Slider& slider,
    const tracktion::engine::AutomatableParameter::Ptr& parameter,
    double step
  ) {
    if (parameter == nullptr) {
      slider.setRange(0.0, 1.0, step);
      slider.setEnabled(false);
      return;
    }
    const auto range = parameter->getValueRange();
    slider.setRange(range.getStart(), range.getEnd(), step);
    slider.setEnabled(true);
    if (const auto defaultValue = parameter->getDefaultValue(); defaultValue.has_value()) {
      slider.setDoubleClickReturnValue(true, defaultValue.value());
    }
  }

  tracktion::engine::AutomatableParameter::Ptr findParameterByIds(std::initializer_list<const char*> ids) {
    for (int index = 0; index < chorus.getNumAutomatableParameters(); ++index) {
      auto parameter = chorus.getAutomatableParameter(index);
      if (parameter == nullptr) {
        continue;
      }
      const auto id = parameter->paramID.trim().toLowerCase();
      const auto name = parameter->getParameterName().trim().toLowerCase();
      for (const char* rawId : ids) {
        const juce::String needle(rawId);
        if (id.equalsIgnoreCase(needle) || name.equalsIgnoreCase(needle) || id.containsIgnoreCase(needle) || name.containsIgnoreCase(needle)) {
          return parameter;
        }
      }
    }
    return {};
  }

  void addParameterListener(tracktion::engine::AutomatableParameter::Ptr& parameter) {
    if (parameter != nullptr) {
      parameter->addListener(this);
    }
  }

  void removeParameterListener(tracktion::engine::AutomatableParameter::Ptr& parameter) {
    if (parameter != nullptr) {
      parameter->removeListener(this);
    }
  }

  void setParamActual(tracktion::engine::AutomatableParameter::Ptr& parameter, float value) {
    if (parameter == nullptr) {
      return;
    }
    const auto range = parameter->getValueRange();
    parameter->setParameter(juce::jlimit(range.getStart(), range.getEnd(), value), juce::sendNotificationSync);
  }

  float getParamActual(const tracktion::engine::AutomatableParameter::Ptr& parameter, float fallback = 0.0F) const {
    return parameter != nullptr ? parameter->getCurrentValue() : fallback;
  }

  float getParamNormalised(const tracktion::engine::AutomatableParameter::Ptr& parameter, float fallback = 0.0F) const {
    return parameter != nullptr ? parameter->getCurrentNormalisedValue() : fallback;
  }

  static juce::String formatPercent(float value) {
    return juce::String(juce::roundToInt(clamp01(value) * 100.0F)) + "%";
  }

  juce::String formatDepthValue() const {
    if (depthParam == nullptr) return "n/a";
    return juce::String(getParamActual(depthParam), 2) + " ms";
  }

  juce::String formatRateValue() const {
    if (rateParam == nullptr) return "n/a";
    return juce::String(getParamActual(rateParam), 2) + " Hz";
  }

  juce::String formatWidthValue() const {
    return widthParam != nullptr ? formatPercent(getParamActual(widthParam)) : "n/a";
  }

  juce::String formatMixValue() const {
    return mixParam != nullptr ? formatPercent(getParamActual(mixParam)) : "n/a";
  }

  void syncControlsFromParameters() {
    const juce::ScopedValueSetter<bool> guard(ignoreControlCallbacks, true);
    syncDial(depthDial, depthParam);
    syncDial(rateDial, rateParam);
    syncDial(widthDial, widthParam);
    syncDial(mixDial, mixParam);
    if (mixParam != nullptr) {
      mixBarSlider.setValue(getParamActual(mixParam), juce::dontSendNotification);
    }
    updateValueLabels();
    updateReadout();
    updateBottomInfo();
  }

  void syncDial(DialControl& dial, const tracktion::engine::AutomatableParameter::Ptr& parameter) {
    if (parameter == nullptr) {
      dial.slider.setEnabled(false);
      dial.valueLabel.setText("n/a", juce::dontSendNotification);
      return;
    }
    dial.slider.setEnabled(true);
    dial.slider.setValue(parameter->getCurrentValue(), juce::dontSendNotification);
  }

  void updateValueLabels() {
    depthDial.valueLabel.setText(formatDepthValue(), juce::dontSendNotification);
    rateDial.valueLabel.setText(formatRateValue(), juce::dontSendNotification);
    widthDial.valueLabel.setText(formatWidthValue(), juce::dontSendNotification);
    mixDial.valueLabel.setText(formatMixValue(), juce::dontSendNotification);
    updateBottomInfo();
  }

  void updateReadout() {
    const float depthNorm = getParamNormalised(depthParam, 0.25F);
    const float rateNorm = getParamNormalised(rateParam, 0.25F);
    const float widthNorm = getParamNormalised(widthParam, 0.5F);
    const float mixNorm = getParamNormalised(mixParam, 0.5F);
    const int spread = juce::roundToInt(lerp(10.0F, 100.0F, widthNorm));
    const int movement = juce::roundToInt((depthNorm * 0.58F + rateNorm * 0.42F) * 100.0F);
    const int shimmer = juce::roundToInt((mixNorm * 0.55F + widthNorm * 0.45F) * 100.0F);

    readoutLabel.setText(
      "Depth   " + formatDepthValue() + "\n"
      + "Rate    " + formatRateValue() + "\n"
      + "Width   " + formatWidthValue() + "   (Spread " + juce::String(spread) + ")\n"
      + "Mix     " + formatMixValue() + "   (Motion " + juce::String(movement) + " / Shimmer " + juce::String(shimmer) + ")",
      juce::dontSendNotification
    );
  }

  void updateBottomInfo() {
    bottomInfoLabel.setText(
      "Tipp: Depth bestimmt die Schwankung, Rate die Geschwindigkeit, Width die Stereo-Breite, Mix den Effektanteil.",
      juce::dontSendNotification
    );
  }

  void applyStylePreset(StylePreset preset) {
    struct Target {
      float depthMs;
      float speedHz;
      float width;
      float mix;
    };

    Target target{};
    switch (preset) {
      case StylePreset::smooth:
        target = { 2.6F, 0.65F, 0.45F, 0.33F };
        break;
      case StylePreset::wide:
        target = { 4.2F, 0.90F, 0.88F, 0.43F };
        break;
      case StylePreset::tight:
        target = { 1.4F, 1.75F, 0.30F, 0.24F };
        break;
      case StylePreset::dream:
        target = { 6.6F, 0.42F, 0.92F, 0.58F };
        break;
    }

    auto beginEndSet = [&](tracktion::engine::AutomatableParameter::Ptr& parameter, float value) {
      if (parameter == nullptr) return;
      parameter->parameterChangeGestureBegin();
      setParamActual(parameter, value);
      parameter->parameterChangeGestureEnd();
    };

    beginEndSet(depthParam, target.depthMs);
    beginEndSet(rateParam, target.speedHz);
    beginEndSet(widthParam, target.width);
    beginEndSet(mixParam, target.mix);

    switch (preset) {
      case StylePreset::smooth: styleSmoothButton.setToggleState(true, juce::dontSendNotification); break;
      case StylePreset::wide: styleWideButton.setToggleState(true, juce::dontSendNotification); break;
      case StylePreset::tight: styleTightButton.setToggleState(true, juce::dontSendNotification); break;
      case StylePreset::dream: styleDreamButton.setToggleState(true, juce::dontSendNotification); break;
    }

    syncControlsFromParameters();
    repaint();
  }

  void drawBackdropGrid(juce::Graphics& g, juce::Rectangle<float> bounds) {
    g.setColour(juce::Colour(0x0816B8FF));
    for (float x = bounds.getX(); x < bounds.getRight(); x += 36.0F) {
      g.drawVerticalLine(juce::roundToInt(x), bounds.getY(), bounds.getBottom());
    }
    for (float y = bounds.getY(); y < bounds.getBottom(); y += 32.0F) {
      g.drawHorizontalLine(juce::roundToInt(y), bounds.getX(), bounds.getRight());
    }
  }

  void drawMotionDisplay(juce::Graphics& g, juce::Rectangle<float> bounds) {
    if (bounds.isEmpty()) return;

    g.setColour(juce::Colour(0xFF111723));
    g.fillRoundedRectangle(bounds, 8.0F);
    g.setColour(juce::Colour(0x18FFFFFF));
    g.drawRoundedRectangle(bounds, 8.0F, 1.0F);

    auto inner = bounds.reduced(10.0F);
    auto laneA = inner.removeFromTop((inner.getHeight() - 10.0F) * 0.5F);
    inner.removeFromTop(10.0F);
    auto laneB = inner;

    auto drawLane = [&](juce::Rectangle<float> lane, float phaseOffset, juce::Colour baseColour) {
      g.setColour(juce::Colour(0x101A2534));
      g.fillRoundedRectangle(lane, 6.0F);

      juce::ColourGradient grad(
        juce::Colour(0x1A3EA1FF), lane.getX(), lane.getY(),
        juce::Colour(0x1CBE6DFF), lane.getRight(), lane.getBottom(),
        false
      );
      g.setGradientFill(grad);
      g.fillRoundedRectangle(lane.reduced(1.0F), 5.0F);

      const float rate = getParamNormalised(rateParam, 0.3F);
      const float depth = getParamNormalised(depthParam, 0.3F);
      const float width = getParamNormalised(widthParam, 0.5F);
      const int bars = 20;
      for (int i = 0; i < bars; ++i) {
        const float t = static_cast<float>(i) / static_cast<float>(bars - 1);
        const float wave = 0.5F + 0.5F * std::sin((t * 7.5F) + motionAnimationPhase * (0.8F + rate * 1.9F) + phaseOffset);
        const float sway = 0.5F + 0.5F * std::sin((t * 13.0F) + motionAnimationPhase * (0.4F + width * 1.2F) + phaseOffset * 1.3F);
        const float intensity = juce::jlimit(0.08F, 1.0F, 0.12F + wave * (0.45F + depth * 0.55F));
        const float barX = lane.getX() + (t * lane.getWidth());
        const float barH = lerp(lane.getHeight() * 0.25F, lane.getHeight() * 0.95F, sway);
        const float barY = lane.getCentreY() - (barH * 0.5F);
        const float barW = lerp(2.0F, 4.2F, width);
        const juce::Colour c = baseColour.withMultipliedAlpha(intensity).interpolatedWith(juce::Colour(0xFFCB86FF), 0.25F + 0.45F * t);
        g.setColour(c);
        g.fillRoundedRectangle(barX - (barW * 0.5F), barY, barW, barH, 1.8F);
      }

      g.setColour(juce::Colour(0x22FFFFFF));
      g.drawRoundedRectangle(lane, 6.0F, 1.0F);
    };

    drawLane(laneA, 0.0F, juce::Colour(0xFF4CA8FF));
    drawLane(laneB, juce::MathConstants<float>::pi * (0.25F + getParamActual(widthParam, 0.5F)), juce::Colour(0xFF7B6DFF));
  }

  void drawModWaveDisplay(juce::Graphics& g, juce::Rectangle<float> bounds) {
    if (bounds.isEmpty()) return;
    g.setGradientFill(juce::ColourGradient(
      juce::Colour(0xFF182230), bounds.getTopLeft(),
      juce::Colour(0xFF111723), bounds.getBottomLeft(),
      false
    ));
    g.fillRoundedRectangle(bounds, 8.0F);
    g.setColour(juce::Colour(0x20FFFFFF));
    g.drawRoundedRectangle(bounds, 8.0F, 1.0F);

    const float depthNorm = getParamNormalised(depthParam, 0.3F);
    const float rateNorm = getParamNormalised(rateParam, 0.3F);
    const float widthNorm = getParamNormalised(widthParam, 0.5F);
    const float ampA = lerp(6.0F, bounds.getHeight() * 0.28F, depthNorm);
    const float ampB = lerp(8.0F, bounds.getHeight() * 0.33F, depthNorm * (0.7F + widthNorm * 0.3F));
    const float speed = lerp(0.8F, 2.8F, rateNorm);

    juce::Path a;
    juce::Path b;
    const int steps = juce::jmax(60, juce::roundToInt(bounds.getWidth()));
    for (int i = 0; i <= steps; ++i) {
      const float t = static_cast<float>(i) / static_cast<float>(steps);
      const float x = bounds.getX() + (t * bounds.getWidth());
      const float baseY = bounds.getCentreY();
      const float y1 = baseY - ampA + std::sin((t * 3.8F) + motionAnimationPhase * speed) * ampA;
      const float y2 = baseY + ampB * 0.2F + std::sin((t * 4.1F) + motionAnimationPhase * speed + widthNorm * juce::MathConstants<float>::pi) * ampB;
      if (i == 0) {
        a.startNewSubPath(x, y1);
        b.startNewSubPath(x, y2);
      } else {
        a.lineTo(x, y1);
        b.lineTo(x, y2);
      }
    }

    g.setColour(juce::Colour(0x20FFFFFF));
    g.drawHorizontalLine(juce::roundToInt(bounds.getCentreY()), bounds.getX() + 8.0F, bounds.getRight() - 8.0F);

    g.setColour(juce::Colour(0xFF42C7FF));
    g.strokePath(a, juce::PathStrokeType(2.0F, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
    g.setColour(juce::Colour(0xFFB07FFF));
    g.strokePath(b, juce::PathStrokeType(1.8F, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
  }

  void drawStereoField(juce::Graphics& g, juce::Rectangle<float> bounds) {
    if (bounds.isEmpty()) return;

    g.setColour(juce::Colour(0x0DFFFFFF));
    g.fillRoundedRectangle(bounds, 8.0F);
    g.setColour(juce::Colour(0x14FFFFFF));
    g.drawRoundedRectangle(bounds, 8.0F, 1.0F);

    auto inner = bounds.reduced(12.0F);
    const float widthNorm = getParamNormalised(widthParam, 0.5F);
    const float mixNorm = getParamNormalised(mixParam, 0.5F);
    const float rateNorm = getParamNormalised(rateParam, 0.2F);
    const float depthNorm = getParamNormalised(depthParam, 0.25F);

    const juce::Point<float> c = inner.getCentre();
    const float radiusX = inner.getWidth() * (0.25F + widthNorm * 0.30F);
    const float radiusY = inner.getHeight() * 0.22F;

    g.setColour(juce::Colour(0x14FFFFFF));
    g.drawEllipse(c.x - inner.getWidth() * 0.36F, c.y - inner.getHeight() * 0.18F, inner.getWidth() * 0.72F, inner.getHeight() * 0.36F, 1.0F);
    g.drawVerticalLine(juce::roundToInt(c.x), inner.getY(), inner.getBottom());
    g.drawHorizontalLine(juce::roundToInt(c.y), inner.getX(), inner.getRight());

    const float orbitPhase = motionAnimationPhase * lerp(0.9F, 2.6F, rateNorm);
    const float lOffset = std::sin(orbitPhase) * radiusX;
    const float rOffset = std::sin(orbitPhase + juce::MathConstants<float>::pi * (0.15F + widthNorm * 0.85F)) * radiusX;
    const float yOffsetL = std::cos(orbitPhase * 1.2F) * radiusY * (0.4F + depthNorm * 0.6F);
    const float yOffsetR = std::cos(orbitPhase * 1.2F + juce::MathConstants<float>::pi * 0.4F) * radiusY * (0.4F + depthNorm * 0.6F);
    const float pointRadius = lerp(4.0F, 8.0F, mixNorm);

    g.setColour(juce::Colour(0x6654C9FF));
    g.fillEllipse(c.x + lOffset - pointRadius, c.y + yOffsetL - pointRadius, pointRadius * 2.0F, pointRadius * 2.0F);
    g.setColour(juce::Colour(0x6686F0FF));
    g.fillEllipse(c.x + rOffset - pointRadius, c.y + yOffsetR - pointRadius, pointRadius * 2.0F, pointRadius * 2.0F);

    g.setColour(juce::Colours::white.withAlpha(0.76F));
    g.drawFittedText("Stereo Movement", inner.toNearestInt().removeFromTop(18), juce::Justification::centredLeft, 1);
    g.setColour(juce::Colours::lightgrey.withAlpha(0.72F));
    const juce::String stats = "Spread " + juce::String(juce::roundToInt(widthNorm * 100.0F))
      + " | Wet " + juce::String(juce::roundToInt(mixNorm * 100.0F));
    g.drawFittedText(stats, inner.toNearestInt().removeFromBottom(18), juce::Justification::centredLeft, 1);
  }

  void drawKnobGlow(juce::Graphics& g, const juce::Slider& slider, juce::Colour colour) {
    const auto b = slider.getBounds().toFloat().reduced(8.0F);
    if (b.isEmpty()) return;
    g.setColour(colour.withAlpha(0.13F));
    g.fillEllipse(b.expanded(6.0F));
  }

  void timerCallback() override {
    const float rateNorm = getParamNormalised(rateParam, 0.2F);
    motionAnimationPhase += 0.03F + rateNorm * 0.075F;
    if (motionAnimationPhase > 10000.0F) {
      motionAnimationPhase = std::fmod(motionAnimationPhase, juce::MathConstants<float>::twoPi);
    }
    repaint(motionPanelBounds);
    repaint(modPanelBounds);
    repaint(spacePanelBounds);
  }

  void handleAsyncUpdate() override {
    syncControlsFromParameters();
    repaint();
  }

  void curveHasChanged(tracktion::engine::AutomatableParameter&) override {}
  void currentValueChanged(tracktion::engine::AutomatableParameter&) override { triggerAsyncUpdate(); }
  void parameterChanged(tracktion::engine::AutomatableParameter&, float) override { triggerAsyncUpdate(); }

  tracktion::engine::ChorusPlugin& chorus;
  tracktion::engine::AutomatableParameter::Ptr depthParam;
  tracktion::engine::AutomatableParameter::Ptr rateParam;
  tracktion::engine::AutomatableParameter::Ptr widthParam;
  tracktion::engine::AutomatableParameter::Ptr mixParam;

  juce::Label titleLabel;
  juce::Label subtitleLabel;
  juce::Label motionTitleLabel;
  juce::Label modTitleLabel;
  juce::Label spaceTitleLabel;
  juce::Label styleTitleLabel;
  juce::Label mixTitleLabel;

  DialControl depthDial;
  DialControl rateDial;
  DialControl widthDial;
  DialControl mixDial;

  juce::TextButton styleSmoothButton;
  juce::TextButton styleWideButton;
  juce::TextButton styleTightButton;
  juce::TextButton styleDreamButton;

  juce::Label readoutLabel;
  juce::Label readoutHintLabel;
  juce::Slider mixBarSlider;
  juce::Label mixDryLabel;
  juce::Label mixWetLabel;
  juce::Label bottomInfoLabel;

  juce::Rectangle<int> motionPanelBounds;
  juce::Rectangle<int> modPanelBounds;
  juce::Rectangle<int> spacePanelBounds;
  juce::Rectangle<int> stylePanelBounds;
  juce::Rectangle<int> mixPanelBounds;
  juce::Rectangle<float> motionGraphBounds;
  juce::Rectangle<float> modWaveBounds;
  juce::Rectangle<float> stereoFieldBounds;

  float motionAnimationPhase = 0.0F;
  bool ignoreControlCallbacks = false;
};

class ReverbFallbackEditor final : public tracktion::engine::Plugin::EditorComponent,
                                   private juce::Timer,
                                   private juce::AsyncUpdater,
                                   private tracktion::engine::AutomatableParameter::Listener {
 public:
  enum class ViewMode {
    easy,
    pro,
  };

  enum class SpacePreset {
    smallRoom,
    wideHall,
    plateGlow,
    freezePad,
  };

  explicit ReverbFallbackEditor(tracktion::engine::ReverbPlugin& pluginToControl)
    : reverb(pluginToControl),
      roomSizeParam(reverb.roomSizeParam),
      dampParam(reverb.dampParam),
      wetParam(reverb.wetParam),
      dryParam(reverb.dryParam),
      widthParam(reverb.widthParam),
      modeParam(reverb.modeParam) {
    setupHeaderLabel(titleLabel, "Reverb");
    titleLabel.setFont(juce::Font(juce::FontOptions(20.0F, juce::Font::bold)));
    addAndMakeVisible(titleLabel);

    setupBodyLabel(subtitleLabel);
    subtitleLabel.setText(
      "TheStuu Room Field: Raumcharakter visuell formen (Tracktion Reverb Fallback).",
      juce::dontSendNotification
    );
    addAndMakeVisible(subtitleLabel);

    configureModeButton(easyModeButton, "Easy");
    easyModeButton.setClickingTogglesState(true);
    easyModeButton.setRadioGroupId(94102);
    easyModeButton.setToggleState(true, juce::dontSendNotification);
    easyModeButton.onClick = [safe = juce::Component::SafePointer<ReverbFallbackEditor>(this)] {
      if (safe != nullptr) {
        safe->setViewMode(ViewMode::easy);
      }
    };
    addAndMakeVisible(easyModeButton);

    configureModeButton(proModeButton, "Pro");
    proModeButton.setClickingTogglesState(true);
    proModeButton.setRadioGroupId(94102);
    proModeButton.onClick = [safe = juce::Component::SafePointer<ReverbFallbackEditor>(this)] {
      if (safe != nullptr) {
        safe->setViewMode(ViewMode::pro);
      }
    };
    addAndMakeVisible(proModeButton);

    modeHintLabel.setJustificationType(juce::Justification::centredLeft);
    modeHintLabel.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.86F));
    modeHintLabel.setFont(juce::Font(juce::FontOptions(12.0F)));
    addAndMakeVisible(modeHintLabel);

    setupPanelTitle(roomFieldTitleLabel, "ROOM FIELD");
    addAndMakeVisible(roomFieldTitleLabel);
    setupPanelTitle(spacePanelTitleLabel, "SPACE");
    addAndMakeVisible(spacePanelTitleLabel);
    setupPanelTitle(mixPanelTitleLabel, "MIX");
    addAndMakeVisible(mixPanelTitleLabel);
    setupPanelTitle(presetPanelTitleLabel, "SPACES");
    addAndMakeVisible(presetPanelTitleLabel);
    setupPanelTitle(tailPanelTitleLabel, "TAIL CURVE");
    addAndMakeVisible(tailPanelTitleLabel);

    setupDial(roomSizeDial, "Size", juce::Colour(0xFF69C7FF));
    setupDial(dampDial, "Damp", juce::Colour(0xFF8EABFF));
    setupDial(widthDial, "Width", juce::Colour(0xFFAC86FF));
    setupDial(earlyEnergyDial, "Early", juce::Colour(0xFF6EE6D6), /*interactive*/ false);

    setupEasyMacro(easySizeMacro, "Room Size", juce::Colour(0xFF69C7FF));
    setupEasyMacro(easyToneMacro, "Brightness", juce::Colour(0xFF8EABFF));
    setupEasyMacro(easyWidthMacro, "Stereo Width", juce::Colour(0xFFAC86FF));
    connectEasyMacroToParam(easySizeMacro, roomSizeParam, false);
    connectEasyMacroToParam(easyToneMacro, dampParam, true);
    connectEasyMacroToParam(easyWidthMacro, widthParam, false);

    setupFader(dryFader, "DRY", juce::Colour(0xFF9CC8FF));
    setupFader(wetFader, "WET", juce::Colour(0xFF6FE6D8));

    setupParameterSlider(roomSizeDial.slider, roomSizeParam, 0.01);
    setupParameterSlider(dampDial.slider, dampParam, 0.01);
    setupParameterSlider(widthDial.slider, widthParam, 0.01);
    setupParameterSlider(dryFader.slider, dryParam, 0.01);
    setupParameterSlider(wetFader.slider, wetParam, 0.01);

    connectSliderToParam(roomSizeDial.slider, roomSizeParam);
    connectSliderToParam(dampDial.slider, dampParam);
    connectSliderToParam(widthDial.slider, widthParam);
    connectSliderToParam(dryFader.slider, dryParam);
    connectSliderToParam(wetFader.slider, wetParam);

    freezeButton.setButtonText("FREEZE");
    freezeButton.setClickingTogglesState(true);
    freezeButton.setColour(juce::TextButton::buttonColourId, juce::Colour(0x1AFFFFFF));
    freezeButton.setColour(juce::TextButton::buttonOnColourId, juce::Colour(0xFF274F8A));
    freezeButton.setColour(juce::TextButton::textColourOffId, juce::Colours::white.withAlpha(0.88F));
    freezeButton.setColour(juce::TextButton::textColourOnId, juce::Colours::white);
    freezeButton.onClick = [safe = juce::Component::SafePointer<ReverbFallbackEditor>(this)] {
      if (safe == nullptr || safe->modeParam == nullptr) {
        return;
      }
      safe->modeParam->parameterChangeGestureBegin();
      safe->setParamActual(safe->modeParam, safe->freezeButton.getToggleState() ? 1.0F : 0.0F);
      safe->modeParam->parameterChangeGestureEnd();
      safe->syncControlsFromParameters();
      safe->repaint();
    };
    addAndMakeVisible(freezeButton);

    freezeHintLabel.setJustificationType(juce::Justification::centredLeft);
    freezeHintLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.72F));
    freezeHintLabel.setFont(juce::Font(juce::FontOptions(12.0F)));
    freezeHintLabel.setText("Freeze haelt den Hall fast unendlich. Gut fuer Ambient-Layer.", juce::dontSendNotification);
    addAndMakeVisible(freezeHintLabel);

    setupPresetButton(presetSmallRoomButton, "Small Room", SpacePreset::smallRoom);
    setupPresetButton(presetWideHallButton, "Wide Hall", SpacePreset::wideHall);
    setupPresetButton(presetPlateGlowButton, "Plate Glow", SpacePreset::plateGlow);
    setupPresetButton(presetFreezePadButton, "Freeze Pad", SpacePreset::freezePad);

    easyPageHeaderLabel.setJustificationType(juce::Justification::centredLeft);
    easyPageHeaderLabel.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.90F));
    easyPageHeaderLabel.setFont(juce::Font(juce::FontOptions(12.0F, juce::Font::bold)));
    addAndMakeVisible(easyPageHeaderLabel);

    easyPageDescriptionLabel.setJustificationType(juce::Justification::topLeft);
    easyPageDescriptionLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.78F));
    easyPageDescriptionLabel.setFont(juce::Font(juce::FontOptions(11.6F)));
    addAndMakeVisible(easyPageDescriptionLabel);

    roomReadoutLabel.setJustificationType(juce::Justification::topLeft);
    roomReadoutLabel.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.9F));
    roomReadoutLabel.setFont(juce::Font(juce::FontOptions(12.5F)));
    addAndMakeVisible(roomReadoutLabel);

    bottomInfoLabel.setJustificationType(juce::Justification::centredLeft);
    bottomInfoLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.78F));
    bottomInfoLabel.setFont(juce::Font(juce::FontOptions(12.0F)));
    addAndMakeVisible(bottomInfoLabel);

    addParamListener(roomSizeParam);
    addParamListener(dampParam);
    addParamListener(wetParam);
    addParamListener(dryParam);
    addParamListener(widthParam);
    addParamListener(modeParam);
    ensureLevelMeterClientAttachment();

    setSize(1040, 660);
    syncControlsFromParameters();
    updateDerivedVisuals();
    updateModeUi();
    startTimerHz(30);
  }

  ~ReverbFallbackEditor() override {
    stopTimer();
    detachLevelMeterClient();
    removeParamListener(roomSizeParam);
    removeParamListener(dampParam);
    removeParamListener(wetParam);
    removeParamListener(dryParam);
    removeParamListener(widthParam);
    removeParamListener(modeParam);
  }

  bool allowWindowResizing() override { return true; }
  juce::ComponentBoundsConstrainer* getBoundsConstrainer() override { return {}; }

  void resized() override {
    auto area = getLocalBounds().reduced(14);

    titleLabel.setBounds(area.removeFromTop(28));
    subtitleLabel.setBounds(area.removeFromTop(20));
    auto modeRow = area.removeFromTop(28);
    easyModeButton.setBounds(modeRow.removeFromLeft(62));
    modeRow.removeFromLeft(6);
    proModeButton.setBounds(modeRow.removeFromLeft(62));
    modeRow.removeFromLeft(10);
    modeHintLabel.setBounds(modeRow);
    area.removeFromTop(8);

    auto topBody = area.removeFromTop(juce::jmax(370, area.getHeight() - 120));
    roomFieldPanelBounds = topBody.removeFromLeft(juce::roundToInt(topBody.getWidth() * 0.44F));
    topBody.removeFromLeft(8);
    auto rightStack = topBody;

    spacePanelBounds = rightStack.removeFromTop(juce::roundToInt(rightStack.getHeight() * 0.56F));
    rightStack.removeFromTop(8);
    mixPanelBounds = rightStack;

    area.removeFromTop(8);
    tailPanelBounds = area.removeFromTop(82);

    auto roomInner = roomFieldPanelBounds.reduced(10);
    roomFieldTitleLabel.setBounds(roomInner.removeFromTop(22));
    roomFieldBounds = roomInner.removeFromTop(juce::jmax(220, roomInner.getHeight() - 92)).toFloat().reduced(0.0F, 2.0F);
    roomReadoutLabel.setBounds(roomInner.removeFromTop(74));

    auto spaceInner = spacePanelBounds.reduced(10);
    spacePanelTitleLabel.setBounds(spaceInner.removeFromTop(22));
    spaceInner.removeFromTop(8);
    if (viewMode == ViewMode::easy) {
      const int rowHeight = juce::jlimit(28, 34, (spaceInner.getHeight() - 38) / 3);
      layoutEasyMacroRow(spaceInner.removeFromTop(rowHeight), easySizeMacro);
      spaceInner.removeFromTop(4);
      layoutEasyMacroRow(spaceInner.removeFromTop(rowHeight), easyToneMacro);
      spaceInner.removeFromTop(4);
      layoutEasyMacroRow(spaceInner.removeFromTop(rowHeight), easyWidthMacro);
      spaceInner.removeFromTop(8);
      auto freezeRow = spaceInner.removeFromTop(30);
      freezeButton.setBounds(freezeRow.removeFromLeft(124));
      freezeHintLabel.setBounds(spaceInner.removeFromTop(26));
    } else {
      auto topKnobRow = spaceInner.removeFromTop(juce::jmin(166, spaceInner.getHeight() / 2));
      auto bottomKnobRow = spaceInner.removeFromTop(juce::jmin(166, spaceInner.getHeight()));
      layoutTwoDials(topKnobRow, roomSizeDial, dampDial);
      bottomKnobRow.removeFromTop(4);
      layoutTwoDials(bottomKnobRow, widthDial, earlyEnergyDial);
      freezeButton.setBounds(spaceInner.removeFromTop(30).removeFromLeft(120));
      freezeHintLabel.setBounds(spaceInner.removeFromTop(28));
    }

    auto mixInner = mixPanelBounds.reduced(10);
    auto mixTop = mixInner.removeFromTop(22);
    mixPanelTitleLabel.setBounds(mixTop.removeFromLeft(60));
    presetPanelTitleLabel.setBounds(mixTop);
    mixInner.removeFromTop(8);
    auto fadersAndPresets = mixInner;
    auto faderArea = fadersAndPresets.removeFromLeft(juce::jmax(180, fadersAndPresets.getWidth() / 2));
    fadersAndPresets.removeFromLeft(8);
    auto presetArea = fadersAndPresets;

    auto faderColumns = faderArea.reduced(6);
    auto dryBounds = faderColumns.removeFromLeft((faderColumns.getWidth() - 10) / 2);
    faderColumns.removeFromLeft(10);
    auto wetBounds = faderColumns;
    layoutFader(dryFader, dryBounds);
    layoutFader(wetFader, wetBounds);

    auto presetInner = presetArea.reduced(4);
    if (viewMode == ViewMode::easy) {
      auto tabRow = presetInner.removeFromTop(34);
      layoutFourButtons(tabRow, presetSmallRoomButton, presetWideHallButton, presetPlateGlowButton, presetFreezePadButton);
      presetInner.removeFromTop(6);
      easyPageHeaderLabel.setBounds(presetInner.removeFromTop(18));
      easyPageDescriptionLabel.setBounds(presetInner.removeFromTop(40));
      presetInner.removeFromTop(6);
      stereoBadgeBounds = presetInner.removeFromTop(30).toFloat();
      presetInner.removeFromTop(6);
      reflectionMeterBounds = presetInner.removeFromTop(54).toFloat();
      presetInner.removeFromTop(6);
      decayBarBounds = presetInner.removeFromTop(18).toFloat();
    } else {
      auto presetTop = presetInner.removeFromTop(40);
      auto presetBottom = presetInner.removeFromTop(40);
      layoutTwoButtons(presetTop, presetSmallRoomButton, presetWideHallButton);
      layoutTwoButtons(presetBottom, presetPlateGlowButton, presetFreezePadButton);
      easyPageHeaderLabel.setBounds(0, 0, 0, 0);
      easyPageDescriptionLabel.setBounds(0, 0, 0, 0);
      presetInner.removeFromTop(8);
      stereoBadgeBounds = presetInner.removeFromTop(30).toFloat();
      presetInner.removeFromTop(6);
      reflectionMeterBounds = presetInner.removeFromTop(54).toFloat();
      presetInner.removeFromTop(6);
      decayBarBounds = presetInner.removeFromTop(18).toFloat();
    }

    auto tailInner = tailPanelBounds.reduced(10);
    tailPanelTitleLabel.setBounds(tailInner.removeFromTop(20));
    tailInner.removeFromTop(4);
    tailCurveBounds = tailInner.toFloat();

    updateDerivedVisuals();
  }

  void paint(juce::Graphics& g) override {
    const auto bounds = getLocalBounds().toFloat();
    g.setGradientFill(juce::ColourGradient(
      juce::Colour(0xFF0A111A), bounds.getTopLeft(),
      juce::Colour(0xFF080C14), bounds.getBottomRight(),
      false
    ));
    g.fillAll();

    drawBackdrop(g, bounds);
    drawPanel(g, roomFieldPanelBounds.toFloat(), 10.0F, juce::Colour(0x141A2432), juce::Colour(0x18FFFFFF));
    drawPanel(g, spacePanelBounds.toFloat(), 10.0F, juce::Colour(0x141A2430), juce::Colour(0x18FFFFFF));
    drawPanel(g, mixPanelBounds.toFloat(), 10.0F, juce::Colour(0x1419232D), juce::Colour(0x16FFFFFF));
    drawPanel(g, tailPanelBounds.toFloat(), 10.0F, juce::Colour(0x121A222C), juce::Colour(0x14FFFFFF));

    drawRoomField(g, roomFieldBounds);
    drawReflectionMeter(g, reflectionMeterBounds);
    drawStereoBadge(g, stereoBadgeBounds);
    drawDecayBar(g, decayBarBounds);
    drawTailCurve(g, tailCurveBounds);
    drawDialGlow(g, roomSizeDial.slider, juce::Colour(0x556AC7FF));
    drawDialGlow(g, dampDial.slider, juce::Colour(0x558EA4FF));
    drawDialGlow(g, widthDial.slider, juce::Colour(0x559D82FF));
    drawDialGlow(g, wetFader.slider, juce::Colour(0x4470E9D6));
  }

 private:
  struct DialControl {
    juce::Label titleLabel;
    juce::Slider slider;
    juce::Label valueLabel;
    juce::Colour accent = juce::Colour(0xFF74C0FF);
  };

  struct EasyMacroControl {
    juce::Label titleLabel;
    juce::Slider slider;
    juce::Label valueLabel;
    juce::Colour accent = juce::Colour(0xFF74C0FF);
  };

  struct FaderControl {
    juce::Label titleLabel;
    juce::Slider slider;
    juce::Label valueLabel;
    juce::Colour accent = juce::Colour(0xFF74C0FF);
  };

  static float clamp01(float value) {
    return juce::jlimit(0.0F, 1.0F, value);
  }

  static float lerp(float a, float b, float t) {
    return a + ((b - a) * t);
  }

  static juce::String percentString(float value) {
    return juce::String(juce::roundToInt(clamp01(value) * 100.0F)) + "%";
  }

  static void drawPanel(juce::Graphics& g, juce::Rectangle<float> r, float radius, juce::Colour fill, juce::Colour stroke) {
    if (r.isEmpty()) return;
    g.setGradientFill(juce::ColourGradient(fill.brighter(0.06F), r.getTopLeft(), fill.darker(0.18F), r.getBottomLeft(), false));
    g.fillRoundedRectangle(r, radius);
    g.setColour(stroke);
    g.drawRoundedRectangle(r, radius, 1.0F);
  }

  static void setupHeaderLabel(juce::Label& label, const juce::String& text) {
    label.setText(text, juce::dontSendNotification);
    label.setJustificationType(juce::Justification::centredLeft);
    label.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.96F));
  }

  static void setupBodyLabel(juce::Label& label) {
    label.setJustificationType(juce::Justification::centredLeft);
    label.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.78F));
    label.setFont(juce::Font(juce::FontOptions(12.4F)));
  }

  static void setupPanelTitle(juce::Label& label, const juce::String& text) {
    label.setText(text, juce::dontSendNotification);
    label.setJustificationType(juce::Justification::centredLeft);
    label.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.86F));
    label.setFont(juce::Font(juce::FontOptions(12.0F, juce::Font::bold)));
  }

  void configureModeButton(juce::TextButton& button, const juce::String& text) {
    button.setButtonText(text);
    button.setColour(juce::TextButton::buttonColourId, juce::Colour(0x28151C27));
    button.setColour(juce::TextButton::buttonOnColourId, juce::Colour(0xFF2067D4));
    button.setColour(juce::TextButton::textColourOffId, juce::Colours::white.withAlpha(0.92F));
    button.setColour(juce::TextButton::textColourOnId, juce::Colours::white);
  }

  void setupDial(DialControl& dial, const juce::String& title, juce::Colour accent, bool interactive = true) {
    dial.accent = accent;
    dial.titleLabel.setText(title.toUpperCase(), juce::dontSendNotification);
    dial.titleLabel.setJustificationType(juce::Justification::centred);
    dial.titleLabel.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.9F));
    dial.titleLabel.setFont(juce::Font(juce::FontOptions(12.0F, juce::Font::bold)));
    addAndMakeVisible(dial.titleLabel);

    dial.valueLabel.setJustificationType(juce::Justification::centred);
    dial.valueLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.82F));
    dial.valueLabel.setFont(juce::Font(juce::FontOptions(12.0F)));
    addAndMakeVisible(dial.valueLabel);

    dial.slider.setSliderStyle(juce::Slider::RotaryHorizontalVerticalDrag);
    dial.slider.setTextBoxStyle(juce::Slider::NoTextBox, false, 0, 0);
    dial.slider.setRotaryParameters(juce::MathConstants<float>::pi * 1.16F, juce::MathConstants<float>::pi * 2.84F, true);
    dial.slider.setColour(juce::Slider::rotarySliderFillColourId, accent);
    dial.slider.setColour(juce::Slider::rotarySliderOutlineColourId, juce::Colour(0x26FFFFFF));
    dial.slider.setColour(juce::Slider::thumbColourId, juce::Colours::white.withAlpha(0.96F));
    dial.slider.setEnabled(interactive);
    if (!interactive) {
      dial.slider.setMouseCursor(juce::MouseCursor::NormalCursor);
      dial.slider.setAlpha(0.86F);
    }
    addAndMakeVisible(dial.slider);
  }

  void setupEasyMacro(EasyMacroControl& macro, const juce::String& title, juce::Colour accent) {
    macro.accent = accent;
    macro.titleLabel.setText(title.toUpperCase(), juce::dontSendNotification);
    macro.titleLabel.setJustificationType(juce::Justification::centredLeft);
    macro.titleLabel.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.92F));
    macro.titleLabel.setFont(juce::Font(juce::FontOptions(11.8F, juce::Font::bold)));
    addAndMakeVisible(macro.titleLabel);

    macro.valueLabel.setJustificationType(juce::Justification::centredRight);
    macro.valueLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.84F));
    macro.valueLabel.setFont(juce::Font(juce::FontOptions(11.5F)));
    addAndMakeVisible(macro.valueLabel);

    macro.slider.setSliderStyle(juce::Slider::LinearHorizontal);
    macro.slider.setTextBoxStyle(juce::Slider::NoTextBox, false, 0, 0);
    macro.slider.setRange(0.0, 1.0, 0.01);
    macro.slider.setColour(juce::Slider::trackColourId, accent);
    macro.slider.setColour(juce::Slider::backgroundColourId, juce::Colour(0x20FFFFFF));
    macro.slider.setColour(juce::Slider::thumbColourId, juce::Colours::white.withAlpha(0.95F));
    addAndMakeVisible(macro.slider);
  }

  void setupFader(FaderControl& fader, const juce::String& title, juce::Colour accent) {
    fader.accent = accent;
    fader.titleLabel.setText(title, juce::dontSendNotification);
    fader.titleLabel.setJustificationType(juce::Justification::centred);
    fader.titleLabel.setColour(juce::Label::textColourId, juce::Colours::white.withAlpha(0.9F));
    fader.titleLabel.setFont(juce::Font(juce::FontOptions(12.0F, juce::Font::bold)));
    addAndMakeVisible(fader.titleLabel);

    fader.valueLabel.setJustificationType(juce::Justification::centred);
    fader.valueLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.78F));
    fader.valueLabel.setFont(juce::Font(juce::FontOptions(11.5F)));
    addAndMakeVisible(fader.valueLabel);

    fader.slider.setSliderStyle(juce::Slider::LinearVertical);
    fader.slider.setTextBoxStyle(juce::Slider::NoTextBox, false, 0, 0);
    fader.slider.setColour(juce::Slider::trackColourId, accent);
    fader.slider.setColour(juce::Slider::backgroundColourId, juce::Colour(0x18FFFFFF));
    fader.slider.setColour(juce::Slider::thumbColourId, juce::Colours::white.withAlpha(0.95F));
    addAndMakeVisible(fader.slider);
  }

  void setupPresetButton(juce::TextButton& button, const juce::String& text, SpacePreset preset) {
    button.setButtonText(text);
    button.setClickingTogglesState(true);
    button.setRadioGroupId(94103);
    button.setColour(juce::TextButton::buttonColourId, juce::Colour(0x18FFFFFF));
    button.setColour(juce::TextButton::buttonOnColourId, juce::Colour(0xFF203E70));
    button.setColour(juce::TextButton::textColourOffId, juce::Colours::white.withAlpha(0.9F));
    button.setColour(juce::TextButton::textColourOnId, juce::Colours::white);
    button.onClick = [safe = juce::Component::SafePointer<ReverbFallbackEditor>(this), preset] {
      if (safe != nullptr) {
        if (safe->viewMode == ViewMode::easy) {
          safe->selectEasyPage(preset, true);
        } else {
          safe->applyPreset(preset);
        }
      }
    };
    addAndMakeVisible(button);
  }

  void setupParameterSlider(juce::Slider& slider, const tracktion::engine::AutomatableParameter::Ptr& param, double step) {
    if (param == nullptr) {
      slider.setRange(0.0, 1.0, step);
      slider.setEnabled(false);
      return;
    }
    const auto range = param->getValueRange();
    slider.setRange(range.getStart(), range.getEnd(), step);
    if (const auto def = param->getDefaultValue(); def.has_value()) {
      slider.setDoubleClickReturnValue(true, def.value());
    }
  }

  void connectSliderToParam(juce::Slider& slider, tracktion::engine::AutomatableParameter::Ptr& param) {
    slider.onDragStart = [safe = juce::Component::SafePointer<ReverbFallbackEditor>(this), ptr = &param]() {
      if (safe != nullptr && ptr != nullptr && *ptr != nullptr) {
        (*ptr)->parameterChangeGestureBegin();
      }
    };
    slider.onDragEnd = [safe = juce::Component::SafePointer<ReverbFallbackEditor>(this), ptr = &param]() {
      if (safe != nullptr && ptr != nullptr && *ptr != nullptr) {
        (*ptr)->parameterChangeGestureEnd();
      }
    };
    slider.onValueChange = [safe = juce::Component::SafePointer<ReverbFallbackEditor>(this), ptr = &param, sliderPtr = &slider]() {
      if (safe == nullptr || safe->ignoreControlCallbacks || ptr == nullptr || *ptr == nullptr || sliderPtr == nullptr) {
        return;
      }
      safe->setParamActual(*ptr, static_cast<float>(sliderPtr->getValue()));
      safe->syncControlsFromParameters();
      safe->repaint();
    };
  }

  void connectEasyMacroToParam(EasyMacroControl& macro, tracktion::engine::AutomatableParameter::Ptr& param, bool invertNormalised) {
    macro.slider.onDragStart = [safe = juce::Component::SafePointer<ReverbFallbackEditor>(this), ptr = &param]() {
      if (safe != nullptr && ptr != nullptr && *ptr != nullptr) {
        (*ptr)->parameterChangeGestureBegin();
      }
    };
    macro.slider.onDragEnd = [safe = juce::Component::SafePointer<ReverbFallbackEditor>(this), ptr = &param]() {
      if (safe != nullptr && ptr != nullptr && *ptr != nullptr) {
        (*ptr)->parameterChangeGestureEnd();
      }
    };
    macro.slider.onValueChange =
      [safe = juce::Component::SafePointer<ReverbFallbackEditor>(this), ptr = &param, sliderPtr = &macro.slider, invertNormalised]() {
        if (safe == nullptr || safe->ignoreEasyMacroCallbacks || ptr == nullptr || *ptr == nullptr || sliderPtr == nullptr) {
          return;
        }
        const float t = juce::jlimit(0.0F, 1.0F, static_cast<float>(sliderPtr->getValue()));
        const float norm = invertNormalised ? (1.0F - t) : t;
        (*ptr)->setNormalisedParameter(norm, juce::sendNotificationSync);
        safe->syncControlsFromParameters();
        safe->repaint();
      };
  }

  void addParamListener(tracktion::engine::AutomatableParameter::Ptr& param) {
    if (param != nullptr) param->addListener(this);
  }

  void removeParamListener(tracktion::engine::AutomatableParameter::Ptr& param) {
    if (param != nullptr) param->removeListener(this);
  }

  void setParamActual(tracktion::engine::AutomatableParameter::Ptr& param, float value) {
    if (param == nullptr) return;
    const auto range = param->getValueRange();
    param->setParameter(juce::jlimit(range.getStart(), range.getEnd(), value), juce::sendNotificationSync);
  }

  float getParamActual(const tracktion::engine::AutomatableParameter::Ptr& param, float fallback = 0.0F) const {
    return param != nullptr ? param->getCurrentValue() : fallback;
  }

  float getParamNorm(const tracktion::engine::AutomatableParameter::Ptr& param, float fallback = 0.0F) const {
    return param != nullptr ? param->getCurrentNormalisedValue() : fallback;
  }

  juce::String paramValueString(const tracktion::engine::AutomatableParameter::Ptr& param, const juce::String& fallback = "n/a") const {
    return param != nullptr ? param->getCurrentValueAsStringWithLabel() : fallback;
  }

  static float dbToUnit(float dB) {
    if (!std::isfinite(dB) || dB <= -99.0F) {
      return 0.0F;
    }
    const float gain = std::pow(10.0F, dB / 20.0F);
    return juce::jlimit(0.0F, 1.0F, gain);
  }

  tracktion::engine::LevelMeterPlugin* findTrackLevelMeterPlugin() const {
    if (auto* ownerTrack = dynamic_cast<tracktion::engine::AudioTrack*>(reverb.getOwnerTrack())) {
      return ownerTrack->getLevelMeterPlugin();
    }
    return nullptr;
  }

  void ensureLevelMeterClientAttachment() {
    auto* meterPlugin = findTrackLevelMeterPlugin();
    auto* nextMeasurer = meterPlugin != nullptr ? &meterPlugin->measurer : nullptr;

    if (attachedLevelMeasurer == nextMeasurer) {
      return;
    }

    detachLevelMeterClient();

    if (nextMeasurer != nullptr) {
      nextMeasurer->addClient(levelMeterClient);
      attachedLevelMeasurer = nextMeasurer;
    }
  }

  void detachLevelMeterClient() {
    if (attachedLevelMeasurer != nullptr) {
      attachedLevelMeasurer->removeClient(levelMeterClient);
      attachedLevelMeasurer = nullptr;
    }
  }

  void updateInputReactiveEnvelopeFromMeter() {
    ensureLevelMeterClientAttachment();

    const float prevEnergy = inputReactiveEnergy;
    float targetEnergy = 0.0F;
    float targetStereoBias = 0.0F;

    if (attachedLevelMeasurer != nullptr) {
      const auto left = levelMeterClient.getAndClearAudioLevel(0);
      const auto right = levelMeterClient.getAndClearAudioLevel(1);
      const float l = dbToUnit(left.dB);
      const float r = dbToUnit(right.dB);
      const float mono = juce::jmax(l, r);
      targetEnergy = juce::jlimit(0.0F, 1.0F, mono * 1.7F);
      const float denom = juce::jmax(0.001F, l + r);
      targetStereoBias = juce::jlimit(-1.0F, 1.0F, (r - l) / denom);
    }

    const float attack = targetEnergy > inputReactiveEnergy ? 0.58F : 0.18F;
    inputReactiveEnergy = juce::jlimit(0.0F, 1.0F, lerp(inputReactiveEnergy, targetEnergy, attack));
    inputReactivePeakHold = juce::jmax(inputReactiveEnergy, inputReactivePeakHold * 0.93F);
    inputReactiveTransient = juce::jmax(0.0F, inputReactiveTransient * 0.78F);

    const float delta = juce::jmax(0.0F, targetEnergy - prevEnergy);
    if (delta > 0.035F) {
      inputReactiveTransient = juce::jlimit(0.0F, 1.0F, juce::jmax(inputReactiveTransient, delta * 2.8F));
    }

    inputReactiveStereoBias = lerp(inputReactiveStereoBias, targetStereoBias, 0.22F);
  }

  void layoutTwoDials(juce::Rectangle<int> bounds, DialControl& left, DialControl& right) {
    auto inner = bounds.reduced(4);
    auto leftArea = inner.removeFromLeft((inner.getWidth() - 8) / 2);
    inner.removeFromLeft(8);
    auto rightArea = inner;
    layoutDial(left, leftArea);
    layoutDial(right, rightArea);
  }

  void layoutDial(DialControl& dial, juce::Rectangle<int> bounds) {
    auto area = bounds.reduced(4);
    dial.titleLabel.setBounds(area.removeFromTop(18));
    dial.valueLabel.setBounds(area.removeFromBottom(18));
    dial.slider.setBounds(area.reduced(2));
  }

  void layoutFader(FaderControl& fader, juce::Rectangle<int> bounds) {
    auto area = bounds.reduced(4);
    fader.titleLabel.setBounds(area.removeFromTop(18));
    fader.valueLabel.setBounds(area.removeFromBottom(16));
    area.removeFromTop(4);
    fader.slider.setBounds(area.reduced(8, 2));
  }

  void layoutEasyMacroRow(juce::Rectangle<int> row, EasyMacroControl& macro) {
    auto area = row.reduced(2, 1);
    auto labelArea = area.removeFromLeft(112);
    auto valueArea = area.removeFromRight(68);
    area.removeFromRight(4);
    macro.titleLabel.setBounds(labelArea);
    macro.valueLabel.setBounds(valueArea);
    macro.slider.setBounds(area);
  }

  void layoutFourButtons(
    juce::Rectangle<int> row,
    juce::TextButton& a,
    juce::TextButton& b,
    juce::TextButton& c,
    juce::TextButton& d
  ) {
    auto area = row;
    const int gap = 4;
    const int w = (area.getWidth() - (gap * 3)) / 4;
    a.setBounds(area.removeFromLeft(w));
    area.removeFromLeft(gap);
    b.setBounds(area.removeFromLeft(w));
    area.removeFromLeft(gap);
    c.setBounds(area.removeFromLeft(w));
    area.removeFromLeft(gap);
    d.setBounds(area);
  }

  void layoutTwoButtons(juce::Rectangle<int> row, juce::TextButton& left, juce::TextButton& right) {
    auto leftArea = row.removeFromLeft((row.getWidth() - 4) / 2);
    row.removeFromLeft(4);
    left.setBounds(leftArea);
    right.setBounds(row);
  }

  void syncControlsFromParameters() {
    const juce::ScopedValueSetter<bool> guard(ignoreControlCallbacks, true);

    syncSlider(roomSizeDial.slider, roomSizeParam);
    syncSlider(dampDial.slider, dampParam);
    syncSlider(widthDial.slider, widthParam);
    syncSlider(dryFader.slider, dryParam);
    syncSlider(wetFader.slider, wetParam);

    roomSizeDial.valueLabel.setText(paramValueString(roomSizeParam), juce::dontSendNotification);
    dampDial.valueLabel.setText(paramValueString(dampParam), juce::dontSendNotification);
    widthDial.valueLabel.setText(paramValueString(widthParam), juce::dontSendNotification);
    dryFader.valueLabel.setText(paramValueString(dryParam), juce::dontSendNotification);
    wetFader.valueLabel.setText(paramValueString(wetParam), juce::dontSendNotification);

    // Derived knob to mirror perceived early reflections intensity (not a real Tracktion parameter).
    const float earlyAmount = computeEarlyEnergy();
    earlyEnergyDial.slider.setRange(0.0, 1.0, 0.0);
    earlyEnergyDial.slider.setValue(earlyAmount, juce::dontSendNotification);
    earlyEnergyDial.valueLabel.setText(percentString(earlyAmount), juce::dontSendNotification);

    const bool freezeOn = getParamActual(modeParam, 0.0F) >= 0.5F;
    freezeButton.setToggleState(freezeOn, juce::dontSendNotification);
    freezeButton.setButtonText(freezeOn ? "FREEZE ON" : "FREEZE");

    syncEasyMacrosFromParameters();
    syncPresetButtons();
    updateEasyPageUi();
    updateDerivedVisuals();
  }

  void syncEasyMacrosFromParameters() {
    const juce::ScopedValueSetter<bool> guard(ignoreEasyMacroCallbacks, true);
    easySizeMacro.slider.setValue(getParamNorm(roomSizeParam, 0.3F), juce::dontSendNotification);
    easyToneMacro.slider.setValue(1.0F - getParamNorm(dampParam, 0.5F), juce::dontSendNotification);
    easyWidthMacro.slider.setValue(getParamNorm(widthParam, 1.0F), juce::dontSendNotification);

    easySizeMacro.valueLabel.setText(paramValueString(roomSizeParam), juce::dontSendNotification);
    easyToneMacro.valueLabel.setText(percentString(1.0F - getParamNorm(dampParam, 0.5F)), juce::dontSendNotification);
    easyWidthMacro.valueLabel.setText(paramValueString(widthParam), juce::dontSendNotification);
  }

  void syncPresetButtons() {
    const juce::ScopedValueSetter<bool> guard(ignorePresetButtonSync, true);
    presetSmallRoomButton.setToggleState(activePreset == SpacePreset::smallRoom, juce::dontSendNotification);
    presetWideHallButton.setToggleState(activePreset == SpacePreset::wideHall, juce::dontSendNotification);
    presetPlateGlowButton.setToggleState(activePreset == SpacePreset::plateGlow, juce::dontSendNotification);
    presetFreezePadButton.setToggleState(activePreset == SpacePreset::freezePad, juce::dontSendNotification);
  }

  void selectEasyPage(SpacePreset page, bool applyPresetNow) {
    activePreset = page;
    if (applyPresetNow) {
      applyPreset(page);
      return;
    }
    syncPresetButtons();
    updateEasyPageUi();
    updateDerivedVisuals();
    resized();
    repaint();
  }

  void updateEasyPageUi() {
    auto setMacroTitle = [](EasyMacroControl& macro, const juce::String& text) {
      macro.titleLabel.setText(text.toUpperCase(), juce::dontSendNotification);
    };

    const bool easy = viewMode == ViewMode::easy;
    if (!easy) {
      presetSmallRoomButton.setButtonText("Small Room");
      presetWideHallButton.setButtonText("Wide Hall");
      presetPlateGlowButton.setButtonText("Plate Glow");
      presetFreezePadButton.setButtonText("Freeze Pad");
      easyPageHeaderLabel.setText({}, juce::dontSendNotification);
      easyPageDescriptionLabel.setText({}, juce::dontSendNotification);
      return;
    }

    presetSmallRoomButton.setButtonText("ROOM");
    presetWideHallButton.setButtonText("HALL");
    presetPlateGlowButton.setButtonText("PLATE");
    presetFreezePadButton.setButtonText("FREEZE");

    switch (activePreset) {
      case SpacePreset::smallRoom:
        easyPageHeaderLabel.setText("ROOM PAGE", juce::dontSendNotification);
        easyPageDescriptionLabel.setText(
          "Kurzer, direkter Raum fuer Vocals, Drums und Inserts. Fokus auf Naehe und Klarheit.",
          juce::dontSendNotification
        );
        setMacroTitle(easySizeMacro, "Room Size");
        setMacroTitle(easyToneMacro, "Wall Bright");
        setMacroTitle(easyWidthMacro, "Stereo Width");
        break;
      case SpacePreset::wideHall:
        easyPageHeaderLabel.setText("HALL PAGE", juce::dontSendNotification);
        easyPageDescriptionLabel.setText(
          "Breiter Hall mit mehr Tiefe. Gut fuer Pads, Atmos und weit hinten platzierte Signale.",
          juce::dontSendNotification
        );
        setMacroTitle(easySizeMacro, "Hall Length");
        setMacroTitle(easyToneMacro, "Air");
        setMacroTitle(easyWidthMacro, "Spread");
        break;
      case SpacePreset::plateGlow:
        easyPageHeaderLabel.setText("PLATE PAGE", juce::dontSendNotification);
        easyPageDescriptionLabel.setText(
          "Dichter Plate-Charakter mit brillanterem Tail. Praktisch fuer Vocals und Synth-Layer.",
          juce::dontSendNotification
        );
        setMacroTitle(easySizeMacro, "Plate Body");
        setMacroTitle(easyToneMacro, "Sheen");
        setMacroTitle(easyWidthMacro, "Focus Width");
        break;
      case SpacePreset::freezePad:
        easyPageHeaderLabel.setText("FREEZE PAGE", juce::dontSendNotification);
        easyPageDescriptionLabel.setText(
          "Ambient-Flache mit Freeze. Dry runter, Wet hoch und Width ausfahren fuer Pads/Transitions.",
          juce::dontSendNotification
        );
        setMacroTitle(easySizeMacro, "Pad Body");
        setMacroTitle(easyToneMacro, "Ice Tone");
        setMacroTitle(easyWidthMacro, "Space Width");
        break;
    }
  }

  void syncSlider(juce::Slider& slider, const tracktion::engine::AutomatableParameter::Ptr& param) {
    if (param == nullptr) {
      slider.setEnabled(false);
      return;
    }
    slider.setEnabled(true);
    slider.setValue(param->getCurrentValue(), juce::dontSendNotification);
  }

  float computeEarlyEnergy() const {
    const float size = getParamNorm(roomSizeParam, 0.3F);
    const float width = getParamNorm(widthParam, 1.0F);
    const float damp = getParamNorm(dampParam, 0.5F);
    const float wet = getParamNorm(wetParam, 0.33F);
    const float dry = getParamNorm(dryParam, 0.5F);
    const float early = (wet * 0.45F) + ((1.0F - damp) * 0.25F) + ((1.0F - size) * 0.20F) + (width * 0.10F);
    return juce::jlimit(0.0F, 1.0F, early * lerp(0.78F, 1.08F, dry));
  }

  void updateDerivedVisuals() {
    const float size = getParamNorm(roomSizeParam, 0.3F);
    const float damp = getParamNorm(dampParam, 0.5F);
    const float wet = getParamNorm(wetParam, 0.33F);
    const float dry = getParamNorm(dryParam, 0.5F);
    const float width = getParamNorm(widthParam, 1.0F);
    const bool freeze = getParamActual(modeParam, 0.0F) >= 0.5F;
    const float early = computeEarlyEnergy();
    const float tail = juce::jlimit(0.0F, 1.0F, (size * 0.55F + wet * 0.35F + (1.0F - damp) * 0.10F));
    const int roomClass = juce::roundToInt(lerp(2.0F, 10.0F, size));
    const int spread = juce::roundToInt(width * 100.0F);
    const int density = juce::roundToInt((1.0F - damp) * 100.0F);

    roomReadoutLabel.setText(
      "Room " + juce::String(roomClass)
      + "  |  Tail " + percentString(tail)
      + "  |  Early " + percentString(early)
      + "\nStereo " + juce::String(spread) + "%  |  Density " + juce::String(density) + "%"
      + "  |  Freeze " + (freeze ? "On" : "Off")
      + "\nDry " + percentString(dry) + "  |  Wet " + percentString(wet)
      + "  |  Input " + percentString(inputReactivePeakHold),
      juce::dontSendNotification
    );

    bottomInfoLabel.setText(
      freeze
        ? "Freeze aktiv: Hall wird gehalten. Raum-Pulse reagieren live auf das Track-Signal fuer sichtbare Impulse."
        : "Size = Raumgroesse, Damp = Hoehenabbau im Tail, Width = Stereo-Breite, Dry/Wet = Signalanteile. Raum-Pulse reagieren auf Audio.",
      juce::dontSendNotification
    );
  }

  void applyPreset(SpacePreset preset) {
    struct Target {
      float roomSize;
      float damp;
      float width;
      float dry;
      float wet;
      float mode;
    };

    Target t{};
    switch (preset) {
      case SpacePreset::smallRoom:
        t = { 0.20F, 0.62F, 0.45F, 0.72F, 0.28F, 0.0F };
        break;
      case SpacePreset::wideHall:
        t = { 0.78F, 0.38F, 0.95F, 0.52F, 0.55F, 0.0F };
        break;
      case SpacePreset::plateGlow:
        t = { 0.48F, 0.28F, 0.72F, 0.58F, 0.47F, 0.0F };
        break;
      case SpacePreset::freezePad:
        t = { 0.92F, 0.18F, 1.00F, 0.12F, 0.88F, 1.0F };
        break;
    }
    activePreset = preset;

    auto apply = [&](tracktion::engine::AutomatableParameter::Ptr& p, float v) {
      if (p == nullptr) return;
      p->parameterChangeGestureBegin();
      setParamActual(p, v);
      p->parameterChangeGestureEnd();
    };

    apply(roomSizeParam, t.roomSize);
    apply(dampParam, t.damp);
    apply(widthParam, t.width);
    apply(dryParam, t.dry);
    apply(wetParam, t.wet);
    apply(modeParam, t.mode);

    syncControlsFromParameters();
    repaint();
  }

  void setViewMode(ViewMode nextMode) {
    if (viewMode == nextMode) {
      updateModeUi();
      return;
    }
    viewMode = nextMode;
    updateModeUi();
    resized();
    repaint();
  }

  void updateModeUi() {
    const bool easy = viewMode == ViewMode::easy;
    easyModeButton.setToggleState(easy, juce::dontSendNotification);
    proModeButton.setToggleState(!easy, juce::dontSendNotification);

    roomSizeDial.titleLabel.setVisible(!easy);
    roomSizeDial.slider.setVisible(!easy);
    roomSizeDial.valueLabel.setVisible(!easy);
    dampDial.titleLabel.setVisible(!easy);
    dampDial.slider.setVisible(!easy);
    dampDial.valueLabel.setVisible(!easy);
    widthDial.titleLabel.setVisible(!easy);
    widthDial.slider.setVisible(!easy);
    widthDial.valueLabel.setVisible(!easy);
    earlyEnergyDial.titleLabel.setVisible(!easy);
    earlyEnergyDial.slider.setVisible(!easy);
    earlyEnergyDial.valueLabel.setVisible(!easy);

    easySizeMacro.titleLabel.setVisible(easy);
    easySizeMacro.slider.setVisible(easy);
    easySizeMacro.valueLabel.setVisible(easy);
    easyToneMacro.titleLabel.setVisible(easy);
    easyToneMacro.slider.setVisible(easy);
    easyToneMacro.valueLabel.setVisible(easy);
    easyWidthMacro.titleLabel.setVisible(easy);
    easyWidthMacro.slider.setVisible(easy);
    easyWidthMacro.valueLabel.setVisible(easy);
    easyPageHeaderLabel.setVisible(easy);
    easyPageDescriptionLabel.setVisible(easy);

    freezeHintLabel.setVisible(true);

    if (easy) {
      subtitleLabel.setText(
        "Easy: Style-Page waehlen, dann Raumgroesse, Brightness und Stereo Width formen. Dry/Wet rechts.",
        juce::dontSendNotification
      );
      modeHintLabel.setText(
        "Small Room / Wide Hall / Plate Glow / Freeze Pad = schnelle Startpunkte. Danach Makros anpassen.",
        juce::dontSendNotification
      );
      spacePanelTitleLabel.setText("EASY MACROS", juce::dontSendNotification);
      mixPanelTitleLabel.setText("MIX", juce::dontSendNotification);
      presetPanelTitleLabel.setText("STYLE PAGES", juce::dontSendNotification);
      tailPanelTitleLabel.setText("TAIL PREVIEW", juce::dontSendNotification);
      freezeHintLabel.setText("Freeze haelt den Hall. Im Easy-Modus fuer Pads/Ambience direkt nutzbar.", juce::dontSendNotification);
    } else {
      subtitleLabel.setText(
        "Pro: Direkte Parameterkontrolle fuer Tracktion Reverb inkl. Tail- und Reflection-Visualisierung.",
        juce::dontSendNotification
      );
      modeHintLabel.setText(
        "Dials = exakte Werte. Presets bleiben als Style-Startpunkte, danach fein abstimmen.",
        juce::dontSendNotification
      );
      spacePanelTitleLabel.setText("SPACE", juce::dontSendNotification);
      mixPanelTitleLabel.setText("MIX", juce::dontSendNotification);
      presetPanelTitleLabel.setText("SPACES", juce::dontSendNotification);
      tailPanelTitleLabel.setText("TAIL CURVE", juce::dontSendNotification);
      freezeHintLabel.setText("Freeze haelt den Hall fast unendlich. Gut fuer Ambient-Layer.", juce::dontSendNotification);
    }

    updateEasyPageUi();
    syncPresetButtons();
  }

  void drawBackdrop(juce::Graphics& g, juce::Rectangle<float> bounds) {
    g.setColour(juce::Colour(0x0616C6FF));
    for (float x = bounds.getX(); x < bounds.getRight(); x += 40.0F) {
      g.drawVerticalLine(juce::roundToInt(x), bounds.getY(), bounds.getBottom());
    }
    for (float y = bounds.getY(); y < bounds.getBottom(); y += 34.0F) {
      g.drawHorizontalLine(juce::roundToInt(y), bounds.getX(), bounds.getRight());
    }
  }

  void drawRoomField(juce::Graphics& g, juce::Rectangle<float> bounds) {
    if (bounds.isEmpty()) return;

    const float size = getParamNorm(roomSizeParam, 0.3F);
    const float damp = getParamNorm(dampParam, 0.5F);
    const float wet = getParamNorm(wetParam, 0.33F);
    const float dry = getParamNorm(dryParam, 0.5F);
    const float width = getParamNorm(widthParam, 1.0F);
    const bool freeze = getParamActual(modeParam, 0.0F) >= 0.5F;
    const float early = computeEarlyEnergy();
    const float inputEnergy = inputReactiveEnergy;
    const float inputPeak = inputReactivePeakHold;
    const float inputTransient = inputReactiveTransient;
    const float stereoBias = inputReactiveStereoBias;

    auto panel = bounds;
    g.setGradientFill(juce::ColourGradient(
      juce::Colour(0xFF141A22), panel.getTopLeft(),
      juce::Colour(0xFF11161E), panel.getBottomLeft(),
      false
    ));
    g.fillRoundedRectangle(panel, 10.0F);
    g.setColour(juce::Colour(0x16FFFFFF));
    g.drawRoundedRectangle(panel, 10.0F, 1.0F);

    // Atmosphere haze / tail energy
    const juce::Colour tailA = freeze ? juce::Colour(0x557FDBFF) : juce::Colour(0x4054A7FF);
    const juce::Colour tailB = freeze ? juce::Colour(0x4099F7FF) : juce::Colour(0x30C585FF);
    juce::ColourGradient haze(
      tailA.withAlpha(0.12F + wet * 0.16F + inputPeak * 0.14F), panel.getCentreX(), panel.getY() + 10.0F,
      tailB.withAlpha(0.04F + (1.0F - damp) * 0.16F + inputEnergy * 0.10F), panel.getCentreX(), panel.getBottom() - 10.0F,
      false
    );
    g.setGradientFill(haze);
    g.fillRoundedRectangle(panel.reduced(2.0F), 8.0F);

    auto room = panel.reduced(18.0F);
    const float baseW = room.getWidth() * lerp(0.42F, 0.82F, size);
    const float topW = baseW * lerp(0.88F, 1.06F, size);
    const float bodyH = room.getHeight() * lerp(0.48F, 0.74F, size);
    const float centerY = room.getCentreY() + lerp(12.0F, -4.0F, size);
    const float topY = centerY - bodyH * 0.45F;
    const float bottomY = centerY + bodyH * 0.42F;
    const float topRx = topW * 0.5F;
    const float bottomRx = baseW * 0.5F;
    const float topRy = lerp(12.0F, 22.0F, size);
    const float bottomRy = lerp(18.0F, 32.0F, size);
    const float waistAmount = lerp(0.35F, 0.10F, damp);
    const float stereoOffset = (width - 0.5F) * 18.0F;
    const juce::Point<float> c(panel.getCentreX(), 0.0F);
    const juce::Point<float> topCenter(c.x, topY);
    const juce::Point<float> bottomCenter(c.x, bottomY);

    auto drawWireframeLayer = [&](float xOffset, juce::Colour lineColour, float alphaScale) {
      const juce::Colour edgeColour = lineColour.withAlpha(alphaScale * (0.40F + wet * 0.45F + inputPeak * 0.20F));
      const juce::Colour ribColour = lineColour.withAlpha(alphaScale * (0.22F + early * 0.55F + inputEnergy * 0.18F));

      g.setColour(edgeColour);
      g.drawEllipse(topCenter.x - topRx + xOffset, topCenter.y - topRy, topRx * 2.0F, topRy * 2.0F, 1.5F);
      g.drawEllipse(bottomCenter.x - bottomRx + xOffset, bottomCenter.y - bottomRy, bottomRx * 2.0F, bottomRy * 2.0F, 1.5F);

      // Mid waist
      const float waistRx = lerp(bottomRx * 0.55F, bottomRx * 0.95F, 1.0F - waistAmount);
      const float waistRy = lerp(8.0F, 15.0F, 1.0F - damp);
      const float waistY = lerp(topY, bottomY, 0.42F + 0.08F * std::sin(roomAnimationPhase * 0.6F));
      g.setColour(edgeColour.withAlpha(alphaScale * (0.12F + (1.0F - damp) * 0.30F)));
      g.drawEllipse(topCenter.x - waistRx + xOffset, waistY - waistRy, waistRx * 2.0F, waistRy * 2.0F, 1.0F);

      // Ribs
      constexpr int ribs = 16;
      for (int i = 0; i < ribs; ++i) {
        const float t = static_cast<float>(i) / static_cast<float>(ribs - 1);
        const float angle = juce::MathConstants<float>::pi * (0.08F + t * 0.84F);
        const float cx = std::cos(angle);
        const float sy = std::sin(angle);
        const float topX = topCenter.x + xOffset + cx * topRx;
        const float topYY = topCenter.y + sy * topRy;
        const float bottomX = bottomCenter.x + xOffset + cx * bottomRx;
        const float bottomYY = bottomCenter.y + sy * bottomRy;
        const float pinch = std::sin(t * juce::MathConstants<float>::pi) * waistAmount * 0.22F;
        juce::Path rib;
        rib.startNewSubPath(topX, topYY);
        rib.quadraticTo(
          lerp(topX, bottomX, 0.52F),
          lerp(topYY, bottomYY, 0.44F) - bodyH * pinch,
          bottomX,
          bottomYY
        );
        g.setColour(ribColour.interpolatedWith(lineColour, 0.25F + 0.55F * (1.0F - t)));
        g.strokePath(rib, juce::PathStrokeType(1.0F));
      }

      // Floor grid hint
      g.setColour(lineColour.withAlpha(alphaScale * (0.07F + dry * 0.20F)));
      for (int i = 0; i < 7; ++i) {
        const float t = static_cast<float>(i) / 6.0F;
        const float y = lerp(bottomY + 14.0F, panel.getBottom() - 16.0F, t);
        const float w = lerp(bottomRx * 0.35F, bottomRx * 1.25F, t);
        g.drawHorizontalLine(juce::roundToInt(y), c.x - w + xOffset, c.x + w + xOffset);
      }
    };

    // Stereo layers
    drawWireframeLayer(-stereoOffset * 0.35F, juce::Colour(0xFF66B9FF), 0.75F);
    drawWireframeLayer(stereoOffset * 0.35F, freeze ? juce::Colour(0xFFA1C8FF) : juce::Colour(0xFFB58CFF), 0.65F);

    // Animated reflections pulses
    const int pulseCount = 4 + juce::roundToInt(inputPeak * 3.0F);
    const float pulseCenterX = c.x + stereoBias * (panel.getWidth() * 0.06F);
    for (int i = 0; i < pulseCount; ++i) {
      const float t = std::fmod((roomAnimationPhase * (freeze ? 0.15F : 0.42F)) + (static_cast<float>(i) / pulseCount), 1.0F);
      const float alpha = (1.0F - t) * (0.08F + wet * 0.22F + inputEnergy * 0.22F + inputTransient * 0.25F);
      const float spread = lerp(0.18F, 0.92F, t);
      const float pulseRx = lerp(topRx * 0.35F, bottomRx * (0.55F + width * 0.55F), spread);
      const float pulseRy = lerp(topRy * 0.30F, bottomRy * (0.45F + size * 0.45F), spread);
      const float pulseY = lerp(topY + 8.0F, bottomY + 10.0F, spread);
      const juce::Colour pulseColor = (freeze ? juce::Colour(0xFF9CD8FF) : juce::Colour(0xFF7FE7D8)).withAlpha(alpha);
      g.setColour(pulseColor);
      g.drawEllipse(pulseCenterX - pulseRx, pulseY - pulseRy, pulseRx * 2.0F, pulseRy * 2.0F, 1.0F + inputTransient * 0.6F);
    }

    if (inputTransient > 0.02F) {
      const float flash = juce::jlimit(0.0F, 1.0F, inputTransient * 1.35F);
      const float ringRx = lerp(topRx * 0.24F, topRx * 0.48F, flash);
      const float ringRy = lerp(topRy * 0.28F, topRy * 0.62F, flash);
      g.setColour((freeze ? juce::Colour(0xFFC6EAFF) : juce::Colour(0xFFA4FFF0)).withAlpha(0.10F + flash * 0.20F));
      g.fillEllipse(pulseCenterX - ringRx, topY + 6.0F - ringRy, ringRx * 2.0F, ringRy * 2.0F);
      g.setColour((freeze ? juce::Colour(0xFFB5DEFF) : juce::Colour(0xFF8FF7E0)).withAlpha(0.24F + flash * 0.42F));
      g.drawEllipse(pulseCenterX - ringRx * 1.15F, topY + 6.0F - ringRy * 1.15F, ringRx * 2.3F, ringRy * 2.3F, 1.2F);
    }

    if (freeze) {
      auto badge = panel.removeFromTop(24).removeFromRight(92).reduced(4, 2).toFloat();
      g.setColour(juce::Colour(0x223278C9));
      g.fillRoundedRectangle(badge, 8.0F);
      g.setColour(juce::Colour(0x66BDE3FF));
      g.drawRoundedRectangle(badge, 8.0F, 1.0F);
      g.setColour(juce::Colours::white.withAlpha(0.92F));
      g.setFont(juce::Font(juce::FontOptions(11.5F, juce::Font::bold)));
      g.drawFittedText("FREEZE", badge.toNearestInt(), juce::Justification::centred, 1);
    }
  }

  void drawReflectionMeter(juce::Graphics& g, juce::Rectangle<float> bounds) {
    if (bounds.isEmpty()) return;
    g.setColour(juce::Colour(0x0FFFFFFF));
    g.fillRoundedRectangle(bounds, 8.0F);
    g.setColour(juce::Colour(0x14FFFFFF));
    g.drawRoundedRectangle(bounds, 8.0F, 1.0F);

    const float early = computeEarlyEnergy();
    const float damp = getParamNorm(dampParam, 0.5F);
    const float width = getParamNorm(widthParam, 1.0F);
    const float inputEnergy = inputReactiveEnergy;
    const float inputTransient = inputReactiveTransient;
    const int bars = 18;
    const float gap = 3.0F;
    const float barWidth = (bounds.getWidth() - ((bars + 1) * gap)) / bars;
    for (int i = 0; i < bars; ++i) {
      const float t = static_cast<float>(i) / static_cast<float>(bars - 1);
      const float pattern = 0.35F + 0.65F * std::sin((t * 8.0F) + roomAnimationPhase * (1.2F + width));
      const float heightNorm = juce::jlimit(
        0.04F,
        1.0F,
        (early * (0.55F + 0.45F * pattern) * (1.0F - damp * 0.35F) * (0.65F + inputEnergy * 0.90F))
          + (inputTransient * 0.22F * (0.4F + 0.6F * pattern))
      );
      const float h = heightNorm * (bounds.getHeight() - 12.0F);
      const float x = bounds.getX() + gap + i * (barWidth + gap);
      const float y = bounds.getBottom() - 6.0F - h;
      const juce::Colour c = juce::Colour(0xFF6AC6FF).interpolatedWith(juce::Colour(0xFF89F0D8), t).withAlpha(0.15F + heightNorm * 0.75F);
      g.setColour(c);
      g.fillRoundedRectangle(x, y, barWidth, h, juce::jmin(2.0F, barWidth * 0.4F));
    }
  }

  void drawStereoBadge(juce::Graphics& g, juce::Rectangle<float> bounds) {
    if (bounds.isEmpty()) return;
    g.setColour(juce::Colour(0x10FFFFFF));
    g.fillRoundedRectangle(bounds, 7.0F);
    g.setColour(juce::Colour(0x18FFFFFF));
    g.drawRoundedRectangle(bounds, 7.0F, 1.0F);

    const float width = getParamNorm(widthParam, 1.0F);
    const float wet = getParamNorm(wetParam, 0.33F);
    const float inputEnergy = inputReactiveEnergy;
    const float spread = juce::jlimit(0.0F, 1.0F, width * (0.75F + wet * 0.25F));
    auto inner = bounds.reduced(10.0F, 6.0F);
    const float centerX = inner.getCentreX();
    const float centerY = inner.getCentreY();
    const float offset = inner.getWidth() * (0.08F + spread * 0.26F);
    const float r = 4.0F + wet * 3.0F + inputEnergy * 1.8F;

    g.setColour(juce::Colours::white.withAlpha(0.70F));
    g.setFont(juce::Font(juce::FontOptions(11.0F, juce::Font::bold)));
    g.drawFittedText("STEREO", inner.removeFromLeft(58).toNearestInt(), juce::Justification::centredLeft, 1);

    g.setColour(juce::Colour(0x2AFFFFFF));
    g.drawVerticalLine(juce::roundToInt(centerX), bounds.getY() + 6.0F, bounds.getBottom() - 6.0F);

    g.setColour(juce::Colour(0xFF78C9FF).withAlpha(0.72F));
    g.fillEllipse(centerX - offset - r + (inputReactiveStereoBias * 2.5F), centerY - r, r * 2.0F, r * 2.0F);
    g.setColour(juce::Colour(0xFF9AEAD8).withAlpha(0.72F));
    g.fillEllipse(centerX + offset - r + (inputReactiveStereoBias * 2.5F), centerY - r, r * 2.0F, r * 2.0F);

    g.setColour(juce::Colours::lightgrey.withAlpha(0.75F));
    g.drawFittedText(juce::String(juce::roundToInt(spread * 100.0F)) + "%", bounds.toNearestInt().removeFromRight(44), juce::Justification::centred, 1);
  }

  void drawDecayBar(juce::Graphics& g, juce::Rectangle<float> bounds) {
    if (bounds.isEmpty()) return;
    g.setColour(juce::Colour(0x0FFFFFFF));
    g.fillRoundedRectangle(bounds, 7.0F);
    g.setColour(juce::Colour(0x16FFFFFF));
    g.drawRoundedRectangle(bounds, 7.0F, 1.0F);

    const float size = getParamNorm(roomSizeParam, 0.3F);
    const float damp = getParamNorm(dampParam, 0.5F);
    const float wet = getParamNorm(wetParam, 0.33F);
    const float inputPeak = inputReactivePeakHold;
    const float tailAmount = juce::jlimit(0.0F, 1.0F, size * 0.65F + wet * 0.35F);
    const float brightness = juce::jlimit(0.0F, 1.0F, (1.0F - damp) * 0.7F + wet * 0.3F);
    const float fillWidth = (bounds.getWidth() - 4.0F) * tailAmount;
    auto fill = bounds.reduced(2.0F);
    fill.setWidth(fillWidth);
    g.setGradientFill(juce::ColourGradient(
      juce::Colour(0xFF62C6FF).withAlpha(0.25F + brightness * 0.35F + inputPeak * 0.12F), fill.getTopLeft(),
      juce::Colour(0xFFA487FF).withAlpha(0.18F + brightness * 0.28F + inputPeak * 0.10F), fill.getBottomRight(),
      false
    ));
    g.fillRoundedRectangle(fill, 5.0F);
  }

  void drawTailCurve(juce::Graphics& g, juce::Rectangle<float> bounds) {
    if (bounds.isEmpty()) return;
    g.setColour(juce::Colour(0xFF101722));
    g.fillRoundedRectangle(bounds, 8.0F);
    g.setColour(juce::Colour(0x14FFFFFF));
    g.drawRoundedRectangle(bounds, 8.0F, 1.0F);

    const float size = getParamNorm(roomSizeParam, 0.3F);
    const float damp = getParamNorm(dampParam, 0.5F);
    const float wet = getParamNorm(wetParam, 0.33F);
    const float dry = getParamNorm(dryParam, 0.5F);
    const float width = getParamNorm(widthParam, 1.0F);
    const bool freeze = getParamActual(modeParam, 0.0F) >= 0.5F;
    const float inputEnergy = inputReactiveEnergy;
    const float inputPeak = inputReactivePeakHold;

    const auto inner = bounds.reduced(10.0F);
    g.setColour(juce::Colour(0x14FFFFFF));
    g.drawHorizontalLine(juce::roundToInt(inner.getBottom()), inner.getX(), inner.getRight());
    g.drawHorizontalLine(juce::roundToInt(inner.getY() + inner.getHeight() * 0.5F), inner.getX(), inner.getRight());

    juce::Path tailA;
    juce::Path tailB;
    const int steps = juce::jmax(80, juce::roundToInt(inner.getWidth()));
    for (int i = 0; i <= steps; ++i) {
      const float t = static_cast<float>(i) / static_cast<float>(steps);
      const float x = inner.getX() + t * inner.getWidth();
      const float decayRate = freeze ? 0.08F : lerp(4.8F, 1.1F, size);
      const float dampCurve = lerp(1.0F, 0.25F, damp);
      const float env = freeze ? (0.75F + inputPeak * 0.06F) : std::exp(-t * decayRate) * lerp(0.95F, 0.55F, damp);
      const float ripple = std::sin((t * (8.0F + width * 10.0F)) + roomAnimationPhase * (0.35F + wet * 0.65F));
      const float shimmer = std::sin((t * 18.0F) + roomAnimationPhase * 0.8F + juce::MathConstants<float>::pi * 0.3F);
      const float reactiveScale = 1.0F + inputEnergy * 0.25F;
      const float yA = inner.getBottom() - (env * dampCurve * wet * inner.getHeight() * 0.85F * reactiveScale)
                       - (ripple * inner.getHeight() * 0.04F * wet * (0.8F + inputPeak * 0.8F));
      const float yB = inner.getBottom() - (env * (0.65F + width * 0.25F) * wet * inner.getHeight() * 0.70F * reactiveScale)
                       - (shimmer * inner.getHeight() * 0.03F * wet * (0.8F + inputPeak * 0.7F));
      if (i == 0) {
        tailA.startNewSubPath(x, yA);
        tailB.startNewSubPath(x, yB);
      } else {
        tailA.lineTo(x, yA);
        tailB.lineTo(x, yB);
      }
    }

    // Fill under wet tail
    juce::Path fill(tailA);
    fill.lineTo(inner.getRight(), inner.getBottom());
    fill.lineTo(inner.getX(), inner.getBottom());
    fill.closeSubPath();
    g.setColour((freeze ? juce::Colour(0x4084D7FF) : juce::Colour(0x304CB6FF)).withAlpha(0.12F + wet * 0.20F));
    g.fillPath(fill);

    g.setColour(juce::Colour(0xFF6EC9FF).withAlpha(0.72F + wet * 0.18F));
    g.strokePath(tailA, juce::PathStrokeType(2.0F, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
    g.setColour((freeze ? juce::Colour(0xFFB0DAFF) : juce::Colour(0xFFAA8DFF)).withAlpha(0.30F + wet * 0.35F));
    g.strokePath(tailB, juce::PathStrokeType(1.4F, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));

    // Dry line reference
    const float dryY = inner.getBottom() - (dry * inner.getHeight() * 0.35F);
    g.setColour(juce::Colour(0x55FFFFFF));
    g.drawHorizontalLine(juce::roundToInt(dryY), inner.getX(), inner.getRight());

    if (inputReactiveTransient > 0.02F) {
      const float x = inner.getX() + inner.getWidth() * juce::jlimit(0.0F, 1.0F, 0.05F + (inputReactiveStereoBias + 1.0F) * 0.45F);
      g.setColour(juce::Colour(0xAA9DEAFF).withAlpha(0.22F + inputReactiveTransient * 0.40F));
      g.drawVerticalLine(juce::roundToInt(x), inner.getY(), inner.getBottom());
    }
  }

  void drawDialGlow(juce::Graphics& g, const juce::Slider& slider, juce::Colour c) {
    auto b = slider.getBounds().toFloat().reduced(8.0F);
    if (b.isEmpty()) return;
    g.setColour(c.withAlpha(0.12F));
    g.fillEllipse(b.expanded(6.0F));
  }

  void timerCallback() override {
    updateInputReactiveEnvelopeFromMeter();
    const float speed = (getParamNorm(roomSizeParam, 0.3F) * 0.35F) + (getParamNorm(wetParam, 0.33F) * 0.20F) + 0.02F;
    const bool freeze = getParamActual(modeParam, 0.0F) >= 0.5F;
    const float audioMotionBoost = 1.0F + (inputReactiveEnergy * 0.55F) + (inputReactiveTransient * 0.70F);
    roomAnimationPhase += (freeze ? speed * 0.35F : speed) * audioMotionBoost;
    if (roomAnimationPhase > 10000.0F) {
      roomAnimationPhase = std::fmod(roomAnimationPhase, juce::MathConstants<float>::twoPi);
    }
    repaint(roomFieldPanelBounds);
    repaint(mixPanelBounds);
    repaint(tailPanelBounds);
  }

  void handleAsyncUpdate() override {
    syncControlsFromParameters();
    repaint();
  }

  void curveHasChanged(tracktion::engine::AutomatableParameter&) override {}
  void currentValueChanged(tracktion::engine::AutomatableParameter&) override { triggerAsyncUpdate(); }
  void parameterChanged(tracktion::engine::AutomatableParameter&, float) override { triggerAsyncUpdate(); }

  tracktion::engine::ReverbPlugin& reverb;
  tracktion::engine::AutomatableParameter::Ptr roomSizeParam;
  tracktion::engine::AutomatableParameter::Ptr dampParam;
  tracktion::engine::AutomatableParameter::Ptr wetParam;
  tracktion::engine::AutomatableParameter::Ptr dryParam;
  tracktion::engine::AutomatableParameter::Ptr widthParam;
  tracktion::engine::AutomatableParameter::Ptr modeParam;

  juce::Label titleLabel;
  juce::Label subtitleLabel;
  juce::TextButton easyModeButton;
  juce::TextButton proModeButton;
  juce::Label modeHintLabel;
  juce::Label roomFieldTitleLabel;
  juce::Label spacePanelTitleLabel;
  juce::Label mixPanelTitleLabel;
  juce::Label presetPanelTitleLabel;
  juce::Label tailPanelTitleLabel;

  DialControl roomSizeDial;
  DialControl dampDial;
  DialControl widthDial;
  DialControl earlyEnergyDial;
  EasyMacroControl easySizeMacro;
  EasyMacroControl easyToneMacro;
  EasyMacroControl easyWidthMacro;

  FaderControl dryFader;
  FaderControl wetFader;

  juce::TextButton freezeButton;
  juce::Label freezeHintLabel;
  juce::TextButton presetSmallRoomButton;
  juce::TextButton presetWideHallButton;
  juce::TextButton presetPlateGlowButton;
  juce::TextButton presetFreezePadButton;
  juce::Label easyPageHeaderLabel;
  juce::Label easyPageDescriptionLabel;

  juce::Label roomReadoutLabel;
  juce::Label bottomInfoLabel;

  juce::Rectangle<int> roomFieldPanelBounds;
  juce::Rectangle<int> spacePanelBounds;
  juce::Rectangle<int> mixPanelBounds;
  juce::Rectangle<int> tailPanelBounds;
  juce::Rectangle<float> roomFieldBounds;
  juce::Rectangle<float> reflectionMeterBounds;
  juce::Rectangle<float> stereoBadgeBounds;
  juce::Rectangle<float> decayBarBounds;
  juce::Rectangle<float> tailCurveBounds;

  tracktion::engine::LevelMeasurer::Client levelMeterClient;
  tracktion::engine::LevelMeasurer* attachedLevelMeasurer = nullptr;
  float roomAnimationPhase = 0.0F;
  float inputReactiveEnergy = 0.0F;
  float inputReactivePeakHold = 0.0F;
  float inputReactiveTransient = 0.0F;
  float inputReactiveStereoBias = 0.0F;
  ViewMode viewMode = ViewMode::easy;
  SpacePreset activePreset = SpacePreset::smallRoom;
  bool ignoreControlCallbacks = false;
  bool ignoreEasyMacroCallbacks = false;
  bool ignorePresetButtonSync = false;
};

class FallbackParameterRow final : public juce::Component,
                                   private tracktion::engine::AutomatableParameter::Listener {
 public:
  explicit FallbackParameterRow(tracktion::engine::AutomatableParameter& parameterToControl)
    : parameter(&parameterToControl) {
    nameLabel.setText(parameter->getParameterName(), juce::dontSendNotification);
    nameLabel.setJustificationType(juce::Justification::centredLeft);
    addAndMakeVisible(nameLabel);

    hintLabel.setText(buildPlainLanguageHint(*parameter), juce::dontSendNotification);
    hintLabel.setJustificationType(juce::Justification::centredLeft);
    hintLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.78F));
    addAndMakeVisible(hintLabel);

    valueLabel.setJustificationType(juce::Justification::centredRight);
    addAndMakeVisible(valueLabel);

    slider.setSliderStyle(juce::Slider::LinearHorizontal);
    slider.setTextBoxStyle(juce::Slider::NoTextBox, false, 0, 0);
    slider.setRange(0.0, 1.0, 0.0);
    slider.onDragStart = [safe = juce::Component::SafePointer<FallbackParameterRow>(this)]() {
      if (safe != nullptr && safe->parameter != nullptr) {
        safe->parameter->parameterChangeGestureBegin();
      }
    };
    slider.onDragEnd = [safe = juce::Component::SafePointer<FallbackParameterRow>(this)]() {
      if (safe != nullptr && safe->parameter != nullptr) {
        safe->parameter->parameterChangeGestureEnd();
      }
    };
    slider.onValueChange = [safe = juce::Component::SafePointer<FallbackParameterRow>(this)]() {
      if (safe == nullptr || safe->parameter == nullptr || safe->ignoreSliderCallback) {
        return;
      }
      safe->parameter->setNormalisedParameter(static_cast<float>(safe->slider.getValue()), juce::sendNotificationSync);
      safe->syncFromParameter();
    };
    addAndMakeVisible(slider);

    if (const auto defaultValue = parameter->getDefaultValue(); defaultValue.has_value()) {
      const float normalised = parameter->valueRange.convertTo0to1(defaultValue.value());
      slider.setDoubleClickReturnValue(true, normalised);
    }

    parameter->addListener(this);
    syncFromParameter();
  }

  ~FallbackParameterRow() override {
    if (parameter != nullptr) {
      parameter->removeListener(this);
    }
  }

  void resized() override {
    auto area = getLocalBounds().reduced(10, 6);
    auto header = area.removeFromTop(20);
    nameLabel.setBounds(header.removeFromLeft(juce::jmax(140, header.getWidth() / 2)));
    valueLabel.setBounds(header);
    hintLabel.setBounds(area.removeFromTop(16));
    slider.setBounds(area.removeFromTop(24));
  }

 private:
  void syncFromParameter() {
    if (parameter == nullptr) {
      return;
    }
    const juce::ScopedValueSetter<bool> guard(ignoreSliderCallback, true);
    slider.setValue(parameter->getCurrentNormalisedValue(), juce::dontSendNotification);
    valueLabel.setText(parameter->getCurrentValueAsStringWithLabel(), juce::dontSendNotification);
  }

  void curveHasChanged(tracktion::engine::AutomatableParameter&) override {}

  void currentValueChanged(tracktion::engine::AutomatableParameter&) override {
    syncFromParameter();
  }

  void parameterChanged(tracktion::engine::AutomatableParameter&, float) override {
    syncFromParameter();
  }

  tracktion::engine::AutomatableParameter::Ptr parameter;
  juce::Label nameLabel;
  juce::Label hintLabel;
  juce::Label valueLabel;
  juce::Slider slider;
  bool ignoreSliderCallback = false;
};

class FallbackPluginEditor final : public tracktion::engine::Plugin::EditorComponent {
 public:
  explicit FallbackPluginEditor(tracktion::engine::Plugin& pluginToControl)
    : plugin(pluginToControl) {
    titleLabel.setText(plugin.getName(), juce::dontSendNotification);
    titleLabel.setJustificationType(juce::Justification::centredLeft);
    titleLabel.setFont(juce::Font(juce::FontOptions(17.0F, juce::Font::bold)));
    addAndMakeVisible(titleLabel);

    subtitleLabel.setText("Intuitive Parameteransicht (Fallback fuer Plugins ohne eigene UI)", juce::dontSendNotification);
    subtitleLabel.setJustificationType(juce::Justification::centredLeft);
    subtitleLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.85F));
    addAndMakeVisible(subtitleLabel);

    viewport.setViewedComponent(&content, false);
    viewport.setScrollBarsShown(true, false);
    addAndMakeVisible(viewport);

    for (int index = 0; index < plugin.getNumAutomatableParameters(); ++index) {
      auto parameter = plugin.getAutomatableParameter(index);
      if (parameter == nullptr) {
        continue;
      }
      auto* row = rows.add(new FallbackParameterRow(*parameter));
      content.addAndMakeVisible(row);
    }

    emptyLabel.setText("Dieses Plugin hat keine automationsfaehigen Parameter.", juce::dontSendNotification);
    emptyLabel.setJustificationType(juce::Justification::centred);
    emptyLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.82F));
    content.addAndMakeVisible(emptyLabel);

    setSize(640, rows.isEmpty() ? 180 : 520);
  }

  bool allowWindowResizing() override {
    return true;
  }

  juce::ComponentBoundsConstrainer* getBoundsConstrainer() override {
    return {};
  }

  void resized() override {
    auto area = getLocalBounds().reduced(12);
    titleLabel.setBounds(area.removeFromTop(24));
    subtitleLabel.setBounds(area.removeFromTop(20));
    area.removeFromTop(6);
    viewport.setBounds(area);

    const int contentWidth = juce::jmax(220, viewport.getWidth() - 16);
    int y = 10;
    if (rows.isEmpty()) {
      emptyLabel.setVisible(true);
      emptyLabel.setBounds(0, y, contentWidth, 80);
      y += 90;
    } else {
      emptyLabel.setVisible(false);
      for (auto* row : rows) {
        row->setBounds(0, y, contentWidth, 74);
        y += 78;
      }
    }
    content.setSize(contentWidth, juce::jmax(y + 10, viewport.getHeight()));
  }

 private:
  tracktion::engine::Plugin& plugin;
  juce::Label titleLabel;
  juce::Label subtitleLabel;
  juce::Viewport viewport;
  juce::Component content;
  juce::OwnedArray<FallbackParameterRow> rows;
  juce::Label emptyLabel;
};

class NativePluginWindow final : public juce::DocumentWindow {
 public:
  explicit NativePluginWindow(tracktion::engine::Plugin& pluginToShow)
    : juce::DocumentWindow(
        pluginToShow.getName(),
        juce::Colours::black,
        juce::DocumentWindow::allButtons,
        kShouldAddPluginWindowToDesktop
      ),
      plugin(pluginToShow) {
    if (kShouldAddPluginWindowToDesktop) {
      // Use OS window chrome so plugin editors are draggable and expose min/max/close controls.
      setUsingNativeTitleBar(true);
    }
    getConstrainer()->setMinimumOnscreenAmounts(0x10000, 50, 30, 50);
    setResizeLimits(100, 50, 4000, 4000);

    recreateEditor();
    setBoundsConstrained(getLocalBounds() + plugin.windowState->choosePositionForPluginWindow());

#if JUCE_LINUX
    setAlwaysOnTop(true);
    addToDesktop();
#endif

    updateStoredBounds = true;
  }

  ~NativePluginWindow() override {
    updateStoredBounds = false;
    plugin.edit.flushPluginStateIfNeeded(plugin);
    setEditor(nullptr);
  }

  static std::unique_ptr<juce::Component> create(tracktion::engine::Plugin& plugin) {
    auto window = std::make_unique<NativePluginWindow>(plugin);
    if (window->getEditor() == nullptr) {
      return {};
    }
    window->show();
    return window;
  }

  void recreateEditor() {
    setEditor(nullptr);
    auto nextEditor = plugin.createEditor();
    if (nextEditor == nullptr) {
      if (auto* equaliserPlugin = dynamic_cast<tracktion::engine::EqualiserPlugin*>(&plugin)) {
        nextEditor = std::make_unique<EqualiserFallbackEditor>(*equaliserPlugin);
      } else if (auto* reverbPlugin = dynamic_cast<tracktion::engine::ReverbPlugin*>(&plugin)) {
        nextEditor = std::make_unique<ReverbFallbackEditor>(*reverbPlugin);
      } else if (auto* chorusPlugin = dynamic_cast<tracktion::engine::ChorusPlugin*>(&plugin)) {
        nextEditor = std::make_unique<ChorusFallbackEditor>(*chorusPlugin);
      } else {
        nextEditor = std::make_unique<FallbackPluginEditor>(plugin);
      }
    }
    setEditor(std::move(nextEditor));
  }

  void recreateEditorAsync() {
    setEditor(nullptr);
    juce::Timer::callAfterDelay(50, [safe = juce::Component::SafePointer<NativePluginWindow>(this)]() {
      if (safe != nullptr) {
        safe->recreateEditor();
      }
    });
  }

 private:
  void ensureWindowIsOnScreen() {
    auto bounds = getBounds();
    if (bounds.getWidth() < 80 || bounds.getHeight() < 50) {
      resizeToFitEditor(true);
      bounds = getBounds();
    }

    auto& displays = juce::Desktop::getInstance().getDisplays();
    const auto* display = displays.getDisplayForRect(bounds);
    const bool isVisibleOnAnyDisplay = display != nullptr && display->userArea.intersects(bounds);
    if (!isVisibleOnAnyDisplay) {
      const int width = std::max(360, bounds.getWidth());
      const int height = std::max(220, bounds.getHeight());
      centreWithSize(width, height);
      setBoundsConstrained(getBounds());
    }
  }

  void show() {
    ensureWindowIsOnScreen();
    setVisible(true);
    toFront(true);
    setBoundsConstrained(getBounds());
    juce::Timer::callAfterDelay(40, [safe = juce::Component::SafePointer<NativePluginWindow>(this)]() {
      if (safe != nullptr) {
        safe->resizeToFitEditor(true);
        safe->ensureWindowIsOnScreen();
        safe->toFront(true);
      }
    });
  }

  void setEditor(std::unique_ptr<tracktion::engine::Plugin::EditorComponent> newEditor) {
    JUCE_AUTORELEASEPOOL {
      const int desiredWidth = newEditor != nullptr ? std::max(8, newEditor->getWidth()) : 0;
      const int desiredHeight = newEditor != nullptr ? std::max(8, newEditor->getHeight()) : 0;
      setConstrainer(nullptr);
      editor.reset();

      if (newEditor != nullptr) {
        editor = std::move(newEditor);
        setContentNonOwned(editor.get(), true);
      }

      setResizable(editor == nullptr || editor->allowWindowResizing(), false);

      if (editor != nullptr && editor->allowWindowResizing()) {
        setConstrainer(editor->getBoundsConstrainer());
      }

      if (desiredWidth > 8 && desiredHeight > 8) {
        setSize(desiredWidth, desiredHeight);
      } else {
        resizeToFitEditor(true);
      }
    }
  }

  tracktion::engine::Plugin::EditorComponent* getEditor() const {
    return editor.get();
  }

  void resizeToFitEditor(bool force = false) {
    if (force || editor == nullptr || !editor->allowWindowResizing()) {
      setSize(
        std::max(8, editor != nullptr ? editor->getWidth() : 0),
        std::max(8, editor != nullptr ? editor->getHeight() : 0)
      );
    }
  }

  void resized() override {
    if (editor != nullptr) {
      editor->setBounds(getLocalBounds());
    }
  }

  void childBoundsChanged(juce::Component* child) override {
    if (child == editor.get()) {
      plugin.edit.pluginChanged(plugin);
      resizeToFitEditor();
    }
  }

  void moved() override {
    if (updateStoredBounds && plugin.windowState != nullptr) {
      plugin.windowState->lastWindowBounds = getBounds();
      plugin.edit.pluginChanged(plugin);
    }
  }

  void userTriedToCloseWindow() override {
    if (plugin.windowState != nullptr) {
      plugin.windowState->closeWindowExplicitly();
    }
  }

  void closeButtonPressed() override {
    userTriedToCloseWindow();
  }

  float getDesktopScaleFactor() const override {
    return 1.0F;
  }

  std::unique_ptr<tracktion::engine::Plugin::EditorComponent> editor;
  tracktion::engine::Plugin& plugin;
  bool updateStoredBounds = false;
};

class NativeUIBehaviour final : public tracktion::engine::UIBehaviour {
 public:
  std::unique_ptr<juce::Component> createPluginWindow(tracktion::engine::PluginWindowState& state) override {
    if (auto* pluginState = dynamic_cast<tracktion::engine::Plugin::WindowState*>(&state)) {
      return NativePluginWindow::create(pluginState->plugin);
    }
    return {};
  }

  void recreatePluginWindowContentAsync(tracktion::engine::Plugin& plugin) override {
    if (auto* window = dynamic_cast<NativePluginWindow*>(plugin.windowState->pluginWindow.get())) {
      window->recreateEditorAsync();
      return;
    }

    tracktion::engine::UIBehaviour::recreatePluginWindowContentAsync(plugin);
  }
};

bool parseIntStrict(const std::string& text, int32_t& value) {
  if (text.empty()) {
    return false;
  }

  char* end = nullptr;
  const long parsed = std::strtol(text.c_str(), &end, 10);
  if (end == text.c_str() || *end != '\0') {
    return false;
  }
  if (parsed < std::numeric_limits<int32_t>::min() || parsed > std::numeric_limits<int32_t>::max()) {
    return false;
  }

  value = static_cast<int32_t>(parsed);
  return true;
}

bool isInitialised(std::string& error) {
  if (!gState || !gState->engine) {
    error = "tracktion backend is not initialised";
    return false;
  }
  return true;
}

/** Returns false if no edit exists (caller should send edit:reset first). */
static bool requireEdit(std::string& error) {
  if (!gState || !gState->edit) {
    error = "no edit (send edit:reset first)";
    return false;
  }
  return true;
}

bool isTrackUtilityPlugin(tracktion::engine::Plugin* plugin) {
  return dynamic_cast<tracktion::engine::VolumeAndPanPlugin*>(plugin) != nullptr
      || dynamic_cast<tracktion::engine::VCAPlugin*>(plugin) != nullptr
      || dynamic_cast<tracktion::engine::LevelMeterPlugin*>(plugin) != nullptr;
}

tracktion::engine::Plugin* getTrackPluginByVisibleIndex(
  tracktion::engine::AudioTrack& track,
  int32_t visiblePluginIndex,
  int32_t& actualPluginIndex,
  std::string& error
) {
  actualPluginIndex = -1;
  error.clear();

  if (visiblePluginIndex < 0) {
    error = "plugin_index out of range";
    return nullptr;
  }

  int32_t visibleIndex = 0;
  for (int32_t rawIndex = 0; rawIndex < track.pluginList.size(); ++rawIndex) {
    auto* plugin = track.pluginList[rawIndex];
    if (plugin == nullptr || isTrackUtilityPlugin(plugin)) {
      continue;
    }
    if (visibleIndex == visiblePluginIndex) {
      actualPluginIndex = rawIndex;
      return plugin;
    }
    ++visibleIndex;
  }

  error = "plugin_index out of range";
  return nullptr;
}

bool openPluginEditorImpl(int32_t trackId, int32_t pluginIndex, std::string& error) {
  auto* track = getAudioTrackByIndex(trackId);
  if (track == nullptr) {
    error = "track_id out of range";
    return false;
  }

  int32_t actualPluginIndex = -1;
  auto* plugin = getTrackPluginByVisibleIndex(*track, pluginIndex, actualPluginIndex, error);
  if (plugin == nullptr) {
    return false;
  }

  std::fprintf(
    stderr,
    "[thestuu-native] openPluginEditor request track=%d visiblePluginIndex=%d actualPluginIndex=%d name=\"%s\"\n",
    static_cast<int>(trackId),
    static_cast<int>(pluginIndex),
    static_cast<int>(actualPluginIndex),
    plugin->getName().toRawUTF8()
  );

  plugin->showWindowExplicitly();
  const bool isShowing = plugin->windowState != nullptr && plugin->windowState->isWindowShowing();
  if (plugin->windowState != nullptr && plugin->windowState->pluginWindow != nullptr) {
    const auto bounds = plugin->windowState->pluginWindow->getBounds();
    std::fprintf(
      stderr,
      "[thestuu-native] openPluginEditor window showing=%d bounds=(x=%d y=%d w=%d h=%d)\n",
      isShowing ? 1 : 0,
      bounds.getX(),
      bounds.getY(),
      bounds.getWidth(),
      bounds.getHeight()
    );
  } else {
    std::fprintf(
      stderr,
      "[thestuu-native] openPluginEditor window showing=%d (no window object)\n",
      isShowing ? 1 : 0
    );
  }

  if (isShowing) {
    error.clear();
    return true;
  }

  error = "plugin editor window could not be opened";
  return false;
}

bool createDefaultEdit(int32_t trackCount, std::string& error) {
  if (!gState || !gState->engine) {
    error = "tracktion backend is not initialised";
    return false;
  }

  const int32_t safeTrackCount = std::max<int32_t>(1, trackCount);
  auto nextEdit = tracktion::engine::createEmptyEdit(*gState->engine, juce::File());
  if (!nextEdit) {
    error = "failed to create default edit";
    return false;
  }

  nextEdit->ensureNumberOfAudioTracks(safeTrackCount);
  const auto tracks = tracktion::engine::getAudioTracks(*nextEdit);
  const juce::String defaultOutId = nextEdit->engine.getDeviceManager().getDefaultWaveOutDeviceID();
  for (int i = 0; i < static_cast<int>(tracks.size()); ++i) {
    if (auto* track = tracks[i]) {
      track->setName("Track " + juce::String(i + 1));
      // Ensure every track outputs to the default device so it is included in the playback graph.
      if (defaultOutId.isNotEmpty()) {
        track->getOutput().setOutputToDeviceID(defaultOutId);
      } else {
        track->getOutput().setOutputToDefaultDevice(false);
      }
      if (i < 2) {
        auto* dev = track->getOutput().getOutputDevice(false);
        std::cerr << "[thestuu-native] edit:reset track " << (i + 1) << " output device: "
                  << (dev ? dev->getName().toStdString() : "null") << std::endl;
      }
    }
  }

  gState->edit = std::move(nextEdit);
  // Do not call ensureContextAllocated here – it must run on the message thread (in transportPlay).
  error.clear();
  return true;
}

static bool createDefaultEditOnMessageThread(int32_t trackCount, std::string& error) {
  error.clear();
  auto* mm = juce::MessageManager::getInstance();
  if (mm && mm->isThisTheMessageThread()) {
    return createDefaultEdit(trackCount, error);
  }
  if (!mm) {
    error = "JUCE MessageManager not available";
    return false;
  }
  std::mutex mtx;
  std::condition_variable cv;
  std::atomic<bool> done{false};
  bool ok = false;
  mm->callAsync([&]() {
    ok = createDefaultEdit(trackCount, error);
    {
      std::lock_guard<std::mutex> lock(mtx);
      done = true;
    }
    cv.notify_one();
  });
  std::unique_lock<std::mutex> lock(mtx);
  const bool finished = cv.wait_for(lock, std::chrono::seconds(15), [&]() { return done.load(); });
  if (!finished) {
    error = "timeout during edit:reset (message thread)";
    return false;
  }
  return ok;
}

PluginParameterInfo toPluginParameterInfo(const tracktion::engine::AutomatableParameter& parameter) {
  PluginParameterInfo info;
  info.id = parameter.paramID.toStdString();
  info.name = parameter.getParameterName().toStdString();
  const auto range = parameter.getValueRange();
  info.min = static_cast<double>(range.getStart());
  info.max = static_cast<double>(range.getEnd());
  info.value = static_cast<double>(parameter.getCurrentNormalisedValue());
  return info;
}

std::vector<PluginParameterInfo> collectAutomatableParameters(tracktion::engine::Plugin& plugin) {
  std::vector<PluginParameterInfo> parameters;
  parameters.reserve(static_cast<size_t>(std::max(0, plugin.getNumAutomatableParameters())));

  for (int i = 0; i < plugin.getNumAutomatableParameters(); ++i) {
    auto param = plugin.getAutomatableParameter(i);
    if (param == nullptr) {
      continue;
    }
    parameters.push_back(toPluginParameterInfo(*param));
  }

  return parameters;
}

std::vector<PluginParameterInfo> collectAudioProcessorParameters(juce::AudioPluginInstance& instance) {
  std::vector<PluginParameterInfo> parameters;
  instance.refreshParameterList();
  auto& rawParams = instance.getParameters();
  parameters.reserve(static_cast<size_t>(std::max(0, rawParams.size())));

  for (int i = 0; i < rawParams.size(); ++i) {
    auto* param = rawParams.getUnchecked(i);
    if (param == nullptr) {
      continue;
    }

    PluginParameterInfo info;
    info.id = std::to_string(i);
    if (auto* withId = dynamic_cast<juce::AudioProcessorParameterWithID*>(param)) {
      if (withId->paramID.isNotEmpty()) {
        info.id = withId->paramID.toStdString();
      }
    }
    info.name = param->getName(256).toStdString();
    if (info.name.empty()) {
      info.name = "Parameter " + std::to_string(i + 1);
    }
    info.min = 0.0;
    info.max = 1.0;
    info.value = static_cast<double>(juce::jlimit(0.0F, 1.0F, param->getValue()));
    parameters.push_back(std::move(info));
  }

  return parameters;
}

std::vector<PluginParameterInfo> collectBuiltInPluginParameters(
  const juce::String& typeName,
  const juce::PluginDescription& description
) {
  std::vector<PluginParameterInfo> parameters;
  if (!gState || !gState->engine || !gState->edit) {
    return parameters;
  }

  if (auto plugin = gState->engine->getPluginManager().createNewPlugin(*gState->edit, typeName, description)) {
    parameters = collectAutomatableParameters(*plugin);
  }

  return parameters;
}

std::vector<PluginParameterInfo> collectUltrasoundParameters() {
  std::vector<PluginParameterInfo> parameters;
  if (!gState || !gState->engine || !gState->edit) {
    return parameters;
  }

  juce::PluginDescription ignored;
  if (auto plugin = gState->engine->getPluginManager().createNewPlugin(*gState->edit, UltrasoundPlugin::xmlTypeName, ignored)) {
    parameters = collectAutomatableParameters(*plugin);
  }

  return parameters;
}

bool findPluginDescriptionByUid(const std::string& pluginUid, juce::PluginDescription& result) {
  if (!gState || !gState->engine) {
    return false;
  }

  const auto cached = gState->pluginByUid.find(pluginUid);
  if (cached != gState->pluginByUid.end()) {
    result = cached->second;
    return true;
  }

  const auto known = gState->engine->getPluginManager().knownPluginList.getTypes();
  for (const auto& desc : known) {
    if (desc.createIdentifierString().toStdString() == pluginUid || desc.matchesIdentifierString(pluginUid)) {
      result = desc;
      gState->pluginByUid.emplace(pluginUid, desc);
      return true;
    }
  }

  return false;
}

tracktion::engine::AutomatableParameter* findParameter(tracktion::engine::Plugin& plugin, const std::string& paramId) {
  if (paramId.empty()) {
    return nullptr;
  }

  if (auto byId = plugin.getAutomatableParameterByID(paramId)) {
    return byId.get();
  }

  int32_t index = -1;
  if (parseIntStrict(paramId, index)) {
    if (index >= 0 && index < plugin.getNumAutomatableParameters()) {
      if (auto byIndex = plugin.getAutomatableParameter(index)) {
        return byIndex.get();
      }
    }
  }

  for (int i = 0; i < plugin.getNumAutomatableParameters(); ++i) {
    auto param = plugin.getAutomatableParameter(i);
    if (param == nullptr) {
      continue;
    }
    if (param->getParameterName().equalsIgnoreCase(juce::String::fromUTF8(paramId.c_str()))) {
      return param.get();
    }
  }

  return nullptr;
}

bool scanExternalPluginFormats(std::string& error) {
  if (!gState || !gState->engine) {
    error = "tracktion backend is not initialised";
    return false;
  }

  auto& pm = gState->engine->getPluginManager();
  pm.setUsesSeparateProcessForScanning(false);

  for (int i = 0; i < pm.pluginFormatManager.getNumFormats(); ++i) {
    auto* format = pm.pluginFormatManager.getFormat(i);
    if (format == nullptr || !format->canScanForPlugins()) {
      continue;
    }

    const auto defaultLocations = format->getDefaultLocationsToSearch();
    const auto files = format->searchPathsForPlugins(defaultLocations, true, false);

    for (const auto& fileOrIdentifier : files) {
      juce::OwnedArray<juce::PluginDescription> found;
      pm.knownPluginList.scanAndAddFile(fileOrIdentifier, true, found, *format);
    }
  }

  pm.knownPluginList.scanFinished();
  error.clear();
  return true;
}

PluginInfo makeUltrasoundInfo() {
  PluginInfo info;
  info.name = "Ultrasound";
  info.uid = kUltrasoundUid;
  info.type = tracktion::engine::PluginManager::builtInPluginFormatName;
  info.kind = "instrument";
  info.isInstrument = true;
  info.isNative = true;
  info.parameters = collectUltrasoundParameters();
  return info;
}

void appendTracktionCorePluginInfos(std::vector<PluginInfo>& plugins) {
  if (!gState || !gState->engine || !gState->edit) {
    return;
  }

  for (const auto& spec : kTracktionCorePluginSpecs) {
    PluginInfo info;
    info.name = spec.displayName;
    info.uid = spec.uid;
    info.type = tracktion::engine::PluginManager::builtInPluginFormatName;
    info.kind = spec.isInstrument ? "instrument" : "effect";
    info.isInstrument = spec.isInstrument;
    info.isNative = true;
    const auto description = createTracktionCorePluginDescription(spec);
    info.parameters = collectBuiltInPluginParameters(spec.xmlTypeName, description);
    gState->parameterCacheByUid[info.uid] = info.parameters;
    plugins.push_back(std::move(info));
  }
}
}  // namespace

tracktion::engine::AudioTrack* getAudioTrackByIndex(int32_t trackId) {
  if (!gState || !gState->edit || trackId < 1) {
    return nullptr;
  }
  auto tracks = tracktion::engine::getAudioTracks(*gState->edit);
  const int index = trackId - 1;
  if (index < 0 || index >= tracks.size()) {
    return nullptr;
  }
  return tracks[index];
}

bool setTrackMute(int32_t trackId, bool mute, std::string& error) {
  if (!gState || !gState->engine) {
    error = "backend not initialised";
    return false;
  }
  auto* track = getAudioTrackByIndex(trackId);
  if (track == nullptr) {
    error = "track_id out of range";
    return false;
  }
  track->setMute(mute);
  transportRebuildGraphOnly();
  return true;
}

bool setTrackSolo(int32_t trackId, bool solo, std::string& error) {
  if (!gState || !gState->engine) {
    error = "backend not initialised";
    return false;
  }
  auto* track = getAudioTrackByIndex(trackId);
  if (track == nullptr) {
    error = "track_id out of range";
    return false;
  }
  track->setSolo(solo);
  transportRebuildGraphOnly();
  return true;
}

bool setTrackVolume(int32_t trackId, double volume, std::string& error) {
  if (!gState || !gState->engine) {
    error = "backend not initialised";
    return false;
  }
  auto* track = getAudioTrackByIndex(trackId);
  if (track == nullptr) {
    error = "track_id out of range";
    return false;
  }
  if (auto* volPan = track->getVolumePlugin()) {
    const float pos = static_cast<float>(std::max(0.0, std::min(1.0, volume)));
    volPan->setSliderPos(pos);
    transportRebuildGraphOnly();
  }
  return true;
}

bool setTrackPan(int32_t trackId, double pan, std::string& error) {
  if (!gState || !gState->engine) {
    error = "backend not initialised";
    return false;
  }
  auto* track = getAudioTrackByIndex(trackId);
  if (track == nullptr) {
    error = "track_id out of range";
    return false;
  }
  if (auto* volPan = track->getVolumePlugin()) {
    const float p = static_cast<float>(std::max(-1.0, std::min(1.0, pan)));
    volPan->setPan(p);
    transportRebuildGraphOnly();
  }
  return true;
}

bool setTrackRecordArm(int32_t trackId, bool armed, std::string& error) {
  if (!gState || !gState->engine) {
    error = "backend not initialised";
    return false;
  }
  auto* track = getAudioTrackByIndex(trackId);
  if (track == nullptr) {
    error = "track_id out of range";
    return false;
  }
  using namespace tracktion::engine;
  track->getWaveInputDevice().setEnabled(armed);
  juce::ValueTree devState = gState->edit->getEditInputDevices().getInstanceStateForInputDevice(track->getWaveInputDevice());
  if (devState.isValid()) {
    juce::ValueTree destState;
    for (int i = 0; i < devState.getNumChildren(); ++i) {
      const auto& c = devState.getChild(i);
      if (c.hasType(IDs::INPUTDEVICEDESTINATION) && EditItemID::fromProperty(c, IDs::targetID) == track->itemID) {
        destState = c;
        break;
      }
    }
    if (!destState.isValid()) {
      destState = juce::ValueTree(IDs::INPUTDEVICEDESTINATION);
      destState.setProperty(IDs::targetID, track->itemID.toVar(), nullptr);
      destState.setProperty(IDs::armed, armed, nullptr);
      devState.addChild(destState, -1, nullptr);
    } else {
      destState.setProperty(IDs::armed, armed, nullptr);
    }
  }
  // Route the physical default wave input (mic) to this track so recording actually goes here.
  if (tracktion::engine::WaveInputDevice* defaultWaveIn = gState->engine->getDeviceManager().getDefaultWaveInDevice()) {
    if (!defaultWaveIn->isTrackDevice()) {
      // Live/low-latency recording: shift recorded audio earlier so it lines up with the beat (like FL Studio).
      // Positive recordAdjustMs increases getAdjustmentSeconds(), which makes adjust more negative → clip starts earlier.
      if (armed)
        defaultWaveIn->setRecordAdjustmentMs(12.0);
      juce::ValueTree physState = gState->edit->getEditInputDevices().getInstanceStateForInputDevice(*defaultWaveIn);
      if (physState.isValid()) {
        if (armed) {
          // Exclusive arm: remove other destinations so only this track receives the mic.
          for (int i = physState.getNumChildren(); --i >= 0;) {
            const auto& c = physState.getChild(i);
            if (c.hasType(IDs::INPUTDEVICEDESTINATION) && EditItemID::fromProperty(c, IDs::targetID) != track->itemID)
              physState.removeChild(i, nullptr);
          }
          juce::ValueTree destState;
          for (int i = 0; i < physState.getNumChildren(); ++i) {
            const auto& c = physState.getChild(i);
            if (c.hasType(IDs::INPUTDEVICEDESTINATION) && EditItemID::fromProperty(c, IDs::targetID) == track->itemID) {
              destState = c;
              break;
            }
          }
          if (!destState.isValid()) {
            destState = juce::ValueTree(IDs::INPUTDEVICEDESTINATION);
            destState.setProperty(IDs::targetID, track->itemID.toVar(), nullptr);
            destState.setProperty(IDs::armed, true, nullptr);
            physState.addChild(destState, -1, nullptr);
          } else {
            destState.setProperty(IDs::armed, true, nullptr);
          }
        } else {
          for (int i = physState.getNumChildren(); --i >= 0;) {
            const auto& c = physState.getChild(i);
            if (c.hasType(IDs::INPUTDEVICEDESTINATION) && EditItemID::fromProperty(c, IDs::targetID) == track->itemID) {
              physState.removeChild(i, nullptr);
              break;
            }
          }
        }
      }
    }
  }
  std::fprintf(stderr, "[thestuu-native] setTrackRecordArm track=%d armed=%d (device enabled + destination armed)\n", static_cast<int>(trackId), armed ? 1 : 0);
  transportRebuildGraphOnly();
  return true;
}

bool initialiseBackend(const BackendConfig& config, BackendRuntimeInfo& info, std::string& error) {
  try {
    gState = std::make_unique<BackendState>();
    gState->sampleRate = std::isfinite(config.sampleRate) && config.sampleRate > 0.0 ? config.sampleRate : 48000.0;
    gState->bufferSize = config.bufferSize > 0 ? config.bufferSize : 256;

    gState->juce = std::make_unique<juce::ScopedJuceInitialiser_GUI>();
    gState->engine = std::make_unique<tracktion::engine::Engine>(
      "TheStuuNative",
      std::make_unique<NativeUIBehaviour>(),
      nullptr
    );
    gState->engine->getPluginManager().setUsesSeparateProcessForScanning(false);
    gState->engine->getPluginManager().createBuiltInType<UltrasoundPlugin>();

    auto& deviceManager = gState->engine->getDeviceManager();
    deviceManager.initialise(2, 2);
    gState->spectrumAnalyzerTap = std::make_unique<GlobalSpectrumAnalyzerTap>();
    deviceManager.deviceManager.addAudioCallback(gState->spectrumAnalyzerTap.get());

    // Do not create an edit here: the device list is not ready yet (Rebuilding Wave Device List
    // runs later), so tracks would get output device null and be excluded from the playback graph.
    // The edit is created on the first edit:reset from the Node engine, when devices are ready.

    info.enabled = true;
    info.tracktion = true;
    info.description =
      "tracktion backend ready (sampleRate=" + std::to_string(static_cast<int>(config.sampleRate)) +
      ", bufferSize=" + std::to_string(config.bufferSize) + ", defaultTracks=" +
      std::to_string(kDefaultTrackCount) + ")";
    error.clear();
    return true;
  } catch (const std::exception& ex) {
    error = ex.what();
  } catch (...) {
    error = "Unknown error during Tracktion backend init";
  }

  gState.reset();
  info = {};
  return false;
}

void shutdownBackend() {
  if (gState && gState->engine && gState->spectrumAnalyzerTap) {
    gState->engine->getDeviceManager().deviceManager.removeAudioCallback(gState->spectrumAnalyzerTap.get());
  }
  gState.reset();
}

bool resetDefaultEdit(int32_t trackCount, std::string& error) {
  if (!isInitialised(error)) {
    return false;
  }

  try {
    const int32_t safeTrackCount = trackCount > 0 ? trackCount : kDefaultTrackCount;
    if (!createDefaultEditOnMessageThread(safeTrackCount, error)) {
      return false;
    }
    gState->parameterCacheByUid.clear();
    error.clear();
    return true;
  } catch (const std::exception& ex) {
    error = ex.what();
    return false;
  } catch (...) {
    error = "unknown error during edit:reset";
    return false;
  }
}

bool scanPlugins(std::vector<PluginInfo>& plugins, std::string& error) {
  plugins.clear();
  if (!isInitialised(error)) {
    return false;
  }

  try {
    if (!scanExternalPluginFormats(error)) {
      return false;
    }

    gState->pluginByUid.clear();
    gState->parameterCacheByUid.clear();

    const auto known = gState->engine->getPluginManager().knownPluginList.getTypes();
    plugins.reserve(static_cast<size_t>(known.size() + kTracktionCorePluginSpecs.size() + 1));

    for (const auto& desc : known) {
      PluginInfo info;
      info.name = desc.name.toStdString();
      info.uid = desc.createIdentifierString().toStdString();
      info.type = desc.pluginFormatName.toStdString();
      info.isInstrument = desc.isInstrument;
      info.kind = info.isInstrument ? "instrument" : "effect";
      info.isNative = false;
      gState->pluginByUid.emplace(info.uid, desc);

      juce::String createError;
      if (auto instance = gState->engine->getPluginManager().createPluginInstance(
            desc,
            gState->sampleRate,
            gState->bufferSize,
            createError
          )) {
        info.parameters = collectAudioProcessorParameters(*instance);
      }

      gState->parameterCacheByUid[info.uid] = info.parameters;
      plugins.push_back(std::move(info));
    }

    appendTracktionCorePluginInfos(plugins);

    auto ultrasound = makeUltrasoundInfo();
    gState->parameterCacheByUid[ultrasound.uid] = ultrasound.parameters;
    plugins.push_back(std::move(ultrasound));

    error.clear();
    return true;
  } catch (const std::exception& ex) {
    error = ex.what();
    plugins.clear();
    return false;
  } catch (...) {
    error = "unknown error during vst:scan";
    plugins.clear();
    return false;
  }
}

bool loadPlugin(const std::string& pluginUid, int32_t trackId, LoadPluginResult& result, std::string& error) {
  result = {};

  if (!isInitialised(error)) {
    return false;
  }
  if (!requireEdit(error)) {
    return false;
  }

  try {
    auto* track = getAudioTrackByIndex(trackId);
    if (track == nullptr) {
      error = "track_id out of range";
      return false;
    }

    tracktion::engine::Plugin::Ptr plugin;
    std::string resolvedUid = pluginUid;
    std::string resolvedType = "unknown";
    bool resolvedIsInstrument = false;
    bool resolvedIsNative = false;

    if (pluginUid == kUltrasoundUid || juce::String::fromUTF8(pluginUid.c_str()).equalsIgnoreCase("ultrasound")) {
      juce::PluginDescription ignored;
      plugin = gState->edit->getPluginCache().createNewPlugin(UltrasoundPlugin::xmlTypeName, ignored);
      resolvedUid = kUltrasoundUid;
      resolvedType = tracktion::engine::PluginManager::builtInPluginFormatName;
      resolvedIsInstrument = true;
      resolvedIsNative = true;
    } else if (const auto* tracktionCorePlugin = findTracktionCorePluginSpecByUid(pluginUid)) {
      const auto description = createTracktionCorePluginDescription(*tracktionCorePlugin);
      plugin = gState->edit->getPluginCache().createNewPlugin(tracktionCorePlugin->xmlTypeName, description);
      resolvedUid = tracktionCorePlugin->uid;
      resolvedType = tracktion::engine::PluginManager::builtInPluginFormatName;
      resolvedIsInstrument = tracktionCorePlugin->isInstrument;
      resolvedIsNative = true;
    } else {
      juce::PluginDescription desc;
      if (!findPluginDescriptionByUid(pluginUid, desc)) {
        error = "VST not found: " + pluginUid;
        return false;
      }

      plugin = gState->edit->getPluginCache().createNewPlugin(tracktion::engine::ExternalPlugin::xmlTypeName, desc);
      resolvedType = desc.pluginFormatName.toStdString();
      resolvedIsInstrument = desc.isInstrument;
      resolvedIsNative = false;
    }

    if (plugin == nullptr) {
      error = "failed to create plugin instance";
      return false;
    }

    track->pluginList.insertPlugin(plugin, track->pluginList.size(), nullptr);
    const int pluginIndex = track->pluginList.indexOf(plugin.get());
    if (pluginIndex < 0) {
      error = "failed to insert plugin into track";
      return false;
    }

    result.trackId = trackId;
    result.pluginIndex = pluginIndex;
    result.name = plugin->getName().toStdString();
    result.uid = resolvedUid;
    result.type = resolvedType;
    result.isInstrument = resolvedIsInstrument;
    result.kind = result.isInstrument ? "instrument" : "effect";
    result.isNative = resolvedIsNative;
    result.parameters = collectAutomatableParameters(*plugin);
    gState->parameterCacheByUid[result.uid] = result.parameters;

    error.clear();
    return true;
  } catch (const std::exception& ex) {
    error = ex.what();
    result = {};
    return false;
  } catch (...) {
    error = "unknown error during vst:load";
    result = {};
    return false;
  }
}

bool openPluginEditor(int32_t trackId, int32_t pluginIndex, std::string& error) {
  error.clear();

  if (!isInitialised(error)) {
    return false;
  }
  if (!requireEdit(error)) {
    return false;
  }

  auto* mm = juce::MessageManager::getInstance();
  if (mm && mm->isThisTheMessageThread()) {
    return openPluginEditorImpl(trackId, pluginIndex, error);
  }
  if (!mm) {
    error = "JUCE MessageManager not available";
    return false;
  }

  std::mutex mtx;
  std::condition_variable cv;
  std::atomic<bool> done{false};
  bool ok = false;

  mm->callAsync([&]() {
    ok = openPluginEditorImpl(trackId, pluginIndex, error);
    {
      std::lock_guard<std::mutex> lock(mtx);
      done = true;
    }
    cv.notify_one();
  });

  std::unique_lock<std::mutex> lock(mtx);
  const bool finished = cv.wait_for(lock, std::chrono::seconds(10), [&]() { return done.load(); });
  if (!finished) {
    error = "timeout while opening plugin editor";
    return false;
  }
  return ok;
}

bool setPluginParameter(
  int32_t trackId,
  int32_t pluginIndex,
  const std::string& paramId,
  double value,
  PluginParameterInfo& result,
  std::string& error
) {
  result = {};

  if (!isInitialised(error)) {
    return false;
  }
  if (!requireEdit(error)) {
    return false;
  }

  try {
    auto* track = getAudioTrackByIndex(trackId);
    if (track == nullptr) {
      error = "track_id out of range";
      return false;
    }

    int32_t actualPluginIndex = -1;
    auto* plugin = getTrackPluginByVisibleIndex(*track, pluginIndex, actualPluginIndex, error);
    if (plugin == nullptr) {
      return false;
    }

    auto* parameter = findParameter(*plugin, paramId);
    if (parameter == nullptr) {
      error = "param_id not found: " + paramId;
      return false;
    }

    const float normalised = juce::jlimit(0.0F, 1.0F, static_cast<float>(value));
    parameter->setNormalisedParameter(normalised, juce::sendNotification);
    result = toPluginParameterInfo(*parameter);

    error.clear();
    return true;
  } catch (const std::exception& ex) {
    error = ex.what();
    result = {};
    return false;
  } catch (...) {
    error = "unknown error during vst:param:set";
    result = {};
    return false;
  }
}

bool importClipFile(const ClipImportRequest& request, ClipImportResult& result, std::string& error) {
  result = {};

  if (!isInitialised(error)) {
    return false;
  }
  if (!requireEdit(error)) {
    return false;
  }

  if (request.sourcePath.empty()) {
    error = "source_path is required";
    return false;
  }

  auto* track = getAudioTrackByIndex(request.trackId);
  if (track == nullptr) {
    error = "track_id out of range";
    return false;
  }

  juce::File sourceFile(request.sourcePath);
  if (!sourceFile.existsAsFile()) {
    error = "source file not found";
    return false;
  }

  tracktion::core::TimeRange clipRange;
  double resultStartBars = 0.0;
  double resultLengthBars = 0.0;

  // Prefer bars so clip position uses the edit’s tempo (avoids BPM mismatch with engine).
  const double beatsPerBar = estimateBeatsPerBar();
  double bpm = 128.0;
  if (gState && gState->edit) {
    bpm = gState->edit->tempoSequence.getBpmAt(tracktion::core::TimePosition::fromSeconds(0.0));
  }
  double startBars = request.startBars >= 0.0 ? request.startBars : 0.0;
  double lengthBars = request.lengthBars > 0.0 ? request.lengthBars : 1.0;
  if (request.lengthBars <= 0.0 && request.lengthSeconds > 0.0 && bpm > 0.0 && beatsPerBar > 0.0) {
    lengthBars = (request.lengthSeconds * bpm) / (60.0 * beatsPerBar);
    if (lengthBars <= 0.0) lengthBars = 1.0;
  }
  if (request.startBars < 0.0 && request.startSeconds >= 0.0 && bpm > 0.0 && beatsPerBar > 0.0) {
    startBars = (request.startSeconds * bpm) / (60.0 * beatsPerBar);
    if (startBars < 0.0) startBars = 0.0;
  }
  const double startBeats = startBars * beatsPerBar;
  const double lengthBeats = lengthBars * beatsPerBar;
  const auto startTime = convertBeatsToTime(startBeats);
  const auto endTime = convertBeatsToTime(startBeats + lengthBeats);
  clipRange = tracktion::core::TimeRange(startTime, endTime);
  resultStartBars = startBars;
  resultLengthBars = lengthBars;
  const double fileOffsetSec = (request.sourceOffsetSeconds >= 0.0) ? request.sourceOffsetSeconds : 0.0;
  std::fprintf(stderr, "[thestuu-native] clip import track %d at %.2f bars (%.3fs) length %.2f bars offset %.2fs\n",
               static_cast<int>(request.trackId), startBars, startTime.inSeconds(), lengthBars, fileOffsetSec);

  const tracktion::engine::ClipPosition position{clipRange, tracktion::core::TimeDuration::fromSeconds(fileOffsetSec)};

  auto clip = track->insertWaveClip(sourceFile.getFileNameWithoutExtension(), sourceFile, position, false);
  if (clip == nullptr) {
    error = "failed to insert clip";
    return false;
  }
  // Play from source file directly for all formats (WAV, MP3, FLAC, OGG, AAC, AIFF, etc.) without
  // proxy so behaviour is identical and playback works regardless of Tracktion’s needsCachedProxy.
  clip->setUsesProxy(false);

  if (request.fadeInSeconds > 0.0 || request.fadeOutSeconds > 0.0) {
    if (auto* acb = dynamic_cast<tracktion::engine::AudioClipBase*>(clip.get())) {
      if (request.fadeInSeconds > 0.0) {
        acb->setFadeIn(tracktion::core::TimeDuration::fromSeconds(request.fadeInSeconds));
      }
      if (request.fadeOutSeconds > 0.0) {
        acb->setFadeOut(tracktion::core::TimeDuration::fromSeconds(request.fadeOutSeconds));
      }
      const int inCurve = (request.fadeInCurve >= 1 && request.fadeInCurve <= 4) ? request.fadeInCurve : 1;
      const int outCurve = (request.fadeOutCurve >= 1 && request.fadeOutCurve <= 4) ? request.fadeOutCurve : 1;
      acb->setFadeInType(static_cast<tracktion::engine::AudioFadeCurve::Type>(inCurve));
      acb->setFadeOutType(static_cast<tracktion::engine::AudioFadeCurve::Type>(outCurve));
    }
  }

  result.trackId = request.trackId;
  result.startBars = resultStartBars;
  result.lengthBars = resultLengthBars;
  result.sourcePath = request.sourcePath;
  error.clear();
  return true;
}

bool importClipFileOnMessageThread(const ClipImportRequest& request, ClipImportResult& result, std::string& error) {
  result = {};
  error.clear();
  auto* mm = juce::MessageManager::getInstance();
  if (mm && mm->isThisTheMessageThread()) {
    return importClipFile(request, result, error);
  }
  if (!mm) {
    error = "JUCE MessageManager not available";
    return false;
  }
  std::mutex mtx;
  std::condition_variable cv;
  std::atomic<bool> done{false};
  bool ok = false;
  mm->callAsync([&]() {
    ok = importClipFile(request, result, error);
    {
      std::lock_guard<std::mutex> lock(mtx);
      done = true;
    }
    cv.notify_one();
  });
  std::unique_lock<std::mutex> lock(mtx);
  cv.wait_for(lock, std::chrono::seconds(10), [&]() { return done.load(); });
  return ok;
}

bool clearAllAudioClips(std::string& error) {
  error.clear();
  if (!gState || !gState->edit) {
    error = "backend not initialised";
    return false;
  }
  try {
    const auto tracks = tracktion::engine::getAudioTracks(*gState->edit);
    for (auto* track : tracks) {
      if (track == nullptr) {
        continue;
      }
      auto& clips = track->getClips();
      for (int j = clips.size(); --j >= 0;) {
        auto* clip = clips.getUnchecked(j);
        if (clip != nullptr) {
          clip->removeFromParent();
        }
      }
    }
    return true;
  } catch (const std::exception& ex) {
    error = ex.what();
    return false;
  } catch (...) {
    error = "unknown error during clearAllAudioClips";
    return false;
  }
}

bool clearAllAudioClipsOnMessageThread(std::string& error) {
  error.clear();
  auto* mm = juce::MessageManager::getInstance();
  if (mm && mm->isThisTheMessageThread()) {
    return clearAllAudioClips(error);
  }
  if (!mm) {
    error = "JUCE MessageManager not available";
    return false;
  }
  std::mutex mtx;
  std::condition_variable cv;
  std::atomic<bool> done{false};
  bool ok = false;
  mm->callAsync([&]() {
    ok = clearAllAudioClips(error);
    {
      std::lock_guard<std::mutex> lock(mtx);
      done = true;
    }
    cv.notify_one();
  });
  std::unique_lock<std::mutex> lock(mtx);
  cv.wait_for(lock, std::chrono::seconds(10), [&]() { return done.load(); });
  return ok;
}

bool getEditAudioClips(std::vector<EditClipInfo>& out, std::string& error) {
  out.clear();
  error.clear();
  if (!gState || !gState->edit) {
    error = "backend not initialised";
    return false;
  }
  try {
    const auto tracks = tracktion::engine::getAudioTracks(*gState->edit);
    const int numTracks = static_cast<int>(tracks.size());
    for (int ti = 0; ti < numTracks; ++ti) {
      auto* track = tracks[static_cast<size_t>(ti)];
      if (track == nullptr) continue;
      const int32_t trackId = static_cast<int32_t>(ti) + 1;
      const auto& clips = track->getClips();
      for (int j = 0; j < clips.size(); ++j) {
        auto* clip = clips.getUnchecked(j);
        if (clip == nullptr) continue;
        auto* waveClip = dynamic_cast<tracktion::engine::WaveAudioClip*>(clip);
        if (waveClip == nullptr) continue;
        juce::File file = waveClip->getOriginalFile();
        const std::string pathStr = file.getFullPathName().toStdString();
        if (pathStr.empty()) continue;
        const auto pos = waveClip->getPosition();
        const double startSec = pos.time.getStart().inSeconds();
        double lengthSec = pos.time.getLength().inSeconds();
        if (lengthSec <= 0.0) lengthSec = 0.1;
        EditClipInfo info;
        info.trackId = trackId;
        info.sourcePath = pathStr;
        info.startSeconds = startSec;
        info.lengthSeconds = lengthSec;
        info.name = waveClip->getName().toStdString();
        if (info.name.empty()) info.name = file.getFileNameWithoutExtension().toStdString();
        out.push_back(std::move(info));
      }
    }
    if (!out.empty()) {
      std::fprintf(stderr, "[thestuu-native] getEditAudioClips: %zu clip(s) (tracks: ", out.size());
      for (size_t i = 0; i < out.size(); ++i) {
        if (i > 0) std::fprintf(stderr, ", ");
        std::fprintf(stderr, "%d", static_cast<int>(out[i].trackId));
      }
      std::fprintf(stderr, ")\n");
    }
    return true;
  } catch (const std::exception& ex) {
    error = ex.what();
    return false;
  } catch (...) {
    error = "unknown error in getEditAudioClips";
    return false;
  }
}

bool getEditAudioClipsOnMessageThread(std::vector<EditClipInfo>& out, std::string& error) {
  out.clear();
  error.clear();
  auto* mm = juce::MessageManager::getInstance();
  if (mm && mm->isThisTheMessageThread()) {
    return getEditAudioClips(out, error);
  }
  if (!mm) {
    error = "JUCE MessageManager not available";
    return false;
  }
  std::mutex mtx;
  std::condition_variable cv;
  std::atomic<bool> done{false};
  bool ok = false;
  mm->callAsync([&]() {
    ok = getEditAudioClips(out, error);
    {
      std::lock_guard<std::mutex> lock(mtx);
      done = true;
    }
    cv.notify_one();
  });
  std::unique_lock<std::mutex> lock(mtx);
  cv.wait_for(lock, std::chrono::seconds(10), [&]() { return done.load(); });
  return ok;
}

bool getSpectrumAnalyzerSnapshot(SpectrumAnalyzerSnapshot& out) {
  out = {};
  if (!gState || !gState->spectrumAnalyzerTap) {
    return false;
  }
  return gState->spectrumAnalyzerTap->getSnapshot(out);
}

static double getBpmFromEdit() {
  if (!gState || !gState->edit) {
    return 128.0;
  }
  auto timeZero = tracktion::core::TimePosition::fromSeconds(0.0);
  return gState->edit->tempoSequence.getBpmAt(timeZero);
}

static double timePositionToBeats(tracktion::core::TimePosition pos) {
  if (!gState || !gState->edit) {
    return 0.0;
  }
  const auto& sequence = gState->edit->tempoSequence.getInternalSequence();
  return sequence.toBeats(pos).inBeats();
}

bool getTransportSnapshot(TransportSnapshot& out) {
  if (!gState || !gState->edit) {
    return false;
  }
  auto& transport = gState->edit->getTransport();
  const bool playing = transport.isPlaying();
  const auto pos = transport.getPosition();
  const double positionBeats = timePositionToBeats(pos);
  const double bpm = getBpmFromEdit();
  const double beatsPerBar = estimateBeatsPerBar();
  const double positionBars = positionBeats / std::max(1.0, beatsPerBar);
  const int64_t bar = static_cast<int64_t>(std::floor(positionBars)) + 1;
  const int64_t beat = static_cast<int64_t>(std::floor(std::fmod(positionBeats, beatsPerBar))) + 1;
  constexpr int64_t kStepsPerBeat = 4;
  const int64_t stepIndex = static_cast<int64_t>(std::floor(positionBeats * static_cast<double>(kStepsPerBeat))) %
    static_cast<int64_t>(beatsPerBar * kStepsPerBeat);
  const int64_t step = stepIndex + 1;

  out.playing = playing;
  out.isRecording = transport.isRecording();
  out.bpm = bpm;
  out.positionBars = positionBars;
  out.positionBeats = positionBeats;
  out.bar = bar;
  out.beat = beat;
  out.step = step;
  out.stepIndex = stepIndex;
  out.timestamp = static_cast<int64_t>(
    std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count());
  return true;
}

static void transportPlayImpl() {
  if (!gState || !gState->edit) {
    return;
  }
  auto& transport = gState->edit->getTransport();
  const bool shouldPlay = gState->edit->shouldPlay();
  std::cerr << "[thestuu-native] transport play: edit.shouldPlay()=" << (shouldPlay ? 1 : 0) << std::endl;
  if (!shouldPlay) {
    return;
  }
  // Debug: log first 4 audio tracks so we can see why track 2 might not play
  {
    const auto tracks = tracktion::engine::getAudioTracks(*gState->edit);
    const int n = std::min(4, static_cast<int>(tracks.size()));
    for (int i = 0; i < n; ++i) {
      if (auto* t = tracks[i]) {
        auto* dev = t->getOutput().getOutputDevice(false);
        const bool processing = t->isProcessing(true);
        const int nClips = t->getClips().size();
        std::cerr << "[thestuu-native] play track " << (i + 1) << " output="
                  << (dev ? dev->getName().toStdString() : "null")
                  << " processing=" << (processing ? 1 : 0) << " clips=" << nClips << std::endl;
      }
    }
  }
  // Force full rebuild at play time so the graph is guaranteed to include all current tracks/clips.
  transport.freePlaybackContext();
  transport.ensureContextAllocated(true);
  transport.play(false);
}

/** Start playback with recording: armed tracks will record input to the timeline. */
static void transportRecordImpl() {
  if (!gState || !gState->edit) {
    std::fprintf(stderr, "[thestuu-native] transportRecordImpl: no gState or edit, skip\n");
    return;
  }
  auto& transport = gState->edit->getTransport();
  if (!gState->edit->shouldPlay()) {
    std::fprintf(stderr, "[thestuu-native] transportRecordImpl: edit.shouldPlay()=false, skip\n");
    return;
  }
  const auto tracks = tracktion::engine::getAudioTracks(*gState->edit);
  int armedCount = 0;
  std::string armedTrackIds;
  for (size_t i = 0; i < tracks.size(); ++i) {
    if (tracks[i] && tracks[i]->getWaveInputDevice().isEnabled()) {
      ++armedCount;
      if (!armedTrackIds.empty()) armedTrackIds += ',';
      armedTrackIds += std::to_string(static_cast<int>(i) + 1);
    }
  }
  std::fprintf(stderr, "[thestuu-native] transportRecordImpl: starting record (tracks with wave input enabled=%d: %s)\n",
               armedCount, armedTrackIds.empty() ? "none" : armedTrackIds.c_str());
  transport.freePlaybackContext();
  transport.ensureContextAllocated(true);
  transport.record(false, true);
  std::fprintf(stderr, "[thestuu-native] transportRecordImpl: transport.record() returned (isPlaying=%d isRecording=%d)\n",
               transport.isPlaying() ? 1 : 0, transport.isRecording() ? 1 : 0);
}

/** Rebuild playback graph without stopping transport (e.g. after mute/solo/volume/pan change). */
static void transportRebuildGraphOnlyImpl() {
  if (!gState || !gState->edit) {
    return;
  }
  auto& transport = gState->edit->getTransport();
  const bool wasPlaying = transport.isPlaying();
  const auto savedPosition = transport.getPosition();
  std::fprintf(stderr, "[thestuu-native] transportRebuildGraphOnly: wasPlaying=%d\n", wasPlaying ? 1 : 0);
  /* Free context so playingFlag is cleared; then rebuild. When we play(), performPlay()
   * will run (playingFlag was cleared) and start the new graph's playhead. */
  transport.freePlaybackContext();
  transport.ensureContextAllocated(true);
  if (wasPlaying) {
    transport.setPosition(savedPosition);
    transport.play(false);
    std::fprintf(stderr, "[thestuu-native] transportRebuildGraphOnly: wasPlaying=1 resume (setPosition + play)\n");
  }
}

static void transportEnsureContextImpl() {
  if (!gState || !gState->edit) {
    return;
  }
  auto& transport = gState->edit->getTransport();
  transport.freePlaybackContext();
  transport.ensureContextAllocated(true);
}

static void runOnMessageThreadAndWait(std::function<void()> fn) {
  if (!fn) return;
  auto* mm = juce::MessageManager::getInstance();
  if (mm && mm->isThisTheMessageThread()) {
    fn();
    return;
  }
  if (!mm) return;
  std::mutex mtx;
  std::condition_variable cv;
  std::atomic<bool> done{false};
  mm->callAsync([&]() {
    fn();
    std::lock_guard<std::mutex> lock(mtx);
    done = true;
    cv.notify_one();
  });
  std::unique_lock<std::mutex> lock(mtx);
  cv.wait_for(lock, std::chrono::seconds(5), [&]() { return done.load(); });
}

/** Rebuild graph without stopping playback. Use after mute/solo/volume/pan/record-arm. */
void transportRebuildGraphOnly() {
  if (!gState || !gState->edit) return;
  runOnMessageThreadAndWait(transportRebuildGraphOnlyImpl);
}

void transportEnsureContext() {
  if (!gState || !gState->edit) return;
  runOnMessageThreadAndWait(transportEnsureContextImpl);
}

void transportPlay() {
  if (!gState || !gState->edit) {
    return;
  }
  std::mutex mtx;
  std::condition_variable cv;
  std::atomic<bool> done{false};
  if (auto* mm = juce::MessageManager::getInstance()) {
    mm->callAsync([&]() {
      transportPlayImpl();
      {
        std::lock_guard<std::mutex> lock(mtx);
        done = true;
      }
      cv.notify_one();
    });
    std::unique_lock<std::mutex> lock(mtx);
    cv.wait_for(lock, std::chrono::seconds(5), [&]() { return done.load(); });
  } else {
    transportPlayImpl();
  }
}

void transportRecord() {
  if (!gState || !gState->edit) {
    return;
  }
  std::mutex mtx;
  std::condition_variable cv;
  std::atomic<bool> done{false};
  if (auto* mm = juce::MessageManager::getInstance()) {
    mm->callAsync([&]() {
      transportRecordImpl();
      {
        std::lock_guard<std::mutex> lock(mtx);
        done = true;
      }
      cv.notify_one();
    });
    std::unique_lock<std::mutex> lock(mtx);
    cv.wait_for(lock, std::chrono::seconds(5), [&]() { return done.load(); });
  } else {
    transportRecordImpl();
  }
}

static void transportPauseImpl() {
  if (!gState || !gState->edit) return;
  auto& transport = gState->edit->getTransport();
  const auto savedPosition = transport.getPosition();
  transport.stop(false, true, true);
  transport.setPosition(savedPosition);
}

static void transportStopImpl() {
  if (!gState || !gState->edit) return;
  auto& transport = gState->edit->getTransport();
  transport.stop(false, true, true);
  transport.setPosition(tracktion::core::TimePosition::fromSeconds(0.0));
}

void transportPause() {
  runOnMessageThreadAndWait(transportPauseImpl);
}

void transportStop() {
  runOnMessageThreadAndWait(transportStopImpl);
}

void transportSeek(double positionBeats) {
  if (!gState || !gState->edit) {
    return;
  }
  const auto timePos = convertBeatsToTime(std::max(0.0, positionBeats));
  gState->edit->getTransport().setPosition(timePos);
}

void transportSetBpm(double bpm) {
  if (!gState || !gState->edit) {
    return;
  }
  const double requested = std::isfinite(bpm) ? bpm : 128.0;
  const double clampedBpm = juce::jlimit(20.0, 300.0, requested);

  auto setTempoOnMessageThread = [clampedBpm]() {
    if (!gState || !gState->edit) {
      return;
    }
    auto& tempoSequence = gState->edit->tempoSequence;
    if (auto* firstTempo = tempoSequence.getTempo(0)) {
      firstTempo->setBpm(clampedBpm);
    } else if (auto insertedTempo = tempoSequence.insertTempo(tracktion::core::BeatPosition::fromBeats(0.0), clampedBpm, 1.0f)) {
      insertedTempo->setBpm(clampedBpm);
    }
    const double resultingBpm = getBpmFromEdit();
    const bool playing = gState->edit->getTransport().isPlaying();
    std::fprintf(
      stderr,
      "[thestuu-native] transportSetBpm applied=%.3f resultingEditBpm=%.3f playing=%d\n",
      clampedBpm,
      resultingBpm,
      playing ? 1 : 0
    );
  };

  if (auto* mm = juce::MessageManager::getInstance()) {
    if (mm->isThisTheMessageThread()) {
      setTempoOnMessageThread();
      return;
    }

    std::mutex mtx;
    std::condition_variable cv;
    std::atomic<bool> done{false};
    mm->callAsync([&]() {
      setTempoOnMessageThread();
      {
        std::lock_guard<std::mutex> lock(mtx);
        done = true;
      }
      cv.notify_one();
    });
    std::unique_lock<std::mutex> lock(mtx);
    cv.wait_for(lock, std::chrono::seconds(5), [&]() { return done.load(); });
    return;
  }

  setTempoOnMessageThread();
}

void pumpMessageLoop() {
  if (auto* mm = juce::MessageManager::getInstance()) {
    mm->runDispatchLoopUntil(0);
  }
}

void runMessageLoopFor(int millisecondsMs) {
  if (auto* mm = juce::MessageManager::getInstance()) {
    mm->runDispatchLoopUntil(millisecondsMs);
  }
}

bool getAudioOutputDevices(std::vector<AudioDeviceInfo>& out, std::string& error) {
  out.clear();
  if (!gState || !gState->engine) {
    error = "tracktion backend is not initialised";
    return false;
  }
  std::vector<AudioDeviceInfo> result;
  std::string errMsg;
  runOnMessageThreadAndWait([&]() {
    try {
      auto& dm = gState->engine->getDeviceManager();
      auto& juceDm = dm.deviceManager;
      auto* type = juceDm.getCurrentDeviceTypeObject();
      if (type == nullptr) {
        errMsg = "no audio device type";
        return;
      }
      type->scanForDevices();
      const auto names = type->getDeviceNames(false);
      result.reserve(static_cast<size_t>(names.size()));
      for (int i = 0; i < names.size(); ++i) {
        const auto name = names[i].toStdString();
        if (name.empty()) continue;
        AudioDeviceInfo info;
        info.id = name;
        info.name = name;
        result.push_back(std::move(info));
      }
    } catch (const std::exception& ex) {
      errMsg = ex.what();
    }
  });
  if (!errMsg.empty()) {
    error = errMsg;
    return false;
  }
  out = std::move(result);
  error.clear();
  return true;
}

bool getCurrentAudioOutputDeviceId(std::string& outId, std::string& error) {
  outId.clear();
  if (!gState || !gState->engine) {
    error = "tracktion backend is not initialised";
    return false;
  }
  std::string result;
  std::string errMsg;
  runOnMessageThreadAndWait([&]() {
    try {
      auto& dm = gState->engine->getDeviceManager();
      auto setup = dm.deviceManager.getAudioDeviceSetup();
      result = setup.outputDeviceName.toStdString();
    } catch (const std::exception& ex) {
      errMsg = ex.what();
    }
  });
  if (!errMsg.empty()) {
    error = errMsg;
    return false;
  }
  outId = result;
  error.clear();
  return true;
}

bool setAudioOutputDevice(const std::string& deviceId, std::string& error) {
  if (!gState || !gState->engine) {
    error = "tracktion backend is not initialised";
    return false;
  }
  std::string errMsg;
  runOnMessageThreadAndWait([&]() {
    try {
      auto& dm = gState->engine->getDeviceManager();
      auto setup = dm.deviceManager.getAudioDeviceSetup();
      setup.outputDeviceName = juce::String::fromUTF8(deviceId.c_str());
      const juce::String err = dm.deviceManager.setAudioDeviceSetup(setup, true);
      if (err.isNotEmpty()) {
        errMsg = err.toStdString();
        return;
      }
      dm.rescanWaveDeviceList();
      for (int i = 0; i < 20; ++i) {
        pumpMessageLoop();
      }
      dm.saveSettings();
    } catch (const std::exception& ex) {
      errMsg = ex.what();
    }
  });
  if (!errMsg.empty()) {
    error = errMsg;
    return false;
  }
  error.clear();
  return true;
}

bool getAudioInputDevices(std::vector<AudioDeviceInfo>& out, std::string& error) {
  out.clear();
  if (!gState || !gState->engine) {
    error = "tracktion backend is not initialised";
    return false;
  }
  std::vector<AudioDeviceInfo> result;
  std::string errMsg;
  runOnMessageThreadAndWait([&]() {
    try {
      auto& dm = gState->engine->getDeviceManager();
      auto& juceDm = dm.deviceManager;
      auto* type = juceDm.getCurrentDeviceTypeObject();
      if (type == nullptr) {
        errMsg = "no audio device type";
        return;
      }
      type->scanForDevices();
      const auto names = type->getDeviceNames(true);
      result.reserve(static_cast<size_t>(names.size()));
      for (int i = 0; i < names.size(); ++i) {
        const auto name = names[i].toStdString();
        if (name.empty()) continue;
        AudioDeviceInfo info;
        info.id = name;
        info.name = name;
        result.push_back(std::move(info));
      }
    } catch (const std::exception& ex) {
      errMsg = ex.what();
    }
  });
  if (!errMsg.empty()) {
    error = errMsg;
    return false;
  }
  out = std::move(result);
  error.clear();
  return true;
}

bool getCurrentAudioInputDeviceId(std::string& outId, std::string& error) {
  outId.clear();
  if (!gState || !gState->engine) {
    error = "tracktion backend is not initialised";
    return false;
  }
  std::string result;
  std::string errMsg;
  runOnMessageThreadAndWait([&]() {
    try {
      auto& dm = gState->engine->getDeviceManager();
      auto setup = dm.deviceManager.getAudioDeviceSetup();
      result = setup.inputDeviceName.toStdString();
    } catch (const std::exception& ex) {
      errMsg = ex.what();
    }
  });
  if (!errMsg.empty()) {
    error = errMsg;
    return false;
  }
  outId = result;
  error.clear();
  return true;
}

bool setAudioInputDevice(const std::string& deviceId, std::string& error) {
  if (!gState || !gState->engine) {
    error = "tracktion backend is not initialised";
    return false;
  }
  std::string errMsg;
  runOnMessageThreadAndWait([&]() {
    try {
      auto& dm = gState->engine->getDeviceManager();
      auto setup = dm.deviceManager.getAudioDeviceSetup();
      setup.inputDeviceName = juce::String::fromUTF8(deviceId.c_str());
      const juce::String err = dm.deviceManager.setAudioDeviceSetup(setup, true);
      if (err.isNotEmpty()) {
        errMsg = err.toStdString();
        return;
      }
      dm.rescanWaveDeviceList();
      for (int i = 0; i < 20; ++i) {
        pumpMessageLoop();
      }
      dm.saveSettings();
    } catch (const std::exception& ex) {
      errMsg = ex.what();
    }
  });
  if (!errMsg.empty()) {
    error = errMsg;
    return false;
  }
  error.clear();
  return true;
}

bool getAudioStatus(AudioStatus& out, std::string& error) {
  out = {};
  if (!gState || !gState->engine) {
    error = "tracktion backend is not initialised";
    return false;
  }
  try {
    auto& dm = gState->engine->getDeviceManager();
    out.sampleRate = dm.getSampleRate();
    out.blockSize = dm.getBlockSize();
    out.outputLatencySeconds = dm.getOutputLatencySeconds();
    if (auto* wo = dm.getDefaultWaveOutDevice()) {
      out.outputChannels = static_cast<int>(wo->getChannels().size());
    }
    error.clear();
    return true;
  } catch (const std::exception& ex) {
    error = ex.what();
    return false;
  }
}

}  // namespace thestuu::native
