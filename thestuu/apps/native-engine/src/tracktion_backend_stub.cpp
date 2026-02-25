#include "tracktion_backend.hpp"

#include <string>
#include <vector>

namespace thestuu::native {

bool initialiseBackend(const BackendConfig& config, BackendRuntimeInfo& info, std::string& error) {
  (void)config;
  error.clear();
  info.enabled = true;
  info.tracktion = false;
  info.description = "stub transport backend (JUCE/Tracktion disabled)";
  return true;
}

void shutdownBackend() {
  // No-op for stub backend.
}

bool resetDefaultEdit(int32_t trackCount, std::string& error) {
  (void)trackCount;
  error = "edit:reset requires STUU_ENABLE_TRACKTION=ON";
  return false;
}

bool scanPlugins(std::vector<PluginInfo>& plugins, std::string& error) {
  plugins.clear();
  error = "vst:scan requires STUU_ENABLE_TRACKTION=ON";
  return false;
}

bool loadPlugin(const std::string& pluginUid, int32_t trackId, LoadPluginResult& result, std::string& error) {
  (void)pluginUid;
  (void)trackId;
  result = {};
  error = "vst:load requires STUU_ENABLE_TRACKTION=ON";
  return false;
}

bool getPluginPreviewImage(
  const std::string& pluginUid,
  int32_t width,
  int32_t height,
  const std::string& outputPath,
  bool& generated,
  std::string& error
) {
  (void)pluginUid;
  (void)width;
  (void)height;
  (void)outputPath;
  generated = false;
  error = "vst:preview:get requires STUU_ENABLE_TRACKTION=ON";
  return false;
}

bool setPluginParameter(
  int32_t trackId,
  int32_t pluginIndex,
  const std::string& paramId,
  double value,
  PluginParameterInfo& result,
  std::string& error
) {
  (void)trackId;
  (void)pluginIndex;
  (void)paramId;
  (void)value;
  result = {};
  error = "vst:param:set requires STUU_ENABLE_TRACKTION=ON";
  return false;
}

bool importClipFile(const ClipImportRequest& request, ClipImportResult& result, std::string& error) {
  (void)request;
  result = {};
  error = "clip:import requires STUU_ENABLE_TRACKTION=ON";
  return false;
}

bool getEditAudioClips(std::vector<EditClipInfo>& out, std::string& error) {
  (void)out;
  error = "edit:get-audio-clips requires STUU_ENABLE_TRACKTION=ON";
  return false;
}
bool getEditAudioClipsOnMessageThread(std::vector<EditClipInfo>& out, std::string& error) {
  return getEditAudioClips(out, error);
}

bool getSpectrumAnalyzerSnapshot(SpectrumAnalyzerSnapshot& out) {
  out = {};
  return false;
}

bool setSpectrumAnalyzerTarget(int32_t trackId, int32_t pluginIndex, std::string& error) {
  (void)trackId;
  (void)pluginIndex;
  error = "analyzer:set-target requires STUU_ENABLE_TRACKTION=ON";
  return false;
}

bool getTransportSnapshot(TransportSnapshot& out) {
  (void)out;
  return false;
}

void transportPlay() {}
void transportRecord() {}
void transportPause() {}
void transportStop() {}
void transportSeek(double positionBeats) { (void)positionBeats; }
void transportSetBpm(double bpm) { (void)bpm; }

}  // namespace thestuu::native
