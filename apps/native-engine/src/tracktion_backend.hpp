#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace thestuu::native {

struct BackendConfig {
  double sampleRate = 48000.0;
  int bufferSize = 256;
};

struct BackendRuntimeInfo {
  bool enabled = false;
  bool tracktion = false;
  std::string description;
};

struct PluginParameterInfo {
  std::string id;
  std::string name;
  double min = 0.0;
  double max = 1.0;
  double value = 0.0;
};

struct PluginInfo {
  std::string name;
  std::string uid;
  std::string type;
  std::vector<PluginParameterInfo> parameters;
};

struct LoadPluginResult {
  int32_t trackId = 0;
  int32_t pluginIndex = -1;
  std::string name;
  std::string uid;
  std::string type;
  std::vector<PluginParameterInfo> parameters;
};

struct ClipImportRequest {
  int32_t trackId = 1;
  std::string sourcePath;
  double startBars = 0.0;
  double lengthBars = 0.0;
  std::string type;
};

struct ClipImportResult {
  int32_t trackId = 0;
  double startBars = 0.0;
  double lengthBars = 0.0;
  std::string sourcePath;
};

bool initialiseBackend(const BackendConfig& config, BackendRuntimeInfo& info, std::string& error);
void shutdownBackend();
bool resetDefaultEdit(int32_t trackCount, std::string& error);
bool scanPlugins(std::vector<PluginInfo>& plugins, std::string& error);
bool loadPlugin(const std::string& pluginUid, int32_t trackId, LoadPluginResult& result, std::string& error);
bool setPluginParameter(
  int32_t trackId,
  int32_t pluginIndex,
  const std::string& paramId,
  double value,
  PluginParameterInfo& result,
  std::string& error
);
bool importClipFile(const ClipImportRequest& request, ClipImportResult& result, std::string& error);

struct TransportSnapshot {
  bool playing = false;
  double bpm = 128.0;
  double positionBars = 0.0;
  double positionBeats = 0.0;
  int64_t bar = 1;
  int64_t beat = 1;
  int64_t step = 1;
  int64_t stepIndex = 0;
  int64_t timestamp = 0;
};

bool getTransportSnapshot(TransportSnapshot& out);
void transportPlay();
void transportPause();
void transportStop();
void transportSeek(double positionBeats);
void transportSetBpm(double bpm);

}  // namespace thestuu::native
