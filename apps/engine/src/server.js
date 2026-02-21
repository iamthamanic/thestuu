import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'socket.io';
import decode from 'audio-decode';
import { createDefaultProject, normalizeProject, parseProject, serializeProject, validateProject } from '@thestuu/shared-json';
import { NativeTransportClient } from './native-transport-client.js';

const enginePort = Number(process.env.ENGINE_PORT || 3987);
const engineHost = process.env.ENGINE_HOST || '127.0.0.1';
const stuuHome = process.env.STUU_HOME || path.join(os.homedir(), '.thestuu');
const projectsDir = path.join(stuuHome, 'projects');
const defaultProjectPath = path.join(projectsDir, 'welcome.stu');
const nativeSocketPath = process.env.STUU_NATIVE_SOCKET || '/tmp/thestuu-native.sock';
const nativeTransportEnabled = process.env.STUU_NATIVE_TRANSPORT !== '0';
const GRID_STEP = 1 / 16;
const BEATS_PER_BAR = 4;
const STEPS_PER_BEAT = 4;
const DEFAULT_PATTERN_LENGTH = 16;
const TRACK_NAME_LIMIT = 25;
const DEFAULT_NATIVE_TRACK_COUNT = 16;
const DEFAULT_PLAYLIST_VIEW_BARS = 32;
const MIN_PLAYLIST_VIEW_BARS = 8;
const MAX_PLAYLIST_VIEW_BARS = 4096;
const DEFAULT_PLAYLIST_BAR_WIDTH = 92;
const MIN_PLAYLIST_BAR_WIDTH = 36;
const MAX_PLAYLIST_BAR_WIDTH = 220;
const DEFAULT_PLAYLIST_SHOW_TRACK_NODES = true;
const IMPORTABLE_AUDIO_EXTENSIONS = new Set(['wav', 'flac', 'mp3', 'ogg', 'aac', 'aiff', 'aif']);
const IMPORTABLE_MIDI_EXTENSIONS = new Set(['mid', 'midi']);
const IMPORTABLE_EXTENSIONS = new Set([...IMPORTABLE_AUDIO_EXTENSIONS, ...IMPORTABLE_MIDI_EXTENSIONS]);
const DEFAULT_IMPORTED_CLIP_LENGTH = 8;
const MAX_WAVEFORM_PEAKS = 2048;
const UPLOAD_WAVEFORM_SAMPLES = 1024;

const mediaDir = path.join(stuuHome, 'media');

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

const state = {
  playing: false,
  project: createDefaultProject('Welcome to TheStuu'),
  selectedProjectFile: defaultProjectPath,
  transport: {
    bar: 1,
    beat: 1,
    step: 1,
    stepIndex: 0,
    positionBars: 0,
    positionBeats: 0,
    timestamp: Date.now(),
  },
};

function sanitizeUploadFilename(name) {
  if (!name || !name.trim()) {
    return '';
  }
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.basename(cleaned);
}

async function readRequestBody(request, limitBytes = MAX_UPLOAD_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) {
      throw new Error('upload too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const transportClock = {
  startedAtMs: null,
  offsetBeats: 0,
};

let nativeTransportClient = null;
let nativeTransportActive = false;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function getFileExtension(filename) {
  if (!isNonEmptyString(filename)) {
    return '';
  }
  const normalized = filename.trim().toLowerCase();
  const dotIndex = normalized.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === normalized.length - 1) {
    return '';
  }
  return normalized.slice(dotIndex + 1);
}

function normalizeImportedFormat(format) {
  if (!isNonEmptyString(format)) {
    return '';
  }
  const normalized = format.trim().toLowerCase();
  if (normalized === 'mid') {
    return 'midi';
  }
  if (normalized === 'aif') {
    return 'aiff';
  }
  return normalized;
}

function normalizeImportedClipType(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'audio' || normalized === 'midi') {
    return normalized;
  }
  return null;
}

function extractWaveformPeaksFromDecoded(audioBuffer, sampleCount = UPLOAD_WAVEFORM_SAMPLES) {
  if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') {
    return [];
  }
  const length = Number(audioBuffer.length);
  const channels = Number(audioBuffer.numberOfChannels) || 0;
  if (!Number.isFinite(length) || length <= 0 || channels <= 0) {
    return [];
  }
  const targetSamples = Math.min(MAX_WAVEFORM_PEAKS, Math.max(24, Math.round(sampleCount)));
  const frameCount = Math.floor(length);
  const blockSize = Math.max(1, Math.floor(frameCount / targetSamples));
  const peaks = [];
  for (let i = 0; i < targetSamples; i += 1) {
    const start = i * blockSize;
    const end = i === targetSamples - 1 ? frameCount : Math.min(frameCount, start + blockSize);
    let peak = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      const data = audioBuffer.getChannelData(ch);
      if (!data) continue;
      for (let j = start; j < end; j += 1) {
        const a = Math.abs(data[j] ?? 0);
        if (a > peak) peak = a;
      }
    }
    peaks.push(Number(Math.min(1, peak).toFixed(4)));
  }
  return normalizeWaveformPeaks(peaks);
}

async function computeWaveformFromUploadBuffer(buffer) {
  try {
    const decoded = await decode(buffer);
    if (!decoded) return { durationSec: null, waveformPeaks: [] };
    const durationSec = Number.isFinite(decoded.duration) && decoded.duration > 0
      ? Number(decoded.duration.toFixed(6))
      : null;
    const waveformPeaks = extractWaveformPeaksFromDecoded(decoded, UPLOAD_WAVEFORM_SAMPLES);
    return { durationSec, waveformPeaks };
  } catch (err) {
    console.warn('[thestuu-engine] upload waveform decode failed:', err instanceof Error ? err.message : err);
    return { durationSec: null, waveformPeaks: [] };
  }
}

function normalizeWaveformPeaks(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const sanitized = value
    .map((peak) => Number(peak))
    .filter((peak) => Number.isFinite(peak))
    .map((peak) => Number(clamp(Math.abs(peak), 0, 1).toFixed(4)));
  if (sanitized.length <= MAX_WAVEFORM_PEAKS) {
    return sanitized;
  }

  const downsampled = [];
  const span = sanitized.length / MAX_WAVEFORM_PEAKS;
  for (let index = 0; index < MAX_WAVEFORM_PEAKS; index += 1) {
    const start = Math.floor(index * span);
    const end = Math.min(sanitized.length, Math.floor((index + 1) * span) || (start + 1));
    let peak = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      if (sanitized[sampleIndex] > peak) {
        peak = sanitized[sampleIndex];
      }
    }
    downsampled.push(Number(peak.toFixed(4)));
  }
  return downsampled;
}

function inferImportedFormatFromMime(mime) {
  if (!isNonEmptyString(mime)) {
    return '';
  }
  const normalized = mime.trim().toLowerCase();
  if (normalized.includes('flac')) {
    return 'flac';
  }
  if (normalized.includes('mpeg') || normalized.includes('mp3')) {
    return 'mp3';
  }
  if (normalized.includes('ogg')) {
    return 'ogg';
  }
  if (normalized.includes('aac')) {
    return 'aac';
  }
  if (normalized.includes('aiff')) {
    return 'aiff';
  }
  if (normalized.includes('wav') || normalized.includes('wave')) {
    return 'wav';
  }
  if (normalized.includes('midi')) {
    return 'midi';
  }
  return '';
}

function inferImportedTypeFromFormat(format) {
  if (IMPORTABLE_MIDI_EXTENSIONS.has(format)) {
    return 'midi';
  }
  if (IMPORTABLE_AUDIO_EXTENSIONS.has(format)) {
    return 'audio';
  }
  return null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundToGrid(value, step = GRID_STEP) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const snapped = Math.round(value / step) * step;
  return Number(snapped.toFixed(6));
}

