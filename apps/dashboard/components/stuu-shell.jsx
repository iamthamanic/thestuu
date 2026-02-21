'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import ReactFlow, { Background, Controls, MiniMap } from 'reactflow';
import {
  Check,
  ChevronRight,
  Circle,
  Download,
  ExternalLink,
  LayoutGrid,
  MousePointer2,
  MoveHorizontal,
  PaintBucket,
  Pause,
  Pencil,
  Play,
  Plug,
  Power,
  Scissors,
  Square,
  Trash2,
  VolumeX,
  ZoomIn,
} from 'lucide-react';
import 'reactflow/dist/style.css';
import { createEngineSocket } from '../lib/socket';

const TABS = ['Edit', 'Mix'];
const DAW_MENU_ITEMS = ['FILE', 'EDIT', 'ADD', 'PATTERNS', 'VIEW', 'OPTIONS', 'TOOLS', 'HELP'];
const DEFAULT_BAR_WIDTH = 92;
const MIN_BAR_WIDTH = 36;
const MAX_BAR_WIDTH = 220;
const DEFAULT_VIEW_BARS = 32;
const MIN_VISIBLE_BARS = 8;
const MAX_TIMELINE_BARS = 4096;
const VIEW_EXTEND_STEP_BARS = 32;
const VIEW_EXTEND_TRIGGER_RATIO = 0.9;
const PLAYHEAD_EXTEND_MARGIN_BARS = 4;
const PLAYHEAD_SCRUB_EDGE_PX = 24;
const PLAYHEAD_SCRUB_SCROLL_PX = 24;
const GRID_STEP = 1 / 16;
const MIN_VOLUME_DB = -80;
const MAX_VOLUME_DB = Number((20 * Math.log10(1.2)).toFixed(1));
const MIN_VISIBLE_TRACKS = 1;
const TRACK_NAME_LIMIT = 25;
const TRACK_CHAIN_VISIBLE_SLOTS = 7;
const TRACK_CHAIN_MODAL_MIN_SLOTS = 8;
const TRACK_CHAIN_PLUGIN_NAME_LIMIT = 14;
const MIXER_INSPECTOR_SLOT_COUNT = 10;
const DEFAULT_WAVEFORM_SAMPLE_COUNT = 1024;
const MIN_WAVEFORM_SAMPLE_COUNT = 24;
const MAX_WAVEFORM_SAMPLE_COUNT = 2048;
/** Placeholder peaks when analysis fails so audio clips still show a wave shape */
const PLACEHOLDER_WAVEFORM_PEAKS = (() => {
  const n = 64;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = (i / (n - 1)) * Math.PI * 4;
    out.push(0.25 + 0.22 * Math.sin(t) + 0.08 * Math.sin(t * 3));
  }
  return out;
})();
const FALLBACK_VST_UID = 'internal:ultrasound';
const TRACK_ADD_MENU_ITEMS = [
  { id: 'record', label: 'Record' },
  { id: 'import', label: 'Import' },
  { id: 'pattern', label: 'Pattern' },
];
const IMPORTABLE_AUDIO_EXTENSIONS = new Set(['wav', 'flac', 'mp3', 'ogg', 'aac', 'aiff', 'aif']);
const IMPORTABLE_MIDI_EXTENSIONS = new Set(['mid', 'midi']);
const IMPORTABLE_EXTENSIONS = new Set([...IMPORTABLE_AUDIO_EXTENSIONS, ...IMPORTABLE_MIDI_EXTENSIONS]);
const IMPORT_FILE_ACCEPT = '.wav,.flac,.mp3,.ogg,.aac,.mid,.midi,.aiff,.aif';
const DEFAULT_IMPORTED_CLIP_LENGTH = 8;
const TIME_MARKER_INTERVAL_SECONDS = 10;
const TRACK_CONTEXT_MENU_ITEMS = [
  { id: 'rename', label: 'Umbenennen' },
  { id: 'duplicate', label: 'Duplizieren' },
  { id: 'delete', label: 'Loeschen' },
];
const DEFAULT_SNAP_MODE = 'auto';
const SNAP_MODE_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'line', label: 'Line' },
  { id: 'cell', label: 'Cell' },
  { id: 'half_beat', label: '1/2 Beat' },
  { id: 'beat', label: 'Beat' },
  { id: 'bar', label: 'Bar' },
];
const DEFAULT_TIME_SIGNATURE = { numerator: 4, denominator: 4 };
const EDIT_TOOL_OPTIONS = [
  { id: 'select', label: 'Select', description: 'waehlt Clips und Bereiche aus' },
  { id: 'draw', label: 'Draw', description: 'erstellt einen Clip an der Cursor-Position' },
  { id: 'paint', label: 'Paint', description: 'malt mehrere Clips beim Ziehen' },
  { id: 'delete', label: 'Delete', description: 'loescht Clips per Klick oder Bereich' },
  { id: 'mute', label: 'Mute', description: 'schaltet Clips stumm oder wieder laut' },
  { id: 'slice', label: 'Trim', description: 'schneidet Audio- und MIDI-Clips an der Position' },
  { id: 'slip', label: 'Slip', description: 'verschiebt den Inhalt im Clip ohne die Laenge zu aendern' },
  { id: 'zoom', label: 'Zoom', description: 'zoomt in einen aufgezogenen Bereich' },
];
const DEFAULT_EDIT_TOOL = 'draw';
const ENGINE_BASE_URL = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://127.0.0.1:3987';

function getEditToolTooltip(tool) {
  if (!tool) {
    return '';
  }
  return `${tool.label} (${tool.description})`;
}

const EDIT_TOOL_CURSORS = (() => {
  const makeCursor = (innerSvg, hotspotX, hotspotY, fallback = 'default') => {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20' fill='none' stroke='#f5f5f8' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>${innerSvg}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspotX} ${hotspotY}, ${fallback}`;
  };

  return {
    select: 'default',
    draw: makeCursor("<path d='M4 15l1.8-4.8 7-7 1.9 1.9-7 7z'/><path d='M12.6 4.4l2 2'/>", 2, 18, 'crosshair'),
    paint: makeCursor("<path d='M3.7 10.6c.2-3 2.2-5.1 5-5.6l2.7 2.7c-.5 2.8-2.6 4.8-5.6 5z'/><path d='M11.3 4.8l2.8-2.4 1.2 1.2-2.4 2.8'/>", 2, 18, 'copy'),
    delete: makeCursor("<circle cx='9' cy='9' r='6'/><path d='M5 13l8-8'/>", 9, 9, 'not-allowed'),
    mute: makeCursor("<path d='M3.4 7h2.3L8.4 4.6v8.8L5.7 11H3.4z'/><path d='M14.8 4.8L6 13.6'/>", 9, 9, 'pointer'),
    slice: makeCursor("<circle cx='5' cy='5' r='2.5'/><path d='M6.77 6.77L10 10'/><path d='M16.67 3.33L6.77 13.23'/><circle cx='5' cy='15' r='2.5'/><path d='M12.33 12.33L16.67 16.67'/>", 2, 18, 'crosshair'),
    slip: makeCursor("<path d='M3.6 10h12.8'/><path d='M6.8 6.8L3.6 10l3.2 3.2'/><path d='M13.2 6.8l3.2 3.2-3.2 3.2'/>", 10, 10, 'ew-resize'),
    zoom: makeCursor("<circle cx='8.2' cy='8.2' r='4.4'/><path d='M11.6 11.6l4 4'/>", 8, 8, 'zoom-in'),
  };
})();

function getEditToolCursor(toolId) {
  return EDIT_TOOL_CURSORS[toolId] || 'default';
}

const DEFAULT_CHAT_MESSAGES = [
  { role: 'system', text: 'TheStuu AI bereit. Beispiel: "Baue einen Trap-Beat mit 140 BPM."' },
];

const FALLBACK_STATE = {
  playing: false,
  transport: {
    bar: 1,
    beat: 1,
    step: 1,
    stepIndex: 0,
    positionBars: 0,
    positionBeats: 0,
  },
  project: {
    project_name: 'Welcome to TheStuu',
    bpm: 128,
    time_signature: DEFAULT_TIME_SIGNATURE,
    playlist_view_bars: DEFAULT_VIEW_BARS,
    playlist_bar_width: DEFAULT_BAR_WIDTH,
    playlist_show_track_nodes: true,
    nodes: [],
    patterns: [],
    playlist: [],
    mixer: [],
  },
  selectedProjectFile: 'welcome.stu',
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function snapToGrid(value, grid = GRID_STEP) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Number((Math.round(value / grid) * grid).toFixed(6));
}

/** Bars <-> time (project start 0:00). BPM = quarter notes/min. time_signature: { numerator, denominator } (e.g. 4/4, 6/8). */
function barsToSeconds(bars, bpm, timeSignature = DEFAULT_TIME_SIGNATURE) {
  if (!Number.isFinite(bars) || !Number.isFinite(bpm) || bpm <= 0) return 0;
  const num = Number(timeSignature?.numerator) || 4;
  const denom = Number(timeSignature?.denominator) || 4;
  const quarterNotesPerBar = (num * 4) / denom;
  return (bars * quarterNotesPerBar * 60) / bpm;
}

function secondsToBars(seconds, bpm, timeSignature = DEFAULT_TIME_SIGNATURE) {
  if (!Number.isFinite(seconds) || !Number.isFinite(bpm) || bpm <= 0) return 0;
  const num = Number(timeSignature?.numerator) || 4;
  const denom = Number(timeSignature?.denominator) || 4;
  const quarterNotesPerBar = (num * 4) / denom;
  return (seconds * bpm) / (quarterNotesPerBar * 60);
}

function formatTimeMMSS(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00';
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getMeterMap(payload) {
  const map = {};
  if (!payload || !Array.isArray(payload.meters)) {
    return map;
  }

  for (const meter of payload.meters) {
    map[meter.trackId] = meter;
  }

  return map;
}

function getPatternId(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (typeof value.pattern_id === 'string' && value.pattern_id.trim()) {
    return value.pattern_id.trim();
  }
  if (typeof value.patternId === 'string' && value.patternId.trim()) {
    return value.patternId.trim();
  }
  if (typeof value.pattern === 'string' && value.pattern.trim()) {
    return value.pattern.trim();
  }
  return null;
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

function inferImportedFormatFromMime(mime) {
  const normalized = isNonEmptyString(mime) ? mime.trim().toLowerCase() : '';
  if (!normalized) {
    return '';
  }
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

function resolveImportedFile(file) {
  if (!file) {
    return null;
  }
  const sourceName = isNonEmptyString(file.name) ? file.name.trim() : '';
  if (!sourceName) {
    return null;
  }
  const extension = normalizeImportedFormat(getFileExtension(sourceName));
  const mime = isNonEmptyString(file.type) ? file.type.trim().toLowerCase() : '';
  const mimeFormat = normalizeImportedFormat(inferImportedFormatFromMime(mime));
  const sourceFormat = extension || mimeFormat;
  if (!sourceFormat || !IMPORTABLE_EXTENSIONS.has(sourceFormat)) {
    return null;
  }
  const type = IMPORTABLE_MIDI_EXTENSIONS.has(sourceFormat) ? 'midi' : 'audio';
  return {
    type,
    sourceName,
    sourceFormat,
    sourceMime: mime,
    sourceSizeBytes: Number.isFinite(Number(file.size)) && Number(file.size) >= 0
      ? Math.round(Number(file.size))
      : null,
  };
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const arrayBuffer = reader.result;
      resolve(arrayBuffer instanceof ArrayBuffer ? arrayBuffer : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file);
  });
}

function decodeAudioBuffer(context, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishResolve = (buffer) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(buffer || null);
    };
    const finishReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    try {
      const maybePromise = context.decodeAudioData(
        arrayBuffer.slice(0),
        (decoded) => finishResolve(decoded),
        (error) => finishReject(error),
      );
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((decoded) => finishResolve(decoded)).catch((error) => finishReject(error));
      }
    } catch (error) {
      finishReject(error);
    }
  });
}

function normalizeWaveformPeaks(peaks, maxSamples = MAX_WAVEFORM_SAMPLE_COUNT) {
  if (!Array.isArray(peaks)) {
    return [];
  }
  const sanitized = peaks
    .map((peak) => Number(peak))
    .filter((peak) => Number.isFinite(peak))
    .map((peak) => Number(clamp(Math.abs(peak), 0, 1).toFixed(4)));
  if (sanitized.length <= maxSamples) {
    return sanitized;
  }

  const downsampled = [];
  const span = sanitized.length / maxSamples;
  for (let index = 0; index < maxSamples; index += 1) {
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

function extractWaveformPeaks(audioBuffer, sampleCount = DEFAULT_WAVEFORM_SAMPLE_COUNT) {
  if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function' || !Number.isFinite(audioBuffer.length) || audioBuffer.length <= 0) {
    return [];
  }

  const channels = Number.isInteger(audioBuffer.numberOfChannels) ? audioBuffer.numberOfChannels : 0;
  if (channels <= 0) {
    return [];
  }

  const targetSamples = Math.round(clamp(sampleCount, MIN_WAVEFORM_SAMPLE_COUNT, MAX_WAVEFORM_SAMPLE_COUNT));
  const frameCount = Math.floor(audioBuffer.length);
  const blockSize = Math.max(1, Math.floor(frameCount / targetSamples));
  const peaks = [];

  for (let sampleIndex = 0; sampleIndex < targetSamples; sampleIndex += 1) {
    const start = sampleIndex * blockSize;
    const end = sampleIndex === targetSamples - 1
      ? frameCount
      : Math.min(frameCount, start + blockSize);
    let peak = 0;

    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const channelData = audioBuffer.getChannelData(channelIndex);
      for (let frameIndex = start; frameIndex < end; frameIndex += 1) {
        const amplitude = Math.abs(channelData[frameIndex] || 0);
        if (amplitude > peak) {
          peak = amplitude;
          if (peak >= 1) {
            break;
          }
        }
      }
      if (peak >= 1) {
        break;
      }
    }

    peaks.push(Number(clamp(peak, 0, 1).toFixed(4)));
  }

  return normalizeWaveformPeaks(peaks);
}

async function analyzeImportedAudioFile(file, sampleCount = DEFAULT_WAVEFORM_SAMPLE_COUNT) {
  if (!file || !IMPORTABLE_AUDIO_EXTENSIONS.has(normalizeImportedFormat(getFileExtension(file.name || '')))) {
    return { durationSec: null, waveformPeaks: [] };
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return { durationSec: null, waveformPeaks: [] };
  }

  const arrayBuffer = await readFileAsArrayBuffer(file);
  if (!arrayBuffer) {
    return { durationSec: null, waveformPeaks: [] };
  }

  let context = null;
  try {
    context = new AudioContextClass();
    const decodedBuffer = await decodeAudioBuffer(context, arrayBuffer);
    const durationRaw = decodedBuffer?.duration;
    const durationSec = Number.isFinite(durationRaw) && durationRaw > 0
      ? Number(durationRaw.toFixed(6))
      : null;
    return {
      durationSec,
      waveformPeaks: extractWaveformPeaks(decodedBuffer, sampleCount),
    };
  } catch {
    return { durationSec: null, waveformPeaks: [] };
  } finally {
    if (context && typeof context.close === 'function') {
      context.close().catch(() => {});
    }
  }
}

function eventHasFilePayload(event) {
  if ((event?.dataTransfer?.files?.length || 0) > 0) {
    return true;
  }
  const types = Array.from(event?.dataTransfer?.types || []);
  return types.includes('Files');
}

async function uploadFileToEngine(file) {
  const uploadUrl = new URL('/media/upload', ENGINE_BASE_URL);
  uploadUrl.searchParams.set('filename', file.name || `import_${Date.now()}`);
  const response = await fetch(uploadUrl.toString(), {
    method: 'POST',
    body: file,
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
    },
  });
  if (!response.ok) {
    throw new Error(`upload failed (${response.status})`);
  }
  const payload = await response.json();
  if (!payload?.ok || !payload.path) {
    throw new Error(payload?.error || 'upload response invalid');
  }
  return {
    path: payload.path,
    size: payload.size,
    duration_sec: payload.duration_sec ?? payload.durationSec ?? null,
    waveform_peaks: Array.isArray(payload.waveform_peaks) ? payload.waveform_peaks : (Array.isArray(payload.waveformPeaks) ? payload.waveformPeaks : null),
  };
}

function normalizeClipType(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'audio' || normalized === 'midi') {
    return normalized;
  }
  return null;
}

function getImportedClipLabel(clip) {
  if (isNonEmptyString(clip?.source_name)) {
    return clip.source_name.trim();
  }
  const clipType = normalizeClipType(clip?.type);
  if (clipType === 'midi') {
    return 'MIDI';
  }
  if (clipType === 'audio') {
    const format = normalizeImportedFormat(clip?.source_format);
    return format ? format.toUpperCase() : 'Audio';
  }
  return 'Clip';
}

function getClipDisplayLabel(clip) {
  const patternId = getPatternId(clip);
  if (patternId) {
    return patternId;
  }
  return getImportedClipLabel(clip);
}

function getClipWaveformPeaks(clip) {
  if (!clip || typeof clip !== 'object') {
    return [];
  }
  return normalizeWaveformPeaks(clip.waveform_peaks ?? clip.waveformPeaks ?? clip.waveform ?? []);
}

function resampleWaveformPeaks(peaks, targetCount) {
  const normalized = normalizeWaveformPeaks(peaks);
  if (normalized.length === 0) {
    return [];
  }

  const safeTargetCount = Math.round(clamp(targetCount, MIN_WAVEFORM_SAMPLE_COUNT, MAX_WAVEFORM_SAMPLE_COUNT));
  if (safeTargetCount === normalized.length) {
    return normalized;
  }

  if (safeTargetCount < normalized.length) {
    const downsampled = [];
    const span = normalized.length / safeTargetCount;
    for (let index = 0; index < safeTargetCount; index += 1) {
      const start = Math.floor(index * span);
      const end = Math.min(normalized.length, Math.floor((index + 1) * span) || (start + 1));
      let peak = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        if (normalized[sampleIndex] > peak) {
          peak = normalized[sampleIndex];
        }
      }
      downsampled.push(Number(peak.toFixed(4)));
    }
    return downsampled;
  }

  const upsampled = [];
  const lastIndex = normalized.length - 1;
  const divisor = safeTargetCount - 1;
  for (let index = 0; index < safeTargetCount; index += 1) {
    const progress = divisor > 0 ? index / divisor : 0;
    const sourcePosition = progress * lastIndex;
    const sourceIndex = Math.floor(sourcePosition);
    const nextIndex = Math.min(lastIndex, sourceIndex + 1);
    const blend = sourcePosition - sourceIndex;
    const value = (normalized[sourceIndex] * (1 - blend)) + (normalized[nextIndex] * blend);
    upsampled.push(Number(clamp(value, 0, 1).toFixed(4)));
  }
  return upsampled;
}

function getAdaptiveWaveformPeaks(peaks, clipWidthPx) {
  const width = Number(clipWidthPx);
  if (!Number.isFinite(width) || width <= 0) {
    return normalizeWaveformPeaks(peaks);
  }
  // About one peak column per ~1.6px yields good detail without noisy overdraw.
  const targetCount = Math.round(width / 1.6);
  return resampleWaveformPeaks(peaks, targetCount);
}

function getWaveformPolygonPoints(peaks) {
  const normalizedPeaks = normalizeWaveformPeaks(peaks);
  if (normalizedPeaks.length === 0) {
    return '';
  }

  const topPoints = [];
  const bottomPoints = [];
  const lastIndex = Math.max(1, normalizedPeaks.length - 1);
  for (let index = 0; index < normalizedPeaks.length; index += 1) {
    const x = (index / lastIndex) * 100;
    const amplitude = normalizedPeaks[index] * 44;
    const topY = 50 - amplitude;
    const bottomY = 50 + amplitude;
    topPoints.push(`${x.toFixed(3)},${topY.toFixed(3)}`);
    bottomPoints.push(`${x.toFixed(3)},${bottomY.toFixed(3)}`);
  }

  return [...topPoints, ...bottomPoints.reverse()].join(' ');
}

function getStepVelocityMap(pattern) {
  const map = new Map();
  if (!pattern || !Array.isArray(pattern.steps)) {
    return map;
  }

  for (const step of pattern.steps) {
    const lane = typeof step.lane === 'string' ? step.lane : null;
    const index = Number(step.index);
    const velocity = Number(step.velocity);
    if (!lane || !Number.isInteger(index) || !Number.isFinite(velocity)) {
      continue;
    }
    map.set(`${lane}:${index}`, velocity);
  }

  return map;
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

    const id = typeof rawParameter.id === 'string' && rawParameter.id.trim()
      ? rawParameter.id.trim()
      : `param_${index + 1}`;
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);

    normalized.push({
      id,
      name: typeof rawParameter.name === 'string' && rawParameter.name.trim() ? rawParameter.name.trim() : id,
      min: Number.isFinite(Number(rawParameter.min)) ? Number(rawParameter.min) : 0,
      max: Number.isFinite(Number(rawParameter.max)) ? Number(rawParameter.max) : 1,
      value: Number.isFinite(Number(rawParameter.value)) ? Number(rawParameter.value) : 0,
    });
  }

  return normalized;
}

function normalizePluginCatalog(plugins) {
  if (!Array.isArray(plugins)) {
    return [];
  }

  const deduped = new Map();
  for (const rawPlugin of plugins) {
    if (!isObject(rawPlugin)) {
      continue;
    }

    const uid = typeof rawPlugin.uid === 'string' && rawPlugin.uid.trim()
      ? rawPlugin.uid.trim()
      : null;
    if (!uid || deduped.has(uid)) {
      continue;
    }

    deduped.set(uid, {
      uid,
      name: typeof rawPlugin.name === 'string' && rawPlugin.name.trim() ? rawPlugin.name.trim() : uid,
      type: typeof rawPlugin.type === 'string' && rawPlugin.type.trim() ? rawPlugin.type.trim() : 'unknown',
      parameters: normalizePluginParameters(rawPlugin.parameters),
    });
  }

  return Array.from(deduped.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function formatTrackName(name, trackId) {
  const base = typeof name === 'string' && name.trim() ? name.trim() : `Track ${trackId}`;
  return base.slice(0, TRACK_NAME_LIMIT);
}

function createDefaultTrackMix(trackId) {
  return {
    track_id: trackId,
    volume: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    record_armed: false,
  };
}

function normalizeTrackMixEntry(entry, trackId) {
  const safeEntry = isObject(entry) ? entry : {};
  return {
    track_id: trackId,
    volume: clamp(Number(safeEntry.volume) || 0.85, 0, 1.2),
    pan: clamp(Number(safeEntry.pan) || 0, -1, 1),
    mute: Boolean(safeEntry.mute),
    solo: Boolean(safeEntry.solo),
    record_armed: Boolean(safeEntry.record_armed ?? safeEntry.recordArmed),
  };
}

function normalizePlaylistViewBars(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_VIEW_BARS;
  }
  return Math.round(clamp(parsed, MIN_VISIBLE_BARS, MAX_TIMELINE_BARS));
}

function normalizePlaylistBarWidth(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BAR_WIDTH;
  }
  return Number(clamp(parsed, MIN_BAR_WIDTH, MAX_BAR_WIDTH).toFixed(3));
}

function normalizePlaylistShowTrackNodes(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return true;
}

function normalizeSnapMode(value) {
  const resolved = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (SNAP_MODE_OPTIONS.some((option) => option.id === resolved)) {
    return resolved;
  }
  return DEFAULT_SNAP_MODE;
}

