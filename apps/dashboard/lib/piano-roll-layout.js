/**
 * Piano roll geometry: pitch rows, note layout, snap, hit-test.
 * Location: apps/dashboard/lib/piano-roll-layout.js
 */

export const PIANO_ROLL_GRID_STEP = 1 / 16;
export const DEFAULT_STEPS_PER_BAR = 16;
export const DEFAULT_PITCH_MIN = 48;
export const DEFAULT_PITCH_MAX = 84;
export const PIANO_ROLL_ROW_HEIGHT_PX = 15;
export const PIANO_ROLL_BAR_WIDTH_PX = 48;
export const PIANO_ROLL_MIN_BAR_WIDTH_PX = 12;
export const PIANO_ROLL_MAX_BAR_WIDTH_PX = 120;
export const PIANO_ROLL_MAX_VISIBLE_BARS = 128;
export const PIANO_ROLL_KEY_WIDTH_PX = 76;
/** Minimum hit target for note length drag (right edge), FL-style. */
export const PIANO_ROLL_RESIZE_HANDLE_MIN_PX = 10;

/**
 * Visible bar count for full piano roll.
 * At least playlist view width (same as arrangement), plus pattern/clip/notes extent.
 */
export function resolvePianoRollVisibleBars({
  patternLoopBars = 1,
  clipLengthBars = 0,
  playlistViewBars = 0,
  notes = [],
} = {}) {
  const loop = Math.max(1, Number(patternLoopBars) || 1);
  const clip = Math.max(0, Number(clipLengthBars) || 0);
  const playlistBars = Math.max(0, Number(playlistViewBars) || 0);
  let notesEnd = 0;
  if (Array.isArray(notes)) {
    for (const note of notes) {
      const end = (Number(note?.start) || 0) + (Number(note?.length) || 0);
      if (end > notesEnd) {
        notesEnd = end;
      }
    }
  }
  return Math.min(
    PIANO_ROLL_MAX_VISIBLE_BARS,
    Math.max(1, loop, clip, playlistBars, Math.ceil(notesEnd)),
  );
}

export function patternLengthStepsFromBars(bars) {
  const barCount = Math.max(1, Math.round(Number(bars) || 1));
  return Math.min(512, Math.max(16, barCount * DEFAULT_STEPS_PER_BAR));
}

export function patternLengthBarsFromSteps(steps) {
  const stepCount = Math.max(DEFAULT_STEPS_PER_BAR, Math.round(Number(steps) || DEFAULT_STEPS_PER_BAR));
  return Math.max(1, stepCount / DEFAULT_STEPS_PER_BAR);
}

export function getNoteResizeHandleWidthPx(noteWidthPx) {
  const width = Number(noteWidthPx);
  if (!Number.isFinite(width) || width <= 0) {
    return PIANO_ROLL_RESIZE_HANDLE_MIN_PX;
  }
  return Math.max(
    PIANO_ROLL_RESIZE_HANDLE_MIN_PX,
    Math.min(Math.round(width * 0.35), 28),
  );
}

export const PIANO_ROLL_SNAP_OPTIONS = [
  { id: 'bar', label: 'Bar', step: 1 },
  { id: '1/2', label: '1/2', step: 1 / 2 },
  { id: '1/4', label: '1/4', step: 1 / 4 },
  { id: '1/8', label: '1/8', step: 1 / 8 },
  { id: '1/16', label: '1/16', step: 1 / 16 },
  { id: '1/32', label: '1/32', step: 1 / 32 },
];

const BLACK_KEY_OFFSETS = new Set([1, 3, 6, 8, 10]);

export function isBlackKeyPitch(pitch) {
  return BLACK_KEY_OFFSETS.has(((Math.round(pitch) % 12) + 12) % 12);
}

export function pitchToLabel(pitch) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const p = Math.round(pitch);
  const octave = Math.floor(p / 12) - 1;
  return `${names[((p % 12) + 12) % 12]}${octave}`;
}

export function buildPitchRows(
  pitchMin = DEFAULT_PITCH_MIN,
  pitchMax = DEFAULT_PITCH_MAX,
  options = {},
) {
  const min = Math.min(pitchMin, pitchMax);
  const max = Math.max(pitchMin, pitchMax);
  const cLabelsOnly = options.cLabelsOnly === true;
  const rows = [];
  for (let pitch = max; pitch >= min; pitch -= 1) {
    const isBlack = isBlackKeyPitch(pitch);
    const isC = ((pitch % 12) + 12) % 12 === 0;
    rows.push({
      pitch,
      label: pitchToLabel(pitch),
      showLabel: !cLabelsOnly || isC,
      isBlack,
    });
  }
  return rows;
}