function makeId(prefix) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${suffix}`;
}

function respond(callback, payload) {
  if (typeof callback === 'function') {
    callback(payload);
  }
}

function emitState() {
  io.emit('engine:state', { ...state, nativeTransport: nativeTransportActive });
}

function ensureProjectArrays() {
  state.project.playlist = Array.isArray(state.project.playlist) ? state.project.playlist : [];
  state.project.patterns = Array.isArray(state.project.patterns) ? state.project.patterns : [];
  state.project.mixer = Array.isArray(state.project.mixer) ? state.project.mixer : [];
  state.project.nodes = Array.isArray(state.project.nodes) ? state.project.nodes : [];
}

function normalizeBool(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  }
  return Boolean(value);
}

function getOrCreateMixerEntry(trackId) {
  ensureProjectArrays();
  let entry = state.project.mixer.find((mixerEntry) => mixerEntry.track_id === trackId);
  if (!entry) {
    entry = createDefaultMixerEntry(trackId);
    state.project.mixer.push(entry);
    state.project.mixer.sort((left, right) => left.track_id - right.track_id);
  } else {
    if (!Number.isFinite(Number(entry.volume))) {
      entry.volume = 0.85;
    }
    if (!Number.isFinite(Number(entry.pan))) {
      entry.pan = 0;
    }
    entry.mute = normalizeBool(entry.mute);
    entry.solo = normalizeBool(entry.solo);
    entry.record_armed = normalizeBool(entry.record_armed);
  }
  return entry;
}

function createDefaultTrackEntry(trackId, name = `Track ${trackId}`) {
  const resolvedTrackId = Number.isInteger(trackId) && trackId > 0 ? trackId : 1;
  const resolvedName = isNonEmptyString(name) ? name.trim().slice(0, TRACK_NAME_LIMIT) : `Track ${resolvedTrackId}`;
  return {
    track_id: resolvedTrackId,
    name: resolvedName,
    chain_collapsed: true,
    chain_enabled: true,
    clips: [],
  };
}

function createDefaultMixerEntry(trackId) {
  const resolvedTrackId = Number.isInteger(trackId) && trackId > 0 ? trackId : 1;
  return {
    track_id: resolvedTrackId,
    volume: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    record_armed: false,
  };
}

function deepCloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function cloneTrackClips(clips) {
  if (!Array.isArray(clips)) {
    return [];
  }
  return clips.map((clip) => ({
    ...clip,
    id: makeId('clip'),
  }));
}

function cloneNodeForTrack(node, trackId) {
  const cloned = deepCloneJson(node, {});
  if (!isObject(cloned)) {
    return null;
  }
  cloned.id = makeId(isVstInstrumentNode(node) ? 'vst' : 'node');
  cloned.track_id = trackId;
  return cloned;
}

function sortProjectTrackCollections() {
  ensureProjectArrays();
  state.project.playlist.sort((left, right) => left.track_id - right.track_id);
  state.project.mixer.sort((left, right) => left.track_id - right.track_id);
}

function shiftTrackIdsForInsert(insertAtTrackId) {
  ensureProjectArrays();
  for (const track of state.project.playlist) {
    const currentId = Number(track.track_id);
    if (Number.isInteger(currentId) && currentId >= insertAtTrackId) {
      track.track_id = currentId + 1;
    }
  }
  for (const mixerEntry of state.project.mixer) {
    const currentId = Number(mixerEntry.track_id);
    if (Number.isInteger(currentId) && currentId >= insertAtTrackId) {
      mixerEntry.track_id = currentId + 1;
    }
  }
  for (const node of state.project.nodes) {
    const currentId = Number(node?.track_id ?? node?.trackId);
    if (Number.isInteger(currentId) && currentId >= insertAtTrackId) {
      node.track_id = currentId + 1;
    }
  }
}

function normalizeTrackIdList(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return Array.from(new Set(
    input
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  )).sort((left, right) => left - right);
}

function reindexTracksRemovingIds(removeTrackIds) {
  ensureProjectArrays();
  const removeSet = new Set(normalizeTrackIdList(removeTrackIds));
  const keptTracks = state.project.playlist
    .map((track) => ({
      ...track,
      track_id: Number(track.track_id),
      clips: Array.isArray(track.clips) ? track.clips : [],
    }))
    .filter((track) => Number.isInteger(track.track_id) && track.track_id > 0 && !removeSet.has(track.track_id))
    .sort((left, right) => left.track_id - right.track_id);

  const trackIdMap = new Map();
  keptTracks.forEach((track, index) => {
    trackIdMap.set(track.track_id, index + 1);
  });

  state.project.playlist = keptTracks.map((track) => ({
    ...track,
    track_id: trackIdMap.get(track.track_id),
    name: isNonEmptyString(track.name) ? track.name.trim().slice(0, TRACK_NAME_LIMIT) : `Track ${trackIdMap.get(track.track_id)}`,
    chain_collapsed: normalizeBool(track.chain_collapsed, true),
    chain_enabled: normalizeBool(track.chain_enabled, true),
  }));

  const mixerByTrackId = new Map();
  for (const entry of state.project.mixer) {
    const trackId = Number(entry?.track_id);
    if (!Number.isInteger(trackId) || trackId <= 0 || removeSet.has(trackId) || !trackIdMap.has(trackId)) {
      continue;
    }
    if (!mixerByTrackId.has(trackId)) {
      mixerByTrackId.set(trackId, entry);
    }
  }
  state.project.mixer = Array.from(trackIdMap.entries()).map(([previousTrackId, nextTrackId]) => {
    const existing = mixerByTrackId.get(previousTrackId);
    if (!existing) {
      return createDefaultMixerEntry(nextTrackId);
    }
    return {
      ...existing,
      track_id: nextTrackId,
      volume: Number.isFinite(Number(existing.volume)) ? Number(existing.volume) : 0.85,
      pan: Number.isFinite(Number(existing.pan)) ? Number(existing.pan) : 0,
      mute: normalizeBool(existing.mute),
      solo: normalizeBool(existing.solo),
      record_armed: normalizeBool(existing.record_armed),
    };
  });

  state.project.nodes = state.project.nodes
    .filter((node) => {
      const trackId = Number(node?.track_id ?? node?.trackId);
      if (!Number.isInteger(trackId) || trackId <= 0) {
        return true;
      }
      return trackIdMap.has(trackId);
    })
    .map((node) => {
      const trackId = Number(node?.track_id ?? node?.trackId);
      if (!Number.isInteger(trackId) || trackId <= 0) {
        return node;
      }
      return {
        ...node,
        track_id: trackIdMap.get(trackId),
      };
    });

  normalizeAllVstPluginIndexes();

  if (state.project.playlist.length === 0) {
    state.project.playlist.push(createDefaultTrackEntry(1));
    state.project.mixer = [createDefaultMixerEntry(1)];
  }

  sortProjectTrackCollections();
  return trackIdMap;
}

function reorderTrackInPlaylist(trackId, toIndex) {
  ensureProjectArrays();
  const sorted = [...state.project.playlist].sort((a, b) => Number(a.track_id) - Number(b.track_id));
  const sourceIndex = sorted.findIndex((t) => Number(t.track_id) === Number(trackId));
  if (sourceIndex === -1) {
    throw new Error(`track ${trackId} not found`);
  }
  const item = sorted.splice(sourceIndex, 1)[0];
  const clampedIndex = Math.max(0, Math.min(toIndex, sorted.length));
  sorted.splice(clampedIndex, 0, item);

  const trackIdMap = new Map();
  sorted.forEach((track, index) => {
    trackIdMap.set(Number(track.track_id), index + 1);
  });

  state.project.playlist = sorted.map((track) => ({
    ...track,
    track_id: trackIdMap.get(Number(track.track_id)),
    name: isNonEmptyString(track.name) ? track.name.trim().slice(0, TRACK_NAME_LIMIT) : track.name,
    chain_collapsed: normalizeBool(track.chain_collapsed, true),
    chain_enabled: normalizeBool(track.chain_enabled, true),
    clips: Array.isArray(track.clips) ? track.clips : [],
  }));

  const mixerByTrackId = new Map();
  for (const entry of state.project.mixer) {
    const tid = Number(entry?.track_id);
    if (Number.isInteger(tid) && tid > 0 && trackIdMap.has(tid)) {
      mixerByTrackId.set(tid, entry);
    }
  }
  state.project.mixer = Array.from(trackIdMap.entries()).map(([previousId, nextId]) => {
    const existing = mixerByTrackId.get(previousId);
    if (!existing) {
      return createDefaultMixerEntry(nextId);
    }
    return {
      ...existing,
      track_id: nextId,
      volume: Number.isFinite(Number(existing.volume)) ? Number(existing.volume) : 0.85,
      pan: Number.isFinite(Number(existing.pan)) ? Number(existing.pan) : 0,
      mute: normalizeBool(existing.mute),
      solo: normalizeBool(existing.solo),
      record_armed: normalizeBool(existing.record_armed),
    };
  });

  state.project.nodes = state.project.nodes.map((node) => {
    const tid = Number(node?.track_id ?? node?.trackId);
    if (!Number.isInteger(tid) || tid <= 0 || !trackIdMap.has(tid)) {
      return node;
    }
    return { ...node, track_id: trackIdMap.get(tid) };
  });

  normalizeAllVstPluginIndexes();
  sortProjectTrackCollections();
}

async function restoreNativeNodesAfterTrackLayoutChange() {
  if (!nativeTransportActive) {
    return { restored: 0, failed: 0, errors: [] };
  }
  return restoreNativeVstNodes({ resetEdit: true });
}

async function safeRestoreNativeNodesAfterTrackLayoutChange() {
  try {
    return await restoreNativeNodesAfterTrackLayoutChange();
  } catch (error) {
    return {
      restored: 0,
      failed: 0,
      errors: [error instanceof Error ? error.message : 'native restore failed'],
    };
  }
}

function normalizeTransportBpm(bpm) {
  const parsed = Number(bpm);
  if (!Number.isFinite(parsed)) {
    return state.project.bpm;
  }
  return Math.min(300, Math.max(20, parsed));
}

function getPatternId(value) {
  if (!isObject(value)) {
    return null;
  }
  if (isNonEmptyString(value.patternId)) {
    return value.patternId.trim();
  }
  if (isNonEmptyString(value.pattern_id)) {
    return value.pattern_id.trim();
  }
  if (isNonEmptyString(value.pattern)) {
    return value.pattern.trim();
  }
  return null;
}

function createTransportSnapshot(timestamp = Date.now()) {
  const bpm = normalizeTransportBpm(state.project.bpm);
  const beatsPerMillisecond = bpm / 60000;
  const elapsedBeats = state.playing && transportClock.startedAtMs !== null
    ? Math.max(0, timestamp - transportClock.startedAtMs) * beatsPerMillisecond
    : 0;
  const positionBeats = Math.max(0, transportClock.offsetBeats + elapsedBeats);
  const bar = Math.floor(positionBeats / BEATS_PER_BAR) + 1;
  const beatInBar = Math.floor(positionBeats % BEATS_PER_BAR) + 1;
  const stepIndex = Math.floor(positionBeats * STEPS_PER_BEAT) % (BEATS_PER_BAR * STEPS_PER_BEAT);

  return {
    bar,
    beat: beatInBar,
    step: stepIndex + 1,
    stepIndex,
    positionBars: Number((positionBeats / BEATS_PER_BAR).toFixed(6)),
    positionBeats: Number(positionBeats.toFixed(6)),
    timestamp,
  };
}

function updateTransportSnapshot(timestamp = Date.now()) {
  state.transport = createTransportSnapshot(timestamp);
  return state.transport;
}

function applyTransportSnapshot(snapshot = {}) {
  if (!isObject(snapshot)) {
    return;
  }

  const nextTransport = {
    ...state.transport,
  };

  const numericFields = ['bar', 'beat', 'step', 'stepIndex', 'positionBars', 'positionBeats', 'timestamp'];
  for (const field of numericFields) {
    const value = Number(snapshot[field]);
    if (Number.isFinite(value)) {
      if (field === 'bar' || field === 'beat' || field === 'step' || field === 'stepIndex') {
        nextTransport[field] = Math.max(0, Math.floor(value));
      } else {
        nextTransport[field] = Number(value.toFixed(6));
      }
    }
  }

  nextTransport.bar = Math.max(1, nextTransport.bar || 1);
  nextTransport.beat = Math.max(1, nextTransport.beat || 1);
  nextTransport.step = Math.max(1, nextTransport.step || 1);
  nextTransport.timestamp = Number.isFinite(Number(nextTransport.timestamp)) ? nextTransport.timestamp : Date.now();
  state.transport = nextTransport;

  if (snapshot.playing !== undefined) {
    state.playing = Boolean(snapshot.playing);
  }
  if (snapshot.bpm !== undefined) {
    state.project.bpm = normalizeTransportBpm(snapshot.bpm);
  }
}

function emitTransport(timestamp = Date.now()) {
  if (nativeTransportActive && state.playing) {
    updateTransportSnapshot(timestamp);
  } else if (!nativeTransportActive) {
    updateTransportSnapshot(timestamp);
  }
  const transport = state.transport;
  io.emit('engine:transport', {
    playing: state.playing,
    ...transport,
  });
}

function restartTransportClock() {
  const now = Date.now();
  if (state.playing) {
    const current = createTransportSnapshot(now);
    transportClock.offsetBeats = current.positionBeats;
    transportClock.startedAtMs = now;
  } else {
    transportClock.startedAtMs = null;
  }
  updateTransportSnapshot(now);
}

function pauseTransportClock() {
  const now = Date.now();
  const current = createTransportSnapshot(now);
  transportClock.offsetBeats = current.positionBeats;
  transportClock.startedAtMs = null;
  state.playing = false;
  updateTransportSnapshot(now);
}

function resetTransportClock() {
  transportClock.startedAtMs = null;
  transportClock.offsetBeats = 0;
  updateTransportSnapshot(Date.now());
}

function handleNativeTransportEvent(eventName, payload = {}) {
  if (eventName !== 'transport.tick' && eventName !== 'transport.state') {
    return;
  }
  applyTransportSnapshot(payload);
  emitTransport(Date.now());
}

async function requestNativeTransport(cmd, payload = {}) {
  if (!nativeTransportClient || !nativeTransportActive) {
    throw new Error('native transport is not active');
  }
  const response = await nativeTransportClient.request(cmd, payload);
  if (isObject(response.transport)) {
    applyTransportSnapshot(response.transport);
  }
  return response;
}

function getTrack(trackId) {
  ensureProjectArrays();
  return state.project.playlist.find((track) => track.track_id === trackId) || null;
}

function getPattern(patternId) {
  ensureProjectArrays();
  return state.project.patterns.find((pattern) => pattern.id === patternId) || null;
}

function assertPositiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function assertTrackId(payload) {
  return assertPositiveInteger(payload.trackId ?? payload.track_id, 'trackId');
}

function assertClipId(payload) {
  if (isNonEmptyString(payload.clipId)) {
    return payload.clipId.trim();
  }
  if (isNonEmptyString(payload.clip_id)) {
    return payload.clip_id.trim();
  }
  throw new Error('clipId is required');
}

function assertPatternId(payload) {
  const patternId = getPatternId(payload);
  if (!patternId) {
    throw new Error('patternId is required');
  }
  return patternId;
}

function isVstInstrumentNode(node) {
  return isObject(node) && node.type === 'vst_instrument';
}

function resolveVstNodePluginUid(node) {
  if (!isObject(node)) {
    return null;
  }
  if (isNonEmptyString(node.plugin_uid)) {
    return node.plugin_uid.trim();
  }
  if (isNonEmptyString(node.pluginUid)) {
    return node.pluginUid.trim();
  }
  if (isNonEmptyString(node.plugin)) {
    return node.plugin.trim();
  }
  return null;
}

function resolveVstNodeTrackId(node) {
  const trackIdRaw = Number(node?.track_id ?? node?.trackId ?? 1);
  return Number.isInteger(trackIdRaw) && trackIdRaw > 0 ? trackIdRaw : 1;
}

function resolveVstNodePluginIndex(node, fallback = 0) {
  const pluginIndexRaw = Number(node?.plugin_index ?? node?.pluginIndex);
  return Number.isInteger(pluginIndexRaw) && pluginIndexRaw >= 0 ? pluginIndexRaw : fallback;
}

function getSortedVstNodeEntriesForTrack(trackId) {
  const resolvedTrackId = Number(trackId);
  if (!Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0) {
    return [];
  }

  return (state.project.nodes || [])
    .map((node, arrayIndex) => ({ node, arrayIndex }))
    .filter(({ node }) => isVstInstrumentNode(node) && resolveVstNodeTrackId(node) === resolvedTrackId)
    .sort((left, right) => {
      const pluginIndexDiff = resolveVstNodePluginIndex(left.node, left.arrayIndex)
        - resolveVstNodePluginIndex(right.node, right.arrayIndex);
      if (pluginIndexDiff !== 0) {
        return pluginIndexDiff;
      }
      return left.arrayIndex - right.arrayIndex;
    });
}

function normalizeVstPluginIndexesForTrack(trackId) {
  const entries = getSortedVstNodeEntriesForTrack(trackId);
  entries.forEach(({ node }, index) => {
    node.plugin_index = index;
  });
  return entries;
}

function normalizeAllVstPluginIndexes() {
  ensureProjectArrays();
  const trackIds = Array.from(new Set(
    state.project.nodes
      .filter((node) => isVstInstrumentNode(node))
      .map((node) => resolveVstNodeTrackId(node)),
  )).sort((left, right) => left - right);

  for (const trackId of trackIds) {
    normalizeVstPluginIndexesForTrack(trackId);
  }
}

function normalizePluginParameters(parameters) {
  if (!Array.isArray(parameters)) {
    return [];
  }

  const normalized = [];
  const seen = new Set();
  for (const [index, rawParameter] of parameters.entries()) {
    if (!isObject(rawParameter)) {
      continue;
    }

    const id = isNonEmptyString(rawParameter.id) ? rawParameter.id.trim() : `param_${index + 1}`;
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);

    const valueRaw = Number(rawParameter.value);
    const minRaw = Number(rawParameter.min);
    const maxRaw = Number(rawParameter.max);
    normalized.push({
      id,
      name: isNonEmptyString(rawParameter.name) ? rawParameter.name.trim() : id,
      min: Number.isFinite(minRaw) ? minRaw : 0,
      max: Number.isFinite(maxRaw) ? maxRaw : 1,
      value: Number.isFinite(valueRaw) ? valueRaw : 0,
    });
  }

  return normalized;
}

async function restoreNativeVstNodes({ resetEdit = false } = {}) {
  if (!nativeTransportActive) {
    return { restored: 0, failed: 0, errors: [] };
  }

  ensureProjectArrays();
  normalizeAllVstPluginIndexes();
  const errors = [];
  let restored = 0;
  let failed = 0;

  if (resetEdit) {
    const maxTrackIdFromNodes = state.project.nodes.reduce((maxTrackId, node) => {
      if (!isVstInstrumentNode(node)) {
        return maxTrackId;
      }
      return Math.max(maxTrackId, resolveVstNodeTrackId(node));
    }, 1);
    const maxTrackIdFromPlaylist = (state.project.playlist || []).reduce(
      (max, t) => Math.max(max, Number(t.track_id) || 0),
      1,
    );
    await requestNativeTransport('edit:reset', {
      track_count: Math.max(DEFAULT_NATIVE_TRACK_COUNT, maxTrackIdFromNodes, maxTrackIdFromPlaylist),
    });
  }

  const vstEntriesForRestore = state.project.nodes
    .map((node, arrayIndex) => ({ node, arrayIndex }))
    .filter(({ node }) => isVstInstrumentNode(node))
    .sort((left, right) => {
      const trackDiff = resolveVstNodeTrackId(left.node) - resolveVstNodeTrackId(right.node);
      if (trackDiff !== 0) {
        return trackDiff;
      }
      const pluginIndexDiff = resolveVstNodePluginIndex(left.node, left.arrayIndex)
        - resolveVstNodePluginIndex(right.node, right.arrayIndex);
      if (pluginIndexDiff !== 0) {
        return pluginIndexDiff;
      }
      return left.arrayIndex - right.arrayIndex;
    });

  for (const { node } of vstEntriesForRestore) {
    if (!isVstInstrumentNode(node)) {
      continue;
    }

    const pluginUid = resolveVstNodePluginUid(node);
    if (!pluginUid) {
      continue;
    }

    const trackId = resolveVstNodeTrackId(node);
    try {
      let response = null;
      let resolvedPluginUid = pluginUid;
      let usedUltrasoundFallback = false;

      try {
        response = await requestNativeTransport('vst:load', {
          plugin_uid: resolvedPluginUid,
          track_id: trackId,
        });
      } catch (initialError) {
        const errorMessage = initialError instanceof Error ? initialError.message : String(initialError);
        const hasExplicitPluginUid = isNonEmptyString(node.plugin_uid) || isNonEmptyString(node.pluginUid);
        const canFallbackToUltrasound = !hasExplicitPluginUid && resolvedPluginUid !== 'internal:ultrasound';
        if (!canFallbackToUltrasound || !errorMessage.includes('VST not found')) {
          throw initialError;
        }

        resolvedPluginUid = 'internal:ultrasound';
        response = await requestNativeTransport('vst:load', {
          plugin_uid: resolvedPluginUid,
          track_id: trackId,
        });
        usedUltrasoundFallback = true;
      }

      const loadedPlugin = isObject(response.plugin) ? response.plugin : {};
      const loadedTrackId = Number(loadedPlugin.trackId);
      const loadedPluginIndex = Number(loadedPlugin.pluginIndex);

      node.plugin = isNonEmptyString(loadedPlugin.name)
        ? loadedPlugin.name
        : (usedUltrasoundFallback ? 'Ultrasound' : (isNonEmptyString(node.plugin) ? node.plugin.trim() : resolvedPluginUid));
      node.plugin_uid = isNonEmptyString(loadedPlugin.uid) ? loadedPlugin.uid : resolvedPluginUid;
      node.track_id = Number.isInteger(loadedTrackId) && loadedTrackId > 0 ? loadedTrackId : trackId;
      node.plugin_index = Number.isInteger(loadedPluginIndex) && loadedPluginIndex >= 0 ? loadedPluginIndex : 0;

      const parameterSchema = normalizePluginParameters(loadedPlugin.parameters);
      node.parameter_schema = parameterSchema;
      node.params = isObject(node.params) ? node.params : {};

      for (const parameter of parameterSchema) {
        if (node.params[parameter.id] === undefined && Number.isFinite(Number(parameter.value))) {
          node.params[parameter.id] = Number(parameter.value);
        }
      }

      for (const [paramId, rawValue] of Object.entries(node.params)) {
        const value = Number(rawValue);
        if (!Number.isFinite(value)) {
          continue;
        }
        try {
          const parameterResponse = await requestNativeTransport('vst:param:set', {
            track_id: node.track_id,
            plugin_index: node.plugin_index,
            param_id: paramId,
            value,
          });
          const appliedValue = Number(parameterResponse?.parameter?.value);
          node.params[paramId] = Number.isFinite(appliedValue) ? appliedValue : value;
        } catch (error) {
          errors.push(`node "${node.id}" param "${paramId}": ${error instanceof Error ? error.message : 'set failed'}`);
        }
      }

      restored += 1;
    } catch (error) {
      failed += 1;
      errors.push(`node "${node.id}": ${error instanceof Error ? error.message : 'load failed'}`);
    }
  }

  if (resetEdit) {
    const syncErrors = await syncPlaylistClipsToNative();
    if (syncErrors.length > 0) {
      errors.push(...syncErrors);
    }
  }

  return { restored, failed, errors };
}

async function syncPlaylistClipsToNative() {
  if (!nativeTransportActive) {
    return [];
  }
  const errors = [];
  const playlist = Array.isArray(state.project.playlist) ? state.project.playlist : [];
  for (const track of playlist) {
    const trackId = Number(track.track_id);
    if (!Number.isInteger(trackId) || trackId < 1) {
      continue;
    }
    const clips = Array.isArray(track.clips) ? track.clips : [];
    for (const clip of clips) {
      const sourcePath = isNonEmptyString(clip.source_path)
        ? clip.source_path.trim()
        : (isNonEmptyString(clip.sourcePath) ? clip.sourcePath.trim() : '');
      if (!sourcePath) {
        continue;
      }
      const type = (clip.type || clip.clip_type || 'audio').toString().toLowerCase();
      if (type !== 'audio') {
        continue;
      }
      const start = Number(clip.start);
      const length = Number(clip.length);
      if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) {
        continue;
      }
      try {
        await requestNativeTransport('clip:import-file', {
          track_id: trackId,
          source_path: sourcePath,
          start,
          length,
          type: 'audio',
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`clip ${clip.id} on track ${trackId}: ${msg}`);
      }
    }
  }
  if (errors.length > 0) {
    console.warn('[thestuu-engine] native clip sync errors:', errors.join('; '));
  }
  return errors;
}

function findClip(track, clipId) {
  if (!track || !Array.isArray(track.clips)) {
    return { clip: null, index: -1 };
  }
  const index = track.clips.findIndex((clip) => clip.id === clipId);
  if (index === -1) {
    return { clip: null, index: -1 };
  }
  return { clip: track.clips[index], index };
}

function sortClips(track) {
  track.clips.sort((left, right) => {
    if (left.start === right.start) {
      return left.id.localeCompare(right.id);
    }
    return left.start - right.start;
  });
}

function nextClipStart(track) {
  if (!Array.isArray(track.clips) || track.clips.length === 0) {
    return 0;
  }
  return track.clips.reduce((maxEnd, clip) => {
    const end = (Number(clip.start) || 0) + (Number(clip.length) || GRID_STEP);
    return Math.max(maxEnd, end);
  }, 0);
}

function sanitizePatternInput(payload) {
  const source = isObject(payload.pattern) ? payload.pattern : payload;
  const providedType = isNonEmptyString(source.type) ? source.type.trim().toLowerCase() : null;
  const type = providedType === 'midi' ? 'midi' : providedType === 'drum' ? 'drum' : 'drum';
  const id = isNonEmptyString(source.id) ? source.id.trim() : makeId('pattern');
  const length = clamp(assertPositiveInteger(source.length ?? DEFAULT_PATTERN_LENGTH, 'pattern.length'), 1, 128);
  const swing = clamp(Number(source.swing ?? 0), 0, 0.95);

  if (type === 'drum') {
    const steps = Array.isArray(source.steps) ? source.steps : [];
    const normalizedSteps = [];
    const dedupe = new Set();

    for (const [index, rawStep] of steps.entries()) {
      if (!isObject(rawStep)) {
        continue;
      }
      const lane = isNonEmptyString(rawStep.lane) ? rawStep.lane.trim() : `Lane ${index + 1}`;
      const stepIndex = clamp(Number(rawStep.index ?? index), 0, length - 1);
      if (!Number.isFinite(stepIndex)) {
        continue;
      }
      const velocity = clamp(Number(rawStep.velocity ?? 1), 0, 1);
      if (!Number.isFinite(velocity) || velocity <= 0) {
        continue;
      }

      const key = `${lane}:${Math.floor(stepIndex)}`;
      if (dedupe.has(key)) {
        continue;
      }
      dedupe.add(key);
      normalizedSteps.push({
        lane,
        index: Math.floor(stepIndex),
        velocity: Number(velocity.toFixed(2)),
      });
    }

    return {
      id,
      type: 'drum',
      length,
      swing: Number(swing.toFixed(3)),
      steps: normalizedSteps,
    };
  }

  const notes = Array.isArray(source.notes) ? source.notes : [];
  const normalizedNotes = [];
  for (const [index, rawNote] of notes.entries()) {
    if (!isObject(rawNote)) {
      continue;
    }
    const noteId = isNonEmptyString(rawNote.id) ? rawNote.id.trim() : makeId(`note_${index + 1}`);
    const start = Math.max(0, roundToGrid(Number(rawNote.start ?? 0)));
    const noteLength = Math.max(GRID_STEP, roundToGrid(Number(rawNote.length ?? GRID_STEP)));
    const pitch = clamp(Math.floor(Number(rawNote.pitch ?? 36)), 0, 127);
    const velocity = clamp(Number(rawNote.velocity ?? 0.8), 0, 1);

    normalizedNotes.push({
      id: noteId,
      start,
      length: noteLength,
      pitch,
      velocity: Number(velocity.toFixed(2)),
    });
  }

  return {
    id,
    type: 'midi',
    length,
    swing: Number(swing.toFixed(3)),
    notes: normalizedNotes,
  };
}

function updatePatternStep(payload = {}) {
  const patternId = assertPatternId(payload);
  const pattern = getPattern(patternId);
  if (!pattern) {
    throw new Error(`pattern "${patternId}" not found`);
  }
  if (pattern.type !== 'drum') {
    throw new Error('pattern:update-step currently supports drum patterns only');
  }

  const lane = isNonEmptyString(payload.lane) ? payload.lane.trim() : null;
  if (!lane) {
    throw new Error('lane is required');
  }
  const stepIndexRaw = Number(payload.stepIndex ?? payload.index);
  if (!Number.isFinite(stepIndexRaw)) {
    throw new Error('stepIndex must be a number');
  }
  const stepIndex = clamp(Math.floor(stepIndexRaw), 0, Math.max(0, (pattern.length || DEFAULT_PATTERN_LENGTH) - 1));
  const velocity = clamp(Number(payload.velocity ?? 1), 0, 1);
  pattern.steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  const existingIndex = pattern.steps.findIndex((step) => step.lane === lane && step.index === stepIndex);

  if (velocity <= 0) {
    if (existingIndex >= 0) {
      pattern.steps.splice(existingIndex, 1);
    }
    return { pattern };
  }

  const nextStep = {
    lane,
    index: stepIndex,
    velocity: Number(velocity.toFixed(2)),
  };

  if (existingIndex >= 0) {
    pattern.steps[existingIndex] = nextStep;
  } else {
    pattern.steps.push(nextStep);
  }

  pattern.steps.sort((left, right) => {
    if (left.index === right.index) {
      return left.lane.localeCompare(right.lane);
    }
    return left.index - right.index;
  });

  return { pattern };
}

function updatePatternMeta(payload = {}) {
  const patternId = assertPatternId(payload);
  const pattern = getPattern(patternId);
  if (!pattern) {
    throw new Error(`pattern "${patternId}" not found`);
  }

  if (payload.length !== undefined) {
    const nextLength = clamp(assertPositiveInteger(payload.length, 'length'), 1, 128);
    pattern.length = nextLength;
    if (pattern.type === 'drum') {
      pattern.steps = (pattern.steps || []).filter((step) => step.index < nextLength);
    }
  }

  if (payload.swing !== undefined) {
    const swing = Number(payload.swing);
    if (!Number.isFinite(swing)) {
      throw new Error('swing must be numeric');
    }
    pattern.swing = Number(clamp(swing, 0, 0.95).toFixed(3));
  }

  return { pattern };
}

function createPattern(payload = {}) {
  ensureProjectArrays();
  const pattern = sanitizePatternInput(payload);
  const duplicate = state.project.patterns.find((entry) => entry.id === pattern.id);
  if (duplicate) {
    throw new Error(`pattern id "${pattern.id}" already exists`);
  }
  state.project.patterns.push(pattern);
  return { pattern };
}

function deletePattern(payload = {}) {
  ensureProjectArrays();
  const patternId = assertPatternId(payload);
  const previousLength = state.project.patterns.length;
  state.project.patterns = state.project.patterns.filter((pattern) => pattern.id !== patternId);
  if (state.project.patterns.length === previousLength) {
    throw new Error(`pattern "${patternId}" not found`);
  }

  for (const track of state.project.playlist) {
    track.clips = Array.isArray(track.clips)
      ? track.clips.filter((clip) => getPatternId(clip) !== patternId)
      : [];
  }

  return { patternId };
}

function createClip(payload = {}) {
  ensureProjectArrays();
  const trackId = assertTrackId(payload);
  const track = getTrack(trackId);
  if (!track) {
    throw new Error(`track "${trackId}" not found`);
  }

  const patternId = assertPatternId(payload);
  if (!getPattern(patternId)) {
    throw new Error(`pattern "${patternId}" not found`);
  }

  const clipId = isNonEmptyString(payload.id) ? payload.id.trim() : makeId('clip');
  const start = payload.start !== undefined ? roundToGrid(Math.max(0, Number(payload.start))) : roundToGrid(nextClipStart(track));
  const length = payload.length !== undefined
    ? Math.max(GRID_STEP, roundToGrid(Number(payload.length)))
    : 1;
  if (!Number.isFinite(start) || !Number.isFinite(length)) {
    throw new Error('clip start/length must be numbers');
  }
  if (Array.isArray(track.clips) && track.clips.some((clip) => clip.id === clipId)) {
    throw new Error(`clip id "${clipId}" already exists on track ${trackId}`);
  }

  track.clips = Array.isArray(track.clips) ? track.clips : [];
  track.clips.push({
    id: clipId,
    start,
    length,
    pattern_id: patternId,
  });
  sortClips(track);
  return { clipId, trackId };
}

async function importClipFile(payload = {}) {
  ensureProjectArrays();
  const trackId = assertTrackId(payload);
  const track = getTrack(trackId);
  if (!track) {
    throw new Error(`track "${trackId}" not found`);
  }

  const clipId = isNonEmptyString(payload.id) ? payload.id.trim() : makeId('clip');
  if (Array.isArray(track.clips) && track.clips.some((clip) => clip.id === clipId)) {
    throw new Error(`clip id "${clipId}" already exists on track ${trackId}`);
  }

  const sourceNameRaw = payload.source_name ?? payload.sourceName ?? payload.file_name ?? payload.fileName ?? payload.filename ?? payload.name;
  const sourceName = isNonEmptyString(sourceNameRaw) ? sourceNameRaw.trim().slice(0, 255) : '';
  if (!sourceName) {
    throw new Error('source_name is required');
  }

  const sourceMimeRaw = payload.source_mime ?? payload.sourceMime ?? payload.mime;
  const sourceMime = isNonEmptyString(sourceMimeRaw) ? sourceMimeRaw.trim().toLowerCase().slice(0, 96) : '';
  const extension = normalizeImportedFormat(getFileExtension(sourceName));
  const mimeFormat = normalizeImportedFormat(inferImportedFormatFromMime(sourceMime));
  const providedFormat = normalizeImportedFormat(payload.source_format ?? payload.sourceFormat ?? payload.format);
  const sourceFormat = providedFormat || extension || mimeFormat;
  if (!sourceFormat || !IMPORTABLE_EXTENSIONS.has(sourceFormat)) {
    throw new Error(`unsupported source_format "${sourceFormat || 'unknown'}"`);
  }

  const providedType = normalizeImportedClipType(payload.type ?? payload.clip_type ?? payload.clipType);
  const inferredType = inferImportedTypeFromFormat(sourceFormat)
    || (sourceMime.includes('midi') ? 'midi' : sourceMime.startsWith('audio/') ? 'audio' : null);
  const clipType = providedType || inferredType;
  if (!clipType) {
    throw new Error('type must be "audio" or "midi"');
  }
  if (clipType === 'midi' && !IMPORTABLE_MIDI_EXTENSIONS.has(sourceFormat)) {
    throw new Error(`source_format "${sourceFormat}" is not a midi format`);
  }
  if (clipType === 'audio' && !IMPORTABLE_AUDIO_EXTENSIONS.has(sourceFormat)) {
    throw new Error(`source_format "${sourceFormat}" is not an audio format`);
  }

  const sourcePathRaw = payload.source_path ?? payload.sourcePath ?? payload.file_path ?? payload.filePath;
  const sourcePath = isNonEmptyString(sourcePathRaw) ? sourcePathRaw.trim() : '';

  const start = payload.start !== undefined ? roundToGrid(Math.max(0, Number(payload.start))) : roundToGrid(nextClipStart(track));
  const length = payload.length !== undefined
    ? Math.max(GRID_STEP, roundToGrid(Number(payload.length)))
    : DEFAULT_IMPORTED_CLIP_LENGTH;
  if (!Number.isFinite(start) || !Number.isFinite(length)) {
    throw new Error('clip start/length must be numbers');
  }

  const sourceSizeBytesRaw = Number(payload.source_size_bytes ?? payload.sourceSizeBytes ?? payload.size_bytes ?? payload.sizeBytes);
  const sourceSizeBytes = Number.isFinite(sourceSizeBytesRaw) && sourceSizeBytesRaw >= 0
    ? Math.round(sourceSizeBytesRaw)
    : null;
  const sourceDurationSecondsRaw = Number(
    payload.source_duration_seconds
    ?? payload.sourceDurationSeconds
    ?? payload.duration_seconds
    ?? payload.durationSeconds,
  );
  const sourceDurationSeconds = Number.isFinite(sourceDurationSecondsRaw) && sourceDurationSecondsRaw > 0
    ? Number(sourceDurationSecondsRaw.toFixed(6))
    : null;
  const waveformPeaks = normalizeWaveformPeaks(payload.waveform_peaks ?? payload.waveformPeaks ?? payload.waveform ?? []);

  track.clips = Array.isArray(track.clips) ? track.clips : [];
  track.clips.push({
    id: clipId,
    start,
    length,
    type: clipType,
    source_name: sourceName,
    source_format: sourceFormat,
    ...(sourceMime ? { source_mime: sourceMime } : {}),
    ...(sourceSizeBytes !== null ? { source_size_bytes: sourceSizeBytes } : {}),
    ...(clipType === 'audio' && sourceDurationSeconds !== null ? { source_duration_seconds: sourceDurationSeconds } : {}),
    ...(clipType === 'audio' && waveformPeaks.length > 0 ? { waveform_peaks: waveformPeaks } : {}),
    ...(sourcePath ? { source_path: sourcePath } : {}),
  });
  sortClips(track);

  if (nativeTransportActive && sourcePath) {
    try {
      await requestNativeTransport('clip:import-file', {
        track_id: trackId,
        source_path: sourcePath,
        start,
        length,
        type: clipType,
      });
    } catch (error) {
      console.warn('[thestuu-engine] native clip import failed:', error instanceof Error ? error.message : error);
    }
  }

  if (nativeTransportActive) {
    const syncErrors = await syncPlaylistClipsToNative();
    if (syncErrors.length > 0) {
      console.warn('[thestuu-engine] native clip sync after import:', syncErrors.join('; '));
    }
  }

  return {
    clipId,
    trackId,
    type: clipType,
    source_name: sourceName,
    source_format: sourceFormat,
    source_path: sourcePath,
  };
}

function moveClip(payload = {}) {
  const sourceTrackId = assertTrackId(payload);
  const clipId = assertClipId(payload);
  const sourceTrack = getTrack(sourceTrackId);
  if (!sourceTrack) {
    throw new Error(`track "${sourceTrackId}" not found`);
  }

  const { clip, index } = findClip(sourceTrack, clipId);
  if (!clip || index === -1) {
    throw new Error(`clip "${clipId}" not found on track ${sourceTrackId}`);
  }

  const nextStartRaw = Number(payload.start);
  if (!Number.isFinite(nextStartRaw)) {
    throw new Error('start must be numeric');
  }
  const nextStart = Math.max(0, roundToGrid(nextStartRaw));

  const destinationTrackIdRaw = payload.toTrackId ?? payload.to_track_id;
  if (destinationTrackIdRaw !== undefined) {
    const destinationTrackId = assertPositiveInteger(destinationTrackIdRaw, 'toTrackId');
    if (destinationTrackId !== sourceTrackId) {
      const destinationTrack = getTrack(destinationTrackId);
      if (!destinationTrack) {
        throw new Error(`track "${destinationTrackId}" not found`);
      }

      sourceTrack.clips.splice(index, 1);
      destinationTrack.clips = Array.isArray(destinationTrack.clips) ? destinationTrack.clips : [];
      destinationTrack.clips.push({
        ...clip,
        start: nextStart,
      });
      sortClips(destinationTrack);
      return { clipId, trackId: destinationTrackId };
    }
  }

  clip.start = nextStart;
  sortClips(sourceTrack);
  return { clipId, trackId: sourceTrackId };
}

function resizeClip(payload = {}) {
  const trackId = assertTrackId(payload);
  const clipId = assertClipId(payload);
  const nextLengthRaw = Number(payload.length);
  if (!Number.isFinite(nextLengthRaw)) {
    throw new Error('length must be numeric');
  }

  const track = getTrack(trackId);
  if (!track) {
    throw new Error(`track "${trackId}" not found`);
  }
  const { clip } = findClip(track, clipId);
  if (!clip) {
    throw new Error(`clip "${clipId}" not found on track ${trackId}`);
  }

  clip.length = Math.max(GRID_STEP, roundToGrid(nextLengthRaw));
  return { clipId, trackId };
}

function deleteClip(payload = {}) {
  const trackId = assertTrackId(payload);
  const clipId = assertClipId(payload);
  const track = getTrack(trackId);
  if (!track) {
    throw new Error(`track "${trackId}" not found`);
  }

  const currentLength = track.clips.length;
  track.clips = track.clips.filter((clip) => clip.id !== clipId);
  if (track.clips.length === currentLength) {
    throw new Error(`clip "${clipId}" not found on track ${trackId}`);
  }
  return { clipId, trackId };
}

function moveMidiNote(payload = {}) {
  const patternId = assertPatternId(payload);
  const pattern = getPattern(patternId);
  if (!pattern) {
    throw new Error(`pattern "${patternId}" not found`);
  }
  if (pattern.type !== 'midi') {
    throw new Error(`pattern "${patternId}" is not a midi pattern`);
  }

  const noteId = isNonEmptyString(payload.noteId) ? payload.noteId.trim() : isNonEmptyString(payload.note_id) ? payload.note_id.trim() : null;
  if (!noteId) {
    throw new Error('noteId is required');
  }

  pattern.notes = Array.isArray(pattern.notes) ? pattern.notes : [];
  const note = pattern.notes.find((entry) => entry.id === noteId);
  if (!note) {
    throw new Error(`note "${noteId}" not found`);
  }

  if (payload.start !== undefined) {
    const start = Number(payload.start);
    if (!Number.isFinite(start)) {
      throw new Error('note.start must be numeric');
    }
    note.start = Math.max(0, roundToGrid(start));
  }
  if (payload.length !== undefined) {
    const length = Number(payload.length);
    if (!Number.isFinite(length)) {
      throw new Error('note.length must be numeric');
    }
    note.length = Math.max(GRID_STEP, roundToGrid(length));
  }
  if (payload.pitch !== undefined) {
    const pitch = Number(payload.pitch);
    if (!Number.isFinite(pitch)) {
      throw new Error('note.pitch must be numeric');
    }
    note.pitch = clamp(Math.floor(pitch), 0, 127);
  }
  if (payload.velocity !== undefined) {
    const velocity = Number(payload.velocity);
    if (!Number.isFinite(velocity)) {
      throw new Error('note.velocity must be numeric');
    }
    note.velocity = Number(clamp(velocity, 0, 1).toFixed(2));
  }

  return { patternId, noteId };
}

async function ensureProjectFile() {
  await fs.mkdir(projectsDir, { recursive: true });

  try {
    const raw = await fs.readFile(defaultProjectPath, 'utf8');
    state.project = parseProject(raw);
    normalizeAllVstPluginIndexes();
  } catch {
    await fs.writeFile(defaultProjectPath, serializeProject(state.project), 'utf8');
  }
}

async function saveProject(targetPath, projectData) {
  const normalizedProject = normalizeProject(projectData);
  const validation = validateProject(normalizedProject);
  if (!validation.ok) {
    throw new Error(validation.errors.join('; '));
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, serializeProject(normalizedProject), 'utf8');
  return normalizedProject;
}

async function startNativeTransportBridge() {
  if (!nativeTransportEnabled) {
    return;
  }

  nativeTransportClient = new NativeTransportClient({
    socketPath: nativeSocketPath,
  });

  nativeTransportClient.on('connect', () => {
    nativeTransportActive = true;
    emitState();
    emitTransport(Date.now());
    setTimeout(async () => {
      if (!nativeTransportActive) return;
      try {
        await requestNativeTransport('transport.set_bpm', { bpm: state.project.bpm });
        await requestNativeTransport('transport.get_state');
        const restoreResult = await restoreNativeVstNodes({ resetEdit: true });
        if (restoreResult.failed > 0 || restoreResult.errors.length > 0) {
          console.warn('[thestuu-engine] native VST restore issues:', restoreResult.errors.join(' | '));
        }
        emitState();
        emitTransport(Date.now());
      } catch (error) {
        console.warn('[thestuu-engine] native transport sync failed:', error instanceof Error ? error.message : error);
      }
    }, 500);
  });

  nativeTransportClient.on('disconnect', () => {
    nativeTransportActive = false;
    transportClock.offsetBeats = Number(state.transport?.positionBeats) || 0;
    transportClock.startedAtMs = state.playing ? Date.now() : null;
    console.warn('[thestuu-engine] native transport disconnected; using JS fallback transport clock.');
    emitState();
  });

  nativeTransportClient.on('event', handleNativeTransportEvent);

  nativeTransportClient.on('error', (error) => {
    console.warn('[thestuu-engine] native transport error:', error instanceof Error ? error.message : error);
  });

  try {
    await nativeTransportClient.start();
    nativeTransportActive = true;
    console.log(`[thestuu-engine] native transport connected (${nativeSocketPath})`);
  } catch (error) {
    nativeTransportActive = false;
    console.warn('[thestuu-engine] native transport not ready yet, retrying in background:', error instanceof Error ? error.message : error);
  }
}

function getRequestPath(request) {
  const rawUrl = typeof request?.url === 'string' ? request.url : '/';
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    const [pathname] = rawUrl.split('?');
    return pathname || '/';
  }
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const httpServer = createServer(async (request, response) => {
  const safeSendJson = (statusCode, payload, extraHeaders = {}) => {
    if (response.headersSent) return;
    let body;
    try {
      body = JSON.stringify(payload);
    } catch (e) {
      console.warn('[thestuu-engine] JSON serialize failed:', e instanceof Error ? e.message : e);
      body = '{"ok":false,"error":"Internal server error"}';
      statusCode = 500;
    }
    try {
      response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...CORS_HEADERS,
        ...extraHeaders,
      });
      response.end(body);
    } catch (e) {
      console.warn('[thestuu-engine] response write failed:', e instanceof Error ? e.message : e);
    }
  };

  try {
    const method = String(request?.method || 'GET').toUpperCase();
    const requestPath = getRequestPath(request);

    if (requestPath.startsWith('/socket.io')) {
      return;
    }

    if (method === 'OPTIONS' && requestPath === '/media/upload') {
      response.writeHead(204, { ...CORS_HEADERS, 'Content-Length': '0' });
      response.end();
      return;
    }

    if (method === 'POST' && requestPath === '/media/upload') {
      try {
        const parsedUrl = new URL(request?.url ?? '', `http://${request?.headers?.host || 'localhost'}`);
        const providedName = sanitizeUploadFilename(parsedUrl.searchParams.get('filename') || '');
        const buffer = await readRequestBody(request);
        if (buffer.length === 0) {
          throw new Error('empty upload');
        }
        await fs.mkdir(mediaDir, { recursive: true });
        const finalName = providedName || `import_${Date.now()}`;
        const destinationPath = path.resolve(path.join(mediaDir, finalName));
        await fs.writeFile(destinationPath, buffer);
        const { durationSec, waveformPeaks } = await computeWaveformFromUploadBuffer(buffer);
        const payload = {
          ok: true,
          path: destinationPath,
          size: buffer.length,
        };
        if (durationSec != null) payload.duration_sec = durationSec;
        if (Array.isArray(waveformPeaks) && waveformPeaks.length > 0) payload.waveform_peaks = waveformPeaks;
        sendJson(response, 200, payload, CORS_HEADERS);
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : 'upload failed' }, CORS_HEADERS);
      }
      return;
    }

    if (method === 'GET' && requestPath === '/health') {
      safeSendJson(200, {
        ok: true,
        service: 'thestuu-engine',
        pid: process.pid,
        host: engineHost,
        port: enginePort,
        nativeTransport: Boolean(nativeTransportActive),
        projectFile: state?.selectedProjectFile ?? null,
        timestamp: Date.now(),
      });
      return;
    }

    if (method === 'GET' && requestPath === '/') {
      safeSendJson(200, {
        ok: true,
        service: 'thestuu-engine',
        health: '/health',
      });
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: 'not_found',
      path: requestPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[thestuu-engine] HTTP handler error:', message);
    safeSendJson(500, {
      ok: false,
      error: 'Internal server error',
      detail: message,
    });
  }
});
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
});

