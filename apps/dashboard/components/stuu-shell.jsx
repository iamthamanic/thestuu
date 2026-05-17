'use client';

import Image from 'next/image';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
} from 'react';
import { createPortal } from 'react-dom';
import ReactFlow, { Background, Controls, MiniMap } from 'reactflow';
import {
  AudioWaveform,
  ArrowUpDown,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Disc3,
  Download,
  ExternalLink,
  Filter,
  Gauge,
  LayoutGrid,
  Mic,
  Minus,
  MousePointer2,
  MoveHorizontal,
  PaintBucket,
  Pause,
  Pencil,
  Play,
  Power,
  RotateCw,
  Scissors,
  SlidersHorizontal,
  Square,
  Trash2,
  Undo2,
  VolumeX,
  Waves,
  X,
  ZoomIn,
  Redo2,
} from 'lucide-react';
import 'reactflow/dist/style.css';
import { createEngineSocket } from '../lib/socket';
import { clipIntersectsViewport, getVisibleBarRange, trackRowIntersectsViewport } from '../lib/clip-visibility.js';
import {
  getPerformanceProfile,
  meterIntervalMsForProfile,
  setPerformanceProfile,
} from '../lib/performance-prefs.js';
import { useBindMeterSocket } from '../context/meters-context.jsx';
import MeterSubscription from './daw/meter-subscription.jsx';
import { MixMeterFlatHint } from '../context/meters-context.jsx';
import {
  ArrangementTrackLevelMeter,
  MixMasterLevelMeter,
  MixStripLevelMeter,
} from './daw/meter-ui.jsx';
import MixPlaylistOverview from './MixPlaylistOverview';
import MixStripChain from './MixStripChain';
import SongStructureAddMenu from './SongStructureAddMenu';
import SongStructureLane from './SongStructureLane';
import ConnectionStatusLogs from './connection-status-logs.jsx';
import { LIVE_LOG_LIMIT as LIVE_ENGINE_LOG_LIMIT, normalizeStructuredLogEntry } from '../lib/live-logs.js';
import { mapEngineDiagnostics } from '../lib/engine-diagnostics.js';
import SongStructureNodeModal from './SongStructureNodeModal';
import SongStructureTemplateManager from './SongStructureTemplateManager';
import { buildPlaylistOverviewPeaks } from '../lib/playlist-overview-peaks';
import {
  computeStructureStarts,
  createDefaultStructureNode,
  insertNodeAtBoundary,
  removeStructureNodeById,
  reorderStructureNodes,
  resizeNodeRight,
} from '../lib/song-structure.js';
import { normalizeMasterMix } from '@thestuu/shared-json';

function ExtractStemsIcon({ size = 24, strokeWidth = 2, ...props }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="4.5" r="2.25" />
      <path d="M3.75 12.25H20.25V16.25L14.75 20V22L9.25 23.25V20L3.75 16.25Z" />
    </svg>
  );
}

function FitToTempoIcon({ size = 24, strokeWidth = 2, ...props }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3 12H9" />
      <path d="M6.75 9.5L9.25 12L6.75 14.5" />
      <circle cx="16" cy="12" r="5.25" />
      <path d="M16 9.25V12H18.5" />
    </svg>
  );
}

const TABS = ['Edit', 'Mix'];
const DAW_MENU_ITEMS = ['FILE', 'VIEW', 'HELP', 'SETTINGS'];
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
const BEATS_PER_BAR = 4;
const SLICE_FREE_STEP = 1 / 256;
const MIN_VOLUME_DB = -80;
const MAX_VOLUME_DB = Number((20 * Math.log10(1.2)).toFixed(1));
const MIN_VISIBLE_TRACKS = 1;
const TRACK_NAME_LIMIT = 25;
const FLOATING_WINDOW_LAYOUTS_STORAGE_KEY = 'thestuu-floating-window-layouts-v1';
const FLOATING_WINDOW_MARGIN = 12;
const FLOATING_WINDOW_DOCK_HEIGHT = 46;
const FLOATING_WINDOW_DOCK_GAP = 10;
const TRACK_CHAIN_VISIBLE_SLOTS = 7;
const TRACK_CHAIN_MODAL_MIN_SLOTS = TRACK_CHAIN_VISIBLE_SLOTS;
const TRACK_CHAIN_PLUGIN_NAME_LIMIT = 14;
const FADE_CURVE_ORDER = ['linear', 'convex', 'concave', 'sCurve'];
const DEFAULT_METRONOME_ENABLED = false;
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
// Must match engine SUPPORTED_AUDIO_EXTENSIONS (wav, flac, mp3, ogg, aac, aiff, aif) – same sync/playback for all.
const IMPORTABLE_AUDIO_EXTENSIONS = new Set(['wav', 'flac', 'mp3', 'ogg', 'aac', 'aiff', 'aif']);
const IMPORTABLE_MIDI_EXTENSIONS = new Set(['mid', 'midi']);
const IMPORTABLE_EXTENSIONS = new Set([...IMPORTABLE_AUDIO_EXTENSIONS, ...IMPORTABLE_MIDI_EXTENSIONS]);
const IMPORT_FILE_ACCEPT = '.wav,.flac,.mp3,.ogg,.aac,.mid,.midi,.aiff,.aif';
const DEFAULT_IMPORTED_CLIP_LENGTH = 8;
const TIME_MARKER_INTERVAL_SECONDS = 10;
const TRACK_CONTEXT_MENU_ITEMS = [
  { id: 'rename', label: 'Umbenennen' },
  { id: 'duplicate', label: 'Duplizieren' },
  { id: 'delete', label: 'Entfernen' },
];
const CLIP_QUICK_TOOL_MENU_ITEMS = [
  { id: 'extract_stems', label: 'Extract Stems', icon: ExtractStemsIcon },
  { id: 'fit_to_tempo', label: 'Fit to Tempo', icon: FitToTempoIcon },
  { id: 'rename_and_color', label: 'Rename and Color', icon: PaintBucket },
  { id: 'analyze_bpm_key', label: 'Analyze BPM & Key', icon: Gauge },
];
const CLIP_RENAME_COLOR_SWATCHES = [
  { id: 'default', label: 'Default', color: '' },
  { id: 'sky', label: 'Sky', color: '#60a5fa' },
  { id: 'emerald', label: 'Emerald', color: '#34d399' },
  { id: 'amber', label: 'Amber', color: '#fbbf24' },
  { id: 'rose', label: 'Rose', color: '#fb7185' },
  { id: 'violet', label: 'Violet', color: '#a78bfa' },
  { id: 'cyan', label: 'Cyan', color: '#22d3ee' },
  { id: 'lime', label: 'Lime', color: '#a3e635' },
  { id: 'orange', label: 'Orange', color: '#fb923c' },
  { id: 'red', label: 'Red', color: '#f87171' },
];
const DEFAULT_SNAP_MODE = 'free';
const SNAP_MODE_OPTIONS = [
  { id: 'free', label: 'Free' },
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
  { id: 'delete', label: 'Delete', description: 'loescht Clips per Klick oder Bereich' },
  { id: 'slice', label: 'Trim', description: 'schneidet Audio- und MIDI-Clips an der Position' },
  { id: 'slip', label: 'Slip', description: 'verschiebt den Audio-Inhalt innerhalb des Clips' },
  { id: 'mute', label: 'Mute', description: 'schaltet Clips stumm oder wieder an' },
  { id: 'zoom', label: 'Zoom', description: 'zoomt in einen aufgezogenen Bereich' },
];
const CLIP_GAIN_MIN = 0;
const CLIP_GAIN_MAX = 2;
const CLIP_GAIN_DEFAULT = 1;
/** ~0.8 dB per 4px vertical drag (FL-style clip gain tab). */
const CLIP_GAIN_DB_PER_PIXEL = 0.2;
const CLIP_GAIN_DB_MIN = -80;
const CLIP_GAIN_DB_MAX = 20 * Math.log10(CLIP_GAIN_MAX);
const FADE_CURVE_DRAG_PX_PER_STEP = 28;
const FADE_CURVE_NODE_MIN_PX = 10;
/** Below this fade width (px) we treat the clip as having no fade — no curve, no handles. */
const FADE_VISIBLE_MIN_PX = 0.5;
const DEFAULT_EDIT_TOOL = 'select';
const ENGINE_BASE_URL = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://127.0.0.1:3990';

/** Safe basename for exported project JSON (no path separators or illegal filename chars). */
function sanitizeProjectJsonBasename(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const stripped = trimmed
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return stripped || '';
}

function getProjectJsonDownloadFilename(project) {
  const base = sanitizeProjectJsonBasename(project?.project_name);
  if (base) return `${base}.json`;
  return 'thestuu-project.json';
}
const TRACKTION_PLUGIN_PREVIEW_DIMENSIONS = { width: 320, height: 96 };

const TRACKTION_PLUGIN_UI_META = {
  '4bandeq': {
    icon: SlidersHorizontal,
    description: 'Equalizer: formt Bass, Mitten und Hoehen. Gut zum Aufraeumen und Feintuning.',
  },
  compressor: {
    icon: Gauge,
    description: 'Compressor/Limiter: macht Lautstaerke gleichmaessiger und bremst Spitzen.',
  },
  reverb: {
    icon: Waves,
    description: 'Reverb: gibt dem Sound Raum und Tiefe.',
  },
  delay: {
    icon: Clock3,
    description: 'Delay: erzeugt Echos und rhythmische Wiederholungen.',
  },
  chorus: {
    icon: RotateCw,
    description: 'Chorus: macht den Klang breiter und weicher.',
  },
  phaser: {
    icon: RotateCw,
    description: 'Phaser: bewegter Filtereffekt fuer mehr Bewegung im Sound.',
  },
  pitchshifter: {
    icon: ArrowUpDown,
    description: 'Pitch Shifter: veraendert die Tonhoehe des Signals.',
  },
  lowpass: {
    icon: Filter,
    description: 'Low Pass: nimmt hohe Frequenzen raus und macht den Klang dunkler.',
  },
  '4osc': {
    icon: AudioWaveform,
    description: 'Four Osc: Synthesizer mit vier Oszillatoren fuer eigene Sounds.',
  },
  sampler: {
    icon: Disc3,
    description: 'Sampler: spielt Samples auf Noten und macht sie musikalisch nutzbar.',
  },
};

const TRACKTION_GENERIC_PLUGIN_UI_META = {
  icon: LayoutGrid,
  description: 'Tracktion Plugin: Klang bearbeiten, formen oder kreativ verfeinern.',
};

const TRACKTION_PLUGIN_TOKEN_ALIASES = {
  eq4band: '4bandeq',
  fourbandeq: '4bandeq',
  foureq: '4bandeq',
  compressorlimiter: 'compressor',
  comp: 'compressor',
  echo: 'delay',
  pitchshift: 'pitchshifter',
  lowpassfilter: 'lowpass',
  lowpassfx: 'lowpass',
  lpf: 'lowpass',
  fourosc: '4osc',
  oscillator: '4osc',
};

function normalizePluginLookupToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeTracktionPluginToken(token) {
  if (!token) {
    return '';
  }
  if (TRACKTION_PLUGIN_UI_META[token]) {
    return token;
  }
  if (TRACKTION_PLUGIN_TOKEN_ALIASES[token]) {
    return TRACKTION_PLUGIN_TOKEN_ALIASES[token];
  }
  const directKey = Object.keys(TRACKTION_PLUGIN_UI_META).find((candidate) => token.includes(candidate));
  if (directKey) {
    return directKey;
  }
  const aliasKey = Object.keys(TRACKTION_PLUGIN_TOKEN_ALIASES).find((candidate) => token.includes(candidate));
  if (aliasKey) {
    return TRACKTION_PLUGIN_TOKEN_ALIASES[aliasKey];
  }
  return '';
}

function resolveTracktionPluginToken(pluginUid, pluginName) {
  const uid = typeof pluginUid === 'string' ? pluginUid.trim().toLowerCase() : '';
  if (uid.startsWith('internal:tracktion:')) {
    const token = normalizePluginLookupToken(uid.slice('internal:tracktion:'.length));
    return normalizeTracktionPluginToken(token) || token;
  }
  const name = typeof pluginName === 'string' ? pluginName.trim().toLowerCase() : '';
  if (name.startsWith('tracktion ')) {
    const token = normalizePluginLookupToken(name.slice('tracktion '.length));
    return normalizeTracktionPluginToken(token) || token;
  }
  return '';
}

function resolveTracktionPluginUiMeta(pluginUid, pluginName) {
  const token = resolveTracktionPluginToken(pluginUid, pluginName);
  if (!token) {
    return null;
  }
  const baseMeta = TRACKTION_PLUGIN_UI_META[token] || TRACKTION_GENERIC_PLUGIN_UI_META;
  if (!TRACKTION_PLUGIN_UI_META[token]) {
    return baseMeta;
  }
  const previewPluginUid = typeof pluginUid === 'string' && pluginUid.trim()
    ? pluginUid.trim()
    : `internal:tracktion:${token}`;
  return {
    ...baseMeta,
    previewSrc: `${ENGINE_BASE_URL}/plugin-preview?uid=${encodeURIComponent(previewPluginUid)}&w=${TRACKTION_PLUGIN_PREVIEW_DIMENSIONS.width}&h=${TRACKTION_PLUGIN_PREVIEW_DIMENSIONS.height}`,
    fallbackPreviewSrc: `/plugin-previews/tracktion/${token}.svg`,
    previewWidth: TRACKTION_PLUGIN_PREVIEW_DIMENSIONS.width,
    previewHeight: TRACKTION_PLUGIN_PREVIEW_DIMENSIONS.height,
  };
}

function buildPluginHelpTooltip(pluginName, pluginUiMeta) {
  const resolvedName = typeof pluginName === 'string' && pluginName.trim() ? pluginName.trim() : 'Plugin';
  if (!pluginUiMeta?.description) {
    return resolvedName;
  }
  return `${resolvedName}: ${pluginUiMeta.description}`;
}

function getPluginParameterLookupToken(parameter) {
  if (!parameter || typeof parameter !== 'object') {
    return '';
  }
  return normalizePluginLookupToken(`${parameter.id || ''} ${parameter.name || ''}`);
}

function findPluginParameterByTokenHints(parameters, hints) {
  if (!Array.isArray(parameters) || parameters.length === 0 || !Array.isArray(hints) || hints.length === 0) {
    return null;
  }

  const normalizedHints = hints
    .map((hint) => normalizePluginLookupToken(hint))
    .filter(Boolean);

  if (normalizedHints.length === 0) {
    return null;
  }

  let bestMatch = null;
  let bestScore = -1;
  for (const parameter of parameters) {
    const token = getPluginParameterLookupToken(parameter);
    if (!token) {
      continue;
    }

    let score = -1;
    for (const hint of normalizedHints) {
      if (!hint) {
        continue;
      }
      if (token === hint) {
        score = Math.max(score, 100);
      } else if (token.startsWith(hint) || token.endsWith(hint)) {
        score = Math.max(score, 80);
      } else if (token.includes(hint)) {
        score = Math.max(score, 60);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = parameter;
    }
  }

  return bestScore >= 0 ? bestMatch : null;
}

function buildTracktionEqInspectorGainParams(parameters) {
  if (!Array.isArray(parameters) || parameters.length === 0) {
    return null;
  }

  const gainParams = {
    loGain: findPluginParameterByTokenHints(parameters, ['loGain', 'lowGain']),
    midGain1: findPluginParameterByTokenHints(parameters, ['midGain1', 'mid1Gain', 'gainMid1']),
    midGain2: findPluginParameterByTokenHints(parameters, ['midGain2', 'mid2Gain', 'gainMid2']),
    hiGain: findPluginParameterByTokenHints(parameters, ['hiGain', 'highGain']),
  };

  const availableCount = Object.values(gainParams).filter(Boolean).length;
  return availableCount > 0 ? gainParams : null;
}

function getPluginParameterActualValue(parameter, fallbackNormalized = null) {
  const normalizedRaw = fallbackNormalized ?? parameter?.value;
  const normalized = clamp(Number(normalizedRaw), 0, 1);
  const min = Number(parameter?.min);
  const max = Number(parameter?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return normalized;
  }
  return min + ((max - min) * normalized);
}

function getPluginParameterNormalizedFromActual(parameter, actualValue) {
  const min = Number(parameter?.min);
  const max = Number(parameter?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return clamp(Number(actualValue), 0, 1);
  }
  const normalized = (Number(actualValue) - min) / (max - min);
  return clamp(normalized, 0, 1);
}

function deriveTracktionEqInspectorEasyMacros(gainParams) {
  if (!gainParams) {
    return { mud: 0, presence: 0, softness: 0 };
  }

  const mid1Gain = gainParams.midGain1 ? getPluginParameterActualValue(gainParams.midGain1) : 0;
  const mid2Gain = gainParams.midGain2 ? getPluginParameterActualValue(gainParams.midGain2) : 0;
  const hiGain = gainParams.hiGain ? getPluginParameterActualValue(gainParams.hiGain) : 0;

  return {
    mud: clamp((-mid1Gain) / 6, 0, 1),
    presence: clamp(mid2Gain / 5, 0, 1),
    softness: clamp((-hiGain) / 5, 0, 1),
  };
}

function isTracktionEqInspectorEffectivelyFlat(gainParams, toleranceDb = 0.15) {
  if (!gainParams || !isObject(gainParams)) {
    return true;
  }

  const gainKeys = ['loGain', 'midGain1', 'midGain2', 'hiGain'];
  let availableCount = 0;

  for (const key of gainKeys) {
    const parameter = gainParams[key];
    if (!parameter) {
      continue;
    }
    availableCount += 1;
    const actualValue = getPluginParameterActualValue(parameter);
    if (!Number.isFinite(actualValue) || Math.abs(actualValue) > toleranceDb) {
      return false;
    }
  }

  return true;
}

function buildTracktionEqInspectorEasyGainTargets(macros) {
  const mud = clamp(Number(macros?.mud) || 0, 0, 1);
  const presence = clamp(Number(macros?.presence) || 0, 0, 1);
  const softness = clamp(Number(macros?.softness) || 0, 0, 1);

  return {
    loGain: -(2.2 * mud),
    midGain1: -(6.0 * mud),
    midGain2: 5.0 * presence,
    hiGain: -(5.0 * softness),
  };
}

function buildTracktionEqInspectorPresetGainTargets(presetId) {
  switch (presetId) {
    case 'flat':
      return { loGain: 0.0, midGain1: 0.0, midGain2: 0.0, hiGain: 0.0 };
    case 'clean_up':
      return { loGain: -1.0, midGain1: -3.0, midGain2: 1.2, hiGain: 1.0 };
    case 'vocal_clarity':
      return { loGain: -1.4, midGain1: -2.5, midGain2: 3.6, hiGain: 2.4 };
    case 'bass_tight':
      return { loGain: -1.4, midGain1: -4.0, midGain2: 1.0, hiGain: 0.0 };
    case 'air_brilliance':
      return { loGain: 0.0, midGain1: -0.8, midGain2: 2.1, hiGain: 4.5 };
    default:
      return null;
  }
}

function formatTracktionEqInspectorMiniFreqLabel(hz) {
  const value = Number(hz);
  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }
  if (value >= 1000) {
    const khz = value / 1000;
    return khz >= 10 ? `${khz.toFixed(0)}k` : `${khz.toFixed(1)}k`;
  }
  return `${Math.round(value)}`;
}

function formatTracktionEqInspectorReadoutFreq(hz) {
  const value = Number(hz);
  if (!Number.isFinite(value) || value <= 0) {
    return '-';
  }
  if (value >= 1000) {
    const khz = value / 1000;
    return khz >= 10 ? `${khz.toFixed(1)} kHz` : `${khz.toFixed(2)} kHz`;
  }
  return `${Math.round(value)} Hz`;
}

function formatTracktionEqInspectorReadoutDb(db) {
  const value = Number(db);
  if (!Number.isFinite(value)) {
    return '-';
  }
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`;
}

function formatTracktionEqInspectorReadoutQ(q) {
  const value = Number(q);
  if (!Number.isFinite(value) || value <= 0) {
    return '-';
  }
  return `Q ${value.toFixed(2)}`;
}

function buildTracktionEqInspectorCurveData(parameters) {
  if (!Array.isArray(parameters) || parameters.length === 0) {
    return null;
  }

  const bandSpecs = [
    {
      id: 'low',
      label: 'Low',
      color: '#5fe28a',
      defaultFreqHz: 110,
      defaultQ: 0.75,
      freqHints: ['loFreq', 'lowFreq'],
      gainHints: ['loGain', 'lowGain'],
      qHints: ['loQ', 'lowQ'],
    },
    {
      id: 'mid1',
      label: 'Mid 1',
      color: '#74c0ff',
      defaultFreqHz: 300,
      defaultQ: 1.1,
      freqHints: ['midFreq1', 'mid1Freq', 'freqMid1'],
      gainHints: ['midGain1', 'mid1Gain', 'gainMid1'],
      qHints: ['midQ1', 'mid1Q', 'qMid1'],
    },
    {
      id: 'mid2',
      label: 'Mid 2',
      color: '#ffc658',
      defaultFreqHz: 3200,
      defaultQ: 1.15,
      freqHints: ['midFreq2', 'mid2Freq', 'freqMid2'],
      gainHints: ['midGain2', 'mid2Gain', 'gainMid2'],
      qHints: ['midQ2', 'mid2Q', 'qMid2'],
    },
    {
      id: 'high',
      label: 'High',
      color: '#ff8aa5',
      defaultFreqHz: 12000,
      defaultQ: 0.75,
      freqHints: ['hiFreq', 'highFreq'],
      gainHints: ['hiGain', 'highGain'],
      qHints: ['hiQ', 'highQ'],
    },
  ];

  const bands = bandSpecs.map((spec) => {
    const freqParam = findPluginParameterByTokenHints(parameters, spec.freqHints);
    const gainParam = findPluginParameterByTokenHints(parameters, spec.gainHints);
    const qParam = findPluginParameterByTokenHints(parameters, spec.qHints);

    const freqHz = clamp(
      freqParam ? getPluginParameterActualValue(freqParam) : spec.defaultFreqHz,
      20,
      20000,
    );
    const gainDb = clamp(
      gainParam ? getPluginParameterActualValue(gainParam) : 0,
      -18,
      18,
    );
    const qValue = Math.max(
      0.1,
      qParam ? getPluginParameterActualValue(qParam) : spec.defaultQ,
    );

    return {
      ...spec,
      freqHz,
      gainDb,
      qValue,
      freqParam,
      gainParam,
      qParam,
    };
  });

  const width = 280;
  const height = 116;
  const minFreq = 20;
  const maxFreq = 20000;
  const maxDb = 18;
  const minDb = -18;
  const log10 = (v) => Math.log(v) / Math.LN10;
  const logMin = log10(minFreq);
  const logRange = log10(maxFreq) - logMin;
  const zeroY = Number((((maxDb - 0) / (maxDb - minDb)) * height).toFixed(2));

  const xForFreq = (freqHz) => {
    const f = clamp(Number(freqHz) || minFreq, minFreq, maxFreq);
    return Number((((log10(f) - logMin) / logRange) * width).toFixed(2));
  };

  const yForDb = (db) => {
    const clampedDb = clamp(Number(db) || 0, minDb, maxDb);
    return Number((((maxDb - clampedDb) / (maxDb - minDb)) * height).toFixed(2));
  };

  const points = [];
  for (let i = 0; i <= width; i += 1) {
    const x = i;
    const norm = x / width;
    const freq = minFreq * ((maxFreq / minFreq) ** norm);
    const logFreq = log10(freq);

    let db = 0;
    for (const band of bands) {
      const bandLog = log10(band.freqHz);
      const delta = logFreq - bandLog;
      const sigma = band.id === 'low' || band.id === 'high'
        ? 0.23
        : clamp(0.22 / Math.max(0.55, band.qValue), 0.06, 0.22);
      db += band.gainDb * Math.exp(-((delta * delta) / (2 * sigma * sigma)));
    }

    points.push({ x, y: yForDb(db), db: clamp(db, minDb, maxDb), freqHz: freq });
  }

  if (points.length === 0) {
    return null;
  }

  const strokePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
  const fillPath = `${strokePath} L ${width} ${zeroY} L 0 ${zeroY} Z`;

  const nodePoints = bands.map((band) => ({
    id: band.id,
    label: band.label,
    color: band.color,
    x: xForFreq(band.freqHz),
    y: yForDb(band.gainDb),
    gainDb: Number(band.gainDb.toFixed(1)),
    freqHz: band.freqHz,
    qValue: band.qValue,
  }));

  const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].map((freqHz) => ({
    freqHz,
    x: xForFreq(freqHz),
    label: formatTracktionEqInspectorMiniFreqLabel(freqHz),
  }));

  const dbLines = [-12, -6, 0, 6, 12].map((db) => ({
    db,
    y: yForDb(db),
  }));

  return {
    width,
    height,
    zeroY,
    strokePath,
    fillPath,
    samples: points,
    bands: bands.map((band) => ({
      id: band.id,
      label: band.label,
      color: band.color,
      freqHz: band.freqHz,
      gainDb: band.gainDb,
      qValue: band.qValue,
      paramIds: {
        freq: band.freqParam?.id || null,
        gain: band.gainParam?.id || null,
        q: band.qParam?.id || null,
      },
    })),
    nodePoints,
    ticks,
    dbLines,
  };
}

function normalizeIncomingEqAnalyzerFrame(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  if (payload.available === false) {
    return null;
  }

  const freqsHz = Array.isArray(payload.freqsHz)
    ? payload.freqsHz.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const preDb = Array.isArray(payload.preDb)
    ? payload.preDb.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  const postDb = Array.isArray(payload.postDb)
    ? payload.postDb.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  const count = Math.min(freqsHz.length, preDb.length, postDb.length);
  if (count < 8) {
    return null;
  }

  return {
    available: true,
    preMirrorsPost: Boolean(payload.preMirrorsPost),
    scope: typeof payload.scope === 'string' ? payload.scope : 'master',
    channels: typeof payload.channels === 'string' ? payload.channels : 'mono',
    sampleRate: Number(payload.sampleRate) || null,
    fftSize: Number.isInteger(Number(payload.fftSize)) ? Number(payload.fftSize) : null,
    minDb: Number.isFinite(Number(payload.minDb)) ? Number(payload.minDb) : -96,
    maxDb: Number.isFinite(Number(payload.maxDb)) ? Number(payload.maxDb) : 6,
    timestamp: Number.isFinite(Number(payload.timestamp)) ? Number(payload.timestamp) : Date.now(),
    freqsHz: freqsHz.slice(0, count),
    preDb: preDb.slice(0, count),
    postDb: postDb.slice(0, count),
  };
}

function buildTracktionEqAnalyzerOverlayData(curve, analyzerFrame) {
  if (!curve || !analyzerFrame || !Array.isArray(analyzerFrame.freqsHz)) {
    return null;
  }

  const width = Number(curve.width) || 280;
  const height = Number(curve.height) || 116;
  const minFreq = 20;
  const maxFreq = 20000;
  const minDb = Number.isFinite(Number(analyzerFrame.minDb)) ? Number(analyzerFrame.minDb) : -96;
  const maxDbRaw = Number.isFinite(Number(analyzerFrame.maxDb)) ? Number(analyzerFrame.maxDb) : 6;
  const maxDb = Math.max(minDb + 12, maxDbRaw);
  const dbRange = Math.max(1, maxDb - minDb);
  const log10 = (v) => Math.log(v) / Math.LN10;
  const logMin = log10(minFreq);
  const logRange = log10(maxFreq) - logMin;
  const xForFreq = (freqHz) => {
    const f = clamp(Number(freqHz) || minFreq, minFreq, maxFreq);
    return Number((((log10(f) - logMin) / logRange) * width).toFixed(2));
  };
  const yForAnalyzerDb = (db) => {
    const clampedDb = clamp(Number(db) || minDb, minDb, maxDb);
    return Number((((maxDb - clampedDb) / dbRange) * height).toFixed(2));
  };
  const toPath = (freqs, values) => {
    const points = [];
    const count = Math.min(freqs.length, values.length);
    for (let i = 0; i < count; i += 1) {
      const x = xForFreq(freqs[i]);
      const y = yForAnalyzerDb(values[i]);
      points.push({ x, y });
    }
    if (points.length < 2) {
      return null;
    }
    const linePath = points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
      .join(' ');
    const fillPath = `${linePath} L ${points[points.length - 1].x} ${height} L ${points[0].x} ${height} Z`;
    return { linePath, fillPath, points };
  };

  const pre = toPath(analyzerFrame.freqsHz, analyzerFrame.preDb);
  const post = toPath(analyzerFrame.freqsHz, analyzerFrame.postDb);
  if (!pre && !post) {
    return null;
  }

  return {
    pre,
    post,
    minDb,
    maxDb,
    preMirrorsPost: Boolean(analyzerFrame.preMirrorsPost),
    scope: analyzerFrame.scope || 'master',
    channels: analyzerFrame.channels || 'mono',
    timestamp: analyzerFrame.timestamp || Date.now(),
  };
}

function formatInspectorEqMacroPercent(value) {
  return `${Math.round(clamp(Number(value) || 0, 0, 1) * 100)}%`;
}

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
  appPreferences: {
    record_count_in_enabled: true,
    record_use_standard_mic: false,
  },
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
    metronome_enabled: DEFAULT_METRONOME_ENABLED,
    time_signature: DEFAULT_TIME_SIGNATURE,
    playlist_view_bars: DEFAULT_VIEW_BARS,
    playlist_bar_width: DEFAULT_BAR_WIDTH,
    playlist_show_track_nodes: true,
    nodes: [],
    patterns: [],
    playlist: [],
    mixer: [],
    master_mix: { volume: 1, pan: 0, mute: false, chain_enabled: true },
    song_structure: { template_id: null, template_name: null, playlist_link_enabled: false, nodes: [] },
  },
  selectedProjectFile: 'welcome.stu',
  history: {
    canUndo: false,
    canRedo: false,
  },
};

function normalizeMetronomeEnabled(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return DEFAULT_METRONOME_ENABLED;
}

function getMetronomeStepBeats() {
  // BPM is defined in quarter-notes per minute, so the metronome steps in quarter-notes.
  return 1;
}

function getMetronomeAccent(stepIndex, timeSignature = DEFAULT_TIME_SIGNATURE) {
  const numerator = Number(timeSignature?.numerator);
  const denominator = Number(timeSignature?.denominator);
  const safeNumerator = Number.isFinite(numerator) && numerator > 0 ? Math.round(numerator) : 4;
  const safeDenominator = Number.isFinite(denominator) && denominator > 0 ? Math.round(denominator) : 4;
  const quarterNotesPerBarRaw = (safeNumerator * 4) / safeDenominator;
  const quarterNotesPerBar = Number.isFinite(quarterNotesPerBarRaw) && quarterNotesPerBarRaw > 0 ? quarterNotesPerBarRaw : 4;
  const stepsPerBar = Math.max(1, Math.round(quarterNotesPerBar));
  const stepInBar = ((stepIndex % stepsPerBar) + stepsPerBar) % stepsPerBar;
  if (stepInBar === 0) {
    return 'strong';
  }
  if (
    safeNumerator === 6
    && safeDenominator === 8
    && stepsPerBar >= 3
    && stepInBar === Math.floor(stepsPerBar / 2)
  ) {
    return 'medium';
  }
  return 'weak';
}

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

/** Clamp pointer-derived track index to existing playlist row ids (arrangement order). */
function clampClipMoveTargetTrackId(rawTrackId, arrangementTracks) {
  const ids = arrangementTracks
    .map((t) => Number(t?.track_id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) {
    return Number.isInteger(rawTrackId) && rawTrackId > 0 ? rawTrackId : 1;
  }
  const lo = Math.min(...ids);
  const hi = Math.max(...ids);
  const base = Number.isInteger(rawTrackId) && rawTrackId > 0 ? rawTrackId : lo;
  return clamp(base, lo, hi);
}

/**
 * Draft for dragging a clip: start from horizontal delta; target track from grid Y (getGridPointerContext).
 * Pure — pass barWidth from ref.current and getGridPointerContext from the shell.
 */
function buildClipMoveDraft({
  event,
  originX,
  originTrackId,
  clipStartBars,
  clipLengthBars,
  barWidthPx,
  snapStep,
  arrangementTracks,
  getGridPointerContext,
}) {
  if (!event || !Number.isFinite(barWidthPx) || barWidthPx <= 0) {
    return null;
  }
  const deltaBars = snapToGrid((event.clientX - originX) / barWidthPx, snapStep);
  const start = Math.max(0, snapToGrid(Number(clipStartBars) + deltaBars, snapStep));
  const ctx = typeof getGridPointerContext === 'function' ? getGridPointerContext(event) : null;
  const rawDest = ctx?.trackId != null && Number.isFinite(Number(ctx.trackId))
    ? Math.floor(Number(ctx.trackId))
    : originTrackId;
  const trackId = clampClipMoveTargetTrackId(rawDest, arrangementTracks);
  const len = Number(clipLengthBars);
  return {
    trackId,
    start,
    length: Number.isFinite(len) && len > 0 ? len : 1,
  };
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

function getSourceNameBase(sourceName) {
  if (!isNonEmptyString(sourceName)) {
    return '';
  }
  const normalized = sourceName.trim();
  if (!normalized) {
    return '';
  }
  const dotIndex = normalized.lastIndexOf('.');
  if (dotIndex <= 0) {
    return normalized;
  }
  const base = normalized.slice(0, dotIndex).trim();
  return base || normalized;
}

function buildTrackRenameChoicesForImports(supportedImports) {
  if (!Array.isArray(supportedImports)) {
    return [];
  }
  const choices = [];
  for (let index = 0; index < supportedImports.length; index += 1) {
    const imported = supportedImports[index]?.imported;
    const sourceName = isNonEmptyString(imported?.sourceName) ? imported.sourceName.trim() : '';
    if (!sourceName) {
      continue;
    }
    const trackName = getSourceNameBase(sourceName);
    if (!trackName) {
      continue;
    }
    choices.push({
      id: `import_track_rename_${index}`,
      sourceName,
      trackName,
    });
  }
  return choices;
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
  if (isNonEmptyString(clip?.name)) {
    return clip.name.trim();
  }
  const patternId = getPatternId(clip);
  if (patternId) {
    return patternId;
  }
  return getImportedClipLabel(clip);
}

function normalizeClipCustomColor(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  return `#${match[1].toLowerCase()}`;
}

function hexToRgbChannels(value) {
  const hex = normalizeClipCustomColor(value);
  if (!hex) {
    return null;
  }
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  if (![r, g, b].every((channel) => Number.isFinite(channel))) {
    return null;
  }
  return `${r}, ${g}, ${b}`;
}

function stripFilenameExtension(value) {
  if (!isNonEmptyString(value)) {
    return '';
  }
  const trimmed = value.trim();
  return trimmed.replace(/\.[^.]+$/, '');
}

function normalizeAutoAnalyzedNameBase(value) {
  const withoutExt = stripFilenameExtension(value);
  const normalized = withoutExt
    .replace(/\s+/g, '_')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'Clip';
}

function formatAnalyzedKeyNameToken(value) {
  if (!isNonEmptyString(value)) {
    return '';
  }
  const trimmed = value.trim();
  const match = /^([A-Ga-g])([#b]?)[\s_-]*(major|minor)$/i.exec(trimmed);
  if (match) {
    const note = `${match[1].toUpperCase()}${match[2] || ''}`;
    const quality = String(match[3] || '').toLowerCase() === 'minor' ? 'Minor' : 'Major';
    return `${note}${quality}`;
  }
  return trimmed.replace(/\s+/g, '');
}

function buildAutoAnalyzedClipName(baseName, { bpm, key } = {}) {
  const parts = [normalizeAutoAnalyzedNameBase(baseName)];
  const bpmNumber = Number(bpm);
  if (Number.isFinite(bpmNumber) && bpmNumber > 0) {
    parts.push(`BPM_${Math.round(bpmNumber)}`);
  }
  const keyToken = formatAnalyzedKeyNameToken(key);
  if (keyToken) {
    parts.push(`Key_${keyToken}`);
  }
  return parts.join('_');
}

function getClipWaveformPeaks(clip) {
  if (!clip || typeof clip !== 'object') {
    return [];
  }
  return normalizeWaveformPeaks(clip.waveform_peaks ?? clip.waveformPeaks ?? clip.waveform ?? []);
}

/**
 * First non-silent sample in the peak array mapped to seconds, assuming peaks are uniformly spaced
 * over `sourceDurationSeconds` (full file). Mirrors engine `getLeadingSilenceOffsetSeconds` when
 * duration is the true file length (engine sync still passes clip length for that call; UI uses
 * source duration so the offset aligns with the full `waveform_peaks` buffer).
 */
function getLeadingSilenceOffsetSecondsFromPeaks(peaks, sourceDurationSeconds, threshold = 0.02) {
  const n = peaks.length;
  if (n === 0 || !Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
    return 0;
  }
  for (let i = 0; i < n; i += 1) {
    const p = Number(peaks[i]);
    if (Number.isFinite(p) && Math.abs(p) > threshold) {
      return (i / n) * sourceDurationSeconds;
    }
  }
  return 0;
}

function sliceWaveformPeaksByFileTime(peaks, t0, t1) {
  const n = peaks.length;
  if (n === 0) {
    return [];
  }
  if (n === 1) {
    return [...peaks];
  }
  const lo = clamp(t0, 0, 1);
  const hi = clamp(t1, lo, 1);
  const last = n - 1;
  const startFrac = lo * last;
  const endFrac = hi * last;
  let i0 = Math.floor(startFrac);
  let i1 = Math.ceil(endFrac);
  i0 = clamp(i0, 0, last);
  i1 = clamp(i1, i0, last);
  return peaks.slice(i0, i1 + 1);
}

function getInteractionTrimStart(clip) {
  if (!clip || typeof clip !== 'object') {
    return 0;
  }
  if (Object.prototype.hasOwnProperty.call(clip, 'trim_start_seconds') && Number.isFinite(Number(clip.trim_start_seconds))) {
    return Math.max(0, Number(clip.trim_start_seconds) || 0);
  }
  const peaks = getClipWaveformPeaks(clip);
  const sourceDur = Number(clip.source_duration_seconds ?? clip.sourceDurationSeconds);
  if (peaks.length > 0 && Number.isFinite(sourceDur) && sourceDur > 0) {
    return getLeadingSilenceOffsetSecondsFromPeaks(peaks, sourceDur);
  }
  return 0;
}

/** Effective file-time start for waveform + split (aligns with engine native offset when trim is stored too low). */
function getEffectiveAudioTrimStartForWaveform(clip) {
  if (!clip || typeof clip !== 'object') {
    return 0;
  }
  const peaks = getClipWaveformPeaks(clip);
  const sourceDur = Number(clip.source_duration_seconds ?? clip.sourceDurationSeconds);
  let peakLead = 0;
  if (peaks.length > 0 && Number.isFinite(sourceDur) && sourceDur > 0) {
    peakLead = getLeadingSilenceOffsetSecondsFromPeaks(peaks, sourceDur);
  }
  if (Object.prototype.hasOwnProperty.call(clip, 'trim_start_seconds') && Number.isFinite(Number(clip.trim_start_seconds))) {
    return Math.max(0, Number(clip.trim_start_seconds) || 0, peakLead);
  }
  return peakLead;
}

/**
 * Waveform peaks for the audible file-time window (FL-style): [trim_start, trim_start + timeline length]
 * mapped onto full-file waveform_peaks. Does not mutate stored peaks.
 */
function getVisibleWaveformPeaks(clip, { bpm, timeSignature } = {}) {
  const peaks = getClipWaveformPeaks(clip);
  if (peaks.length === 0) {
    return [];
  }

  const lengthBars = Number(clip?.length) || 0;
  const safeBpm = Number.isFinite(Number(bpm)) && Number(bpm) > 0 ? Number(bpm) : 128;
  const lengthSeconds = barsToSeconds(lengthBars, safeBpm, timeSignature);

  const sourceDurRaw = Number(clip?.source_duration_seconds ?? clip?.sourceDurationSeconds);
  const hasSourceDur = Number.isFinite(sourceDurRaw) && sourceDurRaw > 0;
  const effectiveSourceDur = hasSourceDur ? sourceDurRaw : Math.max(lengthSeconds, 1e-9);

  const windowStartSec = getEffectiveAudioTrimStartForWaveform(clip);
  const windowEndSec = windowStartSec + lengthSeconds;
  const t0 = clamp(windowStartSec / effectiveSourceDur, 0, 1);
  const t1 = clamp(windowEndSec / effectiveSourceDur, t0, 1);

  if (t1 <= t0) {
    const idx = Math.min(peaks.length - 1, Math.max(0, Math.round(t0 * Math.max(1, peaks.length - 1))));
    return [peaks[idx]];
  }

  const sliced = sliceWaveformPeaksByFileTime(peaks, t0, t1);
  return sliced.length > 0 ? sliced : peaks;
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

function normalizeClipGain(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return CLIP_GAIN_DEFAULT;
  }
  return clamp(parsed, CLIP_GAIN_MIN, CLIP_GAIN_MAX);
}

function clipGainToDb(gain) {
  const normalized = normalizeClipGain(gain);
  if (normalized <= 0.00001) {
    return CLIP_GAIN_DB_MIN;
  }
  return 20 * Math.log10(normalized);
}

function clipDbToGain(db) {
  const parsed = Number(db);
  if (!Number.isFinite(parsed) || parsed <= CLIP_GAIN_DB_MIN + 0.01) {
    return CLIP_GAIN_MIN;
  }
  return normalizeClipGain(10 ** (parsed / 20));
}

function getClipFadeDisplayValues(clip, fadeDraftByKey, clipKey) {
  const draft = fadeDraftByKey?.[clipKey];
  if (draft) {
    return {
      fadeIn: Math.max(0, Number(draft.fadeIn) || 0),
      fadeOut: Math.max(0, Number(draft.fadeOut) || 0),
    };
  }
  return {
    fadeIn: Math.max(0, Number(clip?.fade_in) || 0),
    fadeOut: Math.max(0, Number(clip?.fade_out) || 0),
  };
}

function fadeSecondsToWidthPx(fadeSeconds, barWidthPx, bpm, timeSignature = DEFAULT_TIME_SIGNATURE) {
  const bars = secondsToBars(Math.max(0, Number(fadeSeconds) || 0), bpm, timeSignature);
  const width = Number(barWidthPx);
  if (!Number.isFinite(width) || width <= 0) {
    return 0;
  }
  return Math.max(0, bars * width);
}

function formatClipGainDb(gain) {
  const normalized = normalizeClipGain(gain);
  if (normalized <= 0.00001) {
    return '-∞ dB';
  }
  const db = 20 * Math.log10(normalized);
  const sign = db >= 0 ? '+' : '';
  return `${sign}${db.toFixed(1)} dB`;
}

function getClipFadeCurves(clip, fadeDraftByKey, clipKey) {
  const draft = fadeDraftByKey?.[clipKey];
  const fadeInCurve = draft?.fadeInCurve ?? clip?.fade_in_curve;
  const fadeOutCurve = draft?.fadeOutCurve ?? clip?.fade_out_curve;
  return {
    fadeInCurve: FADE_CURVE_ORDER.includes(fadeInCurve) ? fadeInCurve : 'linear',
    fadeOutCurve: FADE_CURVE_ORDER.includes(fadeOutCurve) ? fadeOutCurve : 'linear',
  };
}

function applyFadeCurveT(t, curve) {
  const clamped = clamp(t, 0, 1);
  switch (curve) {
    case 'convex':
      return clamped * clamped;
    case 'concave':
      return Math.sqrt(clamped);
    case 'sCurve':
      return clamped * clamped * (3 - 2 * clamped);
    default:
      return clamped;
  }
}

function quadBezierPoint(t, x0, y0, x1, y1, x2, y2) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  return {
    x: uu * x0 + 2 * u * t * x1 + tt * x2,
    y: uu * y0 + 2 * u * t * y1 + tt * y2,
  };
}

function getFadeCurveControlY(curve) {
  switch (curve) {
    case 'convex':
      return 94;
    case 'concave':
      return 48;
    case 'sCurve':
      return 62;
    default:
      return 74;
  }
}

function getFadeBezierControlX(which, xSpan, curve = 'linear') {
  const fadeCurve = FADE_CURVE_ORDER.includes(curve) ? curve : 'linear';
  if (which === 'in') {
    return xSpan * (fadeCurve === 'concave' ? 0.35 : fadeCurve === 'convex' ? 0.68 : 0.52);
  }
  const xStart = 100 - xSpan;
  return xStart + xSpan * (fadeCurve === 'concave' ? 0.65 : fadeCurve === 'convex' ? 0.32 : 0.48);
}

function buildFadeCurvePathD(which, fadePx, wrapWidthPx, curve = 'linear') {
  const wrapW = Math.max(1, Number(wrapWidthPx) || 1);
  const fadeW = Math.max(0, Number(fadePx) || 0);
  if (fadeW < FADE_VISIBLE_MIN_PX) {
    return '';
  }
  const fadeCurve = FADE_CURVE_ORDER.includes(curve) ? curve : 'linear';
  const xSpan = Math.min(99, (fadeW / wrapW) * 100);
  const controlY = getFadeCurveControlY(fadeCurve);
  const cx = getFadeBezierControlX(which, xSpan, fadeCurve);

  if (which === 'in') {
    return `M 0 100 Q ${cx.toFixed(2)} ${controlY}, ${xSpan.toFixed(2)} 0`;
  }

  const xStart = 100 - xSpan;
  return `M 100 100 Q ${cx.toFixed(2)} ${controlY}, ${xStart.toFixed(2)} 0`;
}

/** Point on fade quadratic at t=0.5 — curve handle sits on the white line (FL-style). */
function getFadeCurveNodePosition(which, fadePx, wrapWidthPx, curve = 'linear') {
  const fadeW = Math.max(0, Number(fadePx) || 0);
  if (fadeW < FADE_CURVE_NODE_MIN_PX) {
    return null;
  }
  const wrapW = Math.max(1, Number(wrapWidthPx) || 1);
  const fadeCurve = FADE_CURVE_ORDER.includes(curve) ? curve : 'linear';
  const xSpan = Math.min(99, (fadeW / wrapW) * 100);
  const controlY = getFadeCurveControlY(fadeCurve);
  const cx = getFadeBezierControlX(which, xSpan, fadeCurve);

  if (which === 'in') {
    const pt = quadBezierPoint(0.5, 0, 100, cx, controlY, xSpan, 0);
    return { leftPercent: pt.x, topPercent: pt.y };
  }

  const xStart = 100 - xSpan;
  const pt = quadBezierPoint(0.5, 100, 100, cx, controlY, xStart, 0);
  return { leftPercent: pt.x, topPercent: pt.y };
}

/** Per-sample fade envelope 0–1 across clip width (for waveform rendering). */
function getFadeEnvelopeAtX(progress, fadeInFrac, fadeOutFrac, fadeInCurve, fadeOutCurve) {
  let env = 1;
  const p = clamp(progress, 0, 1);
  if (fadeInFrac > 0 && p < fadeInFrac) {
    env = applyFadeCurveT(p / fadeInFrac, fadeInCurve);
  }
  if (fadeOutFrac > 0 && p > 1 - fadeOutFrac) {
    const t = (1 - p) / fadeOutFrac;
    env *= applyFadeCurveT(t, fadeOutCurve);
  }
  return clamp(env, 0, 1);
}

function applyFadeEnvelopeToPeaks(peaks, fadeInPx, fadeOutPx, clipWidthPx, fadeInCurve, fadeOutCurve) {
  const normalized = normalizeWaveformPeaks(peaks);
  if (normalized.length === 0) {
    return normalized;
  }
  const wrapW = Math.max(1, Number(clipWidthPx) || 1);
  const fadeInFrac = Math.max(0, Number(fadeInPx) || 0) / wrapW;
  const fadeOutFrac = Math.max(0, Number(fadeOutPx) || 0) / wrapW;
  if (fadeInFrac < 0.001 && fadeOutFrac < 0.001) {
    return normalized;
  }
  const last = Math.max(1, normalized.length - 1);
  return normalized.map((peak, index) => {
    const progress = index / last;
    const env = getFadeEnvelopeAtX(progress, fadeInFrac, fadeOutFrac, fadeInCurve, fadeOutCurve);
    return Number((peak * env).toFixed(4));
  });
}

function fadeCurveFromVerticalDrag(originCurve, deltaYPx) {
  const originIndex = FADE_CURVE_ORDER.indexOf(originCurve);
  const safeOrigin = originIndex >= 0 ? originIndex : 0;
  const stepOffset = Math.round(-deltaYPx / FADE_CURVE_DRAG_PX_PER_STEP);
  const nextIndex = clamp(safeOrigin + stepOffset, 0, FADE_CURVE_ORDER.length - 1);
  return FADE_CURVE_ORDER[nextIndex];
}

function getClipGainDisplayValue(clip, gainDraftByKey, clipKey) {
  if (gainDraftByKey && Object.prototype.hasOwnProperty.call(gainDraftByKey, clipKey)) {
    return normalizeClipGain(gainDraftByKey[clipKey]);
  }
  return normalizeClipGain(clip?.gain);
}

function getWaveformPolygonPoints(peaks, gainMultiplier = 1) {
  const normalizedPeaks = normalizeWaveformPeaks(peaks);
  if (normalizedPeaks.length === 0) {
    return '';
  }

  const gainScale = clamp(Number(gainMultiplier) || 1, CLIP_GAIN_MIN, CLIP_GAIN_MAX);
  const topPoints = [];
  const bottomPoints = [];
  const lastIndex = Math.max(1, normalizedPeaks.length - 1);
  for (let index = 0; index < normalizedPeaks.length; index += 1) {
    const x = (index / lastIndex) * 100;
    const amplitude = normalizedPeaks[index] * 44 * gainScale;
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

function parseOptionalBool(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return null;
}

function getDefaultFloatingWindowLayouts() {
  return {
    trackChain: {
      x: 72,
      y: 72,
      width: 980,
      height: 560,
      minWidth: 620,
      minHeight: 320,
      zIndex: 30,
      minimized: false,
      maximized: false,
      restoreBounds: null,
    },
    settings: {
      x: 64,
      y: 68,
      width: 520,
      height: 620,
      minWidth: 420,
      minHeight: 260,
      zIndex: 10,
      minimized: false,
      maximized: false,
      restoreBounds: null,
    },
    recordMic: {
      x: 120,
      y: 118,
      width: 420,
      height: 340,
      minWidth: 320,
      minHeight: 190,
      zIndex: 20,
      minimized: false,
      maximized: false,
      restoreBounds: null,
    },
    importTrackRename: {
      x: 140,
      y: 140,
      width: 520,
      height: 380,
      minWidth: 420,
      minHeight: 240,
      zIndex: 40,
      minimized: false,
      maximized: false,
      restoreBounds: null,
    },
  };
}

function getFloatingWindowViewportBounds() {
  if (typeof window === 'undefined') {
    return { width: 1280, height: 800 };
  }
  return {
    width: Math.max(640, window.innerWidth || 0),
    height: Math.max(420, window.innerHeight || 0),
  };
}

function normalizeFloatingWindowLayoutEntry(id, rawValue, viewport = getFloatingWindowViewportBounds()) {
  const defaults = getDefaultFloatingWindowLayouts()[id] || getDefaultFloatingWindowLayouts().settings;
  const source = isObject(rawValue) ? rawValue : {};
  const minWidth = Math.max(240, Math.round(Number(source.minWidth) || defaults.minWidth || 320));
  const minHeight = Math.max(90, Math.round(Number(source.minHeight) || defaults.minHeight || 180));
  const maxWidth = Math.max(minWidth, viewport.width - (FLOATING_WINDOW_MARGIN * 2));
  const dockReserve = FLOATING_WINDOW_DOCK_HEIGHT + FLOATING_WINDOW_DOCK_GAP;
  const maxHeight = Math.max(minHeight, viewport.height - (FLOATING_WINDOW_MARGIN * 2) - dockReserve);
  const width = Math.round(clamp(Number(source.width) || defaults.width, minWidth, maxWidth));
  const height = Math.round(clamp(Number(source.height) || defaults.height, minHeight, maxHeight));
  const minimized = parseOptionalBool(source.minimized);
  const maximized = parseOptionalBool(source.maximized);
  const visibleHeight = (typeof minimized === 'boolean' && minimized) ? 42 : height;
  const x = Math.round(clamp(
    Number(source.x) || defaults.x,
    FLOATING_WINDOW_MARGIN,
    Math.max(FLOATING_WINDOW_MARGIN, viewport.width - width - FLOATING_WINDOW_MARGIN),
  ));
  const y = Math.round(clamp(
    Number(source.y) || defaults.y,
    FLOATING_WINDOW_MARGIN,
    Math.max(FLOATING_WINDOW_MARGIN, viewport.height - visibleHeight - FLOATING_WINDOW_MARGIN - dockReserve),
  ));
  const restoreBounds = isObject(source.restoreBounds)
    ? {
      x: Math.round(Number(source.restoreBounds.x) || x),
      y: Math.round(Number(source.restoreBounds.y) || y),
      width: Math.round(Number(source.restoreBounds.width) || width),
      height: Math.round(Number(source.restoreBounds.height) || height),
    }
    : null;

  return {
    ...defaults,
    x,
    y,
    width,
    height,
    minWidth,
    minHeight,
    zIndex: Math.max(1, Math.round(Number(source.zIndex) || defaults.zIndex || 1)),
    minimized: typeof minimized === 'boolean' ? minimized : defaults.minimized,
    maximized: typeof maximized === 'boolean' ? maximized : defaults.maximized,
    restoreBounds,
  };
}

function normalizeFloatingWindowLayouts(rawValue, viewport = getFloatingWindowViewportBounds()) {
  const defaults = getDefaultFloatingWindowLayouts();
  const source = isObject(rawValue) ? rawValue : {};
  return {
    trackChain: normalizeFloatingWindowLayoutEntry('trackChain', source.trackChain, viewport),
    settings: normalizeFloatingWindowLayoutEntry('settings', source.settings, viewport),
    recordMic: normalizeFloatingWindowLayoutEntry('recordMic', source.recordMic, viewport),
    importTrackRename: normalizeFloatingWindowLayoutEntry('importTrackRename', source.importTrackRename, viewport),
    // Preserve future entries if they exist; normalize only known windows for now.
    ...Object.fromEntries(
      Object.entries(source)
        .filter(([key]) => !Object.prototype.hasOwnProperty.call(defaults, key))
        .map(([key, value]) => [key, value]),
    ),
  };
}

function loadFloatingWindowLayoutsFromStorage() {
  const defaults = getDefaultFloatingWindowLayouts();
  if (typeof window === 'undefined') {
    return defaults;
  }
  try {
    const raw = window.localStorage.getItem(FLOATING_WINDOW_LAYOUTS_STORAGE_KEY);
    if (!raw) {
      return normalizeFloatingWindowLayouts(defaults);
    }
    const parsed = JSON.parse(raw);
    return normalizeFloatingWindowLayouts(parsed);
  } catch {
    return normalizeFloatingWindowLayouts(defaults);
  }
}

function getNextFloatingWindowZCounter(layouts) {
  if (!isObject(layouts)) {
    return 100;
  }
  let maxZ = 0;
  for (const value of Object.values(layouts)) {
    const z = Number(value?.zIndex);
    if (Number.isFinite(z)) {
      maxZ = Math.max(maxZ, z);
    }
  }
  return maxZ + 10;
}

function normalizePluginKind(kindValue, fallbackIsInstrument = null) {
  if (typeof kindValue === 'string') {
    const normalized = kindValue.trim().toLowerCase();
    if (normalized === 'instrument' || normalized === 'inst' || normalized === 'synth' || normalized === 'generator') {
      return 'instrument';
    }
    if (normalized === 'effect' || normalized === 'fx' || normalized === 'audio_fx' || normalized === 'audio-effect') {
      return 'effect';
    }
  }
  if (typeof fallbackIsInstrument === 'boolean') {
    return fallbackIsInstrument ? 'instrument' : 'effect';
  }
  return 'effect';
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

    const isInstrumentFlag = parseOptionalBool(rawPlugin.isInstrument ?? rawPlugin.is_instrument);
    const kind = normalizePluginKind(rawPlugin.kind ?? rawPlugin.plugin_kind, isInstrumentFlag);
    const isNativeFlag = parseOptionalBool(rawPlugin.isNative ?? rawPlugin.is_native);

    deduped.set(uid, {
      uid,
      name: typeof rawPlugin.name === 'string' && rawPlugin.name.trim() ? rawPlugin.name.trim() : uid,
      type: typeof rawPlugin.type === 'string' && rawPlugin.type.trim() ? rawPlugin.type.trim() : 'unknown',
      kind,
      isInstrument: kind === 'instrument',
      isNative: typeof isNativeFlag === 'boolean' ? isNativeFlag : uid.startsWith('internal:'),
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
    record_input_device_id: null,
    record_input_device_name: null,
  };
}

/** Mix strip M/S/R: semantic classes (`mute-toggle`, `solo-toggle`, `record-toggle`) + `active`, aligned with Edit `arrangement-track-toggle`. */
function mixStripToggleButtonClass(action, active) {
  return `${action}-toggle${active ? ' active' : ''}`;
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
    record_input_device_id: typeof safeEntry.record_input_device_id === 'string' ? safeEntry.record_input_device_id : null,
    record_input_device_name: typeof safeEntry.record_input_device_name === 'string' ? safeEntry.record_input_device_name : null,
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
  if (mode === 'free') {
    return SLICE_FREE_STEP;
  }
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

function findClipOnPlaylistTrack(playlist, trackId, clipId) {
  const list = Array.isArray(playlist) ? playlist : [];
  const track = list.find((t) => Number(t?.track_id) === Number(trackId));
  if (!track || !Array.isArray(track.clips)) {
    return null;
  }
  const idStr = String(clipId);
  return track.clips.find((c) => String(c?.id) === idStr) || null;
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
  if (!node || typeof node !== 'object') {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'track_id')) {
    const v = Number(node.track_id);
    if (v === 0) {
      return 0;
    }
    if (Number.isInteger(v) && v > 0) {
      return v;
    }
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'trackId')) {
    const v = Number(node.trackId);
    if (v === 0) {
      return 0;
    }
    if (Number.isInteger(v) && v > 0) {
      return v;
    }
    return null;
  }
  return null;
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

function resolveNodePluginDisplayName(node, pluginNameByUid) {
  if (!node || typeof node !== 'object') {
    return 'Plugin';
  }
  const uid = typeof node.plugin_uid === 'string' ? node.plugin_uid.trim() : '';
  const mappedName = uid ? pluginNameByUid.get(uid) : '';
  if (typeof mappedName === 'string' && mappedName.trim()) {
    return mappedName.trim();
  }
  const pluginName = typeof node.plugin === 'string' ? node.plugin.trim() : '';
  if (pluginName) {
    return pluginName;
  }
  if (uid) {
    return uid;
  }
  const id = typeof node.id === 'string' ? node.id.trim() : '';
  return id || 'Plugin';
}

export default function StuuShell() {
  const socketRef = useRef(null);
  const clipDraftsRef = useRef({});
  const importFileInputRef = useRef(null);
  const importTargetTrackIdRef = useRef(null);
  const importTrackRenamePromptResolverRef = useRef(null);
  const trackNameInputRef = useRef(null);
  const cancelTrackNameEditRef = useRef(false);
  const arrangementScrollRef = useRef(null);
  const mixOverviewRef = useRef(null);
  const arrangementGridRef = useRef(null);
  const arrangementTrackRowsRef = useRef(null);
  const arrangementBodyRef = useRef(null);
  const barWidthRef = useRef(DEFAULT_BAR_WIDTH);
  const timelineBarsRef = useRef(DEFAULT_VIEW_BARS);
  const viewBarsRef = useRef(DEFAULT_VIEW_BARS);
  const showTrackNodesRef = useRef(true);
  const seekAnimationFrameRef = useRef(null);
  const playheadAnimationFrameRef = useRef(null);
  const playheadLeftPxRef = useRef(-1);
  /** Incremented when switching to Edit so the next scroll-element sync always writes --playhead-left-px (new DOM node / remount). */
  const playheadSyncGenerationRef = useRef(0);
  const playheadAppliedScrollGenRef = useRef(-1);
  const prevTabForPlayheadRef = useRef(null);
  const pendingSeekBarsRef = useRef(null);
  const playheadPointerHandlersRef = useRef(null);
  const toolPointerHandlersRef = useRef(null);
  const toolDragRef = useRef(null);
  const countInTimeoutRef = useRef(null);
  const countInIntervalRef = useRef(null);
  const metronomeAudioContextRef = useRef(null);
  const metronomeFrameRef = useRef(null);
  const metronomeLastStepRef = useRef(null);
  const metronomeNeedleRef = useRef(null);
  const metronomeClockRef = useRef({
    anchorMs: 0,
    anchorBeats: 0,
    bpm: FALLBACK_STATE.project.bpm,
  });
  const trackRowDragBlockedRef = useRef(false);
  const playheadDragBarsRef = useRef(null);
  const previewStopTimeoutRef = useRef(null);
  const inspectorEqProParamRowRefs = useRef(new Map());
  const inspectorEqAnalyzerFrozenRef = useRef(false);
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
  const metronomeDebugRef = useRef({
    tickCount: 0,
    lastTickMs: 0,
    lastLogMs: 0,
  });
  const transportDebugRef = useRef({
    lastPositionBeats: null,
    lastTimestamp: null,
    lastLogMs: 0,
  });
  const floatingWindowInteractionRef = useRef(null);
  const activateFloatingWindowRef = useRef(null);
  const loadedProjectFileRef = useRef(null);
  const chatHistoryLoadedRef = useRef(false);
  const speechRecognitionRef = useRef(null);
  const lastSyncedViewRef = useRef({
    file: '',
    bars: DEFAULT_VIEW_BARS,
    width: DEFAULT_BAR_WIDTH,
    showNodes: true,
  });

  /** Mix / Edit volume+pan: local `applyLocal*` on every input; one engine commit on pointer release (FL-style, avoids emitState storms). */
  const mixLevelDragSessionRef = useRef(null);
  const mixLevelDragDetachRef = useRef(null);

  const [connection, setConnection] = useState('connecting');
  const [engineDiagnostics, setEngineDiagnostics] = useState(null);
  const [connectionLogs, setConnectionLogs] = useState([]);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settingsTab, setSettingsTab] = useState('AUDIO');
  const [settingsVstPluginTab, setSettingsVstPluginTab] = useState('effects');
  const [settingsVstSearch, setSettingsVstSearch] = useState('');
  const [settingsVstSourceFilter, setSettingsVstSourceFilter] = useState('all');
  const [audioOutputDevices, setAudioOutputDevices] = useState([]);
  const [audioOutputCurrentId, setAudioOutputCurrentId] = useState('');
  const [audioInputDevices, setAudioInputDevices] = useState([]);
  const [audioInputCurrentId, setAudioInputCurrentId] = useState('');
  const [audioStatus, setAudioStatus] = useState(/** @type {{ sampleRate: number | null; blockSize: number | null; outputLatencySeconds: number | null; outputChannels: number | null } | null} */ (null));
  /** Track id for which the "choose mic for record" modal is open; null = closed. */
  const [recordMicModalTrackId, setRecordMicModalTrackId] = useState(/** @type {number | null} */ (null));
  const [recordMicInputDevices, setRecordMicInputDevices] = useState(/** @type {{ id: string; name: string }[]} */ ([]));
  const [floatingWindowLayouts, setFloatingWindowLayouts] = useState(() => loadFloatingWindowLayoutsFromStorage());
  const [, setFloatingWindowZCounter] = useState(() => getNextFloatingWindowZCounter(loadFloatingWindowLayoutsFromStorage()));
  const [enginePort, setEnginePort] = useState(() => {
    try {
      const u = new URL(ENGINE_BASE_URL);
      return u.port ? Number(u.port) : 3990;
    } catch {
      return 3990;
    }
  });
  const [editTool, setEditTool] = useState(DEFAULT_EDIT_TOOL);
  const [selectedClipKeys, setSelectedClipKeys] = useState([]);
  const [clipMuteOverrides, setClipMuteOverrides] = useState({});
  const [clipSlipPreviewBars, setClipSlipPreviewBars] = useState({});
  const [toolDragOverlay, setToolDragOverlay] = useState(null);
  const [bpmInputValue, setBpmInputValue] = useState(String(FALLBACK_STATE.project.bpm));
  const [isBpmInputFocused, setIsBpmInputFocused] = useState(false);
  const [activeTab, setActiveTab] = useState('Edit');
  const [state, setState] = useState(FALLBACK_STATE);
  const recordCountInEnabledPreference = typeof state?.appPreferences?.record_count_in_enabled === 'boolean'
    ? state.appPreferences.record_count_in_enabled
    : FALLBACK_STATE.appPreferences.record_count_in_enabled;
  const recordUseStandardMicPreference = typeof state?.appPreferences?.record_use_standard_mic === 'boolean'
    ? state.appPreferences.record_use_standard_mic
    : FALLBACK_STATE.appPreferences.record_use_standard_mic;
  const [transport, setTransport] = useState(FALLBACK_STATE.transport);
  const transportUiMetaRef = useRef({
    bpm: FALLBACK_STATE.transport.bpm,
    playing: false,
    recording: false,
    beatsPerBar: 4,
  });
  const [arrangementVisibleBars, setArrangementVisibleBars] = useState({ start: 0, end: 128 });
  const [performanceProfile, setPerformanceProfileState] = useState('balanced');
  const bindMeterSocket = useBindMeterSocket();
  const [chatInput, setChatInput] = useState('');
  const [speechListening, setSpeechListening] = useState(false);
  const [chatMessages, setChatMessages] = useState(DEFAULT_CHAT_MESSAGES);
  const [aiChatDrawerOpen, setAiChatDrawerOpen] = useState(false);
  const [sidePanelTab, setSidePanelTab] = useState('assistant');
  const [inspector, setInspector] = useState({ type: 'project' });
  const [inspectorEqViewMode, setInspectorEqViewMode] = useState('easy');
  const [inspectorEqSelectedBandId, setInspectorEqSelectedBandId] = useState('mid1');
  const [inspectorEqCurveHover, setInspectorEqCurveHover] = useState(null);
  const [inspectorEqPinnedReadout, setInspectorEqPinnedReadout] = useState(null);
  const [inspectorEqAnalyzerFrame, setInspectorEqAnalyzerFrame] = useState(null);
  const [inspectorEqAnalyzerFrozen, setInspectorEqAnalyzerFrozen] = useState(false);
  const [activePatternId, setActivePatternId] = useState(null);
  const [clipDrafts, setClipDrafts] = useState({});
  const [clipDisplayOverrides, setClipDisplayOverrides] = useState({});
  const [clipInteraction, setClipInteraction] = useState(null);
  const [fadeHandleInteraction, setFadeHandleInteraction] = useState(/** @type {{ mode: 'length'|'curve'; which: 'in'|'out'; trackId: number; clipId: string; fadeIn: number; fadeOut: number; fadeInCurve: string; fadeOutCurve: string; clipLengthSeconds: number } | null} */ (null));
  const fadeHandleDraftRef = useRef(/** @type {{ fadeIn: number; fadeOut: number; fadeInCurve: string; fadeOutCurve: string } | null} */ (null));
  const fadeDraftRafRef = useRef(null);
  const fadeHandleStartRef = useRef(/** @type {{ originX: number; originY: number; originCurve: string; originFadeIn: number; originFadeOut: number } | null} */ (null));
  const [fadeDraftByKey, setFadeDraftByKey] = useState(/** @type {{ [clipKey: string]: { fadeIn: number; fadeOut: number; fadeInCurve: string; fadeOutCurve: string } } } */ ({}));
  const [gainDraftByKey, setGainDraftByKey] = useState(/** @type {{ [clipKey: string]: number } } */ ({}));
  const gainDragDraftRef = useRef(/** @type {number | null} */ (null));
  const gainDragOriginRef = useRef(/** @type {{ originY: number; originDb: number } | null} */ (null));
  const [openTrackMenuId, setOpenTrackMenuId] = useState(null);
  const [trackAddMenuAnchor, setTrackAddMenuAnchor] = useState(/** @type {{ top: number; right: number; height: number } | null} */ (null));
  const [editingTrackId, setEditingTrackId] = useState(null);
  const [editingTrackName, setEditingTrackName] = useState('');
  const [localTrackNameOverrides, setLocalTrackNameOverrides] = useState({});
  const [barWidth, setBarWidth] = useState(DEFAULT_BAR_WIDTH);
  const [viewBars, setViewBars] = useState(DEFAULT_VIEW_BARS);
  const [snapMode, setSnapMode] = useState(DEFAULT_SNAP_MODE);
  const [structureAddMenuOpen, setStructureAddMenuOpen] = useState(false);
  const [structureNodeModal, setStructureNodeModal] = useState(/** @type {object | null} */ (null));
  const [selectedStructureNodeId, setSelectedStructureNodeId] = useState(/** @type {string | null} */ (null));
  const [structureTemplateManagerOpen, setStructureTemplateManagerOpen] = useState(false);
  const [structureTemplates, setStructureTemplates] = useState(/** @type {Array<{ id: string; name: string; note?: string; modified_at?: string }>} */ ([]));
  const structureImportInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const structureMenuAnchorRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const [showTrackNodes, setShowTrackNodes] = useState(true);
  const [arrangementViewportWidth, setArrangementViewportWidth] = useState(0);
  const [availablePlugins, setAvailablePlugins] = useState([]);
  const availableEffectPlugins = useMemo(
    () => availablePlugins.filter((plugin) => isObject(plugin) && plugin.kind !== 'instrument'),
    [availablePlugins],
  );
  const availableGeneratorPlugins = useMemo(
    () => availablePlugins.filter((plugin) => isObject(plugin) && plugin.kind === 'instrument'),
    [availablePlugins],
  );
  const settingsVstPlugins = useMemo(
    () => (settingsVstPluginTab === 'generators' ? availableGeneratorPlugins : availableEffectPlugins),
    [settingsVstPluginTab, availableGeneratorPlugins, availableEffectPlugins],
  );
  const settingsVstSourceCounts = useMemo(() => {
    const nativeCount = settingsVstPlugins.filter((plugin) => plugin.isNative).length;
    const externalCount = settingsVstPlugins.filter((plugin) => !plugin.isNative).length;
    return {
      all: settingsVstPlugins.length,
      native: nativeCount,
      external: externalCount,
    };
  }, [settingsVstPlugins]);
  const settingsFilteredVstPlugins = useMemo(() => {
    const search = settingsVstSearch.trim().toLowerCase();
    return settingsVstPlugins.filter((plugin) => {
      if (!isObject(plugin)) {
        return false;
      }
      if (settingsVstSourceFilter === 'native' && !plugin.isNative) {
        return false;
      }
      if (settingsVstSourceFilter === 'external' && plugin.isNative) {
        return false;
      }
      if (!search) {
        return true;
      }
      const name = typeof plugin.name === 'string' ? plugin.name.toLowerCase() : '';
      const uid = typeof plugin.uid === 'string' ? plugin.uid.toLowerCase() : '';
      const type = typeof plugin.type === 'string' ? plugin.type.toLowerCase() : '';
      const source = plugin.isNative ? 'native' : 'external';
      return name.includes(search) || uid.includes(search) || type.includes(search) || source.includes(search);
    });
  }, [settingsVstPlugins, settingsVstSearch, settingsVstSourceFilter]);
  const [selectedPluginUid, setSelectedPluginUid] = useState(FALLBACK_VST_UID);
  const [selectedPluginTrackId, setSelectedPluginTrackId] = useState(1);
  const [pluginScanPending, setPluginScanPending] = useState(false);
  /** Prevents auto vst:scan loops when the catalog is empty (pending toggles would retrigger effects). */
  const nodeTabVstAutoScanDoneRef = useRef(false);
  const settingsVstPluginsAutoScanDoneRef = useRef(false);
  /** Clears stuck "Scanne…" if the socket ack never arrives (engine/native hang beyond server timeout). */
  const pluginScanAckTimeoutRef = useRef(null);
  const [pluginLoadPending, setPluginLoadPending] = useState(false);
  const [historyMutationPending, setHistoryMutationPending] = useState(false);
  const [hoveredTrackId, setHoveredTrackId] = useState(null);
  const [dropTargetTrackId, setDropTargetTrackId] = useState(null);
  const [trackReorderDragId, setTrackReorderDragId] = useState(null);
  const [trackReorderDropIndex, setTrackReorderDropIndex] = useState(null);
  const [trackChainEnabledOverrides, setTrackChainEnabledOverrides] = useState({});
  const [playheadDragBars, setPlayheadDragBars] = useState(null);
  const [trackContextMenu, setTrackContextMenu] = useState(null);
  const [clipQuickToolMenu, setClipQuickToolMenu] = useState(null);
  const [clipRenameColorPrompt, setClipRenameColorPrompt] = useState(null);
  const [clipAnalyzeResultModal, setClipAnalyzeResultModal] = useState(null);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedTrackIds, setSelectedTrackIds] = useState([]);
  const [openTrackPluginPicker, setOpenTrackPluginPicker] = useState(null);
  const [trackChainModalTrackId, setTrackChainModalTrackId] = useState(null);
  const [slicePreviewBars, setSlicePreviewBars] = useState(null);
  const [sliceCursorPosition, setSliceCursorPosition] = useState(null);
  const [importTrackRenamePrompt, setImportTrackRenamePrompt] = useState(null);
  const clipRenameColorNameInputRef = useRef(null);
  /** TEMP split debug: throttle render + engine:state logs to this track + clip ids */
  const splitDebugSessionRef = useRef({ until: 0, trackId: null, clipIds: null });
  /** In-app audio clip duplicate buffer (Cmd/Ctrl+C, Cmd/Ctrl+V; Linux uses Ctrl like Windows). Not the OS clipboard. */
  const audioClipClipboardRef = useRef(/** @type {{ items: { sourceTrackId: number; clip: object }[] } | null} */ (null));
  /** Desired Structure↔Playlist link; reapplied on each engine:state after hydration so geometry edits cannot clear it. */
  const playlistLinkIntentRef = useRef(false);
  /** False until first snapshot per session — then intent overrides incoming playlist_link_enabled. Reset on project switch / undo / redo. */
  const playlistLinkIntentReadyRef = useRef(false);
  /** Latest link flag for synchronous toggles (avoids stale closures during rapid engine:state). */
  const playlistLinkEnabledRef = useRef(false);
  const playlistLinkTogglePendingRef = useRef(false);
  const appendConnectionLogEntry = useCallback((entry) => {
    const normalized = normalizeStructuredLogEntry({
      source: 'engine',
      ...entry,
    });
    if (!normalized) {
      return;
    }
    setConnectionLogs((prev) => {
      const next = [...prev, normalized];
      return next.length > LIVE_ENGINE_LOG_LIMIT ? next.slice(-LIVE_ENGINE_LOG_LIMIT) : next;
    });
  }, []);
  const pluginNameByUid = useMemo(() => {
    const map = new Map();
    for (const plugin of availablePlugins) {
      if (!isObject(plugin)) {
        continue;
      }
      const uid = typeof plugin.uid === 'string' ? plugin.uid.trim() : '';
      const name = typeof plugin.name === 'string' ? plugin.name.trim() : '';
      if (!uid || !name || map.has(uid)) {
        continue;
      }
      map.set(uid, name);
    }
    return map;
  }, [availablePlugins]);

  const applyEngineTransportPayload = useCallback((payload = {}) => {
    const previous = latestTransportRef.current;
    const merged = { ...previous, ...(isObject(payload) ? payload : {}) };
    latestTransportRef.current = merged;

    const snapshot = transportSnapshotRef.current;
    const payloadBeatsPerBar = Number(merged.beatsPerBar);
    const beatsPerBar = Number.isFinite(payloadBeatsPerBar) && payloadBeatsPerBar > 0
      ? payloadBeatsPerBar
      : Number(snapshot?.beatsPerBar);
    const safeBeatsPerBar = Number.isFinite(beatsPerBar) && beatsPerBar > 0 ? beatsPerBar : 4;
    const payloadBpm = Number(merged.bpm);
    const snapshotBpm = Number(snapshot?.bpm);
    const safeBpm = Number.isFinite(payloadBpm) && payloadBpm > 0
      ? payloadBpm
      : Number.isFinite(snapshotBpm) && snapshotBpm > 0
        ? snapshotBpm
        : FALLBACK_STATE.project.bpm;
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
    const timestamp = Number.isFinite(timestampRaw) ? timestampRaw : Date.now();
    const playing = Boolean(merged.playing ?? snapshot?.playing);

    transportSnapshotRef.current = {
      ...snapshot,
      bpm: safeBpm,
      beatsPerBar: safeBeatsPerBar,
      playing,
      positionBars,
      positionBeats,
      timestamp,
    };

    const nowMs = Date.now();
    const debug = transportDebugRef.current;
    if (playing) {
      let estimatedBpm = null;
      const lastBeats = typeof debug.lastPositionBeats === 'number' ? debug.lastPositionBeats : null;
      const lastTimestamp = typeof debug.lastTimestamp === 'number' ? debug.lastTimestamp : null;
      if (lastBeats != null && lastTimestamp != null) {
        const deltaBeats = positionBeats - lastBeats;
        const deltaMs = timestamp - lastTimestamp;
        if (deltaMs > 0 && deltaBeats >= 0) {
          const estimate = (deltaBeats / deltaMs) * 60000;
          if (Number.isFinite(estimate) && estimate > 0 && estimate < 400) {
            estimatedBpm = estimate;
          }
        }
      }
      debug.lastPositionBeats = positionBeats;
      debug.lastTimestamp = timestamp;
      if (nowMs - debug.lastLogMs >= 2000) {
        const estimatedText = Number.isFinite(estimatedBpm) ? estimatedBpm.toFixed(3) : 'n/a';
        console.log(
          `[thestuu-ui] transport payload bpm=${safeBpm.toFixed(3)} estBpm=${estimatedText} `
          + `positionBeats=${positionBeats.toFixed(6)} ts=${timestamp}`,
        );
        debug.lastLogMs = nowMs;
      }
    } else {
      debug.lastPositionBeats = null;
      debug.lastTimestamp = null;
      debug.lastLogMs = 0;
    }

    const lastUiCommit = transportUiCommitRef.current;
    const commitIntervalMs = playing ? 40 : 120;
    const shouldCommit =
      !playing
      || !lastUiCommit.playing
      || nowMs - lastUiCommit.lastMs >= commitIntervalMs;
    if (shouldCommit) {
      transportUiCommitRef.current = { lastMs: nowMs, playing };
      const meta = transportUiMetaRef.current;
      const recording = Boolean(merged.recording ?? snapshot?.recording);
      const metaChanged =
        !playing
        || safeBpm !== meta.bpm
        || playing !== meta.playing
        || recording !== meta.recording
        || safeBeatsPerBar !== meta.beatsPerBar;
      if (metaChanged) {
        transportUiMetaRef.current = {
          bpm: safeBpm,
          playing,
          recording,
          beatsPerBar: safeBeatsPerBar,
        };
        setTransport((current) => ({
          ...current,
          ...merged,
        }));
      }
    }
  }, []);

  useEffect(() => {
    clipDraftsRef.current = clipDrafts;
  }, [clipDrafts]);

  useEffect(() => {
    inspectorEqAnalyzerFrozenRef.current = inspectorEqAnalyzerFrozen;
  }, [inspectorEqAnalyzerFrozen]);

  useEffect(() => {
    return () => {
      if (importTrackRenamePromptResolverRef.current) {
        importTrackRenamePromptResolverRef.current({ apply: false, trackName: '' });
        importTrackRenamePromptResolverRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined') {
        clearFloatingWindowInteraction();
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(FLOATING_WINDOW_LAYOUTS_STORAGE_KEY, JSON.stringify(floatingWindowLayouts));
  }, [floatingWindowLayouts]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const handleResize = () => {
      setFloatingWindowLayouts((prev) => normalizeFloatingWindowLayouts(prev, getFloatingWindowViewportBounds()));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!showSettingsModal) {
      return;
    }
    activateFloatingWindowRef.current?.('settings', { unminimize: true });
  }, [showSettingsModal]);

  useEffect(() => {
    if (recordMicModalTrackId == null) {
      return;
    }
    activateFloatingWindowRef.current?.('recordMic', { unminimize: true });
  }, [recordMicModalTrackId]);

  useEffect(() => {
    if (trackChainModalTrackId == null) {
      return;
    }
    activateFloatingWindowRef.current?.('trackChain', { unminimize: true });
  }, [trackChainModalTrackId]);

  useEffect(() => {
    if (!importTrackRenamePrompt) {
      return;
    }
    activateFloatingWindowRef.current?.('importTrackRename', { unminimize: true });
  }, [importTrackRenamePrompt]);

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
    if (!aiChatDrawerOpen) {
      return undefined;
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setAiChatDrawerOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [aiChatDrawerOpen]);

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

    const handleConnect = () => {
      setConnection('online');
      appendConnectionLogEntry({ level: 'info', text: '[thestuu-ui] socket connected' });
    };
    const handleDisconnect = () => {
      if (pluginScanAckTimeoutRef.current) {
        clearTimeout(pluginScanAckTimeoutRef.current);
        pluginScanAckTimeoutRef.current = null;
      }
      setPluginScanPending(false);
      setConnection('offline');
      appendConnectionLogEntry({ level: 'warn', source: 'ui', text: '[thestuu-ui] socket disconnected' });
    };
    const handleConnectError = () => {
      if (pluginScanAckTimeoutRef.current) {
        clearTimeout(pluginScanAckTimeoutRef.current);
        pluginScanAckTimeoutRef.current = null;
      }
      setPluginScanPending(false);
      setConnection('offline');
      appendConnectionLogEntry({ level: 'error', source: 'ui', text: '[thestuu-ui] socket connect_error' });
    };
    const handleReconnectAttempt = () => {
      setConnection('connecting');
      appendConnectionLogEntry({ level: 'info', source: 'ui', text: '[thestuu-ui] socket reconnect_attempt' });
    };
    const handleEngineLogsInit = (payload) => {
      const entries = Array.isArray(payload?.entries)
        ? payload.entries.map((e) => normalizeStructuredLogEntry({ source: 'engine', ...e })).filter(Boolean)
        : [];
      setConnectionLogs(entries.slice(-LIVE_ENGINE_LOG_LIMIT));
    };
    const handleEngineLog = (entry) => {
      appendConnectionLogEntry(entry);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.io.on('reconnect_attempt', handleReconnectAttempt);
    const handleEngineDiagnostics = (payload) => {
      setEngineDiagnostics(mapEngineDiagnostics(payload?.diagnostics ?? payload));
    };
    socket.on('engine:ready', (payload) => {
      if (Number.isFinite(payload?.enginePort)) setEnginePort(payload.enginePort);
      handleEngineDiagnostics(payload);
    });
    socket.on('engine:diagnostics', handleEngineDiagnostics);
    socket.on('engine:logs:init', handleEngineLogsInit);
    socket.on('engine:log', handleEngineLog);
    socket.on('engine:state', (payload) => {
      const dbg = splitDebugSessionRef.current;
      if (dbg.until > Date.now() && dbg.trackId != null) {
        const playlist = Array.isArray(payload?.project?.playlist) ? payload.project.playlist : [];
        console.log('[CLIENT_ENGINE_STATE_CLIPS]', playlist.map((tr) => ({
          trackId: tr.track_id,
          clips: Array.isArray(tr.clips)
            ? tr.clips.map((c) => ({
              id: c.id,
              start: c.start,
              length: c.length,
              trim_start_seconds: c.trim_start_seconds,
              source_name: c.source_name,
            }))
            : [],
        })));
      }
      const session = mixLevelDragSessionRef.current;
      let mergedPayload = payload;
      if (session && isObject(payload) && isObject(payload.project)) {
        const project = { ...payload.project };
        let touched = false;
        if (session.kind === 'volume') {
          if (session.trackId === 0) {
            const mm = normalizeMasterMix(project.master_mix);
            project.master_mix = { ...mm, volume: session.lastValue };
            touched = true;
          } else {
            const mixer = Array.isArray(project.mixer)
              ? project.mixer.map((e) => (isObject(e) ? { ...e } : e))
              : [];
            const i = mixer.findIndex((e) => isObject(e) && Number(e.track_id) === session.trackId);
            if (i >= 0) {
              mixer[i] = { ...mixer[i], volume: session.lastValue };
              project.mixer = mixer;
              touched = true;
            }
          }
        } else if (session.kind === 'pan') {
          if (session.trackId === 0) {
            const mm = normalizeMasterMix(project.master_mix);
            project.master_mix = { ...mm, pan: session.lastValue };
            touched = true;
          } else {
            const mixer = Array.isArray(project.mixer)
              ? project.mixer.map((e) => (isObject(e) ? { ...e } : e))
              : [];
            const i = mixer.findIndex((e) => isObject(e) && Number(e.track_id) === session.trackId);
            if (i >= 0) {
              mixer[i] = { ...mixer[i], pan: session.lastValue };
              project.mixer = mixer;
              touched = true;
            }
          }
        }
        if (touched) {
          mergedPayload = { ...payload, project };
        }
      }
      setState((prev) => {
        let next = mergedPayload;
        if (!isObject(next)) {
          return prev;
        }
        const prevFile =
          typeof prev.selectedProjectFile === 'string' ? prev.selectedProjectFile : FALLBACK_STATE.selectedProjectFile;
        const nextFile =
          typeof next.selectedProjectFile === 'string' ? next.selectedProjectFile : FALLBACK_STATE.selectedProjectFile;
        if (prevFile !== nextFile) {
          playlistLinkIntentReadyRef.current = false;
        }
        const incomingSs = next.project?.song_structure;
        if (isObject(incomingSs)) {
          if (!playlistLinkIntentReadyRef.current) {
            playlistLinkIntentRef.current = Boolean(incomingSs.playlist_link_enabled);
            playlistLinkIntentReadyRef.current = true;
          } else {
            next = {
              ...next,
              project: {
                ...next.project,
                song_structure: {
                  ...incomingSs,
                  playlist_link_enabled: playlistLinkIntentRef.current,
                },
              },
            };
          }
        }
        return next;
      });
      setTrackChainEnabledOverrides({});
    });
    const unbindMeters = bindMeterSocket ? bindMeterSocket(socket) : () => {};
    socket.on('engine:analyzer', (payload) => {
      if (inspectorEqAnalyzerFrozenRef.current) {
        return;
      }
      setInspectorEqAnalyzerFrame(normalizeIncomingEqAnalyzerFrame(payload));
    });
    socket.on('engine:transport', (payload) => {
      applyEngineTransportPayload(payload);
    });
    socket.on('engine:offline', (payload) => {
      applyEngineTransportPayload({
        playing: false,
        recording: false,
        timestamp: Date.now(),
      });
      setEngineDiagnostics(mapEngineDiagnostics({
        nativeProcessRunning: false,
        ipcConnected: false,
        tracktionReady: false,
        audioDeviceReady: false,
        dawReady: false,
      }));
      const reason = isObject(payload) && typeof payload.message === 'string'
        ? payload.message
        : 'Native-Engine offline — Transport und DAW-Bearbeitung sind deaktiviert.';
      appendConnectionLogEntry({ level: 'warn', message: reason });
    });

    return () => {
      if (pluginScanAckTimeoutRef.current) {
        clearTimeout(pluginScanAckTimeoutRef.current);
        pluginScanAckTimeoutRef.current = null;
      }
      setPluginScanPending(false);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off('engine:logs:init', handleEngineLogsInit);
      socket.off('engine:log', handleEngineLog);
      socket.off('engine:ready');
      socket.off('engine:diagnostics');
      unbindMeters();
      socket.off('engine:state');
      socket.off('engine:analyzer');
      socket.off('engine:transport');
      socket.off('engine:offline');
      socket.io.off('reconnect_attempt', handleReconnectAttempt);
      socket.close();
    };
  }, [appendConnectionLogEntry, applyEngineTransportPayload, bindMeterSocket]);

  useEffect(() => {
    setPerformanceProfileState(getPerformanceProfile());
  }, []);

  useEffect(() => {
    if (connection !== 'online' || !state?.nativeTransport || !socketRef.current) {
      return;
    }
    socketRef.current.emit('audio:get-outputs', {}, (res) => {
      if (res?.ok && Array.isArray(res.devices)) {
        setAudioOutputDevices(res.devices);
        if (typeof res.currentId === 'string') setAudioOutputCurrentId(res.currentId);
      }
      if (res?.ok && (res.sampleRate != null || res.blockSize != null || res.outputChannels != null)) {
        setAudioStatus({
          sampleRate: typeof res.sampleRate === 'number' ? res.sampleRate : null,
          blockSize: typeof res.blockSize === 'number' ? res.blockSize : null,
          outputLatencySeconds: typeof res.outputLatencySeconds === 'number' ? res.outputLatencySeconds : null,
          outputChannels: typeof res.outputChannels === 'number' ? res.outputChannels : null,
        });
      } else {
        setAudioStatus(null);
      }
    });
    socketRef.current.emit('audio:get-inputs', {}, (res) => {
      if (res?.ok && Array.isArray(res.devices)) {
        setAudioInputDevices(res.devices);
        if (typeof res.currentId === 'string') setAudioInputCurrentId(res.currentId);
      }
    });
  }, [connection, state?.nativeTransport]);

  useEffect(() => {
    if (recordMicModalTrackId == null || !socketRef.current || connection !== 'online' || !state?.nativeTransport) {
      return;
    }
    socketRef.current.emit('audio:get-inputs', {}, (res) => {
      if (res?.ok && Array.isArray(res.devices)) {
        setRecordMicInputDevices(res.devices);
      }
    });
  }, [recordMicModalTrackId, connection, state?.nativeTransport]);

  useEffect(() => {
    if (!showSettingsModal || !socketRef.current || connection !== 'online' || !state?.nativeTransport) {
      return;
    }
    socketRef.current.emit('audio:get-outputs', {}, (res) => {
      if (res?.ok && Array.isArray(res.devices)) {
        setAudioOutputDevices(res.devices);
        if (typeof res.currentId === 'string') setAudioOutputCurrentId(res.currentId);
      }
      if (res?.ok && (res.sampleRate != null || res.blockSize != null || res.outputChannels != null)) {
        setAudioStatus({
          sampleRate: typeof res.sampleRate === 'number' ? res.sampleRate : null,
          blockSize: typeof res.blockSize === 'number' ? res.blockSize : null,
          outputLatencySeconds: typeof res.outputLatencySeconds === 'number' ? res.outputLatencySeconds : null,
          outputChannels: typeof res.outputChannels === 'number' ? res.outputChannels : null,
        });
      } else {
        setAudioStatus(null);
      }
    });
    socketRef.current.emit('audio:get-inputs', {}, (res) => {
      if (res?.ok && Array.isArray(res.devices)) {
        setAudioInputDevices(res.devices);
        if (typeof res.currentId === 'string') setAudioInputCurrentId(res.currentId);
      }
    });
  }, [showSettingsModal, connection, state?.nativeTransport]);

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

  useEffect(() => {
    if (activeTab !== 'Edit') {
      return;
    }
    const scrollElement = arrangementScrollRef.current;
    const trackRowsElement = arrangementTrackRowsRef.current;
    if (!scrollElement || !trackRowsElement) {
      return;
    }
    const syncTrackRowsToGrid = () => {
      const nextTop = scrollElement.scrollTop;
      if (Math.abs(trackRowsElement.scrollTop - nextTop) > 0.25) {
        trackRowsElement.scrollTop = nextTop;
      }
    };

    scrollElement.addEventListener('scroll', syncTrackRowsToGrid, { passive: true });
    syncTrackRowsToGrid();

    return () => {
      scrollElement.removeEventListener('scroll', syncTrackRowsToGrid);
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
  const masterMix = useMemo(() => normalizeMasterMix(state?.project?.master_mix), [state?.project?.master_mix]);
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

  const anyTrackSolo = useMemo(
    () => arrangementTracks.some((track) => track.exists && Boolean(track.mix?.solo)),
    [arrangementTracks],
  );

  const playlistOverviewPeaks = useMemo(() => {
    const bpm = Number(state?.project?.bpm) || 128;
    return buildPlaylistOverviewPeaks({
      tracks: arrangementTracks,
      maxClipEnd,
      bpm,
      timeSignature,
      clipMuteOverrides,
      anyTrackSolo,
    });
  }, [
    arrangementTracks,
    maxClipEnd,
    state?.project?.bpm,
    timeSignature,
    clipMuteOverrides,
    anyTrackSolo,
  ]);

  const metronomeEnabled = normalizeMetronomeEnabled(state?.project?.metronome_enabled);
  const isMetronomeRunning = metronomeEnabled && Boolean(state?.playing);
  const projectBpmForInput = useMemo(() => {
    const bpm = Number(state?.project?.bpm);
    const normalized = Number.isFinite(bpm) && bpm > 0 ? Math.round(bpm) : FALLBACK_STATE.project.bpm;
    return Math.min(300, Math.max(20, normalized));
  }, [state?.project?.bpm]);
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

  useEffect(() => {
    if (!isBpmInputFocused) {
      setBpmInputValue(String(projectBpmForInput));
    }
  }, [projectBpmForInput, isBpmInputFocused]);

  const commitBpmInput = useCallback(() => {
    const normalizedRaw = String(bpmInputValue || '').trim().replace(',', '.');
    if (!normalizedRaw) {
      setBpmInputValue(String(projectBpmForInput));
      return;
    }
    const parsed = Number(normalizedRaw);
    if (!Number.isFinite(parsed)) {
      setBpmInputValue(String(projectBpmForInput));
      return;
    }
    const nextBpm = Math.round(clamp(parsed, 20, 300));
    setBpmInputValue(String(nextBpm));
    if (nextBpm !== projectBpmForInput) {
      socketRef.current?.emit('transport:set-bpm', { bpm: nextBpm }, (result) => {
        if (!result?.ok) {
          setChatMessages((previous) => [
            ...previous,
            { role: 'system', text: `Fehler (transport:set-bpm): ${result?.error || 'Unbekannter Fehler'}` },
          ]);
        }
      });
    }
  }, [bpmInputValue, projectBpmForInput]);

  const handleBpmInputChange = useCallback((event) => {
    const raw = String(event?.target?.value ?? '');
    if (raw === '') {
      setBpmInputValue('');
      return;
    }
    if (/^\d{0,3}$/.test(raw)) {
      setBpmInputValue(raw);
    }
  }, []);

  const handleBpmInputFocus = useCallback(() => {
    setIsBpmInputFocused(true);
  }, []);

  const handleBpmInputBlur = useCallback(() => {
    setIsBpmInputFocused(false);
    commitBpmInput();
  }, [commitBpmInput]);

  const handleBpmInputKeyDown = useCallback((event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setBpmInputValue(String(projectBpmForInput));
      setIsBpmInputFocused(false);
      event.currentTarget.blur();
    }
  }, [projectBpmForInput]);

  useEffect(() => {
    timelineBarsRef.current = timelineBars;
  }, [timelineBars]);

  useEffect(() => {
    const beatsPerBarRaw = (timeSignature.numerator * 4) / timeSignature.denominator;
    const beatsPerBar = Number.isFinite(beatsPerBarRaw) && beatsPerBarRaw > 0 ? beatsPerBarRaw : 4;
    const bpm = Number(state?.project?.bpm);
    const normalizedBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 128;
    const snapshot = transportSnapshotRef.current;
    const snapshotBpm = Number(snapshot?.bpm);
    const keepSnapshotBpmWhilePlaying = Boolean(snapshot?.playing) && Number.isFinite(snapshotBpm) && snapshotBpm > 0;

    transportSnapshotRef.current = {
      ...snapshot,
      bpm: keepSnapshotBpmWhilePlaying ? snapshotBpm : normalizedBpm,
      beatsPerBar,
      playing: Boolean(state?.playing ?? snapshot.playing),
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
    const raw = playheadDragBarsRef.current;
    if (raw != null && Number.isFinite(Number(raw))) {
      return Math.max(0, Number(raw));
    }
    return Math.max(0, computeInterpolatedPlayheadBars(Date.now()));
  }, [computeInterpolatedPlayheadBars]);
  const metronomeNumerator = Number(timeSignature.numerator) || 4;
  const metronomeDenominator = Number(timeSignature.denominator) || 4;
  const ensureMetronomeAudioContext = useCallback(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return null;
    }
    if (!metronomeAudioContextRef.current) {
      try {
        metronomeAudioContextRef.current = new AudioContextClass();
      } catch {
        metronomeAudioContextRef.current = null;
      }
    }
    return metronomeAudioContextRef.current;
  }, []);

  const primeMetronomeAudio = useCallback(() => {
    const context = ensureMetronomeAudioContext();
    if (!context) {
      return;
    }
    if (context.state === 'suspended') {
      context.resume().catch(() => {});
    }
  }, [ensureMetronomeAudioContext]);

  const triggerMetronomeTick = useCallback((accent = 'weak') => {
    const debug = metronomeDebugRef.current;
    const nowPerfMs = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    const targetBpm = Number(transportSnapshotRef.current?.bpm);
    const safeTargetBpm = Number.isFinite(targetBpm) && targetBpm > 0 ? targetBpm : FALLBACK_STATE.project.bpm;
    let measuredBpm = null;
    if (debug.lastTickMs > 0) {
      const deltaMs = nowPerfMs - debug.lastTickMs;
      if (deltaMs > 0) {
        const estimate = 60000 / deltaMs;
        if (Number.isFinite(estimate) && estimate > 0 && estimate < 400) {
          measuredBpm = estimate;
        }
      }
    }
    debug.tickCount += 1;
    if (debug.tickCount <= 8 || nowPerfMs - debug.lastLogMs >= 2000) {
      console.log(
        `[thestuu-ui] metronome tick #${debug.tickCount} accent=${accent} targetBpm=${safeTargetBpm.toFixed(3)} `
        + `measuredBpm=${Number.isFinite(measuredBpm) ? measuredBpm.toFixed(3) : 'n/a'}`,
      );
      debug.lastLogMs = nowPerfMs;
    }
    debug.lastTickMs = nowPerfMs;

    const context = ensureMetronomeAudioContext();
    if (!context) {
      return;
    }
    if (context.state === 'suspended') {
      context.resume().catch(() => {});
      return;
    }

    const now = context.currentTime;
    const masterGain = context.createGain();
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const transientOscillator = context.createOscillator();
    const transientEnvelope = context.createGain();
    const tone = accent === 'strong' ? 1980 : accent === 'medium' ? 1620 : 1340;
    const level = accent === 'strong' ? 0.24 : accent === 'medium' ? 0.19 : 0.15;
    const transientTone = accent === 'strong' ? 3900 : accent === 'medium' ? 3400 : 3000;
    const transientLevel = accent === 'strong' ? 0.12 : accent === 'medium' ? 0.095 : 0.08;

    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(tone, now);
    transientOscillator.type = 'triangle';
    transientOscillator.frequency.setValueAtTime(transientTone, now);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(level, now + 0.0007);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.036);
    transientEnvelope.gain.setValueAtTime(0.0001, now);
    transientEnvelope.gain.exponentialRampToValueAtTime(transientLevel, now + 0.0004);
    transientEnvelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.012);
    masterGain.gain.setValueAtTime(1, now);

    oscillator.connect(envelope);
    envelope.connect(masterGain);
    transientOscillator.connect(transientEnvelope);
    transientEnvelope.connect(masterGain);
    masterGain.connect(context.destination);

    oscillator.start(now);
    transientOscillator.start(now);
    transientOscillator.stop(now + 0.014);
    oscillator.stop(now + 0.045);
  }, [ensureMetronomeAudioContext]);

  useEffect(() => {
    if (!isMetronomeRunning) {
      metronomeLastStepRef.current = null;
      metronomeClockRef.current = {
        anchorMs: 0,
        anchorBeats: 0,
        bpm: FALLBACK_STATE.project.bpm,
      };
      if (metronomeFrameRef.current != null) {
        window.cancelAnimationFrame(metronomeFrameRef.current);
        metronomeFrameRef.current = null;
      }
      if (metronomeNeedleRef.current) {
        metronomeNeedleRef.current.setAttribute('transform', 'rotate(0 32 45)');
      }
      metronomeDebugRef.current = {
        tickCount: 0,
        lastTickMs: 0,
        lastLogMs: 0,
      };
      return undefined;
    }

    const signature = { numerator: metronomeNumerator, denominator: metronomeDenominator };
    const stepBeatsRaw = getMetronomeStepBeats(signature);
    const stepBeats = Number.isFinite(stepBeatsRaw) && stepBeatsRaw > 0 ? stepBeatsRaw : 1;
    const epsilon = stepBeats * 0.03;

    const renderFrame = () => {
      const nowMs = Date.now();
      const clock = metronomeClockRef.current;
      const snapshot = transportSnapshotRef.current;
      const snapshotBpm = Number(snapshot?.bpm);
      const stateBpm = Number(state?.project?.bpm);
      const bpmRaw = Number.isFinite(snapshotBpm) && snapshotBpm > 0 ? snapshotBpm : stateBpm;
      const safeBpm = Number.isFinite(bpmRaw) && bpmRaw > 0 ? Math.min(300, Math.max(20, bpmRaw)) : FALLBACK_STATE.project.bpm;
      const snapshotBeats = Number(snapshot?.positionBeats);

      if (clock.anchorMs <= 0) {
        clock.anchorMs = nowMs;
        clock.anchorBeats = Number.isFinite(snapshotBeats) ? Math.max(0, snapshotBeats) : 0;
        clock.bpm = safeBpm;
      }

      if (Math.abs(clock.bpm - safeBpm) > 0.0001) {
        const elapsedMsBeforeBpmChange = Math.max(0, nowMs - clock.anchorMs);
        clock.anchorBeats = Math.max(0, clock.anchorBeats + (elapsedMsBeforeBpmChange * clock.bpm) / 60000);
        clock.anchorMs = nowMs;
        clock.bpm = safeBpm;
      }

      let positionBeats = Math.max(0, clock.anchorBeats + (Math.max(0, nowMs - clock.anchorMs) * clock.bpm) / 60000);
      if (Number.isFinite(snapshotBeats) && Math.abs(snapshotBeats - positionBeats) > 8) {
        // Follow explicit seeks/stops from transport state, but otherwise keep BPM-true local clock.
        clock.anchorBeats = Math.max(0, snapshotBeats);
        clock.anchorMs = nowMs;
        positionBeats = clock.anchorBeats;
      }
      const currentStep = Math.floor((positionBeats + epsilon) / stepBeats);

      if (!Number.isInteger(metronomeLastStepRef.current)) {
        const nearestStepBeat = currentStep * stepBeats;
        const nearStepBoundary = Math.abs(positionBeats - nearestStepBeat) <= epsilon;
        metronomeLastStepRef.current = nearStepBoundary ? (currentStep - 1) : currentStep;
      }

      while (metronomeLastStepRef.current < currentStep) {
        metronomeLastStepRef.current += 1;
        const accent = getMetronomeAccent(metronomeLastStepRef.current, signature);
        triggerMetronomeTick(accent);
      }

      if (metronomeNeedleRef.current) {
        const swingPhase = positionBeats * Math.PI;
        const angleDeg = Math.sin(swingPhase) * 20;
        metronomeNeedleRef.current.setAttribute('transform', `rotate(${angleDeg.toFixed(2)} 32 45)`);
      }

      metronomeFrameRef.current = window.requestAnimationFrame(renderFrame);
    };

    metronomeFrameRef.current = window.requestAnimationFrame(renderFrame);
    return () => {
      if (metronomeFrameRef.current != null) {
        window.cancelAnimationFrame(metronomeFrameRef.current);
        metronomeFrameRef.current = null;
      }
    };
  }, [isMetronomeRunning, metronomeNumerator, metronomeDenominator, triggerMetronomeTick, state?.project?.bpm]);

  useEffect(() => () => {
    if (metronomeFrameRef.current != null) {
      window.cancelAnimationFrame(metronomeFrameRef.current);
      metronomeFrameRef.current = null;
    }
    const context = metronomeAudioContextRef.current;
    metronomeAudioContextRef.current = null;
    if (context && typeof context.close === 'function') {
      context.close().catch(() => {});
    }
  }, []);

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
      if (!Number.isInteger(trackId) || trackId < 0) {
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
  const mixMasterNodes = useMemo(() => vstNodesByTrack.get(0) || [], [vstNodesByTrack]);
  const mixMasterChainEnabled = useMemo(() => {
    if (trackChainEnabledOverrides[0] !== undefined) {
      return trackChainEnabledOverrides[0] !== false;
    }
    return masterMix.chain_enabled !== false;
  }, [trackChainEnabledOverrides, masterMix.chain_enabled]);
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

  const inspectorTracktionEqUi = useMemo(() => {
    if (!inspectorNode || inspectorNode.type !== 'vst_instrument') {
      return null;
    }

    const token = resolveTracktionPluginToken(inspectorNode.plugin_uid, inspectorNode.plugin);
    if (token !== '4bandeq') {
      return null;
    }

    const gainParams = buildTracktionEqInspectorGainParams(inspectorNodeParameters);
    const curve = buildTracktionEqInspectorCurveData(inspectorNodeParameters);
    return {
      gainParams,
      isEffectivelyFlat: isTracktionEqInspectorEffectivelyFlat(gainParams),
      easyMacros: deriveTracktionEqInspectorEasyMacros(gainParams),
      curve,
    };
  }, [inspectorNode, inspectorNodeParameters]);

  const inspectorEqAnalyzerAvailable = connection === 'online' && state?.nativeTransport === true;
  const inspectorTracktionEqAnalyzerOverlay = useMemo(() => {
    if (!inspectorTracktionEqUi?.curve || !inspectorEqAnalyzerFrame) {
      return null;
    }
    return buildTracktionEqAnalyzerOverlayData(inspectorTracktionEqUi.curve, inspectorEqAnalyzerFrame);
  }, [inspectorTracktionEqUi, inspectorEqAnalyzerFrame]);
  const inspectorTracktionEqAnalyzerStatusText = useMemo(() => {
    if (!inspectorEqAnalyzerAvailable) {
      return 'Analyzer nur mit Native-Engine';
    }
    if (!inspectorTracktionEqAnalyzerOverlay) {
      return 'Analyzer wartet auf Signal';
    }
    const mode = inspectorTracktionEqAnalyzerOverlay.preMirrorsPost ? 'PRE≈POST' : 'PRE/POST';
    return `${inspectorTracktionEqAnalyzerOverlay.scope.toUpperCase()} · ${mode}`;
  }, [inspectorEqAnalyzerAvailable, inspectorTracktionEqAnalyzerOverlay]);

  const inspectorTracktionEqSelectedBand = useMemo(() => {
    const bands = inspectorTracktionEqUi?.curve?.bands;
    if (!Array.isArray(bands) || bands.length === 0) {
      return null;
    }
    return bands.find((band) => band.id === inspectorEqSelectedBandId) || bands[1] || bands[0] || null;
  }, [inspectorTracktionEqUi, inspectorEqSelectedBandId]);

  const inspectorTracktionEqBandByParamId = useMemo(() => {
    const map = new Map();
    const bands = inspectorTracktionEqUi?.curve?.bands;
    if (!Array.isArray(bands)) {
      return map;
    }
    for (const band of bands) {
      const ids = [band?.paramIds?.freq, band?.paramIds?.gain, band?.paramIds?.q];
      for (const id of ids) {
        if (typeof id === 'string' && id.trim() && !map.has(id)) {
          map.set(id, band);
        }
      }
    }
    return map;
  }, [inspectorTracktionEqUi]);

  const inspectorTracktionEqCurveReadout = useMemo(() => {
    if (inspectorEqPinnedReadout && Number.isFinite(inspectorEqPinnedReadout.freqHz) && Number.isFinite(inspectorEqPinnedReadout.gainDb)) {
      return inspectorEqPinnedReadout;
    }
    if (inspectorEqCurveHover && Number.isFinite(inspectorEqCurveHover.freqHz) && Number.isFinite(inspectorEqCurveHover.gainDb)) {
      return inspectorEqCurveHover;
    }
    if (inspectorTracktionEqSelectedBand) {
      return {
        source: 'band',
        bandId: inspectorTracktionEqSelectedBand.id,
        label: inspectorTracktionEqSelectedBand.label,
        freqHz: inspectorTracktionEqSelectedBand.freqHz,
        gainDb: inspectorTracktionEqSelectedBand.gainDb,
      };
    }
    return null;
  }, [inspectorEqPinnedReadout, inspectorEqCurveHover, inspectorTracktionEqSelectedBand]);

  const inspectorTracktionEqMiniCurveHighlightBandId = useMemo(() => {
    if (typeof inspectorEqPinnedReadout?.bandId === 'string' && inspectorEqPinnedReadout.bandId) {
      return inspectorEqPinnedReadout.bandId;
    }
    if (typeof inspectorEqCurveHover?.bandId === 'string' && inspectorEqCurveHover.bandId) {
      return inspectorEqCurveHover.bandId;
    }
    return inspectorEqSelectedBandId;
  }, [inspectorEqPinnedReadout, inspectorEqCurveHover, inspectorEqSelectedBandId]);

  const inspectorTracktionEqSelectedBandParamIdSet = useMemo(() => {
    const ids = [
      inspectorTracktionEqSelectedBand?.paramIds?.freq,
      inspectorTracktionEqSelectedBand?.paramIds?.gain,
      inspectorTracktionEqSelectedBand?.paramIds?.q,
    ].filter((id) => typeof id === 'string' && id.trim());
    return new Set(ids);
  }, [inspectorTracktionEqSelectedBand]);

  const inspectorTracktionEqSelectedBandParamKey = useMemo(() => {
    return Array.from(inspectorTracktionEqSelectedBandParamIdSet).join('|');
  }, [inspectorTracktionEqSelectedBandParamIdSet]);

  useEffect(() => {
    if (inspector.type !== 'node') {
      return;
    }
    setInspectorEqViewMode('easy');
    setInspectorEqSelectedBandId('mid1');
    setInspectorEqCurveHover(null);
    setInspectorEqPinnedReadout(null);
    setInspectorEqAnalyzerFrozen(false);
  }, [inspector.type, inspectorNode?.id]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    const isEqNode = inspector.type === 'node'
      && inspectorNode?.type === 'vst_instrument'
      && resolveTracktionPluginToken(inspectorNode?.plugin_uid, inspectorNode?.plugin) === '4bandeq';

    if (isEqNode) {
      const trackId = Number(inspectorNode?.track_id ?? inspectorNode?.trackId);
      const pluginIndex = Number(inspectorNode?.plugin_index ?? inspectorNode?.pluginIndex);
      if (Number.isInteger(trackId) && trackId > 0) {
        socket.emit('analyzer:set-target', {
          mode: 'track',
          trackId,
          pluginIndex: Number.isInteger(pluginIndex) ? pluginIndex : -1,
        });
        return;
      }
    }

    socket.emit('analyzer:set-target', { mode: 'master' });
  }, [
    connection,
    inspector.type,
    inspectorNode?.id,
    inspectorNode?.type,
    inspectorNode?.plugin_uid,
    inspectorNode?.plugin,
    inspectorNode?.track_id,
    inspectorNode?.trackId,
    inspectorNode?.plugin_index,
    inspectorNode?.pluginIndex,
  ]);

  useEffect(() => {
    if (inspectorEqViewMode !== 'pro' || !inspectorTracktionEqSelectedBandParamKey) {
      return;
    }

    const selectedParamIds = inspectorTracktionEqSelectedBandParamKey.split('|').filter(Boolean);
    const targetParamId = selectedParamIds.find((paramId) => inspectorEqProParamRowRefs.current.has(paramId));
    if (!targetParamId) {
      return;
    }

    const targetRow = inspectorEqProParamRowRefs.current.get(targetParamId);
    if (!targetRow || typeof targetRow.scrollIntoView !== 'function') {
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [inspectorEqViewMode, inspectorNode?.id, inspectorTracktionEqSelectedBandParamKey]);

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
    if (openTrackPluginPicker && openTrackPluginPicker.trackId !== 0 && !existingTrackIds.includes(openTrackPluginPicker.trackId)) {
      setOpenTrackPluginPicker(null);
    }
  }, [openTrackPluginPicker, existingTrackIds]);

  useEffect(() => {
    if (trackChainModalTrackId !== null && trackChainModalTrackId !== 0 && !existingTrackIds.includes(trackChainModalTrackId)) {
      setTrackChainModalTrackId(null);
    }
  }, [trackChainModalTrackId, existingTrackIds]);

  useEffect(() => {
    if (!multiSelectMode) {
      setSelectedTrackIds([]);
    }
  }, [multiSelectMode]);

  useEffect(() => {
    if (activeTab === 'Edit' || activeTab === 'Mix') {
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

  useEffect(() => () => {
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.abort();
      speechRecognitionRef.current = null;
    }
  }, []);

  function getSpeechRecognitionConstructor() {
    if (typeof window === 'undefined') {
      return null;
    }
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function toggleSpeechRecognition() {
    if (speechListening) {
      speechRecognitionRef.current?.stop();
      setSpeechListening(false);
      return;
    }

    const SpeechRecognition = getSpeechRecognitionConstructor();
    if (!SpeechRecognition) {
      appendSystemMessage('Spracheingabe ist in diesem Browser nicht verfuegbar. In Chrome/Edge unter HTTPS oder localhost versuchen.');
      return;
    }

    const recognition = new SpeechRecognition();
    speechRecognitionRef.current = recognition;
    recognition.lang = 'de-DE';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setSpeechListening(true);
    };

    recognition.onresult = (event) => {
      const transcript = Array.from(event.results || [])
        .slice(event.resultIndex || 0)
        .map((result) => result?.[0]?.transcript || '')
        .join(' ')
        .trim();

      if (!transcript) {
        return;
      }

      setChatInput((previous) => {
        const trimmed = previous.trim();
        return trimmed ? `${trimmed} ${transcript}` : transcript;
      });
    };

    recognition.onerror = (event) => {
      setSpeechListening(false);
      appendSystemMessage(`Spracheingabe fehlgeschlagen: ${event?.error || 'Unbekannter Fehler'}`);
    };

    recognition.onend = () => {
      setSpeechListening(false);
      if (speechRecognitionRef.current === recognition) {
        speechRecognitionRef.current = null;
      }
    };

    try {
      recognition.start();
    } catch (error) {
      setSpeechListening(false);
      speechRecognitionRef.current = null;
      appendSystemMessage(`Spracheingabe konnte nicht gestartet werden: ${error?.message || 'Unbekannter Fehler'}`);
    }
  }

  const applyProjectBpm = useCallback((rawBpm, { sourceLabel = 'Analyse' } = {}) => {
    const parsed = Number(rawBpm);
    if (!Number.isFinite(parsed)) {
      appendSystemMessage(`Fehler (transport:set-bpm): Ungueltiger BPM-Wert aus ${sourceLabel}.`);
      return;
    }
    const nextBpm = Math.round(clamp(parsed, 20, 300));
    setBpmInputValue(String(nextBpm));
    const socket = socketRef.current;
    if (!socket) {
      appendSystemMessage('Fehler (transport:set-bpm): Keine Engine-Verbindung.');
      return;
    }
    socket.emit('transport:set-bpm', { bpm: nextBpm }, (result) => {
      if (!result?.ok) {
        appendSystemMessage(`Fehler (transport:set-bpm): ${result?.error || 'Unbekannter Fehler'}`);
        return;
      }
      appendSystemMessage(`Projekt-BPM auf ${nextBpm} gesetzt (${sourceLabel}).`);
    });
  }, [appendSystemMessage]);

  const emitMutation = useCallback((eventName, payload, onSuccess) => {
    if (eventName === 'clip:resize' || eventName === 'clip:import-file' || eventName === 'clip:move') {
      console.log('[MUTATION_SEND]', eventName, payload);
    }
    socketRef.current?.emit(eventName, payload, (result) => {
      if (eventName === 'clip:resize' || eventName === 'clip:import-file' || eventName === 'clip:move') {
        console.log('[MUTATION_RESULT]', eventName, result);
      }
      if (result?.ok) {
        if (onSuccess) {
          onSuccess(result);
        }
        return;
      }
      appendSystemMessage(`Fehler (${eventName}): ${result?.error || 'Unbekannter Fehler'}`);
    });
  }, [appendSystemMessage]);

  const songStructure = useMemo(() => {
    const raw = state?.project?.song_structure;
    return {
      template_id: raw?.template_id ?? null,
      template_name: raw?.template_name ?? null,
      playlist_link_enabled: Boolean(raw?.playlist_link_enabled),
      nodes: Array.isArray(raw?.nodes) ? raw.nodes : [],
    };
  }, [state?.project?.song_structure]);

  useEffect(() => {
    playlistLinkEnabledRef.current = songStructure.playlist_link_enabled;
  }, [songStructure.playlist_link_enabled]);

  const handleStructurePlaylistLinkToggle = useCallback(() => {
    if (playlistLinkTogglePendingRef.current) {
      return;
    }
    const socket = socketRef.current;
    if (!socket || connection !== 'online') {
      appendSystemMessage('Engine nicht verbunden — Structure-Link kann nicht umgeschaltet werden.');
      return;
    }
    const prevEnabled = playlistLinkEnabledRef.current;
    const nextEnabled = !prevEnabled;
    playlistLinkTogglePendingRef.current = true;
    playlistLinkIntentRef.current = nextEnabled;
    playlistLinkIntentReadyRef.current = true;
    playlistLinkEnabledRef.current = nextEnabled;

    startTransition(() => {
      setState((statePrev) => {
        const ss = statePrev.project?.song_structure;
        const base = isObject(ss) ? ss : {};
        return {
          ...statePrev,
          project: {
            ...statePrev.project,
            song_structure: {
              ...base,
              playlist_link_enabled: nextEnabled,
            },
          },
        };
      });
    });

    socket.emit(
      'song-structure:set-playlist-link',
      { playlist_link_enabled: nextEnabled },
      (result) => {
        playlistLinkTogglePendingRef.current = false;
        if (result?.ok) {
          return;
        }
        playlistLinkIntentRef.current = prevEnabled;
        playlistLinkEnabledRef.current = prevEnabled;
        startTransition(() => {
          setState((statePrev) => {
            const ss = statePrev.project?.song_structure;
            const base = isObject(ss) ? ss : {};
            return {
              ...statePrev,
              project: {
                ...statePrev.project,
                song_structure: {
                  ...base,
                  playlist_link_enabled: prevEnabled,
                },
              },
            };
          });
        });
        appendSystemMessage(
          `Fehler (song-structure:set-playlist-link): ${result?.error || 'Unbekannter Fehler'}`,
        );
      },
    );
  }, [appendSystemMessage, connection]);

  const structurePlaylistTintSegments = useMemo(() => {
    if (!songStructure.playlist_link_enabled || !songStructure.nodes.length) {
      return [];
    }
    const starts = computeStructureStarts(songStructure.nodes);
    return songStructure.nodes.map((node, index) => {
      const len = Number(node?.length);
      const lengthBars = Number.isFinite(len) ? len : 1;
      const rgb = hexToRgbChannels(node?.color);
      return {
        id: String(node?.id ?? index),
        leftPx: starts[index] * barWidth,
        widthPx: Math.max(4, lengthBars * barWidth),
        rgb: rgb || '125, 211, 252',
      };
    });
  }, [barWidth, songStructure.nodes, songStructure.playlist_link_enabled]);

  useEffect(() => {
    if (!selectedStructureNodeId) {
      return;
    }
    const exists = songStructure.nodes.some((n) => n.id === selectedStructureNodeId);
    if (!exists) {
      setSelectedStructureNodeId(null);
    }
  }, [songStructure.nodes, selectedStructureNodeId]);

  const refreshStructureTemplates = useCallback(() => {
    socketRef.current?.emit('structure-template:list', {}, (result) => {
      if (result?.ok) {
        setStructureTemplates(Array.isArray(result.templates) ? result.templates : []);
      }
    });
  }, []);

  const applyStructureNodes = useCallback((nodes, meta = {}) => {
    if (!socketRef.current) {
      appendSystemMessage('Socket nicht bereit — Structure-Änderung nicht möglich.');
      return;
    }
    const plainNodes = Array.isArray(nodes)
      ? nodes.map((node) => ({
        id: String(node?.id ?? ''),
        title: String(node?.title ?? 'Section'),
        note: typeof node?.note === 'string' ? node.note : '',
        color: typeof node?.color === 'string' ? node.color : '#7dd3fc',
        length: Number(node?.length) || 1,
      }))
      : [];
    emitMutation('song-structure:set-nodes', {
      nodes: plainNodes,
      playlist_link_enabled: playlistLinkIntentRef.current,
      ...(Object.prototype.hasOwnProperty.call(meta, 'template_id') ? { template_id: meta.template_id } : {}),
      ...(Object.prototype.hasOwnProperty.call(meta, 'template_name') ? { template_name: meta.template_name } : {}),
    });
  }, [appendSystemMessage, emitMutation]);

  const downloadStructureJsonFile = useCallback((payload, filename) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleStructureResize = useCallback((index, nextLength) => {
    const nextNodes = resizeNodeRight(songStructure.nodes, index, nextLength, snapStep);
    applyStructureNodes(nextNodes);
  }, [applyStructureNodes, snapStep, songStructure.nodes]);

  const handleStructureAddAtBoundary = useCallback((boundaryIndex) => {
    const nextNodes = insertNodeAtBoundary(songStructure.nodes, boundaryIndex, snapStep);
    applyStructureNodes(nextNodes);
  }, [applyStructureNodes, snapStep, songStructure.nodes]);

  const handleStructureLaneSelectNode = useCallback((nodeId) => {
    setSelectedClipKeys([]);
    setSelectedStructureNodeId(nodeId ?? null);
  }, []);

  const handleStructureNodeModalOpen = useCallback((node) => {
    setSelectedClipKeys([]);
    setSelectedStructureNodeId(node?.id ?? null);
    setStructureNodeModal(node);
  }, []);

  const handleStructureReorder = useCallback((fromIndex, insertBeforeIndex) => {
    const nextNodes = reorderStructureNodes(songStructure.nodes, fromIndex, insertBeforeIndex);
    const prevKey = songStructure.nodes.map((n) => n?.id).join('\0');
    const nextKey = nextNodes.map((n) => n?.id).join('\0');
    if (prevKey === nextKey) {
      return;
    }
    applyStructureNodes(nextNodes);
  }, [applyStructureNodes, songStructure.nodes]);

  const handleStructureRemoveNodeById = useCallback((nodeId) => {
    const id = typeof nodeId === 'string' ? nodeId.trim() : '';
    if (!id) {
      return;
    }
    const nextNodes = removeStructureNodeById(songStructure.nodes, id);
    if (nextNodes === songStructure.nodes) {
      return;
    }
    applyStructureNodes(nextNodes);
    setStructureNodeModal(null);
    setSelectedStructureNodeId(null);
  }, [applyStructureNodes, songStructure.nodes]);

  const handleStructureKeyboardDeleteRequest = useCallback(() => {
    if (!selectedStructureNodeId) {
      return;
    }
    handleStructureRemoveNodeById(selectedStructureNodeId);
  }, [handleStructureRemoveNodeById, selectedStructureNodeId]);

  const handleStructureNodeSave = useCallback((patch) => {
    emitMutation('song-structure:update-node', patch, () => {
      setStructureNodeModal(null);
    });
  }, [emitMutation]);

  const handleStructureCreateNew = useCallback(() => {
    applyStructureNodes([createDefaultStructureNode(16)], { template_id: null, template_name: null });
  }, [applyStructureNodes]);

  const handleStructureExportJson = useCallback(() => {
    if (songStructure.template_id) {
      socketRef.current?.emit('structure-template:export', { id: songStructure.template_id }, (result) => {
        if (result?.ok && result.json) {
          downloadStructureJsonFile(JSON.parse(result.json), `${songStructure.template_id}.json`);
        }
      });
      return;
    }
    downloadStructureJsonFile(
      { name: 'Project Structure', nodes: songStructure.nodes },
      'song-structure.json',
    );
  }, [downloadStructureJsonFile, songStructure.nodes, songStructure.template_id]);

  const handleStructureImportJson = useCallback(() => {
    structureImportInputRef.current?.click();
  }, []);

  const handleStructureImportFile = useCallback((event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ''));
        socketRef.current?.emit('structure-template:import', { template: parsed, json: JSON.stringify(parsed) }, (result) => {
          if (result?.ok && result.template) {
            appendSystemMessage(`Structure template imported: ${result.template.name}`);
            refreshStructureTemplates();
          } else {
            appendSystemMessage(`Import failed: ${result?.error || 'Unknown error'}`);
          }
        });
      } catch (error) {
        appendSystemMessage(`Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}`);
      }
    };
    reader.readAsText(file);
  }, [appendSystemMessage, refreshStructureTemplates]);

  const handleStructureSaveAsNew = useCallback(() => {
    const name = window.prompt('Template name', songStructure.template_name || 'My Structure');
    if (!name?.trim()) {
      return;
    }
    socketRef.current?.emit('structure-template:save-as-new', {
      name: name.trim(),
      nodes: songStructure.nodes,
    }, (result) => {
      if (result?.ok && result.template) {
        emitMutation('song-structure:set-template-meta', {
          template_id: result.template.id,
          template_name: result.template.name,
        });
        appendSystemMessage(`Template saved: ${result.template.name}`);
        refreshStructureTemplates();
      }
    });
  }, [appendSystemMessage, emitMutation, refreshStructureTemplates, songStructure.nodes, songStructure.template_name]);

  const handleStructureSaveLoadedTemplate = useCallback(() => {
    if (!songStructure.template_id) {
      appendSystemMessage('No template loaded — use Save as New');
      return;
    }
    socketRef.current?.emit('structure-template:save', {
      id: songStructure.template_id,
      name: songStructure.template_name,
      nodes: songStructure.nodes,
    }, (result) => {
      if (result?.ok) {
        appendSystemMessage(`Template updated: ${result.template?.name || songStructure.template_name}`);
        refreshStructureTemplates();
      } else {
        appendSystemMessage(`Save failed: ${result?.error || 'Unknown error'}`);
      }
    });
  }, [appendSystemMessage, refreshStructureTemplates, songStructure.nodes, songStructure.template_id, songStructure.template_name]);

  const handleStructureTemplateLoad = useCallback((tpl) => {
    if (!tpl?.id) {
      return;
    }
    socketRef.current?.emit('structure-template:load', { id: tpl.id }, (result) => {
      if (result?.ok && result.template) {
        applyStructureNodes(result.template.nodes, {
          template_id: result.template.id,
          template_name: result.template.name,
        });
        appendSystemMessage(`Structure loaded: ${result.template.name}`);
        setStructureTemplateManagerOpen(false);
      }
    });
  }, [appendSystemMessage, applyStructureNodes]);

  const handleStructureTemplateExport = useCallback((tpl) => {
    if (!tpl?.id) {
      return;
    }
    socketRef.current?.emit('structure-template:export', { id: tpl.id }, (result) => {
      if (result?.ok && result.template) {
        downloadStructureJsonFile(result.template, `${tpl.id}.json`);
      }
    });
  }, [downloadStructureJsonFile]);

  const handleStructureTemplateEditMeta = useCallback((tpl) => {
    if (!tpl?.id) {
      return;
    }
    const name = window.prompt('Template name', tpl.name || '');
    if (!name?.trim()) {
      return;
    }
    const note = window.prompt('Template note', tpl.note || '') ?? '';
    socketRef.current?.emit('structure-template:save', {
      id: tpl.id,
      name: name.trim(),
      note: note.trim(),
    }, (result) => {
      if (result?.ok) {
        refreshStructureTemplates();
      }
    });
  }, [refreshStructureTemplates]);

  useEffect(() => {
    if (!structureTemplateManagerOpen) {
      return undefined;
    }
    refreshStructureTemplates();
    return undefined;
  }, [refreshStructureTemplates, structureTemplateManagerOpen]);

  useEffect(() => {
    if (!structureAddMenuOpen) {
      return undefined;
    }
    const onPointerDown = (event) => {
      const withinTrigger = event.target.closest('[data-structure-menu-root="true"]');
      const withinPortalMenu = event.target.closest('[data-structure-add-menu="true"]');
      if (!withinTrigger && !withinPortalMenu) {
        setStructureAddMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [structureAddMenuOpen]);

  const requestClipBpmKeyAnalysis = useCallback(({
    trackId,
    clipId,
    clipType = 'audio',
    clipLabel = '',
    showResultModal = true,
    announceStart = true,
    announceDone = true,
    autoRenameBaseName = '',
  } = {}) => {
    const resolvedTrackId = Number(trackId);
    const resolvedClipId = isNonEmptyString(clipId) ? clipId.trim() : '';
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0 || !resolvedClipId) {
      return;
    }
    if (String(clipType || '').toLowerCase() !== 'audio') {
      appendSystemMessage(`Analyze BPM & Key ist aktuell nur fuer Audio-Clips gedacht (Clip ${resolvedClipId} auf Track ${resolvedTrackId}).`);
      return;
    }

    const descriptor = clipLabel
      ? `"${clipLabel}" (Track ${resolvedTrackId})`
      : `Clip ${resolvedClipId} auf Track ${resolvedTrackId}`;
    const clipKey = getClipSelectionKey(resolvedTrackId, resolvedClipId);

    if (announceStart) {
      appendSystemMessage(`Analyze BPM & Key gestartet fuer ${descriptor}...`);
    }

    emitMutation('clip:analyze-bpm-key', {
      trackId: resolvedTrackId,
      clipId: resolvedClipId,
    }, (result) => {
      const resolvedBpm = Number(result?.bpm);
      const resolvedKey = isNonEmptyString(result?.key) ? result.key.trim() : '';
      const autoName = isNonEmptyString(autoRenameBaseName)
        ? buildAutoAnalyzedClipName(autoRenameBaseName, {
          bpm: Number.isFinite(resolvedBpm) ? resolvedBpm : null,
          key: resolvedKey || null,
        })
        : '';

      setClipDisplayOverrides((previous) => ({
        ...previous,
        [clipKey]: {
          ...(previous?.[clipKey] || {}),
          ...(Number.isFinite(resolvedBpm) ? { bpm: resolvedBpm } : { bpm: undefined }),
          ...(resolvedKey ? { key: resolvedKey } : { key: undefined }),
          ...(isNonEmptyString(result?.analyzed_at) ? { analyzed_at: result.analyzed_at } : {}),
          ...(autoName ? { name: autoName } : {}),
        },
      }));

      if (autoName) {
        emitMutation('clip:set-properties', {
          trackId: resolvedTrackId,
          clipId: resolvedClipId,
          name: autoName,
        });
      }

      if (showResultModal) {
        setClipAnalyzeResultModal({
          trackId: resolvedTrackId,
          clipId: resolvedClipId,
          clipLabel: clipLabel || '',
          bpm: Number.isFinite(resolvedBpm) ? Number(resolvedBpm.toFixed(1)) : null,
          key: resolvedKey || null,
          analyzedAt: isNonEmptyString(result?.analyzed_at) ? result.analyzed_at : null,
          methodBpm: typeof result?.method?.bpm === 'string' ? result.method.bpm : null,
          methodKey: typeof result?.method?.key === 'string' ? result.method.key : null,
        });
      }

      if (announceDone) {
        const bpmText = Number.isFinite(resolvedBpm) ? `${resolvedBpm.toFixed(1)} BPM` : 'BPM ?';
        const keyText = resolvedKey || 'Key ?';
        appendSystemMessage(`Analyse fertig fuer ${descriptor}: ${bpmText}, ${keyText}.${autoName ? ` Name: ${autoName}` : ''}`);
      }
    });
  }, [appendSystemMessage, emitMutation]);

  const resolveImportTrackRenamePrompt = useCallback((payload = { apply: false, trackName: '' }) => {
    const resolver = importTrackRenamePromptResolverRef.current;
    importTrackRenamePromptResolverRef.current = null;
    setImportTrackRenamePrompt(null);
    if (resolver) {
      resolver({
        apply: Boolean(payload?.apply),
        trackName: isNonEmptyString(payload?.trackName) ? payload.trackName.trim() : '',
      });
    }
  }, []);

  const requestImportTrackRenameDecision = useCallback((trackId, supportedImports) => {
    const choices = buildTrackRenameChoicesForImports(supportedImports);
    if (choices.length === 0) {
      return Promise.resolve({ apply: false, trackName: '' });
    }

    return new Promise((resolve) => {
      if (importTrackRenamePromptResolverRef.current) {
        importTrackRenamePromptResolverRef.current({ apply: false, trackName: '' });
      }
      importTrackRenamePromptResolverRef.current = resolve;
      setImportTrackRenamePrompt({
        trackId,
        choices,
        selectedChoiceId: choices[0].id,
      });
    });
  }, []);

  const triggerProjectHistory = useCallback((direction) => {
    const socket = socketRef.current;
    if (!socket || historyMutationPending) {
      return;
    }

    const wantsUndo = direction === 'undo';
    const canUndo = Boolean(state?.history?.canUndo);
    const canRedo = Boolean(state?.history?.canRedo);
    if ((wantsUndo && !canUndo) || (!wantsUndo && !canRedo)) {
      return;
    }

    const eventName = wantsUndo ? 'project:undo' : 'project:redo';
    setHistoryMutationPending(true);
    playlistLinkIntentReadyRef.current = false;
    socket.emit(eventName, {}, (result) => {
      setHistoryMutationPending(false);
      if (!result?.ok) {
        appendSystemMessage(`Fehler (${eventName}): ${result?.error || 'Unbekannter Fehler'}`);
      }
    });
  }, [appendSystemMessage, historyMutationPending, state?.history?.canRedo, state?.history?.canUndo]);

  const triggerProjectUndo = useCallback(() => {
    triggerProjectHistory('undo');
  }, [triggerProjectHistory]);

  const triggerProjectRedo = useCallback(() => {
    triggerProjectHistory('redo');
  }, [triggerProjectHistory]);

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
      if (!target.closest('[data-clip-quick-tool-menu-root="true"]')) {
        setClipQuickToolMenu(null);
      }
      if (!target.closest('[data-clip-rename-color-root="true"]')) {
        setClipRenameColorPrompt(null);
      }
      if (!target.closest('[data-clip-analyze-result-root="true"]')) {
        setClipAnalyzeResultModal(null);
      }
      if (!target.closest('[data-track-plugin-picker-root="true"]')) {
        setOpenTrackPluginPicker(null);
      }
      if (
        !target.closest('.structure-node')
        && !target.closest('.structure-node-modal-overlay')
        && !target.closest('[data-structure-add-menu="true"]')
        && !target.closest('[data-structure-link-toggle="true"]')
      ) {
        setSelectedStructureNodeId(null);
      }
    }

    function handleKeyDown(event) {
      const activeFocusEl =
        document.activeElement instanceof Element ? document.activeElement : null;
      const shortcutBlockedByTyping = activeFocusEl ? isEditableTarget(activeFocusEl) : false;

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
      if (importTrackRenamePrompt) {
        if (event.key === 'Escape') {
          event.preventDefault();
          resolveImportTrackRenamePrompt({ apply: false, trackName: '' });
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const selectedChoice = importTrackRenamePrompt.choices.find((choice) => (
            choice.id === importTrackRenamePrompt.selectedChoiceId
          )) || importTrackRenamePrompt.choices[0];
          resolveImportTrackRenamePrompt({
            apply: true,
            trackName: selectedChoice?.trackName || '',
          });
          return;
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !shortcutBlockedByTyping) {
        const key = event.key.toLowerCase();
        const wantsUndo = key === 'z' && !event.shiftKey;
        const wantsRedo = (key === 'z' && event.shiftKey) || (!event.metaKey && event.ctrlKey && key === 'y');
        if (wantsUndo || wantsRedo) {
          event.preventDefault();
          if (wantsUndo) {
            triggerProjectUndo();
          } else {
            triggerProjectRedo();
          }
          return;
        }
        if (activeTab === 'Edit') {
          const playlist = state?.project?.playlist;
          if (key === 'c') {
            const nextItems = [];
            for (const keyEntry of selectedClipKeys) {
              const resolved = resolveClipSelectionKey(keyEntry);
              if (!resolved) {
                continue;
              }
              const clip = findClipOnPlaylistTrack(playlist, resolved.trackId, resolved.clipId);
              if (!clip || normalizeClipType(clip.type) !== 'audio') {
                continue;
              }
              const sourcePath = clip.source_path ?? clip.sourcePath;
              if (!isNonEmptyString(sourcePath)
                || !isNonEmptyString(clip.source_name)
                || !isNonEmptyString(clip.source_format)) {
                continue;
              }
              let snapshot;
              try {
                snapshot = JSON.parse(JSON.stringify(clip));
              } catch {
                continue;
              }
              nextItems.push({ sourceTrackId: resolved.trackId, clip: snapshot });
            }
            if (nextItems.length > 0) {
              event.preventDefault();
              audioClipClipboardRef.current = { items: nextItems };
              return;
            }
          }
          if (key === 'v') {
            const buf = audioClipClipboardRef.current;
            const bufItems = buf?.items;
            if (Array.isArray(bufItems) && bufItems.length > 0) {
              event.preventDefault();
              const existingArrangementTracks = arrangementTracks.filter((t) => t.exists);
              let pasteTrackId = null;
              for (const tid of selectedTrackIds) {
                const n = Number(tid);
                if (!Number.isInteger(n) || n <= 0) {
                  continue;
                }
                if (existingArrangementTracks.some((t) => t.track_id === n)) {
                  pasteTrackId = n;
                  break;
                }
              }
              if (pasteTrackId === null) {
                const firstSel = selectedClipKeys[0];
                const fromClip = firstSel ? resolveClipSelectionKey(firstSel) : null;
                if (fromClip && existingArrangementTracks.some((t) => t.track_id === fromClip.trackId)) {
                  pasteTrackId = fromClip.trackId;
                }
              }
              if (pasteTrackId === null && bufItems[0]) {
                const fallback = Number(bufItems[0].sourceTrackId);
                if (Number.isInteger(fallback) && fallback > 0
                  && existingArrangementTracks.some((t) => t.track_id === fallback)) {
                  pasteTrackId = fallback;
                }
              }
              if (pasteTrackId === null && existingArrangementTracks[0]) {
                pasteTrackId = existingArrangementTracks[0].track_id;
              }
              if (pasteTrackId === null) {
                appendSystemMessage('Audio einfuegen: kein gueltiger Ziel-Track.');
                return;
              }
              const clampedTrackId = clampClipMoveTargetTrackId(pasteTrackId, arrangementTracks);
              let cursorStart = snapToGrid(Math.max(0, getCurrentTransportBars()), snapStep);
              for (const entry of bufItems) {
                const clip = entry?.clip;
                if (!isObject(clip)) {
                  continue;
                }
                const lenRaw = Number(clip.length);
                const lengthBars = Number.isFinite(lenRaw) && lenRaw > 0
                  ? snapToGrid(lenRaw, snapStep)
                  : Math.max(GRID_STEP, snapStep);
                const trimStart = getEffectiveAudioTrimStartForWaveform(clip);
                createImportedClipFromSource(
                  clampedTrackId,
                  clip,
                  cursorStart,
                  lengthBars,
                  undefined,
                  { trim_start_seconds: trimStart, grid_step: snapStep },
                );
                cursorStart = snapToGrid(cursorStart + lengthBars, snapStep);
              }
              return;
            }
          }
        }
      }
      if (event.key === 'Escape') {
        setOpenTrackMenuId(null);
        setTrackContextMenu(null);
        setClipQuickToolMenu(null);
        setClipRenameColorPrompt(null);
        setClipAnalyzeResultModal(null);
        setOpenTrackPluginPicker(null);
        setTrackChainModalTrackId(null);
        setStructureNodeModal(null);
        setToolDragOverlay(null);
        toolDragRef.current = null;
        clearToolPointerSession();
        return;
      }
      if (activeTab === 'Edit' && !shortcutBlockedByTyping) {
        const key = event.key.toLowerCase();
        if (key === 'x') {
          activateToolFromShortcut('slice');
          return;
        }
        if (key === 'v' && !event.metaKey && !event.ctrlKey) {
          activateToolFromShortcut('select');
          return;
        }
        if (key === 'z') {
          activateToolFromShortcut('zoom');
          return;
        }
        const wantsDelete =
          key === 'delete'
          || key === 'backspace'
          || event.code === 'Delete'
          || event.code === 'Backspace';
        if (wantsDelete && !event.defaultPrevented) {
          if (selectedClipKeys.length > 0) {
            event.preventDefault();
            for (const keyEntry of selectedClipKeys) {
              const resolved = resolveClipSelectionKey(keyEntry);
              if (!resolved) {
                continue;
              }
              emitMutation('clip:delete', { trackId: resolved.trackId, clipId: String(resolved.clipId) });
            }
            setSelectedClipKeys([]);
            return;
          }
          if (selectedStructureNodeId) {
            event.preventDefault();
            handleStructureRemoveNodeById(selectedStructureNodeId);
            return;
          }
        }
      }
      if ((event.key === ' ' || event.code === 'Space') && !shortcutBlockedByTyping) {
        event.preventDefault();
        if (connection !== 'online' || state?.nativeTransport !== true) {
          return;
        }
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
  }, [
    activeTab,
    state?.playing,
    state?.project?.playlist,
    selectedClipKeys,
    selectedTrackIds,
    arrangementTracks,
    snapStep,
    getCurrentTransportBars,
    selectedStructureNodeId,
    handleStructureRemoveNodeById,
    emitMutation,
    triggerProjectRedo,
    triggerProjectUndo,
    importTrackRenamePrompt,
    resolveImportTrackRenamePrompt,
    appendSystemMessage,
  ]);

  useEffect(() => {
    if (!clipRenameColorPrompt) {
      return;
    }
    const timer = window.setTimeout(() => {
      clipRenameColorNameInputRef.current?.focus();
      clipRenameColorNameInputRef.current?.select();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [clipRenameColorPrompt?.trackId, clipRenameColorPrompt?.clipId]);

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

  const applyPlayheadToScrollEl = useCallback(
    (scrollEl) => {
      const bars = getCurrentTransportBars();
      const leftPx = clamp(
        bars * barWidthRef.current,
        0,
        timelineBarsRef.current * barWidthRef.current,
      );
      const gen = playheadSyncGenerationRef.current;
      if (gen !== playheadAppliedScrollGenRef.current) {
        playheadAppliedScrollGenRef.current = gen;
        playheadLeftPxRef.current = leftPx;
        scrollEl.style.setProperty('--playhead-left-px', `${leftPx}px`);
      } else if (Math.abs(leftPx - playheadLeftPxRef.current) >= 0.05) {
        playheadLeftPxRef.current = leftPx;
        scrollEl.style.setProperty('--playhead-left-px', `${leftPx}px`);
      }
      if (
        Boolean(transportSnapshotRef.current.playing)
        && bars >= viewBarsRef.current - PLAYHEAD_EXTEND_MARGIN_BARS
      ) {
        ensureViewBars(bars + PLAYHEAD_EXTEND_MARGIN_BARS + VIEW_EXTEND_STEP_BARS);
      }
    },
    [ensureViewBars, getCurrentTransportBars],
  );

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

  const applyMixOverviewPlayhead = useCallback(() => {
    const overviewEl = mixOverviewRef.current;
    if (!overviewEl) {
      return;
    }
    const safeEnd = Math.max(0.001, Number(maxClipEnd) || 0);
    const bars = getCurrentTransportBars();
    const pct = clamp(bars / safeEnd, 0, 1) * 100;
    overviewEl.style.setProperty('--mix-overview-playhead-pct', `${pct}%`);
  }, [getCurrentTransportBars, maxClipEnd]);

  const seekMixOverviewBars = useCallback((rawBars, { shiftKey = false } = {}) => {
    if (!Number.isFinite(rawBars)) {
      return;
    }
    const safeEnd = Math.max(0.001, Number(maxClipEnd) || 0);
    const snapped = shiftKey ? snapToGrid(rawBars, snapStep) : rawBars;
    const nextBars = Number(clamp(snapped, 0, safeEnd).toFixed(6));
    playheadDragBarsRef.current = nextBars;
    setPlayheadDragBars(nextBars);
    scheduleTransportSeek(nextBars);
    const overviewEl = mixOverviewRef.current;
    if (overviewEl) {
      const pct = clamp(nextBars / safeEnd, 0, 1) * 100;
      overviewEl.style.setProperty('--mix-overview-playhead-pct', `${pct}%`);
    }
  }, [maxClipEnd, snapStep, scheduleTransportSeek]);

  const clearMixOverviewPlayheadDrag = useCallback(() => {
    setPlayheadDragBars(null);
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
      const range = getVisibleBarRange(
        scrollElement.scrollLeft,
        scrollElement.clientWidth,
        barWidthRef.current,
      );
      setArrangementVisibleBars(range);

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

    const positionBars = Number(transportSnapshotRef.current?.positionBars);
    if (!Number.isFinite(positionBars)) {
      return;
    }
    if (positionBars < viewBarsRef.current - PLAYHEAD_EXTEND_MARGIN_BARS) {
      return;
    }

    ensureViewBars(positionBars + PLAYHEAD_EXTEND_MARGIN_BARS + VIEW_EXTEND_STEP_BARS);
  }, [activeTab, state?.playing, transport?.positionBars, ensureViewBars]);

  /** Entering Edit (incl. first paint): bump generation before layout sync so --playhead-left-px is never skipped vs stale gen/ref. */
  useLayoutEffect(() => {
    const prev = prevTabForPlayheadRef.current;
    if (activeTab === 'Edit' && prev !== 'Edit') {
      playheadSyncGenerationRef.current += 1;
      playheadLeftPxRef.current = -1;
    }
    prevTabForPlayheadRef.current = activeTab;

    if (activeTab === 'Edit') {
      const scrollEl = arrangementScrollRef.current;
      if (scrollEl) {
        applyPlayheadToScrollEl(scrollEl);
      }
    }
    if (activeTab === 'Edit' || activeTab === 'Mix') {
      applyMixOverviewPlayhead();
    }
  }, [activeTab, applyPlayheadToScrollEl, applyMixOverviewPlayhead]);

  useEffect(() => {
    if (activeTab !== 'Edit' && activeTab !== 'Mix') {
      return;
    }

    let scrollRefRetries = 0;
    const MAX_SCROLL_REF_RETRIES = 24;

    const renderPlayhead = () => {
      if (activeTab === 'Edit') {
        const scrollElement = arrangementScrollRef.current;
        if (!scrollElement) {
          if (scrollRefRetries < MAX_SCROLL_REF_RETRIES) {
            scrollRefRetries += 1;
            playheadAnimationFrameRef.current = window.requestAnimationFrame(renderPlayhead);
          }
          return;
        }
        scrollRefRetries = 0;
        applyPlayheadToScrollEl(scrollElement);
      }
      if (activeTab === 'Edit' || activeTab === 'Mix') {
        applyMixOverviewPlayhead();
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
  }, [activeTab, state?.playing, applyPlayheadToScrollEl, applyMixOverviewPlayhead]);

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
    const clipKey = isNonEmptyString(clip?.id) ? getClipSelectionKey(trackId, clip.id) : null;
    const displayOverride = clipKey ? clipDisplayOverrides[clipKey] : null;
    const baseClip = displayOverride ? { ...clip, ...displayOverride } : clip;
    const draft = clipDrafts[clip.id];
    if (!draft || draft.trackId !== trackId) {
      return baseClip;
    }
    return {
      ...baseClip,
      start: draft.start,
      length: draft.length,
    };
  }, [clipDrafts, clipDisplayOverrides]);

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

  function createImportedClipFromSource(trackId, sourceClip, start, length, onCreated, trimExtra = {}) {
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
    const trimFromSplit = Number(trimExtra.trim_start_seconds ?? trimExtra.trimStartSeconds);
    const gridStepExtra = trimExtra.grid_step ?? trimExtra.gridStep;
    const importPayload = {
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
      ...(Number.isFinite(trimFromSplit) && trimFromSplit >= 0 ? { trim_start_seconds: trimFromSplit } : {}),
      ...(Number.isFinite(Number(gridStepExtra)) && Number(gridStepExtra) > 0 ? { grid_step: Number(gridStepExtra) } : {}),
    };
    console.log('[IMPORT_RIGHT_CLIENT_PAYLOAD]', importPayload);
    emitMutation('clip:import-file', importPayload, onCreated);
  }

  function splitClipAtBar(trackId, clip, splitBarsRaw, step = snapStep) {
    const clipStart = Number(clip?.start) || 0;
    const clipLength = Number(clip?.length) || 0;
    const clipEnd = clipStart + clipLength;
    const splitBars = snapToGrid(splitBarsRaw, step);
    console.log('[SPLIT_START] input', {
      trackId,
      clipId: clip?.id,
      clipStart,
      clipLength,
      clipEnd,
      splitBarsRaw,
      splitBars,
      step,
      trim_start_seconds: clip?.trim_start_seconds,
    });
    if (splitBars <= clipStart + step || splitBars >= clipEnd - step) {
      console.log('[SPLIT_START] aborted edge guard', { splitBars, clipStart, clipEnd, step });
      return;
    }

    splitDebugSessionRef.current = {
      until: Date.now() + 12000,
      trackId: Number(trackId),
      clipIds: new Set([String(clip?.id)]),
    };

    const leftLength = Math.max(step, snapToGrid(splitBars - clipStart, step));
    const sourcePatternId = getPatternId(clip);
    const sourceKey = getClipSelectionKey(trackId, clip.id);
    const sourceMuted = clipMuteOverrides[sourceKey] === true;
    const sourceSlipBars = Number(clipSlipPreviewBars[sourceKey]) || 0;
    const splitBpm = Number(state?.project?.bpm) || 128;
    const splitTs = timeSignature;
    const baseTrim = getEffectiveAudioTrimStartForWaveform(clip);

    console.log('[SPLIT_CALC] pre-resize math', {
      clipStart,
      clipLength,
      clipEnd,
      splitBars,
      leftLength,
      expectedRightStartBeforeServer: clipStart + leftLength,
      expectedRightLengthBeforeServer: clipEnd - (clipStart + leftLength),
      baseTrim,
      splitBpm,
      timeSignature: splitTs,
      rightTrimPreview: baseTrim + barsToSeconds(leftLength, splitBpm, splitTs),
    });

    emitMutation('clip:resize', { trackId, clipId: clip.id, length: leftLength, grid_step: step }, (result) => {
      console.log('[SPLIT_RESIZE_RESULT] resize callback result', result);
      const leftStored = Number.isFinite(Number(result?.length)) ? Number(result.length) : leftLength;
      const rightStart = snapToGrid(clipStart + leftStored, step);
      const rightLengthAdjusted = Math.max(step, snapToGrid(clipEnd - rightStart, step));
      const rightClipTrim = baseTrim + barsToSeconds(leftStored, splitBpm, splitTs);
      console.log('[SPLIT_CALC] post-resize math', {
        resultLengthRaw: result?.length,
        leftStored,
        clipStart,
        clipEnd,
        rightStart,
        rightLengthAdjusted,
        rightClipTrim,
        step,
      });

      const onCreated = (createResult) => {
        const newClipId = isNonEmptyString(createResult?.clipId) ? createResult.clipId : null;
        if (newClipId && splitDebugSessionRef.current.clipIds) {
          splitDebugSessionRef.current.clipIds.add(String(newClipId));
        }
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
          start: rightStart,
          length: rightLengthAdjusted,
          grid_step: step,
        }, onCreated);
      } else {
        console.log('[SPLIT_CREATE_RIGHT_CLIENT] about to create right audio clip', {
          trackId,
          sourceClipId: clip?.id,
          sourceClipStart: clip?.start,
          sourceClipLength: clip?.length,
          rightStart,
          rightLengthAdjusted,
          rightClipTrim,
          step,
        });
        createImportedClipFromSource(trackId, clip, rightStart, rightLengthAdjusted, onCreated, {
          trim_start_seconds: rightClipTrim,
          grid_step: step,
        });
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
            emitMutation('clip:delete', { trackId: entry.trackId, clipId: String(entry.clipId) });
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

  function setMetronomeEnabled(enabled) {
    const nextEnabled = Boolean(enabled);
    if (nextEnabled) {
      primeMetronomeAudio();
    } else {
      metronomeLastStepRef.current = null;
      metronomeClockRef.current = {
        anchorMs: 0,
        anchorBeats: 0,
        bpm: FALLBACK_STATE.project.bpm,
      };
      metronomeDebugRef.current = {
        tickCount: 0,
        lastTickMs: 0,
        lastLogMs: 0,
      };
      if (metronomeNeedleRef.current) {
        metronomeNeedleRef.current.setAttribute('transform', 'rotate(0 32 45)');
      }
    }
    setState((previousState) => {
      const baseState = isObject(previousState) ? previousState : FALLBACK_STATE;
      const baseProject = isObject(baseState.project) ? baseState.project : FALLBACK_STATE.project;
      return {
        ...baseState,
        project: {
          ...baseProject,
          metronome_enabled: nextEnabled,
        },
      };
    });
    emitMutation('project:update-view', { metronomeEnabled: nextEnabled });
  }

  function toggleMetronome() {
    setMetronomeEnabled(!metronomeEnabled);
  }

  function transportPlay() {
    if (!dawEngineReady) {
      appendSystemMessage('Play nicht moeglich: Native-Engine ist nicht verbunden. Starte mit npm run start im Projektroot.');
      return;
    }
    clearPreviewStopTimer();
    const typedRaw = Number(String(bpmInputValue || '').trim().replace(',', '.'));
    const desiredBpm = Number.isFinite(typedRaw)
      ? Math.round(clamp(typedRaw, 20, 300))
      : projectBpmForInput;

    setBpmInputValue(String(desiredBpm));
    setState((previousState) => {
      const baseState = isObject(previousState) ? previousState : FALLBACK_STATE;
      const baseProject = isObject(baseState.project) ? baseState.project : FALLBACK_STATE.project;
      return {
        ...baseState,
        project: {
          ...baseProject,
          bpm: desiredBpm,
        },
      };
    });
    transportSnapshotRef.current = {
      ...transportSnapshotRef.current,
      bpm: desiredBpm,
    };

    console.log(
      `[thestuu-ui] transportPlay desiredBpm=${desiredBpm} projectBpm=${projectBpmForInput} `
      + `input="${String(bpmInputValue || '').trim()}"`,
    );

    const anyRecordArmed = (state?.project?.mixer ?? []).some((e) => e.record_armed);
    const shouldAutoMetronome = Boolean(state?.project?.record_auto_metronome) && anyRecordArmed;
    if (shouldAutoMetronome && !metronomeEnabled) {
      setState((prev) => ({
        ...prev,
        project: { ...prev?.project, metronome_enabled: true },
      }));
      emitMutation('project:update-view', { metronomeEnabled: true });
    }

    const beginPlay = () => {
      if (metronomeEnabled || shouldAutoMetronome) {
        primeMetronomeAudio();
      }
      emitMutation('transport:play', { bpm: desiredBpm });
    };

    const countInBeats = recordCountInEnabledPreference
      ? Math.max(1, Math.min(10, Number(state?.project?.record_count_in_beats) || 4))
      : 0;
    if (anyRecordArmed && countInBeats > 0) {
      if (countInTimeoutRef.current) clearTimeout(countInTimeoutRef.current);
      if (countInIntervalRef.current) clearInterval(countInIntervalRef.current);
      if (metronomeEnabled || shouldAutoMetronome) primeMetronomeAudio();
      const beatIntervalMs = (60 / Math.max(20, Math.min(300, desiredBpm))) * 1000;
      const timeSig = { numerator: Number(state?.project?.time_signature_numerator) || 4, denominator: Number(state?.project?.time_signature_denominator) || 4 };
      triggerMetronomeTick(getMetronomeAccent(0, timeSig));
      let count = 1;
      countInIntervalRef.current = setInterval(() => {
        if (count < countInBeats) triggerMetronomeTick(getMetronomeAccent(count, timeSig));
        count += 1;
        if (count >= countInBeats) {
          if (countInIntervalRef.current) clearInterval(countInIntervalRef.current);
          countInIntervalRef.current = null;
        }
      }, beatIntervalMs);
      countInTimeoutRef.current = setTimeout(() => {
        countInTimeoutRef.current = null;
        if (countInIntervalRef.current) {
          clearInterval(countInIntervalRef.current);
          countInIntervalRef.current = null;
        }
        beginPlay();
      }, countInBeats * beatIntervalMs);
      return;
    }

    const socket = socketRef.current;
    if (desiredBpm !== projectBpmForInput && socket) {
      socket.emit('transport:set-bpm', { bpm: desiredBpm }, (result) => {
        if (!result?.ok) {
          appendSystemMessage(`Fehler (transport:set-bpm): ${result?.error || 'Unbekannter Fehler'}`);
        }
        beginPlay();
      });
      return;
    }

    if (desiredBpm !== projectBpmForInput && !socket) {
      appendSystemMessage('Fehler (transport:set-bpm): Keine Engine-Verbindung.');
    }

    beginPlay();
  }

  function transportPause() {
    if (!dawEngineReady) {
      appendSystemMessage('Pause nicht moeglich: Native-Engine ist nicht verbunden.');
      return;
    }
    clearPreviewStopTimer();
    if (countInTimeoutRef.current) { clearTimeout(countInTimeoutRef.current); countInTimeoutRef.current = null; }
    if (countInIntervalRef.current) { clearInterval(countInIntervalRef.current); countInIntervalRef.current = null; }
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
    if (!dawEngineReady) {
      appendSystemMessage('Stop nicht moeglich: Native-Engine ist nicht verbunden.');
      return;
    }
    clearPreviewStopTimer();
    if (countInTimeoutRef.current) { clearTimeout(countInTimeoutRef.current); countInTimeoutRef.current = null; }
    if (countInIntervalRef.current) { clearInterval(countInIntervalRef.current); countInIntervalRef.current = null; }
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

  function applyLocalMasterMix(patch) {
    if (!isObject(patch)) {
      return;
    }
    setState((previousState) => {
      const baseState = isObject(previousState) ? previousState : FALLBACK_STATE;
      const baseProject = isObject(baseState.project) ? baseState.project : FALLBACK_STATE.project;
      const current = normalizeMasterMix(baseProject.master_mix);
      return {
        ...baseState,
        project: {
          ...baseProject,
          master_mix: { ...current, ...patch },
        },
      };
    });
  }

  function detachMixLevelDragWindowListeners() {
    if (typeof mixLevelDragDetachRef.current === 'function') {
      mixLevelDragDetachRef.current();
      mixLevelDragDetachRef.current = null;
    }
  }

  function finalizeMixLevelDragFromSession() {
    detachMixLevelDragWindowListeners();
    const session = mixLevelDragSessionRef.current;
    mixLevelDragSessionRef.current = null;
    if (!session) {
      return;
    }
    if (session.kind === 'volume') {
      if (session.trackId === 0) {
        emitMutation('track:set-volume', { trackId: 0, volume: session.lastValue });
      } else {
        ensureTrackExists(session.trackId, () => {
          emitMutation('track:set-volume', { trackId: session.trackId, volume: session.lastValue });
        });
      }
    } else if (session.kind === 'pan') {
      if (session.trackId === 0) {
        emitMutation('track:set-pan', { trackId: 0, pan: session.lastValue });
      } else {
        ensureTrackExists(session.trackId, () => {
          emitMutation('track:set-pan', { trackId: session.trackId, pan: session.lastValue });
        });
      }
    }
  }

  function beginMixLevelPointerDrag(kind, trackId, initialValue) {
    if ((kind !== 'volume' && kind !== 'pan') || !Number.isInteger(trackId) || trackId < 0) {
      return;
    }
    const existing = mixLevelDragSessionRef.current;
    if (existing && existing.kind === kind && existing.trackId === trackId) {
      existing.lastValue = initialValue;
      return;
    }
    if (existing) {
      finalizeMixLevelDragFromSession();
    } else {
      detachMixLevelDragWindowListeners();
    }
    mixLevelDragSessionRef.current = { kind, trackId, lastValue: initialValue };
    const onPointerEnd = () => {
      finalizeMixLevelDragFromSession();
    };
    window.addEventListener('pointerup', onPointerEnd, true);
    window.addEventListener('pointercancel', onPointerEnd, true);
    mixLevelDragDetachRef.current = () => {
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('pointercancel', onPointerEnd, true);
    };
  }

  function handleMixVolumeSliderInput(trackId, rawValue) {
    const resolvedVolume = normalizeVolumeValue(rawValue);
    applyLocalTrackMix(trackId, { volume: resolvedVolume });
    const session = mixLevelDragSessionRef.current;
    if (session && session.kind === 'volume' && session.trackId === trackId) {
      session.lastValue = resolvedVolume;
      return;
    }
    ensureTrackExists(trackId, () => {
      emitMutation('track:set-volume', { trackId, volume: resolvedVolume });
    });
  }

  function handleMixMasterVolumeSliderInput(rawValue) {
    const resolvedVolume = normalizeVolumeValue(rawValue);
    applyLocalMasterMix({ volume: resolvedVolume });
    const session = mixLevelDragSessionRef.current;
    if (session && session.kind === 'volume' && session.trackId === 0) {
      session.lastValue = resolvedVolume;
      return;
    }
    emitMutation('track:set-volume', { trackId: 0, volume: resolvedVolume });
  }

  function handleMixPanSliderInput(trackId, rawValue) {
    const resolvedPan = normalizePanValue(rawValue);
    applyLocalTrackMix(trackId, { pan: resolvedPan });
    const session = mixLevelDragSessionRef.current;
    if (session && session.kind === 'pan' && session.trackId === trackId) {
      session.lastValue = resolvedPan;
      return;
    }
    ensureTrackExists(trackId, () => {
      emitMutation('track:set-pan', { trackId, pan: resolvedPan });
    });
  }

  function handleMixMasterPanSliderInput(rawValue) {
    const resolvedPan = normalizePanValue(rawValue);
    applyLocalMasterMix({ pan: resolvedPan });
    const session = mixLevelDragSessionRef.current;
    if (session && session.kind === 'pan' && session.trackId === 0) {
      session.lastValue = resolvedPan;
      return;
    }
    emitMutation('track:set-pan', { trackId: 0, pan: resolvedPan });
  }

  function setMasterVolume(volume) {
    if (connection !== 'online' || state?.nativeTransport !== true) {
      return;
    }
    finalizeMixLevelDragFromSession();
    const resolvedVolume = normalizeVolumeValue(volume);
    applyLocalMasterMix({ volume: resolvedVolume });
    emitMutation('track:set-volume', { trackId: 0, volume: resolvedVolume });
  }

  function setMasterPan(pan) {
    if (connection !== 'online' || state?.nativeTransport !== true) {
      return;
    }
    finalizeMixLevelDragFromSession();
    const resolvedPan = normalizePanValue(pan);
    applyLocalMasterMix({ pan: resolvedPan });
    emitMutation('track:set-pan', { trackId: 0, pan: resolvedPan });
  }

  function setMasterMute(mute) {
    applyLocalMasterMix({ mute: Boolean(mute) });
    emitMutation('track:set-mute', { trackId: 0, mute: Boolean(mute) });
  }

  function setMasterVolumeDb(dbValue) {
    finalizeMixLevelDragFromSession();
    const resolvedVolume = fromVolumeDbInput(dbValue);
    if (resolvedVolume === null) {
      return;
    }
    setMasterVolume(resolvedVolume);
  }

  function setMasterPanPercent(percentValue, referencePan = 0) {
    finalizeMixLevelDragFromSession();
    const parsedPercent = Number(percentValue);
    if (!Number.isFinite(parsedPercent)) {
      return;
    }
    const magnitude = clamp(Math.abs(parsedPercent), 0, 100);
    if (magnitude === 0) {
      setMasterPan(0);
      return;
    }
    const reference = Number(referencePan);
    const sign = Number.isFinite(reference) && reference < 0 ? -1 : 1;
    setMasterPan((magnitude / 100) * sign);
  }

  function setVolume(trackId, volume) {
    if (connection !== 'online' || state?.nativeTransport !== true) {
      return;
    }
    finalizeMixLevelDragFromSession();
    const resolvedVolume = normalizeVolumeValue(volume);
    applyLocalTrackMix(trackId, { volume: resolvedVolume });
    ensureTrackExists(trackId, () => {
      emitMutation('track:set-volume', { trackId, volume: resolvedVolume });
    });
  }

  function setPan(trackId, pan) {
    if (connection !== 'online' || state?.nativeTransport !== true) {
      return;
    }
    finalizeMixLevelDragFromSession();
    const resolvedPan = normalizePanValue(pan);
    applyLocalTrackMix(trackId, { pan: resolvedPan });
    ensureTrackExists(trackId, () => {
      emitMutation('track:set-pan', { trackId, pan: resolvedPan });
    });
  }

  function setVolumeDb(trackId, dbValue) {
    finalizeMixLevelDragFromSession();
    const resolvedVolume = fromVolumeDbInput(dbValue);
    if (resolvedVolume === null) {
      return;
    }
    setVolume(trackId, resolvedVolume);
  }

  function setPanPercent(trackId, percentValue, referencePan = 0) {
    finalizeMixLevelDragFromSession();
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

  function updateAppPreferences(patch) {
    if (!isObject(patch)) {
      return;
    }
    const nextPatch = {};
    if (Object.prototype.hasOwnProperty.call(patch, 'record_count_in_enabled')) {
      nextPatch.record_count_in_enabled = Boolean(patch.record_count_in_enabled);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'record_use_standard_mic')) {
      nextPatch.record_use_standard_mic = Boolean(patch.record_use_standard_mic);
    }
    if (Object.keys(nextPatch).length === 0) {
      return;
    }

    setState((prev) => {
      const baseState = isObject(prev) ? prev : FALLBACK_STATE;
      const basePrefs = isObject(baseState.appPreferences) ? baseState.appPreferences : FALLBACK_STATE.appPreferences;
      return {
        ...baseState,
        appPreferences: {
          ...basePrefs,
          ...nextPatch,
        },
      };
    });

    const socket = socketRef.current;
    if (!socket) {
      appendSystemMessage('App-Preferences konnten nicht gespeichert werden: Keine Engine-Verbindung.');
      return;
    }

    socket.emit('app-preferences:update', nextPatch, (res) => {
      if (!res?.ok) {
        appendSystemMessage(`Fehler (app-preferences:update): ${res?.error || 'Unbekannter Fehler'}`);
        return;
      }
      if (isObject(res.app_preferences)) {
        setState((prev) => {
          const baseState = isObject(prev) ? prev : FALLBACK_STATE;
          return {
            ...baseState,
            appPreferences: {
              ...(isObject(baseState.appPreferences) ? baseState.appPreferences : FALLBACK_STATE.appPreferences),
              ...res.app_preferences,
            },
          };
        });
      }
    });
  }

  function clearFloatingWindowInteraction() {
    const handlers = floatingWindowInteractionRef.current;
    if (!handlers || typeof window === 'undefined') {
      return;
    }
    window.removeEventListener('pointermove', handlers.handleMove);
    window.removeEventListener('pointerup', handlers.handleEnd);
    window.removeEventListener('pointercancel', handlers.handleEnd);
    floatingWindowInteractionRef.current = null;
  }

  function getFloatingWindowLayout(windowId) {
    const raw = isObject(floatingWindowLayouts) ? floatingWindowLayouts[windowId] : null;
    return normalizeFloatingWindowLayoutEntry(windowId, raw, getFloatingWindowViewportBounds());
  }

  function consumeFloatingWindowZIndex() {
    let nextZ = 100;
    setFloatingWindowZCounter((prev) => {
      nextZ = Math.max(1, Number(prev) || 1);
      return nextZ + 10;
    });
    return nextZ;
  }

  function patchFloatingWindowLayout(windowId, patchOrUpdater) {
    setFloatingWindowLayouts((prevLayouts) => {
      const normalizedLayouts = normalizeFloatingWindowLayouts(prevLayouts, getFloatingWindowViewportBounds());
      const current = normalizeFloatingWindowLayoutEntry(windowId, normalizedLayouts[windowId], getFloatingWindowViewportBounds());
      const patch = typeof patchOrUpdater === 'function'
        ? patchOrUpdater(current, normalizedLayouts)
        : patchOrUpdater;
      if (!isObject(patch)) {
        return normalizedLayouts;
      }
      const nextEntry = normalizeFloatingWindowLayoutEntry(windowId, { ...current, ...patch }, getFloatingWindowViewportBounds());
      return {
        ...normalizedLayouts,
        [windowId]: nextEntry,
      };
    });
  }

  function activateFloatingWindow(windowId, options = {}) {
    const nextZ = consumeFloatingWindowZIndex();
    const unminimize = Boolean(options?.unminimize);
    patchFloatingWindowLayout(windowId, (current) => ({
      zIndex: nextZ,
      minimized: unminimize ? false : current.minimized,
    }));
  }
  activateFloatingWindowRef.current = activateFloatingWindow;

  function minimizeFloatingWindow(windowId) {
    patchFloatingWindowLayout(windowId, (current) => ({
      minimized: true,
      maximized: false,
      restoreBounds: current.maximized
        ? (current.restoreBounds || { x: current.x, y: current.y, width: current.width, height: current.height })
        : current.restoreBounds,
    }));
  }

  function restoreFloatingWindow(windowId) {
    activateFloatingWindow(windowId, { unminimize: true });
  }

  function toggleFloatingWindowMaximize(windowId) {
    patchFloatingWindowLayout(windowId, (current) => {
      if (current.maximized) {
        const restore = isObject(current.restoreBounds) ? current.restoreBounds : null;
        if (!restore) {
          return { maximized: false };
        }
        return {
          maximized: false,
          minimized: false,
          x: restore.x,
          y: restore.y,
          width: restore.width,
          height: restore.height,
        };
      }
      return {
        minimized: false,
        maximized: true,
        restoreBounds: {
          x: current.x,
          y: current.y,
          width: current.width,
          height: current.height,
        },
      };
    });
    activateFloatingWindow(windowId);
  }

  function beginFloatingWindowDrag(windowId, event) {
    if (event.button != null && event.button !== 0) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('button, input, select, textarea, a, [role="button"], .floating-window-resize-handle')) {
      return;
    }
    const current = getFloatingWindowLayout(windowId);
    if (current.maximized) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    activateFloatingWindow(windowId);

    const startLayout = current;
    const originClientX = event.clientX;
    const originClientY = event.clientY;

    clearFloatingWindowInteraction();

    const handleMove = (moveEvent) => {
      const dx = moveEvent.clientX - originClientX;
      const dy = moveEvent.clientY - originClientY;
      patchFloatingWindowLayout(windowId, {
        x: Math.round(startLayout.x + dx),
        y: Math.round(startLayout.y + dy),
      });
    };

    const handleEnd = () => {
      clearFloatingWindowInteraction();
    };

    floatingWindowInteractionRef.current = { handleMove, handleEnd };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('pointercancel', handleEnd);
  }

  function beginFloatingWindowResize(windowId, edge, event) {
    if (event.button != null && event.button !== 0) {
      return;
    }
    const current = getFloatingWindowLayout(windowId);
    if (current.maximized) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    activateFloatingWindow(windowId);

    const startLayout = current;
    const originClientX = event.clientX;
    const originClientY = event.clientY;
    const edgeToken = typeof edge === 'string' ? edge.toLowerCase() : '';
    clearFloatingWindowInteraction();

    const handleMove = (moveEvent) => {
      const dx = moveEvent.clientX - originClientX;
      const dy = moveEvent.clientY - originClientY;
      let nextX = startLayout.x;
      let nextY = startLayout.y;
      let nextWidth = startLayout.width;
      let nextHeight = startLayout.height;

      if (edgeToken.includes('e')) {
        nextWidth = startLayout.width + dx;
      }
      if (edgeToken.includes('s')) {
        nextHeight = startLayout.height + dy;
      }
      if (edgeToken.includes('w')) {
        nextX = startLayout.x + dx;
        nextWidth = startLayout.width - dx;
      }
      if (edgeToken.includes('n')) {
        nextY = startLayout.y + dy;
        nextHeight = startLayout.height - dy;
      }

      patchFloatingWindowLayout(windowId, {
        x: Math.round(nextX),
        y: Math.round(nextY),
        width: Math.round(nextWidth),
        height: Math.round(nextHeight),
      });
    };

    const handleEnd = () => {
      clearFloatingWindowInteraction();
    };

    floatingWindowInteractionRef.current = { handleMove, handleEnd };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('pointercancel', handleEnd);
  }

  function getFloatingWindowShellStyle(windowId) {
    const entry = getFloatingWindowLayout(windowId);
    const viewport = getFloatingWindowViewportBounds();
    const dockReserve = FLOATING_WINDOW_DOCK_HEIGHT + FLOATING_WINDOW_DOCK_GAP;
    if (entry.maximized) {
      return {
        position: 'fixed',
        left: FLOATING_WINDOW_MARGIN,
        top: FLOATING_WINDOW_MARGIN,
        width: Math.max(entry.minWidth, viewport.width - (FLOATING_WINDOW_MARGIN * 2)),
        height: Math.max(entry.minHeight, viewport.height - (FLOATING_WINDOW_MARGIN * 2) - dockReserve),
        maxHeight: 'none',
        zIndex: 300 + entry.zIndex,
      };
    }
    return {
      position: 'fixed',
      left: entry.x,
      top: entry.y,
      width: entry.width,
      height: entry.height,
      maxHeight: 'none',
      zIndex: 300 + entry.zIndex,
    };
  }

  function getFloatingWindowLayerStyle(windowId) {
    const entry = getFloatingWindowLayout(windowId);
    return {
      pointerEvents: 'none',
      background: 'transparent',
      padding: 0,
      zIndex: 280 + entry.zIndex,
    };
  }

  function isFloatingWindowMinimized(windowId) {
    return Boolean(getFloatingWindowLayout(windowId).minimized);
  }

  function beginModalDrag(kind, event) {
    beginFloatingWindowDrag(kind, event);
  }

  function getDraggableModalStyle(kindOrOffset) {
    if (typeof kindOrOffset === 'string') {
      return getFloatingWindowShellStyle(kindOrOffset);
    }
    return getFloatingWindowShellStyle('settings');
  }

  function renderFloatingWindowResizeHandles(windowId) {
    const entry = getFloatingWindowLayout(windowId);
    if (entry.maximized) {
      return null;
    }
    return ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => (
      <button
        key={`${windowId}_resize_${edge}`}
        type="button"
        className={`floating-window-resize-handle floating-window-resize-${edge}`}
        aria-label={`Fenstergröße ändern (${edge})`}
        tabIndex={-1}
        onPointerDown={(event) => beginFloatingWindowResize(windowId, edge, event)}
      />
    ));
  }

  function isFloatingWindowOpen(windowId) {
    if (windowId === 'trackChain') {
      return trackChainModalTrackId != null;
    }
    if (windowId === 'settings') {
      return Boolean(showSettingsModal);
    }
    if (windowId === 'recordMic') {
      return recordMicModalTrackId != null;
    }
    if (windowId === 'importTrackRename') {
      return Boolean(importTrackRenamePrompt);
    }
    return false;
  }

  function closeFloatingWindow(windowId) {
    if (windowId === 'trackChain') {
      setTrackChainModalTrackId(null);
      setOpenTrackPluginPicker(null);
      return;
    }
    if (windowId === 'settings') {
      setShowSettingsModal(false);
      return;
    }
    if (windowId === 'recordMic') {
      setRecordMicModalTrackId(null);
      return;
    }
    if (windowId === 'importTrackRename') {
      resolveImportTrackRenamePrompt({ apply: false, trackName: '' });
    }
  }

  function getFloatingWindowTitle(windowId) {
    if (windowId === 'trackChain') {
      return trackChainModalTrack ? `${trackChainModalTrack.name || `Track ${trackChainModalTrack.track_id}`} · FX` : 'Node Chain';
    }
    if (windowId === 'settings') {
      return 'Settings';
    }
    if (windowId === 'recordMic') {
      return recordMicModalTrackId != null ? `Mic Track ${recordMicModalTrackId}` : 'Mic';
    }
    if (windowId === 'importTrackRename') {
      return importTrackRenamePrompt
        ? `Track ${importTrackRenamePrompt.trackId} Name`
        : 'Track Name übernehmen';
    }
    return windowId;
  }

  function setAudioInputDevice(deviceId, onResult) {
    if (!socketRef.current || !deviceId) {
      if (typeof onResult === 'function') {
        onResult({ ok: false, error: 'missing socket or device id' });
      }
      return;
    }
    socketRef.current.emit('audio:set-input', { deviceId }, (res) => {
      if (res?.ok) {
        setAudioInputCurrentId(deviceId);
      }
      if (typeof onResult === 'function') {
        onResult(res);
      }
    });
  }

  function setRecordArm(trackId, recordArmed) {
    applyLocalTrackMix(trackId, { record_armed: Boolean(recordArmed) });
    ensureTrackExists(trackId, () => {
      emitMutation('track:set-record-arm', { trackId, recordArmed: Boolean(recordArmed) });
    });
  }

  function setRecordArmWithMic(trackId, deviceId, deviceName, options = {}) {
    const onFailure = typeof options?.onFailure === 'function' ? options.onFailure : null;
    const onSuccess = typeof options?.onSuccess === 'function' ? options.onSuccess : null;
    if (!deviceId) {
      onFailure?.({ ok: false, error: 'missing device id' });
      return;
    }
    setAudioInputDevice(deviceId, (resAudio) => {
      if (!resAudio?.ok) {
        onFailure?.(resAudio);
        return;
      }
      applyLocalTrackMix(trackId, {
        record_armed: true,
        record_input_device_id: deviceId,
        record_input_device_name: deviceName || deviceId,
      });
      ensureTrackExists(trackId, () => {
        emitMutation('track:set-record-arm', {
          trackId,
          recordArmed: true,
          record_input_device_id: deviceId,
          record_input_device_name: deviceName || deviceId,
        });
      });
      setRecordMicModalTrackId(null);
      onSuccess?.(resAudio);
    });
  }

  function openRecordArmMicSelection(trackId) {
    const resolvedTrackId = Number(trackId);
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0) {
      return;
    }

    if (!recordUseStandardMicPreference) {
      setRecordMicModalTrackId(resolvedTrackId);
      return;
    }

    const fallbackMessage = 'eingestelltes Standard-Mikrofon nicht verfügbar. Bitte Mikrofon auswählen.';
    const selectedDeviceId = typeof audioInputCurrentId === 'string' ? audioInputCurrentId.trim() : '';
    if (!selectedDeviceId) {
      appendSystemMessage(fallbackMessage);
      setRecordMicModalTrackId(resolvedTrackId);
      return;
    }

    const knownDevices = audioInputDevices.length > 0 ? audioInputDevices : recordMicInputDevices;
    const matchingDevice = knownDevices.find((device) => device?.id === selectedDeviceId) || null;
    if (knownDevices.length > 0 && !matchingDevice) {
      appendSystemMessage(fallbackMessage);
      setRecordMicModalTrackId(resolvedTrackId);
      return;
    }

    setRecordArmWithMic(resolvedTrackId, selectedDeviceId, matchingDevice?.name || selectedDeviceId, {
      onFailure: () => {
        appendSystemMessage(fallbackMessage);
        setRecordMicModalTrackId(resolvedTrackId);
      },
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
    setClipQuickToolMenu(null);
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
    const socket = socketRef.current;
    if (!socket) {
      return false;
    }
    if (!socket.connected) {
      appendSystemMessage('VST-Scan abgebrochen: Keine Verbindung zum Engine-Socket.');
      return false;
    }
    if (connection !== 'online' || !state?.nativeTransport) {
      appendSystemMessage('VST-Scan nicht moeglich: Native Engine ist nicht bereit (warte auf Transport).');
      return false;
    }

    if (pluginScanAckTimeoutRef.current) {
      clearTimeout(pluginScanAckTimeoutRef.current);
      pluginScanAckTimeoutRef.current = null;
    }

    setPluginScanPending(true);
    /** Slightly above engine `NATIVE_VST_SCAN_TIMEOUT_MS` (600000) so the server can answer first. */
    const clientAckSafetyMs = 615000;
    pluginScanAckTimeoutRef.current = setTimeout(() => {
      pluginScanAckTimeoutRef.current = null;
      setPluginScanPending(false);
      appendSystemMessage(
        'VST-Scan: Keine Antwort vom Engine (Timeout). Pruefe Engine-/Native-Logs und starte die Native-Engine neu.',
      );
    }, clientAckSafetyMs);

    socket.emit('vst:scan', {}, (result) => {
      if (pluginScanAckTimeoutRef.current) {
        clearTimeout(pluginScanAckTimeoutRef.current);
        pluginScanAckTimeoutRef.current = null;
      }
      setPluginScanPending(false);

      if (!result?.ok) {
        appendSystemMessage(`Fehler (vst:scan): ${result?.error || 'Unbekannter Fehler'}`);
        return;
      }

      const plugins = normalizePluginCatalog(result.plugins);
      setAvailablePlugins(plugins);
      const effectPlugins = plugins.filter((plugin) => plugin.kind !== 'instrument');
      setSelectedPluginUid((previousUid) => {
        if (previousUid && effectPlugins.some((plugin) => plugin.uid === previousUid)) {
          return previousUid;
        }
        return effectPlugins[0]?.uid || FALLBACK_VST_UID;
      });

      if (!silent) {
        appendSystemMessage(`VST-Scan abgeschlossen: ${plugins.length} Plugins gefunden.`);
      }
    });
    return true;
  }, [appendSystemMessage, connection, state?.nativeTransport]);

  function addVst(options = {}) {
    const requestedSlotKind = normalizePluginKind(options.slotKind ?? options.slot_kind, null);
    const defaultEffectPluginUid = availableEffectPlugins[0]?.uid;
    const fallbackPluginUid = requestedSlotKind === 'effect'
      ? (defaultEffectPluginUid || '')
      : FALLBACK_VST_UID;
    const pluginUid = typeof options.pluginUid === 'string' && options.pluginUid.trim()
      ? options.pluginUid.trim()
      : (typeof selectedPluginUid === 'string' && selectedPluginUid.trim() ? selectedPluginUid.trim() : fallbackPluginUid);
    if (!pluginUid) {
      appendSystemMessage('Kein Effekt-Plugin verfuegbar. Bitte zuerst Plugins scannen.');
      return;
    }
    const requestedTrackId = Number(options.trackId ?? selectedPluginTrackId ?? selectedTrackId ?? 1);
    let trackId;
    if (options.track_id === 0 || options.trackId === 0) {
      trackId = 0;
    } else {
      trackId = Number.isInteger(requestedTrackId) && requestedTrackId > 0 ? requestedTrackId : 1;
    }
    const insertIndexRaw = Number(options.insertIndex);
    const insertIndex = Number.isInteger(insertIndexRaw) && insertIndexRaw >= 0 ? insertIndexRaw : null;

    const runVstAdd = () => {
      setPluginLoadPending(true);
      socketRef.current?.emit('vst:add', {
        plugin_uid: pluginUid,
        track_id: trackId,
        ...(requestedSlotKind ? { slot_kind: requestedSlotKind } : {}),
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
    };

    if (trackId === 0) {
      runVstAdd();
      return;
    }

    ensureTrackExists(trackId, runVstAdd);
  }

  function setVstNodeParameter(node, paramId, value) {
    if (!node || node.type !== 'vst_instrument') {
      return;
    }

    const trackId = resolveNodeTrackId(node);
    const pluginIndex = resolveNodePluginIndex(node, -1);
    const nextValue = clamp(Number(value), 0, 1);
    if (trackId == null || !Number.isInteger(pluginIndex) || pluginIndex < 0 || !Number.isFinite(nextValue)) {
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

  function applyInspectorTracktionEqGainTargets(targets) {
    if (!inspectorNode || inspectorNode.type !== 'vst_instrument') {
      return;
    }
    if (!inspectorTracktionEqUi?.gainParams || !targets || typeof targets !== 'object') {
      return;
    }

    for (const [role, targetGainDb] of Object.entries(targets)) {
      const parameter = inspectorTracktionEqUi.gainParams[role];
      if (!parameter || typeof parameter.id !== 'string' || !parameter.id) {
        continue;
      }
      const normalizedValue = getPluginParameterNormalizedFromActual(parameter, Number(targetGainDb));
      setVstNodeParameter(inspectorNode, parameter.id, normalizedValue);
    }
  }

  function applyInspectorTracktionEqPreset(presetId) {
    const targets = buildTracktionEqInspectorPresetGainTargets(presetId);
    if (!targets) {
      return;
    }
    applyInspectorTracktionEqGainTargets(targets);
  }

  function setInspectorTracktionEqEasyMacro(macroId, nextValue) {
    if (!inspectorTracktionEqUi?.gainParams) {
      return;
    }

    const current = inspectorTracktionEqUi.easyMacros || { mud: 0, presence: 0, softness: 0 };
    const nextMacros = {
      mud: current.mud,
      presence: current.presence,
      softness: current.softness,
      [macroId]: clamp(Number(nextValue), 0, 1),
    };
    applyInspectorTracktionEqGainTargets(buildTracktionEqInspectorEasyGainTargets(nextMacros));
  }

  function selectInspectorTracktionEqBand(bandId) {
    if (typeof bandId !== 'string' || !bandId.trim()) {
      return;
    }
    setInspectorEqSelectedBandId(bandId);
  }

  function registerInspectorEqProParamRowRef(paramId, element) {
    if (typeof paramId !== 'string' || !paramId) {
      return;
    }
    if (element) {
      inspectorEqProParamRowRefs.current.set(paramId, element);
      return;
    }
    inspectorEqProParamRowRefs.current.delete(paramId);
  }

  function toggleInspectorEqAnalyzerFreeze() {
    setInspectorEqAnalyzerFrozen((previous) => !previous);
  }

  function toggleInspectorTracktionEqReadoutPin() {
    if (inspectorEqPinnedReadout) {
      setInspectorEqPinnedReadout(null);
      return;
    }

    const current = inspectorTracktionEqCurveReadout;
    if (!current || !Number.isFinite(Number(current.freqHz)) || !Number.isFinite(Number(current.gainDb))) {
      return;
    }

    setInspectorEqPinnedReadout({
      source: 'pinned',
      bandId: typeof current.bandId === 'string' ? current.bandId : null,
      label: typeof current.label === 'string' ? current.label : null,
      freqHz: Number(current.freqHz),
      gainDb: Number(current.gainDb),
    });
    setInspectorEqCurveHover(null);
  }

  function previewInspectorTracktionEqBandHover(band) {
    if (inspectorEqPinnedReadout) {
      return;
    }
    if (!band || typeof band !== 'object') {
      return;
    }
    if (!Number.isFinite(Number(band.freqHz)) || !Number.isFinite(Number(band.gainDb))) {
      return;
    }
    setInspectorEqCurveHover({
      source: 'pro-row-band',
      bandId: typeof band.id === 'string' ? band.id : null,
      label: typeof band.label === 'string' ? band.label : null,
      freqHz: Number(band.freqHz),
      gainDb: Number(band.gainDb),
    });
  }

  function clearInspectorTracktionEqCurveHover() {
    if (inspectorEqPinnedReadout) {
      return;
    }
    setInspectorEqCurveHover(null);
  }

  function handleInspectorTracktionEqCurvePointerMove(event) {
    if (inspectorEqPinnedReadout) {
      return;
    }
    const curve = inspectorTracktionEqUi?.curve;
    if (!curve || !Array.isArray(curve.samples) || curve.samples.length === 0) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    const x = clamp(((event.clientX - rect.left) / rect.width) * curve.width, 0, curve.width);
    const y = clamp(((event.clientY - rect.top) / rect.height) * curve.height, 0, curve.height);
    const sampleIndex = clamp(Math.round(x), 0, curve.samples.length - 1);
    const sample = curve.samples[sampleIndex];
    if (!sample) {
      return;
    }

    let nearestNode = null;
    let nearestNodeDistance = 12;
    if (Array.isArray(curve.nodePoints)) {
      for (const point of curve.nodePoints) {
        if (!point) {
          continue;
        }
        const dx = Number(point.x) - x;
        const dy = Number(point.y) - y;
        const distance = Math.sqrt((dx * dx) + (dy * dy));
        if (distance < nearestNodeDistance) {
          nearestNodeDistance = distance;
          nearestNode = point;
        }
      }
    }

    if (nearestNode) {
      setInspectorEqCurveHover({
        source: 'band',
        bandId: nearestNode.id,
        label: nearestNode.label,
        freqHz: nearestNode.freqHz,
        gainDb: nearestNode.gainDb,
      });
      return;
    }

    setInspectorEqCurveHover({
      source: 'curve',
      bandId: null,
      label: null,
      freqHz: sample.freqHz,
      gainDb: sample.db,
    });
  }

  function setVstNodeBypassed(node, bypassed) {
    if (!node || node.type !== 'vst_instrument') {
      return;
    }
    const trackId = resolveNodeTrackId(node);
    const pluginIndex = Number(node.plugin_index ?? node.pluginIndex);
    if (trackId == null || !Number.isInteger(pluginIndex) || pluginIndex < 0) {
      return;
    }
    emitMutation('vst:bypass:set', {
      nodeId: node.id,
      track_id: trackId,
      plugin_index: pluginIndex,
      bypassed: Boolean(bypassed),
    });
  }

  function openVstNodeEditor(node) {
    if (!node || node.type !== 'vst_instrument') {
      return;
    }

    const trackId = resolveNodeTrackId(node);
    const pluginIndex = resolveNodePluginIndex(node, -1);
    if (trackId == null || !Number.isInteger(pluginIndex) || pluginIndex < 0) {
      appendSystemMessage('Plugin-Fenster konnte nicht geoeffnet werden (ungueltige Node-Metadaten).');
      return;
    }

    socketRef.current?.emit('vst:editor:open', {
      node_id: node.id,
      track_id: trackId,
      plugin_index: pluginIndex,
    }, (result) => {
      if (!result?.ok) {
        appendSystemMessage(`Fehler (vst:editor:open): ${result?.error || 'Unbekannter Fehler'}`);
      }
    });
  }

  function setTrackChainEnabled(trackId, enabled) {
    if (!Number.isInteger(trackId) || trackId < 0) return;
    setTrackChainEnabledOverrides((prev) => ({ ...prev, [trackId]: enabled }));
    emitMutation('track:set-chain-enabled', { trackId, enabled });
  }

  function removeVstNode(node) {
    if (!node || node.type !== 'vst_instrument') {
      return;
    }
    const pluginLabel = resolveNodePluginDisplayName(node, pluginNameByUid);
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
      || resolvedTrackId < 0
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

  function openTrackChainModalSlotPluginPicker(trackId, slotIndex) {
    const resolvedTrackId = Number(trackId);
    const resolvedSlotIndex = Number(slotIndex);
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId < 0 || !Number.isInteger(resolvedSlotIndex) || resolvedSlotIndex < 0) {
      return;
    }

    setTrackChainModalTrackId(resolvedTrackId);
    restoreFloatingWindow('trackChain');
    openTrackSlotPluginPicker(resolvedTrackId, resolvedSlotIndex, 'modal');
  }

  function openTrackSlotPluginPicker(trackId, slotIndex, scope = 'track') {
    const resolvedTrackId = Number(trackId);
    const resolvedSlotIndex = Number(slotIndex);
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId < 0 || !Number.isInteger(resolvedSlotIndex) || resolvedSlotIndex < 0) {
      return;
    }
    setTrackContextMenu(null);
    setOpenTrackMenuId(null);
    setOpenTrackPluginPicker({
      trackId: resolvedTrackId,
      slotIndex: resolvedSlotIndex,
      scope,
    });
    if (availableEffectPlugins.length === 0 && !pluginScanPending) {
      scanVstPlugins({ silent: true });
    }
  }

  useEffect(() => {
    if (activeTab !== 'Node') {
      nodeTabVstAutoScanDoneRef.current = false;
      return;
    }
    if (pluginScanPending || availablePlugins.length > 0 || nodeTabVstAutoScanDoneRef.current) {
      return;
    }
    if (connection !== 'online' || !state?.nativeTransport) {
      return;
    }
    const started = scanVstPlugins({ silent: true });
    if (started) {
      nodeTabVstAutoScanDoneRef.current = true;
    }
  }, [activeTab, pluginScanPending, availablePlugins.length, scanVstPlugins, connection, state?.nativeTransport]);

  useEffect(() => {
    if (!showSettingsModal || settingsTab !== 'VST PLUGINS') {
      settingsVstPluginsAutoScanDoneRef.current = false;
      return;
    }
    if (pluginScanPending || availablePlugins.length > 0 || settingsVstPluginsAutoScanDoneRef.current) {
      return;
    }
    if (connection !== 'online' || !state?.nativeTransport) {
      return;
    }
    const started = scanVstPlugins({ silent: true });
    if (started) {
      settingsVstPluginsAutoScanDoneRef.current = true;
    }
  }, [showSettingsModal, settingsTab, pluginScanPending, availablePlugins.length, scanVstPlugins, connection, state?.nativeTransport]);

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
      const renameDecision = await requestImportTrackRenameDecision(resolvedTrackId, supported);
      if (renameDecision.apply && isNonEmptyString(renameDecision.trackName)) {
        renameTrack(resolvedTrackId, renameDecision.trackName);
      }
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
          const trimFromPeaks = imported.type === 'audio' && waveformPeaks.length > 0 && sourceDurationSeconds !== null
            ? Number(getLeadingSilenceOffsetSecondsFromPeaks(waveformPeaks, sourceDurationSeconds).toFixed(6))
            : 0;
          emitMutation(
            'clip:import-file',
            {
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
              ...(imported.type === 'audio' ? { trim_start_seconds: trimFromPeaks } : {}),
            },
            (result) => {
              if (result?.nativeImportError) {
                appendSystemMessage(`Clip angelegt, aber Audio-Engine-Import fehlgeschlagen: ${result.nativeImportError}. Playback moeglicherweise ohne Ton.`);
              }
              const importedClipId = isNonEmptyString(result?.clipId) ? result.clipId.trim() : '';
              if (imported.type === 'audio' && importedClipId) {
                requestClipBpmKeyAnalysis({
                  trackId: resolvedTrackId,
                  clipId: importedClipId,
                  clipType: 'audio',
                  clipLabel: imported.sourceName || importedClipId,
                  showResultModal: supported.length === 1,
                  announceStart: false,
                  announceDone: false,
                  autoRenameBaseName: imported.sourceName || importedClipId,
                });
              }
            },
          );
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

  function shouldBlockTrackRowDragFromTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }
    if (target.closest('[data-track-reorder-handle="true"]')) {
      return false;
    }
    return Boolean(
      target.closest(
        '[data-track-drag-ignore="true"], input, button, select, textarea, label, a, [contenteditable="true"]',
      ),
    );
  }

  function handleTrackRowPointerDownCapture(event) {
    trackRowDragBlockedRef.current = shouldBlockTrackRowDragFromTarget(event.target);
  }

  function handleTrackRowDragStart(event, trackId) {
    if (trackRowDragBlockedRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.dataTransfer.setData(TRACK_REORDER_MIME, String(trackId));
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(trackId));
    setTrackReorderDragId(trackId);
  }

  function handleTrackRowDragEnd() {
    trackRowDragBlockedRef.current = false;
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
    trackRowDragBlockedRef.current = false;
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
    setClipQuickToolMenu(null);
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
      setClipQuickToolMenu(null);
      setOpenTrackPluginPicker(null);
      return;
    }
    setOpenTrackMenuId(null);
    setTrackContextMenu(null);
    setClipQuickToolMenu(null);
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

  function openClipQuickToolMenu(event, {
    trackId,
    clipId,
    clipType,
    clipLabel,
    clipName,
    clipColor,
  }) {
    const resolvedTrackId = Number(trackId);
    const resolvedClipId = isNonEmptyString(clipId)
      ? clipId.trim()
      : (clipId !== undefined && clipId !== null ? String(clipId) : '');
    if (!Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0 || !resolvedClipId) {
      return;
    }

    event.stopPropagation();
    setClipRenameColorPrompt(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const estimatedWidth = 210;
    const estimatedHeight = 164;
    let nextX = rect.left;
    let nextY = rect.bottom + 6;
    if (typeof window !== 'undefined') {
      nextX = Math.min(nextX, window.innerWidth - estimatedWidth - 8);
      nextY = Math.min(nextY, window.innerHeight - estimatedHeight - 8);
    }

    setClipQuickToolMenu((previous) => {
      if (previous && previous.trackId === resolvedTrackId && previous.clipId === resolvedClipId) {
        return null;
      }
      return {
        trackId: resolvedTrackId,
        clipId: resolvedClipId,
        clipType: typeof clipType === 'string' ? clipType : 'unknown',
        clipLabel: typeof clipLabel === 'string' ? clipLabel : '',
        clipName: typeof clipName === 'string' ? clipName : '',
        clipColor: normalizeClipCustomColor(clipColor) || '',
        x: Math.max(8, nextX),
        y: Math.max(8, nextY),
      };
    });
  }

  function handleClipQuickToolAction(menu, actionId) {
    setClipQuickToolMenu(null);
    const resolvedTrackId = Number(menu?.trackId);
    const resolvedClipId = isNonEmptyString(menu?.clipId) ? menu.clipId.trim() : '';
    if (!menu || !Number.isInteger(resolvedTrackId) || resolvedTrackId <= 0 || !resolvedClipId) {
      return;
    }

    const clipDescriptor = menu.clipLabel
      ? `"${menu.clipLabel}" (Track ${menu.trackId})`
      : `Clip ${menu.clipId} auf Track ${menu.trackId}`;

    if (actionId === 'extract_stems') {
      if (menu.clipType !== 'audio') {
        appendSystemMessage(`Extract Stems ist aktuell nur fuer Audio-Clips gedacht (${clipDescriptor}).`);
        return;
      }
      appendSystemMessage(`Extract Stems fuer ${clipDescriptor} ist noch nicht implementiert.`);
      return;
    }

    if (actionId === 'fit_to_tempo') {
      appendSystemMessage(`Fit to Tempo fuer ${clipDescriptor} ist noch nicht implementiert.`);
      return;
    }

    if (actionId === 'rename_and_color') {
      const estimatedWidth = 256;
      const estimatedHeight = 212;
      let nextX = Number(menu.x) || 8;
      let nextY = (Number(menu.y) || 8) + 8;
      if (typeof window !== 'undefined') {
        nextX = Math.min(nextX, window.innerWidth - estimatedWidth - 8);
        nextY = Math.min(nextY, window.innerHeight - estimatedHeight - 8);
      }
      setClipRenameColorPrompt({
        trackId: resolvedTrackId,
        clipId: resolvedClipId,
        clipType: typeof menu.clipType === 'string' ? menu.clipType : 'unknown',
        clipLabel: typeof menu.clipLabel === 'string' ? menu.clipLabel : '',
        nameValue: typeof menu.clipName === 'string' ? menu.clipName : '',
        colorValue: normalizeClipCustomColor(menu.clipColor) || '',
        x: Math.max(8, nextX),
        y: Math.max(8, nextY),
      });
      return;
    }

    if (actionId === 'analyze_bpm_key') {
      requestClipBpmKeyAnalysis({
        trackId: resolvedTrackId,
        clipId: resolvedClipId,
        clipType: menu.clipType,
        clipLabel: menu.clipLabel || '',
        showResultModal: true,
        announceStart: true,
        announceDone: true,
      });
    }
  }

  function updateClipRenameColorPrompt(patch) {
    setClipRenameColorPrompt((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        ...(patch && typeof patch === 'object' ? patch : {}),
      };
    });
  }

  function closeClipRenameColorPrompt() {
    setClipRenameColorPrompt(null);
  }

  function submitClipRenameColorPrompt() {
    if (!clipRenameColorPrompt) {
      return;
    }
    const trackId = Number(clipRenameColorPrompt.trackId);
    const clipId = isNonEmptyString(clipRenameColorPrompt.clipId)
      ? clipRenameColorPrompt.clipId.trim()
      : '';
    if (!Number.isInteger(trackId) || trackId <= 0 || !clipId) {
      setClipRenameColorPrompt(null);
      return;
    }

    const nextName = isNonEmptyString(clipRenameColorPrompt.nameValue)
      ? clipRenameColorPrompt.nameValue.trim()
      : '';
    const nextColor = normalizeClipCustomColor(clipRenameColorPrompt.colorValue) || '';
    const clipKey = getClipSelectionKey(trackId, clipId);

    setClipDisplayOverrides((previous) => ({
      ...previous,
      [clipKey]: {
        name: nextName || undefined,
        color: nextColor || undefined,
      },
    }));
    setClipRenameColorPrompt(null);

    emitMutation('clip:set-properties', {
      trackId,
      clipId,
      name: nextName,
      color: nextColor,
    }, () => {
      appendSystemMessage(`Rename and Color fuer Clip "${clipId}" auf Track ${trackId} aktualisiert.`);
    });
  }

  function beginClipInteraction(event, mode, trackId, clip, interactionOptions = {}) {
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
    if (mode === 'move') {
      setClipInteraction({
        mode: 'move',
        trackId,
        clipId: clip.id,
        originX: event.clientX,
        start: Number(clip.start) || 0,
        length: Number(clip.length) || 1,
      });
      return;
    }
    const edge = interactionOptions.edge === 'start' ? 'start' : 'end';
    const bpm = Number(state?.project?.bpm) || 128;
    const sourceDur = Number(clip?.source_duration_seconds ?? clip?.sourceDurationSeconds);
    setClipInteraction({
      mode: edge === 'start' ? 'resize-left' : 'resize',
      trackId,
      clipId: clip.id,
      originX: event.clientX,
      start: Number(clip.start) || 0,
      length: Number(clip.length) || 1,
      bpm,
      trimStart: getInteractionTrimStart(clip),
      sourceDurationSeconds: Number.isFinite(sourceDur) && sourceDur > 0 ? sourceDur : null,
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

  function beginClipGainInteraction(event, trackId, clip) {
    event.preventDefault();
    event.stopPropagation();
    const clipKey = getClipSelectionKey(trackId, clip.id);
    const originGain = normalizeClipGain(clip.gain);
    const originDb = clipGainToDb(originGain);
    gainDragOriginRef.current = { originY: event.clientY, originDb };
    gainDragDraftRef.current = originGain;
    setGainDraftByKey((previous) => ({ ...previous, [clipKey]: originGain }));

    const handleMove = (moveEvent) => {
      const start = gainDragOriginRef.current;
      if (!start) {
        return;
      }
      const deltaY = start.originY - moveEvent.clientY;
      const nextDb = clamp(start.originDb + deltaY * CLIP_GAIN_DB_PER_PIXEL, CLIP_GAIN_DB_MIN, CLIP_GAIN_DB_MAX);
      const nextGain = clipDbToGain(nextDb);
      gainDragDraftRef.current = nextGain;
      setGainDraftByKey((previous) => ({ ...previous, [clipKey]: nextGain }));
    };

    const handleUp = () => {
      const draftGain = gainDragDraftRef.current;
      if (draftGain != null) {
        emitMutation('clip:set-gain', {
          trackId,
          clipId: clip.id,
          gain: Number(draftGain.toFixed(4)),
        });
      }
      gainDragDraftRef.current = null;
      gainDragOriginRef.current = null;
      setGainDraftByKey((previous) => {
        const next = { ...previous };
        delete next[clipKey];
        return next;
      });
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
    if (event.target.closest('.clip-fade-in-curve-handle, .clip-fade-out-curve-handle')) {
      const which = event.target.closest('.clip-fade-in-curve-handle') ? 'in' : 'out';
      beginFadeHandleInteraction(which, 'curve', event, trackId, clip);
      return;
    }
    if (event.target.closest('.clip-fade-in-handle, .clip-fade-out-handle')) {
      const which = event.target.closest('.clip-fade-in-handle') ? 'in' : 'out';
      beginFadeHandleInteraction(which, 'length', event, trackId, clip);
      return;
    }
    if (event.target.closest('.clip-corner-tools, .clip-corner-button')) {
      return;
    }
    const clipType = (clip?.type || clip?.clip_type || '').toString().toLowerCase();
    if (
      clipType === 'audio'
      && editTool === 'select'
      && event.target.closest('.clip-gain-handle')
      && !event.target.closest('.clip-resize-handle, .clip-corner-tools, .clip-fade-in-handle, .clip-fade-out-handle, .clip-fade-in-curve-handle, .clip-fade-out-curve-handle')
    ) {
      beginClipGainInteraction(event, trackId, clip);
      return;
    }

    if (editTool === 'delete') {
      event.preventDefault();
      event.stopPropagation();
      emitMutation('clip:delete', { trackId, clipId: String(clip.id) });
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
      const playlistArrSliceDbg = Array.isArray(state?.project?.playlist) ? state.project.playlist : [];
      const srcTrackSliceDbg = playlistArrSliceDbg.find((tRow) => Number(tRow?.track_id) === Number(trackId));
      const sourceClipRow = Array.isArray(srcTrackSliceDbg?.clips)
        ? srcTrackSliceDbg.clips.find((cRow) => String(cRow?.id) === String(clip?.id))
        : null;
      console.log('[CUT_INPUT] raw event/client', {
        clientX: event.clientX,
        clientY: event.clientY,
      });
      console.log('[CUT_INPUT] pointer context', {
        x: context.x,
        bars: context.bars,
        snappedBars: context.snappedBars,
        snapStep,
        barWidth: barWidthRef.current,
      });
      console.log('[CUT_INPUT] clip passed to splitClipAtBar', {
        id: clip?.id,
        start: clip?.start,
        length: clip?.length,
        type: clip?.type,
        trim_start_seconds: clip?.trim_start_seconds,
      });
      console.log('[CUT_INPUT] rendered vs source clip', {
        rendered: {
          id: clip?.id,
          start: clip?.start,
          length: clip?.length,
        },
        source: sourceClipRow
          ? {
            id: sourceClipRow.id,
            start: sourceClipRow.start,
            length: sourceClipRow.length,
          }
          : null,
      });
      splitClipAtBar(trackId, clip, context.bars, snapStep);
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
      // Fall through so drag moves the clip (selector = select + move on drag).
    }

    beginClipInteraction(event, 'move', trackId, clip);
  }

  function handleClipResizePointerDown(event, trackId, clip, edge = 'end') {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (editTool === 'slip') {
      return;
    }
    const clipKey = getClipSelectionKey(trackId, clip.id);
    applyClipSelection([clipKey], { additive: false, toggle: false });
    beginClipInteraction(event, 'resize', trackId, clip, { edge });
  }

  function beginFadeHandleInteraction(which, mode, event, trackId, clip) {
    event.preventDefault();
    event.stopPropagation();
    const bpm = Number(transportSnapshotRef.current?.bpm) || 120;
    const clipLengthBars = Number(clip.length) || 1;
    const clipLengthSeconds = barsToSeconds(clipLengthBars, bpm, timeSignature);
    const fadeIn = Number(clip.fade_in) || 0;
    const fadeOut = Number(clip.fade_out) || 0;
    const fadeInCurve = FADE_CURVE_ORDER.includes(clip.fade_in_curve) ? clip.fade_in_curve : 'linear';
    const fadeOutCurve = FADE_CURVE_ORDER.includes(clip.fade_out_curve) ? clip.fade_out_curve : 'linear';
    const originCurve = which === 'in' ? fadeInCurve : fadeOutCurve;
    const clipKey = getClipSelectionKey(trackId, clip.id);
    fadeHandleDraftRef.current = { fadeIn, fadeOut, fadeInCurve, fadeOutCurve };
    fadeHandleStartRef.current = {
      originX: event.clientX,
      originY: event.clientY,
      originCurve,
      originFadeIn: fadeIn,
      originFadeOut: fadeOut,
    };
    setFadeHandleInteraction({
      mode,
      which,
      trackId,
      clipId: clip.id,
      fadeIn,
      fadeOut,
      fadeInCurve,
      fadeOutCurve,
      clipLengthSeconds,
    });
    setFadeDraftByKey((prev) => ({ ...prev, [clipKey]: { fadeIn, fadeOut, fadeInCurve, fadeOutCurve } }));
  }

  useEffect(() => {
    if (!fadeHandleInteraction) {
      return;
    }
    const bpm = Number(transportSnapshotRef.current?.bpm) || 120;
    const maxFadeSeconds = fadeHandleInteraction.clipLengthSeconds / 2;
    const clipKey = getClipSelectionKey(fadeHandleInteraction.trackId, fadeHandleInteraction.clipId);

    function handlePointerMove(moveEvent) {
      const start = fadeHandleStartRef.current;
      const draft = fadeHandleDraftRef.current;
      if (!start || !draft) return;

      let nextFadeIn = draft.fadeIn;
      let nextFadeOut = draft.fadeOut;
      let nextFadeInCurve = draft.fadeInCurve;
      let nextFadeOutCurve = draft.fadeOutCurve;

      if (fadeHandleInteraction.mode === 'length') {
        const deltaXBars = (moveEvent.clientX - start.originX) / barWidthRef.current;
        if (fadeHandleInteraction.which === 'in') {
          const newFadeInBars = Math.max(0, secondsToBars(start.originFadeIn, bpm, timeSignature) + deltaXBars);
          nextFadeIn = Math.min(barsToSeconds(newFadeInBars, bpm, timeSignature), maxFadeSeconds);
        } else {
          const newFadeOutBars = Math.max(0, secondsToBars(start.originFadeOut, bpm, timeSignature) - deltaXBars);
          nextFadeOut = Math.min(barsToSeconds(newFadeOutBars, bpm, timeSignature), maxFadeSeconds);
        }
      } else {
        const deltaYPx = moveEvent.clientY - start.originY;
        if (fadeHandleInteraction.which === 'in') {
          nextFadeInCurve = fadeCurveFromVerticalDrag(start.originCurve, deltaYPx);
        } else {
          nextFadeOutCurve = fadeCurveFromVerticalDrag(start.originCurve, deltaYPx);
        }
      }

      fadeHandleDraftRef.current = { fadeIn: nextFadeIn, fadeOut: nextFadeOut, fadeInCurve: nextFadeInCurve, fadeOutCurve: nextFadeOutCurve };
      if (fadeDraftRafRef.current === null) {
        fadeDraftRafRef.current = window.requestAnimationFrame(() => {
          fadeDraftRafRef.current = null;
          const live = fadeHandleDraftRef.current;
          if (!live) return;
          setFadeDraftByKey((prev) => ({
            ...prev,
            [clipKey]: {
              fadeIn: live.fadeIn,
              fadeOut: live.fadeOut,
              fadeInCurve: live.fadeInCurve,
              fadeOutCurve: live.fadeOutCurve,
            },
          }));
        });
      }
    }

    function handlePointerUp() {
      if (fadeDraftRafRef.current !== null) {
        window.cancelAnimationFrame(fadeDraftRafRef.current);
        fadeDraftRafRef.current = null;
      }
      const draft = fadeHandleDraftRef.current;
      if (draft) {
        emitMutation('clip:set-fade', {
          trackId: fadeHandleInteraction.trackId,
          clipId: fadeHandleInteraction.clipId,
          fade_in: draft.fadeIn,
          fade_out: draft.fadeOut,
          fade_in_curve: draft.fadeInCurve,
          fade_out_curve: draft.fadeOutCurve,
        });
      }
      fadeHandleDraftRef.current = null;
      fadeHandleStartRef.current = null;
      setFadeHandleInteraction(null);
      setFadeDraftByKey((prev) => {
        const next = { ...prev };
        delete next[clipKey];
        return next;
      });
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [fadeHandleInteraction, emitMutation, timeSignature]);

  useEffect(() => {
    if (!clipInteraction) {
      return;
    }

    function handlePointerMove(event) {
      const deltaBars = snapToGrid((event.clientX - clipInteraction.originX) / barWidthRef.current, snapStep);
      setClipDrafts((previous) => {
        const next = { ...previous };
        if (clipInteraction.mode === 'move') {
          const draft = buildClipMoveDraft({
            event,
            originX: clipInteraction.originX,
            originTrackId: clipInteraction.trackId,
            clipStartBars: clipInteraction.start,
            clipLengthBars: clipInteraction.length,
            barWidthPx: barWidthRef.current,
            snapStep,
            arrangementTracks,
            getGridPointerContext,
          });
          if (draft) {
            next[clipInteraction.clipId] = draft;
          }
        } else if (clipInteraction.mode === 'resize-left') {
          const bpm = Number(clipInteraction.bpm) || 128;
          let nextStart = snapToGrid(clipInteraction.start + deltaBars, snapStep);
          let nextLength = snapToGrid(clipInteraction.length - deltaBars, snapStep);
          let nextTrim = clipInteraction.trimStart + barsToSeconds(deltaBars, bpm, timeSignature);
          nextStart = Math.max(0, nextStart);
          nextLength = Math.max(snapStep, nextLength);
          nextTrim = Math.max(0, nextTrim);
          const sourceDur = clipInteraction.sourceDurationSeconds;
          if (sourceDur != null && Number.isFinite(sourceDur)) {
            let lenSec = (Math.max(snapStep, nextLength) * BEATS_PER_BAR * 60) / bpm;
            const maxTrim = Math.max(0, sourceDur - lenSec);
            if (nextTrim > maxTrim) {
              nextTrim = maxTrim;
            }
            lenSec = (Math.max(snapStep, nextLength) * BEATS_PER_BAR * 60) / bpm;
            if (nextTrim + lenSec > sourceDur + 1e-6) {
              const minLenSec = (snapStep * BEATS_PER_BAR * 60) / bpm;
              const targetLenSec = Math.max(minLenSec, sourceDur - nextTrim);
              const targetLenBars = (targetLenSec * bpm) / (60 * BEATS_PER_BAR);
              nextLength = Math.max(snapStep, snapToGrid(targetLenBars, snapStep));
            }
          }
          next[clipInteraction.clipId] = {
            trackId: clipInteraction.trackId,
            start: nextStart,
            length: nextLength,
            trimStart: nextTrim,
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
          const payload = {
            trackId: clipInteraction.trackId,
            clipId: clipInteraction.clipId,
            start: draft.start,
          };
          if (Number(draft.trackId) !== Number(clipInteraction.trackId)) {
            payload.toTrackId = draft.trackId;
          }
          emitMutation('clip:move', payload);
        } else if (clipInteraction.mode === 'resize-left') {
          emitMutation('clip:resize', {
            trackId: clipInteraction.trackId,
            clipId: clipInteraction.clipId,
            length: draft.length,
            start: draft.start,
            trim_start_seconds: draft.trimStart,
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

    function handlePointerEnd() {
      handlePointerUp();
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [clipInteraction, emitMutation, snapStep, timeSignature, arrangementTracks, getGridPointerContext]);

  const contextMenuTrack = trackContextMenu
    ? (arrangementTrackMap.get(trackContextMenu.trackId) || null)
    : null;
  const trackChainModalTrack = useMemo(() => {
    if (trackChainModalTrackId === null) {
      return null;
    }
    if (trackChainModalTrackId === 0) {
      const chainOn = trackChainEnabledOverrides[0] !== undefined
        ? Boolean(trackChainEnabledOverrides[0])
        : masterMix.chain_enabled !== false;
      return {
        track_id: 0,
        name: 'Master',
        exists: true,
        mix: {
          volume: masterMix.volume,
          pan: masterMix.pan,
          mute: masterMix.mute,
          solo: false,
          record_armed: false,
        },
        chain_enabled: chainOn,
      };
    }
    return arrangementTrackMap.get(trackChainModalTrackId) || null;
  }, [trackChainModalTrackId, arrangementTrackMap, masterMix, trackChainEnabledOverrides]);
  const trackChainModalNodes = useMemo(() => {
    if (!trackChainModalTrack) {
      return [];
    }
    return vstNodesByTrack.get(trackChainModalTrack.track_id) || [];
  }, [trackChainModalTrack, vstNodesByTrack]);
  const trackChainModalSlots = useMemo(() => {
    // Keep one additional empty slot so plugins can always be appended without a dedicated button.
    const slotCount = Math.max(TRACK_CHAIN_MODAL_MIN_SLOTS, trackChainModalNodes.length + 1);
    return Array.from({ length: slotCount }, (_, slotIndex) => ({
      slotIndex,
      node: trackChainModalNodes[slotIndex] || null,
    }));
  }, [trackChainModalNodes]);
  const trackChainModalPluginPickerOpen = Boolean(
    trackChainModalTrack
      && openTrackPluginPicker
      && openTrackPluginPicker.scope === 'modal'
      && openTrackPluginPicker.trackId === trackChainModalTrack.track_id,
  );
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
  const mixSelectedTrackId = useMemo(() => {
    if (Number.isInteger(selectedTrackId) && mixTracks.some((track) => track.track_id === selectedTrackId)) {
      return selectedTrackId;
    }
    return mixTracks[0]?.track_id ?? null;
  }, [selectedTrackId, mixTracks]);

  const showDawTopShell = activeTab === 'Edit' || activeTab === 'Mix';
  const canUndoProject = Boolean(state?.history?.canUndo);
  const canRedoProject = Boolean(state?.history?.canRedo);
  const dawEngineReady = connection === 'online' && state?.nativeTransport === true;
  const renderConnectionStatusWithLogs = () => (
    <ConnectionStatusLogs
      connection={connection}
      enginePort={String(enginePort)}
      dawEngineReady={dawEngineReady}
      nativeTransport={state?.nativeTransport === true}
      engineDiagnostics={engineDiagnostics}
      connectionLogs={connectionLogs}
      setConnectionLogs={setConnectionLogs}
      appendLogEntry={appendConnectionLogEntry}
    />
  );

  const renderInspectorTracktionEqCurvePanel = ({ mode = 'easy', showBandButtons = true } = {}) => {
    const curve = inspectorTracktionEqUi?.curve;
    if (!inspectorNode || !curve) {
      return null;
    }

    const showMasterScopeNote = inspectorEqAnalyzerAvailable
      && String(inspectorTracktionEqAnalyzerOverlay?.scope || '').toLowerCase() === 'master';

    return (
      <div
        className={`inspector-eq-mini-curve ${mode === 'pro' ? 'is-pro' : ''}`}
        aria-label={mode === 'pro' ? 'EQ Verlauf und Analyzer (Pro)' : 'EQ Verlauf Vorschau'}
      >
        <div className="inspector-eq-mini-curve-head">
          <span>{`EQ Verlauf + Analyzer (${inspectorTracktionEqAnalyzerStatusText})`}</span>
          <div className="inspector-eq-mini-curve-head-actions">
            <span className={inspectorTracktionEqCurveReadout ? 'is-active' : ''}>
              {inspectorTracktionEqCurveReadout
                ? `${inspectorEqPinnedReadout ? 'PIN · ' : ''}${inspectorTracktionEqCurveReadout.label ? `${inspectorTracktionEqCurveReadout.label}: ` : ''}${formatTracktionEqInspectorReadoutFreq(inspectorTracktionEqCurveReadout.freqHz)} · ${formatTracktionEqInspectorReadoutDb(inspectorTracktionEqCurveReadout.gainDb)}`
                : 'ca. ±18 dB'}
            </span>
            <button
              type="button"
              className={`inspector-eq-mini-curve-pin ${inspectorEqAnalyzerFrozen ? 'active' : ''}`}
              onClick={toggleInspectorEqAnalyzerFreeze}
              aria-pressed={inspectorEqAnalyzerFrozen}
              title={inspectorEqAnalyzerFrozen ? 'Analyzer weiterlaufen lassen' : 'Analyzer einfrieren'}
            >
              {inspectorEqAnalyzerFrozen ? 'Frozen' : 'Freeze'}
            </button>
            <button
              type="button"
              className={`inspector-eq-mini-curve-pin ${inspectorEqPinnedReadout ? 'active' : ''}`}
              onClick={toggleInspectorTracktionEqReadoutPin}
              aria-pressed={Boolean(inspectorEqPinnedReadout)}
              disabled={!inspectorTracktionEqCurveReadout && !inspectorEqPinnedReadout}
              title={inspectorEqPinnedReadout ? 'Readout loesen' : 'Aktuelles Readout pinnen'}
            >
              {inspectorEqPinnedReadout ? 'Unpin' : 'Pin'}
            </button>
          </div>
        </div>
        <svg
          className="inspector-eq-mini-curve-svg"
          viewBox={`0 0 ${curve.width} ${curve.height}`}
          preserveAspectRatio="none"
          role="img"
          aria-hidden="true"
          onPointerMove={handleInspectorTracktionEqCurvePointerMove}
          onPointerLeave={clearInspectorTracktionEqCurveHover}
        >
          {curve.dbLines.map((line) => (
            <line
              key={`${inspectorNode.id}_${mode}_db_${line.db}`}
              x1="0"
              x2={curve.width}
              y1={line.y}
              y2={line.y}
              className={line.db === 0 ? 'eq-zero' : 'eq-grid'}
            />
          ))}

          {curve.ticks.map((tick) => (
            <line
              key={`${inspectorNode.id}_${mode}_tick_${tick.freqHz}`}
              x1={tick.x}
              x2={tick.x}
              y1="0"
              y2={curve.height}
              className="eq-grid"
            />
          ))}

          <path d={curve.fillPath} className="eq-fill" />

          {inspectorTracktionEqAnalyzerOverlay?.pre ? (
            <path
              d={inspectorTracktionEqAnalyzerOverlay.pre.fillPath}
              className={`eq-analyzer-fill-pre ${inspectorTracktionEqAnalyzerOverlay.preMirrorsPost ? 'is-mirrored' : ''}`}
            />
          ) : null}
          {inspectorTracktionEqAnalyzerOverlay?.post ? (
            <path
              d={inspectorTracktionEqAnalyzerOverlay.post.fillPath}
              className="eq-analyzer-fill-post"
            />
          ) : null}
          {inspectorTracktionEqAnalyzerOverlay?.pre ? (
            <path
              d={inspectorTracktionEqAnalyzerOverlay.pre.linePath}
              className={`eq-analyzer-line-pre ${inspectorTracktionEqAnalyzerOverlay.preMirrorsPost ? 'is-mirrored' : ''}`}
            />
          ) : null}
          {inspectorTracktionEqAnalyzerOverlay?.post ? (
            <path
              d={inspectorTracktionEqAnalyzerOverlay.post.linePath}
              className="eq-analyzer-line-post"
            />
          ) : null}

          <path d={curve.strokePath} className="eq-line" />

          {curve.nodePoints.map((point) => (
            <g
              key={`${inspectorNode.id}_${mode}_node_${point.id}`}
              className={`eq-node ${inspectorTracktionEqMiniCurveHighlightBandId === point.id ? 'is-selected' : ''}`}
              onClick={() => selectInspectorTracktionEqBand(point.id)}
            >
              <circle
                cx={point.x}
                cy={point.y}
                r={inspectorTracktionEqMiniCurveHighlightBandId === point.id ? '6.3' : '4.5'}
                fill={point.color}
                fillOpacity={inspectorTracktionEqMiniCurveHighlightBandId === point.id ? '0.26' : '0.18'}
              />
              <circle
                cx={point.x}
                cy={point.y}
                r={inspectorTracktionEqMiniCurveHighlightBandId === point.id ? '3.2' : '2.6'}
                fill={point.color}
                stroke="rgba(255,255,255,0.82)"
                strokeWidth={inspectorTracktionEqMiniCurveHighlightBandId === point.id ? '1.1' : '0.8'}
              />
            </g>
          ))}
        </svg>
        {!inspectorEqAnalyzerAvailable ? (
          <p className="inspector-eq-analyzer-note">Analyzer nur mit laufender Native-Engine verfügbar.</p>
        ) : null}
        {showMasterScopeNote ? (
          <p className="inspector-eq-analyzer-note is-master">Live-Analyzer zeigt aktuell Master-Out (noch nicht nur diesen EQ/Track).</p>
        ) : null}

        <div className="inspector-eq-mini-curve-ticks" aria-hidden="true">
          {curve.ticks.filter((tick) => (
            tick.freqHz === 50
            || tick.freqHz === 200
            || tick.freqHz === 1000
            || tick.freqHz === 5000
            || tick.freqHz === 10000
          )).map((tick) => (
            <span key={`${inspectorNode.id}_${mode}_tick_label_${tick.freqHz}`}>{tick.label}</span>
          ))}
        </div>

        {showBandButtons ? (
          <div className="inspector-eq-mini-band-buttons" role="group" aria-label="EQ Baender">
            {curve.nodePoints.map((point) => (
              <button
                key={`${inspectorNode.id}_${mode}_band_btn_${point.id}`}
                type="button"
                className={inspectorTracktionEqMiniCurveHighlightBandId === point.id ? 'active' : ''}
                onClick={() => selectInspectorTracktionEqBand(point.id)}
                title={`${point.label}: ${formatTracktionEqInspectorReadoutFreq(point.freqHz)} · ${formatTracktionEqInspectorReadoutDb(point.gainDb)}`}
              >
                <span className="dot" style={{ backgroundColor: point.color }} aria-hidden="true" />
                <span>{point.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  /** Renders track/clip/node/pattern/EQ inspector UI for the unified side panel (Inspector tab). Lives in stuu-shell.jsx with access to shell state. */
  function renderInspectorPanelBody() {
    return (
      <>
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
                inspectorTracktionEqUi ? (
                  <div className="inspector-plugin-mode-shell">
                    <div className="inspector-plugin-mode-tabs" role="tablist" aria-label="EQ Inspector Modus">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={inspectorEqViewMode === 'easy'}
                        className={inspectorEqViewMode === 'easy' ? 'active' : ''}
                        onClick={() => setInspectorEqViewMode('easy')}
                        disabled={!inspectorTracktionEqUi.gainParams}
                      >
                        Easy
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={inspectorEqViewMode === 'pro'}
                        className={inspectorEqViewMode === 'pro' ? 'active' : ''}
                        onClick={() => setInspectorEqViewMode('pro')}
                      >
                        Pro
                      </button>
                    </div>

                    {inspectorEqViewMode === 'easy' && inspectorTracktionEqUi.gainParams ? (
                      <div className="inspector-eq-easy">
                        <p className="inspector-eq-hint">
                          Schnellstart fuer den Tracktion EQ: Preset klicken, dann mit 3 Reglern nach Gehoer anpassen.
                        </p>

                        {renderInspectorTracktionEqCurvePanel({ mode: 'easy', showBandButtons: true })}

                        <div className="inspector-eq-preset-grid" role="group" aria-label="EQ Easy Presets">
                          <button type="button" onClick={() => applyInspectorTracktionEqPreset('clean_up')}>Clean Up</button>
                          <button type="button" onClick={() => applyInspectorTracktionEqPreset('vocal_clarity')}>Vocal Klarheit</button>
                          <button type="button" onClick={() => applyInspectorTracktionEqPreset('bass_tight')}>Bass Tight</button>
                          <button type="button" onClick={() => applyInspectorTracktionEqPreset('air_brilliance')}>Air / Brillanz</button>
                        </div>

                        <button
                          type="button"
                          className="inspector-eq-reset-button"
                          disabled={Boolean(inspectorTracktionEqUi?.isEffectivelyFlat)}
                          onClick={() => applyInspectorTracktionEqPreset('flat')}
                          title={
                            inspectorTracktionEqUi?.isEffectivelyFlat
                              ? 'EQ ist bereits praktisch flat'
                              : 'Alle EQ-Gains auf 0 dB setzen'
                          }
                        >
                          Reset EQ (Flat)
                        </button>

                        {[
                          { id: 'mud', label: 'Weniger dumpf', value: inspectorTracktionEqUi.easyMacros.mud },
                          { id: 'presence', label: 'Mehr Praesenz', value: inspectorTracktionEqUi.easyMacros.presence },
                          { id: 'softness', label: 'Weicher', value: inspectorTracktionEqUi.easyMacros.softness },
                        ].map((macro) => (
                          <label key={`${inspectorNode.id}_${macro.id}`} className="inspector-eq-macro-row">
                            <div className="inspector-eq-macro-row-head">
                              <span>{macro.label}</span>
                              <span>{formatInspectorEqMacroPercent(macro.value)}</span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.01}
                              value={clamp(Number(macro.value) || 0, 0, 1)}
                              onChange={(event) => setInspectorTracktionEqEasyMacro(macro.id, Number(event.target.value))}
                            />
                          </label>
                        ))}

                        <p className="muted inspector-eq-footnote">
                          Easy im Inspector arbeitet mit schnellen Gain-Makros. Fuer Frequenz/Q direkt auf Pro wechseln oder das Plugin-Fenster oeffnen.
                        </p>
                      </div>
                    ) : (
                      <>
                        {inspectorEqViewMode === 'easy' && !inspectorTracktionEqUi.gainParams ? (
                          <p className="muted inspector-eq-footnote">
                            Easy-Mapping fuer diesen EQ wurde nicht erkannt. Pro zeigt alle Parameter.
                          </p>
                        ) : null}
                        {inspectorEqViewMode === 'pro'
                          ? renderInspectorTracktionEqCurvePanel({ mode: 'pro', showBandButtons: false })
                          : null}
                        {inspectorEqViewMode === 'pro' && inspectorTracktionEqSelectedBand ? (
                          <div className="inspector-eq-pro-focus">
                            <strong>{`Band Fokus: ${inspectorTracktionEqSelectedBand.label}`}</strong>
                            <span>
                              {`${formatTracktionEqInspectorReadoutFreq(inspectorTracktionEqSelectedBand.freqHz)} · ${formatTracktionEqInspectorReadoutDb(inspectorTracktionEqSelectedBand.gainDb)} · ${formatTracktionEqInspectorReadoutQ(inspectorTracktionEqSelectedBand.qValue)}`}
                            </span>
                            <small>Freq / Gain / Q dieses Bands sind unten hervorgehoben.</small>
                          </div>
                        ) : null}
                        <div className="vst-param-list">
                          {inspectorNodeParameters.length > 0 ? (
                            inspectorNodeParameters.map((parameter) => {
                              const normalizedValue = clamp(Number(parameter.value) || 0, 0, 1);
                              const linkedBand = inspectorEqViewMode === 'pro'
                                ? (inspectorTracktionEqBandByParamId.get(parameter.id) || null)
                                : null;
                              const isLinkedBandParam = Boolean(linkedBand);
                              const isSelectedBandParam = inspectorEqViewMode === 'pro'
                                && inspectorTracktionEqSelectedBandParamIdSet.has(parameter.id);
                              return (
                                <label
                                  key={`${inspectorNode.id}_${parameter.id}`}
                                  className={`vst-param-row ${isLinkedBandParam ? 'band-linked-param' : ''} ${isSelectedBandParam ? 'selected-band-param' : ''}`}
                                  ref={(element) => registerInspectorEqProParamRowRef(parameter.id, element)}
                                  onClick={() => {
                                    if (linkedBand?.id) {
                                      selectInspectorTracktionEqBand(linkedBand.id);
                                    }
                                  }}
                                  onPointerEnter={() => {
                                    if (linkedBand) {
                                      previewInspectorTracktionEqBandHover(linkedBand);
                                    }
                                  }}
                                  onPointerLeave={() => {
                                    if (linkedBand) {
                                      clearInspectorTracktionEqCurveHover();
                                    }
                                  }}
                                  onFocus={() => {
                                    if (linkedBand) {
                                      previewInspectorTracktionEqBandHover(linkedBand);
                                    }
                                  }}
                                  onBlur={() => {
                                    if (linkedBand) {
                                      clearInspectorTracktionEqCurveHover();
                                    }
                                  }}
                                  title={linkedBand?.label ? `Band ${linkedBand.label}` : undefined}
                                >
                                  <div className="vst-param-head">
                                    <span className="vst-param-head-name">
                                      <span>{parameter.name}</span>
                                      {linkedBand ? (
                                        <em className={`vst-param-band-chip ${isSelectedBandParam ? 'active' : ''}`}>{linkedBand.label}</em>
                                      ) : null}
                                    </span>
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
                      </>
                    )}
                  </div>
                ) : (
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
                )
              ) : (
                <pre>{JSON.stringify(inspectorNode, null, 2)}</pre>
              )}
            </div>
          ) : null}

          {inspector.type === 'project' ? (
            <div className="inspector-project-json-shell">
              <div className="inspector-json-download-bar">
                <button
                  type="button"
                  className="inspector-json-download-btn"
                  title="Projekt JSON herunterladen"
                  aria-label="Projekt JSON herunterladen"
                  onClick={() => {
                    const payload = state?.project ?? {};
                    const text = JSON.stringify(payload, null, 2);
                    const blob = new Blob([text], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    try {
                      const anchor = document.createElement('a');
                      anchor.href = url;
                      anchor.download = getProjectJsonDownloadFilename(state?.project);
                      document.body.appendChild(anchor);
                      anchor.click();
                      anchor.remove();
                    } finally {
                      URL.revokeObjectURL(url);
                    }
                  }}
                >
                  <Download size={14} strokeWidth={2} aria-hidden="true" />
                  <span>Download</span>
                </button>
              </div>
              <pre>{JSON.stringify(state?.project, null, 2)}</pre>
            </div>
          ) : null}
      </>
    );
  }

  return (
    <>
    <MeterSubscription socketRef={socketRef} connection={connection} activeTab={activeTab} />
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
        <main className={`panel panel-main ${activeTab === 'Edit' ? 'edit-focus' : ''}`}>
          {showDawTopShell ? (
            <>
              <div className="daw-menu-bar">
                <div className="daw-menu-row daw-menu-row-1">
                  <div className="daw-menu-left">
                    <span className="daw-logo" aria-hidden="true">
                      <Image
                        src="/thestuulogo.png"
                        alt="THE STUU"
                        className="daw-logo-img"
                        width={774}
                        height={172}
                        priority
                      />
                    </span>
                    {DAW_MENU_ITEMS.map((item) =>
                      item === 'SETTINGS' ? (
                        <button
                          key={item}
                          type="button"
                          className="daw-menu-item-button"
                          onClick={() => {
                            setShowSettingsModal(true);
                            restoreFloatingWindow('settings');
                          }}
                          aria-label="Einstellungen öffnen"
                        >
                          {item}
                        </button>
                      ) : (
                        <span key={item}>{item}</span>
                      )
                    )}
                  </div>
                  <div className="daw-menu-right">
                    <button
                      type="button"
                      className="daw-history-btn ai-chat-toggle"
                      onClick={() => {
                        setAiChatDrawerOpen((prev) => {
                          const opening = !prev;
                          if (opening) {
                            setSidePanelTab('assistant');
                          }
                          return opening;
                        });
                      }}
                      aria-label={aiChatDrawerOpen ? 'Seitenpanel schließen' : 'Seitenpanel öffnen (Assistant)'}
                      aria-expanded={aiChatDrawerOpen}
                      title="Assistant / Inspector"
                    >
                      <Bot size={14} aria-hidden="true" />
                    </button>
                    {renderConnectionStatusWithLogs()}
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
                  <div className="daw-history-controls" role="group" aria-label="Undo und Redo">
                    <button
                      type="button"
                      className="daw-history-btn"
                      onClick={triggerProjectUndo}
                      disabled={!canUndoProject || historyMutationPending}
                      title="Zurueck (Cmd/Ctrl+Z)"
                      aria-label="Zurueck"
                    >
                      <Undo2 size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="daw-history-btn"
                      onClick={triggerProjectRedo}
                      disabled={!canRedoProject || historyMutationPending}
                      title="Vor (Cmd+Shift+Z / Ctrl+Y)"
                      aria-label="Vor"
                    >
                      <Redo2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>

              {state?.nativeClipSyncSummary?.failed > 0 ? (
                <div className="alert alert-warning native-clip-sync-warning" role="alert">
                  <span>
                    {state.nativeClipSyncSummary.failed} Audio-Clip(s) konnten nicht an die Engine gesendet werden
                    (z.&nbsp;B. Datei nicht gefunden). Playback dieser Clips ohne Ton. Terminal/Engine-Log prüfen.
                  </span>
                </div>
              ) : null}
              <header className="main-header compact">
                <div className="daw-control-strip">
                  <div className="daw-btn-group">
                    <button
                      type="button"
                      className={`transport-btn ${state?.playing ? 'is-pause' : 'is-play'}`}
                      onClick={togglePlayPause}
                      disabled={!dawEngineReady}
                      title={dawEngineReady
                        ? (state?.playing ? 'Pause (Leertaste)' : 'Play (Leertaste)')
                        : 'Native-Engine nicht verbunden'}
                      aria-label={state?.playing ? 'Pause' : 'Play'}
                      aria-disabled={!dawEngineReady}
                    >
                      {state?.playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                    </button>
                    <button
                      type="button"
                      className="transport-btn is-stop"
                      onClick={transportStop}
                      disabled={!dawEngineReady}
                      title={dawEngineReady ? 'Stop' : 'Native-Engine nicht verbunden'}
                      aria-label="Stop"
                      aria-disabled={!dawEngineReady}
                    >
                      <Square size={12} aria-hidden="true" />
                    </button>
                    <button
                      className={`transport-btn metronome-btn ${metronomeEnabled ? 'active' : ''} ${isMetronomeRunning ? 'running' : ''}`}
                      onClick={toggleMetronome}
                      title={metronomeEnabled ? 'Metronom aus' : 'Metronom an'}
                      aria-label={metronomeEnabled ? 'Metronom ausschalten' : 'Metronom einschalten'}
                      aria-pressed={metronomeEnabled}
                    >
                      <span className="metronome-btn-glyph" aria-hidden="true">
                        <svg className="metronome-btn-icon" viewBox="0 0 64 64">
                          <g className="metronome-btn-static">
                            <path className="metronome-btn-stroke" d="M24 10C24 7 26.3 5 29.2 5H34.8C37.7 5 40 7 40 10" />
                            <line className="metronome-btn-stroke" x1="23" y1="12" x2="41" y2="12" />
                            <path className="metronome-btn-stroke" d="M23 12L16 44H48L41 12" />
                            <line className="metronome-btn-stroke" x1="30.2" y1="17" x2="33.8" y2="17" />
                            <line className="metronome-btn-stroke" x1="29.4" y1="22" x2="34.6" y2="22" />
                            <line className="metronome-btn-stroke" x1="29" y1="27" x2="35" y2="27" />
                            <line className="metronome-btn-stroke" x1="29.4" y1="32" x2="34.6" y2="32" />
                            <line className="metronome-btn-stroke" x1="30.2" y1="37" x2="33.8" y2="37" />
                            <line className="metronome-btn-stroke" x1="16" y1="45" x2="49" y2="45" />
                            <line className="metronome-btn-stroke" x1="16" y1="45" x2="27" y2="45" />
                            <path className="metronome-btn-stroke" d="M16 45L11 62H49L46 50" />
                            <circle className="metronome-btn-fill" cx="49" cy="45" r="2.4" />
                          </g>
                          <g ref={metronomeNeedleRef} className="metronome-btn-needle" transform="rotate(0 32 45)">
                            <line className="metronome-btn-stroke" x1="32" y1="45" x2="32" y2="11" />
                          </g>
                        </svg>
                      </span>
                    </button>
                  </div>

                  <div className="daw-btn-group">
                    <label className="bpm-field compact">
                      BPM
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={bpmInputValue}
                        onChange={handleBpmInputChange}
                        onFocus={handleBpmInputFocus}
                        onBlur={handleBpmInputBlur}
                        onKeyDown={handleBpmInputKeyDown}
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
                  {showDawTopShell ? (
                    <MixPlaylistOverview
                      ref={mixOverviewRef}
                      peaks={playlistOverviewPeaks}
                      maxClipEndBars={maxClipEnd}
                      onSeekBars={seekMixOverviewBars}
                      onSeekEnd={clearMixOverviewPlayheadDrag}
                    />
                  ) : null}
                </div>
              </header>
            </>
          ) : (
            <header className="main-header">
              <div className="main-header-title">
                <h1>{state?.project?.project_name || 'TheStuu Session'}</h1>
                <p>
                  Connection:{' '}
                  {renderConnectionStatusWithLogs()}
                </p>
              </div>

              <div className="transport-group">
                <button
                  type="button"
                  className={`transport-btn ${state?.playing ? 'is-pause' : 'is-play'}`}
                  onClick={togglePlayPause}
                  disabled={!dawEngineReady}
                  title={dawEngineReady
                    ? (state?.playing ? 'Pause (Leertaste)' : 'Play (Leertaste)')
                    : 'Native-Engine nicht verbunden'}
                  aria-label={state?.playing ? 'Pause' : 'Play'}
                  aria-disabled={!dawEngineReady}
                >
                  {state?.playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  className="transport-btn is-stop"
                  onClick={transportStop}
                  disabled={!dawEngineReady}
                  title={dawEngineReady ? 'Stop' : 'Native-Engine nicht verbunden'}
                  aria-label="Stop"
                  aria-disabled={!dawEngineReady}
                >
                  <Square size={12} aria-hidden="true" />
                </button>
                <button
                  className={`transport-btn metronome-btn ${metronomeEnabled ? 'active' : ''} ${isMetronomeRunning ? 'running' : ''}`}
                  onClick={toggleMetronome}
                  title={metronomeEnabled ? 'Metronom aus' : 'Metronom an'}
                  aria-label={metronomeEnabled ? 'Metronom ausschalten' : 'Metronom einschalten'}
                  aria-pressed={metronomeEnabled}
                >
                  <span className="metronome-btn-glyph" aria-hidden="true">
                    <svg className="metronome-btn-icon" viewBox="0 0 64 64">
                      <g className="metronome-btn-static">
                        <path className="metronome-btn-stroke" d="M24 10C24 7 26.3 5 29.2 5H34.8C37.7 5 40 7 40 10" />
                        <line className="metronome-btn-stroke" x1="23" y1="12" x2="41" y2="12" />
                        <path className="metronome-btn-stroke" d="M23 12L16 44H48L41 12" />
                        <line className="metronome-btn-stroke" x1="30.2" y1="17" x2="33.8" y2="17" />
                        <line className="metronome-btn-stroke" x1="29.4" y1="22" x2="34.6" y2="22" />
                        <line className="metronome-btn-stroke" x1="29" y1="27" x2="35" y2="27" />
                        <line className="metronome-btn-stroke" x1="29.4" y1="32" x2="34.6" y2="32" />
                        <line className="metronome-btn-stroke" x1="30.2" y1="37" x2="33.8" y2="37" />
                        <line className="metronome-btn-stroke" x1="16" y1="45" x2="49" y2="45" />
                        <line className="metronome-btn-stroke" x1="16" y1="45" x2="27" y2="45" />
                        <path className="metronome-btn-stroke" d="M16 45L11 62H49L46 50" />
                        <circle className="metronome-btn-fill" cx="49" cy="45" r="2.4" />
                      </g>
                      <g ref={metronomeNeedleRef} className="metronome-btn-needle" transform="rotate(0 32 45)">
                        <line className="metronome-btn-stroke" x1="32" y1="45" x2="32" y2="11" />
                      </g>
                    </svg>
                  </span>
                </button>
                <button onClick={saveProject}>Save</button>
                <label className="bpm-field">
                  BPM
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={bpmInputValue}
                    onChange={handleBpmInputChange}
                    onFocus={handleBpmInputFocus}
                    onBlur={handleBpmInputBlur}
                    onKeyDown={handleBpmInputKeyDown}
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

          <section className={`tab-content ${showDawTopShell ? 'tab-content-edit' : ''}`}>
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
                      '--track-row-height': `${showTrackNodes ? 150 : 104}px`,
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
                      <div className="arrangement-structure-label-row" data-structure-menu-root="true">
                        <button
                          ref={structureMenuAnchorRef}
                          type="button"
                          className={`arrangement-structure-label-btn ${structureAddMenuOpen ? 'is-open' : ''}`}
                          onClick={() => setStructureAddMenuOpen((open) => !open)}
                          aria-expanded={structureAddMenuOpen}
                          aria-haspopup="menu"
                        >
                          Structure
                          <ChevronDown size={12} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className={`arrangement-structure-link-toggle${songStructure.playlist_link_enabled ? ' is-active' : ''}`}
                          data-structure-link-toggle="true"
                          aria-label={
                            songStructure.playlist_link_enabled
                              ? 'Structure mit Playlist verknüpft (klicken zum Trennen)'
                              : 'Structure mit Playlist verknüpfen'
                          }
                          aria-pressed={songStructure.playlist_link_enabled}
                          title={
                            songStructure.playlist_link_enabled
                              ? 'Verbunden: Sections verschieben mitzieht Clips. Klick zum Trennen.'
                              : 'Getrennt: Klicken, um Sections mit der Playlist zu verknüpfen.'
                          }
                          onPointerDown={(event) => {
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleStructurePlaylistLinkToggle();
                          }}
                        >
                          <span className="arrangement-structure-link-toggle-glyph" aria-hidden="true">
                            <span className="arrangement-structure-link-toggle-mask" />
                          </span>
                        </button>
                        <SongStructureAddMenu
                          anchorRef={structureMenuAnchorRef}
                          open={structureAddMenuOpen}
                          onClose={() => setStructureAddMenuOpen(false)}
                          onSaveAsNew={handleStructureSaveAsNew}
                          onExportJson={handleStructureExportJson}
                          onImportJson={handleStructureImportJson}
                          onCreateNew={handleStructureCreateNew}
                          onOpenTemplates={() => setStructureTemplateManagerOpen(true)}
                        />
                        <input
                          ref={structureImportInputRef}
                          type="file"
                          accept="application/json,.json"
                          className="sr-only"
                          tabIndex={-1}
                          aria-hidden="true"
                          onChange={handleStructureImportFile}
                        />
                      </div>
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
                          <button
                            type="button"
                            className="edit-tool-btn sync-btn"
                            title="Sync (synchronisiert Audio-Spuren; Konzept unter docs/sync button.md)"
                            aria-label="Sync"
                          >
                            <span className="sync-btn-glyph" aria-hidden="true">
                              <span className="sync-btn-line" />
                              <span className="sync-btn-label">SYNC</span>
                              <span className="sync-btn-line" />
                            </span>
                          </button>
                        </div>
                        <div className="arrangement-track-header-actions">
                          {multiSelectMode && selectedTrackIds.length > 0 ? (
                            <button
                              type="button"
                              className="arrangement-track-bulk-delete"
                              onClick={deleteSelectedTracks}
                              title={`${selectedTrackIds.length} markierte Tracks entfernen`}
                              aria-label={`${selectedTrackIds.length} markierte Tracks entfernen`}
                            >
                              <Trash2 size={12} strokeWidth={2} aria-hidden="true" />
                              <span className="arrangement-track-bulk-delete-count" aria-hidden="true">{selectedTrackIds.length}</span>
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div
                        ref={arrangementTrackRowsRef}
                        className="arrangement-track-rows"
                        onWheel={(event) => {
                          const scrollElement = arrangementScrollRef.current;
                          if (!scrollElement) {
                            return;
                          }
                          event.preventDefault();
                          if (event.shiftKey || Math.abs(event.deltaX) > 0) {
                            scrollElement.scrollLeft += event.deltaX || event.deltaY;
                            return;
                          }
                          scrollElement.scrollTop += event.deltaY;
                        }}
                      >
                        {arrangementTracks.map((track, trackIndex) => {
                          const scrollEl = arrangementScrollRef.current;
                          const rowHeightPx = showTrackNodes ? 150 : 104;
                          if (
                            scrollEl
                            && arrangementTracks.length > 24
                            && !trackRowIntersectsViewport(
                              trackIndex,
                              rowHeightPx,
                              scrollEl.scrollTop,
                              scrollEl.clientHeight,
                            )
                          ) {
                            return (
                              <div
                                key={`track_spacer_${track.track_id}`}
                                className="arrangement-track-row arrangement-track-row-spacer"
                                style={{ height: rowHeightPx, minHeight: rowHeightPx }}
                                aria-hidden="true"
                              />
                            );
                          }
                          const isChainEnabled = track.chain_enabled !== false;
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
                              className={`arrangement-track-row ${isSelected ? 'active' : ''} ${isHovered ? 'hovered' : ''} ${track.exists ? '' : 'placeholder'} ${track.mix?.mute ? 'track-muted' : ''} ${track.mix?.solo ? 'track-soloed' : ''} ${openTrackMenuId === track.track_id ? 'menu-open' : ''} ${openTrackPluginPicker && openTrackPluginPicker.scope === 'track' && openTrackPluginPicker.trackId === track.track_id ? 'picker-open' : ''} ${showTrackNodes ? 'track-chain-expanded' : 'track-chain-collapsed'} ${dropTargetTrackId === track.track_id ? 'drop-target' : ''} ${isReorderDropTarget ? 'track-reorder-drop-target' : ''} ${isReorderDragging ? 'track-reorder-dragging' : ''}`}
                              role="button"
                              tabIndex={0}
                              draggable
                              onPointerDownCapture={handleTrackRowPointerDownCapture}
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
                                setClipQuickToolMenu(null);
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
                                  <ArrangementTrackLevelMeter
                                    trackId={track.track_id}
                                    ariaLabel={`Track ${track.track_id} Pegel`}
                                  />
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
                                    className={`arrangement-track-add ${track.track_id === 1 ? 'primary' : ''}`}
                                    title={track.track_id === 1 ? 'Track 1: Record, Import oder neues Pattern + Clip' : `Track ${track.track_id}: Record, Import oder Pattern`}
                                    aria-label={`Track ${track.track_id} Aktionen`}
                                    aria-haspopup="menu"
                                    aria-expanded={openTrackMenuId === track.track_id}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setTrackContextMenu(null);
                                      setClipQuickToolMenu(null);
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
                                data-track-drag-ignore="true"
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                              >
                                <div className="arrangement-track-toggle-group">
                                  <button
                                    type="button"
                                    className={`arrangement-track-toggle mute-toggle ${track.mix.mute ? 'active' : ''}`}
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
                                    className={`arrangement-track-toggle solo-toggle ${track.mix.solo ? 'active' : ''}`}
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
                                      if (track.mix.record_armed) {
                                        setRecordArm(track.track_id, false);
                                      } else {
                                        openRecordArmMicSelection(track.track_id);
                                      }
                                    }}
                                  >
                                    R
                                  </button>
                                </div>
                                {(track.mix.record_armed && (track.mix.record_input_device_name || track.mix.record_input_device_id)) ? (
                                  <div className="arrangement-track-mic-label" title="Aufnahme-Mikrofon">
                                    Mikro: {track.mix.record_input_device_name || track.mix.record_input_device_id}
                                  </div>
                                ) : null}
                                <label className="arrangement-track-mini-field arrangement-track-mini-field-volume">
                                  <span>Vol</span>
                                  <input
                                    type="range"
                                    min={0}
                                    max={1.2}
                                    step={0.01}
                                    value={track.mix.volume}
                                    onPointerDown={(event) => {
                                      event.stopPropagation();
                                      beginMixLevelPointerDrag(
                                        'volume',
                                        track.track_id,
                                        normalizeVolumeValue(event.currentTarget.value),
                                      );
                                    }}
                                    onInput={(event) => handleMixVolumeSliderInput(track.track_id, event.target.value)}
                                    onClick={(event) => event.stopPropagation()}
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
                                        onPointerDown={(event) => {
                                          event.stopPropagation();
                                          beginMixLevelPointerDrag(
                                            'pan',
                                            track.track_id,
                                            normalizePanValue(event.currentTarget.value),
                                          );
                                        }}
                                        onInput={(event) => handleMixPanSliderInput(track.track_id, event.target.value)}
                                        onClick={(event) => event.stopPropagation()}
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
                                  className={`arrangement-track-chain ${isChainEnabled ? '' : 'chain-disabled'}`}
                                  onClick={(event) => event.stopPropagation()}
                                  onPointerDown={(event) => event.stopPropagation()}
                                >
                                  <div className="arrangement-track-chain-rail" data-track-plugin-picker-root="true">
                                    <div className="arrangement-track-chain-flow">
                                    {chainSlots.map(({ slotIndex, node }) => {
                                      const hasNode = Boolean(node);
                                      const isBypassed = Boolean(node?.bypassed);
                                      const pluginDisplayName = hasNode
                                        ? resolveNodePluginDisplayName(node, pluginNameByUid)
                                        : '';
                                      const pluginUiMeta = hasNode
                                        ? resolveTracktionPluginUiMeta(node?.plugin_uid, pluginDisplayName)
                                        : null;
                                      const SlotPluginIcon = pluginUiMeta?.icon || null;
                                      const slotLabel = hasNode
                                        ? `${slotIndex + 1} ${formatTrackChainPluginName(pluginDisplayName)}`
                                        : `${slotIndex + 1}`;
                                      const isPickerOpen = Boolean(
                                        openTrackPluginPicker
                                        && openTrackPluginPicker.scope === 'track'
                                        && openTrackPluginPicker.trackId === track.track_id
                                        && openTrackPluginPicker.slotIndex === slotIndex,
                                      );
                                      const slotTooltip = hasNode
                                        ? buildPluginHelpTooltip(pluginDisplayName, pluginUiMeta)
                                        : `Slot ${slotIndex + 1}: Plugin hinzufuegen`;
                                      return (
                                        <div
                                          key={`track_chain_${track.track_id}_${slotIndex}`}
                                          className="arrangement-track-chain-flow-segment"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            if (!hasNode) {
                                              openTrackChainModalSlotPluginPicker(track.track_id, slotIndex);
                                              return;
                                            }
                                            setInspector({ type: 'node', nodeId: node.id });
                                            openVstNodeEditor(node);
                                          }}
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
                                              title={slotTooltip}
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
                                                  openTrackChainModalSlotPluginPicker(track.track_id, slotIndex);
                                                  return;
                                                }
                                                setInspector({ type: 'node', nodeId: node.id });
                                                openVstNodeEditor(node);
                                              }}
                                            >
                                              <span className="arrangement-track-chain-slot-label compact">
                                                {hasNode && SlotPluginIcon ? (
                                                  <SlotPluginIcon size={10} strokeWidth={2} aria-hidden="true" />
                                                ) : null}
                                                <span>{slotLabel}</span>
                                              </span>
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
                                                  <Trash2 size={9} strokeWidth={2} aria-hidden="true" />
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
                                                {availableEffectPlugins.length === 0 ? (
                                                  <button
                                                    type="button"
                                                    className="arrangement-track-plugin-picker-item muted"
                                                    onClick={(event) => {
                                                      event.stopPropagation();
                                                      scanVstPlugins();
                                                    }}
                                                  >
                                                    {pluginScanPending ? 'Scanne Effekt-Plugins...' : 'Effekt-Plugins scannen'}
                                                  </button>
                                                ) : availableEffectPlugins.map((plugin) => {
                                                  const pluginUiMeta = resolveTracktionPluginUiMeta(plugin.uid, plugin.name);
                                                  const PluginIcon = pluginUiMeta?.icon || null;
                                                  const pluginTooltip = buildPluginHelpTooltip(plugin.name, pluginUiMeta);
                                                  return (
                                                  <button
                                                    key={`track_chain_picker_${track.track_id}_${slotIndex}_${plugin.uid}`}
                                                    type="button"
                                                    className="arrangement-track-plugin-picker-item"
                                                    title={pluginTooltip}
                                                    disabled={pluginLoadPending}
                                                    onClick={(event) => {
                                                      event.stopPropagation();
                                                      addVst({
                                                        trackId: track.track_id,
                                                        pluginUid: plugin.uid,
                                                        insertIndex: slotIndex,
                                                        slotKind: 'effect',
                                                        onSuccess: () => setOpenTrackPluginPicker(null),
                                                      });
                                                    }}
                                                  >
                                                    <span className="plugin-name-with-icon truncate">
                                                      {PluginIcon ? <PluginIcon size={12} strokeWidth={2} aria-hidden="true" /> : null}
                                                      <span>{plugin.name}</span>
                                                    </span>
                                                    <small>{plugin.type}</small>
                                                  </button>
                                                  );
                                                })}
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
                                          restoreFloatingWindow('trackChain');
                                        }}
                                      >
                                        <TrackChainOpenIcon />
                                      </button>
                                      <button
                                        type="button"
                                        className={`arrangement-track-chain-enable ${isChainEnabled ? 'enabled' : 'disabled'}`}
                                        title={isChainEnabled ? 'Effektkette aus (Leistung sparen)' : 'Effektkette ein'}
                                        aria-label={isChainEnabled ? 'Effektkette aus' : 'Effektkette ein'}
                                        onPointerDown={(event) => {
                                          event.stopPropagation();
                                          event.preventDefault();
                                          setTrackChainEnabled(track.track_id, !isChainEnabled);
                                        }}
                                      >
                                        <span className="arrangement-track-chain-enable-label">FX</span>
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
                              className={`arrangement-track-context-item ${item.id === 'delete' ? 'arrangement-track-context-item-delete' : ''}`}
                              aria-label={item.id === 'delete' ? 'Track entfernen' : item.label}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleTrackContextAction(contextMenuTrack, item.id);
                              }}
                            >
                              {item.id === 'delete' ? (
                                <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                              ) : item.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {clipQuickToolMenu ? (
                        <div
                          className="clip-quick-tools-menu"
                          role="menu"
                          aria-label={`Clip Tools Menue fuer Track ${clipQuickToolMenu.trackId}`}
                          data-clip-quick-tool-menu-root="true"
                          style={{
                            left: `${clipQuickToolMenu.x}px`,
                            top: `${clipQuickToolMenu.y}px`,
                          }}
                        >
                          {CLIP_QUICK_TOOL_MENU_ITEMS.map((item) => (
                            (() => {
                              const ItemIcon = item.icon;
                              return (
                                <button
                                  key={`clip_quick_menu_${clipQuickToolMenu.trackId}_${clipQuickToolMenu.clipId}_${item.id}`}
                                  type="button"
                                  role="menuitem"
                                  className="clip-quick-tools-menu-item"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleClipQuickToolAction(clipQuickToolMenu, item.id);
                                  }}
                                >
                                  <span className="clip-quick-tools-menu-item-icon" aria-hidden="true">
                                    <ItemIcon size={15} strokeWidth={2} />
                                  </span>
                                  <span className="clip-quick-tools-menu-item-label">{item.label}</span>
                                </button>
                              );
                            })()
                          ))}
                        </div>
                      ) : null}
                      {clipRenameColorPrompt ? (
                        <div
                          className="clip-rename-color-popover"
                          role="dialog"
                          aria-modal="false"
                          aria-label={`Rename and Color fuer Clip ${clipRenameColorPrompt.clipId}`}
                          data-clip-rename-color-root="true"
                          style={{
                            left: `${clipRenameColorPrompt.x}px`,
                            top: `${clipRenameColorPrompt.y}px`,
                          }}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <div className="clip-rename-color-popover-head">
                            <div className="clip-rename-color-popover-title">
                              <Pencil size={12} strokeWidth={2} aria-hidden="true" />
                              <span>Rename and Color</span>
                            </div>
                            <button
                              type="button"
                              className="clip-rename-color-popover-close"
                              onClick={closeClipRenameColorPrompt}
                              aria-label="Schliessen"
                              title="Schliessen"
                            >
                              <X size={12} strokeWidth={2} aria-hidden="true" />
                            </button>
                          </div>
                          <form
                            className="clip-rename-color-popover-body"
                            onSubmit={(event) => {
                              event.preventDefault();
                              submitClipRenameColorPrompt();
                            }}
                          >
                            <label className="clip-rename-color-field">
                              <span>Name</span>
                              <input
                                ref={clipRenameColorNameInputRef}
                                type="text"
                                value={clipRenameColorPrompt.nameValue}
                                maxLength={255}
                                placeholder={clipRenameColorPrompt.clipLabel || 'Clip name'}
                                onChange={(event) => {
                                  updateClipRenameColorPrompt({ nameValue: event.target.value });
                                }}
                              />
                            </label>
                            <div className="clip-rename-color-field">
                              <span>
                                <PaintBucket size={11} strokeWidth={2} aria-hidden="true" />
                                Farbe
                              </span>
                              <div className="clip-rename-color-swatches">
                                {CLIP_RENAME_COLOR_SWATCHES.map((swatch) => {
                                  const isActive = (clipRenameColorPrompt.colorValue || '') === (swatch.color || '');
                                  return (
                                    <button
                                      key={`clip_rename_color_${swatch.id}`}
                                      type="button"
                                      className={`clip-rename-color-swatch ${isActive ? 'active' : ''} ${swatch.color ? '' : 'is-default'}`}
                                      onClick={() => {
                                        updateClipRenameColorPrompt({ colorValue: swatch.color || '' });
                                      }}
                                      aria-label={swatch.label}
                                      title={swatch.label}
                                      style={swatch.color ? { '--swatch-color': swatch.color } : undefined}
                                    >
                                      {!swatch.color ? <span>Auto</span> : null}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                            <label className="clip-rename-color-field">
                              <span>Hex</span>
                              <input
                                type="text"
                                value={clipRenameColorPrompt.colorValue || ''}
                                maxLength={7}
                                placeholder="#60a5fa"
                                onChange={(event) => {
                                  updateClipRenameColorPrompt({ colorValue: event.target.value });
                                }}
                              />
                            </label>
                            <div className="clip-rename-color-actions">
                              <button
                                type="button"
                                className="clip-rename-color-btn"
                                onClick={closeClipRenameColorPrompt}
                              >
                                Abbrechen
                              </button>
                              <button
                                type="submit"
                                className="clip-rename-color-btn primary"
                              >
                                Ok
                              </button>
                            </div>
                          </form>
                        </div>
                      ) : null}
                      {clipAnalyzeResultModal ? (
                        <div
                          className="clip-analyze-result-modal-overlay"
                          role="presentation"
                          onPointerDown={() => {
                            setClipAnalyzeResultModal(null);
                          }}
                        >
                          <div
                            className="clip-analyze-result-modal"
                            role="dialog"
                            aria-modal="true"
                            aria-label={`Analyse-Ergebnis fuer Clip ${clipAnalyzeResultModal.clipId}`}
                            data-clip-analyze-result-root="true"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <div className="clip-analyze-result-modal-head">
                              <div className="clip-analyze-result-modal-title">
                                <Gauge size={14} strokeWidth={2} aria-hidden="true" />
                                <span>Analyze BPM & Key</span>
                              </div>
                              <button
                                type="button"
                                className="clip-analyze-result-modal-close"
                                onClick={() => setClipAnalyzeResultModal(null)}
                                aria-label="Schliessen"
                                title="Schliessen"
                              >
                                <X size={14} strokeWidth={2} aria-hidden="true" />
                              </button>
                            </div>
                            <div className="clip-analyze-result-modal-body">
                              <div className="clip-analyze-result-modal-clip">
                                {clipAnalyzeResultModal.clipLabel || `Clip ${clipAnalyzeResultModal.clipId}`}
                                <small>{`Track ${clipAnalyzeResultModal.trackId}`}</small>
                              </div>
                              <div className="clip-analyze-result-grid">
                                <div className="clip-analyze-result-cell">
                                  <span className="label">BPM</span>
                                  <strong>{clipAnalyzeResultModal.bpm != null ? clipAnalyzeResultModal.bpm.toFixed(1) : '—'}</strong>
                                  <small>{clipAnalyzeResultModal.methodBpm || 'unknown'}</small>
                                </div>
                                <div className="clip-analyze-result-cell">
                                  <span className="label">Key</span>
                                  <strong>{clipAnalyzeResultModal.key || '—'}</strong>
                                  <small>{clipAnalyzeResultModal.methodKey || 'unknown'}</small>
                                </div>
                              </div>
                              <div className="clip-analyze-result-modal-actions">
                                <button
                                  type="button"
                                  className="clip-analyze-result-btn"
                                  onClick={() => setClipAnalyzeResultModal(null)}
                                >
                                  Schliessen
                                </button>
                                <button
                                  type="button"
                                  className="clip-analyze-result-btn primary"
                                  disabled={clipAnalyzeResultModal.bpm == null}
                                  onClick={() => {
                                    if (clipAnalyzeResultModal.bpm == null) {
                                      return;
                                    }
                                    applyProjectBpm(clipAnalyzeResultModal.bpm, {
                                      sourceLabel: `Clip-Analyse (${clipAnalyzeResultModal.clipLabel || clipAnalyzeResultModal.clipId})`,
                                    });
                                    setClipAnalyzeResultModal(null);
                                  }}
                                >
                                  BPM uebernehmen
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </section>

                    <section className="arrangement-canvas">
                      <div
                        ref={arrangementScrollRef}
                        className="arrangement-scroll"
                        onWheel={handleArrangementWheel}
                      >
                        <SongStructureLane
                          nodes={songStructure.nodes}
                          barWidth={barWidth}
                          snapStep={snapStep}
                          timelineWidth={timelineWidth}
                          readOnly={false}
                          playlistLinkTintSegments={structurePlaylistTintSegments}
                          selectedNodeId={selectedStructureNodeId}
                          onSelectStructureNode={handleStructureLaneSelectNode}
                          onResize={handleStructureResize}
                          onAddAtBoundary={handleStructureAddAtBoundary}
                          onReorder={handleStructureReorder}
                          onPlayheadPointerDown={beginPlayheadScrub}
                          onStructureKeyboardDelete={handleStructureKeyboardDeleteRequest}
                          onNodeClick={handleStructureNodeModalOpen}
                        />

                        <div
                          className="timeline-ruler"
                          style={{ width: `${timelineWidth}px`, minWidth: '100%' }}
                          onPointerDown={beginPlayheadScrub}
                        >
                          {structurePlaylistTintSegments.length > 0 ? (
                            <div
                              className="arrangement-structure-playlist-tint arrangement-structure-playlist-tint--ruler"
                              aria-hidden="true"
                            >
                              {structurePlaylistTintSegments.map((seg) => (
                                <div
                                  key={`struct_tint_ruler_${seg.id}`}
                                  className="arrangement-structure-playlist-tint-strip"
                                  style={{
                                    left: `${seg.leftPx}px`,
                                    width: `${seg.widthPx}px`,
                                    background: `linear-gradient(180deg, rgba(${seg.rgb}, 0.26), rgba(${seg.rgb}, 0.07))`,
                                  }}
                                />
                              ))}
                            </div>
                          ) : null}
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
                                const bars = snapToGrid(context.bars, snapStep);
                                setSlicePreviewBars(bars);
                                const gridEl = arrangementGridRef.current;
                                const scrollEl = arrangementScrollRef.current;
                                if (gridEl && scrollEl && Number.isFinite(bars)) {
                                  const gridRect = gridEl.getBoundingClientRect();
                                  const scrollLeft = scrollEl.scrollLeft || 0;
                                  const lineLeftPx = gridRect.left + (bars * barWidth) - scrollLeft;
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
                          {structurePlaylistTintSegments.length > 0 ? (
                            <div
                              className="arrangement-structure-playlist-tint arrangement-structure-playlist-tint--grid"
                              aria-hidden="true"
                            >
                              {structurePlaylistTintSegments.map((seg) => (
                                <div
                                  key={`struct_tint_grid_${seg.id}`}
                                  className="arrangement-structure-playlist-tint-strip"
                                  style={{
                                    left: `${seg.leftPx}px`,
                                    width: `${seg.widthPx}px`,
                                    background: `linear-gradient(180deg, rgba(${seg.rgb}, 0.11), rgba(${seg.rgb}, 0.2))`,
                                  }}
                                />
                              ))}
                            </div>
                          ) : null}
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
                            const clipsRaw = Array.isArray(track.clips) ? track.clips : [];
                            const moveDraft =
                              clipInteraction?.mode === 'move' && clipInteraction?.clipId
                                ? clipDrafts?.[clipInteraction.clipId]
                                : null;
                            const crossMoveActive =
                              Boolean(moveDraft)
                              && Number(moveDraft.trackId) !== Number(clipInteraction?.trackId);
                            const sourceClipCross =
                              crossMoveActive && clipInteraction?.trackId != null && clipInteraction?.clipId
                                ? (() => {
                                  const st = arrangementTracks.find(
                                    (t) => Number(t.track_id) === Number(clipInteraction.trackId),
                                  );
                                  const arr = Array.isArray(st?.clips) ? st.clips : [];
                                  return arr.find((c) => String(c?.id) === String(clipInteraction.clipId)) ?? null;
                                })()
                                : null;
                            let clips = clipsRaw;
                            if (crossMoveActive && sourceClipCross) {
                              if (Number(track.track_id) === Number(clipInteraction.trackId)) {
                                clips = clipsRaw.filter((c) => String(c?.id) !== String(clipInteraction.clipId));
                              } else if (Number(track.track_id) === Number(moveDraft.trackId)) {
                                clips = [...clipsRaw, sourceClipCross];
                              }
                            }
                            const isSelected = multiSelectMode
                              ? selectedTrackIdSet.has(track.track_id)
                              : selectedTrackId === track.track_id;
                            const isHovered = hoveredTrackId === track.track_id;
                            return (
                              <div
                                key={`lane_${track.track_id}`}
                                className={`arrangement-grid-row ${isSelected ? 'active' : ''} ${isHovered ? 'hovered' : ''} ${track.mix?.mute ? 'track-muted' : ''} ${track.mix?.solo ? 'track-soloed' : ''} ${showTrackNodes ? 'track-chain-expanded' : 'track-chain-collapsed'} ${dropTargetTrackId === track.track_id ? 'drop-target' : ''}`}
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
                                {(() => {
                                  const arrangementClipBpm = Number(state?.project?.bpm) || 128;
                                  const clipsInView = clips.filter((clip) => {
                                    const rendered = getRenderedClip(track.track_id, clip);
                                    return clipIntersectsViewport(
                                      {
                                        start: Number(rendered?.start) || 0,
                                        length: Number(rendered?.length) || 1,
                                      },
                                      arrangementVisibleBars.start,
                                      arrangementVisibleBars.end,
                                    );
                                  });
                                  return clipsInView.map((clip) => {
                                  const renderedClip = getRenderedClip(track.track_id, clip);
                                  const patternId = getPatternId(renderedClip);
                                  const clipLabel = getClipDisplayLabel(renderedClip);
                                  const clipType = normalizeClipType(renderedClip?.type);
                                  const clipStart = Number(renderedClip.start) || 0;
                                  const clipLength = Number(renderedClip.length) || 1;
                                  const clipLeft = clipStart * barWidth;
                                  const clipWidth = Math.max(14, clipLength * barWidth);
                                  {
                                    const dbg = splitDebugSessionRef.current;
                                    const dbgActive = clipType === 'audio'
                                      && dbg.until > Date.now()
                                      && dbg.trackId != null
                                      && Number(dbg.trackId) === Number(track.track_id)
                                      && dbg.clipIds
                                      && (dbg.clipIds.has(String(clip.id)) || dbg.clipIds.has(String(renderedClip?.id)));
                                    if (dbgActive) {
                                      const clipKeyDbg = getClipSelectionKey(track.track_id, clip.id);
                                      console.log('[RENDER_CLIP_POSITION]', {
                                        trackId: track.track_id,
                                        sourceClip: {
                                          id: clip?.id,
                                          start: clip?.start,
                                          length: clip?.length,
                                          trim_start_seconds: clip?.trim_start_seconds,
                                        },
                                        renderedClip: {
                                          id: renderedClip?.id,
                                          start: renderedClip?.start,
                                          length: renderedClip?.length,
                                          trim_start_seconds: renderedClip?.trim_start_seconds,
                                        },
                                        displayOverride: clipDisplayOverrides?.[clipKeyDbg] || null,
                                        draft: clipDrafts?.[clip.id] || null,
                                        barWidth,
                                        clipLeft,
                                        clipWidth,
                                      });
                                    }
                                  }
                                  const clipKey = getClipSelectionKey(track.track_id, clip.id);
                                  const isClipSelected = selectedClipKeySet.has(clipKey);
                                  const isClipMuted = clipMuteOverrides[clipKey] === true || renderedClip?.muted === true;
                                  const slipPreviewBars = Number(clipSlipPreviewBars[clipKey]) || 0;
                                  const slipPreviewPx = Number((slipPreviewBars * barWidth).toFixed(3));
                                  const showSlipBadge = Math.abs(slipPreviewBars) >= 0.02;
                                  const slipLabel = `${slipPreviewBars >= 0 ? '+' : ''}${slipPreviewBars.toFixed(2)}`;
                                  const clipCustomColor = normalizeClipCustomColor(renderedClip?.color);
                                  const clipAccentRgb = hexToRgbChannels(clipCustomColor);
                                  const clipAnalyzedBpmValue = Number(renderedClip?.bpm);
                                  const clipAnalyzedBpm = Number.isFinite(clipAnalyzedBpmValue) && clipAnalyzedBpmValue > 0
                                    ? Number(clipAnalyzedBpmValue.toFixed(1))
                                    : null;
                                  const clipAnalyzedKey = isNonEmptyString(renderedClip?.key)
                                    ? renderedClip.key.trim()
                                    : '';
                                  const rawPeaks = clipType === 'audio' ? getClipWaveformPeaks(renderedClip) : [];
                                  const windowedPeaks = clipType === 'audio' && rawPeaks.length > 0
                                    ? getVisibleWaveformPeaks(renderedClip, { bpm: arrangementClipBpm, timeSignature })
                                    : [];
                                  const peaksForAdaptive = clipType === 'audio'
                                    ? (windowedPeaks.length > 0 ? windowedPeaks : (rawPeaks.length > 0 ? rawPeaks : PLACEHOLDER_WAVEFORM_PEAKS))
                                    : [];
                                  const { fadeIn: clipFadeInSec, fadeOut: clipFadeOutSec } = clipType === 'audio'
                                    ? getClipFadeDisplayValues(renderedClip, fadeDraftByKey, clipKey)
                                    : { fadeIn: 0, fadeOut: 0 };
                                  const clipFadeInPx = clipType === 'audio'
                                    ? fadeSecondsToWidthPx(clipFadeInSec, barWidth, arrangementClipBpm, timeSignature)
                                    : 0;
                                  const clipFadeOutPx = clipType === 'audio'
                                    ? fadeSecondsToWidthPx(clipFadeOutSec, barWidth, arrangementClipBpm, timeSignature)
                                    : 0;
                                  const { fadeInCurve: clipFadeInCurve, fadeOutCurve: clipFadeOutCurve } = clipType === 'audio'
                                    ? getClipFadeCurves(renderedClip, fadeDraftByKey, clipKey)
                                    : { fadeInCurve: 'linear', fadeOutCurve: 'linear' };
                                  const waveformPeaksRaw = clipType === 'audio'
                                    ? getAdaptiveWaveformPeaks(peaksForAdaptive, clipWidth)
                                    : [];
                                  const waveformPeaks = clipType === 'audio' && waveformPeaksRaw.length > 0
                                    ? applyFadeEnvelopeToPeaks(
                                      waveformPeaksRaw,
                                      clipFadeInPx,
                                      clipFadeOutPx,
                                      clipWidth,
                                      clipFadeInCurve,
                                      clipFadeOutCurve,
                                    )
                                    : waveformPeaksRaw;
                                  const clipGainValue = clipType === 'audio'
                                    ? getClipGainDisplayValue(renderedClip, gainDraftByKey, clipKey)
                                    : CLIP_GAIN_DEFAULT;
                                  const isGainDragging = clipType === 'audio' && Object.prototype.hasOwnProperty.call(gainDraftByKey, clipKey);
                                  const waveformPolygonPoints = waveformPeaks.length > 0
                                    ? getWaveformPolygonPoints(waveformPeaks, clipGainValue)
                                    : '';
                                  const showFadeInUi = clipFadeInPx >= FADE_VISIBLE_MIN_PX;
                                  const showFadeOutUi = clipFadeOutPx >= FADE_VISIBLE_MIN_PX;
                                  const clipFadeInPath = showFadeInUi
                                    ? buildFadeCurvePathD('in', clipFadeInPx, clipWidth, clipFadeInCurve)
                                    : '';
                                  const clipFadeOutPath = showFadeOutUi
                                    ? buildFadeCurvePathD('out', clipFadeOutPx, clipWidth, clipFadeOutCurve)
                                    : '';
                                  const clipFadeInCurveNode = clipType === 'audio'
                                    ? getFadeCurveNodePosition('in', clipFadeInPx, clipWidth, clipFadeInCurve)
                                    : null;
                                  const clipFadeOutCurveNode = clipType === 'audio'
                                    ? getFadeCurveNodePosition('out', clipFadeOutPx, clipWidth, clipFadeOutCurve)
                                    : null;
                                  const clipGainDbLabel = clipType === 'audio'
                                    ? formatClipGainDb(clipGainValue)
                                    : '';
                                  const audioMissingFile = clipType === 'audio' && !(renderedClip?.source_path || renderedClip?.sourcePath);

                                  return (
                                    <div
                                      key={clip.id}
                                      className={`timeline-clip ${clipType ? `clip-type-${clipType}` : ''} ${audioMissingFile ? 'clip-missing-file' : ''} ${isClipSelected ? 'clip-selected' : ''} ${isClipMuted ? 'clip-muted' : ''} ${isGainDragging ? 'clip-gain-dragging' : ''} ${clipAccentRgb ? 'has-custom-color' : ''}`}
                                      style={{
                                        left: `${clipLeft}px`,
                                        width: `${clipWidth}px`,
                                        '--clip-slip-shift-px': `${slipPreviewPx}px`,
                                        ...(clipCustomColor ? { '--clip-accent': clipCustomColor } : {}),
                                        ...(clipAccentRgb ? { '--clip-accent-rgb': clipAccentRgb } : {}),
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
                                      <div
                                        className="clip-corner-tools"
                                        data-clip-quick-tool-menu-root="true"
                                        onPointerDown={(event) => event.stopPropagation()}
                                        onClick={(event) => event.stopPropagation()}
                                      >
                                        <button
                                          type="button"
                                          className="clip-corner-button danger"
                                          onPointerDown={(event) => event.stopPropagation()}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            setClipQuickToolMenu(null);
                                            emitMutation('clip:delete', { trackId: track.track_id, clipId: String(clip.id) });
                                          }}
                                          aria-label="Clip entfernen"
                                          title="Clip entfernen"
                                        >
                                          <Trash2 size={10} strokeWidth={2} aria-hidden="true" />
                                        </button>
                                        <button
                                          type="button"
                                          className={`clip-corner-button ${clipQuickToolMenu && clipQuickToolMenu.trackId === track.track_id && String(clipQuickToolMenu.clipId) === String(clip.id) ? 'active' : ''}`}
                                          onPointerDown={(event) => event.stopPropagation()}
                                          onClick={(event) => {
                                            openClipQuickToolMenu(event, {
                                              trackId: track.track_id,
                                              clipId: clip.id,
                                              clipType,
                                              clipLabel,
                                              clipName: typeof renderedClip?.name === 'string' ? renderedClip.name : '',
                                              clipColor: clipCustomColor || '',
                                            });
                                          }}
                                          aria-label="Clip Tools"
                                          title="Clip Tools"
                                          aria-haspopup="menu"
                                          aria-expanded={Boolean(
                                            clipQuickToolMenu
                                            && clipQuickToolMenu.trackId === track.track_id
                                            && String(clipQuickToolMenu.clipId) === String(clip.id)
                                          )}
                                        >
                                          <ChevronDown size={10} strokeWidth={2} aria-hidden="true" />
                                        </button>
                                      </div>
                                      {clipType === 'audio' ? (
                                        <>
                                          <div className="timeline-clip-label-bar">
                                            <span className="timeline-clip-label" title={clipLabel}>{clipLabel}</span>
                                            {showSlipBadge ? (
                                              <span className="timeline-clip-slip-badge" title={`Slip: ${slipLabel} Bars`}>
                                                {slipLabel}
                                              </span>
                                            ) : null}
                                            {clipAnalyzedBpm != null ? (
                                              <span className="timeline-clip-analysis-badge bpm" title={`Detected Tempo: ${clipAnalyzedBpm.toFixed(1)} BPM`}>
                                                {clipAnalyzedBpm.toFixed(1)} BPM
                                              </span>
                                            ) : null}
                                            {clipAnalyzedKey ? (
                                              <span className="timeline-clip-analysis-badge key" title={`Detected Key: ${clipAnalyzedKey}`}>
                                                {clipAnalyzedKey}
                                              </span>
                                            ) : null}
                                            {audioMissingFile ? (
                                              <span className="timeline-clip-missing-badge" title="Datei fehlt – kein Abspielen">!</span>
                                            ) : null}
                                          </div>
                                          <div className="timeline-clip-waveform-wrap">
                                            <div
                                              className="clip-resize-handle clip-resize-handle-left"
                                              onPointerDown={(event) => {
                                                handleClipResizePointerDown(event, track.track_id, renderedClip, 'start');
                                              }}
                                            />
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
                                            {(showFadeInUi || showFadeOutUi) ? (
                                              <div className="clip-fade-curves" aria-hidden="true">
                                                <svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
                                                  {clipFadeInPath ? (
                                                    <path className="clip-fade-curve clip-fade-curve-in" d={clipFadeInPath} />
                                                  ) : null}
                                                  {clipFadeOutPath ? (
                                                    <path className="clip-fade-curve clip-fade-curve-out" d={clipFadeOutPath} />
                                                  ) : null}
                                                </svg>
                                              </div>
                                            ) : null}
                                            {showFadeInUi ? (
                                              <div
                                                className="clip-fade-overlay clip-fade-overlay-in"
                                                style={{ width: `${clipFadeInPx}px` }}
                                                aria-hidden="true"
                                              />
                                            ) : null}
                                            {showFadeOutUi ? (
                                              <div
                                                className="clip-fade-overlay clip-fade-overlay-out"
                                                style={{ width: `${clipFadeOutPx}px` }}
                                                aria-hidden="true"
                                              />
                                            ) : null}
                                            <div
                                              className="clip-fade-in-handle"
                                              style={{ left: `${Math.max(0, clipFadeInPx)}px` }}
                                              title="Fade In length — drag horizontally"
                                              onPointerDown={(event) => {
                                                event.stopPropagation();
                                                beginFadeHandleInteraction('in', 'length', event, track.track_id, renderedClip);
                                              }}
                                            />
                                            <div
                                              className="clip-fade-out-handle"
                                              style={{ left: `${Math.max(0, clipWidth - Math.max(0, clipFadeOutPx))}px` }}
                                              title="Fade Out length — drag horizontally"
                                              onPointerDown={(event) => {
                                                event.stopPropagation();
                                                beginFadeHandleInteraction('out', 'length', event, track.track_id, renderedClip);
                                              }}
                                            />
                                            {clipFadeInCurveNode ? (
                                              <div
                                                className="clip-fade-in-curve-handle"
                                                style={{
                                                  left: `${clipFadeInCurveNode.leftPercent}%`,
                                                  top: `${clipFadeInCurveNode.topPercent}%`,
                                                }}
                                                title="Fade In curve — drag vertically"
                                                onPointerDown={(event) => {
                                                  event.stopPropagation();
                                                  beginFadeHandleInteraction('in', 'curve', event, track.track_id, renderedClip);
                                                }}
                                              />
                                            ) : null}
                                            {clipFadeOutCurveNode ? (
                                              <div
                                                className="clip-fade-out-curve-handle"
                                                style={{
                                                  left: `${clipFadeOutCurveNode.leftPercent}%`,
                                                  top: `${clipFadeOutCurveNode.topPercent}%`,
                                                }}
                                                title="Fade Out curve — drag vertically"
                                                onPointerDown={(event) => {
                                                  event.stopPropagation();
                                                  beginFadeHandleInteraction('out', 'curve', event, track.track_id, renderedClip);
                                                }}
                                              />
                                            ) : null}
                                            <div
                                              className="clip-resize-handle clip-resize-handle-right"
                                              onPointerDown={(event) => {
                                                handleClipResizePointerDown(event, track.track_id, renderedClip, 'end');
                                              }}
                                            />
                                          </div>
                                          <div
                                            className="clip-gain-handle"
                                            title={`Gain: ${clipGainDbLabel} — drag vertically`}
                                            aria-label={`Clip gain ${clipGainDbLabel}`}
                                            onPointerDown={(event) => {
                                              event.stopPropagation();
                                              if (editTool === 'select') {
                                                beginClipGainInteraction(event, track.track_id, renderedClip);
                                              }
                                            }}
                                          />
                                          <span className="clip-gain-readout" aria-live="polite">
                                            {clipGainDbLabel}
                                          </span>
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
                                          <div
                                            className="clip-resize-handle clip-resize-handle-right"
                                            onPointerDown={(event) => {
                                              handleClipResizePointerDown(event, track.track_id, renderedClip, 'end');
                                            }}
                                          />
                                        </>
                                      )}
                                    </div>
                                  );
                                });
                                })()}
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
                  {trackChainModalTrack && !isFloatingWindowMinimized('trackChain') ? (
                    <div
                      className="track-chain-modal-overlay floating-window-overlay"
                      role="presentation"
                      style={getFloatingWindowLayerStyle('trackChain')}
                    >
                      <div
                        className="track-chain-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-label={`Track ${trackChainModalTrack.track_id} Node-Kette`}
                        style={getFloatingWindowShellStyle('trackChain')}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          activateFloatingWindow('trackChain');
                        }}
                      >
                        <div
                          className="track-chain-modal-head"
                          onPointerDown={(event) => beginModalDrag('trackChain', event)}
                        >
                          <h2>{`${trackChainModalTrack.name} · Node Chain`}</h2>
                          <div className="settings-modal-window-controls">
                            <button
                              type="button"
                              className="settings-modal-window-btn"
                              onClick={() => minimizeFloatingWindow('trackChain')}
                              aria-label="Minimieren"
                              title="Minimieren"
                            >
                              <Minus size={14} strokeWidth={2} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="settings-modal-window-btn"
                              onClick={() => toggleFloatingWindowMaximize('trackChain')}
                              aria-label={getFloatingWindowLayout('trackChain').maximized ? 'Wiederherstellen' : 'Maximieren'}
                              title={getFloatingWindowLayout('trackChain').maximized ? 'Wiederherstellen' : 'Maximieren'}
                            >
                              {getFloatingWindowLayout('trackChain').maximized
                                ? <Square size={12} strokeWidth={2} aria-hidden="true" />
                                : <LayoutGrid size={14} strokeWidth={2} aria-hidden="true" />}
                            </button>
                            <button
                              type="button"
                              className="track-chain-modal-close settings-modal-close"
                              onClick={() => closeFloatingWindow('trackChain')}
                              aria-label="Schliessen"
                              title="Schliessen"
                            >
                              <X size={14} strokeWidth={2} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                        <div className="track-chain-modal-canvas" data-track-plugin-picker-root="true">
                          <div className="track-chain-modal-flow">
                            {trackChainModalSlots.map(({ slotIndex, node }) => {
                              const hasNode = Boolean(node);
                              const bypassed = Boolean(node?.bypassed);
                              const pluginDisplayName = hasNode
                                ? resolveNodePluginDisplayName(node, pluginNameByUid)
                                : 'Leerer Slot';
                              const pluginUiMeta = hasNode
                                ? resolveTracktionPluginUiMeta(node?.plugin_uid, pluginDisplayName)
                                : null;
                              const SlotPluginIcon = pluginUiMeta?.icon || null;
                              const hasPreviewThumb = Boolean(hasNode && pluginUiMeta?.previewSrc);
                              const slotTooltip = hasNode
                                ? buildPluginHelpTooltip(pluginDisplayName, pluginUiMeta)
                                : `Slot ${slotIndex + 1}: Plugin hinzufuegen`;
                              const isPickerTarget = Boolean(
                                trackChainModalPluginPickerOpen
                                && openTrackPluginPicker?.slotIndex === slotIndex,
                              );
                              return (
                                <div
                                  key={`track_chain_modal_slot_${trackChainModalTrack.track_id}_${slotIndex}`}
                                  className="track-chain-modal-flow-segment"
                                >
                                  <div
                                    className={`track-chain-modal-slot-shell ${hasNode ? 'filled' : 'empty'} ${bypassed ? 'bypassed' : ''} ${isPickerTarget ? 'picker-target' : ''}`}
                                  >
                                    <span className="track-chain-modal-slot-number">{slotIndex + 1}</span>
                                    <div
                                      className={`track-chain-modal-slot ${hasNode ? 'filled' : 'empty'} ${bypassed ? 'bypassed' : ''}`}
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
                                      <button
                                        type="button"
                                        className="track-chain-modal-slot-main"
                                        draggable={hasNode}
                                        title={slotTooltip}
                                        aria-label={hasNode ? `${pluginDisplayName} Plugin oeffnen` : `Slot ${slotIndex + 1} Effekt hinzufuegen`}
                                        onDragStart={(event) => {
                                          if (!hasNode) {
                                            return;
                                          }
                                          event.dataTransfer.effectAllowed = 'move';
                                          event.dataTransfer.setData('text/plain', String(slotIndex));
                                        }}
                                        onClick={() => {
                                          if (!hasNode) {
                                            openTrackSlotPluginPicker(trackChainModalTrack.track_id, slotIndex, 'modal');
                                            return;
                                          }
                                          setInspector({ type: 'node', nodeId: node.id });
                                          openVstNodeEditor(node);
                                        }}
                                      >
                                        {hasPreviewThumb ? (
                                          <span className="track-chain-modal-slot-preview" aria-hidden="true">
                                            <span className="track-chain-modal-slot-preview-frame">
                                              <img
                                                src={pluginUiMeta.previewSrc}
                                                alt=""
                                                width={pluginUiMeta.previewWidth || TRACKTION_PLUGIN_PREVIEW_DIMENSIONS.width}
                                                height={pluginUiMeta.previewHeight || TRACKTION_PLUGIN_PREVIEW_DIMENSIONS.height}
                                                className="track-chain-modal-slot-preview-image"
                                                loading="lazy"
                                                decoding="async"
                                                data-fallback-src={pluginUiMeta.fallbackPreviewSrc || ''}
                                                onError={(event) => {
                                                  const imgEl = event.currentTarget;
                                                  const fallbackSrc = imgEl.dataset.fallbackSrc || '';
                                                  if (fallbackSrc && imgEl.dataset.fallbackApplied !== '1') {
                                                    imgEl.dataset.fallbackApplied = '1';
                                                    imgEl.src = fallbackSrc;
                                                    return;
                                                  }
                                                  imgEl.onerror = null;
                                                }}
                                              />
                                            </span>
                                          </span>
                                        ) : (
                                          <span className="track-chain-modal-slot-label">
                                            {hasNode ? (
                                              <span className="plugin-name-with-icon truncate">
                                                {SlotPluginIcon ? <SlotPluginIcon size={12} strokeWidth={2} aria-hidden="true" /> : null}
                                                <span>{formatTrackChainPluginName(pluginDisplayName)}</span>
                                              </span>
                                            ) : 'add Effect'}
                                          </span>
                                        )}
                                      </button>
                                      {hasNode ? (
                                        <div className="track-chain-modal-slot-tools">
                                          <button
                                            type="button"
                                            className={`arrangement-track-chain-slot-bypass ${bypassed ? 'active' : ''}`}
                                            title={bypassed ? 'Bypass deaktivieren' : 'Bypass aktivieren'}
                                            onClick={() => setVstNodeBypassed(node, !bypassed)}
                                          >
                                            <TrackChainBypassIcon active={bypassed} />
                                          </button>
                                          <button
                                            type="button"
                                            className="arrangement-track-chain-slot-remove"
                                            title="Plugin entfernen"
                                            aria-label="Plugin entfernen"
                                            onClick={() => removeVstNode(node)}
                                          >
                                            <Trash2 size={11} strokeWidth={2} aria-hidden="true" />
                                          </button>
                                        </div>
                                      ) : null}
                                    </div>
                                    <div className="track-chain-modal-slot-meta">
                                      <strong>{`Slot ${slotIndex + 1}`}</strong>
                                      <span title={slotTooltip}>{hasNode ? pluginDisplayName : 'Klick zum Hinzufuegen'}</span>
                                    </div>
                                  </div>
                                  {slotIndex < trackChainModalSlots.length - 1 ? (
                                    <span className="track-chain-modal-connector" aria-hidden="true">
                                      <TrackChainArrowIcon />
                                    </span>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div className="track-chain-modal-footer" data-track-plugin-picker-root="true">
                          <div className="track-chain-modal-footer-row">
                            <span className="track-chain-modal-footer-hint">
                              {trackChainModalPluginPickerOpen
                                ? `Slot ${Number(openTrackPluginPicker?.slotIndex ?? 0) + 1}: Plugin auswaehlen`
                                : 'Leeren Slot klicken, um ein Plugin hinzuzufuegen'}
                            </span>
                          </div>
                          {trackChainModalPluginPickerOpen ? (
                            <div
                              className="arrangement-track-plugin-picker modal"
                              role="menu"
                              aria-label={`Track ${trackChainModalTrack.track_id} Plugin-Auswahl`}
                              data-track-plugin-picker-root="true"
                            >
                              {availableEffectPlugins.length === 0 ? (
                                <button
                                  type="button"
                                  className="arrangement-track-plugin-picker-item muted"
                                  onClick={() => scanVstPlugins()}
                                >
                                  {pluginScanPending ? 'Scanne Effekt-Plugins...' : 'Effekt-Plugins scannen'}
                                </button>
                              ) : availableEffectPlugins.map((plugin) => {
                                const pluginUiMeta = resolveTracktionPluginUiMeta(plugin.uid, plugin.name);
                                const PluginIcon = pluginUiMeta?.icon || null;
                                const pluginTooltip = buildPluginHelpTooltip(plugin.name, pluginUiMeta);
                                return (
                                  <button
                                    key={`track_chain_modal_picker_${trackChainModalTrack.track_id}_${plugin.uid}`}
                                    type="button"
                                    className="arrangement-track-plugin-picker-item"
                                    title={pluginTooltip}
                                    disabled={pluginLoadPending}
                                    onClick={() => {
                                      addVst({
                                        trackId: trackChainModalTrack.track_id,
                                        pluginUid: plugin.uid,
                                        insertIndex: openTrackPluginPicker.slotIndex,
                                        slotKind: 'effect',
                                        onSuccess: () => setOpenTrackPluginPicker(null),
                                      });
                                    }}
                                  >
                                    <span className="plugin-name-with-icon truncate">
                                      {PluginIcon ? <PluginIcon size={12} strokeWidth={2} aria-hidden="true" /> : null}
                                      <span>{plugin.name}</span>
                                    </span>
                                    <small>{plugin.type}</small>
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                        {renderFloatingWindowResizeHandles('trackChain')}
                      </div>
                    </div>
                  ) : null}
                  {recordMicModalTrackId != null && !isFloatingWindowMinimized('recordMic') ? (
                    <div
                      className="settings-modal-overlay floating-window-overlay"
                      role="presentation"
                      style={getFloatingWindowLayerStyle('recordMic')}
                    >
                      <div
                        className="settings-modal record-mic-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-label="Mikrofon für Aufnahme wählen"
                        style={getDraggableModalStyle('recordMic')}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          activateFloatingWindow('recordMic');
                        }}
                      >
                        <div
                          className="settings-modal-head"
                          onPointerDown={(e) => beginModalDrag('recordMic', e)}
                        >
                          <h2>Mikrofon für Aufnahme (Track {recordMicModalTrackId})</h2>
                          <div className="settings-modal-window-controls">
                            <button
                              type="button"
                              className="settings-modal-window-btn"
                              onClick={() => minimizeFloatingWindow('recordMic')}
                              aria-label="Minimieren"
                              title="Minimieren"
                            >
                              <Minus size={14} strokeWidth={2} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="settings-modal-window-btn"
                              onClick={() => toggleFloatingWindowMaximize('recordMic')}
                              aria-label={getFloatingWindowLayout('recordMic').maximized ? 'Wiederherstellen' : 'Maximieren'}
                              title={getFloatingWindowLayout('recordMic').maximized ? 'Wiederherstellen' : 'Maximieren'}
                            >
                              {getFloatingWindowLayout('recordMic').maximized
                                ? <Square size={12} strokeWidth={2} aria-hidden="true" />
                                : <LayoutGrid size={14} strokeWidth={2} aria-hidden="true" />}
                            </button>
                            <button
                              type="button"
                              className="settings-modal-close"
                              onClick={() => setRecordMicModalTrackId(null)}
                              aria-label="Schliessen"
                              title="Schliessen"
                            >
                              <X size={14} strokeWidth={2} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                        <div className="settings-modal-body">
                          <p className="settings-audio-hint">Wähle das Mikrofon, mit dem diese Spur aufgenommen werden soll.</p>
                          {recordMicInputDevices.length === 0 ? (
                            <p className="settings-audio-hint">Lade Eingabegeräte …</p>
                          ) : (
                            <ul className="record-mic-list">
                              {recordMicInputDevices.map((d) => (
                                <li key={d.id}>
                                  <button
                                    type="button"
                                    className="record-mic-option"
                                    onClick={() => setRecordArmWithMic(recordMicModalTrackId, d.id, d.name || d.id)}
                                  >
                                    {d.name || d.id}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => setRecordMicModalTrackId(null)}
                          >
                            Abbrechen
                          </button>
                        </div>
                        {renderFloatingWindowResizeHandles('recordMic')}
                      </div>
                    </div>
                  ) : null}
                  {showSettingsModal && !isFloatingWindowMinimized('settings') ? (
                    <div
                      className="settings-modal-overlay floating-window-overlay"
                      role="presentation"
                      style={getFloatingWindowLayerStyle('settings')}
                    >
                      <div
                        className="settings-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-label="Einstellungen"
                        style={getDraggableModalStyle('settings')}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          activateFloatingWindow('settings');
                        }}
                      >
                        <div
                          className="settings-modal-head"
                          onPointerDown={(e) => beginModalDrag('settings', e)}
                        >
                          <h2>Settings</h2>
                          <div className="settings-modal-window-controls">
                            <button
                              type="button"
                              className="settings-modal-window-btn"
                              onClick={() => minimizeFloatingWindow('settings')}
                              aria-label="Minimieren"
                              title="Minimieren"
                            >
                              <Minus size={14} strokeWidth={2} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="settings-modal-window-btn"
                              onClick={() => toggleFloatingWindowMaximize('settings')}
                              aria-label={getFloatingWindowLayout('settings').maximized ? 'Wiederherstellen' : 'Maximieren'}
                              title={getFloatingWindowLayout('settings').maximized ? 'Wiederherstellen' : 'Maximieren'}
                            >
                              {getFloatingWindowLayout('settings').maximized
                                ? <Square size={12} strokeWidth={2} aria-hidden="true" />
                                : <LayoutGrid size={14} strokeWidth={2} aria-hidden="true" />}
                            </button>
                            <button
                              type="button"
                              className="settings-modal-close"
                              onClick={() => setShowSettingsModal(false)}
                              aria-label="Schliessen"
                              title="Schliessen"
                            >
                              <X size={14} strokeWidth={2} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                        <div className="settings-modal-tabs">
                          {['AUDIO', 'VST PLUGINS', 'RECORD', 'GENERAL', 'PERFORMANCE'].map((tab) => (
                            <button
                              key={tab}
                              type="button"
                              className={`settings-modal-tab ${settingsTab === tab ? 'active' : ''}`}
                              onClick={() => setSettingsTab(tab)}
                            >
                              {tab}
                            </button>
                          ))}
                        </div>
                        <div className="settings-modal-body">
                          {settingsTab === 'AUDIO' ? (
                            <div className="settings-audio-panel">
                              {connection !== 'online' || !state?.nativeTransport ? (
                                <div className="settings-audio-unavailable" role="status">
                                  <p><strong>Native-Engine nicht verbunden.</strong></p>
                                  <p>Für Audio-Ausgabe und Geräteliste die App mit der Native-Engine starten:</p>
                                  <p><code>npm run dev</code> (aus dem Projektroot <code>thestuu</code>).</p>
                                  <p>Damit starten Native-Binary, Engine und Dashboard zusammen.</p>
                                </div>
                              ) : null}
                              <label className="audio-output-select-wrap">
                                <span className="audio-output-label">Audio-Ausgabe</span>
                                <select
                                  className="audio-output-select"
                                  value={audioOutputCurrentId}
                                  onChange={(e) => {
                                    const id = e.target.value;
                                    if (!id) return;
                                    socketRef.current?.emit('audio:set-output', { deviceId: id }, (res) => {
                                      if (res?.ok) setAudioOutputCurrentId(id);
                                    });
                                  }}
                                  title="z. B. interne Lautsprecher, Bluetooth-Kopfhörer oder externe Soundkarte"
                                  aria-label="Audio-Ausgabe wählen"
                                  disabled={connection !== 'online' || !state?.nativeTransport}
                                >
                                  {audioOutputDevices.length === 0 ? (
                                    <option value="">
                                      {connection === 'online' && state?.nativeTransport
                                        ? '— Keine Ausgabegeräte gemeldet —'
                                        : '— Keine Geräte (Native offline) —'}
                                    </option>
                                  ) : (
                                    <>
                                      <option value="" disabled>
                                        — Bluetooth-Gerät wird angezeigt, wenn es mit dem Computer verbunden ist —
                                      </option>
                                      {audioOutputDevices.map((d) => (
                                        <option key={d.id} value={d.id}>{d.name || d.id}</option>
                                      ))}
                                    </>
                                  )}
                                </select>
                              </label>
                              {connection === 'online' && state?.nativeTransport && audioOutputDevices.length === 0 ? (
                                <p className="settings-audio-hint">
                                  Die Native-Engine ist verbunden, hat aber noch keine Ausgabegeräte geliefert.
                                  Einstellungen schließen und erneut öffnen oder kurz warten; bei dauerhaft leerer Liste die Engine-Logs prüfen (Antwort auf <code>audio:get-outputs</code>).
                                </p>
                              ) : (
                                <p className="settings-audio-hint">
                                  Wähle das Ausgabegerät für Wiedergabe (z. B. interne Lautsprecher oder externe Soundkarte).
                                </p>
                              )}
                              <label className="audio-output-select-wrap">
                                <span className="audio-output-label">Audio-Eingabe</span>
                                <select
                                  className="audio-output-select"
                                  value={audioInputCurrentId}
                                  onChange={(e) => {
                                    const id = e.target.value;
                                    if (!id) return;
                                    setAudioInputDevice(id);
                                  }}
                                  title="Quelle für Aufnahme (z. B. Mikrofon, Bluetooth-Kopfhörer oder Line-In)"
                                  aria-label="Audio-Eingabe wählen"
                                  disabled={connection !== 'online' || !state?.nativeTransport}
                                >
                                  {audioInputDevices.length === 0 ? (
                                    <option value="">
                                      {connection === 'online' && state?.nativeTransport
                                        ? '— Keine Eingabegeräte —'
                                        : '— Keine Geräte (Native offline) —'}
                                    </option>
                                  ) : (
                                    <>
                                      <option value="" disabled>
                                        — Bluetooth-Mikrofon wird angezeigt, wenn es mit dem Computer verbunden ist —
                                      </option>
                                      {audioInputDevices.map((d) => (
                                        <option key={d.id} value={d.id}>{d.name || d.id}</option>
                                      ))}
                                    </>
                                  )}
                                </select>
                              </label>
                              <p className="settings-audio-hint">
                                Wähle das Eingabegerät für Aufnahme (z. B. Mikrofon, Bluetooth-Kopfhörer oder Line-In). Wird beim Record-Button der Spuren verwendet.
                              </p>
                              {(audioStatus && (audioStatus.sampleRate != null || audioStatus.outputChannels != null)) ? (
                                <dl className="settings-audio-status">
                                  {audioStatus.sampleRate != null ? (
                                    <>
                                      <dt>Sample rate (Hz)</dt>
                                      <dd>{Math.round(audioStatus.sampleRate)}</dd>
                                    </>
                                  ) : null}
                                  <dt>Status</dt>
                                  <dd>
                                    {audioStatus.sampleRate != null && audioStatus.outputChannels != null
                                      ? `Offen, ${Math.round(audioStatus.sampleRate)} Hz, ${audioStatus.outputChannels} Ausgänge`
                                      : audioStatus.sampleRate != null
                                        ? `${Math.round(audioStatus.sampleRate)} Hz`
                                        : audioStatus.outputChannels != null
                                          ? `${audioStatus.outputChannels} Ausgänge`
                                          : '—'}
                                    {audioStatus.outputLatencySeconds != null && audioStatus.outputLatencySeconds > 0
                                      ? ` · Latenz: ${(audioStatus.outputLatencySeconds * 1000).toFixed(1)} ms`
                                      : ''}
                                    {audioStatus.blockSize != null ? ` · Block: ${audioStatus.blockSize} Samples` : ''}
                                  </dd>
                                </dl>
                              ) : null}
                            </div>
                          ) : settingsTab === 'RECORD' ? (
                            <div className="settings-record-panel">
                              <label className="settings-record-option">
                                <input
                                  type="checkbox"
                                  checked={Boolean(state?.project?.record_auto_metronome)}
                                  onChange={(e) => {
                                    const v = e.target.checked;
                                    setState((prev) => ({
                                      ...prev,
                                      project: { ...prev?.project, record_auto_metronome: v },
                                    }));
                                    emitMutation('project:update-view', { record_auto_metronome: v });
                                  }}
                                />
                                <span>Metronom beim Record automatisch aktivieren</span>
                              </label>
                              <p className="settings-audio-hint">Wenn mindestens eine Spur auf Aufnahme steht und du Play drückst, wird das Metronom automatisch eingeschaltet.</p>
                              <label className="settings-record-option">
                                <input
                                  type="checkbox"
                                  checked={recordCountInEnabledPreference}
                                  onChange={(e) => {
                                    updateAppPreferences({ record_count_in_enabled: Boolean(e.target.checked) });
                                  }}
                                />
                                <span>Einzählzeit vor Aufnahme aktivieren</span>
                              </label>
                              <label className="settings-record-option settings-record-count-in">
                                <span>Einzählzeit (Beats vor Aufnahme)</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={10}
                                  disabled={!recordCountInEnabledPreference}
                                  value={Math.max(1, Math.min(10, Number(state?.project?.record_count_in_beats) || 4))}
                                  onChange={(e) => {
                                    const raw = Number(e.target.value);
                                    const v = Number.isInteger(raw) && raw >= 1 && raw <= 10 ? raw : 4;
                                    setState((prev) => ({
                                      ...prev,
                                      project: { ...prev?.project, record_count_in_beats: v },
                                    }));
                                    emitMutation('project:update-view', { record_count_in_beats: v });
                                  }}
                                />
                              </label>
                              <p className="settings-audio-hint">
                                {recordCountInEnabledPreference
                                  ? 'Anzahl Beats im Tempo des Projekts vor Start der Aufnahme (1–10). Die Ticks laufen in der Geschwindigkeit der BPM.'
                                  : 'Einzählzeit ist deaktiviert. Aufnahme startet sofort; der zuletzt eingestellte Wert bleibt gespeichert.'}
                              </p>
                              <label className="settings-record-option">
                                <input
                                  type="checkbox"
                                  checked={recordUseStandardMicPreference}
                                  onChange={(e) => {
                                    updateAppPreferences({ record_use_standard_mic: Boolean(e.target.checked) });
                                  }}
                                />
                                <span>Standard-Mikrofon beim Record Arm verwenden</span>
                              </label>
                              <label className="audio-output-select-wrap">
                                <span className="audio-output-label">Standard-Mikrofon (Audio-Eingabe)</span>
                                <select
                                  className="audio-output-select"
                                  value={audioInputCurrentId}
                                  onChange={(e) => {
                                    const id = e.target.value;
                                    if (!id) return;
                                    setAudioInputDevice(id);
                                  }}
                                  title="Standard-Mikrofon für Record Arm"
                                  aria-label="Standard-Mikrofon wählen"
                                  disabled={!recordUseStandardMicPreference || connection !== 'online' || !state?.nativeTransport}
                                >
                                  {audioInputDevices.length === 0 ? (
                                    <option value="">
                                      {connection === 'online' && state?.nativeTransport
                                        ? '— Keine Eingabegeräte —'
                                        : '— Keine Geräte (Native offline) —'}
                                    </option>
                                  ) : (
                                    <>
                                      <option value="" disabled>
                                        — Standard-Mikrofon auswählen —
                                      </option>
                                      {audioInputDevices.map((d) => (
                                        <option key={`record_pref_${d.id}`} value={d.id}>{d.name || d.id}</option>
                                      ))}
                                    </>
                                  )}
                                </select>
                              </label>
                              <p className="settings-audio-hint">
                                Wenn aktiviert, verwendet der <code>R</code>-Button am Track/Mixer direkt dieses Mikrofon. Wenn es nicht verfügbar ist, wird die Mikrofon-Auswahl geöffnet.
                              </p>
                            </div>
                          ) : settingsTab === 'VST PLUGINS' ? (
                            <div className="settings-vst-panel">
                              <div className="settings-vst-toolbar">
                                <div className="settings-vst-subtabs" role="tablist" aria-label="VST Plugin Kategorien">
                                  <button
                                    type="button"
                                    className={`settings-vst-subtab ${settingsVstPluginTab === 'effects' ? 'active' : ''}`}
                                    onClick={() => setSettingsVstPluginTab('effects')}
                                  >
                                    Effects ({availableEffectPlugins.length})
                                  </button>
                                  <button
                                    type="button"
                                    className={`settings-vst-subtab ${settingsVstPluginTab === 'generators' ? 'active' : ''}`}
                                    onClick={() => setSettingsVstPluginTab('generators')}
                                  >
                                    Generators ({availableGeneratorPlugins.length})
                                  </button>
                                </div>
                                <button
                                  type="button"
                                  className="settings-vst-rescan"
                                  onClick={() => scanVstPlugins()}
                                  disabled={pluginScanPending || connection !== 'online' || !state?.nativeTransport}
                                >
                                  {pluginScanPending ? 'Scanne...' : 'Rescan'}
                                </button>
                              </div>
                              <div className="settings-vst-search-row">
                                <input
                                  id="settings-vst-search"
                                  type="search"
                                  className="settings-vst-search-input"
                                  value={settingsVstSearch}
                                  onChange={(event) => setSettingsVstSearch(event.target.value)}
                                  placeholder="Suche nach Name, UID, Typ"
                                  aria-label="Plugin Suche"
                                />
                                <div className="settings-vst-source-filters" role="group" aria-label="Plugin Source Filter">
                                  <label className={`settings-vst-source-filter ${settingsVstSourceFilter === 'all' ? 'active' : ''}`}>
                                    <input
                                      type="checkbox"
                                      checked={settingsVstSourceFilter === 'all'}
                                      onChange={() => setSettingsVstSourceFilter('all')}
                                    />
                                    <span>{`ALL (${settingsVstSourceCounts.all})`}</span>
                                  </label>
                                  <label className={`settings-vst-source-filter ${settingsVstSourceFilter === 'native' ? 'active' : ''}`}>
                                    <input
                                      type="checkbox"
                                      checked={settingsVstSourceFilter === 'native'}
                                      onChange={() => setSettingsVstSourceFilter('native')}
                                    />
                                    <span>{`NATIVE (${settingsVstSourceCounts.native})`}</span>
                                  </label>
                                  <label className={`settings-vst-source-filter ${settingsVstSourceFilter === 'external' ? 'active' : ''}`}>
                                    <input
                                      type="checkbox"
                                      checked={settingsVstSourceFilter === 'external'}
                                      onChange={() => setSettingsVstSourceFilter('external')}
                                    />
                                    <span>{`EXTERNAL (${settingsVstSourceCounts.external})`}</span>
                                  </label>
                                </div>
                              </div>

                              {connection !== 'online' || !state?.nativeTransport ? (
                                <div className="settings-audio-unavailable" role="status">
                                  <p><strong>Native-Engine nicht verbunden.</strong></p>
                                  <p>Plugin-Scan und Plugin-Liste sind nur mit aktiver Native-Engine verfuegbar.</p>
                                </div>
                              ) : settingsVstPlugins.length === 0 ? (
                                <div className="settings-placeholder-panel">
                                  <p>
                                    {settingsVstPluginTab === 'effects'
                                      ? 'Keine Effekt-Plugins gefunden.'
                                      : 'Keine Generator-Plugins gefunden.'}
                                  </p>
                                  <p>Mit Rescan erneut suchen.</p>
                                </div>
                              ) : settingsFilteredVstPlugins.length === 0 ? (
                                <div className="settings-placeholder-panel">
                                  <p>Keine Treffer mit dem aktuellen Filter.</p>
                                  <p>Filter anpassen oder Rescan starten.</p>
                                </div>
                              ) : (
                                <div className="settings-vst-list" role="list" aria-label="VST Plugin Liste">
                                  {settingsFilteredVstPlugins.map((plugin) => {
                                    const pluginUiMeta = resolveTracktionPluginUiMeta(plugin.uid, plugin.name);
                                    const PluginIcon = pluginUiMeta?.icon || null;
                                    const pluginTooltip = buildPluginHelpTooltip(plugin.name, pluginUiMeta);
                                    return (
                                      <div
                                        key={`settings_vst_${settingsVstPluginTab}_${plugin.uid}`}
                                        className="settings-vst-item"
                                        role="listitem"
                                        title={pluginTooltip}
                                      >
                                        <div className="settings-vst-item-main">
                                          <strong className="plugin-name-with-icon truncate">
                                            {PluginIcon ? <PluginIcon size={12} strokeWidth={2} aria-hidden="true" /> : null}
                                            <span>{plugin.name}</span>
                                          </strong>
                                          <small>{plugin.uid}</small>
                                        </div>
                                        <div className="settings-vst-item-meta">
                                          <span>{plugin.type}</span>
                                          <span>{plugin.isNative ? 'Native' : 'External'}</span>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          ) : settingsTab === 'PERFORMANCE' ? (
                            <div className="settings-performance-panel">
                              <p className="settings-audio-hint">Steuert Meter-Rate und UI-Last auf schwacher Hardware.</p>
                              <div className="settings-performance-options" role="radiogroup" aria-label="Performance Profil">
                                {['low', 'balanced', 'high'].map((profile) => (
                                  <label key={profile} className={`settings-performance-option ${performanceProfile === profile ? 'active' : ''}`}>
                                    <input
                                      type="radio"
                                      name="performanceProfile"
                                      value={profile}
                                      checked={performanceProfile === profile}
                                      onChange={() => {
                                        setPerformanceProfile(profile);
                                        setPerformanceProfileState(profile);
                                        socketRef.current?.emit('client:performance_profile', { profile });
                                      }}
                                    />
                                    <span>{profile === 'low' ? 'Low (Kartoffel)' : profile === 'high' ? 'High' : 'Balanced'}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="settings-placeholder-panel">
                              <p>Allgemeine Einstellungen — in Arbeit.</p>
                            </div>
                          )}
                        </div>
                        {renderFloatingWindowResizeHandles('settings')}
                      </div>
                    </div>
                  ) : null}
                  {importTrackRenamePrompt ? (
                    <div
                      className="import-track-rename-modal-overlay floating-window-overlay"
                      role="presentation"
                      style={getFloatingWindowLayerStyle('importTrackRename')}
                    >
                      <div
                        className="import-track-rename-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-label={`Track ${importTrackRenamePrompt.trackId} Namen uebernehmen`}
                        style={getDraggableModalStyle('importTrackRename')}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          activateFloatingWindow('importTrackRename');
                        }}
                      >
                        <div
                          className="import-track-rename-modal-head"
                          onPointerDown={(event) => beginModalDrag('importTrackRename', event)}
                        >
                          <div className="import-track-rename-modal-head-title">
                            <h2>Namen uebernehmen?</h2>
                            <div className="settings-modal-window-controls">
                              <button
                                type="button"
                                className="settings-modal-window-btn"
                                onClick={() => minimizeFloatingWindow('importTrackRename')}
                                aria-label="Minimieren"
                                title="Minimieren"
                              >
                                <Minus size={14} strokeWidth={2} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="settings-modal-window-btn"
                                onClick={() => toggleFloatingWindowMaximize('importTrackRename')}
                                aria-label={getFloatingWindowLayout('importTrackRename').maximized ? 'Wiederherstellen' : 'Maximieren'}
                                title={getFloatingWindowLayout('importTrackRename').maximized ? 'Wiederherstellen' : 'Maximieren'}
                              >
                                {getFloatingWindowLayout('importTrackRename').maximized
                                  ? <Square size={12} strokeWidth={2} aria-hidden="true" />
                                  : <LayoutGrid size={14} strokeWidth={2} aria-hidden="true" />}
                              </button>
                            </div>
                            <button
                              type="button"
                              className="import-track-rename-modal-close"
                              aria-label="Schliessen"
                              onClick={() => {
                                resolveImportTrackRenamePrompt({ apply: false, trackName: '' });
                              }}
                            >
                              <X size={14} strokeWidth={2} aria-hidden="true" />
                            </button>
                          </div>
                          <p>
                            {importTrackRenamePrompt.choices.length > 1
                              ? `Track ${importTrackRenamePrompt.trackId}: Waehle einen Dateinamen fuer den Track.`
                              : `Track ${importTrackRenamePrompt.trackId}: Dateinamen als Trackname uebernehmen?`}
                          </p>
                        </div>

                        {importTrackRenamePrompt.choices.length > 1 ? (
                          <div className="import-track-rename-modal-list">
                            {importTrackRenamePrompt.choices.map((choice) => (
                              <label
                                key={`import_track_rename_choice_${choice.id}`}
                                className={`import-track-rename-modal-item ${importTrackRenamePrompt.selectedChoiceId === choice.id ? 'selected' : ''}`}
                              >
                                <input
                                  type="radio"
                                  name="import-track-rename-choice"
                                  value={choice.id}
                                  checked={importTrackRenamePrompt.selectedChoiceId === choice.id}
                                  onChange={() => {
                                    setImportTrackRenamePrompt((current) => {
                                      if (!current) {
                                        return current;
                                      }
                                      return {
                                        ...current,
                                        selectedChoiceId: choice.id,
                                      };
                                    });
                                  }}
                                />
                                <span>{choice.trackName}</span>
                                <small>{choice.sourceName}</small>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <p className="import-track-rename-modal-single-name">
                            {importTrackRenamePrompt.choices[0]?.trackName || `Track ${importTrackRenamePrompt.trackId}`}
                          </p>
                        )}

                        <div className="import-track-rename-modal-actions">
                          <button
                            type="button"
                            className="import-track-rename-modal-btn"
                            onClick={() => {
                              resolveImportTrackRenamePrompt({ apply: false, trackName: '' });
                            }}
                          >
                            Nein
                          </button>
                          <button
                            type="button"
                            className="import-track-rename-modal-btn primary"
                            onClick={() => {
                              const selectedChoice = importTrackRenamePrompt.choices.find((choice) => (
                                choice.id === importTrackRenamePrompt.selectedChoiceId
                              )) || importTrackRenamePrompt.choices[0];
                              resolveImportTrackRenamePrompt({
                                apply: true,
                                trackName: selectedChoice?.trackName || '',
                              });
                            }}
                          >
                            Ja
                          </button>
                        </div>
                        {renderFloatingWindowResizeHandles('importTrackRename')}
                      </div>
                    </div>
                  ) : null}
                  {structureNodeModal ? (
                    <SongStructureNodeModal
                      node={structureNodeModal}
                      onClose={() => setStructureNodeModal(null)}
                      onSave={handleStructureNodeSave}
                      onDelete={handleStructureRemoveNodeById}
                    />
                  ) : null}
                  <SongStructureTemplateManager
                    open={structureTemplateManagerOpen}
                    templates={structureTemplates}
                    loadedTemplateId={songStructure.template_id}
                    onClose={() => setStructureTemplateManagerOpen(false)}
                    onRefresh={refreshStructureTemplates}
                    onLoad={handleStructureTemplateLoad}
                    onSaveLoaded={handleStructureSaveLoadedTemplate}
                    onSaveAsNew={handleStructureSaveAsNew}
                    onExport={handleStructureTemplateExport}
                    onEditMeta={handleStructureTemplateEditMeta}
                  />
                </>
              ) : null}

              {activeTab === 'Mix' ? (
                <div className="mix-layout">
                  <MixMeterFlatHint
                    playing={Boolean(transport.playing)}
                    nativeOn={Boolean(state?.nativeTransport)}
                    trackCount={mixTracks.length}
                    tracks={mixTracks}
                  />
                  <div className="mix-structure-strip">
                    <div className="mix-structure-strip-label">Structure</div>
                    <SongStructureLane
                      nodes={songStructure.nodes}
                      barWidth={barWidth}
                      snapStep={snapStep}
                      timelineWidth={timelineWidth}
                      readOnly
                      playlistLinkTintSegments={structurePlaylistTintSegments}
                    />
                  </div>
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
                      <article
                        className={`mix-strip mix-strip-master ${masterMix.mute ? 'track-muted' : ''}`}
                        aria-label="Master Channel"
                        onClick={(event) => {
                          if (event.target.closest('input, button, textarea, select, a, label')) {
                            return;
                          }
                          setTrackContextMenu(null);
                          setOpenTrackPluginPicker(null);
                        }}
                        onDoubleClick={() => {
                          setTrackChainModalTrackId(0);
                          restoreFloatingWindow('trackChain');
                        }}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                          }
                        }}
                      >
                        <div className="mix-strip-head">
                          <span className="mix-strip-index">M</span>
                          <strong>Master</strong>
                        </div>
                        <MixMasterLevelMeter tracks={mixTracks} />
                        <div className="mix-strip-toggle-row">
                          <button
                            type="button"
                            className={mixStripToggleButtonClass('mute', masterMix.mute)}
                            onClick={(event) => {
                              event.stopPropagation();
                              setMasterMute(!masterMix.mute);
                            }}
                            title="Mute"
                            aria-label="Master Mute"
                          >
                            <TrackMixToggleIcon action="mute" active={masterMix.mute} />
                          </button>
                        </div>
                        <label className="mix-strip-pan">
                          <span>Pan</span>
                          <div className="arrangement-track-pan-range">
                            <em>L</em>
                            <span
                              className="arrangement-pan-slider-shell"
                              style={getPanFillRange(masterMix.pan)}
                            >
                              <input
                                type="range"
                                className="arrangement-pan-slider"
                                min={-1}
                                max={1}
                                step={0.01}
                                value={masterMix.pan}
                                onPointerDown={(event) => {
                                  event.stopPropagation();
                                  beginMixLevelPointerDrag('pan', 0, normalizePanValue(event.currentTarget.value));
                                }}
                                onInput={(event) => handleMixMasterPanSliderInput(event.target.value)}
                                onClick={(event) => event.stopPropagation()}
                                aria-label="Pan Master"
                              />
                            </span>
                            <em>R</em>
                          </div>
                          <div className="mix-strip-pan-value-edit">
                            <span className="mix-strip-pan-value-side mix-strip-pan-value-side-left" aria-hidden="true">
                              {toPanPercent(masterMix.pan) < 0 ? 'L' : ''}
                            </span>
                            <input
                              type="number"
                              className="arrangement-track-value-input"
                              min={0}
                              max={100}
                              step={1}
                              value={toPanMagnitudePercent(masterMix.pan)}
                              onChange={(event) => setMasterPanPercent(event.target.value, masterMix.pan)}
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                              aria-label={`Pan Wert Master (${getPanSideLabel(masterMix.pan)})`}
                            />
                            <span className="mix-strip-pan-value-side mix-strip-pan-value-side-right" aria-hidden="true">
                              {toPanPercent(masterMix.pan) > 0 ? 'R' : ''}
                            </span>
                          </div>
                        </label>
                        <div className="mix-strip-fader-wrap">
                          <input
                            type="range"
                            className="mix-strip-fader"
                            min={0}
                            max={1.2}
                            step={0.01}
                            value={masterMix.volume}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              beginMixLevelPointerDrag('volume', 0, normalizeVolumeValue(event.currentTarget.value));
                            }}
                            onInput={(event) => handleMixMasterVolumeSliderInput(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                          />
                        </div>
                        <div className="mix-strip-db mix-strip-db-editable">
                          <div className="mix-strip-db-inner">
                            <input
                              type="number"
                              className="arrangement-track-value-input mix-strip-db-input"
                              min={MIN_VOLUME_DB}
                              max={MAX_VOLUME_DB}
                              step={0.1}
                              value={toVolumeDbInput(masterMix.volume)}
                              onChange={(event) => setMasterVolumeDb(event.target.value)}
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                              aria-label="Mix Volume dB Master"
                              title={formatVolumeDbLabel(masterMix.volume)}
                            />
                            <span className="mix-strip-db-suffix">dB</span>
                          </div>
                        </div>
                        <MixStripChain
                          trackId={0}
                          trackNodes={mixMasterNodes}
                          chainEnabled={mixMasterChainEnabled}
                          pluginNameByUid={pluginNameByUid}
                          resolveNodePluginDisplayName={resolveNodePluginDisplayName}
                          formatTrackChainPluginName={formatTrackChainPluginName}
                          resolveTracktionPluginUiMeta={resolveTracktionPluginUiMeta}
                          buildPluginHelpTooltip={buildPluginHelpTooltip}
                          openTrackChainModalSlotPluginPicker={openTrackChainModalSlotPluginPicker}
                          setInspector={setInspector}
                          openVstNodeEditor={openVstNodeEditor}
                          setVstNodeBypassed={setVstNodeBypassed}
                          removeVstNode={removeVstNode}
                          reorderTrackVstNodes={reorderTrackVstNodes}
                        />
                      </article>

                      {mixTracks.map((track) => {
                        const trackMix = track.mix || createDefaultTrackMix(track.track_id);
                        const trackNodes = vstNodesByTrack.get(track.track_id) || [];
                        const isSelected = track.track_id === mixSelectedTrackId;

                        return (
                          <article
                            key={`mix_strip_${track.track_id}`}
                            className={`mix-strip ${isSelected ? 'active' : ''} ${trackMix.mute ? 'track-muted' : ''} ${trackMix.solo ? 'track-soloed' : ''}`}
                            onClick={(event) => {
                              if (event.target.closest('input, button, textarea, select, a, label')) {
                                return;
                              }
                              setTrackContextMenu(null);
                              setOpenTrackPluginPicker(null);
                              setInspector({ type: 'track', trackId: track.track_id });
                            }}
                            onDoubleClick={() => {
                              setTrackChainModalTrackId(track.track_id);
                              restoreFloatingWindow('trackChain');
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

                            <MixStripLevelMeter trackId={track.track_id} />

                            <div className="mix-strip-toggle-row">
                              <button
                                type="button"
                                className={mixStripToggleButtonClass('mute', trackMix.mute)}
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
                                className={mixStripToggleButtonClass('solo', trackMix.solo)}
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
                                className={mixStripToggleButtonClass('record', trackMix.record_armed)}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (trackMix.record_armed) {
                                    setRecordArm(track.track_id, false);
                                  } else {
                                    openRecordArmMicSelection(track.track_id);
                                  }
                                }}
                                title="Record Arm"
                                aria-label={`Track ${track.track_id} Record Arm`}
                              >
                                R
                              </button>
                            </div>
                            {(trackMix.record_armed && (trackMix.record_input_device_name || trackMix.record_input_device_id)) ? (
                              <div className="arrangement-track-mic-label mix-strip-mic-label">Mikro: {trackMix.record_input_device_name || trackMix.record_input_device_id}</div>
                            ) : null}

                            <label className="mix-strip-pan">
                              <span>Pan</span>
                              <div className="arrangement-track-pan-range">
                                <em>L</em>
                                <span
                                  className="arrangement-pan-slider-shell"
                                  style={getPanFillRange(trackMix.pan)}
                                >
                                  <input
                                    type="range"
                                    className="arrangement-pan-slider"
                                    min={-1}
                                    max={1}
                                    step={0.01}
                                    value={trackMix.pan}
                                    onPointerDown={(event) => {
                                      event.stopPropagation();
                                      beginMixLevelPointerDrag(
                                        'pan',
                                        track.track_id,
                                        normalizePanValue(event.currentTarget.value),
                                      );
                                    }}
                                    onInput={(event) => handleMixPanSliderInput(track.track_id, event.target.value)}
                                    onClick={(event) => event.stopPropagation()}
                                    aria-label={`Pan Track ${track.track_id}`}
                                  />
                                </span>
                                <em>R</em>
                              </div>
                              <div className="mix-strip-pan-value-edit">
                                <span className="mix-strip-pan-value-side mix-strip-pan-value-side-left" aria-hidden="true">
                                  {toPanPercent(trackMix.pan) < 0 ? 'L' : ''}
                                </span>
                                <input
                                  type="number"
                                  className="arrangement-track-value-input"
                                  min={0}
                                  max={100}
                                  step={1}
                                  value={toPanMagnitudePercent(trackMix.pan)}
                                  onChange={(event) => setPanPercent(track.track_id, event.target.value, trackMix.pan)}
                                  onClick={(event) => event.stopPropagation()}
                                  onPointerDown={(event) => event.stopPropagation()}
                                  aria-label={`Pan Wert Mix Track ${track.track_id} (${getPanSideLabel(trackMix.pan)})`}
                                />
                                <span className="mix-strip-pan-value-side mix-strip-pan-value-side-right" aria-hidden="true">
                                  {toPanPercent(trackMix.pan) > 0 ? 'R' : ''}
                                </span>
                              </div>
                            </label>

                            <div className="mix-strip-fader-wrap">
                              <input
                                type="range"
                                className="mix-strip-fader"
                                min={0}
                                max={1.2}
                                step={0.01}
                                value={trackMix.volume}
                                onPointerDown={(event) => {
                                  event.stopPropagation();
                                  beginMixLevelPointerDrag(
                                    'volume',
                                    track.track_id,
                                    normalizeVolumeValue(event.currentTarget.value),
                                  );
                                }}
                                onInput={(event) => handleMixVolumeSliderInput(track.track_id, event.target.value)}
                                onClick={(event) => event.stopPropagation()}
                              />
                            </div>
                            <div className="mix-strip-db mix-strip-db-editable">
                              <div className="mix-strip-db-inner">
                                <input
                                  type="number"
                                  className="arrangement-track-value-input mix-strip-db-input"
                                  min={MIN_VOLUME_DB}
                                  max={MAX_VOLUME_DB}
                                  step={0.1}
                                  value={toVolumeDbInput(trackMix.volume)}
                                  onChange={(event) => setVolumeDb(track.track_id, event.target.value)}
                                  onClick={(event) => event.stopPropagation()}
                                  onPointerDown={(event) => event.stopPropagation()}
                                  aria-label={`Mix Volume dB Track ${track.track_id}`}
                                  title={formatVolumeDbLabel(trackMix.volume)}
                                />
                                <span className="mix-strip-db-suffix">dB</span>
                              </div>
                            </div>

                            <MixStripChain
                              trackId={track.track_id}
                              trackNodes={trackNodes}
                              chainEnabled={track.chain_enabled !== false}
                              pluginNameByUid={pluginNameByUid}
                              resolveNodePluginDisplayName={resolveNodePluginDisplayName}
                              formatTrackChainPluginName={formatTrackChainPluginName}
                              resolveTracktionPluginUiMeta={resolveTracktionPluginUiMeta}
                              buildPluginHelpTooltip={buildPluginHelpTooltip}
                              openTrackChainModalSlotPluginPicker={openTrackChainModalSlotPluginPicker}
                              setInspector={setInspector}
                              openVstNodeEditor={openVstNodeEditor}
                              setVstNodeBypassed={setVstNodeBypassed}
                              removeVstNode={removeVstNode}
                              reorderTrackVstNodes={reorderTrackVstNodes}
                            />
                          </article>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : null}
          </section>
        </main>

      </div>
    </div>
    {aiChatDrawerOpen ? (
      <div className="ai-chat-drawer-root" role="complementary" aria-label="Seitenpanel">
        <aside className="ai-chat-drawer panel panel-chat">
          <div className="panel-header ai-chat-drawer-header">
            <div className="ai-chat-drawer-tabs" role="tablist" aria-label="Panel Tabs">
              <button
                type="button"
                role="tab"
                id="side-panel-tab-assistant"
                aria-selected={sidePanelTab === 'assistant'}
                aria-controls="side-panel-assistant"
                className={`ai-chat-drawer-tab ${sidePanelTab === 'assistant' ? 'is-active' : ''}`}
                onClick={() => setSidePanelTab('assistant')}
              >
                Assistant
              </button>
              <button
                type="button"
                role="tab"
                id="side-panel-tab-inspector"
                aria-selected={sidePanelTab === 'inspector'}
                aria-controls="side-panel-inspector"
                className={`ai-chat-drawer-tab ${sidePanelTab === 'inspector' ? 'is-active' : ''}`}
                onClick={() => setSidePanelTab('inspector')}
              >
                Inspector
              </button>
            </div>
            <button
              type="button"
              className="ai-chat-drawer-close"
              onClick={() => setAiChatDrawerOpen(false)}
              aria-label="Seitenpanel schließen"
              title="Schließen (Esc)"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {sidePanelTab === 'assistant' ? (
            <div
              id="side-panel-assistant"
              className="ai-chat-drawer-assistant"
              role="tabpanel"
              aria-labelledby="side-panel-tab-assistant"
            >
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
                <button
                  type="button"
                  className={`chat-form-speech-btn${speechListening ? ' is-listening' : ''}`}
                  aria-label="Spracheingabe"
                  title={speechListening ? 'Diktat beenden' : 'Diktat starten'}
                  aria-pressed={speechListening}
                  onClick={toggleSpeechRecognition}
                >
                  <Mic size={16} aria-hidden="true" />
                </button>
                <button type="submit">Send</button>
              </form>
            </div>
          ) : (
            <div
              id="side-panel-inspector"
              className="panel-inspector ai-chat-drawer-inspector-body"
              role="tabpanel"
              aria-labelledby="side-panel-tab-inspector"
            >
              {renderInspectorPanelBody()}
            </div>
          )}
        </aside>
      </div>
    ) : null}
    {(() => {
      const minimizedWindowIds = ['trackChain', 'settings', 'recordMic', 'importTrackRename']
        .filter((windowId) => isFloatingWindowOpen(windowId) && isFloatingWindowMinimized(windowId))
        .sort((left, right) => getFloatingWindowLayout(left).zIndex - getFloatingWindowLayout(right).zIndex);
      if (minimizedWindowIds.length === 0) {
        return null;
      }
      return createPortal(
        <div className="floating-window-dock" role="toolbar" aria-label="Minimierte Fenster">
          {minimizedWindowIds.map((windowId) => (
            <div key={`dock_${windowId}`} className="floating-window-dock-item">
              <button
                type="button"
                className="floating-window-dock-item-main"
                onClick={() => restoreFloatingWindow(windowId)}
                title={`${getFloatingWindowTitle(windowId)} wiederherstellen`}
              >
                <span className="floating-window-dock-item-name">{getFloatingWindowTitle(windowId)}</span>
              </button>
              <button
                type="button"
                className="floating-window-dock-item-close"
                onClick={() => closeFloatingWindow(windowId)}
                aria-label={`${getFloatingWindowTitle(windowId)} schließen`}
                title="Schließen"
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      );
    })()}
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
                      importTargetTrackIdRef.current = track.track_id;
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
