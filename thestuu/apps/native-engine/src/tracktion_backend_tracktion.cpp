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

struct BackendState {
  std::unique_ptr<juce::ScopedJuceInitialiser_GUI> juce;
  std::unique_ptr<tracktion::engine::Engine> engine;
  std::unique_ptr<tracktion::engine::Edit> edit;
  double sampleRate = 48000.0;
  int bufferSize = 256;
  std::unordered_map<std::string, juce::PluginDescription> pluginByUid;
  std::unordered_map<std::string, std::vector<PluginParameterInfo>> parameterCacheByUid;
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

    subtitleLabel.setText("Drag Node = Freq/Gain, Mousewheel = Q, Shift = Fine", juce::dontSendNotification);
    subtitleLabel.setJustificationType(juce::Justification::centredLeft);
    subtitleLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey.withAlpha(0.78F));
    addAndMakeVisible(subtitleLabel);

    infoLabel.setJustificationType(juce::Justification::centredLeft);
    addAndMakeVisible(infoLabel);

    for (auto& band : bands) {
      if (band.freq != nullptr) band.freq->addListener(this);
      if (band.gain != nullptr) band.gain->addListener(this);
      if (band.q != nullptr) band.q->addListener(this);
    }

    setSize(820, 560);
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
    area.removeFromTop(4);
    infoLabel.setBounds(area.removeFromBottom(28));
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
    infoLabel.setText(
      band.name
      + "  |  " + formatFrequency(bandFrequency(index))
      + "  |  " + formatGain(bandGain(index))
      + "  |  " + formatQ(bandQ(index))
      + "  |  Tipp: Ziehen fuer Klangform, Wheel fuer Breite (Q).",
      juce::dontSendNotification
    );
  }

  void handleAsyncUpdate() override {
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
  juce::Label infoLabel;
  juce::Rectangle<float> graphBounds;
  int activeBandIndex = 1;
  int hoverBandIndex = -1;
  bool dragInProgress = false;
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
        juce::DocumentWindow::closeButton,
        kShouldAddPluginWindowToDesktop
      ),
      plugin(pluginToShow) {
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
  void show() {
    setVisible(true);
    toFront(false);
    setBoundsConstrained(getBounds());
  }

  void setEditor(std::unique_ptr<tracktion::engine::Plugin::EditorComponent> newEditor) {
    JUCE_AUTORELEASEPOOL {
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

bool openPluginEditorImpl(int32_t trackId, int32_t pluginIndex, std::string& error) {
  auto* track = getAudioTrackByIndex(trackId);
  if (track == nullptr) {
    error = "track_id out of range";
    return false;
  }

  if (pluginIndex < 0 || pluginIndex >= track->pluginList.size()) {
    error = "plugin_index out of range";
    return false;
  }

  auto* plugin = track->pluginList[pluginIndex];
  if (plugin == nullptr) {
    error = "plugin not found on track";
    return false;
  }

  plugin->showWindowExplicitly();
  if (plugin->windowState != nullptr && plugin->windowState->isWindowShowing()) {
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
  track->getWaveInputDevice().setEnabled(armed);
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

    if (pluginIndex < 0 || pluginIndex >= track->pluginList.size()) {
      error = "plugin_index out of range";
      return false;
    }

    auto* plugin = track->pluginList[pluginIndex];
    if (plugin == nullptr) {
      error = "plugin not found on track";
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

void transportPause() {
  if (!gState || !gState->edit) {
    return;
  }
  gState->edit->getTransport().stop(true, false, true);
}

void transportStop() {
  if (!gState || !gState->edit) {
    return;
  }
  gState->edit->getTransport().stop(true, false, true);
  gState->edit->getTransport().setPosition(tracktion::core::TimePosition::fromSeconds(0.0));
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
  try {
    auto& dm = gState->engine->getDeviceManager();
    dm.rescanWaveDeviceList();
    for (int i = 0; i < 20; ++i) {
      pumpMessageLoop();
    }
    const auto devices = dm.getWaveOutputDevices();
    out.reserve(devices.size());
    for (auto* d : devices) {
      if (d == nullptr) {
        continue;
      }
      AudioDeviceInfo info;
      info.id = d->getDeviceID().toStdString();
      info.name = d->getName().toStdString();
      out.push_back(std::move(info));
    }
    error.clear();
    return true;
  } catch (const std::exception& ex) {
    error = ex.what();
    out.clear();
    return false;
  }
}

bool getCurrentAudioOutputDeviceId(std::string& outId, std::string& error) {
  outId.clear();
  if (!gState || !gState->engine) {
    error = "tracktion backend is not initialised";
    return false;
  }
  try {
    auto& dm = gState->engine->getDeviceManager();
    outId = dm.getDefaultWaveOutDeviceID().toStdString();
    error.clear();
    return true;
  } catch (const std::exception& ex) {
    error = ex.what();
    return false;
  }
}

bool setAudioOutputDevice(const std::string& deviceId, std::string& error) {
  if (!gState || !gState->engine) {
    error = "tracktion backend is not initialised";
    return false;
  }
  try {
    auto& dm = gState->engine->getDeviceManager();
    dm.setDefaultWaveOutDevice(juce::String::fromUTF8(deviceId.c_str()));
    dm.saveSettings();
    error.clear();
    return true;
  } catch (const std::exception& ex) {
    error = ex.what();
    return false;
  }
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
      dm.rescanWaveDeviceList();
      dm.dispatchPendingUpdates();
      const auto devices = dm.getWaveInputDevices();
      result.reserve(devices.size());
      for (auto* d : devices) {
        if (d == nullptr || d->isTrackDevice()) {
          continue;
        }
        AudioDeviceInfo info;
        info.id = d->getDeviceID().toStdString();
        info.name = d->getName().toStdString();
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
  try {
    auto& dm = gState->engine->getDeviceManager();
    outId = dm.getDefaultWaveInDeviceID().toStdString();
    error.clear();
    return true;
  } catch (const std::exception& ex) {
    error = ex.what();
    return false;
  }
}

bool setAudioInputDevice(const std::string& deviceId, std::string& error) {
  if (!gState || !gState->engine) {
    error = "tracktion backend is not initialised";
    return false;
  }
  try {
    auto& dm = gState->engine->getDeviceManager();
    dm.setDefaultWaveInDevice(juce::String::fromUTF8(deviceId.c_str()));
    dm.saveSettings();
    error.clear();
    return true;
  } catch (const std::exception& ex) {
    error = ex.what();
    return false;
  }
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