function bindMutation(socket, eventName, handler) {
  socket.on(eventName, async (payload = {}, callback = () => {}) => {
    try {
      const result = await handler(payload);
      emitState();
      respond(callback, { ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown mutation error';
      socket.emit('engine:error', { event: eventName, error: message });
      respond(callback, { ok: false, error: message });
    }
  });
}

io.on('connection', (socket) => {
  if (!nativeTransportActive) {
    updateTransportSnapshot(Date.now());
  }
  socket.emit('engine:ready', {
    enginePort,
    projectFile: state.selectedProjectFile,
    nativeTransport: nativeTransportActive,
    nativeSocketPath: nativeTransportEnabled ? nativeSocketPath : null,
  });
  socket.emit('engine:state', { ...state, nativeTransport: nativeTransportActive });
  socket.emit('engine:transport', {
    playing: state.playing,
    ...state.transport,
  });

  socket.on('transport:play', async (_payload = {}, callback = () => {}) => {
    const startPlayhead = () => {
      state.playing = true;
      transportClock.startedAtMs = Date.now();
      transportClock.offsetBeats = state.transport?.positionBeats ?? 0;
      updateTransportSnapshot(Date.now());
      emitState();
      emitTransport(Date.now());
    };
    try {
      if (nativeTransportActive) {
        await requestNativeTransport('transport.play');
        state.playing = true;
        if (state.transport && typeof state.transport.positionBeats === 'number') {
          transportClock.offsetBeats = state.transport.positionBeats;
          transportClock.startedAtMs = Date.now();
        } else {
          transportClock.startedAtMs = Date.now();
          transportClock.offsetBeats = state.transport?.positionBeats ?? 0;
        }
        updateTransportSnapshot(Date.now());
        emitState();
        emitTransport(Date.now());
        respond(callback, { ok: true, playing: state.playing });
      } else if (!state.playing) {
        startPlayhead();
        respond(callback, { ok: true, playing: state.playing });
      } else {
        emitState();
        emitTransport(Date.now());
        respond(callback, { ok: true, playing: state.playing });
      }
    } catch (error) {
      console.warn('[thestuu-engine] transport:play failed, starting UI playhead anyway:', error instanceof Error ? error.message : error);
      if (!state.playing) startPlayhead();
      else { emitState(); emitTransport(Date.now()); }
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'transport:play failed' });
    }
  });

  socket.on('transport:pause', async (_payload = {}, callback = () => {}) => {
    try {
      if (nativeTransportActive) {
        await requestNativeTransport('transport.pause');
        state.playing = false;
        if (state.transport && typeof state.transport.positionBeats === 'number') {
          transportClock.offsetBeats = state.transport.positionBeats;
          transportClock.startedAtMs = null;
        }
      } else if (state.playing) {
        pauseTransportClock();
      }
      emitState();
      emitTransport(Date.now());
      respond(callback, { ok: true, playing: state.playing });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'transport:pause failed' });
    }
  });

  socket.on('transport:stop', async (_payload = {}, callback = () => {}) => {
    try {
      if (nativeTransportActive) {
        await requestNativeTransport('transport.stop');
        state.playing = false;
        transportClock.offsetBeats = 0;
        transportClock.startedAtMs = null;
      } else {
        state.playing = false;
        resetTransportClock();
      }
      emitState();
      emitTransport(Date.now());
      respond(callback, { ok: true, playing: state.playing });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'transport:stop failed' });
    }
  });

  socket.on('transport:set-bpm', async (payload = {}, callback = () => {}) => {
    try {
      const nextBpm = normalizeTransportBpm(payload.bpm);
      if (nativeTransportActive) {
        await requestNativeTransport('transport.set_bpm', { bpm: nextBpm });
      } else {
        state.project.bpm = nextBpm;
        restartTransportClock();
      }
      emitState();
      emitTransport(Date.now());
      respond(callback, { ok: true, bpm: state.project.bpm });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'transport:set-bpm failed' });
    }
  });

  socket.on('transport:seek', async (payload = {}, callback = () => {}) => {
    try {
      const positionBarsRaw = Number(payload.positionBars ?? payload.position_bars);
      const positionBeatsRaw = Number(payload.positionBeats ?? payload.position_beats);
      if (!Number.isFinite(positionBarsRaw) && !Number.isFinite(positionBeatsRaw)) {
        respond(callback, { ok: false, error: 'positionBars or positionBeats must be numeric' });
        return;
      }

      const nextPositionBeats = Number.isFinite(positionBeatsRaw)
        ? Math.max(0, positionBeatsRaw)
        : Math.max(0, positionBarsRaw * BEATS_PER_BAR);

      if (nativeTransportActive) {
        await requestNativeTransport('transport.seek', { position_beats: nextPositionBeats });
      } else {
        transportClock.offsetBeats = nextPositionBeats;
        transportClock.startedAtMs = state.playing ? Date.now() : null;
        updateTransportSnapshot(Date.now());
      }

      emitState();
      emitTransport(Date.now());
      respond(callback, {
        ok: true,
        playing: state.playing,
        positionBars: Number((nextPositionBeats / BEATS_PER_BAR).toFixed(6)),
        positionBeats: Number(nextPositionBeats.toFixed(6)),
      });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'transport:seek failed' });
    }
  });

  socket.on('track:set-volume', (payload = {}, callback = () => {}) => {
    const trackId = Number(payload.trackId ?? payload.track_id);
    const volume = Number(payload.volume);
    if (!Number.isFinite(trackId) || !Number.isFinite(volume)) {
      respond(callback, { ok: false, error: 'trackId and volume must be numbers' });
      return;
    }

    const clampedVolume = Math.max(0, Math.min(1.2, volume));
    const existing = getOrCreateMixerEntry(trackId);
    existing.volume = clampedVolume;

    emitState();
    respond(callback, { ok: true, trackId, volume: clampedVolume });
  });

  socket.on('track:set-pan', (payload = {}, callback = () => {}) => {
    const trackId = Number(payload.trackId ?? payload.track_id);
    const pan = Number(payload.pan);
    if (!Number.isFinite(trackId) || !Number.isFinite(pan)) {
      respond(callback, { ok: false, error: 'trackId and pan must be numbers' });
      return;
    }

    const clampedPan = Math.max(-1, Math.min(1, pan));
    const entry = getOrCreateMixerEntry(trackId);
    entry.pan = clampedPan;

    emitState();
    respond(callback, { ok: true, trackId, pan: clampedPan });
  });

  socket.on('track:set-mute', (payload = {}, callback = () => {}) => {
    const trackId = Number(payload.trackId ?? payload.track_id);
    if (!Number.isFinite(trackId)) {
      respond(callback, { ok: false, error: 'trackId must be numeric' });
      return;
    }

    const muted = normalizeBool(payload.mute);
    const entry = getOrCreateMixerEntry(trackId);
    entry.mute = muted;

    emitState();
    respond(callback, { ok: true, trackId, mute: muted });
  });

  socket.on('track:set-solo', (payload = {}, callback = () => {}) => {
    const trackId = Number(payload.trackId ?? payload.track_id);
    if (!Number.isFinite(trackId)) {
      respond(callback, { ok: false, error: 'trackId must be numeric' });
      return;
    }

    const solo = normalizeBool(payload.solo);
    const entry = getOrCreateMixerEntry(trackId);
    entry.solo = solo;

    emitState();
    respond(callback, { ok: true, trackId, solo });
  });

  socket.on('track:set-record-arm', (payload = {}, callback = () => {}) => {
    const trackId = Number(payload.trackId ?? payload.track_id);
    if (!Number.isFinite(trackId)) {
      respond(callback, { ok: false, error: 'trackId must be numeric' });
      return;
    }

    const recordArmed = normalizeBool(payload.recordArmed ?? payload.record_armed);
    const entry = getOrCreateMixerEntry(trackId);
    entry.record_armed = recordArmed;

    emitState();
    respond(callback, { ok: true, trackId, record_armed: recordArmed });
  });

  socket.on('track:create', (payload = {}, callback = () => {}) => {
    ensureProjectArrays();
    const existingIds = new Set(state.project.playlist.map((track) => Number(track.track_id)).filter((trackId) => Number.isInteger(trackId) && trackId > 0));
    const requestedTrackId = Number(payload.trackId ?? payload.track_id);
    const nextId = Number.isInteger(requestedTrackId) && requestedTrackId > 0 && !existingIds.has(requestedTrackId)
      ? requestedTrackId
      : (state.project.playlist || []).reduce((maxId, track) => Math.max(maxId, Number(track.track_id) || 0), 0) + 1;
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : `Track ${nextId}`;
    const chainCollapsed = normalizeBool(payload.chainCollapsed ?? payload.chain_collapsed, true);

    const nextTrack = createDefaultTrackEntry(nextId, name);
    nextTrack.chain_collapsed = chainCollapsed;
    state.project.playlist.push(nextTrack);
    const mixerEntry = state.project.mixer.find((entry) => entry.track_id === nextId);
    if (!mixerEntry) {
      state.project.mixer.push(createDefaultMixerEntry(nextId));
    }
    sortProjectTrackCollections();

    emitState();
    respond(callback, { ok: true, trackId: nextId });
  });

  socket.on('track:insert', async (payload = {}, callback = () => {}) => {
    try {
      ensureProjectArrays();
      const highestTrackId = state.project.playlist.reduce((maxId, track) => {
        const trackId = Number(track?.track_id);
        return Number.isInteger(trackId) && trackId > maxId ? trackId : maxId;
      }, 0);
      const afterTrackIdRaw = Number(payload.afterTrackId ?? payload.after_track_id ?? payload.trackId ?? payload.track_id ?? highestTrackId);
      const afterTrackId = Number.isInteger(afterTrackIdRaw) && afterTrackIdRaw >= 0
        ? clamp(afterTrackIdRaw, 0, highestTrackId)
        : highestTrackId;
      const insertAtTrackId = afterTrackId + 1;

      shiftTrackIdsForInsert(insertAtTrackId);
      state.project.playlist.push(createDefaultTrackEntry(insertAtTrackId));
      state.project.mixer.push(createDefaultMixerEntry(insertAtTrackId));
      sortProjectTrackCollections();
      normalizeAllVstPluginIndexes();

      const nativeSync = await safeRestoreNativeNodesAfterTrackLayoutChange();

      emitState();
      respond(callback, {
        ok: true,
        trackId: insertAtTrackId,
        nativeSync,
      });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'track:insert failed' });
    }
  });

  socket.on('track:reorder', (payload = {}, callback = () => {}) => {
    try {
      const trackId = Number(payload.trackId ?? payload.track_id);
      const toIndexRaw = payload.toIndex ?? payload.to_index ?? payload.index;
      const toIndex = Number.isInteger(toIndexRaw) ? Math.max(0, toIndexRaw) : -1;
      if (!Number.isInteger(trackId) || trackId <= 0 || toIndex < 0) {
        respond(callback, { ok: false, error: 'trackId and toIndex (0-based) are required' });
        return;
      }
      reorderTrackInPlaylist(trackId, toIndex);
      emitState();
      respond(callback, { ok: true, trackId, toIndex });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'track:reorder failed' });
    }
  });

  socket.on('track:delete', async (payload = {}, callback = () => {}) => {
    try {
      ensureProjectArrays();
      const trackIdRaw = Number(payload.trackId ?? payload.track_id);
      if (!Number.isInteger(trackIdRaw) || trackIdRaw <= 0) {
        respond(callback, { ok: false, error: 'trackId must be a positive integer' });
        return;
      }

      const hadTrack = state.project.playlist.some((track) => Number(track?.track_id) === trackIdRaw);
      if (!hadTrack) {
        respond(callback, { ok: false, error: `track "${trackIdRaw}" not found` });
        return;
      }

      reindexTracksRemovingIds([trackIdRaw]);
      const nativeSync = await safeRestoreNativeNodesAfterTrackLayoutChange();

      emitState();
      respond(callback, {
        ok: true,
        deletedTrackIds: [trackIdRaw],
        nativeSync,
      });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'track:delete failed' });
    }
  });

  socket.on('track:bulk-delete', async (payload = {}, callback = () => {}) => {
    try {
      ensureProjectArrays();
      const trackIds = normalizeTrackIdList(payload.trackIds ?? payload.track_ids);
      if (trackIds.length === 0) {
        respond(callback, { ok: false, error: 'trackIds must contain at least one positive integer' });
        return;
      }

      const existingTrackIds = new Set(
        state.project.playlist
          .map((track) => Number(track?.track_id))
          .filter((trackId) => Number.isInteger(trackId) && trackId > 0),
      );
      const existingRequestedTrackIds = trackIds.filter((trackId) => existingTrackIds.has(trackId));
      if (existingRequestedTrackIds.length === 0) {
        respond(callback, { ok: false, error: 'none of the requested trackIds exist' });
        return;
      }

      reindexTracksRemovingIds(existingRequestedTrackIds);
      const nativeSync = await safeRestoreNativeNodesAfterTrackLayoutChange();

      emitState();
      respond(callback, {
        ok: true,
        deletedTrackIds: existingRequestedTrackIds,
        nativeSync,
      });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'track:bulk-delete failed' });
    }
  });

  socket.on('track:duplicate', async (payload = {}, callback = () => {}) => {
    try {
      ensureProjectArrays();
      const sourceTrackId = Number(payload.trackId ?? payload.track_id);
      if (!Number.isInteger(sourceTrackId) || sourceTrackId <= 0) {
        respond(callback, { ok: false, error: 'trackId must be a positive integer' });
        return;
      }

      const sourceTrack = state.project.playlist.find((track) => Number(track?.track_id) === sourceTrackId);
      if (!sourceTrack) {
        respond(callback, { ok: false, error: `track "${sourceTrackId}" not found` });
        return;
      }

      const sourceMixerEntry = state.project.mixer.find((entry) => Number(entry?.track_id) === sourceTrackId);
      const sourceNodes = state.project.nodes.filter((node) => Number(node?.track_id ?? node?.trackId) === sourceTrackId);
      const duplicateTrackId = sourceTrackId + 1;

      shiftTrackIdsForInsert(duplicateTrackId);

      const duplicateName = isNonEmptyString(sourceTrack.name)
        ? `${sourceTrack.name.trim().slice(0, Math.max(0, TRACK_NAME_LIMIT - 7))} (Copy)`
        : `Track ${duplicateTrackId} (Copy)`;
      state.project.playlist.push({
        ...createDefaultTrackEntry(duplicateTrackId, duplicateName),
        chain_collapsed: normalizeBool(sourceTrack.chain_collapsed, true),
        chain_enabled: normalizeBool(sourceTrack.chain_enabled, true),
        clips: cloneTrackClips(sourceTrack.clips),
      });

      const normalizedSourceMixer = sourceMixerEntry
        ? {
          ...sourceMixerEntry,
          track_id: duplicateTrackId,
          volume: Number.isFinite(Number(sourceMixerEntry.volume)) ? Number(sourceMixerEntry.volume) : 0.85,
          pan: Number.isFinite(Number(sourceMixerEntry.pan)) ? Number(sourceMixerEntry.pan) : 0,
          mute: normalizeBool(sourceMixerEntry.mute),
          solo: normalizeBool(sourceMixerEntry.solo),
          record_armed: normalizeBool(sourceMixerEntry.record_armed),
        }
        : createDefaultMixerEntry(duplicateTrackId);
      state.project.mixer.push(normalizedSourceMixer);

      for (const sourceNode of sourceNodes) {
        const clonedNode = cloneNodeForTrack(sourceNode, duplicateTrackId);
        if (clonedNode) {
          state.project.nodes.push(clonedNode);
        }
      }

      sortProjectTrackCollections();
      normalizeAllVstPluginIndexes();
      const nativeSync = await safeRestoreNativeNodesAfterTrackLayoutChange();

      emitState();
      respond(callback, {
        ok: true,
        sourceTrackId,
        trackId: duplicateTrackId,
        nativeSync,
      });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'track:duplicate failed' });
    }
  });

  socket.on('track:set-name', async (payload = {}, callback = () => {}) => {
    const trackId = Number(payload.trackId ?? payload.track_id);
    const providedName = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!Number.isInteger(trackId) || trackId <= 0) {
      respond(callback, { ok: false, error: 'trackId must be a positive integer' });
      return;
    }

    state.project.playlist = Array.isArray(state.project.playlist) ? state.project.playlist : [];
    const track = state.project.playlist.find((entry) => Number(entry.track_id) === trackId);
    if (!track) {
      respond(callback, { ok: false, error: `track "${trackId}" not found` });
      return;
    }

    track.name = (providedName || `Track ${trackId}`).slice(0, TRACK_NAME_LIMIT);

    try {
      state.project = await saveProject(state.selectedProjectFile, state.project);
    } catch (error) {
      emitState();
      respond(callback, {
        ok: false,
        error: `track renamed but save failed: ${error instanceof Error ? error.message : 'unknown save error'}`,
      });
      return;
    }

    emitState();
    respond(callback, { ok: true, trackId, name: track.name });
  });

  socket.on('track:set-chain-collapsed', (payload = {}, callback = () => {}) => {
    const trackId = Number(payload.trackId ?? payload.track_id);
    if (!Number.isInteger(trackId) || trackId <= 0) {
      respond(callback, { ok: false, error: 'trackId must be a positive integer' });
      return;
    }

    state.project.playlist = Array.isArray(state.project.playlist) ? state.project.playlist : [];
    const track = state.project.playlist.find((entry) => Number(entry.track_id) === trackId);
    if (!track) {
      respond(callback, { ok: false, error: `track "${trackId}" not found` });
      return;
    }

    track.chain_collapsed = normalizeBool(payload.collapsed ?? payload.chain_collapsed, true);
    emitState();
    respond(callback, { ok: true, trackId, chain_collapsed: track.chain_collapsed });
  });

  socket.on('track:set-chain-enabled', (payload = {}, callback = () => {}) => {
    ensureProjectArrays();
    const trackId = Number(payload.trackId ?? payload.track_id);
    if (!Number.isInteger(trackId) || trackId <= 0) {
      respond(callback, { ok: false, error: 'trackId is required' });
      return;
    }
    const track = state.project.playlist.find((entry) => Number(entry.track_id) === trackId);
    if (!track) {
      respond(callback, { ok: false, error: `track "${trackId}" not found` });
      return;
    }
    const enabled = normalizeBool(payload.enabled ?? payload.chain_enabled, true);
    track.chain_enabled = enabled;
    const vstNodesOnTrack = (state.project.nodes || []).filter(
      (node) => isVstInstrumentNode(node) && Number(node?.track_id ?? node?.trackId) === trackId,
    );
    for (const node of vstNodesOnTrack) {
      node.bypassed = !enabled;
    }
    emitState();
    respond(callback, { ok: true, trackId, chain_enabled: track.chain_enabled });
  });

  socket.on('project:update-view', (payload = {}, callback = () => {}) => {
    const nextBarsRaw = Number(payload.playlistViewBars ?? payload.playlist_view_bars);
    const nextBarWidthRaw = Number(payload.playlistBarWidth ?? payload.playlist_bar_width);
    const hasShowTrackNodes = Object.prototype.hasOwnProperty.call(payload, 'playlistShowTrackNodes')
      || Object.prototype.hasOwnProperty.call(payload, 'playlist_show_track_nodes');
    if (!Number.isFinite(nextBarsRaw) && !Number.isFinite(nextBarWidthRaw) && !hasShowTrackNodes) {
      respond(callback, { ok: false, error: 'playlistViewBars, playlistBarWidth, or playlistShowTrackNodes must be provided' });
      return;
    }

    if (Number.isFinite(nextBarsRaw)) {
      state.project.playlist_view_bars = Math.round(clamp(nextBarsRaw, MIN_PLAYLIST_VIEW_BARS, MAX_PLAYLIST_VIEW_BARS));
    } else if (!Number.isFinite(state.project.playlist_view_bars)) {
      state.project.playlist_view_bars = DEFAULT_PLAYLIST_VIEW_BARS;
    }

    if (Number.isFinite(nextBarWidthRaw)) {
      state.project.playlist_bar_width = Number(clamp(nextBarWidthRaw, MIN_PLAYLIST_BAR_WIDTH, MAX_PLAYLIST_BAR_WIDTH).toFixed(3));
    } else if (!Number.isFinite(state.project.playlist_bar_width)) {
      state.project.playlist_bar_width = DEFAULT_PLAYLIST_BAR_WIDTH;
    }

    if (hasShowTrackNodes) {
      state.project.playlist_show_track_nodes = normalizeBool(payload.playlistShowTrackNodes ?? payload.playlist_show_track_nodes);
    } else if (typeof state.project.playlist_show_track_nodes !== 'boolean') {
      state.project.playlist_show_track_nodes = DEFAULT_PLAYLIST_SHOW_TRACK_NODES;
    }

    emitState();
    respond(callback, {
      ok: true,
      playlist_view_bars: state.project.playlist_view_bars,
      playlist_bar_width: state.project.playlist_bar_width,
      playlist_show_track_nodes: state.project.playlist_show_track_nodes,
    });
  });

  socket.on('vst:scan', async (_payload = {}, callback = () => {}) => {
    try {
      if (!nativeTransportActive) {
        respond(callback, { ok: false, error: 'native transport is not active' });
        return;
      }

      const response = await requestNativeTransport('vst:scan');
      const plugins = Array.isArray(response.plugins) ? response.plugins : [];
      respond(callback, { ok: true, plugins });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'vst:scan failed' });
    }
  });

  socket.on('vst:add', async (payload = {}, callback = () => {}) => {
    try {
      const pluginUid = typeof payload.plugin_uid === 'string' && payload.plugin_uid.trim()
        ? payload.plugin_uid.trim()
        : (typeof payload.pluginUid === 'string' && payload.pluginUid.trim()
          ? payload.pluginUid.trim()
          : (typeof payload.plugin === 'string' && payload.plugin.trim() ? payload.plugin.trim() : 'ultrasound'));
      const trackIdRaw = Number(payload.track_id ?? payload.trackId ?? 1);
      const trackId = Number.isInteger(trackIdRaw) && trackIdRaw > 0 ? trackIdRaw : 1;
      const insertIndexRaw = Number(payload.insert_index ?? payload.insertIndex);
      const requestedInsertIndex = Number.isInteger(insertIndexRaw) && insertIndexRaw >= 0 ? insertIndexRaw : null;
      const id = makeId('vst');

      let loadedPlugin = null;
      if (nativeTransportActive) {
        const response = await requestNativeTransport('vst:load', {
          plugin_uid: pluginUid,
          track_id: trackId,
        });
        loadedPlugin = response.plugin || null;
      }

      const pluginName = typeof loadedPlugin?.name === 'string' && loadedPlugin.name
        ? loadedPlugin.name
        : pluginUid;
      const parameterSchema = normalizePluginParameters(loadedPlugin?.parameters);
      const params = {};
      for (const parameter of parameterSchema) {
        if (Number.isFinite(Number(parameter.value))) {
          params[parameter.id] = Number(parameter.value);
        }
      }

      const resolvedTrackId = Number(loadedPlugin?.trackId ?? trackId);
      const trackNodeEntriesBeforeInsert = getSortedVstNodeEntriesForTrack(resolvedTrackId);
      const fallbackPluginIndex = trackNodeEntriesBeforeInsert.length;
      const loadedPluginIndexRaw = Number(loadedPlugin?.pluginIndex);
      const initialPluginIndex = Number.isInteger(loadedPluginIndexRaw) && loadedPluginIndexRaw >= 0
        ? loadedPluginIndexRaw
        : fallbackPluginIndex;

      state.project.nodes = state.project.nodes || [];
      state.project.nodes.push({
        id,
        type: 'vst_instrument',
        plugin: pluginName,
        plugin_uid: loadedPlugin?.uid || pluginUid,
        track_id: resolvedTrackId,
        plugin_index: initialPluginIndex,
        bypassed: normalizeBool(payload.bypassed, false),
        parameter_schema: parameterSchema,
        params,
      });

      normalizeVstPluginIndexesForTrack(resolvedTrackId);
      let nativeSync = null;

      if (requestedInsertIndex !== null) {
        const orderedEntries = getSortedVstNodeEntriesForTrack(resolvedTrackId);
        const orderedNodes = orderedEntries.map((entry) => entry.node);
        const sourceIndex = orderedNodes.findIndex((node) => node?.id === id);
        const targetIndex = clamp(requestedInsertIndex, 0, Math.max(0, orderedNodes.length - 1));
        if (sourceIndex >= 0 && sourceIndex !== targetIndex) {
          const [movedNode] = orderedNodes.splice(sourceIndex, 1);
          orderedNodes.splice(targetIndex, 0, movedNode);
          orderedNodes.forEach((node, index) => {
            node.plugin_index = index;
          });
          if (nativeTransportActive) {
            nativeSync = await safeRestoreNativeNodesAfterTrackLayoutChange();
          }
        }
      }

      normalizeAllVstPluginIndexes();
      emitState();
      respond(callback, {
        ok: true,
        nodeId: id,
        trackId: resolvedTrackId,
        plugin: loadedPlugin,
        nativeSync,
      });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'vst:add failed' });
    }
  });

  socket.on('vst:remove', async (payload = {}, callback = () => {}) => {
    try {
      ensureProjectArrays();
      const nodeId = isNonEmptyString(payload.node_id)
        ? payload.node_id.trim()
        : (isNonEmptyString(payload.nodeId) ? payload.nodeId.trim() : '');

      let nodeIndex = -1;
      let node = null;
      if (nodeId) {
        nodeIndex = state.project.nodes.findIndex((entry) => entry?.id === nodeId && isVstInstrumentNode(entry));
        if (nodeIndex >= 0) {
          node = state.project.nodes[nodeIndex];
        }
      } else {
        const trackId = Number(payload.track_id ?? payload.trackId);
        const pluginIndex = Number(payload.plugin_index ?? payload.pluginIndex);
        if (!Number.isInteger(trackId) || trackId <= 0 || !Number.isInteger(pluginIndex) || pluginIndex < 0) {
          respond(callback, { ok: false, error: 'nodeId or (track_id + plugin_index) is required' });
          return;
        }
        const entries = getSortedVstNodeEntriesForTrack(trackId);
        node = entries[pluginIndex]?.node || null;
        if (node) {
          nodeIndex = state.project.nodes.findIndex((entry) => entry?.id === node.id);
        }
      }

      if (!node || nodeIndex < 0) {
        respond(callback, { ok: false, error: 'vst node not found' });
        return;
      }

      const trackId = resolveVstNodeTrackId(node);
      const removedNodeId = node.id;
      state.project.nodes.splice(nodeIndex, 1);
      normalizeVstPluginIndexesForTrack(trackId);

      let nativeSync = null;
      if (nativeTransportActive) {
        nativeSync = await safeRestoreNativeNodesAfterTrackLayoutChange();
      }

      emitState();
      respond(callback, {
        ok: true,
        nodeId: removedNodeId,
        trackId,
        nativeSync,
      });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'vst:remove failed' });
    }
  });

  socket.on('vst:reorder', async (payload = {}, callback = () => {}) => {
    try {
      ensureProjectArrays();
      const trackId = Number(payload.track_id ?? payload.trackId);
      const fromIndexRaw = Number(payload.from_index ?? payload.fromIndex);
      const toIndexRaw = Number(payload.to_index ?? payload.toIndex);
      if (!Number.isInteger(trackId) || trackId <= 0 || !Number.isInteger(fromIndexRaw) || fromIndexRaw < 0 || !Number.isInteger(toIndexRaw) || toIndexRaw < 0) {
        respond(callback, { ok: false, error: 'track_id, from_index and to_index are required' });
        return;
      }

      const entries = getSortedVstNodeEntriesForTrack(trackId);
      if (entries.length < 2) {
        respond(callback, { ok: true, trackId, changed: false });
        return;
      }

      const sourceIndex = clamp(fromIndexRaw, 0, entries.length - 1);
      const targetIndex = clamp(toIndexRaw, 0, entries.length - 1);
      if (sourceIndex === targetIndex) {
        respond(callback, { ok: true, trackId, changed: false });
        return;
      }

      const orderedNodes = entries.map((entry) => entry.node);
      const [movedNode] = orderedNodes.splice(sourceIndex, 1);
      orderedNodes.splice(targetIndex, 0, movedNode);
      orderedNodes.forEach((node, index) => {
        node.plugin_index = index;
      });

      let nativeSync = null;
      if (nativeTransportActive) {
        nativeSync = await safeRestoreNativeNodesAfterTrackLayoutChange();
      }

      emitState();
      respond(callback, {
        ok: true,
        trackId,
        changed: true,
        nativeSync,
      });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'vst:reorder failed' });
    }
  });

  socket.on('vst:bypass:set', (payload = {}, callback = () => {}) => {
    ensureProjectArrays();
    const nodeId = isNonEmptyString(payload.node_id)
      ? payload.node_id.trim()
      : (isNonEmptyString(payload.nodeId) ? payload.nodeId.trim() : '');

    let node = null;
    if (nodeId) {
      node = state.project.nodes.find((entry) => entry?.id === nodeId && isVstInstrumentNode(entry)) || null;
    } else {
      const trackId = Number(payload.track_id ?? payload.trackId);
      const pluginIndex = Number(payload.plugin_index ?? payload.pluginIndex);
      if (!Number.isInteger(trackId) || trackId <= 0 || !Number.isInteger(pluginIndex) || pluginIndex < 0) {
        respond(callback, { ok: false, error: 'nodeId or (track_id + plugin_index) is required' });
        return;
      }
      const entries = getSortedVstNodeEntriesForTrack(trackId);
      node = entries[pluginIndex]?.node || null;
    }

    if (!node) {
      respond(callback, { ok: false, error: 'vst node not found' });
      return;
    }

    node.bypassed = normalizeBool(payload.bypassed ?? payload.bypass, false);
    emitState();
    respond(callback, {
      ok: true,
      nodeId: node.id,
      bypassed: node.bypassed,
      trackId: resolveVstNodeTrackId(node),
      pluginIndex: resolveVstNodePluginIndex(node, 0),
    });
  });

  socket.on('vst:param:set', async (payload = {}, callback = () => {}) => {
    try {
      if (!nativeTransportActive) {
        respond(callback, { ok: false, error: 'native transport is not active' });
        return;
      }

      const trackIdRaw = Number(payload.track_id ?? payload.trackId);
      const pluginIndexRaw = Number(payload.plugin_index ?? payload.pluginIndex);
      const valueRaw = Number(payload.value);
      const paramId = typeof payload.param_id === 'string' && payload.param_id.trim()
        ? payload.param_id.trim()
        : (typeof payload.paramId === 'string' && payload.paramId.trim() ? payload.paramId.trim() : '');

      if (!Number.isInteger(trackIdRaw) || trackIdRaw <= 0 || !Number.isInteger(pluginIndexRaw) || pluginIndexRaw < 0 || !Number.isFinite(valueRaw) || !paramId) {
        respond(callback, { ok: false, error: 'track_id, plugin_index, param_id and value are required' });
        return;
      }

      const response = await requestNativeTransport('vst:param:set', {
        track_id: trackIdRaw,
        plugin_index: pluginIndexRaw,
        param_id: paramId,
        value: valueRaw,
      });

      const nodeId = typeof payload.node_id === 'string' && payload.node_id.trim()
        ? payload.node_id.trim()
        : (typeof payload.nodeId === 'string' && payload.nodeId.trim() ? payload.nodeId.trim() : null);

      if (nodeId) {
        const node = (state.project.nodes || []).find((entry) => entry.id === nodeId);
        if (node) {
          node.params = node.params || {};
          const appliedValue = Number(response?.parameter?.value ?? valueRaw);
          node.params[paramId] = Number.isFinite(appliedValue) ? appliedValue : valueRaw;
          if (Array.isArray(node.parameter_schema)) {
            const schemaEntry = node.parameter_schema.find((entry) => entry?.id === paramId);
            if (schemaEntry && Number.isFinite(appliedValue)) {
              schemaEntry.value = appliedValue;
            }
          }
        }
      }

      emitState();
      respond(callback, { ok: true, parameter: response.parameter || null });
    } catch (error) {
      respond(callback, { ok: false, error: error instanceof Error ? error.message : 'vst:param:set failed' });
    }
  });

  socket.on('project:load', async (payload = {}, callback = () => {}) => {
    try {
      const filename = typeof payload.filename === 'string' && payload.filename.trim() ? payload.filename.trim() : 'welcome.stu';
      const filePath = path.join(projectsDir, filename.endsWith('.stu') ? filename : `${filename}.stu`);
      const raw = await fs.readFile(filePath, 'utf8');

      state.project = parseProject(raw);
      normalizeAllVstPluginIndexes();
      state.selectedProjectFile = filePath;
      let restoreResult = { restored: 0, failed: 0, errors: [] };
      if (nativeTransportActive) {
        await requestNativeTransport('transport.stop');
        await requestNativeTransport('transport.set_bpm', { bpm: state.project.bpm });
        restoreResult = await restoreNativeVstNodes({ resetEdit: true });
        if (restoreResult.failed > 0 || restoreResult.errors.length > 0) {
          console.warn('[thestuu-engine] project:load native VST restore issues:', restoreResult.errors.join(' | '));
        }
      } else {
        state.playing = false;
        resetTransportClock();
      }
      emitState();
      emitTransport(Date.now());
      callback({
        ok: true,
        filePath,
        restoredPlugins: restoreResult.restored,
        failedPlugins: restoreResult.failed,
        restoreErrors: restoreResult.errors,
      });
    } catch (error) {
      callback({ ok: false, error: error instanceof Error ? error.message : 'Unknown load error' });
    }
  });

  socket.on('project:save', async (payload = {}, callback = () => {}) => {
    try {
      const filename = typeof payload.filename === 'string' && payload.filename.trim() ? payload.filename.trim() : path.basename(state.selectedProjectFile);
      const filePath = path.join(projectsDir, filename.endsWith('.stu') ? filename : `${filename}.stu`);
      const projectData = payload.project || state.project;

      const normalizedProject = await saveProject(filePath, projectData);
      state.selectedProjectFile = filePath;
      state.project = normalizedProject;
      if (nativeTransportActive) {
        await requestNativeTransport('transport.set_bpm', { bpm: state.project.bpm });
      }

      emitState();
      callback({ ok: true, filePath });
    } catch (error) {
      callback({ ok: false, error: error instanceof Error ? error.message : 'Unknown save error' });
    }
  });

  bindMutation(socket, 'pattern:create', createPattern);
  bindMutation(socket, 'pattern:update-step', updatePatternStep);
  bindMutation(socket, 'pattern:update', updatePatternMeta);
  bindMutation(socket, 'pattern:delete', deletePattern);

  bindMutation(socket, 'clip:create', createClip);
  bindMutation(socket, 'clip:import-file', importClipFile);
  bindMutation(socket, 'track:import-file', importClipFile);
  bindMutation(socket, 'clip:move', moveClip);
  bindMutation(socket, 'clip:resize', resizeClip);
  bindMutation(socket, 'clip:delete', deleteClip);

  bindMutation(socket, 'move_midi_note', moveMidiNote);
  bindMutation(socket, 'pattern:move-midi-note', moveMidiNote);

  bindMutation(socket, 'create_pattern', createPattern);
  bindMutation(socket, 'update_pattern_step', updatePatternStep);
  bindMutation(socket, 'update_pattern', updatePatternMeta);
  bindMutation(socket, 'delete_pattern', deletePattern);
  bindMutation(socket, 'create_clip', createClip);
  bindMutation(socket, 'import_clip_file', importClipFile);
  bindMutation(socket, 'move_clip', moveClip);
  bindMutation(socket, 'resize_clip', resizeClip);
  bindMutation(socket, 'delete_clip', deleteClip);
});

