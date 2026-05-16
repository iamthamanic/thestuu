/**
 * @thestuu/protocol – shared native IPC command names, socket events, and payload shapes.
 * Authoritative dispatch: apps/native-engine/src/main.cpp
 * Socket adapters: apps/engine/src/server.js
 */

// ---------------------------------------------------------------------------
// Native IPC commands (MessagePack request `cmd` field)
// ---------------------------------------------------------------------------

/** @type {Readonly<Record<string, string>>} Implemented in native-engine today */
export const NATIVE_COMMANDS = Object.freeze({
  // Transport
  TRANSPORT_GET_STATE: 'transport.get_state',
  TRANSPORT_ENSURE_CONTEXT: 'transport.ensure-context',
  TRANSPORT_PLAY: 'transport.play',
  TRANSPORT_RECORD: 'transport.record',
  TRANSPORT_PAUSE: 'transport.pause',
  TRANSPORT_STOP: 'transport.stop',
  TRANSPORT_SET_BPM: 'transport.set_bpm',
  TRANSPORT_SEEK: 'transport.seek',
  TRANSPORT_GET_METERS: 'transport.get_meters',

  // Edit / clips (legacy sync path)
  EDIT_RESET: 'edit:reset',
  EDIT_CLEAR_AUDIO_CLIPS: 'edit:clear-audio-clips',
  EDIT_GET_AUDIO_CLIPS: 'edit:get-audio-clips',
  EDIT_UNDO: 'edit.undo',
  EDIT_REDO: 'edit.redo',
  CLIP_IMPORT_FILE: 'clip:import-file',
  CLIP_MOVE: 'clip.move',
  CLIP_RESIZE: 'clip.resize',
  CLIP_DELETE: 'clip.delete',

  // Tracks (native layout)
  TRACK_LIST: 'track.list',
  TRACK_CREATE: 'track.create',
  TRACK_DELETE: 'track.delete',
  TRACK_REORDER: 'track.reorder',
  TRACK_SYNC_LAYOUT: 'track.sync-layout',

  PROJECT_EXPORT: 'project.export',
  PROJECT_IMPORT: 'project.import',

  // Tracks / mixer (native)
  TRACK_SET_MUTE: 'track:set-mute',
  TRACK_SET_SOLO: 'track:set-solo',
  TRACK_SET_VOLUME: 'track:set-volume',
  TRACK_SET_PAN: 'track:set-pan',
  TRACK_SET_RECORD_ARM: 'track:set-record-arm',

  // VST / plugins
  VST_SCAN: 'vst:scan',
  VST_LOAD: 'vst:load',
  VST_EDITOR_OPEN: 'vst:editor:open',
  VST_PREVIEW_GET: 'vst:preview:get',
  VST_PARAM_SET: 'vst:param:set',

  // Audio devices
  AUDIO_GET_OUTPUTS: 'audio.get_outputs',
  AUDIO_SET_OUTPUT: 'audio.set_output',
  AUDIO_GET_INPUTS: 'audio.get_inputs',
  AUDIO_SET_INPUT: 'audio.set_input',

  // Analyzer
  ANALYZER_SET_TARGET: 'analyzer:set-target',

  // System
  BACKEND_INFO: 'backend.info',
  HEALTH_PING: 'health.ping',
});

/**
 * Target native-first commands (refactor plan; not all implemented yet).
 * @type {Readonly<Record<string, string>>}
 */
export const NATIVE_COMMANDS_TARGET = Object.freeze({
  EDIT_SAVE: 'edit.save',
  EDIT_OPEN: 'edit.open',
  EDIT_SNAPSHOT: 'edit.snapshot',

  CLIP_SET_FADE: 'clip.setFade',
  CLIP_SET_GAIN: 'clip.setGain',
  CLIP_SPLIT: 'clip.split',

  TRACK_RENAME: 'track.rename',

  MIXER_SET_VOLUME: 'mixer.setVolume',
  MIXER_SET_PAN: 'mixer.setPan',
  MIXER_SET_MUTE: 'mixer.setMute',
  MIXER_SET_SOLO: 'mixer.setSolo',
  MIXER_SET_RECORD_ARM: 'mixer.setRecordArm',

  PLUGIN_SCAN: 'plugin.scan',
  PLUGIN_LOAD: 'plugin.load',
  PLUGIN_UNLOAD: 'plugin.unload',
  PLUGIN_SET_PARAMETER: 'plugin.setParameter',
});