function resolveAutoSnapStep(barWidth) {
  if (!Number.isFinite(barWidth)) {
    return 1 / 4;
  }
  if (barWidth >= 170) {
    return 1 / 16;
  }
  if (barWidth >= 110) {
    return 1 / 8;
  }
  if (barWidth >= 72) {
    return 1 / 4;
  }
  if (barWidth >= 48) {
    return 1 / 2;
  }
  return 1;
}

function resolveGridLineDensity(barWidth) {
  if (!Number.isFinite(barWidth)) {
    return {
      microDivisions: 4,
      microAlpha: 0.05,
      beatAlpha: 0.11,
    };
  }
  if (barWidth >= 200) {
    return {
      microDivisions: 32,
      microAlpha: 0.06,
      beatAlpha: 0.13,
    };
  }
  if (barWidth >= 110) {
    return {
      microDivisions: 16,
      microAlpha: 0.08,
      beatAlpha: 0.13,
    };
  }
  if (barWidth >= 72) {
    return {
      microDivisions: 8,
      microAlpha: 0.07,
      beatAlpha: 0.12,
    };
  }
  if (barWidth >= 48) {
    return {
      microDivisions: 4,
      microAlpha: 0.05,
      beatAlpha: 0.10,
    };
  }
  return {
    microDivisions: 4,
    microAlpha: 0.04,
    beatAlpha: 0.08,
  };
}

function resolveSnapStep(snapMode, barWidth, gridLineDensity) {
  const mode = normalizeSnapMode(snapMode);
  if (mode === 'line') {
    const microDivisions = Number(gridLineDensity?.microDivisions);
    const microAlpha = Number(gridLineDensity?.microAlpha);
    const beatAlpha = Number(gridLineDensity?.beatAlpha);
    if (Number.isFinite(microDivisions) && microDivisions > 0 && microAlpha > 0) {
      return 1 / microDivisions;
    }
    if (beatAlpha > 0) {
      return 1 / 4;
    }
    return 1;
  }
  if (mode === 'cell') {
    return GRID_STEP;
  }
  if (mode === 'half_beat') {
    return 1 / 8;
  }
  if (mode === 'beat') {
    return 1 / 4;
  }
  if (mode === 'bar') {
    return 1;
  }
  return resolveAutoSnapStep(barWidth);
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function getClipSelectionKey(trackId, clipId) {
  return `${trackId}:${clipId}`;
}

function resolveClipSelectionKey(key) {
  if (!isNonEmptyString(key)) {
    return null;
  }
  const [trackPart, clipPart] = key.split(':');
  const trackId = Number(trackPart);
  if (!Number.isInteger(trackId) || trackId <= 0 || !isNonEmptyString(clipPart)) {
    return null;
  }
  return { trackId, clipId: clipPart.trim() };
}

function TrackActionIcon({ action }) {
  if (action === 'record') return <Circle size={14} strokeWidth={2.5} className="track-action-icon-record" aria-hidden="true" />;
  if (action === 'import') return <Download size={14} strokeWidth={2} aria-hidden="true" />;
  return <LayoutGrid size={14} strokeWidth={2} aria-hidden="true" />;
}

function TrackMixToggleIcon({ action, active = false }) {
  if (action === 'mute') return <VolumeX size={14} strokeWidth={2} aria-hidden="true" />;
  if (action === 'solo') {
    return (
      <span className="track-mix-solo-letter" aria-hidden="true">S</span>
    );
  }
  return null;
}

function MultiSelectIcon({ active = false }) {
  if (!active) return <span className="multi-select-icon-placeholder" aria-hidden="true" />;
  return <Check size={14} strokeWidth={2.5} aria-hidden="true" />;
}

function TrackChainOpenIcon() {
  return <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />;
}

function TrackChainArrowIcon() {
  return <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />;
}

function TrackChainBypassIcon({ active = false }) {
  return <Power size={14} strokeWidth={2} opacity={active ? 0.5 : 1} aria-hidden="true" />;
}

function TrackChainPlugIcon() {
  return <Plug size={14} strokeWidth={2} aria-hidden="true" />;
}

const EDIT_TOOL_LUCIDE_ICONS = {
  select: MousePointer2,
  draw: Pencil,
  paint: PaintBucket,
  delete: Trash2,
  mute: VolumeX,
  slip: MoveHorizontal,
  slice: Scissors,
  zoom: ZoomIn,
  preview: Play,
};

function EditToolIcon({ toolId }) {
  const Icon = EDIT_TOOL_LUCIDE_ICONS[toolId];
  if (!Icon) return null;
  return (
    <Icon
      size={14}
      strokeWidth={2}
      className={toolId === 'slice' ? 'edit-tool-icon-slice' : undefined}
      aria-hidden="true"
    />
  );
}

function normalizeVolumeValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0.85;
  }
  return clamp(parsed, 0, 1.2);
}

function normalizePanValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return clamp(parsed, -1, 1);
}