const engineTickTimer = setInterval(() => {
  const now = Date.now();
  emitTransport(now);

  const playlist = state.project.playlist || [];
  const meters = playlist.map((track) => {
    if (nativeTransportActive) {
      return { trackId: track.track_id, peak: 0, rms: 0 };
    }
    return {
      trackId: track.track_id,
      peak: state.playing ? Math.random() * 0.95 : Math.random() * 0.05,
      rms: state.playing ? Math.random() * 0.75 : Math.random() * 0.03,
    };
  });

  io.emit('engine:meter', {
    playing: state.playing,
    timestamp: now,
    meters,
  });
}, 120);

async function boot() {
  await ensureProjectFile();
  await startNativeTransportBridge();
  if (!nativeTransportActive) {
    updateTransportSnapshot(Date.now());
  }

  httpServer.listen(enginePort, engineHost, () => {
    console.log(`[thestuu-engine] listening on ${engineHost}:${enginePort}`);
    console.log(`[thestuu-engine] home: ${stuuHome}`);
    if (nativeTransportEnabled) {
      console.log(`[thestuu-engine] native transport: ${nativeTransportActive ? 'online' : 'offline'} (${nativeSocketPath})`);
    }
  });
}

function shutdown(signal) {
  console.log(`[thestuu-engine] received ${signal}, shutting down...`);
  clearInterval(engineTickTimer);
  nativeTransportClient?.stop();
  io.close(() => {
    httpServer.close(() => {
      process.exit(0);
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

boot().catch((error) => {
  console.error('[thestuu-engine] boot failed:', error);
  process.exit(1);
});