export function snapBar(value, step = PIANO_ROLL_GRID_STEP) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return 0;
  }
  const snapped = Math.round(value / step) * step;
  return Number(Math.max(0, snapped).toFixed(6));
}

export function createNoteId() {
  return `note_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * @param {number} clientX
 * @param {number} clientY
 * @param {DOMRect} gridRect
 * @param {{ totalBars: number, pitchMin: number, pitchMax: number, snapStep?: number }} config
 */
export function pointerToCell(clientX, clientY, gridRect, config) {
  const totalBars = Math.max(PIANO_ROLL_GRID_STEP, Number(config.totalBars) || 1);
  const pitchMin = config.pitchMin;
  const pitchMax = config.pitchMax;
  const snapStep = config.snapStep ?? PIANO_ROLL_GRID_STEP;

  const xRatio = clamp((clientX - gridRect.left) / Math.max(1, gridRect.width), 0, 0.9999);
  const yRatio = clamp((clientY - gridRect.top) / Math.max(1, gridRect.height), 0, 0.9999);

  const start = snapBar(xRatio * totalBars, snapStep);
  const rowIndex = Math.floor(yRatio * (pitchMax - pitchMin + 1));
  const pitch = clamp(pitchMax - rowIndex, pitchMin, pitchMax);

  return { start, pitch };
}

/**
 * @param {Array<object>} notes
 * @param {{ totalBars: number, pitchMin?: number, pitchMax?: number, barWidthPx?: number, rowHeightPx?: number }} options
 */
export function layoutNoteRects(notes, options = {}) {
  const totalBars = Math.max(PIANO_ROLL_GRID_STEP, Number(options.totalBars) || 1);
  const pitchMin = Number.isFinite(options.pitchMin) ? options.pitchMin : DEFAULT_PITCH_MIN;
  const pitchMax = Number.isFinite(options.pitchMax) ? options.pitchMax : DEFAULT_PITCH_MAX;
  const span = Math.max(1, pitchMax - pitchMin + 1);
  const barWidthPx = Number(options.barWidthPx) || PIANO_ROLL_BAR_WIDTH_PX;
  const rowHeightPx = Number(options.rowHeightPx) || PIANO_ROLL_ROW_HEIGHT_PX;
  const gridWidthPx = totalBars * barWidthPx;
  const gridHeightPx = span * rowHeightPx;

  if (!Array.isArray(notes)) {
    return [];
  }

  return notes
    .filter((note) => Number.isFinite(Number(note?.pitch)))
    .map((note, index) => {
      const pitch = Math.round(Number(note.pitch));
      if (pitch < pitchMin || pitch > pitchMax) {
        return null;
      }
      const start = Math.max(0, Number(note.start) || 0);
      const length = Math.max(PIANO_ROLL_GRID_STEP, Number(note.length) || PIANO_ROLL_GRID_STEP);
      const rowIndex = pitchMax - pitch;
      const leftPx = (start / totalBars) * gridWidthPx;
      const widthPx = (length / totalBars) * gridWidthPx;
      const topPx = rowIndex * rowHeightPx;
      const patternStart = Number.isFinite(Number(note.pattern_start))
        ? Number(note.pattern_start)
        : start;
      return {
        id: note.id || `note_${index + 1}`,
        pitch,
        start,
        length,
        patternStart,
        velocity: Number.isFinite(Number(note.velocity)) ? Number(note.velocity) : 0.8,
        leftPercent: (start / totalBars) * 100,
        widthPercent: Math.min(100 - (start / totalBars) * 100, (length / totalBars) * 100),
        topPercent: (rowIndex / span) * 100,
        heightPercent: 100 / span,
        leftPx,
        widthPx: Math.max(2, widthPx),
        topPx,
        heightPx: rowHeightPx - 2,
      };
    })
    .filter(Boolean);
}

export function noteOccupiesCell(note, pitch, start, snapStep) {
  const p = Math.round(Number(note?.pitch));
  const s = Number(note?.start) || 0;
  const len = Number(note?.length) || snapStep;
  if (p !== Math.round(pitch)) {
    return false;
  }
  return start >= s - 0.0001 && start < s + len - 0.0001;
}

export function findNoteAtCell(notes, pitch, start, snapStep = PIANO_ROLL_GRID_STEP) {
  return (notes || []).find((note) => noteOccupiesCell(note, pitch, start, snapStep)) || null;
}

export function hasNoteAtCell(notes, pitch, start, snapStep = PIANO_ROLL_GRID_STEP) {
  return Boolean(findNoteAtCell(notes, pitch, start, snapStep));
}

/**
 * @param {Array<object>} notes
 * @param {number} pitch
 * @param {number} start
 * @param {{ snapStep?: number, defaultLength?: number, velocity?: number }} options
 */
export function addNoteAtCell(notes, pitch, start, options = {}) {
  const snapStep = options.snapStep ?? PIANO_ROLL_GRID_STEP;
  const list = Array.isArray(notes) ? [...notes] : [];
  if (hasNoteAtCell(list, pitch, start, snapStep)) {
    return list;
  }
  list.push({
    id: createNoteId(),
    pitch: Math.round(pitch),
    start: snapBar(start, snapStep),
    length: Math.max(snapStep, options.defaultLength ?? snapStep * 4),
    velocity: options.velocity ?? 0.85,
  });
  return list;
}

export function removeNoteById(notes, noteId) {
  return (notes || []).filter((note) => String(note.id) !== String(noteId));
}

export function removeNotesByIds(notes, noteIds) {
  const removeSet = new Set((noteIds || []).map(String));
  if (removeSet.size === 0) {
    return notes || [];
  }
  return (notes || []).filter((note) => !removeSet.has(String(note.id)));
}

export function removeNotesAtCell(notes, pitch, start, snapStep = PIANO_ROLL_GRID_STEP) {
  return (notes || []).filter((note) => !noteOccupiesCell(note, pitch, start, snapStep));
}

export function toggleNoteAtCell(notes, pitch, start, options = {}) {
  const snapStep = options.snapStep ?? PIANO_ROLL_GRID_STEP;
  const existing = findNoteAtCell(notes, pitch, start, snapStep);
  if (existing) {
    return removeNoteById(notes, existing.id);
  }
  return addNoteAtCell(notes, pitch, start, options);
}

export function updateNotesById(notes, noteId, patch) {
  return (notes || []).map((note) => (
    String(note.id) === String(noteId) ? { ...note, ...patch } : note
  ));
}

export function moveNotes(notes, noteIds, deltaStart, deltaPitch, bounds = {}) {
  const idSet = new Set((noteIds || []).map(String));
  const pitchMin = bounds.pitchMin ?? 0;
  const pitchMax = bounds.pitchMax ?? 127;
  const maxStart = bounds.maxStart ?? Infinity;
  return (notes || []).map((note) => {
    if (!idSet.has(String(note.id))) {
      return note;
    }
    const start = Math.max(0, snapBar((Number(note.start) || 0) + deltaStart, bounds.snapStep));
    const pitch = clamp(Math.round((Number(note.pitch) || 0) + deltaPitch), pitchMin, pitchMax);
    if (start + (Number(note.length) || 0) > maxStart) {
      return { ...note, start: Math.max(0, maxStart - (Number(note.length) || 0)), pitch };
    }
    return { ...note, start, pitch };
  });
}

export function resizeNoteById(notes, noteId, newLength, snapStep = PIANO_ROLL_GRID_STEP) {
  const length = Math.max(snapStep, snapBar(newLength, snapStep));
  return updateNotesById(notes, noteId, { length });
}

/**
 * Hit-test note body or resize handle (right edge).
 */
export function hitTestNotes(clientX, clientY, gridRect, notes, config) {
  const rects = layoutNoteRects(notes, config);
  for (let i = rects.length - 1; i >= 0; i -= 1) {
    const rect = rects[i];
    const left = gridRect.left + rect.leftPx;
    const top = gridRect.top + rect.topPx;
    const width = rect.widthPx;
    const height = rect.heightPx;
      const handleWidth = getNoteResizeHandleWidthPx(width);
      const resizeZonePx = Math.max(handleWidth, Math.min(width * 0.4, width - 2));
      if (
        clientX >= left
        && clientX <= left + width + 2
        && clientY >= top
        && clientY <= top + height
      ) {
        const isResize = width > 4 && clientX >= left + width - resizeZonePx;
        return { noteId: rect.id, mode: isResize ? 'resize' : 'move' };
      }
  }
  return null;
}

/** @deprecated use pointerToCell */
export function pointerToNoteDraft(clientX, clientY, gridRect, config) {
  const cell = pointerToCell(clientX, clientY, gridRect, {
    totalBars: config.totalBars,
    pitchMin: config.pitchMin,
    pitchMax: config.pitchMax,
    snapStep: config.snapStep ?? PIANO_ROLL_GRID_STEP,
  });
  const snapStep = config.snapStep ?? PIANO_ROLL_GRID_STEP;
  const stepsPerBar = Math.max(1, config.stepsPerBar || DEFAULT_STEPS_PER_BAR);
  return {
    id: createNoteId(),
    pitch: cell.pitch,
    start: cell.start,
    length: Math.max(snapStep, snapBar(1 / (stepsPerBar / 4), snapStep) || 1 / 4),
    velocity: 0.85,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
