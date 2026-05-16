#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace thestuu::native {

struct BackendConfig {
  double sampleRate = 48000.0;
  int bufferSize = 1024;
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
  std::string kind = "effect";
  bool isInstrument = false;
  bool isNative = false;
  std::vector<PluginParameterInfo> parameters;
};

struct LoadPluginResult {
  int32_t trackId = 0;
  int32_t pluginIndex = -1;
  std::string name;
  std::string uid;
  std::string type;
  std::string kind = "effect";
  bool isInstrument = false;
  bool isNative = false;
  std::vector<PluginParameterInfo> parameters;
};

struct ClipImportRequest {
  int32_t trackId = 1;
  std::string sourcePath;
  double startBars = 0.0;
  double lengthBars = 0.0;
  /** If >= 0 and lengthSeconds > 0, clip is placed by time (seconds) instead of bars. */
  double startSeconds = -1.0;
  double lengthSeconds = -1.0;
  /** Fade in/out duration in seconds. Applied after insert. */
  double fadeInSeconds = 0.0;
  double fadeOutSeconds = 0.0;
  /** Fade curve type: 1=linear, 2=convex, 3=concave, 4=sCurve (tracktion AudioFadeCurve::Type). */
  int fadeInCurve = 1;
  int fadeOutCurve = 1;
  std::string type;
  /** Start reading the source file from this time in seconds (skip leading silence). If < 0, ignored. */
  double sourceOffsetSeconds = -1.0;
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
bool openPluginEditor(int32_t trackId, int32_t pluginIndex, std::string& error);
bool getPluginPreviewImage(
  const std::string& pluginUid,
  int32_t width,
  int32_t height,
  const std::string& outputPath,
  bool& generated,
  std::string& error
);
bool setPluginParameter(
  int32_t trackId,
  int32_t pluginIndex,
  const std::string& paramId,
  double value,
  PluginParameterInfo& result,
  std::string& error
);
bool importClipFile(const ClipImportRequest& request, ClipImportResult& result, std::string& error);

/** Same as importClipFile but runs on the JUCE message thread. Use from socket/worker threads to avoid Edit corruption and malloc crashes. */
bool importClipFileOnMessageThread(const ClipImportRequest& request, ClipImportResult& result, std::string& error);

/** Set track mute (trackId is 1-based). Returns false if track not found or backend not initialised. */
bool setTrackMute(int32_t trackId, bool mute, std::string& error);

/** Set track solo (trackId is 1-based). Returns false if track not found or backend not initialised. */
bool setTrackSolo(int32_t trackId, bool solo, std::string& error);

/** Set track volume (trackId 1-based, volume 0..1 linear). Returns false if track not found or backend not initialised. */
bool setTrackVolume(int32_t trackId, double volume, std::string& error);

/** Set track pan (trackId 1-based, pan -1..1). Returns false if track not found or backend not initialised. */
bool setTrackPan(int32_t trackId, double pan, std::string& error);

/** Set track record arm (trackId 1-based). When armed, track uses default wave input for recording. */
bool setTrackRecordArm(int32_t trackId, bool armed, std::string& error);

/** Removes all audio (wave) clips from all audio tracks. Edit and VSTs are unchanged. Must run on message thread or use clearAllAudioClipsOnMessageThread from other threads. */
bool clearAllAudioClips(std::string& error);
/** Same as clearAllAudioClips but runs on the JUCE message thread. */
bool clearAllAudioClipsOnMessageThread(std::string& error);

/** Describes one audio clip in the edit (for sync from native to engine after recording). */
struct EditClipInfo {
  int32_t trackId = 0;
  std::string sourcePath;
  double startSeconds = 0.0;
  double lengthSeconds = 0.0;
  std::string name;
};
/** Fill list of audio clips currently in the edit (all audio tracks, wave clips only). Used after recording so engine can merge new clips into playlist. Must run on message thread or use getEditAudioClipsOnMessageThread. */
bool getEditAudioClips(std::vector<EditClipInfo>& out, std::string& error);
bool getEditAudioClipsOnMessageThread(std::vector<EditClipInfo>& out, std::string& error);

/** Locate and edit a wave clip by absolute source_path (and optional disambiguating start in bars). */
struct ClipEditBySourceRequest {
  int32_t trackId = 0;
  int32_t toTrackId = 0;
  std::string sourcePath;
  double startBars = 0.0;
  double lengthBars = -1.0;
  double oldStartBars = -1.0;
};

bool moveAudioClipBySource(const ClipEditBySourceRequest& request, std::string& error);
bool moveAudioClipBySourceOnMessageThread(const ClipEditBySourceRequest& request, std::string& error);
bool resizeAudioClipBySource(const ClipEditBySourceRequest& request, std::string& error);
bool resizeAudioClipBySourceOnMessageThread(const ClipEditBySourceRequest& request, std::string& error);
bool deleteAudioClipBySource(int32_t trackId, const std::string& sourcePath, double oldStartBars, std::string& error);
bool deleteAudioClipBySourceOnMessageThread(int32_t trackId, const std::string& sourcePath, double oldStartBars, std::string& error);

bool editUndo(std::string& error);
bool editUndoOnMessageThread(std::string& error);
bool editRedo(std::string& error);
bool editRedoOnMessageThread(std::string& error);

/** One audio track row in the edit (1-based track id matches UI track_id). */
struct TrackLayoutEntry {
  int32_t id = 0;
  std::string name;
  int32_t index = 0;
};

struct TrackMixerState {
  int32_t trackId = 0;
  double volume = 0.85;
  double pan = 0.0;
  bool mute = false;
  bool solo = false;
  bool recordArmed = false;
};

struct ProjectExportSnapshot {
  std::vector<TrackLayoutEntry> tracks;
  std::vector<EditClipInfo> clips;
  std::vector<TrackMixerState> mixer;
  double masterVolume = 1.0;
  double masterPan = 0.0;
};

bool listAudioTracks(std::vector<TrackLayoutEntry>& out, std::string& error);
bool listAudioTracksOnMessageThread(std::vector<TrackLayoutEntry>& out, std::string& error);
bool createAudioTrack(const std::string& name, int32_t& outTrackId, std::string& error);
bool createAudioTrackOnMessageThread(const std::string& name, int32_t& outTrackId, std::string& error);
bool deleteAudioTrack(int32_t trackId, std::string& error);
bool deleteAudioTrackOnMessageThread(int32_t trackId, std::string& error);
bool reorderAudioTracks(const std::vector<int32_t>& orderedTrackIds, std::string& error);
bool reorderAudioTracksOnMessageThread(const std::vector<int32_t>& orderedTrackIds, std::string& error);
/** Match native audio track count/order/names to desired layout (clips unchanged). */
bool syncAudioTrackLayout(const std::vector<TrackLayoutEntry>& desired, std::string& error);
bool syncAudioTrackLayoutOnMessageThread(const std::vector<TrackLayoutEntry>& desired, std::string& error);
bool exportProjectSnapshot(ProjectExportSnapshot& out, std::string& error);
bool exportProjectSnapshotOnMessageThread(ProjectExportSnapshot& out, std::string& error);
bool importProjectSnapshot(const ProjectExportSnapshot& snapshot, std::string& error);
bool importProjectSnapshotOnMessageThread(const ProjectExportSnapshot& snapshot, std::string& error);

/**
 * Live spectrum analyzer frame from the native audio path.
 * Source is either the selected track post-FX level meter tap or the global output fallback.
 * Pre/Post may still mirror until dedicated per-plugin taps are added.
 */
struct SpectrumAnalyzerSnapshot {
  bool available = false;
  bool preMirrorsPost = true;
  std::string scope = "master";
  std::string channels = "mono";
  double sampleRate = 0.0;
  int fftSize = 0;
  double minDb = -96.0;
  double maxDb = 0.0;
  int64_t timestamp = 0;
  std::vector<float> freqsHz;
  std::vector<float> preDb;
  std::vector<float> postDb;
};
bool getSpectrumAnalyzerSnapshot(SpectrumAnalyzerSnapshot& out);
/** Set analyzer target to a track (1-based audio track id). Pass trackId <= 0 to use master fallback. */
bool setSpectrumAnalyzerTarget(int32_t trackId, int32_t pluginIndex, std::string& error);

struct TransportSnapshot {
  bool playing = false;
  bool isRecording = false;
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

/** Per-track peak/RMS from native LevelMeter taps (0..1 linear). Vector length matches trackCount (1..N). */
struct TrackMeterLevels {
  float peak = 0.f;
  float rms = 0.f;
};
bool getTransportMeterLevels(std::vector<TrackMeterLevels>& out, int32_t trackCount, std::string& error);

void transportPlay();
/** Start playback with recording; use when at least one track is record-armed. */
void transportRecord();
/** Rebuild playback graph from current edit (all tracks/clips). Call after sync so play is instant. */
void transportEnsureContext();
void transportPause();
void transportStop();
void transportSeek(double positionBeats);
void transportSetBpm(double bpm);

/** Process pending JUCE/Tracktion message thread work. Only use when no main-thread message loop is running. */
void pumpMessageLoop();

/** Run the JUCE message loop for up to \a millisecondsMs. Must be called from the main thread (macOS). */
void runMessageLoopFor(int millisecondsMs);

//-----------------------------------------------------------------------------
// Audio device selection (output). When Tracktion is enabled, list/set output device.
struct AudioDeviceInfo {
  std::string id;
  std::string name;
};
struct AudioStatus {
  double sampleRate = 0.0;
  int blockSize = 0;
  double outputLatencySeconds = 0.0;
  int outputChannels = 0;
};
/** Fill list of available audio output devices. Returns false if not initialised or Tracktion disabled. */
bool getAudioOutputDevices(std::vector<AudioDeviceInfo>& out, std::string& error);
/** Current output device ID (empty if none). */
bool getCurrentAudioOutputDeviceId(std::string& outId, std::string& error);
/** Set output device by ID; saves to settings. Returns false if device not found or not enabled. */
bool setAudioOutputDevice(const std::string& deviceId, std::string& error);

/** Fill list of available audio input devices (for recording). Returns false if not initialised or Tracktion disabled. */
bool getAudioInputDevices(std::vector<AudioDeviceInfo>& out, std::string& error);
/** Current input device ID (empty if none). */
bool getCurrentAudioInputDeviceId(std::string& outId, std::string& error);
/** Set input device by ID; saves to settings. Used as default recording source. Returns false if device not found or not enabled. */
bool setAudioInputDevice(const std::string& deviceId, std::string& error);

/** Current audio status (sample rate, block size, latency, output channels). */
bool getAudioStatus(AudioStatus& out, std::string& error);

}  // namespace thestuu::native