// ---------------------------------------------------------------------------
// Engine → dashboard Socket.IO events
// ---------------------------------------------------------------------------

/** @type {Readonly<Record<string, string>>} */
export const ENGINE_EVENTS = Object.freeze({
  READY: 'engine:ready',
  OFFLINE: 'engine:offline',
  ERROR: 'engine:error',
  STATE: 'engine:state',
  TRANSPORT: 'engine:transport',
  METER: 'engine:meter',
  ANALYZER: 'engine:analyzer',
  LOG: 'engine:log',
  LOGS_INIT: 'engine:logs:init',
});

/**
 * Target domain events (native or engine; migration).
 * @type {Readonly<Record<string, string>>}
 */
export const ENGINE_EVENTS_TARGET = Object.freeze({
  TRANSPORT_CHANGED: 'transport.changed',
  EDIT_SNAPSHOT: 'edit.snapshot',
  EDIT_SAVED: 'edit.saved',
  EDIT_LOADED: 'edit.loaded',
  TRACK_CHANGED: 'track.changed',
  CLIP_CHANGED: 'clip.changed',
  MIXER_CHANGED: 'mixer.changed',
  PLUGIN_CHANGED: 'plugin.changed',
  COMMAND_FAILED: 'command.failed',
});

// ---------------------------------------------------------------------------
// Native → engine IPC events (`event` field on type: "event" messages)
// ---------------------------------------------------------------------------

/** @type {Readonly<Record<string, string>>} */
export const NATIVE_EVENTS = Object.freeze({
  TRANSPORT_TICK: 'transport.tick',
});

// ---------------------------------------------------------------------------
// Dashboard → engine socket command names (colon namespace)
// ---------------------------------------------------------------------------

/** @type {Readonly<Record<string, string>>} */
export const SOCKET_COMMANDS = Object.freeze({
  // Transport
  TRANSPORT_PLAY: 'transport:play',
  TRANSPORT_PAUSE: 'transport:pause',
  TRANSPORT_STOP: 'transport:stop',
  TRANSPORT_SET_BPM: 'transport:set-bpm',
  TRANSPORT_SEEK: 'transport:seek',

  // Tracks
  TRACK_SET_VOLUME: 'track:set-volume',
  TRACK_SET_PAN: 'track:set-pan',
  TRACK_SET_MUTE: 'track:set-mute',
  TRACK_SET_SOLO: 'track:set-solo',
  TRACK_SET_RECORD_ARM: 'track:set-record-arm',
  TRACK_CREATE: 'track:create',
  TRACK_INSERT: 'track:insert',
  TRACK_REORDER: 'track:reorder',
  TRACK_DELETE: 'track:delete',
  TRACK_BULK_DELETE: 'track:bulk-delete',
  TRACK_DUPLICATE: 'track:duplicate',
  TRACK_SET_NAME: 'track:set-name',
  TRACK_SET_CHAIN_COLLAPSED: 'track:set-chain-collapsed',
  TRACK_SET_CHAIN_ENABLED: 'track:set-chain-enabled',
  TRACK_IMPORT_FILE: 'track:import-file',

  // Clips
  CLIP_CREATE: 'clip:create',
  CLIP_IMPORT_FILE: 'clip:import-file',
  CLIP_MOVE: 'clip:move',
  CLIP_RESIZE: 'clip:resize',
  CLIP_SET_FADE: 'clip:set-fade',
  CLIP_SET_GAIN: 'clip:set-gain',
  CLIP_SET_PROPERTIES: 'clip:set-properties',
  CLIP_ANALYZE_BPM_KEY: 'clip:analyze-bpm-key',
  CLIP_DELETE: 'clip:delete',

  // Patterns (Node-owned until separate migration)
  PATTERN_CREATE: 'pattern:create',
  PATTERN_UPDATE_STEP: 'pattern:update-step',
  PATTERN_UPDATE: 'pattern:update',
  PATTERN_DELETE: 'pattern:delete',
  PATTERN_MOVE_MIDI_NOTE: 'pattern:move-midi-note',

  // Project
  PROJECT_LOAD: 'project:load',
  PROJECT_APPLY: 'project:apply',
  PROJECT_SAVE: 'project:save',
  PROJECT_UNDO: 'project:undo',
  PROJECT_REDO: 'project:redo',
  PROJECT_UPDATE_VIEW: 'project:update-view',

  // VST
  VST_SCAN: 'vst:scan',
  VST_ADD: 'vst:add',
  VST_EDITOR_OPEN: 'vst:editor:open',
  VST_REMOVE: 'vst:remove',
  VST_REORDER: 'vst:reorder',
  VST_BYPASS_SET: 'vst:bypass:set',
  VST_PARAM_SET: 'vst:param:set',

  // Song structure (app metadata)
  SONG_STRUCTURE_SET_NODES: 'song-structure:set-nodes',
  SONG_STRUCTURE_SET_PLAYLIST_LINK: 'song-structure:set-playlist-link',
  SONG_STRUCTURE_UPDATE_NODE: 'song-structure:update-node',
  SONG_STRUCTURE_CLEAR: 'song-structure:clear',
  SONG_STRUCTURE_SET_TEMPLATE_META: 'song-structure:set-template-meta',

  // Analyzer / audio I/O
  ANALYZER_SET_TARGET: 'analyzer:set-target',
  AUDIO_GET_OUTPUTS: 'audio:get-outputs',
  AUDIO_SET_OUTPUT: 'audio:set-output',
  AUDIO_GET_INPUTS: 'audio:get-inputs',
  AUDIO_SET_INPUT: 'audio:set-input',
});

