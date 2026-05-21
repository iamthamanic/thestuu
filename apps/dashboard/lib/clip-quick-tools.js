/**
 * Clip Tools menu items by timeline clip kind (pattern vs audio).
 * Location: apps/dashboard/lib/clip-quick-tools.js
 */

import { ExtractStemsIcon, FitToTempoIcon } from '../components/clip-tool-icons.jsx';
import { FileMusic, Gauge, PaintBucket } from 'lucide-react';

export const CLIP_QUICK_TOOL_ACTIONS = {
  EXTRACT_STEMS: 'extract_stems',
  FIT_TO_TEMPO: 'fit_to_tempo',
  RENAME_AND_COLOR: 'rename_and_color',
  ANALYZE_BPM_KEY: 'analyze_bpm_key',
  IMPORT_MIDI: 'import_midi',
};

const RENAME_AND_COLOR = {
  id: CLIP_QUICK_TOOL_ACTIONS.RENAME_AND_COLOR,
  label: 'Rename and Color',
  icon: PaintBucket,
};

const IMPORT_MIDI = {
  id: CLIP_QUICK_TOOL_ACTIONS.IMPORT_MIDI,
  label: 'Import MIDI',
  icon: FileMusic,
};

const AUDIO_ONLY = [
  {
    id: CLIP_QUICK_TOOL_ACTIONS.EXTRACT_STEMS,
    label: 'Extract Stems',
    icon: ExtractStemsIcon,
  },
  {
    id: CLIP_QUICK_TOOL_ACTIONS.FIT_TO_TEMPO,
    label: 'Fit to Tempo',
    icon: FitToTempoIcon,
  },
  RENAME_AND_COLOR,
  {
    id: CLIP_QUICK_TOOL_ACTIONS.ANALYZE_BPM_KEY,
    label: 'Analyze BPM & Key',
    icon: Gauge,
  },
];

const PATTERN_ITEMS = [
  RENAME_AND_COLOR,
  IMPORT_MIDI,
];

const DEFAULT_ITEMS = [
  RENAME_AND_COLOR,
];

/**
 * @param {'pattern'|'audio'|'midi'|string|null|undefined} clipKind
 */
export function getClipQuickToolMenuItems(clipKind) {
  if (clipKind === 'pattern') {
    return PATTERN_ITEMS;
  }
  if (clipKind === 'audio') {
    return AUDIO_ONLY;
  }
  return DEFAULT_ITEMS;
}
