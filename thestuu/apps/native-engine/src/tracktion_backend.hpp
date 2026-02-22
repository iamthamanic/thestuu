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