/** Flat list of all native command strings (implemented). */
export const NATIVE_COMMAND_LIST = Object.freeze(Object.values(NATIVE_COMMANDS));

/** Flat list of socket command strings. */
export const SOCKET_COMMAND_LIST = Object.freeze(Object.values(SOCKET_COMMANDS));

// ---------------------------------------------------------------------------
// JSDoc payload shapes (documentation; not runtime validation)
// ---------------------------------------------------------------------------

/**
 * Transport snapshot returned under `transport` on native transport commands
 * and mirrored on `engine:transport`.
 * @typedef {object} TransportSnapshot
 * @property {boolean} playing
 * @property {number} bpm
 * @property {number} [recording]
 * @property {number} bar - 1-based
 * @property {number} beat - 1-based
 * @property {number} step - 1-based
 * @property {number} stepIndex - 0-based
 * @property {number} positionBars
 * @property {number} positionBeats
 * @property {number} [timestamp] - epoch ms
 */

/**
 * @typedef {object} TransportSeekPayload
 * @property {number} [position_beats]
 * @property {number} [positionBeats]
 * @property {number} [position_bars]
 * @property {number} [positionBars]
 */

/**
 * @typedef {object} ClipMovePayload
 * @property {number} track_id
 * @property {string} clip_id
 * @property {number} start - bars
 * @property {number} [to_track_id]
 */

/**
 * @typedef {object} ClipResizePayload
 * @property {number} track_id
 * @property {string} clip_id
 * @property {number} length - bars
 * @property {number} [start]
 * @property {number} [trim_start_seconds]
 */

/**
 * @typedef {object} ClipImportNativePayload
 * @property {number} track_id
 * @property {string} source_path
 * @property {number} [start] - bars
 * @property {number} [length] - bars
 * @property {number} [start_seconds]
 * @property {number} [length_seconds]
 * @property {number} [fade_in]
 * @property {number} [fade_out]
 * @property {'audio'|'midi'} [type]
 * @property {number} [source_offset_seconds]
 */

/**
 * @typedef {object} EditSnapshot
 * @property {TransportSnapshot} [transport]
 * @property {Array<object>} [tracks]
 * @property {Array<object>} [clips]
 * @property {Array<object>} [mixer]
 */
