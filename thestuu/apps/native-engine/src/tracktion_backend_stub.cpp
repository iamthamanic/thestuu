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

bool moveAudioClipBySource(const ClipEditBySourceRequest& request, std::string& error) {
  (void)request;
  error = "clip.move requires STUU_ENABLE_TRACKTION=ON";
  return false;
}
bool moveAudioClipBySourceOnMessageThread(const ClipEditBySourceRequest& request, std::string& error) {
  return moveAudioClipBySource(request, error);
}
bool resizeAudioClipBySource(const ClipEditBySourceRequest& request, std::string& error) {
  (void)request;
  error = "clip.resize requires STUU_ENABLE_TRACKTION=ON";
  return false;
}
bool resizeAudioClipBySourceOnMessageThread(const ClipEditBySourceRequest& request, std::string& error) {
  return resizeAudioClipBySource(request, error);
}
bool deleteAudioClipBySource(int32_t trackId, const std::string& sourcePath, double oldStartBars, std::string& error) {
  (void)trackId;
  (void)sourcePath;
  (void)oldStartBars;
  error = "clip.delete requires STUU_ENABLE_TRACKTION=ON";
  return false;
}
bool deleteAudioClipBySourceOnMessageThread(int32_t trackId, const std::string& sourcePath, double oldStartBars, std::string& error) {
  return deleteAudioClipBySource(trackId, sourcePath, oldStartBars, error);
}
bool editUndo(std::string& error) {
  error = "edit.undo requires STUU_ENABLE_TRACKTION=ON";
  return false;
}
bool editUndoOnMessageThread(std::string& error) {
  return editUndo(error);
}
bool editRedo(std::string& error) {
  error = "edit.redo requires STUU_ENABLE_TRACKTION=ON";
  return false;
}
bool editRedoOnMessageThread(std::string& error) {
  return editRedo(error);
}

bool listAudioTracks(std::vector<TrackLayoutEntry>& out, std::string& error) {
  (void)out;
  error = "track.list requires STUU_ENABLE_TRACKTION=ON";
  return false;
}
bool listAudioTracksOnMessageThread(std::vector<TrackLayoutEntry>& out, std::string& error) {
  return listAudioTracks(out, error);
}
bool createAudioTrack(const std::string& name, int32_t& outTrackId, std::string& error) {
  (void)name;
  (void)outTrackId;
  error = "track.create requires STUU_ENABLE_TRACKTION=ON";
  return false;
}
bool createAudioTrackOnMessageThread(const std::string& name, int32_t& outTrackId, std::string& error) {
  return createAudioTrack(name, outTrackId, error);
}
bool deleteAudioTrack(int32_t trackId, std::string& error) {
  (void)trackId;
  error = "track.delete requires STUU_ENABLE_TRACKTION=ON";
  return false;
}
bool deleteAudioTrackOnMessageThread(int32_t trackId, std::string& error) {
  return deleteAudioTrack(trackId, error);
}
bool reorderAudioTracks(const std::vector<int32_t>& orderedTrackIds, std::string& error) {
  (void)orderedTrackIds;
  error = "track.reorder requires STUU_ENABLE_TRACKTION=ON";
  return false;
}
bool reorderAudioTracksOnMessageThread(const std::vector<int32_t>& orderedTrackIds, std::string& error) {
  return reorderAudioTracks(orderedTrackIds, error);
}
bool syncAudioTrackLayout(const std::vector<TrackLayoutEntry>& desired, std::string& error) {
  (void)desired;
  error = "track.sync-layout requires STUU_ENABLE_TRACKTION=ON";
  return false;
}
bool syncAudioTrackLayoutOnMessageThread(const std::vector<TrackLayoutEntry>& desired, std::string& error) {
  return syncAudioTrackLayout(desired, error);
}
bool exportProjectSnapshot(ProjectExportSnapshot& out, std::string& error) {
  (void)out;
  error = "project.export requires STUU_ENABLE_TRACKTION=ON";
  return false;
}
bool exportProjectSnapshotOnMessageThread(ProjectExportSnapshot& out, std::string& error) {
  return exportProjectSnapshot(out, error);
}
bool importProjectSnapshot(const ProjectExportSnapshot& snapshot, std::string& error) {
  (void)snapshot;
  error = "project.import requires STUU_ENABLE_TRACKTION=ON";
  return false;
}
bool importProjectSnapshotOnMessageThread(const ProjectExportSnapshot& snapshot, std::string& error) {
  return importProjectSnapshot(snapshot, error);
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

bool getTransportMeterLevels(std::vector<TrackMeterLevels>& out, int32_t trackCount, std::string& error) {
  out.clear();
  error.clear();
  if (trackCount <= 0) {
    return true;
  }
  out.assign(static_cast<size_t>(trackCount), TrackMeterLevels{});
  return true;
}

void transportPlay() {}
void transportRecord() {}
void transportPause() {}
void transportStop() {}
void transportSeek(double positionBeats) { (void)positionBeats; }
void transportSetBpm(double bpm) { (void)bpm; }

}  // namespace thestuu::native