function toVolumeDb(volume) {
  const normalizedVolume = normalizeVolumeValue(volume);
  if (normalizedVolume <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  return 20 * Math.log10(normalizedVolume);
}

function toPanPercent(pan) {
  return Math.round(normalizePanValue(pan) * 100);
}

function toPanMagnitudePercent(pan) {
  return Math.abs(toPanPercent(pan));
}

function getPanSideLabel(pan) {
  const percent = toPanPercent(pan);
  if (percent === 0) {
    return 'C';
  }
  return percent > 0 ? 'R' : 'L';
}

function toVolumeDbInput(volume) {
  const db = toVolumeDb(volume);
  if (!Number.isFinite(db)) {
    return MIN_VOLUME_DB;
  }
  return Number(db.toFixed(1));
}

function formatVolumeDbLabel(volume) {
  const db = toVolumeDb(volume);
  if (!Number.isFinite(db)) {
    return '-inf dB';
  }
  return `${db.toFixed(1)} dB`;
}

function fromVolumeDbInput(dbValue) {
  const parsedDb = Number(dbValue);
  if (!Number.isFinite(parsedDb)) {
    return null;
  }
  if (parsedDb <= MIN_VOLUME_DB) {
    return 0;
  }
  return normalizeVolumeValue(10 ** (parsedDb / 20));
}

function getPanFillRange(pan) {
  const normalizedPan = normalizePanValue(pan);
  const thumbPercent = ((normalizedPan + 1) / 2) * 100;
  return {
    '--pan-fill-start': `${Math.min(50, thumbPercent)}%`,
    '--pan-fill-end': `${Math.max(50, thumbPercent)}%`,
  };
}

function resolveNodeTrackId(node) {
  const trackId = Number(node?.track_id ?? node?.trackId);
  return Number.isInteger(trackId) && trackId > 0 ? trackId : null;
}

function resolveNodePluginIndex(node, fallback = 0) {
  const pluginIndex = Number(node?.plugin_index ?? node?.pluginIndex);
  return Number.isInteger(pluginIndex) && pluginIndex >= 0 ? pluginIndex : fallback;
}

function formatTrackChainPluginName(name) {
  const normalized = typeof name === 'string' && name.trim() ? name.trim() : 'Plugin';
  if (normalized.length <= TRACK_CHAIN_PLUGIN_NAME_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, TRACK_CHAIN_PLUGIN_NAME_LIMIT - 1)}…`;
}

export default function StuuShell() {
  const socketRef = useRef(null);
  const clipDraftsRef = useRef({});
  const importFileInputRef = useRef(null);
  const importTargetTrackIdRef = useRef(null);
  const trackNameInputRef = useRef(null);
  const cancelTrackNameEditRef = useRef(false);
  const arrangementScrollRef = useRef(null);
  const arrangementGridRef = useRef(null);
  const arrangementBodyRef = useRef(null);
  const barWidthRef = useRef(DEFAULT_BAR_WIDTH);
  const timelineBarsRef = useRef(DEFAULT_VIEW_BARS);
  const viewBarsRef = useRef(DEFAULT_VIEW_BARS);
  const showTrackNodesRef = useRef(true);
  const seekAnimationFrameRef = useRef(null);
  const playheadAnimationFrameRef = useRef(null);
  const playheadLeftPxRef = useRef(-1);
  const pendingSeekBarsRef = useRef(null);
  const playheadPointerHandlersRef = useRef(null);
  const toolPointerHandlersRef = useRef(null);
  const toolDragRef = useRef(null);
  const playheadDragBarsRef = useRef(null);
  const previewStopTimeoutRef = useRef(null);
  const latestTransportRef = useRef(FALLBACK_STATE.transport);
  const transportUiCommitRef = useRef({ lastMs: 0, playing: false });
  const transportSnapshotRef = useRef({
    bpm: FALLBACK_STATE.project.bpm,
    beatsPerBar: (DEFAULT_TIME_SIGNATURE.numerator * 4) / DEFAULT_TIME_SIGNATURE.denominator,
    playing: false,
    positionBars: FALLBACK_STATE.transport.positionBars,
    positionBeats: FALLBACK_STATE.transport.positionBeats,
    timestamp: Date.now(),
  });
  const loadedProjectFileRef = useRef(null);
  const chatHistoryLoadedRef = useRef(false);
  const lastSyncedViewRef = useRef({
    file: '',
    bars: DEFAULT_VIEW_BARS,
    width: DEFAULT_BAR_WIDTH,
    showNodes: true,
  });

  const [connection, setConnection] = useState('connecting');
  const [enginePort, setEnginePort] = useState(() => {
    try {
      const u = new URL(ENGINE_BASE_URL);
      return u.port ? Number(u.port) : 3987;
    } catch {
      return 3987;
    }
  });
  const [editTool, setEditTool] = useState(DEFAULT_EDIT_TOOL);
  const [selectedClipKeys, setSelectedClipKeys] = useState([]);
  const [clipMuteOverrides, setClipMuteOverrides] = useState({});
  const [clipSlipPreviewBars, setClipSlipPreviewBars] = useState({});
  const [toolDragOverlay, setToolDragOverlay] = useState(null);
  const [activeTab, setActiveTab] = useState('Edit');
  const [state, setState] = useState(FALLBACK_STATE);
  const [transport, setTransport] = useState(FALLBACK_STATE.transport);
  const [meters, setMeters] = useState({});
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState(DEFAULT_CHAT_MESSAGES);
  const [inspector, setInspector] = useState({ type: 'project' });
  const [activePatternId, setActivePatternId] = useState(null);
  const [clipDrafts, setClipDrafts] = useState({});
  const [clipInteraction, setClipInteraction] = useState(null);
  const [openTrackMenuId, setOpenTrackMenuId] = useState(null);
  const [trackAddMenuAnchor, setTrackAddMenuAnchor] = useState(/** @type {{ top: number; right: number; height: number } | null} */ (null));
  const [editingTrackId, setEditingTrackId] = useState(null);
  const [editingTrackName, setEditingTrackName] = useState('');
  const [localTrackNameOverrides, setLocalTrackNameOverrides] = useState({});
  const [barWidth, setBarWidth] = useState(DEFAULT_BAR_WIDTH);
  const [viewBars, setViewBars] = useState(DEFAULT_VIEW_BARS);
  const [snapMode, setSnapMode] = useState(DEFAULT_SNAP_MODE);
  const [showTrackNodes, setShowTrackNodes] = useState(true);
  const [arrangementViewportWidth, setArrangementViewportWidth] = useState(0);
  const [availablePlugins, setAvailablePlugins] = useState([]);
  const [selectedPluginUid, setSelectedPluginUid] = useState(FALLBACK_VST_UID);
  const [selectedPluginTrackId, setSelectedPluginTrackId] = useState(1);
  const [pluginScanPending, setPluginScanPending] = useState(false);
  const [pluginLoadPending, setPluginLoadPending] = useState(false);
  const [hoveredTrackId, setHoveredTrackId] = useState(null);
  const [dropTargetTrackId, setDropTargetTrackId] = useState(null);
  const [trackReorderDragId, setTrackReorderDragId] = useState(null);
  const [trackReorderDropIndex, setTrackReorderDropIndex] = useState(null);
  const [trackChainEnabledOverrides, setTrackChainEnabledOverrides] = useState({});
  const [playheadDragBars, setPlayheadDragBars] = useState(null);
  const [trackContextMenu, setTrackContextMenu] = useState(null);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedTrackIds, setSelectedTrackIds] = useState([]);
  const [openTrackPluginPicker, setOpenTrackPluginPicker] = useState(null);
  const [trackChainModalTrackId, setTrackChainModalTrackId] = useState(null);
  const [slicePreviewBars, setSlicePreviewBars] = useState(null);
  const [sliceCursorPosition, setSliceCursorPosition] = useState(null);

  const applyEngineTransportPayload = useCallback((payload = {}) => {
    const previous = latestTransportRef.current;
    const merged = { ...previous, ...(isObject(payload) ? payload : {}) };
    latestTransportRef.current = merged;

    const snapshot = transportSnapshotRef.current;
    const beatsPerBar = Number(snapshot?.beatsPerBar);
    const safeBeatsPerBar = Number.isFinite(beatsPerBar) && beatsPerBar > 0 ? beatsPerBar : 4;
    const transportBars = Number(merged.positionBars);
    const transportBeats = Number(merged.positionBeats);
    const positionBeats = Number.isFinite(transportBeats)
      ? Math.max(0, transportBeats)
      : Number.isFinite(transportBars)
        ? Math.max(0, transportBars * safeBeatsPerBar)
        : Math.max(0, Number(snapshot?.positionBeats) || 0);
    const positionBars = Number.isFinite(transportBars)
      ? Math.max(0, transportBars)
      : Number((positionBeats / safeBeatsPerBar).toFixed(6));
    const timestampRaw = Number(merged.timestamp);
    const playing = Boolean(merged.playing ?? snapshot?.playing);

    transportSnapshotRef.current = {
      ...snapshot,
      playing,
      positionBars,
      positionBeats,
      timestamp: Number.isFinite(timestampRaw) ? timestampRaw : Date.now(),
    };

    const nowMs = Date.now();
    const lastUiCommit = transportUiCommitRef.current;
    const shouldCommit =
      !playing
      || !lastUiCommit.playing
      || nowMs - lastUiCommit.lastMs >= 120;
    if (shouldCommit) {
      transportUiCommitRef.current = { lastMs: nowMs, playing };
      setTransport((current) => ({
        ...current,
        ...merged,
      }));
    }
  }, []);

  useEffect(() => {
    clipDraftsRef.current = clipDrafts;
  }, [clipDrafts]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('thestuu-chat-history');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setChatMessages(parsed);
        }
      }
    } catch {
      // Ignore invalid chat history payloads.
    } finally {
      chatHistoryLoadedRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!chatHistoryLoadedRef.current) {
      return;
    }
    window.localStorage.setItem('thestuu-chat-history', JSON.stringify(chatMessages));
  }, [chatMessages]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('thestuu-playlist-snap-mode');
      if (!saved) {
        return;
      }
      setSnapMode(normalizeSnapMode(saved));
    } catch {
      // Ignore invalid snap mode payloads.
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem('thestuu-playlist-snap-mode', normalizeSnapMode(snapMode));
  }, [snapMode]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('thestuu-edit-tool');
      if (!saved) {
        return;
      }
      if (EDIT_TOOL_OPTIONS.some((tool) => tool.id === saved)) {
        setEditTool(saved);
      }
    } catch {
      // Ignore malformed tool preference.
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem('thestuu-edit-tool', editTool);
  }, [editTool]);

  useEffect(() => {
    const socket = createEngineSocket();
    socketRef.current = socket;

    socket.on('connect', () => setConnection('online'));
    socket.on('disconnect', () => setConnection('offline'));
    socket.on('connect_error', () => setConnection('offline'));
    socket.io.on('reconnect_attempt', () => setConnection('connecting'));
    socket.on('engine:ready', (payload) => {
      if (Number.isFinite(payload?.enginePort)) setEnginePort(payload.enginePort);
    });
    socket.on('engine:state', (payload) => {
      setState(payload);
      setTrackChainEnabledOverrides({});
    });
    socket.on('engine:meter', (payload) => setMeters(getMeterMap(payload)));
    socket.on('engine:transport', (payload) => {
      applyEngineTransportPayload(payload);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
      socket.off('engine:ready');
      socket.io.off('reconnect_attempt');
      socket.close();
    };
  }, [applyEngineTransportPayload]);

  useEffect(() => {
    if (editingTrackId === null || !trackNameInputRef.current) {
      return;
    }
    trackNameInputRef.current.focus();
    trackNameInputRef.current.select();
  }, [editingTrackId]);

  useEffect(() => {
    barWidthRef.current = barWidth;
  }, [barWidth]);

  useEffect(() => {
    viewBarsRef.current = viewBars;
  }, [viewBars]);

  useEffect(() => {
    showTrackNodesRef.current = showTrackNodes;
  }, [showTrackNodes]);

  useEffect(() => {
    playheadDragBarsRef.current = Number.isFinite(playheadDragBars) ? playheadDragBars : null;
  }, [playheadDragBars]);

  useEffect(() => {
    const selectedProjectFile = typeof state?.selectedProjectFile === 'string'
      ? state.selectedProjectFile
      : FALLBACK_STATE.selectedProjectFile;
    const projectViewBars = normalizePlaylistViewBars(state?.project?.playlist_view_bars);
    const projectBarWidth = normalizePlaylistBarWidth(state?.project?.playlist_bar_width);
    const projectShowTrackNodes = normalizePlaylistShowTrackNodes(state?.project?.playlist_show_track_nodes);

    if (loadedProjectFileRef.current !== selectedProjectFile) {
      loadedProjectFileRef.current = selectedProjectFile;
      setViewBars(projectViewBars);
      setBarWidth(projectBarWidth);
      setShowTrackNodes(projectShowTrackNodes);
      lastSyncedViewRef.current = {
        file: selectedProjectFile,
        bars: projectViewBars,
        width: projectBarWidth,
        showNodes: projectShowTrackNodes,
      };
      return;
    }

    if (Math.abs(projectBarWidth - barWidthRef.current) >= 0.1) {
      setBarWidth(projectBarWidth);
    }
    if (Math.abs(projectViewBars - viewBarsRef.current) >= 1) {
      setViewBars(projectViewBars);
    }
    if (projectShowTrackNodes !== showTrackNodesRef.current) {
      setShowTrackNodes(projectShowTrackNodes);
    }
  }, [state?.selectedProjectFile, state?.project?.playlist_view_bars, state?.project?.playlist_bar_width, state?.project?.playlist_show_track_nodes]);

  useEffect(() => {
    if (activeTab !== 'Edit') {
      return;
    }

    const scrollElement = arrangementScrollRef.current;
    if (!scrollElement) {
      return;
    }

    function updateViewportWidth() {
      setArrangementViewportWidth(scrollElement.clientWidth || 0);
    }

    updateViewportWidth();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        updateViewportWidth();
      });
      observer.observe(scrollElement);
      return () => {
        observer.disconnect();
      };
    }

    window.addEventListener('resize', updateViewportWidth);
    return () => {
      window.removeEventListener('resize', updateViewportWidth);
    };
  }, [activeTab]);

  const projectNodes = useMemo(() => {
    return Array.isArray(state?.project?.nodes) ? state.project.nodes : [];
  }, [state]);

  const flowNodes = useMemo(() => {
    return projectNodes.map((node, index) => ({
      id: node.id,
      position: { x: 80 + (index % 3) * 230, y: 90 + Math.floor(index / 3) * 180 },
      data: { label: `${node.plugin || node.type} (${node.id})` },
      style: {
        background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.06))',
        color: '#f3f3f5',
        border: '1px solid rgba(255, 255, 255, 0.22)',
        borderRadius: 12,
        padding: 10,
      },
    }));
  }, [projectNodes]);

  const flowEdges = useMemo(() => {
    if (flowNodes.length < 2) {
      return [];
    }

    return flowNodes.slice(1).map((node, index) => ({
      id: `edge_${flowNodes[index].id}_${node.id}`,
      source: flowNodes[index].id,
      target: node.id,
      animated: true,
      style: { stroke: '#d6d6da', strokeWidth: 2 },
    }));
  }, [flowNodes]);

  const playlist = state?.project?.playlist ?? FALLBACK_STATE.project.playlist;
  const mixer = state?.project?.mixer ?? FALLBACK_STATE.project.mixer;
  const patterns = state?.project?.patterns ?? FALLBACK_STATE.project.patterns;
  const playlistTrackMap = useMemo(() => {
    const map = new Map();
    for (const track of playlist) {
      const trackId = Number(track?.track_id);
      if (!Number.isInteger(trackId) || trackId <= 0) {
        continue;
      }
      map.set(trackId, track);
    }
    return map;
  }, [playlist]);
  const mixerTrackMap = useMemo(() => {
    const map = new Map();
    for (const entry of mixer) {
      const trackId = Number(entry?.track_id);
      if (!Number.isInteger(trackId) || trackId <= 0) {
        continue;
      }
      map.set(trackId, normalizeTrackMixEntry(entry, trackId));
    }
    return map;
  }, [mixer]);
  const visibleTrackCount = useMemo(() => {
    const highestTrackId = playlist.reduce((maxId, track) => {
      const trackId = Number(track?.track_id);
      return Number.isInteger(trackId) && trackId > maxId ? trackId : maxId;
    }, 0);
    return Math.max(MIN_VISIBLE_TRACKS, highestTrackId);
  }, [playlist]);
  const arrangementTracks = useMemo(() => {
    return Array.from({ length: visibleTrackCount }, (_, index) => {
      const trackId = index + 1;
      const source = playlistTrackMap.get(trackId);
      const localOverride = localTrackNameOverrides[trackId];
      const serverChainEnabled = source?.chain_enabled !== false;
      const chainEnabled = trackChainEnabledOverrides[trackId] !== undefined
        ? trackChainEnabledOverrides[trackId]
        : serverChainEnabled;
      return {
        track_id: trackId,
        exists: Boolean(source),
        name: formatTrackName(localOverride ?? source?.name, trackId),
        chain_collapsed: !showTrackNodes,
        chain_enabled: chainEnabled,
        clips: Array.isArray(source?.clips) ? source.clips : [],
        mix: mixerTrackMap.get(trackId) || createDefaultTrackMix(trackId),
      };
    });
  }, [playlistTrackMap, mixerTrackMap, visibleTrackCount, localTrackNameOverrides, showTrackNodes, trackChainEnabledOverrides]);
  const arrangementTrackMap = useMemo(() => new Map(arrangementTracks.map((track) => [track.track_id, track])), [arrangementTracks]);
  const existingClipKeySet = useMemo(() => {
    const keys = new Set();
    for (const track of arrangementTracks) {
      const clips = Array.isArray(track?.clips) ? track.clips : [];
      for (const clip of clips) {
        if (!isNonEmptyString(clip?.id)) {
          continue;
        }
        keys.add(getClipSelectionKey(track.track_id, clip.id));
      }
    }
    return keys;
  }, [arrangementTracks]);

  useEffect(() => {
    if (activeTab !== 'Edit') return;
    let cleanup = () => {};
    const id = setTimeout(() => {
      const el = arrangementBodyRef.current;
      if (!el) return;
      const onWheel = (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const delta = e.deltaY > 0 ? -4 : 4;
          setBarWidth((w) => clamp(w + delta, MIN_BAR_WIDTH, MAX_BAR_WIDTH));
        }
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      cleanup = () => el.removeEventListener('wheel', onWheel);
    }, 0);
    return () => {
      clearTimeout(id);
      cleanup();
    };
  }, [activeTab]);

  useEffect(() => {
    if (!openTrackMenuId) {
      setTrackAddMenuAnchor(null);
    } else {
      const t = arrangementTrackMap.get(openTrackMenuId);
      if (t) importTargetTrackIdRef.current = t.track_id;
    }
  }, [openTrackMenuId, arrangementTrackMap]);

  const drumPatterns = useMemo(() => patterns.filter((pattern) => pattern.type === 'drum'), [patterns]);
  const resolvedActivePatternId = useMemo(() => {
    if (drumPatterns.length === 0) {
      return null;
    }
    if (activePatternId && drumPatterns.some((pattern) => pattern.id === activePatternId)) {
      return activePatternId;
    }
    return drumPatterns[0].id;
  }, [drumPatterns, activePatternId]);

  const maxClipEnd = useMemo(() => {
    return arrangementTracks.reduce((maxEnd, track) => {
      const clips = Array.isArray(track.clips) ? track.clips : [];
      const trackEnd = clips.reduce((trackMax, clip) => {
        const start = Number(clip.start) || 0;
        const length = Number(clip.length) || 0;
        return Math.max(trackMax, start + length);
      }, 0);
      return Math.max(maxEnd, trackEnd);
    }, 0);
  }, [arrangementTracks]);

  const dataEndBars = Math.max(MIN_VISIBLE_BARS, Math.ceil(maxClipEnd + 2));
  const minimumViewportBars = Math.max(
    MIN_VISIBLE_BARS,
    Math.ceil((arrangementViewportWidth || 0) / barWidth) + 1,
  );
  const timelineBars = clamp(Math.max(dataEndBars, viewBars, minimumViewportBars), MIN_VISIBLE_BARS, MAX_TIMELINE_BARS);
  const timelineWidth = timelineBars * barWidth;
  const gridLineDensity = useMemo(() => resolveGridLineDensity(barWidth), [barWidth]);
  const timeSignature = useMemo(
    () => ({
      numerator: Number(state?.project?.time_signature?.numerator) || 4,
      denominator: Number(state?.project?.time_signature?.denominator) || 4,
    }),
    [state?.project?.time_signature],
  );
  const timeMarkers = useMemo(() => {
    const bpm = Number(state?.project?.bpm) || 128;
    const timelineEndSeconds = barsToSeconds(timelineBars, bpm, timeSignature);
    const markers = [];
    for (let s = 0; s <= timelineEndSeconds; s += TIME_MARKER_INTERVAL_SECONDS) {
      const bars = secondsToBars(s, bpm, timeSignature);
      const leftPx = bars * barWidth;
      if (leftPx <= timelineWidth + 1) {
        markers.push({ seconds: s, leftPx, label: formatTimeMMSS(s) });
      }
    }
    return markers;
  }, [state?.project?.bpm, timeSignature, timelineBars, timelineWidth, barWidth]);
  const snapStep = useMemo(
    () => resolveSnapStep(snapMode, barWidth, gridLineDensity),
    [snapMode, barWidth, gridLineDensity],
  );
  const sliceSnapStep = useMemo(() => {
    const micro = Number(gridLineDensity?.microDivisions);
    return Number.isFinite(micro) && micro > 0 ? 1 / micro : 1 / 4;
  }, [gridLineDensity]);

  useEffect(() => {
    timelineBarsRef.current = timelineBars;
  }, [timelineBars]);

  useEffect(() => {
    const beatsPerBarRaw = (timeSignature.numerator * 4) / timeSignature.denominator;
    const beatsPerBar = Number.isFinite(beatsPerBarRaw) && beatsPerBarRaw > 0 ? beatsPerBarRaw : 4;
    const bpm = Number(state?.project?.bpm);
    const normalizedBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 128;

    transportSnapshotRef.current = {
      ...transportSnapshotRef.current,
      bpm: normalizedBpm,
      beatsPerBar,
      playing: Boolean(state?.playing ?? transportSnapshotRef.current.playing),
    };
  }, [state?.project?.bpm, state?.playing, timeSignature.numerator, timeSignature.denominator]);

  const computeInterpolatedPlayheadBars = useCallback((nowMs = Date.now()) => {
    const snapshot = transportSnapshotRef.current;
    const beatsPerBar = Number(snapshot?.beatsPerBar);
    const safeBeatsPerBar = Number.isFinite(beatsPerBar) && beatsPerBar > 0 ? beatsPerBar : 4;
    const baseBeats = Math.max(0, Number(snapshot?.positionBeats) || 0);
    const bpm = Number(snapshot?.bpm);
    const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 128;
    const snapshotTimestamp = Number(snapshot?.timestamp);
    const safeTimestamp = Number.isFinite(snapshotTimestamp) ? snapshotTimestamp : nowMs;
    const elapsedMs = Math.max(0, nowMs - safeTimestamp);
    const deltaBeats = Boolean(snapshot?.playing) ? (elapsedMs * safeBpm) / 60000 : 0;
    return Number(((baseBeats + deltaBeats) / safeBeatsPerBar).toFixed(6));
  }, []);

  const getCurrentTransportBars = useCallback(() => {
    const draggedBars = Number(playheadDragBarsRef.current);
    if (Number.isFinite(draggedBars)) {
      return Math.max(0, draggedBars);
    }
    return Math.max(0, computeInterpolatedPlayheadBars(Date.now()));
  }, [computeInterpolatedPlayheadBars]);
  const timeDisplay = useMemo(() => {
    const bpm = Number(state?.project?.bpm) || 128;
    const beats = Number(transport?.positionBeats) || 0;
    const totalSeconds = (beats * 60) / bpm;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const centiseconds = Math.floor((totalSeconds - Math.floor(totalSeconds)) * 100);
    return `${String(minutes).padStart(1, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
  }, [state, transport]);

  const inspectorPattern = useMemo(() => {
    if (inspector.type !== 'pattern' && inspector.type !== 'pattern-step') {
      return null;
    }
    const patternId = inspector.patternId || resolvedActivePatternId;
    return patterns.find((pattern) => pattern.id === patternId) || null;
  }, [inspector, patterns, resolvedActivePatternId]);
  const inspectorStepVelocityMap = useMemo(() => getStepVelocityMap(inspectorPattern), [inspectorPattern]);

  const inspectorTrack = useMemo(() => {
    if (inspector.type !== 'track' && inspector.type !== 'clip') {
      return null;
    }
    return playlist.find((track) => track.track_id === inspector.trackId) || null;
  }, [inspector, playlist]);

  const inspectorClip = useMemo(() => {
    if (inspector.type !== 'clip' || !inspectorTrack) {
      return null;
    }
    return (inspectorTrack.clips || []).find((clip) => clip.id === inspector.clipId) || null;
  }, [inspector, inspectorTrack]);
  const selectedTrackId = useMemo(() => {
    if (inspector.type === 'track' || inspector.type === 'clip') {
      return inspector.trackId ?? null;
    }
    if ((inspector.type === 'pattern' || inspector.type === 'pattern-step') && inspector.trackId) {
      return inspector.trackId;
    }
    return null;
  }, [inspector]);
  const existingTrackIds = useMemo(() => {
    return arrangementTracks.filter((track) => track.exists).map((track) => track.track_id);
  }, [arrangementTracks]);
  const selectedTrackIdSet = useMemo(() => new Set(selectedTrackIds), [selectedTrackIds]);
  const selectedClipKeySet = useMemo(() => new Set(selectedClipKeys), [selectedClipKeys]);
  const inspectorNode = useMemo(() => {
    if (inspector.type !== 'node') {
      return null;
    }
    return projectNodes.find((node) => node.id === inspector.nodeId) || null;
  }, [inspector, projectNodes]);
  const vstNodes = useMemo(() => projectNodes.filter((node) => node?.type === 'vst_instrument'), [projectNodes]);
  const vstNodesByTrack = useMemo(() => {
    const map = new Map();
    for (const [nodeIndex, node] of vstNodes.entries()) {
      const trackId = resolveNodeTrackId(node);
      if (!Number.isInteger(trackId) || trackId <= 0) {
        continue;
      }
      if (!map.has(trackId)) {
        map.set(trackId, []);
      }
      map.get(trackId).push({
        node,
        nodeIndex,
      });
    }

    for (const [trackId, entries] of map.entries()) {
      const sorted = entries
        .slice()
        .sort((left, right) => {
          const indexDiff = resolveNodePluginIndex(left.node, left.nodeIndex) - resolveNodePluginIndex(right.node, right.nodeIndex);
          if (indexDiff !== 0) {
            return indexDiff;
          }
          return left.nodeIndex - right.nodeIndex;
        })
        .map((entry) => entry.node);
      map.set(trackId, sorted);
    }

    return map;
  }, [vstNodes]);
  const inspectorNodeParameters = useMemo(() => {
    if (!inspectorNode || inspectorNode.type !== 'vst_instrument') {
      return [];
    }

    const parameterSchema = normalizePluginParameters(inspectorNode.parameter_schema);
    const parameterValues = isObject(inspectorNode.params) ? inspectorNode.params : {};

    if (parameterSchema.length > 0) {
      return parameterSchema.map((parameter) => {
        const nextValue = Number(parameterValues[parameter.id]);
        return {
          ...parameter,
          value: Number.isFinite(nextValue) ? nextValue : Number(parameter.value) || 0,
        };
      });
    }

    return Object.entries(parameterValues)
      .filter(([id, value]) => typeof id === 'string' && id.trim() && Number.isFinite(Number(value)))
      .map(([id, value]) => ({
        id,
        name: id,
        min: 0,
        max: 1,
        value: Number(value),
      }));
  }, [inspectorNode]);

  useEffect(() => {
    if (!Number.isInteger(selectedTrackId) || selectedTrackId <= 0) {
      return;
    }
    setSelectedPluginTrackId(selectedTrackId);
  }, [selectedTrackId]);

  useEffect(() => {
    setSelectedTrackIds((previous) => {
      const available = new Set(existingTrackIds);
      const next = previous.filter((trackId) => available.has(trackId));
      return next.length === previous.length ? previous : next;
    });
  }, [existingTrackIds]);

  useEffect(() => {
    setSelectedClipKeys((previous) => {
      const next = previous.filter((key) => existingClipKeySet.has(key));
      return next.length === previous.length ? previous : next;
    });
  }, [existingClipKeySet]);

  useEffect(() => {
    setClipMuteOverrides((previous) => {
      const nextEntries = Object.entries(previous).filter(([key]) => existingClipKeySet.has(key));
      if (nextEntries.length === Object.keys(previous).length) {
        return previous;
      }
      return Object.fromEntries(nextEntries);
    });
    setClipSlipPreviewBars((previous) => {
      const nextEntries = Object.entries(previous).filter(([key]) => existingClipKeySet.has(key));
      if (nextEntries.length === Object.keys(previous).length) {
        return previous;
      }
      return Object.fromEntries(nextEntries);
    });
  }, [existingClipKeySet]);

  useEffect(() => {
    if (openTrackPluginPicker && !existingTrackIds.includes(openTrackPluginPicker.trackId)) {
      setOpenTrackPluginPicker(null);
    }
  }, [openTrackPluginPicker, existingTrackIds]);

  useEffect(() => {
    if (trackChainModalTrackId !== null && !existingTrackIds.includes(trackChainModalTrackId)) {
      setTrackChainModalTrackId(null);
    }
  }, [trackChainModalTrackId, existingTrackIds]);

  useEffect(() => {
    if (!multiSelectMode) {
      setSelectedTrackIds([]);
    }
  }, [multiSelectMode]);

  useEffect(() => {
    if (activeTab === 'Edit') {
      return;
    }
    setOpenTrackPluginPicker(null);
    setTrackChainModalTrackId(null);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'Edit') {
      return;
    }
    setDropTargetTrackId(null);
  }, [activeTab]);

  useEffect(() => {
    function clearDropTarget() {
      setDropTargetTrackId(null);
    }
    window.addEventListener('dragend', clearDropTarget);
    window.addEventListener('drop', clearDropTarget);
    return () => {
      window.removeEventListener('dragend', clearDropTarget);
      window.removeEventListener('drop', clearDropTarget);
    };
  }, []);

  const appendSystemMessage = useCallback((text) => {
    setChatMessages((previous) => [...previous, { role: 'system', text }]);
  }, []);

  const emitMutation = useCallback((eventName, payload, onSuccess) => {
    socketRef.current?.emit(eventName, payload, (result) => {
      if (result?.ok) {
        if (onSuccess) {
          onSuccess(result);
        }
        return;
      }
      appendSystemMessage(`Fehler (${eventName}): ${result?.error || 'Unbekannter Fehler'}`);
    });
  }, [appendSystemMessage]);

  useEffect(() => {
    function handlePointerDown(event) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (!target.closest('[data-track-add-menu-root="true"]')) {
        setOpenTrackMenuId(null);
      }
      if (!target.closest('[data-track-context-menu-root="true"]')) {
        setTrackContextMenu(null);
      }
      if (!target.closest('[data-track-plugin-picker-root="true"]')) {
        setOpenTrackPluginPicker(null);
      }
    }

    function handleKeyDown(event) {
      const activateToolFromShortcut = (nextTool) => {
        const normalized = EDIT_TOOL_OPTIONS.some((tool) => tool.id === nextTool) ? nextTool : DEFAULT_EDIT_TOOL;
        setEditTool(normalized);
        setToolDragOverlay(null);
        toolDragRef.current = null;
        clearToolPointerSession();
      };
      if (event.repeat) {
        return;
      }
      if (event.key === 'Escape') {
        setOpenTrackMenuId(null);
        setTrackContextMenu(null);
        setOpenTrackPluginPicker(null);
        setTrackChainModalTrackId(null);
        setToolDragOverlay(null);
        toolDragRef.current = null;
        clearToolPointerSession();
        return;
      }
      if (activeTab === 'Edit' && !isEditableTarget(event.target)) {
        const key = event.key.toLowerCase();
        if (key === 'b') {
          activateToolFromShortcut('paint');
          return;
        }
        if (key === 'd' || key === 'p') {
          activateToolFromShortcut('draw');
          return;
        }
        if (key === 'm') {
          activateToolFromShortcut('mute');
          return;
        }
        if (key === 'x') {
          activateToolFromShortcut('slice');
          return;
        }
        if (key === 'v') {
          activateToolFromShortcut('select');
          return;
        }
        if (key === 'z') {
          activateToolFromShortcut('zoom');
          return;
        }
        if (key === 'delete' || key === 'backspace') {
          if (selectedClipKeys.length > 0) {
            event.preventDefault();
            for (const keyEntry of selectedClipKeys) {
              const resolved = resolveClipSelectionKey(keyEntry);
              if (!resolved) {
                continue;
              }
              emitMutation('clip:delete', { trackId: resolved.trackId, clipId: resolved.clipId });
            }
            setSelectedClipKeys([]);
            return;
          }
        }
      }
      if ((event.key === ' ' || event.code === 'Space') && !isEditableTarget(event.target)) {
        event.preventDefault();
        if (state?.playing) {
          emitMutation('transport:pause', {});
        } else {
          emitMutation('transport:play', {});
        }
      }
    }

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeTab, state?.playing, selectedClipKeys, emitMutation]);

  useEffect(() => {
    return () => {
      if (seekAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(seekAnimationFrameRef.current);
        seekAnimationFrameRef.current = null;
      }
      if (playheadAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(playheadAnimationFrameRef.current);
        playheadAnimationFrameRef.current = null;
      }
      if (playheadPointerHandlersRef.current) {
        const { handleMove, handleUp, handleCancel } = playheadPointerHandlersRef.current;
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        window.removeEventListener('pointercancel', handleCancel);
        playheadPointerHandlersRef.current = null;
      }
      if (toolPointerHandlersRef.current) {
        const { handleMove, handleUp, handleCancel } = toolPointerHandlersRef.current;
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        window.removeEventListener('pointercancel', handleCancel);
        toolPointerHandlersRef.current = null;
      }
      if (previewStopTimeoutRef.current !== null) {
        window.clearTimeout(previewStopTimeoutRef.current);
        previewStopTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setLocalTrackNameOverrides((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const [rawTrackId, overrideName] of Object.entries(previous)) {
        const trackId = Number(rawTrackId);
        const source = playlistTrackMap.get(trackId);
        if (!source) {
          continue;
        }
        if (formatTrackName(source.name, trackId) === formatTrackName(overrideName, trackId)) {
          delete next[rawTrackId];
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [playlistTrackMap]);

  const ensureViewBars = useCallback((minimumBars) => {
    const nextMinimumBars = normalizePlaylistViewBars(minimumBars);
    setViewBars((previous) => Math.max(previous, nextMinimumBars));
  }, []);

  useEffect(() => {
    if (viewBars < minimumViewportBars) {
      setViewBars(minimumViewportBars);
    }
  }, [viewBars, minimumViewportBars]);

  useEffect(() => {
    if (activeTab !== 'Edit') {
      return;
    }
    const scrollElement = arrangementScrollRef.current;
    if (!scrollElement) {
      return;
    }

    function handleScroll() {
      const viewportEnd = scrollElement.scrollLeft + scrollElement.clientWidth;
      const totalWidth = scrollElement.scrollWidth;
      if (totalWidth <= 0) {
        return;
      }
      const visibleRatio = viewportEnd / totalWidth;
      if (visibleRatio < VIEW_EXTEND_TRIGGER_RATIO) {
        return;
      }

      const barsAtViewportEnd = Math.ceil(viewportEnd / barWidthRef.current);
      ensureViewBars(barsAtViewportEnd + VIEW_EXTEND_STEP_BARS);
    }

    scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollElement.removeEventListener('scroll', handleScroll);
    };
  }, [activeTab, ensureViewBars]);

  useEffect(() => {
    if (activeTab !== 'Edit' || !state?.playing) {
      return;
    }

    const positionBars = Number(transport?.positionBars);
    if (!Number.isFinite(positionBars)) {
      return;
    }
    if (positionBars < viewBarsRef.current - PLAYHEAD_EXTEND_MARGIN_BARS) {
      return;
    }

    ensureViewBars(positionBars + PLAYHEAD_EXTEND_MARGIN_BARS + VIEW_EXTEND_STEP_BARS);
  }, [activeTab, state?.playing, transport?.positionBars, ensureViewBars]);

  useEffect(() => {
    if (activeTab !== 'Edit') {
      return;
    }
    const scrollElement = arrangementScrollRef.current;
    if (!scrollElement) {
      return;
    }

    const renderPlayhead = () => {
      const bars = getCurrentTransportBars();
      const leftPx = clamp(
        bars * barWidthRef.current,
        0,
        timelineBarsRef.current * barWidthRef.current,
      );
      if (Math.abs(leftPx - playheadLeftPxRef.current) >= 0.05) {
        playheadLeftPxRef.current = leftPx;
        scrollElement.style.setProperty('--playhead-left-px', `${leftPx}px`);
      }
      if (
        Boolean(transportSnapshotRef.current.playing)
        && bars >= viewBarsRef.current - PLAYHEAD_EXTEND_MARGIN_BARS
      ) {
        ensureViewBars(bars + PLAYHEAD_EXTEND_MARGIN_BARS + VIEW_EXTEND_STEP_BARS);
      }
      playheadAnimationFrameRef.current = window.requestAnimationFrame(renderPlayhead);
    };

    playheadAnimationFrameRef.current = window.requestAnimationFrame(renderPlayhead);
    return () => {
      if (playheadAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(playheadAnimationFrameRef.current);
        playheadAnimationFrameRef.current = null;
      }
    };
  }, [activeTab, ensureViewBars, getCurrentTransportBars]);

  useEffect(() => {
    const selectedProjectFile = typeof state?.selectedProjectFile === 'string'
      ? state.selectedProjectFile
      : FALLBACK_STATE.selectedProjectFile;
    if (!selectedProjectFile || !socketRef.current) {
      return;
    }

    const normalizedBars = normalizePlaylistViewBars(viewBars);
    const normalizedWidth = normalizePlaylistBarWidth(barWidth);
    const normalizedShowNodes = Boolean(showTrackNodes);
    const lastSynced = lastSyncedViewRef.current;
    if (
      lastSynced.file === selectedProjectFile
      && lastSynced.bars === normalizedBars
      && Math.abs(lastSynced.width - normalizedWidth) < 0.001
      && lastSynced.showNodes === normalizedShowNodes
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      emitMutation(
        'project:update-view',
        {
          playlistViewBars: normalizedBars,
          playlistBarWidth: normalizedWidth,
          playlistShowTrackNodes: normalizedShowNodes,
        },
        () => {
          lastSyncedViewRef.current = {
            file: selectedProjectFile,
            bars: normalizedBars,
            width: normalizedWidth,
            showNodes: normalizedShowNodes,
          };
        },
      );
    }, 140);

    return () => {
      window.clearTimeout(timer);
    };
  }, [state?.selectedProjectFile, viewBars, barWidth, showTrackNodes, emitMutation]);

  const handleArrangementWheel = useCallback((event) => {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }

    const scrollElement = arrangementScrollRef.current;
    if (!scrollElement) {
      return;
    }
    event.preventDefault();

    const rect = scrollElement.getBoundingClientRect();
    const pointerX = clamp(event.clientX - rect.left, 0, rect.width);
    const currentWidth = barWidthRef.current;
    const zoomScale = Math.exp(-event.deltaY * 0.0015);
    const nextWidth = normalizePlaylistBarWidth(currentWidth * zoomScale);
    if (Math.abs(nextWidth - currentWidth) < 0.001) {
      return;
    }

    const anchorBar = (scrollElement.scrollLeft + pointerX) / currentWidth;
    setBarWidth(nextWidth);

    window.requestAnimationFrame(() => {
      const targetScrollLeft = Math.max(0, anchorBar * nextWidth - pointerX);
      scrollElement.scrollLeft = targetScrollLeft;
      const barsInView = Math.ceil((targetScrollLeft + scrollElement.clientWidth) / nextWidth) + 1;
      ensureViewBars(barsInView);
    });
  }, [ensureViewBars]);

  const scheduleTransportSeek = useCallback((nextBars) => {
    if (!Number.isFinite(nextBars)) {
      return;
    }
    pendingSeekBarsRef.current = nextBars;
    if (seekAnimationFrameRef.current !== null) {
      return;
    }
    seekAnimationFrameRef.current = window.requestAnimationFrame(() => {
      seekAnimationFrameRef.current = null;
      const bars = pendingSeekBarsRef.current;
      pendingSeekBarsRef.current = null;
      if (!Number.isFinite(bars)) {
        return;
      }
      socketRef.current?.emit('transport:seek', { positionBars: bars });
    });
  }, []);

  const seekPlayheadFromPointer = useCallback((event) => {
    const scrollElement = arrangementScrollRef.current;
    if (!scrollElement) {
      return null;
    }

    const rect = scrollElement.getBoundingClientRect();
    if (event.clientX >= rect.right - PLAYHEAD_SCRUB_EDGE_PX) {
      scrollElement.scrollLeft += PLAYHEAD_SCRUB_SCROLL_PX;
    } else if (event.clientX <= rect.left + PLAYHEAD_SCRUB_EDGE_PX) {
      scrollElement.scrollLeft = Math.max(0, scrollElement.scrollLeft - PLAYHEAD_SCRUB_SCROLL_PX);
    }

    const absoluteX = scrollElement.scrollLeft + (event.clientX - rect.left);
    const rawBars = clamp(absoluteX / barWidthRef.current, 0, MAX_TIMELINE_BARS);
    const snapped = event.shiftKey ? snapToGrid(rawBars, snapStep) : rawBars;
    const nextBars = Number(clamp(snapped, 0, MAX_TIMELINE_BARS).toFixed(6));

    setPlayheadDragBars(nextBars);
    ensureViewBars(nextBars + PLAYHEAD_EXTEND_MARGIN_BARS + VIEW_EXTEND_STEP_BARS);
    scheduleTransportSeek(nextBars);
    return nextBars;
  }, [snapStep, ensureViewBars, scheduleTransportSeek]);

  const beginPlayheadScrub = useCallback((event) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (isEditableTarget(target)) {
      return;
    }
    if (target.closest('.timeline-clip, .clip-delete, .clip-resize-handle, button, input, select, textarea')) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    seekPlayheadFromPointer(event);

    const handleMove = (moveEvent) => {
      seekPlayheadFromPointer(moveEvent);
    };

    const cleanupPlayheadHandlers = (pointerEvent) => {
      if (pointerEvent) {
        seekPlayheadFromPointer(pointerEvent);
      }
      if (playheadPointerHandlersRef.current) {
        window.removeEventListener('pointermove', playheadPointerHandlersRef.current.handleMove);
        window.removeEventListener('pointerup', playheadPointerHandlersRef.current.handleUp);
        window.removeEventListener('pointercancel', playheadPointerHandlersRef.current.handleCancel);
        playheadPointerHandlersRef.current = null;
      }
      setPlayheadDragBars(null);
    };
    const handleUp = (upEvent) => {
      cleanupPlayheadHandlers(upEvent);
    };
    const handleCancel = () => {
      cleanupPlayheadHandlers();
    };

    if (playheadPointerHandlersRef.current) {
      window.removeEventListener('pointermove', playheadPointerHandlersRef.current.handleMove);
      window.removeEventListener('pointerup', playheadPointerHandlersRef.current.handleUp);
      window.removeEventListener('pointercancel', playheadPointerHandlersRef.current.handleCancel);
    }
    playheadPointerHandlersRef.current = { handleMove, handleUp, handleCancel };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
  }, [seekPlayheadFromPointer]);

  const getTrackRowHeightPx = useCallback(() => (showTrackNodes ? 150 : 104), [showTrackNodes]);

  const getGridPointerContext = useCallback((event) => {
    const scrollElement = arrangementScrollRef.current;
    const gridElement = arrangementGridRef.current;
    if (!scrollElement || !gridElement) {
      return null;
    }
    const gridRect = gridElement.getBoundingClientRect();
    const x = scrollElement.scrollLeft + (event.clientX - gridRect.left);
    const y = scrollElement.scrollTop + (event.clientY - gridRect.top);
    const barsRaw = x / barWidthRef.current;
    const bars = Number(clamp(barsRaw, 0, MAX_TIMELINE_BARS).toFixed(6));
    const rowHeight = getTrackRowHeightPx();
    const trackIndex = Math.max(0, Math.floor(y / rowHeight));
    const resolvedTrackId = trackIndex + 1;
    return {
      x,
      y,
      bars,
      snappedBars: snapToGrid(bars, snapStep),
      trackId: resolvedTrackId,
      trackIndex,
      rowHeight,
    };
  }, [getTrackRowHeightPx, snapStep]);

  const getRenderedClip = useCallback((trackId, clip) => {
    const draft = clipDrafts[clip.id];
    if (!draft || draft.trackId !== trackId) {
      return clip;
    }
    return {
      ...clip,
      start: draft.start,
      length: draft.length,
    };
  }, [clipDrafts]);

  const getClipEntriesForTools = useCallback(() => {
    const entries = [];
    const rowHeight = getTrackRowHeightPx();
    for (const [trackIndex, track] of arrangementTracks.entries()) {
      const clips = Array.isArray(track?.clips) ? track.clips : [];
      const rowTop = trackIndex * rowHeight;
      const clipTop = rowTop + 16;
      const clipBottom = rowTop + rowHeight - 16;
      for (const clip of clips) {
        if (!isNonEmptyString(clip?.id)) {
          continue;
        }
        const renderedClip = getRenderedClip(track.track_id, clip);
        const start = Number(renderedClip?.start);
        const length = Number(renderedClip?.length);
        if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) {
          continue;
        }
        const left = start * barWidthRef.current;
        const width = Math.max(14, length * barWidthRef.current);
        entries.push({
          key: getClipSelectionKey(track.track_id, clip.id),
          trackId: track.track_id,
          trackIndex,
          clipId: clip.id,
          clip,
          renderedClip,
          left,
          right: left + width,
          top: clipTop,
          bottom: clipBottom,
        });
      }
    }
    return entries;
  }, [arrangementTracks, getTrackRowHeightPx, getRenderedClip]);

  function clearPreviewStopTimer() {
    if (previewStopTimeoutRef.current !== null) {
      window.clearTimeout(previewStopTimeoutRef.current);
      previewStopTimeoutRef.current = null;
    }
  }

  function setClipMuted(trackId, clipId, muted) {
    const key = getClipSelectionKey(trackId, clipId);
    setClipMuteOverrides((previous) => ({
      ...previous,
      [key]: Boolean(muted),
    }));
  }

  function toggleClipMuted(trackId, clipId, fallbackMuted = false) {
    const key = getClipSelectionKey(trackId, clipId);
    setClipMuteOverrides((previous) => {
      const current = Object.prototype.hasOwnProperty.call(previous, key)
        ? previous[key]
        : Boolean(fallbackMuted);
      return {
        ...previous,
        [key]: !current,
      };
    });
  }

  function applyClipSelection(keys, { additive = false, toggle = false } = {}) {
    const unique = Array.from(new Set(keys.filter((key) => isNonEmptyString(key))));
    if (toggle) {
      setSelectedClipKeys((previous) => {
        const set = new Set(previous);
        for (const key of unique) {
          if (set.has(key)) {
            set.delete(key);
          } else {
            set.add(key);
          }
        }
        return Array.from(set);
      });
      return;
    }
    if (additive) {
      setSelectedClipKeys((previous) => Array.from(new Set([...previous, ...unique])));
      return;
    }
    setSelectedClipKeys(unique);
  }

  function getClipSelectionRange() {
    const selectedSet = selectedClipKeySet;
    let entries = getClipEntriesForTools().filter((entry) => selectedSet.has(entry.key));
    if (entries.length === 0 && inspector.type === 'clip' && isNonEmptyString(inspector.clipId)) {
      const fallbackKey = getClipSelectionKey(inspector.trackId, inspector.clipId);
      entries = getClipEntriesForTools().filter((entry) => entry.key === fallbackKey);
    }
    if (entries.length === 0) {
      return null;
    }
    const start = entries.reduce((minValue, entry) => Math.min(minValue, Number(entry.renderedClip.start) || 0), Number.POSITIVE_INFINITY);
    const end = entries.reduce((maxValue, entry) => {
      const clipStart = Number(entry.renderedClip.start) || 0;
      const clipLength = Number(entry.renderedClip.length) || 0;
      return Math.max(maxValue, clipStart + clipLength);
    }, 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }
    return { start, end, entries };
  }

  function playSelectedClipsPreview() {
    const range = getClipSelectionRange();
    if (!range) {
      appendSystemMessage('Keine Clips ausgewaehlt fuer Vorschau.');
      return;
    }

    clearPreviewStopTimer();
    const durationBars = Math.max(GRID_STEP, range.end - range.start);
    const bpm = Number(state?.project?.bpm) || 128;
    const previewDurationSec = barsToSeconds(durationBars, bpm, timeSignature);
    const previewDurationMs = Math.max(60, Math.round(previewDurationSec * 1000));
    scheduleTransportSeek(range.start);
    transportPlay();
    previewStopTimeoutRef.current = window.setTimeout(() => {
      previewStopTimeoutRef.current = null;
      transportPause();
    }, previewDurationMs);
  }

  function createImportedClipFromSource(trackId, sourceClip, start, length, onCreated) {
    if (!isObject(sourceClip)) {
      appendSystemMessage('Slice nicht moeglich: ungueltiger Clip.');
      return;
    }
    const sourcePath = sourceClip.source_path ?? sourceClip.sourcePath;
    if (!isNonEmptyString(sourcePath)) {
      appendSystemMessage('Slice fuer diesen Audio-Clip nicht moeglich (fehlender source_path).');
      return;
    }
    if (!isNonEmptyString(sourceClip.source_name) || !isNonEmptyString(sourceClip.source_format)) {
      appendSystemMessage('Slice fuer diesen Clip nicht moeglich (fehlende Import-Metadaten).');
      return;
    }
    emitMutation('clip:import-file', {
      trackId,
      type: normalizeClipType(sourceClip.type) || 'audio',
      source_name: sourceClip.source_name,
      source_format: sourceClip.source_format,
      source_path: sourcePath,
      start,
      length,
      ...(isNonEmptyString(sourceClip.source_mime) ? { source_mime: sourceClip.source_mime } : {}),
      ...(Number.isInteger(sourceClip.source_size_bytes) ? { source_size_bytes: sourceClip.source_size_bytes } : {}),
      ...(Number.isFinite(Number(sourceClip.source_duration_seconds)) ? { source_duration_seconds: Number(sourceClip.source_duration_seconds) } : {}),
      ...(Array.isArray(sourceClip.waveform_peaks) && sourceClip.waveform_peaks.length > 0 ? { waveform_peaks: sourceClip.waveform_peaks } : {}),
    }, onCreated);
  }

  function splitClipAtBar(trackId, clip, splitBarsRaw, step = snapStep) {
    const clipStart = Number(clip?.start) || 0;
    const clipLength = Number(clip?.length) || 0;
    const clipEnd = clipStart + clipLength;
    const splitBars = snapToGrid(splitBarsRaw, step);
    if (splitBars <= clipStart + step || splitBars >= clipEnd - step) {
      return;
    }

    const leftLength = Math.max(step, snapToGrid(splitBars - clipStart, step));
    const rightLength = Math.max(step, snapToGrid(clipEnd - splitBars, step));
    const sourcePatternId = getPatternId(clip);
    const sourceKey = getClipSelectionKey(trackId, clip.id);
    const sourceMuted = clipMuteOverrides[sourceKey] === true;
    const sourceSlipBars = Number(clipSlipPreviewBars[sourceKey]) || 0;

    emitMutation('clip:resize', { trackId, clipId: clip.id, length: leftLength }, () => {
      const onCreated = (result) => {
        const newClipId = isNonEmptyString(result?.clipId) ? result.clipId : null;
        if (!newClipId) {
          return;
        }
        const newKey = getClipSelectionKey(trackId, newClipId);
        setClipMuteOverrides((previous) => (sourceMuted ? { ...previous, [newKey]: true } : previous));
        setClipSlipPreviewBars((previous) => (
          Number.isFinite(sourceSlipBars) && Math.abs(sourceSlipBars) > 0.0001
            ? { ...previous, [newKey]: sourceSlipBars }
            : previous
        ));
      };
      if (sourcePatternId) {
        emitMutation('clip:create', {
          trackId,
          patternId: sourcePatternId,
          start: splitBars,
          length: rightLength,
        }, onCreated);
      } else {
        createImportedClipFromSource(trackId, clip, splitBars, rightLength, onCreated);
      }
    });
  }

  function updateToolDragOverlay(mode, startPoint, currentPoint) {
    const left = Math.min(startPoint.x, currentPoint.x);
    const top = Math.min(startPoint.y, currentPoint.y);
    const width = Math.abs(currentPoint.x - startPoint.x);
    const height = Math.abs(currentPoint.y - startPoint.y);
    setToolDragOverlay({
      mode,
      left,
      top,
      width,
      height,
    });
  }

  function clearToolPointerSession() {
    if (!toolPointerHandlersRef.current) {
      return;
    }
    const { handleMove, handleUp, handleCancel } = toolPointerHandlersRef.current;
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    window.removeEventListener('pointercancel', handleCancel);
    toolPointerHandlersRef.current = null;
  }

  function beginToolPointerSession(handleMove, handleUp, handleCancel = handleUp) {
    clearToolPointerSession();
    toolPointerHandlersRef.current = { handleMove, handleUp, handleCancel };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
  }

  function handleGridPointerDown(event) {
    if (isEditableTarget(event.target)) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (event.target.closest('.timeline-clip, .clip-delete, .clip-resize-handle, button, input, select, textarea')) {
      return;
    }

    const context = getGridPointerContext(event);
    if (!context || !Number.isInteger(context.trackId) || context.trackId <= 0) {
      return;
    }

    if (editTool === 'draw') {
      event.preventDefault();
      event.stopPropagation();
      createClip(context.trackId, { start: context.snappedBars });
      return;
    }

    if (editTool === 'paint') {
      event.preventDefault();
      event.stopPropagation();
      const paintTrackId = context.trackId;
      const paintedSlots = new Set();
      const stampClip = (bars) => {
        const snappedBars = snapToGrid(Math.max(0, bars), snapStep);
        const slotKey = `${paintTrackId}:${snappedBars.toFixed(6)}`;
        if (paintedSlots.has(slotKey)) {
          return;
        }
        paintedSlots.add(slotKey);
        createClip(paintTrackId, { start: snappedBars });
      };
      stampClip(context.bars);
      const handleMove = (moveEvent) => {
        const moveContext = getGridPointerContext(moveEvent);
        if (!moveContext) {
          return;
        }
        stampClip(moveContext.bars);
      };
      const handleUp = () => {
        clearToolPointerSession();
      };
      beginToolPointerSession(handleMove, handleUp);
      return;
    }

    if (editTool === 'delete' || editTool === 'select' || editTool === 'zoom') {
      event.preventDefault();
      event.stopPropagation();
      const startPoint = { x: context.x, y: context.y };
      const mode = editTool;
      const additiveSelection = Boolean(event.shiftKey);
      const toggleSelection = Boolean(event.metaKey || event.ctrlKey);
      toolDragRef.current = {
        mode,
        startPoint,
        currentPoint: startPoint,
      };

      const handleMove = (moveEvent) => {
        const moveContext = getGridPointerContext(moveEvent);
        if (!moveContext || !toolDragRef.current) {
          return;
        }
        toolDragRef.current.currentPoint = { x: moveContext.x, y: moveContext.y };
        updateToolDragOverlay(mode, startPoint, toolDragRef.current.currentPoint);
      };
      const handleUp = (upEvent) => {
        const upContext = getGridPointerContext(upEvent);
        const dragState = toolDragRef.current;
        toolDragRef.current = null;
        clearToolPointerSession();
        setToolDragOverlay(null);
        if (!upContext || !dragState) {
          return;
        }

        const endPoint = dragState.currentPoint || { x: upContext.x, y: upContext.y };
        const left = Math.min(startPoint.x, endPoint.x);
        const right = Math.max(startPoint.x, endPoint.x);
        const top = Math.min(startPoint.y, endPoint.y);
        const bottom = Math.max(startPoint.y, endPoint.y);
        const clipEntries = getClipEntriesForTools().filter((entry) => (
          entry.left < right
          && entry.right > left
          && entry.top < bottom
          && entry.bottom > top
        ));

        if (mode === 'delete') {
          if (clipEntries.length === 0) {
            return;
          }
          for (const entry of clipEntries) {
            emitMutation('clip:delete', { trackId: entry.trackId, clipId: entry.clipId });
          }
          return;
        }

        if (mode === 'select') {
          const keys = clipEntries.map((entry) => entry.key);
          applyClipSelection(keys, { additive: additiveSelection, toggle: toggleSelection });
          return;
        }

        if (mode === 'zoom') {
          const scrollElement = arrangementScrollRef.current;
          if (!scrollElement) {
            return;
          }
          const selectionWidth = Math.abs(endPoint.x - startPoint.x);
          const currentWidth = barWidthRef.current;
          if (selectionWidth < 8) {
            const scale = upEvent.altKey ? 0.8 : 1.25;
            const pointerViewportX = upEvent.clientX - scrollElement.getBoundingClientRect().left;
            const anchorBar = (scrollElement.scrollLeft + pointerViewportX) / currentWidth;
            const nextWidth = normalizePlaylistBarWidth(currentWidth * scale);
            setBarWidth(nextWidth);
            window.requestAnimationFrame(() => {
              scrollElement.scrollLeft = Math.max(0, anchorBar * nextWidth - pointerViewportX);
              const barsInView = Math.ceil((scrollElement.scrollLeft + scrollElement.clientWidth) / nextWidth) + 1;
              ensureViewBars(barsInView);
            });
            return;
          }

          const rangeStartBars = Math.max(0, left / currentWidth);
          const rangeEndBars = Math.max(rangeStartBars + GRID_STEP, right / currentWidth);
          const rangeBars = Math.max(GRID_STEP, rangeEndBars - rangeStartBars);
          const fitWidth = normalizePlaylistBarWidth(scrollElement.clientWidth / rangeBars);
          setBarWidth(fitWidth);
          ensureViewBars(rangeEndBars + 2);
          window.requestAnimationFrame(() => {
            scrollElement.scrollLeft = Math.max(0, rangeStartBars * fitWidth);
          });
        }
      };
      beginToolPointerSession(handleMove, handleUp);
      return;
    }

    if (editTool === 'slip') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (editTool === 'slice') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    beginPlayheadScrub(event);
  }

  function transportPlay() {
    clearPreviewStopTimer();
    applyEngineTransportPayload({ playing: true, timestamp: Date.now() });
    emitMutation('transport:play', {});
  }

  function transportPause() {
    clearPreviewStopTimer();
    emitMutation('transport:pause', {});
  }

  function togglePlayPause() {
    if (state?.playing) {
      transportPause();
      return;
    }
    transportPlay();
  }

  function transportStop() {
    clearPreviewStopTimer();
    emitMutation('transport:stop', {});
  }

  function setActiveEditTool(nextTool) {
    const normalized = EDIT_TOOL_OPTIONS.some((tool) => tool.id === nextTool) ? nextTool : DEFAULT_EDIT_TOOL;
    setEditTool(normalized);
    setSlicePreviewBars(null);
    setSliceCursorPosition(null);
    setToolDragOverlay(null);
    toolDragRef.current = null;
    clearToolPointerSession();
  }

  function setBpm(value) {
    emitMutation('transport:set-bpm', { bpm: Number(value) });
  }

  function applyLocalTrackMix(trackId, patch) {
    const resolvedTrackId = Number(trackId);
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0 || !isObject(patch)) {
      return;
    }

    setState((previousState) => {
      const baseState = isObject(previousState) ? previousState : FALLBACK_STATE;
      const baseProject = isObject(baseState.project) ? baseState.project : FALLBACK_STATE.project;
      const baseMixer = Array.isArray(baseProject.mixer) ? baseProject.mixer : [];

      let found = false;
      const nextMixer = baseMixer.map((entry) => {
        const entryTrackId = Number(entry?.track_id);
        if (!Number.isInteger(entryTrackId) || entryTrackId <= 0) {
          return entry;
        }
        if (entryTrackId !== resolvedTrackId) {
          return normalizeTrackMixEntry(entry, entryTrackId);
        }
        found = true;
        return normalizeTrackMixEntry({ ...entry, ...patch, track_id: resolvedTrackId }, resolvedTrackId);
      });

      if (!found) {
        nextMixer.push(normalizeTrackMixEntry({ ...createDefaultTrackMix(resolvedTrackId), ...patch }, resolvedTrackId));
      }

      nextMixer.sort((left, right) => left.track_id - right.track_id);
      return {
        ...baseState,
        project: {
          ...baseProject,
          mixer: nextMixer,
        },
      };
    });
  }

  function setVolume(trackId, volume) {
    const resolvedVolume = normalizeVolumeValue(volume);
    applyLocalTrackMix(trackId, { volume: resolvedVolume });
    ensureTrackExists(trackId, () => {
      emitMutation('track:set-volume', { trackId, volume: resolvedVolume });
    });
  }

  function setPan(trackId, pan) {
    const resolvedPan = normalizePanValue(pan);
    applyLocalTrackMix(trackId, { pan: resolvedPan });
    ensureTrackExists(trackId, () => {
      emitMutation('track:set-pan', { trackId, pan: resolvedPan });
    });
  }

  function setVolumeDb(trackId, dbValue) {
    const resolvedVolume = fromVolumeDbInput(dbValue);
    if (resolvedVolume === null) {
      return;
    }
    setVolume(trackId, resolvedVolume);
  }

  function setPanPercent(trackId, percentValue, referencePan = 0) {
    const parsedPercent = Number(percentValue);
    if (!Number.isFinite(parsedPercent)) {
      return;
    }
    const magnitude = clamp(Math.abs(parsedPercent), 0, 100);
    if (magnitude === 0) {
      setPan(trackId, 0);
      return;
    }
    const reference = Number(referencePan);
    const sign = Number.isFinite(reference) && reference < 0 ? -1 : 1;
    setPan(trackId, (magnitude / 100) * sign);
  }

  function setMute(trackId, mute) {
    applyLocalTrackMix(trackId, { mute: Boolean(mute) });
    ensureTrackExists(trackId, () => {
      emitMutation('track:set-mute', { trackId, mute: Boolean(mute) });
    });
  }

  function setSolo(trackId, solo) {
    applyLocalTrackMix(trackId, { solo: Boolean(solo) });
    ensureTrackExists(trackId, () => {
      emitMutation('track:set-solo', { trackId, solo: Boolean(solo) });
    });
  }

  function setRecordArm(trackId, recordArmed) {
    applyLocalTrackMix(trackId, { record_armed: Boolean(recordArmed) });
    ensureTrackExists(trackId, () => {
      emitMutation('track:set-record-arm', { trackId, recordArmed: Boolean(recordArmed) });
    });
  }

  function createTrack() {
    const name = `Track ${playlist.length + 1}`;
    emitMutation('track:create', { name, chainCollapsed: false });
  }

  function insertTrackAfter(trackId) {
    const resolvedTrackId = Number(trackId);
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId < 0) {
      return;
    }
    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    let receivedAck = false;
    const timeoutId = window.setTimeout(() => {
      if (receivedAck) {
        return;
      }
      appendSystemMessage('Track-Einfuegen wurde nicht bestaetigt. Bitte Engine-Prozess neu starten.');
    }, 900);

    socket.emit('track:insert', { afterTrackId: resolvedTrackId }, (result) => {
      receivedAck = true;
      window.clearTimeout(timeoutId);
      if (!result?.ok) {
        appendSystemMessage(`Fehler (track:insert): ${result?.error || 'Unbekannter Fehler'}`);
        return;
      }
      const nextTrackId = Number(result?.trackId);
      if (Number.isInteger(nextTrackId) && nextTrackId > 0) {
        setInspector({ type: 'track', trackId: nextTrackId });
      }
    });
  }

  function duplicateTrack(trackId) {
    const resolvedTrackId = Number(trackId);
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0) {
      return;
    }
    emitMutation('track:duplicate', { trackId: resolvedTrackId }, (result) => {
      const nextTrackId = Number(result?.trackId);
      if (Number.isInteger(nextTrackId) && nextTrackId > 0) {
        setInspector({ type: 'track', trackId: nextTrackId });
      }
    });
  }

  function deleteTrack(trackId) {
    const resolvedTrackId = Number(trackId);
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0) {
      return;
    }
    const confirmed = window.confirm(`Track ${resolvedTrackId} wirklich loeschen?`);
    if (!confirmed) {
      return;
    }
    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    let receivedAck = false;
    const timeoutId = window.setTimeout(() => {
      if (receivedAck) {
        return;
      }
      appendSystemMessage('Track-Loeschen wurde nicht bestaetigt. Bitte Engine-Prozess neu starten.');
    }, 900);

    socket.emit('track:delete', { trackId: resolvedTrackId }, (result) => {
      receivedAck = true;
      window.clearTimeout(timeoutId);
      if (!result?.ok) {
        appendSystemMessage(`Fehler (track:delete): ${result?.error || 'Unbekannter Fehler'}`);
        return;
      }
      setTrackContextMenu(null);
      setSelectedTrackIds((previous) => previous.filter((id) => id !== resolvedTrackId));
      setInspector({ type: 'project' });
    });
  }

  function deleteSelectedTracks() {
    const normalized = Array.from(new Set(
      selectedTrackIds
        .map((trackId) => Number(trackId))
        .filter((trackId) => Number.isInteger(trackId) && trackId > 0),
    )).sort((left, right) => left - right);
    if (normalized.length === 0) {
      return;
    }
    const confirmed = window.confirm(`${normalized.length} Track(s) wirklich loeschen?`);
    if (!confirmed) {
      return;
    }
    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    let receivedAck = false;
    const timeoutId = window.setTimeout(() => {
      if (receivedAck) {
        return;
      }
      appendSystemMessage('Mehrfach-Loeschen wurde nicht bestaetigt. Bitte Engine-Prozess neu starten.');
    }, 900);

    socket.emit('track:bulk-delete', { trackIds: normalized }, (result) => {
      receivedAck = true;
      window.clearTimeout(timeoutId);
      if (!result?.ok) {
        appendSystemMessage(`Fehler (track:bulk-delete): ${result?.error || 'Unbekannter Fehler'}`);
        return;
      }
      setSelectedTrackIds([]);
      setInspector({ type: 'project' });
      setTrackContextMenu(null);
    });
  }

  function toggleTrackSelection(trackId) {
    const resolvedTrackId = Number(trackId);
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0) {
      return;
    }
    setSelectedTrackIds((previous) => (
      previous.includes(resolvedTrackId)
        ? previous.filter((id) => id !== resolvedTrackId)
        : [...previous, resolvedTrackId]
    ));
  }

  function openTrackContextMenu(event, trackId) {
    const resolvedTrackId = Number(trackId);
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setOpenTrackMenuId(null);
    setOpenTrackPluginPicker(null);

    const estimatedWidth = 168;
    const estimatedHeight = 126;
    let nextX = Number(event.clientX) || 0;
    let nextY = Number(event.clientY) || 0;
    if (typeof window !== 'undefined') {
      nextX = Math.min(nextX, window.innerWidth - estimatedWidth - 8);
      nextY = Math.min(nextY, window.innerHeight - estimatedHeight - 8);
    }
    setTrackContextMenu({
      trackId: resolvedTrackId,
      x: Math.max(8, nextX),
      y: Math.max(8, nextY),
    });
  }

  function renameTrack(trackId, nextName) {
    const name = formatTrackName(nextName, trackId);
    setLocalTrackNameOverrides((previous) => ({
      ...previous,
      [trackId]: name,
    }));

    if (connection !== 'online') {
      appendSystemMessage('Umbenennen lokal vorgemerkt. Engine ist noch nicht verbunden (Status: CONNECTING/OFFLINE).');
      return;
    }

    ensureTrackExists(trackId, () => {
      emitMutation('track:set-name', { trackId, name });
    });
  }

  function ensureTrackExists(trackId, onReady) {
    if (playlistTrackMap.has(trackId)) {
      onReady();
      return;
    }

    const highestExistingTrackId = playlist.reduce((maxId, track) => {
      const resolvedTrackId = Number(track?.track_id);
      return Number.isInteger(resolvedTrackId) && resolvedTrackId > maxId ? resolvedTrackId : maxId;
    }, 0);

    const missingCount = Math.max(0, trackId - highestExistingTrackId);
    if (missingCount === 0) {
      appendSystemMessage(`Track ${trackId} existiert nicht und kann nicht automatisch erstellt werden.`);
      return;
    }

    function createMissingTrack(remaining, nextId) {
      if (remaining <= 0) {
        onReady();
        return;
      }
      emitMutation('track:create', { trackId: nextId, name: `Track ${nextId}` }, () => {
        createMissingTrack(remaining - 1, nextId + 1);
      });
    }

    createMissingTrack(missingCount, highestExistingTrackId + 1);
  }

  const scanVstPlugins = useCallback((options = {}) => {
    const silent = Boolean(options.silent);
    if (!socketRef.current) {
      return;
    }

    setPluginScanPending(true);
    socketRef.current.emit('vst:scan', {}, (result) => {
      setPluginScanPending(false);

      if (!result?.ok) {
        if (!silent) {
          appendSystemMessage(`Fehler (vst:scan): ${result?.error || 'Unbekannter Fehler'}`);
        }
        return;
      }

      const plugins = normalizePluginCatalog(result.plugins);
      setAvailablePlugins(plugins);
      setSelectedPluginUid((previousUid) => {
        if (previousUid && plugins.some((plugin) => plugin.uid === previousUid)) {
          return previousUid;
        }
        const fallbackPlugin = plugins.find((plugin) => plugin.uid === FALLBACK_VST_UID);
        return fallbackPlugin?.uid || plugins[0]?.uid || FALLBACK_VST_UID;
      });

      if (!silent) {
        appendSystemMessage(`VST-Scan abgeschlossen: ${plugins.length} Plugins gefunden.`);
      }
    });
  }, [appendSystemMessage]);

  function addVst(options = {}) {
    const pluginUid = typeof options.pluginUid === 'string' && options.pluginUid.trim()
      ? options.pluginUid.trim()
      : (typeof selectedPluginUid === 'string' && selectedPluginUid.trim() ? selectedPluginUid.trim() : FALLBACK_VST_UID);
    const requestedTrackId = Number(options.trackId ?? selectedPluginTrackId ?? selectedTrackId ?? 1);
    const trackId = Number.isInteger(requestedTrackId) && requestedTrackId > 0 ? requestedTrackId : 1;
    const insertIndexRaw = Number(options.insertIndex);
    const insertIndex = Number.isInteger(insertIndexRaw) && insertIndexRaw >= 0 ? insertIndexRaw : null;

    ensureTrackExists(trackId, () => {
      setPluginLoadPending(true);
      socketRef.current?.emit('vst:add', {
        plugin_uid: pluginUid,
        track_id: trackId,
        ...(insertIndex !== null ? { insert_index: insertIndex } : {}),
      }, (result) => {
        setPluginLoadPending(false);
        if (result?.ok) {
          if (result?.nodeId) {
            setInspector({ type: 'node', nodeId: result.nodeId });
          }
          if (typeof options.onSuccess === 'function') {
            options.onSuccess(result);
          }
          return;
        }
        appendSystemMessage(`Fehler (vst:add): ${result?.error || 'Unbekannter Fehler'}`);
      });
    });
  }

  function setVstNodeParameter(node, paramId, value) {
    if (!node || node.type !== 'vst_instrument') {
      return;
    }

    const trackId = Number(node.track_id ?? node.trackId);
    const pluginIndex = Number(node.plugin_index ?? node.pluginIndex);
    const nextValue = clamp(Number(value), 0, 1);
    if (!Number.isInteger(trackId) || trackId <= 0 || !Number.isInteger(pluginIndex) || pluginIndex < 0 || !Number.isFinite(nextValue)) {
      appendSystemMessage('VST-Parameter konnte nicht gesetzt werden (ungueltige Node-Metadaten).');
      return;
    }

    emitMutation('vst:param:set', {
      nodeId: node.id,
      track_id: trackId,
      plugin_index: pluginIndex,
      param_id: paramId,
      value: nextValue,
    });
  }

  function setVstNodeBypassed(node, bypassed) {
    if (!node || node.type !== 'vst_instrument') {
      return;
    }
    const trackId = Number(node.track_id ?? node.trackId);
    const pluginIndex = Number(node.plugin_index ?? node.pluginIndex);
    if (!Number.isInteger(trackId) || trackId <= 0 || !Number.isInteger(pluginIndex) || pluginIndex < 0) {
      return;
    }
    emitMutation('vst:bypass:set', {
      nodeId: node.id,
      track_id: trackId,
      plugin_index: pluginIndex,
      bypassed: Boolean(bypassed),
    });
  }

  function setTrackChainEnabled(trackId, enabled) {
    if (!Number.isInteger(trackId) || trackId <= 0) return;
    setTrackChainEnabledOverrides((prev) => ({ ...prev, [trackId]: enabled }));
    emitMutation('track:set-chain-enabled', { trackId, enabled });
  }

  function removeVstNode(node) {
    if (!node || node.type !== 'vst_instrument') {
      return;
    }
    const pluginLabel = formatTrackChainPluginName(node.plugin || node.plugin_uid || node.id || 'Plugin');
    const confirmed = window.confirm(`Plugin "${pluginLabel}" wirklich entfernen?`);
    if (!confirmed) {
      return;
    }
    emitMutation('vst:remove', { nodeId: node.id });
  }

  function reorderTrackVstNodes(trackId, fromIndex, toIndex) {
    const resolvedTrackId = Number(trackId);
    const resolvedFromIndex = Number(fromIndex);
    const resolvedToIndex = Number(toIndex);
    if (
      !Number.isInteger(resolvedTrackId)
      || resolvedTrackId <= 0
      || !Number.isInteger(resolvedFromIndex)
      || resolvedFromIndex < 0
      || !Number.isInteger(resolvedToIndex)
      || resolvedToIndex < 0
      || resolvedFromIndex === resolvedToIndex
    ) {
      return;
    }
    emitMutation('vst:reorder', {
      track_id: resolvedTrackId,
      from_index: resolvedFromIndex,
      to_index: resolvedToIndex,
    });
  }

  function openTrackSlotPluginPicker(trackId, slotIndex, scope = 'track') {
    const resolvedTrackId = Number(trackId);
    const resolvedSlotIndex = Number(slotIndex);
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0 || !Number.isInteger(resolvedSlotIndex) || resolvedSlotIndex < 0) {
      return;
    }
    setTrackContextMenu(null);
    setOpenTrackMenuId(null);
    setOpenTrackPluginPicker({
      trackId: resolvedTrackId,
      slotIndex: resolvedSlotIndex,
      scope,
    });
    if (availablePlugins.length === 0 && !pluginScanPending) {
      scanVstPlugins({ silent: true });
    }
  }

  useEffect(() => {
    if (activeTab !== 'Node' || pluginScanPending || availablePlugins.length > 0) {
      return;
    }
    scanVstPlugins({ silent: true });
  }, [activeTab, pluginScanPending, availablePlugins.length, scanVstPlugins]);

  function saveProject() {
    const projectWithViewState = {
      ...(state?.project || {}),
      playlist_view_bars: normalizePlaylistViewBars(viewBars),
      playlist_bar_width: normalizePlaylistBarWidth(barWidth),
      playlist_show_track_nodes: normalizePlaylistShowTrackNodes(showTrackNodes),
    };

    socketRef.current?.emit('project:save', { project: projectWithViewState }, (result) => {
      const text = result?.ok
        ? `Projekt gespeichert: ${result.filePath}`
        : `Fehler beim Speichern: ${result?.error || 'Unbekannter Fehler'}`;
      appendSystemMessage(text);
    });
  }

  function saveProjectViewSettingsSilently(nextShowTrackNodes = showTrackNodes) {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    const projectWithViewState = {
      ...(state?.project || {}),
      playlist_view_bars: normalizePlaylistViewBars(viewBars),
      playlist_bar_width: normalizePlaylistBarWidth(barWidth),
      playlist_show_track_nodes: normalizePlaylistShowTrackNodes(nextShowTrackNodes),
    };
    socket.emit('project:save', { project: projectWithViewState }, (result) => {
      if (!result?.ok) {
        appendSystemMessage(`Auto-Save fehlgeschlagen: ${result?.error || 'Unbekannter Fehler'}`);
      }
    });
  }

  function submitChat(event) {
    event.preventDefault();
    const prompt = chatInput.trim();
    if (!prompt) {
      return;
    }

    setChatMessages((previous) => [...previous, { role: 'user', text: prompt }]);
    setChatInput('');

    window.setTimeout(() => {
      setChatMessages((previous) => [
        ...previous,
        {
          role: 'assistant',
          text: `MVP-Antwort: Tool-Aufruf vorgesehen fuer: "${prompt}". MCP-Bridge folgt in Phase 3.`,
        },
      ]);
    }, 280);
  }

  function createDrumPattern(onCreated) {
    emitMutation(
      'pattern:create',
      {
        type: 'drum',
        length: 16,
        swing: 0,
        steps: [
          { lane: 'Kick', index: 0, velocity: 1 },
          { lane: 'Snare', index: 4, velocity: 0.9 },
        ],
      },
      (result) => {
        const nextPatternId = result?.pattern?.id;
        if (nextPatternId) {
          setActivePatternId(nextPatternId);
          setInspector({ type: 'pattern', patternId: nextPatternId });
          if (typeof onCreated === 'function') {
            onCreated(nextPatternId);
          }
        }
      },
    );
  }

  function updatePatternMeta(patternId, patch) {
    emitMutation('pattern:update', { patternId, ...patch });
  }

  function setPatternStepVelocity(patternId, lane, index, velocity) {
    emitMutation('pattern:update-step', { patternId, lane, index, velocity });
    setInspector({ type: 'pattern-step', patternId, lane, index });
  }

  function createClip(trackId, options = {}) {
    const fallbackPatternId = options.patternId || resolvedActivePatternId || patterns[0]?.id || null;
    if (!fallbackPatternId) {
      appendSystemMessage('Kein Pattern vorhanden. Bitte zuerst ein Pattern erstellen.');
      return;
    }
    const requestedLength = Number(options.length ?? 1);
    const normalizedLength = Math.max(snapStep, snapToGrid(requestedLength, snapStep));
    const requestedStart = Number(options.start);
    const normalizedStart = Number.isFinite(requestedStart)
      ? Math.max(0, snapToGrid(requestedStart, snapStep))
      : undefined;

    ensureTrackExists(trackId, () => {
      emitMutation('clip:create', {
        trackId,
        patternId: fallbackPatternId,
        length: normalizedLength,
        ...(normalizedStart !== undefined ? { start: normalizedStart } : {}),
      });
      setInspector({ type: 'track', trackId });
    });
  }

  function createPatternAndClipOnTrackOne() {
    const clipStart = snapToGrid(Math.max(0, getCurrentTransportBars()), snapStep);
    createDrumPattern((patternId) => {
      createClip(1, {
        patternId,
        start: clipStart,
        length: 8,
      });
    });
  }

  async function importFilesToTrack(trackId, fileList, options = {}) {
    const resolvedTrackId = Number(trackId);
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0) {
      appendSystemMessage('Import fehlgeschlagen: ungueltige Track-ID.');
      return;
    }

    const files = Array.from(fileList || []);
    if (files.length === 0) {
      return;
    }

    const supported = [];
    const skippedNames = [];
    for (const file of files) {
      const imported = resolveImportedFile(file);
      if (!imported) {
        skippedNames.push(isNonEmptyString(file?.name) ? file.name.trim() : 'Unbekannte Datei');
        continue;
      }
      supported.push({ file, imported });
    }

    if (skippedNames.length > 0) {
      appendSystemMessage(`Import ignoriert (nicht unterstuetztes Format): ${skippedNames.join(', ')}`);
    }
    if (supported.length === 0) {
      return;
    }

    const requestedStart = Number(options.start);
    const baseStart = Number.isFinite(requestedStart)
      ? Math.max(0, snapToGrid(requestedStart, snapStep))
      : snapToGrid(Math.max(0, getCurrentTransportBars()), snapStep);

    async function finalizeImport() {
      let nextStart = baseStart;
      try {
        const bpm = Number(state?.project?.bpm) || 128;
        const ts = timeSignature;
        for (const { file, imported } of supported) {
          let lengthBars = DEFAULT_IMPORTED_CLIP_LENGTH;
          let sourceDurationSeconds = null;
          let waveformPeaks = [];
          let uploadResult = null;
          try {
            uploadResult = await uploadFileToEngine(file);
          } catch (uploadErr) {
            appendSystemMessage(`Upload fehlgeschlagen für "${file.name}": ${uploadErr instanceof Error ? uploadErr.message : 'unknown'}. Clip wird trotzdem angelegt.`);
          }
          if (imported.type === 'audio') {
            if (uploadResult?.duration_sec != null && uploadResult?.waveform_peaks?.length) {
              sourceDurationSeconds = Number(uploadResult.duration_sec);
              waveformPeaks = normalizeWaveformPeaks(uploadResult.waveform_peaks);
              if (Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0) {
                lengthBars = Math.max(GRID_STEP, snapToGrid(secondsToBars(sourceDurationSeconds, bpm, ts), snapStep));
              }
            } else {
              const analysis = await analyzeImportedAudioFile(file, DEFAULT_WAVEFORM_SAMPLE_COUNT);
              const durationSec = Number(analysis?.durationSec);
              sourceDurationSeconds = Number.isFinite(durationSec) && durationSec > 0 ? Number(durationSec.toFixed(6)) : null;
              waveformPeaks = normalizeWaveformPeaks(analysis?.waveformPeaks ?? []);
              if (Number.isFinite(durationSec) && durationSec > 0) {
                lengthBars = Math.max(GRID_STEP, snapToGrid(secondsToBars(durationSec, bpm, ts), snapStep));
              }
            }
          }
          emitMutation('clip:import-file', {
            trackId: resolvedTrackId,
            type: imported.type,
            source_name: imported.sourceName,
            source_format: imported.sourceFormat,
            ...(uploadResult?.path ? { source_path: uploadResult.path } : {}),
            start: nextStart,
            length: lengthBars,
            ...(imported.sourceMime ? { source_mime: imported.sourceMime } : {}),
            ...(Number.isInteger(imported.sourceSizeBytes) ? { source_size_bytes: imported.sourceSizeBytes } : {}),
            ...(sourceDurationSeconds !== null ? { source_duration_seconds: sourceDurationSeconds } : {}),
            ...(waveformPeaks.length > 0 ? { waveform_peaks: waveformPeaks } : {}),
          });
          nextStart = snapToGrid(nextStart + lengthBars, snapStep);
        }
        setInspector({ type: 'track', trackId: resolvedTrackId });
        appendSystemMessage(`${supported.length} Datei(en) auf Track ${resolvedTrackId} importiert.`);
      } catch (error) {
        appendSystemMessage(`Import fehlgeschlagen: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }

    ensureTrackExists(resolvedTrackId, () => {
      void finalizeImport();
    });
  }

  function openTrackImportPicker(trackId) {
    const resolvedTrackId = Number(trackId);
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0) {
      return;
    }
    ensureTrackExists(resolvedTrackId, () => {
      importTargetTrackIdRef.current = resolvedTrackId;
      importFileInputRef.current?.click();
    });
  }

  function handleTrackImportInputChange(event) {
    const targetTrackId = Number(importTargetTrackIdRef.current ?? selectedTrackId ?? 1);
    importTargetTrackIdRef.current = null;
    importFilesToTrack(targetTrackId, event.target.files);
    event.target.value = '';
  }

  function handleTrackFileDragOver(event, trackId) {
    if (!eventHasFilePayload(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDropTargetTrackId(trackId);
  }

  function handleTrackFileDrop(event, trackId) {
    if (!eventHasFilePayload(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setDropTargetTrackId(null);
    importFilesToTrack(trackId, event.dataTransfer.files);
  }

  const TRACK_REORDER_MIME = 'application/x-thestuu-track';

  function handleTrackRowDragStart(event, trackId) {
    event.dataTransfer.setData(TRACK_REORDER_MIME, String(trackId));
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(trackId));
    setTrackReorderDragId(trackId);
  }

  function handleTrackRowDragEnd() {
    setTrackReorderDragId(null);
    setTrackReorderDropIndex(null);
  }

  function handleTrackRowDragOver(event, trackIndex) {
    if (!event.dataTransfer.types.includes(TRACK_REORDER_MIME)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setTrackReorderDropIndex(trackIndex);
  }

  function handleTrackRowDragLeave(event, trackIndex) {
    if (trackReorderDropIndex === trackIndex) {
      setTrackReorderDropIndex(null);
    }
  }

  function handleTrackRowDrop(event, trackIndex) {
    if (!event.dataTransfer.types.includes(TRACK_REORDER_MIME)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const draggedId = Number(event.dataTransfer.getData(TRACK_REORDER_MIME));
    setTrackReorderDragId(null);
    setTrackReorderDropIndex(null);
    setDropTargetTrackId(null);
    const fromIndex = arrangementTracks.findIndex((t) => t.track_id === draggedId);
    if (fromIndex === -1 || fromIndex === trackIndex) {
      return;
    }
    emitMutation('track:reorder', { trackId: draggedId, toIndex: trackIndex });
  }

  function beginTrackNameEdit(track) {
    cancelTrackNameEditRef.current = false;
    setOpenTrackMenuId(null);
    setTrackContextMenu(null);
    setOpenTrackPluginPicker(null);
    setEditingTrackId(track.track_id);
    setEditingTrackName(formatTrackName(track.name, track.track_id));
  }

  function cancelTrackNameEdit() {
    setEditingTrackId(null);
    setEditingTrackName('');
  }

  function commitTrackNameEdit(track, value = editingTrackName) {
    const nextName = formatTrackName(value || track.name, track.track_id);
    cancelTrackNameEdit();
    renameTrack(track.track_id, nextName);
  }

  function handleTrackAddAction(trackId, actionId) {
    if (actionId === 'import') {
      openTrackImportPicker(trackId);
      setOpenTrackMenuId(null);
      setTrackContextMenu(null);
      setOpenTrackPluginPicker(null);
      return;
    }
    setOpenTrackMenuId(null);
    setTrackContextMenu(null);
    setOpenTrackPluginPicker(null);
    if (actionId === 'pattern') {
      if (trackId === 1) {
        createPatternAndClipOnTrackOne();
        return;
      }
      createClip(trackId, {
        start: snapToGrid(Math.max(0, getCurrentTransportBars()), snapStep),
      });
      return;
    }

    ensureTrackExists(trackId, () => {
      setInspector({ type: 'track', trackId });
      if (actionId === 'record') {
        appendSystemMessage(`Record fuer Track ${trackId} ist im aktuellen MVP noch nicht implementiert.`);
      }
    });
  }

  function handleTrackContextAction(track, actionId) {
    setTrackContextMenu(null);
    if (!track || !Number.isInteger(Number(track.track_id))) {
      return;
    }
    if (actionId === 'rename') {
      beginTrackNameEdit(track);
      return;
    }
    if (actionId === 'duplicate') {
      duplicateTrack(track.track_id);
      return;
    }
    if (actionId === 'delete') {
      deleteTrack(track.track_id);
    }
  }

  function beginClipInteraction(event, mode, trackId, clip) {
    event.preventDefault();
    event.stopPropagation();
    const patternId = getPatternId(clip);
    if (patternId) {
      setInspector({ type: 'pattern', patternId, trackId, clipId: clip.id });
      if (drumPatterns.some((pattern) => pattern.id === patternId)) {
        setActivePatternId(patternId);
      }
    } else {
      setInspector({ type: 'clip', trackId, clipId: clip.id });
    }
    setClipInteraction({
      mode,
      trackId,
      clipId: clip.id,
      originX: event.clientX,
      start: Number(clip.start) || 0,
      length: Number(clip.length) || 1,
    });
  }

  function beginSlipInteraction(event, trackId, clip) {
    event.preventDefault();
    event.stopPropagation();
    const clipKey = getClipSelectionKey(trackId, clip.id);
    const initialBars = Number(clipSlipPreviewBars[clipKey]) || 0;
    const originX = event.clientX;

    const handleMove = (moveEvent) => {
      const deltaBars = (moveEvent.clientX - originX) / barWidthRef.current;
      setClipSlipPreviewBars((previous) => ({
        ...previous,
        [clipKey]: Number((initialBars + deltaBars).toFixed(6)),
      }));
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }

  function handleClipPointerDown(event, trackId, clip) {
    if (event.button !== 0) {
      return;
    }

    if (editTool === 'delete') {
      event.preventDefault();
      event.stopPropagation();
      emitMutation('clip:delete', { trackId, clipId: clip.id });
      return;
    }
    if (editTool === 'mute') {
      event.preventDefault();
      event.stopPropagation();
      toggleClipMuted(trackId, clip.id, clip?.muted);
      return;
    }
    if (editTool === 'slice') {
      const context = getGridPointerContext(event);
      if (!context) {
        return;
      }
      const splitBars = snapToGrid(context.bars, sliceSnapStep);
      splitClipAtBar(trackId, clip, splitBars, sliceSnapStep);
      return;
    }
    if (editTool === 'slip') {
      beginSlipInteraction(event, trackId, clip);
      return;
    }
    if (editTool === 'select') {
      event.preventDefault();
      event.stopPropagation();
      const clipKey = getClipSelectionKey(trackId, clip.id);
      applyClipSelection([clipKey], {
        additive: event.shiftKey || event.metaKey || event.ctrlKey,
        toggle: event.metaKey || event.ctrlKey,
      });
      return;
    }

    beginClipInteraction(event, 'move', trackId, clip);
  }

  function handleClipResizePointerDown(event, trackId, clip) {
    if (editTool === 'draw' || editTool === 'paint') {
      beginClipInteraction(event, 'resize', trackId, clip);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  useEffect(() => {
    if (!clipInteraction) {
      return;
    }

    function handlePointerMove(event) {
      const deltaBars = snapToGrid((event.clientX - clipInteraction.originX) / barWidthRef.current, snapStep);
      setClipDrafts((previous) => {
        const next = { ...previous };
        if (clipInteraction.mode === 'move') {
          next[clipInteraction.clipId] = {
            trackId: clipInteraction.trackId,
            start: Math.max(0, snapToGrid(clipInteraction.start + deltaBars, snapStep)),
            length: clipInteraction.length,
          };
        } else {
          next[clipInteraction.clipId] = {
            trackId: clipInteraction.trackId,
            start: clipInteraction.start,
            length: Math.max(snapStep, snapToGrid(clipInteraction.length + deltaBars, snapStep)),
          };
        }
        return next;
      });
    }

    function handlePointerUp() {
      const draft = clipDraftsRef.current[clipInteraction.clipId];
      if (draft) {
        if (clipInteraction.mode === 'move') {
          emitMutation('clip:move', {
            trackId: clipInteraction.trackId,
            clipId: clipInteraction.clipId,
            start: draft.start,
          });
        } else {
          emitMutation('clip:resize', {
            trackId: clipInteraction.trackId,
            clipId: clipInteraction.clipId,
            length: draft.length,
          });
        }
      }

      setClipDrafts((previous) => {
        const next = { ...previous };
        delete next[clipInteraction.clipId];
        return next;
      });
      setClipInteraction(null);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [clipInteraction, emitMutation, snapStep]);

  const contextMenuTrack = trackContextMenu
    ? (arrangementTrackMap.get(trackContextMenu.trackId) || null)
    : null;
  const trackChainModalTrack = trackChainModalTrackId !== null
    ? (arrangementTrackMap.get(trackChainModalTrackId) || null)
    : null;
  const trackChainModalNodes = useMemo(() => {
    if (!trackChainModalTrack) {
      return [];
    }
    return vstNodesByTrack.get(trackChainModalTrack.track_id) || [];
  }, [trackChainModalTrack, vstNodesByTrack]);
  const trackChainModalSlots = useMemo(() => {
    const slotCount = Math.max(TRACK_CHAIN_MODAL_MIN_SLOTS, trackChainModalNodes.length);
    return Array.from({ length: slotCount }, (_, slotIndex) => ({
      slotIndex,
      node: trackChainModalNodes[slotIndex] || null,
    }));
  }, [trackChainModalNodes]);
  const mixTracks = useMemo(() => {
    const existingTracks = arrangementTracks.filter((track) => track.exists);
    if (existingTracks.length > 0) {
      return existingTracks;
    }
    if (arrangementTracks.length > 0) {
      return [arrangementTracks[0]];
    }
    return [];
  }, [arrangementTracks]);
  const mixMasterPeak = useMemo(() => {
    return mixTracks.reduce((maxPeak, track) => {
      const trackPeak = clamp(Number(meters[track.track_id]?.peak) || 0, 0, 1);
      return Math.max(maxPeak, trackPeak);
    }, 0);
  }, [mixTracks, meters]);
  const mixSelectedTrackId = useMemo(() => {
    if (Number.isInteger(selectedTrackId) && mixTracks.some((track) => track.track_id === selectedTrackId)) {
      return selectedTrackId;
    }
    return mixTracks[0]?.track_id ?? null;
  }, [selectedTrackId, mixTracks]);
  const mixSelectedTrack = useMemo(() => {
    if (!Number.isInteger(mixSelectedTrackId)) {
      return null;
    }
    return mixTracks.find((track) => track.track_id === mixSelectedTrackId) || null;
  }, [mixTracks, mixSelectedTrackId]);
  const mixSelectedTrackMix = useMemo(() => {
    if (!mixSelectedTrack) {
      return null;
    }
    return mixSelectedTrack.mix || createDefaultTrackMix(mixSelectedTrack.track_id);
  }, [mixSelectedTrack]);
  const mixSelectedTrackNodes = useMemo(() => {
    if (!mixSelectedTrack) {
      return [];
    }
    return vstNodesByTrack.get(mixSelectedTrack.track_id) || [];
  }, [mixSelectedTrack, vstNodesByTrack]);
  const mixSelectedTrackSlots = useMemo(() => {
    return Array.from({ length: MIXER_INSPECTOR_SLOT_COUNT }, (_, slotIndex) => ({
      slotIndex,
      node: mixSelectedTrackNodes[slotIndex] || null,
    }));
  }, [mixSelectedTrackNodes]);
  const mixSelectedTrackSlotOverflow = Math.max(0, mixSelectedTrackNodes.length - MIXER_INSPECTOR_SLOT_COUNT);
  const mixPluginPickerOpen = Boolean(
    mixSelectedTrack
      && openTrackPluginPicker
      && openTrackPluginPicker.scope === 'mix'
      && openTrackPluginPicker.trackId === mixSelectedTrack.track_id,
  );
  const showDawTopShell = activeTab === 'Edit' || activeTab === 'Mix';

  return (
    <>
    <div className={`stuu-root ${activeTab === 'Edit' ? 'edit-focus' : ''}`}>
      <input
        ref={importFileInputRef}
        type="file"
        accept={IMPORT_FILE_ACCEPT}
        multiple
        className="import-file-input-hidden"
        onChange={handleTrackImportInputChange}
      />
      <div className={`stuu-grid ${activeTab === 'Edit' ? 'edit-focus' : ''}`}>
        <aside className="panel panel-chat">
          <div className="panel-header">AI Chat</div>
          <div className="chat-list">
            {chatMessages.map((message, index) => (
              <div key={`${message.role}_${index}`} className={`chat-bubble chat-${message.role}`}>
                <strong>{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Stuu' : 'System'}:</strong>{' '}
                {message.text}
              </div>
            ))}
          </div>

          <form className="chat-form" onSubmit={submitChat}>
            <input
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Prompt an Stuu..."
            />
            <button type="submit">Send</button>
          </form>
        </aside>

        <main className={`panel panel-main ${activeTab === 'Edit' ? 'edit-focus' : ''}`}>
          {showDawTopShell ? (
            <>
              <div className="daw-menu-bar">
                <div className="daw-menu-row daw-menu-row-1">
                  <div className="daw-menu-left">
                    {DAW_MENU_ITEMS.map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>
                  <div className="daw-menu-right">
                    <span
                      className={`status status-badge ${connection === 'online' && state?.nativeTransport !== false ? 'online' : connection === 'online' ? 'no-audio' : connection}`}
                      title={
                        connection === 'offline' || connection === 'connecting'
                          ? `Engine nicht erreichbar (${enginePort}). Starte alle Dienste mit: npm run start (im Projektroot). Prüfe ob Port ${enginePort} frei ist.`
                          : connection === 'online' && state?.nativeTransport === false
                            ? 'Native-Engine nicht verbunden – kein Ton. Starte mit: npm run start (Projektroot).'
                            : undefined
                      }
                    >
                      {connection === 'online' && state?.nativeTransport !== false ? 'online' : connection === 'online' ? 'no audio' : connection}
                      <span className="status-port" title={`Engine: ${enginePort}`}>:{enginePort}</span>
                      <a
                        href={`http://127.0.0.1:${enginePort}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="status-open-icon"
                        title="Engine in neuem Tab öffnen"
                        aria-label="Engine in neuem Tab öffnen"
                      >
                        <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    </span>
                  </div>
                </div>
                <div className="daw-menu-row daw-menu-row-2 view-tab-row">
                  {TABS.map((tab) => (
                    <button
                      key={`menu_tab_${tab}`}
                      type="button"
                      className={`view-tab ${tab === activeTab ? 'active' : ''}`}
                      onClick={() => setActiveTab(tab)}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
              </div>

              <header className="main-header compact">
                <div className="daw-control-strip">
                  <div className="daw-btn-group">
                    <button
                      className={`transport-btn ${state?.playing ? 'is-pause' : 'is-play'}`}
                      onClick={togglePlayPause}
                      title={state?.playing ? 'Pause (Leertaste)' : 'Play (Leertaste)'}
                      aria-label={state?.playing ? 'Pause' : 'Play'}
                    >
                      {state?.playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                    </button>
                    <button
                      className="transport-btn is-stop"
                      onClick={transportStop}
                      title="Stop"
                      aria-label="Stop"
                    >
                      <Square size={12} aria-hidden="true" />
                    </button>
                  </div>

                  <div className="daw-btn-group">
                    <label className="bpm-field compact">
                      BPM
                      <input
                        type="number"
                        min={20}
                        max={300}
                        value={state?.project?.bpm || 128}
                        onChange={(event) => setBpm(event.target.value)}
                      />
                    </label>
                  </div>

                  <div className="daw-btn-group">
                    <label className="timesig-field compact" title="Taktart">
                      <span className="timesig-label">Takt</span>
                      <select
                        value={`${timeSignature.numerator}/${timeSignature.denominator}`}
                        onChange={(event) => {
                          const v = event.target.value;
                          const [n, d] = v.split('/').map(Number);
                          if (Number.isInteger(n) && Number.isInteger(d)) {
                            emitMutation('project:update-view', { time_signature: { numerator: n, denominator: d } });
                          }
                        }}
                        aria-label="Taktart"
                      >
                        <option value="2/4">2/4</option>
                        <option value="3/4">3/4</option>
                        <option value="4/4">4/4</option>
                        <option value="6/8">6/8</option>
                      </select>
                    </label>
                  </div>

                  <div className="daw-btn-group">
                    <label className="snap-field compact">
                      SNAP
                      <select
                        value={snapMode}
                        onChange={(event) => setSnapMode(normalizeSnapMode(event.target.value))}
                      >
                        {SNAP_MODE_OPTIONS.map((option) => (
                          <option key={`snap_option_${option.id}`} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="daw-time-readout">{timeDisplay}</div>
                </div>
              </header>
            </>
          ) : (
            <header className="main-header">
              <div className="main-header-title">
                <h1>{state?.project?.project_name || 'TheStuu Session'}</h1>
                <p>
                  Connection:{' '}
                  <span
                    className={`status status-badge ${connection === 'online' && state?.nativeTransport !== false ? 'online' : connection === 'online' ? 'no-audio' : connection}`}
                    title={
                      connection === 'offline' || connection === 'connecting'
                        ? `Engine nicht erreichbar (${enginePort}). Starte alle Dienste mit: npm run start (im Projektroot). Prüfe ob Port ${enginePort} frei ist.`
                        : connection === 'online' && state?.nativeTransport === false
                          ? 'Native-Engine nicht verbunden – kein Ton. Starte mit: npm run start (Projektroot).'
                          : undefined
                    }
                  >
                    {connection === 'online' && state?.nativeTransport !== false ? 'online' : connection === 'online' ? 'no audio' : connection}
                    <span className="status-port" title={`Engine: ${enginePort}`}>:{enginePort}</span>
                    <a href={`http://127.0.0.1:${enginePort}`} target="_blank" rel="noopener noreferrer" className="status-open-icon" title="Engine in neuem Tab öffnen" aria-label="Engine in neuem Tab öffnen">
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  </span>
                </p>
              </div>

              <div className="transport-group">
                <button
                  className={`transport-btn ${state?.playing ? 'is-pause' : 'is-play'}`}
                  onClick={togglePlayPause}
                  title={state?.playing ? 'Pause (Leertaste)' : 'Play (Leertaste)'}
                  aria-label={state?.playing ? 'Pause' : 'Play'}
                >
                  {state?.playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                </button>
                <button
                  className="transport-btn is-stop"
                  onClick={transportStop}
                  title="Stop"
                  aria-label="Stop"
                >
                  <Square size={12} aria-hidden="true" />
                </button>
                <button onClick={saveProject}>Save</button>
                <label className="bpm-field">
                  BPM
                  <input
                    type="number"
                    min={20}
                    max={300}
                    value={state?.project?.bpm || 128}
                    onChange={(event) => setBpm(event.target.value)}
                  />
                </label>
              </div>
            </header>
          )}

          <div className={`tabs-row view-tab-row ${showDawTopShell ? 'compact' : ''}`}>
            {TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                className={`view-tab ${tab === activeTab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
            {!showDawTopShell ? (
              <div className="tab-actions">
                <button onClick={createTrack}>+ Track</button>
                <button onClick={addVst}>+ VST</button>
              </div>
            ) : null}
          </div>

          <AnimatePresence mode="wait">
            <motion.section
              key={activeTab}
              className={`tab-content ${showDawTopShell ? 'tab-content-edit' : ''}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === 'Edit' ? (
                <>
                  {editTool === 'slice' && sliceCursorPosition != null
                    ? createPortal(
                        <div
                          className="slice-fake-cursor"
                          style={{
                            position: 'fixed',
                            left: sliceCursorPosition.lineLeftPx - 10,
                            top: sliceCursorPosition.clientY - 10,
                            width: 20,
                            height: 20,
                            pointerEvents: 'none',
                            zIndex: 9999,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                          aria-hidden="true"
                        >
                          <Scissors size={20} strokeWidth={2} />
                        </div>,
                        document.body,
                      )
                    : null}
                  <div
                    className={`arrangement-layout edit-tool-${editTool}`}
                    style={{
                      '--bar-width': `${barWidth}px`,
                      '--grid-micro-divisions': String(gridLineDensity.microDivisions),
                      '--grid-micro-alpha': String(gridLineDensity.microAlpha),
                      '--grid-beat-alpha': String(gridLineDensity.beatAlpha),
                      '--arrangement-tool-cursor': editTool === 'slice' && sliceCursorPosition != null ? 'none' : getEditToolCursor(editTool),
                    }}
                  >
                  <div
                    ref={arrangementBodyRef}
                    className="arrangement-body"
                    role="application"
                    aria-label="Arrangement"
                  >
                    <section className="arrangement-track-column">
                      <div className="arrangement-track-header">
                        <div className="daw-btn-group edit-tools-group" role="toolbar" aria-label="Edit Tools">
                          <button
                            type="button"
                            className="edit-tool-btn preview-btn"
                            title="Preview (spielt die aktuell ausgewaehlten Clips als Vorschau)"
                            aria-label="Preview"
                            onClick={playSelectedClipsPreview}
                          >
                            <EditToolIcon toolId="preview" />
                          </button>
                          {EDIT_TOOL_OPTIONS.map((tool) => (
                            <button
                              key={`edit_tool_${tool.id}`}
                              type="button"
                              className={`edit-tool-btn ${editTool === tool.id ? 'active' : ''}`}
                              title={getEditToolTooltip(tool)}
                              aria-label={tool.label}
                              aria-pressed={editTool === tool.id}
                              onClick={() => setActiveEditTool(tool.id)}
                            >
                              <EditToolIcon toolId={tool.id} />
                            </button>
                          ))}
                        </div>
                        <div className="arrangement-track-header-actions">
                          {multiSelectMode && selectedTrackIds.length > 0 ? (
                            <button
                              type="button"
                              className="arrangement-track-bulk-delete"
                              onClick={deleteSelectedTracks}
                              title={`Loeschen (${selectedTrackIds.length} markierte Tracks entfernen)`}
                            >
                              Loeschen ({selectedTrackIds.length})
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div className="arrangement-track-rows">
                        {arrangementTracks.map((track, trackIndex) => {
                          const meter = meters[track.track_id];
                          const hasClips = Array.isArray(track.clips) && track.clips.length > 0;
                          const isHot = hasClips && (meter?.peak || 0) > 0.12;
                          const isSelected = multiSelectMode
                            ? selectedTrackIdSet.has(track.track_id)
                            : selectedTrackId === track.track_id;
                          const isHovered = hoveredTrackId === track.track_id;
                          const isReorderDropTarget = trackReorderDropIndex === trackIndex;
                          const isReorderDragging = trackReorderDragId === track.track_id;
                          const trackNodes = vstNodesByTrack.get(track.track_id) || [];
                          const visibleChainNodes = trackNodes.slice(0, TRACK_CHAIN_VISIBLE_SLOTS);
                          const chainSlots = Array.from({ length: TRACK_CHAIN_VISIBLE_SLOTS }, (_, slotIndex) => ({
                            slotIndex,
                            node: visibleChainNodes[slotIndex] || null,
                          }));
                          return (
                            <div
                              key={`track_${track.track_id}`}
                              className={`arrangement-track-row ${isSelected ? 'active' : ''} ${isHovered ? 'hovered' : ''} ${track.exists ? '' : 'placeholder'} ${openTrackMenuId === track.track_id ? 'menu-open' : ''} ${openTrackPluginPicker && openTrackPluginPicker.scope === 'track' && openTrackPluginPicker.trackId === track.track_id ? 'picker-open' : ''} ${showTrackNodes ? 'track-chain-expanded' : 'track-chain-collapsed'} ${dropTargetTrackId === track.track_id ? 'drop-target' : ''} ${isReorderDropTarget ? 'track-reorder-drop-target' : ''} ${isReorderDragging ? 'track-reorder-dragging' : ''}`}
                              role="button"
                              tabIndex={0}
                              draggable
                              onMouseEnter={() => setHoveredTrackId(track.track_id)}
                              onMouseLeave={() => setHoveredTrackId((current) => (current === track.track_id ? null : current))}
                              onDragStart={(event) => handleTrackRowDragStart(event, track.track_id)}
                              onDragEnd={handleTrackRowDragEnd}
                              onDragOver={(event) => {
                                if (event.dataTransfer.types.includes(TRACK_REORDER_MIME)) {
                                  handleTrackRowDragOver(event, trackIndex);
                                  return;
                                }
                                handleTrackFileDragOver(event, track.track_id);
                              }}
                              onDragLeave={(event) => {
                                handleTrackRowDragLeave(event, trackIndex);
                                setDropTargetTrackId((current) => (current === track.track_id ? null : current));
                              }}
                              onDrop={(event) => {
                                if (event.dataTransfer.types.includes(TRACK_REORDER_MIME)) {
                                  handleTrackRowDrop(event, trackIndex);
                                  return;
                                }
                                handleTrackFileDrop(event, track.track_id);
                              }}
                              onClick={() => {
                                setOpenTrackMenuId(null);
                                setTrackContextMenu(null);
                                setOpenTrackPluginPicker(null);
                                if (multiSelectMode) {
                                  toggleTrackSelection(track.track_id);
                                  return;
                                }
                                setInspector({ type: 'track', trackId: track.track_id });
                              }}
                              onKeyDown={(event) => {
                                if (event.target !== event.currentTarget) {
                                  return;
                                }
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  if (multiSelectMode) {
                                    toggleTrackSelection(track.track_id);
                                    return;
                                  }
                                  setInspector({ type: 'track', trackId: track.track_id });
                                }
                              }}
                            >
                              <div
                                className="arrangement-track-head"
                                onContextMenu={(event) => openTrackContextMenu(event, track.track_id)}
                              >
                                <div className="arrangement-track-label">
                                  <button
                                    type="button"
                                    className={`arrangement-track-select-checkbox ${multiSelectMode ? 'enabled' : ''} ${selectedTrackIdSet.has(track.track_id) ? 'checked' : ''}`}
                                    aria-label={`Track ${track.track_id} ${selectedTrackIdSet.has(track.track_id) ? 'abwaehlen' : 'auswaehlen'}`}
                                    aria-pressed={selectedTrackIdSet.has(track.track_id)}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (!multiSelectMode) {
                                        setMultiSelectMode(true);
                                      }
                                      toggleTrackSelection(track.track_id);
                                    }}
                                  >
                                    <MultiSelectIcon active={selectedTrackIdSet.has(track.track_id)} />
                                  </button>
                                  <div
                                    className="arrangement-track-meter"
                                    role="img"
                                    aria-label={`Track ${track.track_id} Pegel`}
                                  >
                                    <div
                                      className="arrangement-track-meter-fill"
                                      style={{
                                        height: hasClips
                                          ? `${Math.min(100, 100 * clamp(Number(meter?.peak) || 0, 0, 1))}%`
                                          : '0%',
                                      }}
                                    />
                                  </div>
                                  <span className="arrangement-track-index">{track.track_id}</span>
                                  {editingTrackId === track.track_id ? (
                                    <input
                                      ref={trackNameInputRef}
                                      className="arrangement-track-name-input"
                                      value={editingTrackName}
                                      maxLength={TRACK_NAME_LIMIT}
                                      onChange={(event) => setEditingTrackName(event.target.value)}
                                      onClick={(event) => event.stopPropagation()}
                                      onPointerDown={(event) => event.stopPropagation()}
                                      onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                          event.preventDefault();
                                          cancelTrackNameEditRef.current = true;
                                          commitTrackNameEdit(track, event.currentTarget.value);
                                          return;
                                        }
                                        if (event.key === 'Escape') {
                                          event.preventDefault();
                                          cancelTrackNameEditRef.current = true;
                                          cancelTrackNameEdit();
                                        }
                                      }}
                                      onBlur={() => {
                                        if (cancelTrackNameEditRef.current) {
                                          cancelTrackNameEditRef.current = false;
                                          cancelTrackNameEdit();
                                          return;
                                        }
                                        commitTrackNameEdit(track);
                                      }}
                                    />
                                  ) : (
                                    <span
                                      className="arrangement-track-name"
                                      title="Doppelklick zum Umbenennen"
                                      onDoubleClick={(event) => {
                                        event.stopPropagation();
                                        beginTrackNameEdit(track);
                                      }}
                                    >
                                      {track.name}
                                    </span>
                                  )}
                                </div>
                                <div className="arrangement-track-actions" data-track-add-menu-root="true">
                                  <button
                                    type="button"
                                    className={`arrangement-track-add ${track.track_id === 1 ? 'primary' : ''} ${isHot ? 'hot' : ''}`}
                                    title={track.track_id === 1 ? 'Track 1: Record, Import oder neues Pattern + Clip' : `Track ${track.track_id}: Record, Import oder Pattern`}
                                    aria-label={`Track ${track.track_id} Aktionen`}
                                    aria-haspopup="menu"
                                    aria-expanded={openTrackMenuId === track.track_id}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setTrackContextMenu(null);
                                      setOpenTrackPluginPicker(null);
                                      const nextOpen = openTrackMenuId === track.track_id ? null : track.track_id;
                                      if (nextOpen === track.track_id) {
                                        const rect = event.currentTarget.getBoundingClientRect();
                                        setTrackAddMenuAnchor({ top: rect.top, right: rect.right, height: rect.height });
                                      }
                                      setOpenTrackMenuId(nextOpen);
                                    }}
                                  >
                                    +
                                  </button>
                                  {/* Track add menu is rendered via portal to avoid overflow clipping */}
                                </div>
                              </div>
                              <div
                                className="arrangement-track-mix"
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                              >
                                <div className="arrangement-track-toggle-group">
                                  <button
                                    type="button"
                                    className={`arrangement-track-toggle ${track.mix.mute ? 'active' : ''}`}
                                    title="Mute"
                                    aria-label="Mute"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setMute(track.track_id, !track.mix.mute);
                                    }}
                                  >
                                    <TrackMixToggleIcon action="mute" active={track.mix.mute} />
                                  </button>
                                  <button
                                    type="button"
                                    className={`arrangement-track-toggle ${track.mix.solo ? 'active' : ''}`}
                                    title="Solo"
                                    aria-label="Solo"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setSolo(track.track_id, !track.mix.solo);
                                    }}
                                  >
                                    <TrackMixToggleIcon action="solo" active={track.mix.solo} />
                                  </button>
                                  <button
                                    type="button"
                                    className={`arrangement-track-toggle record-toggle ${track.mix.record_armed ? 'active' : ''}`}
                                    title="Record Arm"
                                    aria-label="Record Arm"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setRecordArm(track.track_id, !track.mix.record_armed);
                                    }}
                                  >
                                    R
                                  </button>
                                </div>
                                <label className="arrangement-track-mini-field arrangement-track-mini-field-volume">
                                  <span>Vol</span>
                                  <input
                                    type="range"
                                    min={0}
                                    max={1.2}
                                    step={0.01}
                                    value={track.mix.volume}
                                    onChange={(event) => setVolume(track.track_id, event.target.value)}
                                  />
                                  <div className="arrangement-track-value-edit">
                                    <input
                                      type="number"
                                      className="arrangement-track-value-input"
                                      min={MIN_VOLUME_DB}
                                      max={MAX_VOLUME_DB}
                                      step={0.1}
                                      value={toVolumeDbInput(track.mix.volume)}
                                      onChange={(event) => setVolumeDb(track.track_id, event.target.value)}
                                      onClick={(event) => event.stopPropagation()}
                                      onPointerDown={(event) => event.stopPropagation()}
                                      aria-label={`Volume dB Track ${track.track_id}`}
                                      title={formatVolumeDbLabel(track.mix.volume)}
                                    />
                                    <span>dB</span>
                                  </div>
                                </label>
                                <label className="arrangement-track-mini-field arrangement-track-mini-field-pan">
                                  <span>Pan</span>
                                  <div className="arrangement-track-pan-range">
                                    <em>L</em>
                                    <span
                                      className="arrangement-pan-slider-shell"
                                      style={getPanFillRange(track.mix.pan)}
                                    >
                                      <input
                                        type="range"
                                        className="arrangement-pan-slider"
                                        min={-1}
                                        max={1}
                                        step={0.01}
                                        value={track.mix.pan}
                                        onChange={(event) => setPan(track.track_id, event.target.value)}
                                      />
                                    </span>
                                    <em>R</em>
                                  </div>
                                  <div className="arrangement-track-value-edit">
                                    <input
                                      type="number"
                                      className="arrangement-track-value-input"
                                      min={0}
                                      max={100}
                                      step={1}
                                      value={toPanMagnitudePercent(track.mix.pan)}
                                      onChange={(event) => setPanPercent(track.track_id, event.target.value, track.mix.pan)}
                                      onClick={(event) => event.stopPropagation()}
                                      onPointerDown={(event) => event.stopPropagation()}
                                      aria-label={`Pan Wert Track ${track.track_id}`}
                                    />
                                    <span>{getPanSideLabel(track.mix.pan)}</span>
                                  </div>
                                </label>
                              </div>
                              {showTrackNodes ? (
                                <div
                                  className={`arrangement-track-chain ${track.chain_enabled !== false ? '' : 'chain-disabled'}`}
                                  onClick={(event) => event.stopPropagation()}
                                  onPointerDown={(event) => event.stopPropagation()}
                                >
                                  <div className="arrangement-track-chain-rail" data-track-plugin-picker-root="true">
                                    <div className="arrangement-track-chain-flow">
                                    {chainSlots.map(({ slotIndex, node }) => {
                                      const hasNode = Boolean(node);
                                      const isBypassed = Boolean(node?.bypassed);
                                      const slotLabel = hasNode
                                        ? `${slotIndex + 1} ${formatTrackChainPluginName(node.plugin || node.plugin_uid || node.id)}`
                                        : `${slotIndex + 1}`;
                                      const isPickerOpen = Boolean(
                                        openTrackPluginPicker
                                        && openTrackPluginPicker.scope === 'track'
                                        && openTrackPluginPicker.trackId === track.track_id
                                        && openTrackPluginPicker.slotIndex === slotIndex,
                                      );
                                      return (
                                        <div
                                          key={`track_chain_${track.track_id}_${slotIndex}`}
                                          className="arrangement-track-chain-flow-segment"
                                        >
                                          <div
                                            className={`arrangement-track-chain-slot ${hasNode ? 'filled' : 'empty'} ${isBypassed ? 'bypassed' : ''}`}
                                            onDragOver={(event) => {
                                              event.preventDefault();
                                            }}
                                            onDrop={(event) => {
                                              event.preventDefault();
                                              const sourceSlotIndex = Number(event.dataTransfer.getData('text/plain'));
                                              if (
                                                !Number.isInteger(sourceSlotIndex)
                                                || sourceSlotIndex < 0
                                                || sourceSlotIndex >= trackNodes.length
                                              ) {
                                                return;
                                              }
                                              const targetSlotIndex = clamp(slotIndex, 0, Math.max(0, trackNodes.length - 1));
                                              reorderTrackVstNodes(track.track_id, sourceSlotIndex, targetSlotIndex);
                                            }}
                                          >
                                            <button
                                              type="button"
                                              className="arrangement-track-chain-slot-main compact"
                                              draggable={hasNode}
                                              title={hasNode ? `${slotIndex + 1}. ${node.plugin || node.plugin_uid || node.id}` : `Slot ${slotIndex + 1}: Plugin hinzufuegen`}
                                              onDragStart={(event) => {
                                                if (!hasNode) {
                                                  return;
                                                }
                                                event.dataTransfer.effectAllowed = 'move';
                                                event.dataTransfer.setData('text/plain', String(slotIndex));
                                              }}
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                if (!hasNode) {
                                                  openTrackSlotPluginPicker(track.track_id, slotIndex, 'track');
                                                  return;
                                                }
                                                setInspector({ type: 'node', nodeId: node.id });
                                              }}
                                            >
                                              <span className="arrangement-track-chain-slot-label compact">{slotLabel}</span>
                                              {hasNode ? (
                                                <span
                                                  className={`arrangement-track-chain-slot-status-dot ${isBypassed ? 'bypassed' : 'active'}`}
                                                  aria-hidden="true"
                                                />
                                              ) : null}
                                            </button>
                                            {hasNode ? (
                                              <div className="arrangement-track-chain-slot-tools">
                                                <button
                                                  type="button"
                                                  className={`arrangement-track-chain-slot-bypass ${isBypassed ? 'active' : ''}`}
                                                  title={isBypassed ? 'Bypass deaktivieren' : 'Bypass aktivieren'}
                                                  aria-label={isBypassed ? 'Bypass deaktivieren' : 'Bypass aktivieren'}
                                                  onClick={(event) => {
                                                    event.stopPropagation();
                                                    setVstNodeBypassed(node, !isBypassed);
                                                  }}
                                                >
                                                  <TrackChainBypassIcon active={isBypassed} />
                                                </button>
                                                <button
                                                  type="button"
                                                  className="arrangement-track-chain-slot-remove"
                                                  title="Plugin entfernen"
                                                  aria-label="Plugin entfernen"
                                                  onClick={(event) => {
                                                    event.stopPropagation();
                                                    removeVstNode(node);
                                                  }}
                                                >
                                                  x
                                                </button>
                                              </div>
                                            ) : null}

                                            {isPickerOpen ? (
                                              <div
                                                className="arrangement-track-plugin-picker"
                                                role="menu"
                                                aria-label={`Track ${track.track_id} Plugin-Auswahl`}
                                                data-track-plugin-picker-root="true"
                                              >
                                                {availablePlugins.length === 0 ? (
                                                  <button
                                                    type="button"
                                                    className="arrangement-track-plugin-picker-item muted"
                                                    onClick={(event) => {
                                                      event.stopPropagation();
                                                      scanVstPlugins();
                                                    }}
                                                  >
                                                    {pluginScanPending ? 'Scanne Plugins...' : 'Plugins scannen'}
                                                  </button>
                                                ) : availablePlugins.map((plugin) => (
                                                  <button
                                                    key={`track_chain_picker_${track.track_id}_${slotIndex}_${plugin.uid}`}
                                                    type="button"
                                                    className="arrangement-track-plugin-picker-item"
                                                    disabled={pluginLoadPending}
                                                    onClick={(event) => {
                                                      event.stopPropagation();
                                                      addVst({
                                                        trackId: track.track_id,
                                                        pluginUid: plugin.uid,
                                                        insertIndex: slotIndex,
                                                        onSuccess: () => setOpenTrackPluginPicker(null),
                                                      });
                                                    }}
                                                  >
                                                    <span>{plugin.name}</span>
                                                    <small>{plugin.type}</small>
                                                  </button>
                                                ))}
                                              </div>
                                            ) : null}
                                          </div>
                                          {slotIndex < TRACK_CHAIN_VISIBLE_SLOTS - 1 ? (
                                            <span className="arrangement-track-chain-connector" aria-hidden="true">
                                              <TrackChainArrowIcon />
                                            </span>
                                          ) : null}
                                        </div>
                                      );
                                    })}
                                  </div>

                                    <div className="arrangement-track-chain-rail-buttons">
                                      <button
                                        type="button"
                                        className="arrangement-track-chain-open-inline"
                                        title={`Track ${track.track_id} Node-Editor oeffnen`}
                                        aria-label={`Track ${track.track_id} Node-Editor oeffnen`}
                                        onPointerDown={(event) => {
                                          event.stopPropagation();
                                          event.preventDefault();
                                          setOpenTrackMenuId(null);
                                          setTrackContextMenu(null);
                                          setOpenTrackPluginPicker(null);
                                          setTrackChainModalTrackId(track.track_id);
                                        }}
                                      >
                                        <TrackChainOpenIcon />
                                      </button>
                                      <button
                                        type="button"
                                        className={`arrangement-track-chain-enable ${track.chain_enabled ? 'enabled' : 'disabled'}`}
                                        title={track.chain_enabled ? 'Effektkette aus (Leistung sparen)' : 'Effektkette ein'}
                                        aria-label={track.chain_enabled ? 'Effektkette aus' : 'Effektkette ein'}
                                        onPointerDown={(event) => {
                                          event.stopPropagation();
                                          event.preventDefault();
                                          setTrackChainEnabled(track.track_id, !track.chain_enabled);
                                        }}
                                      >
                                        <TrackChainPlugIcon />
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ) : null}
                              <button
                                type="button"
                                className="arrangement-track-insert-button"
                                aria-label={`Track nach ${track.track_id} einfuegen`}
                                title={`Track nach ${track.track_id} einfuegen`}
                                onPointerDown={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  insertTrackAfter(track.track_id);
                                }}
                              >
                                +
                              </button>
                            </div>
                          );
                        })}
                      </div>
                      {contextMenuTrack && trackContextMenu ? (
                        <div
                          className="arrangement-track-context-menu"
                          role="menu"
                          aria-label={`Track ${contextMenuTrack.track_id} Kontextmenue`}
                          data-track-context-menu-root="true"
                          style={{
                            left: `${trackContextMenu.x}px`,
                            top: `${trackContextMenu.y}px`,
                          }}
                        >
                          {TRACK_CONTEXT_MENU_ITEMS.map((item) => (
                            <button
                              key={`track_context_${item.id}`}
                              type="button"
                              role="menuitem"
                              className="arrangement-track-context-item"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleTrackContextAction(contextMenuTrack, item.id);
                              }}
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </section>

                    <section className="arrangement-canvas">
                      <div
                        ref={arrangementScrollRef}
                        className="arrangement-scroll"
                        onWheel={handleArrangementWheel}
                      >
                        <div
                          className="timeline-ruler"
                          style={{ width: `${timelineWidth}px`, minWidth: '100%' }}
                          onPointerDown={beginPlayheadScrub}
                        >
                          <div className="timeline-ruler-time-row" aria-hidden="true">
                            {timeMarkers.map(({ seconds, leftPx, label }) => (
                              <div
                                key={`time_${seconds}`}
                                className="timeline-ruler-time-marker"
                                style={{ left: `${leftPx}px` }}
                              >
                                {label}
                              </div>
                            ))}
                          </div>
                          <div className="timeline-ruler-bar-row">
                            {Array.from({ length: timelineBars }, (_, index) => (
                              <div key={`bar_${index + 1}`} className="timeline-ruler-cell">
                                {index + 1}
                              </div>
                            ))}
                          </div>
                          <div className="timeline-playhead" />
                        </div>

                        <div
                          ref={arrangementGridRef}
                          className={`arrangement-grid${editTool === 'slice' && sliceCursorPosition != null ? ' arrangement-grid-slice-cursor' : ''}`}
                          style={{ width: `${timelineWidth}px`, minWidth: '100%' }}
                          onPointerDown={handleGridPointerDown}
                          onPointerMove={(event) => {
                            if (editTool === 'slice') {
                              const context = getGridPointerContext(event);
                              if (context) {
                                const snapped = snapToGrid(context.bars, sliceSnapStep);
                                setSlicePreviewBars(snapped);
                                const gridEl = arrangementGridRef.current;
                                const scrollEl = arrangementScrollRef.current;
                                if (gridEl && scrollEl && Number.isFinite(snapped)) {
                                  const gridRect = gridEl.getBoundingClientRect();
                                  const scrollLeft = scrollEl.scrollLeft || 0;
                                  const lineLeftPx = gridRect.left + (snapped * barWidth) - scrollLeft;
                                  setSliceCursorPosition({ lineLeftPx, clientY: event.clientY });
                                }
                              }
                            }
                          }}
                          onPointerLeave={() => {
                            if (editTool === 'slice') {
                              setSlicePreviewBars(null);
                              setSliceCursorPosition(null);
                            }
                          }}
                          onContextMenu={(event) => {
                            if (editTool === 'zoom') {
                              event.preventDefault();
                            }
                          }}
                        >
                          {editTool === 'slice' && slicePreviewBars != null && Number.isFinite(slicePreviewBars) ? (
                            <div
                              className="timeline-slice-line"
                              style={{
                                left: `${slicePreviewBars * barWidth}px`,
                              }}
                              aria-hidden="true"
                            />
                          ) : null}
                          {arrangementTracks.map((track) => {
                            const clips = Array.isArray(track.clips) ? track.clips : [];
                            const isSelected = multiSelectMode
                              ? selectedTrackIdSet.has(track.track_id)
                              : selectedTrackId === track.track_id;
                            const isHovered = hoveredTrackId === track.track_id;
                            return (
                              <div
                                key={`lane_${track.track_id}`}
                                className={`arrangement-grid-row ${isSelected ? 'active' : ''} ${isHovered ? 'hovered' : ''} ${showTrackNodes ? 'track-chain-expanded' : 'track-chain-collapsed'} ${dropTargetTrackId === track.track_id ? 'drop-target' : ''}`}
                                onMouseEnter={() => setHoveredTrackId(track.track_id)}
                                onMouseLeave={() => setHoveredTrackId((current) => (current === track.track_id ? null : current))}
                                onDragOver={(event) => handleTrackFileDragOver(event, track.track_id)}
                                onDragLeave={() => setDropTargetTrackId((current) => (current === track.track_id ? null : current))}
                                onDrop={(event) => handleTrackFileDrop(event, track.track_id)}
                                onDoubleClick={() => {
                                  if (editTool !== 'draw' && editTool !== 'paint') {
                                    return;
                                  }
                                  createClip(track.track_id, { start: snapToGrid(Math.max(0, getCurrentTransportBars()), snapStep) });
                                }}
                              >
                                <div className="timeline-row-playhead" />
                                {clips.map((clip) => {
                                  const renderedClip = getRenderedClip(track.track_id, clip);
                                  const patternId = getPatternId(renderedClip);
                                  const clipLabel = getClipDisplayLabel(renderedClip);
                                  const clipType = normalizeClipType(renderedClip?.type);
                                  const clipStart = Number(renderedClip.start) || 0;
                                  const clipLength = Number(renderedClip.length) || 1;
                                  const clipLeft = clipStart * barWidth;
                                  const clipWidth = Math.max(14, clipLength * barWidth);
                                  const clipKey = getClipSelectionKey(track.track_id, clip.id);
                                  const isClipSelected = selectedClipKeySet.has(clipKey);
                                  const isClipMuted = clipMuteOverrides[clipKey] === true || renderedClip?.muted === true;
                                  const slipPreviewBars = Number(clipSlipPreviewBars[clipKey]) || 0;
                                  const slipPreviewPx = Number((slipPreviewBars * barWidth).toFixed(3));
                                  const showSlipBadge = Math.abs(slipPreviewBars) >= 0.02;
                                  const slipLabel = `${slipPreviewBars >= 0 ? '+' : ''}${slipPreviewBars.toFixed(2)}`;
                                  const rawPeaks = clipType === 'audio' ? getClipWaveformPeaks(renderedClip) : [];
                                  const waveformPeaks = clipType === 'audio'
                                    ? getAdaptiveWaveformPeaks(rawPeaks.length > 0 ? rawPeaks : PLACEHOLDER_WAVEFORM_PEAKS, clipWidth)
                                    : [];
                                  const waveformPolygonPoints = waveformPeaks.length > 0 ? getWaveformPolygonPoints(waveformPeaks) : '';
                                  const audioMissingFile = clipType === 'audio' && !(renderedClip?.source_path || renderedClip?.sourcePath);

                                  return (
                                    <div
                                      key={clip.id}
                                      className={`timeline-clip ${clipType ? `clip-type-${clipType}` : ''} ${audioMissingFile ? 'clip-missing-file' : ''} ${isClipSelected ? 'clip-selected' : ''} ${isClipMuted ? 'clip-muted' : ''}`}
                                      style={{
                                        left: `${clipLeft}px`,
                                        width: `${clipWidth}px`,
                                        '--clip-slip-shift-px': `${slipPreviewPx}px`,
                                      }}
                                      title={audioMissingFile ? 'Datei fehlt – Abspielen nicht möglich. Bitte erneut importieren.' : undefined}
                                      onClick={() => {
                                        if (editTool === 'select') {
                                          applyClipSelection([clipKey], {
                                            additive: false,
                                            toggle: false,
                                          });
                                        }
                                        setInspector({ type: 'clip', trackId: track.track_id, clipId: clip.id });
                                        if (patternId) {
                                          setInspector({ type: 'pattern', patternId, trackId: track.track_id, clipId: clip.id });
                                          if (drumPatterns.some((pattern) => pattern.id === patternId)) {
                                            setActivePatternId(patternId);
                                          }
                                        }
                                      }}
                                      onPointerDown={(event) => handleClipPointerDown(event, track.track_id, renderedClip)}
                                    >
                                      {clipType === 'audio' ? (
                                        <>
                                          <div className="timeline-clip-label-bar">
                                            <span className="timeline-clip-label" title={clipLabel}>{clipLabel}</span>
                                            {showSlipBadge ? (
                                              <span className="timeline-clip-slip-badge" title={`Slip: ${slipLabel} Bars`}>
                                                {slipLabel}
                                              </span>
                                            ) : null}
                                            {audioMissingFile ? (
                                              <span className="timeline-clip-missing-badge" title="Datei fehlt – kein Abspielen">!</span>
                                            ) : null}
                                            <button
                                              className="clip-delete"
                                              onPointerDown={(event) => event.stopPropagation()}
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                emitMutation('clip:delete', { trackId: track.track_id, clipId: clip.id });
                                              }}
                                            >
                                              x
                                            </button>
                                          </div>
                                          <div className="timeline-clip-waveform-wrap">
                                            <div
                                              className={`timeline-clip-waveform ${waveformPolygonPoints ? 'has-waveform' : 'is-empty'}`}
                                              aria-hidden="true"
                                            >
                                              {waveformPolygonPoints ? (
                                                <svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
                                                  <line className="timeline-clip-waveform-center" x1="0" y1="50" x2="100" y2="50" />
                                                  <polygon className="timeline-clip-waveform-shape" points={waveformPolygonPoints} />
                                                </svg>
                                              ) : null}
                                            </div>
                                            <div
                                              className="clip-resize-handle"
                                              onPointerDown={(event) => {
                                                handleClipResizePointerDown(event, track.track_id, renderedClip);
                                              }}
                                            />
                                          </div>
                                        </>
                                      ) : (
                                        <>
                                          {audioMissingFile ? (
                                            <span className="timeline-clip-missing-badge" title="Datei fehlt – kein Abspielen">!</span>
                                          ) : null}
                                          <span className="timeline-clip-label" title={clipLabel}>{clipLabel}</span>
                                          {showSlipBadge ? (
                                            <span className="timeline-clip-slip-badge" title={`Slip: ${slipLabel} Bars`}>
                                              {slipLabel}
                                            </span>
                                          ) : null}
                                          <button
                                            className="clip-delete"
                                            onPointerDown={(event) => event.stopPropagation()}
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              emitMutation('clip:delete', { trackId: track.track_id, clipId: clip.id });
                                            }}
                                          >
                                            x
                                          </button>
                                          <div
                                            className="clip-resize-handle"
                                            onPointerDown={(event) => {
                                              handleClipResizePointerDown(event, track.track_id, renderedClip);
                                            }}
                                          />
                                        </>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                          {toolDragOverlay ? (
                            <div
                              className={`arrangement-tool-overlay tool-${toolDragOverlay.mode}`}
                              style={{
                                left: `${toolDragOverlay.left}px`,
                                top: `${toolDragOverlay.top}px`,
                                width: `${Math.max(1, toolDragOverlay.width)}px`,
                                height: `${Math.max(1, toolDragOverlay.height)}px`,
                              }}
                            />
                          ) : null}
                        </div>
                      </div>
                    </section>
                  </div>
                  </div>
                  {trackChainModalTrack ? (
                    <div
                      className="track-chain-modal-overlay"
                      role="presentation"
                      onPointerDown={() => {
                        setTrackChainModalTrackId(null);
                        setOpenTrackPluginPicker(null);
                      }}
                    >
                      <div
                        className="track-chain-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-label={`Track ${trackChainModalTrack.track_id} Node-Kette`}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        <div className="track-chain-modal-head">
                          <h2>{`${trackChainModalTrack.name} · Node Chain`}</h2>
                          <button
                            type="button"
                            className="track-chain-modal-close"
                            onClick={() => {
                              setTrackChainModalTrackId(null);
                              setOpenTrackPluginPicker(null);
                            }}
                          >
                            Schliessen
                          </button>
                        </div>
                        <div className="track-chain-modal-list" data-track-plugin-picker-root="true">
                          {trackChainModalSlots.map(({ slotIndex, node }) => {
                            const hasNode = Boolean(node);
                            const bypassed = Boolean(node?.bypassed);
                            return (
                              <div
                                key={`track_chain_modal_slot_${trackChainModalTrack.track_id}_${slotIndex}`}
                                className={`track-chain-modal-item ${hasNode ? 'filled' : 'empty'} ${bypassed ? 'bypassed' : ''}`}
                                draggable={hasNode}
                                onClick={() => {
                                  if (!hasNode) {
                                    openTrackSlotPluginPicker(trackChainModalTrack.track_id, slotIndex, 'modal');
                                  }
                                }}
                                onDragStart={(event) => {
                                  if (!hasNode) {
                                    return;
                                  }
                                  event.dataTransfer.effectAllowed = 'move';
                                  event.dataTransfer.setData('text/plain', String(slotIndex));
                                }}
                                onDragOver={(event) => {
                                  event.preventDefault();
                                }}
                                onDrop={(event) => {
                                  event.preventDefault();
                                  const sourceIndex = Number(event.dataTransfer.getData('text/plain'));
                                  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= trackChainModalNodes.length) {
                                    return;
                                  }
                                  const targetIndex = clamp(slotIndex, 0, Math.max(0, trackChainModalNodes.length - 1));
                                  reorderTrackVstNodes(trackChainModalTrack.track_id, sourceIndex, targetIndex);
                                }}
                              >
                                <div className="track-chain-modal-item-main">
                                  <span>{slotIndex + 1}</span>
                                  <strong>{hasNode ? (node?.plugin || node?.plugin_uid || node?.id || 'Plugin') : 'Leerer Slot'}</strong>
                                </div>
                                <div className="track-chain-modal-item-actions">
                                  {hasNode ? (
                                    <>
                                      <button
                                        type="button"
                                        className={`arrangement-track-chain-slot-bypass ${bypassed ? 'active' : ''}`}
                                        onClick={() => setVstNodeBypassed(node, !bypassed)}
                                      >
                                        <TrackChainBypassIcon active={bypassed} />
                                      </button>
                                      <button
                                        type="button"
                                        className="arrangement-track-chain-slot-remove"
                                        onClick={() => removeVstNode(node)}
                                      >
                                        x
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      type="button"
                                      className="track-chain-modal-item-add"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        openTrackSlotPluginPicker(trackChainModalTrack.track_id, slotIndex, 'modal');
                                      }}
                                    >
                                      + Plugin
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <div className="track-chain-modal-footer" data-track-plugin-picker-root="true">
                          <button
                            type="button"
                            className="track-chain-modal-add"
                            onClick={() => openTrackSlotPluginPicker(trackChainModalTrack.track_id, trackChainModalNodes.length, 'modal')}
                          >
                            + Plugin
                          </button>
                          {openTrackPluginPicker
                          && openTrackPluginPicker.scope === 'modal'
                          && openTrackPluginPicker.trackId === trackChainModalTrack.track_id ? (
                            <div
                              className="arrangement-track-plugin-picker modal"
                              role="menu"
                              aria-label={`Track ${trackChainModalTrack.track_id} Plugin-Auswahl`}
                              data-track-plugin-picker-root="true"
                            >
                              {availablePlugins.length === 0 ? (
                                <button
                                  type="button"
                                  className="arrangement-track-plugin-picker-item muted"
                                  onClick={() => scanVstPlugins()}
                                >
                                  {pluginScanPending ? 'Scanne Plugins...' : 'Plugins scannen'}
                                </button>
                              ) : availablePlugins.map((plugin) => (
                                <button
                                  key={`track_chain_modal_picker_${trackChainModalTrack.track_id}_${plugin.uid}`}
                                  type="button"
                                  className="arrangement-track-plugin-picker-item"
                                  disabled={pluginLoadPending}
                                  onClick={() => {
                                    addVst({
                                      trackId: trackChainModalTrack.track_id,
                                      pluginUid: plugin.uid,
                                      insertIndex: openTrackPluginPicker.slotIndex,
                                      onSuccess: () => setOpenTrackPluginPicker(null),
                                    });
                                  }}
                                >
                                  <span>{plugin.name}</span>
                                  <small>{plugin.type}</small>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}

              {activeTab === 'Mix' ? (
                <div className="mix-layout">
                  <div className="mix-strip-scroller">
                    <div className="mix-strip-ruler" aria-hidden="true">
                      <span className="mix-strip-ruler-item master">M</span>
                      {mixTracks.map((track) => (
                        <span key={`mix_ruler_${track.track_id}`} className="mix-strip-ruler-item">
                          {track.track_id}
                        </span>
                      ))}
                    </div>
                    <div className="mix-strip-row">
                      <article className="mix-strip mix-strip-master" aria-label="Master Channel">
                        <div className="mix-strip-head">
                          <span className="mix-strip-index">M</span>
                          <strong>Master</strong>
                        </div>
                        <div className="mix-strip-meter">
                          <div className="mix-strip-meter-fill" style={{ height: `${Math.round(mixMasterPeak * 100)}%` }} />
                        </div>
                        <div className="mix-strip-db">0.0 dB</div>
                        <div className="mix-strip-route">1-2</div>
                      </article>

                      {mixTracks.map((track) => {
                        const trackMix = track.mix || createDefaultTrackMix(track.track_id);
                        const trackNodes = vstNodesByTrack.get(track.track_id) || [];
                        const meterPeak = clamp(Number(meters[track.track_id]?.peak) || 0, 0, 1);
                        const isSelected = track.track_id === mixSelectedTrackId;
                        const visibleNodes = trackNodes.slice(0, MIXER_INSPECTOR_SLOT_COUNT);
                        const overflowCount = Math.max(0, trackNodes.length - MIXER_INSPECTOR_SLOT_COUNT);

                        return (
                          <article
                            key={`mix_strip_${track.track_id}`}
                            className={`mix-strip ${isSelected ? 'active' : ''}`}
                            onClick={() => {
                              setTrackContextMenu(null);
                              setOpenTrackPluginPicker(null);
                              setInspector({ type: 'track', trackId: track.track_id });
                            }}
                            onDoubleClick={() => {
                              setTrackChainModalTrackId(track.track_id);
                            }}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setInspector({ type: 'track', trackId: track.track_id });
                              }
                            }}
                          >
                            <div className="mix-strip-head">
                              <span className="mix-strip-index">{track.track_id}</span>
                              <strong>{track.name || `Track ${track.track_id}`}</strong>
                            </div>

                            <div className="mix-strip-meter">
                              <div className="mix-strip-meter-fill" style={{ height: `${Math.round(meterPeak * 100)}%` }} />
                            </div>

                            <div className="mix-strip-toggle-row">
                              <button
                                type="button"
                                className={trackMix.mute ? 'active' : ''}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setMute(track.track_id, !trackMix.mute);
                                }}
                                title="Mute"
                                aria-label={`Track ${track.track_id} Mute`}
                              >
                                <TrackMixToggleIcon action="mute" active={trackMix.mute} />
                              </button>
                              <button
                                type="button"
                                className={trackMix.solo ? 'active' : ''}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSolo(track.track_id, !trackMix.solo);
                                }}
                                title="Solo"
                                aria-label={`Track ${track.track_id} Solo`}
                              >
                                <TrackMixToggleIcon action="solo" active={trackMix.solo} />
                              </button>
                              <button
                                type="button"
                                className={`record-toggle ${trackMix.record_armed ? 'active' : ''}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setRecordArm(track.track_id, !trackMix.record_armed);
                                }}
                                title="Record Arm"
                                aria-label={`Track ${track.track_id} Record Arm`}
                              >
                                R
                              </button>
                            </div>

                            <label className="mix-strip-pan">
                              <span>PAN</span>
                              <input
                                type="range"
                                min={-1}
                                max={1}
                                step={0.01}
                                value={trackMix.pan}
                                onChange={(event) => setPan(track.track_id, event.target.value)}
                                onPointerDown={(event) => event.stopPropagation()}
                              />
                              <strong>{`${toPanMagnitudePercent(trackMix.pan)} ${getPanSideLabel(trackMix.pan)}`}</strong>
                            </label>

                            <div className="mix-strip-fader-wrap">
                              <input
                                type="range"
                                className="mix-strip-fader"
                                min={0}
                                max={1.2}
                                step={0.01}
                                value={trackMix.volume}
                                onChange={(event) => setVolume(track.track_id, event.target.value)}
                                onPointerDown={(event) => event.stopPropagation()}
                              />
                            </div>
                            <div className="mix-strip-db">{formatVolumeDbLabel(trackMix.volume)}</div>

                            <div className="mix-strip-slot-row">
                              {Array.from({ length: MIXER_INSPECTOR_SLOT_COUNT }, (_, slotIndex) => {
                                const node = visibleNodes[slotIndex] || null;
                                const bypassed = Boolean(node?.bypassed);
                                return (
                                  <span
                                    key={`mix_strip_slot_${track.track_id}_${slotIndex}`}
                                    className={`mix-strip-slot-dot ${node ? 'filled' : ''} ${bypassed ? 'bypassed' : ''}`}
                                    title={node ? `${slotIndex + 1}. ${node.plugin || node.plugin_uid || node.id}` : `Slot ${slotIndex + 1} leer`}
                                  />
                                );
                              })}
                              {overflowCount > 0 ? <span className="mix-strip-slot-overflow">+{overflowCount}</span> : null}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </div>

                  <aside className="mix-channel-inspector" data-track-plugin-picker-root="true">
                    {mixSelectedTrack && mixSelectedTrackMix ? (
                      <>
                        <div className="mix-channel-inspector-head">
                          <h3>{mixSelectedTrack.name || `Track ${mixSelectedTrack.track_id}`}</h3>
                          <p>{`Track ${mixSelectedTrack.track_id} · Nodes ${mixSelectedTrackNodes.length}`}</p>
                        </div>

                        <div className="mix-channel-inspector-controls">
                          <div className="mix-channel-toggle-row">
                            <button
                              type="button"
                              className={mixSelectedTrackMix.mute ? 'active' : ''}
                              onClick={() => setMute(mixSelectedTrack.track_id, !mixSelectedTrackMix.mute)}
                            >
                              <TrackMixToggleIcon action="mute" active={mixSelectedTrackMix.mute} />
                            </button>
                            <button
                              type="button"
                              className={mixSelectedTrackMix.solo ? 'active' : ''}
                              onClick={() => setSolo(mixSelectedTrack.track_id, !mixSelectedTrackMix.solo)}
                            >
                              <TrackMixToggleIcon action="solo" active={mixSelectedTrackMix.solo} />
                            </button>
                            <button
                              type="button"
                              className={`record-toggle ${mixSelectedTrackMix.record_armed ? 'active' : ''}`}
                              onClick={() => setRecordArm(mixSelectedTrack.track_id, !mixSelectedTrackMix.record_armed)}
                            >
                              R
                            </button>
                            <button
                              type="button"
                              className={`mix-chain-enabled-toggle ${mixSelectedTrack.chain_enabled ? 'active' : ''}`}
                              onClick={() => setTrackChainEnabled(mixSelectedTrack.track_id, !mixSelectedTrack.chain_enabled)}
                              title={mixSelectedTrack.chain_enabled ? 'Effektkette aus' : 'Effektkette ein'}
                            >
                              FX
                            </button>
                          </div>

                          <label className="mix-channel-field">
                            VOL
                            <div className="mix-channel-field-body">
                              <input
                                type="range"
                                min={0}
                                max={1.2}
                                step={0.01}
                                value={mixSelectedTrackMix.volume}
                                onChange={(event) => setVolume(mixSelectedTrack.track_id, event.target.value)}
                              />
                              <input
                                type="number"
                                min={MIN_VOLUME_DB}
                                max={MAX_VOLUME_DB}
                                step={0.1}
                                value={toVolumeDbInput(mixSelectedTrackMix.volume)}
                                onChange={(event) => setVolumeDb(mixSelectedTrack.track_id, event.target.value)}
                              />
                              <span>dB</span>
                            </div>
                          </label>

                          <label className="mix-channel-field">
                            PAN
                            <div className="mix-channel-field-body">
                              <input
                                type="range"
                                min={-1}
                                max={1}
                                step={0.01}
                                value={mixSelectedTrackMix.pan}
                                onChange={(event) => setPan(mixSelectedTrack.track_id, event.target.value)}
                              />
                              <input
                                type="number"
                                min={0}
                                max={100}
                                step={1}
                                value={toPanMagnitudePercent(mixSelectedTrackMix.pan)}
                                onChange={(event) => setPanPercent(mixSelectedTrack.track_id, event.target.value, mixSelectedTrackMix.pan)}
                              />
                              <span>{getPanSideLabel(mixSelectedTrackMix.pan)}</span>
                            </div>
                          </label>
                        </div>

                        <div className="mix-channel-slots">
                          {mixSelectedTrackSlots.map(({ slotIndex, node }) => {
                            const hasNode = Boolean(node);
                            const bypassed = Boolean(node?.bypassed);
                            return (
                              <div
                                key={`mix_channel_slot_${mixSelectedTrack.track_id}_${slotIndex}`}
                                className={`mix-channel-slot ${hasNode ? 'filled' : 'empty'} ${bypassed ? 'bypassed' : ''}`}
                                draggable={hasNode}
                                onDragStart={(event) => {
                                  if (!hasNode) {
                                    return;
                                  }
                                  event.dataTransfer.effectAllowed = 'move';
                                  event.dataTransfer.setData('text/plain', String(slotIndex));
                                }}
                                onDragOver={(event) => {
                                  event.preventDefault();
                                }}
                                onDrop={(event) => {
                                  event.preventDefault();
                                  const sourceIndex = Number(event.dataTransfer.getData('text/plain'));
                                  if (
                                    !Number.isInteger(sourceIndex)
                                    || sourceIndex < 0
                                    || sourceIndex >= mixSelectedTrackNodes.length
                                  ) {
                                    return;
                                  }
                                  const targetIndex = clamp(slotIndex, 0, Math.max(0, mixSelectedTrackNodes.length - 1));
                                  reorderTrackVstNodes(mixSelectedTrack.track_id, sourceIndex, targetIndex);
                                }}
                              >
                                <span className="mix-channel-slot-index">{`Slot ${slotIndex + 1}`}</span>
                                <button
                                  type="button"
                                  className="mix-channel-slot-main"
                                  onClick={() => {
                                    if (!hasNode) {
                                      openTrackSlotPluginPicker(mixSelectedTrack.track_id, slotIndex, 'mix');
                                      return;
                                    }
                                    setInspector({ type: 'node', nodeId: node.id });
                                  }}
                                >
                                  {hasNode
                                    ? formatTrackChainPluginName(node.plugin || node.plugin_uid || node.id || 'Plugin')
                                    : 'Leerer Slot'}
                                </button>
                                <div className="mix-channel-slot-actions">
                                  <span
                                    className={`mix-channel-slot-led ${hasNode ? 'filled' : ''} ${bypassed ? 'bypassed' : ''}`}
                                    title={hasNode ? (bypassed ? 'Bypassed' : 'Aktiv') : 'Leer'}
                                  />
                                  {hasNode ? (
                                    <>
                                      <button
                                        type="button"
                                        className={`mix-channel-slot-bypass ${bypassed ? 'active' : ''}`}
                                        onClick={() => setVstNodeBypassed(node, !bypassed)}
                                        title={bypassed ? 'Bypass aus' : 'Bypass an'}
                                      >
                                        <TrackChainBypassIcon active={bypassed} />
                                      </button>
                                      <button
                                        type="button"
                                        className="mix-channel-slot-remove"
                                        onClick={() => removeVstNode(node)}
                                        title="Plugin entfernen"
                                      >
                                        x
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      type="button"
                                      className="mix-channel-slot-add"
                                      onClick={() => openTrackSlotPluginPicker(mixSelectedTrack.track_id, slotIndex, 'mix')}
                                    >
                                      +
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        <div className="mix-channel-inspector-footer">
                          <button
                            type="button"
                            className="mix-channel-add-plugin"
                            onClick={() => openTrackSlotPluginPicker(mixSelectedTrack.track_id, mixSelectedTrackNodes.length, 'mix')}
                          >
                            + Plugin
                          </button>
                          <button
                            type="button"
                            className="mix-channel-open-nodes"
                            onClick={() => {
                              setTrackChainModalTrackId(mixSelectedTrack.track_id);
                            }}
                          >
                            Node Modal
                          </button>
                          {mixSelectedTrackSlotOverflow > 0 ? (
                            <span className="mix-channel-slot-overflow">{`+${mixSelectedTrackSlotOverflow} weitere Slots`}</span>
                          ) : null}
                        </div>

                        {mixPluginPickerOpen ? (
                          <div className="mix-channel-plugin-picker" role="menu" aria-label="Plugin Auswahl">
                            {availablePlugins.length === 0 ? (
                              <button
                                type="button"
                                className="mix-channel-plugin-picker-item muted"
                                onClick={() => scanVstPlugins()}
                              >
                                {pluginScanPending ? 'Scanne Plugins...' : 'Plugins scannen'}
                              </button>
                            ) : availablePlugins.map((plugin) => (
                              <button
                                key={`mix_channel_picker_${mixSelectedTrack.track_id}_${plugin.uid}`}
                                type="button"
                                className="mix-channel-plugin-picker-item"
                                disabled={pluginLoadPending}
                                onClick={() => {
                                  addVst({
                                    trackId: mixSelectedTrack.track_id,
                                    pluginUid: plugin.uid,
                                    insertIndex: openTrackPluginPicker?.slotIndex,
                                    onSuccess: () => setOpenTrackPluginPicker(null),
                                  });
                                }}
                              >
                                <span>{plugin.name}</span>
                                <small>{plugin.type}</small>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className="muted">Kein Track fuer Mix-Ansicht verfuegbar.</p>
                    )}
                  </aside>
                </div>
              ) : null}
            </motion.section>
          </AnimatePresence>
        </main>

        <aside className="panel panel-inspector">
          <div className="panel-header">Inspector</div>
          <p className="muted">
            {inspector.type === 'project' && 'Aktives Projekt'}
            {inspector.type === 'track' && `Track #${inspector.trackId}`}
            {inspector.type === 'clip' && `Clip ${inspector.clipId}`}
            {inspector.type === 'node' && `Node ${inspector.nodeId}`}
            {(inspector.type === 'pattern' || inspector.type === 'pattern-step') && `Pattern ${inspectorPattern?.id || ''}`}
          </p>

          {(inspector.type === 'pattern' || inspector.type === 'pattern-step') && inspectorPattern ? (
            <div className="inspector-form">
              <label>
                Pattern
                <select
                  value={inspectorPattern.id}
                  onChange={(event) => {
                    setInspector({ type: 'pattern', patternId: event.target.value });
                    setActivePatternId(event.target.value);
                  }}
                >
                  {patterns.map((pattern) => (
                    <option key={pattern.id} value={pattern.id}>
                      {pattern.id} ({pattern.type})
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Laenge
                <select
                  value={inspectorPattern.length}
                  onChange={(event) => updatePatternMeta(inspectorPattern.id, { length: Number(event.target.value) })}
                >
                  {[8, 16, 32, 64].map((value) => (
                    <option key={`length_${value}`} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Swing ({Number(inspectorPattern.swing || 0).toFixed(2)})
                <input
                  type="range"
                  min={0}
                  max={0.75}
                  step={0.01}
                  value={inspectorPattern.swing || 0}
                  onChange={(event) => updatePatternMeta(inspectorPattern.id, { swing: Number(event.target.value) })}
                />
              </label>

              {inspector.type === 'pattern-step' ? (
                <div className="inspector-step-block">
                  <p>
                    Step {(inspector.index || 0) + 1} · {inspector.lane}
                  </p>
                  <div className="step-velocity-buttons">
                    <button
                      className={(inspectorStepVelocityMap.get(`${inspector.lane}:${inspector.index}`) || 0) === 0 ? 'active' : ''}
                      onClick={() => setPatternStepVelocity(inspectorPattern.id, inspector.lane, inspector.index, 0)}
                    >
                      Off
                    </button>
                    <button
                      className={Math.abs((inspectorStepVelocityMap.get(`${inspector.lane}:${inspector.index}`) || 0) - 0.55) < 0.05 ? 'active' : ''}
                      onClick={() => setPatternStepVelocity(inspectorPattern.id, inspector.lane, inspector.index, 0.55)}
                    >
                      Soft
                    </button>
                    <button
                      className={Math.abs((inspectorStepVelocityMap.get(`${inspector.lane}:${inspector.index}`) || 0) - 1) < 0.05 ? 'active' : ''}
                      onClick={() => setPatternStepVelocity(inspectorPattern.id, inspector.lane, inspector.index, 1)}
                    >
                      Accent
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {inspector.type === 'track' && inspectorTrack ? (
            <div className="inspector-summary">
              <p>Name: {inspectorTrack.name}</p>
              <p>Clips: {(inspectorTrack.clips || []).length}</p>
            </div>
          ) : null}

          {inspector.type === 'clip' && inspectorClip ? (
            <div className="inspector-summary">
              <p>ID: {inspectorClip.id}</p>
              <p>Start: {Number(inspectorClip.start || 0).toFixed(2)} Bar</p>
              <p>Laenge: {Number(inspectorClip.length || 0).toFixed(2)} Bar</p>
              <p>Pattern: {getPatternId(inspectorClip) || '-'}</p>
            </div>
          ) : null}

          {inspector.type === 'node' && inspectorNode ? (
            <div className="inspector-form">
              <div className="inspector-summary">
                <p>Typ: {inspectorNode.type}</p>
                <p>Plugin: {inspectorNode.plugin || inspectorNode.plugin_uid || '-'}</p>
                <p>UID: {inspectorNode.plugin_uid || '-'}</p>
                <p>Track: {Number(inspectorNode.track_id ?? inspectorNode.trackId ?? 0) || '-'}</p>
                <p>Index: {Number(inspectorNode.plugin_index ?? inspectorNode.pluginIndex ?? 0)}</p>
              </div>

              {inspectorNode.type === 'vst_instrument' ? (
                <div className="vst-param-list">
                  {inspectorNodeParameters.length > 0 ? (
                    inspectorNodeParameters.map((parameter) => {
                      const normalizedValue = clamp(Number(parameter.value) || 0, 0, 1);
                      return (
                        <label key={`${inspectorNode.id}_${parameter.id}`} className="vst-param-row">
                          <div className="vst-param-head">
                            <span>{parameter.name}</span>
                            <span>{normalizedValue.toFixed(2)}</span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={normalizedValue}
                            onChange={(event) => setVstNodeParameter(inspectorNode, parameter.id, Number(event.target.value))}
                          />
                        </label>
                      );
                    })
                  ) : (
                    <p className="muted">Keine automatisierbaren Parameter gefunden.</p>
                  )}
                </div>
              ) : (
                <pre>{JSON.stringify(inspectorNode, null, 2)}</pre>
              )}
            </div>
          ) : null}

          {inspector.type === 'project' ? (
            <pre>{JSON.stringify(state?.project, null, 2)}</pre>
          ) : null}
        </aside>
      </div>
    </div>
    {openTrackMenuId != null && trackAddMenuAnchor != null && (() => {
      const track = arrangementTrackMap.get(openTrackMenuId);
      if (!track) return null;
      return createPortal(
        <div
          className="arrangement-track-add-menu arrangement-track-add-menu-portal"
          data-track-add-menu-root="true"
          style={{
            position: 'fixed',
            left: trackAddMenuAnchor.right + 6,
            top: trackAddMenuAnchor.top + trackAddMenuAnchor.height / 2,
            transform: 'translateY(-50%)',
          }}
          role="menu"
          aria-label={`Track ${track.track_id} Aktionen`}
        >
          {TRACK_ADD_MENU_ITEMS.map((item) => {
            if (item.id === 'import') {
              return (
                <label
                  key={`portal_${track.track_id}_${item.id}`}
                  role="menuitem"
                  className="arrangement-track-add-item"
                >
                  <input
                    type="file"
                    accept={IMPORT_FILE_ACCEPT}
                    multiple
                    className="import-file-input-hidden"
                    onChange={(event) => {
                      handleTrackImportInputChange(event);
                      setOpenTrackMenuId(null);
                      setTrackContextMenu(null);
                      setOpenTrackPluginPicker(null);
                    }}
                  />
                  <TrackActionIcon action={item.id} />
                  <span>{item.label}</span>
                </label>
              );
            }
            return (
              <button
                key={`portal_${track.track_id}_${item.id}`}
                type="button"
                role="menuitem"
                className={`arrangement-track-add-item ${item.id === 'pattern' && track.track_id === 1 ? 'primary' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  handleTrackAddAction(track.track_id, item.id);
                }}
              >
                <TrackActionIcon action={item.id} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>,
        document.body
      );
    })()}
    </>
  );
}
