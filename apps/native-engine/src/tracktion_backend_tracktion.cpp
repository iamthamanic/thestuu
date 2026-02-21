#include "tracktion_backend.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <limits>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <tracktion_engine/tracktion_engine.h>
#include <tracktion_engine/model/edit/tracktion_TempoSequence.h>
#include <tracktion_engine/model/tracks/tracktion_ClipTrack.h>
#include <tracktion_engine/model/tracks/tracktion_EditTime.h>
#include <tracktion_core/utilities/tracktion_Tempo.h>
#include <tracktion_core/utilities/tracktion_TimeRange.h>
#include <tracktion_core/utilities/tracktion_BeatPosition.h>

namespace thestuu::native {
namespace {

constexpr int32_t kDefaultTrackCount = 16;
constexpr const char* kUltrasoundUid = "internal:ultrasound";

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
  if (!gState || !gState->engine || !gState->edit) {
    error = "tracktion backend is not initialised";
    return false;
  }
  return true;
}

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
  for (int i = 0; i < tracks.size(); ++i) {
    if (auto* track = tracks[i]) {
      track->setName("Track " + juce::String(i + 1));
    }
  }

  gState->edit = std::move(nextEdit);
  gState->edit->getTransport().ensureContextAllocated();
  error.clear();
  return true;
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
  info.parameters = collectUltrasoundParameters();
  return info;
}
}  // namespace

bool initialiseBackend(const BackendConfig& config, BackendRuntimeInfo& info, std::string& error) {
  try {
    gState = std::make_unique<BackendState>();
    gState->sampleRate = std::isfinite(config.sampleRate) && config.sampleRate > 0.0 ? config.sampleRate : 48000.0;
    gState->bufferSize = config.bufferSize > 0 ? config.bufferSize : 256;

    gState->juce = std::make_unique<juce::ScopedJuceInitialiser_GUI>();
    gState->engine = std::make_unique<tracktion::engine::Engine>("TheStuuNative");
    gState->engine->getPluginManager().setUsesSeparateProcessForScanning(false);
    gState->engine->getPluginManager().createBuiltInType<UltrasoundPlugin>();

    auto& deviceManager = gState->engine->getDeviceManager();
    deviceManager.initialise(2, 2);

    std::string editError;
    if (!createDefaultEdit(kDefaultTrackCount, editError)) {
      throw std::runtime_error(editError);
    }
    gState->edit->getTransport().ensureContextAllocated();

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
    if (!createDefaultEdit(safeTrackCount, error)) {
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
    plugins.reserve(static_cast<size_t>(known.size() + 1));

    for (const auto& desc : known) {
      PluginInfo info;
      info.name = desc.name.toStdString();
      info.uid = desc.createIdentifierString().toStdString();
      info.type = desc.pluginFormatName.toStdString();
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

  try {
    auto* track = getAudioTrackByIndex(trackId);
    if (track == nullptr) {
      error = "track_id out of range";
      return false;
    }

    tracktion::engine::Plugin::Ptr plugin;
    std::string resolvedUid = pluginUid;
    std::string resolvedType = "unknown";

    if (pluginUid == kUltrasoundUid || juce::String::fromUTF8(pluginUid.c_str()).equalsIgnoreCase("ultrasound")) {
      juce::PluginDescription ignored;
      plugin = gState->edit->getPluginCache().createNewPlugin(UltrasoundPlugin::xmlTypeName, ignored);
      resolvedUid = kUltrasoundUid;
      resolvedType = tracktion::engine::PluginManager::builtInPluginFormatName;
    } else {
      juce::PluginDescription desc;
      if (!findPluginDescriptionByUid(pluginUid, desc)) {
        error = "VST not found: " + pluginUid;
        return false;
      }

      plugin = gState->edit->getPluginCache().createNewPlugin(tracktion::engine::ExternalPlugin::xmlTypeName, desc);
      resolvedType = desc.pluginFormatName.toStdString();
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

  const double beatsPerBar = estimateBeatsPerBar();
  const double startBars = std::max(0.0, request.startBars);
  const double lengthBars = request.lengthBars > 0.0 ? request.lengthBars : 1.0;
  const double startBeats = startBars * beatsPerBar;
  const double lengthBeats = lengthBars * beatsPerBar;
  const auto startTime = convertBeatsToTime(startBeats);
  const auto endTime = convertBeatsToTime(startBeats + lengthBeats);

  const tracktion::core::TimeRange clipRange(startTime, endTime);
  const tracktion::engine::ClipPosition position{clipRange, tracktion::core::TimeDuration::fromSeconds(0.0)};

  auto clip = track->insertWaveClip(sourceFile.getFileNameWithoutExtension(), sourceFile, position, false);
  if (clip == nullptr) {
    error = "failed to insert clip";
    return false;
  }

  result.trackId = request.trackId;
  result.startBars = startBars;
  result.lengthBars = lengthBars;
  result.sourcePath = request.sourcePath;
  error.clear();
  return true;
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

void transportPlay() {
  if (!gState || !gState->edit) {
    return;
  }
  gState->edit->getTransport().play(false);
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

void transportSetBpm(double /* bpm */) {
  if (!gState || !gState->edit) {
    return;
  }
  /* Tempo can be set via tempoSequence if needed; default BPM is used for now */
}

}  // namespace thestuu::native
