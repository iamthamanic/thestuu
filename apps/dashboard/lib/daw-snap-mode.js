/**
 * Playlist / piano-roll snap modes (Free, Auto, Line, Cell, Beat, Bar).
 * Location: apps/dashboard/lib/daw-snap-mode.js
 */

export const GRID_STEP = 1 / 16;
export const SLICE_FREE_STEP = 1 / 256;

export const DEFAULT_SNAP_MODE = 'free';

export const SNAP_MODE_OPTIONS = [
  { id: 'free', label: 'Free' },
  { id: 'auto', label: 'Auto' },
  { id: 'line', label: 'Line' },
  { id: 'cell', label: 'Cell' },
  { id: 'half_beat', label: '1/2 Beat' },
  { id: 'beat', label: 'Beat' },
  { id: 'bar', label: 'Bar' },
];

export function normalizeSnapMode(value) {
  const resolved = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (SNAP_MODE_OPTIONS.some((option) => option.id === resolved)) {
    return resolved;
  }
  return DEFAULT_SNAP_MODE;
}

export function resolveAutoSnapStep(barWidth) {
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

export function resolveGridLineDensity(barWidth) {
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

export function resolveSnapStep(snapMode, barWidth, gridLineDensity) {
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

/** Human-readable grid step for toolbar readout (e.g. 1/16, Bar). */
export function formatSnapStepLabel(step) {
  const value = Number(step);
  if (!Number.isFinite(value) || value <= 0) {
    return '—';
  }
  if (value >= 1) {
    return value === 1 ? 'Bar' : `${value} bars`;
  }
  const denom = Math.round(1 / value);
  if (denom > 0 && Math.abs(value - 1 / denom) < 0.0001) {
    return `1/${denom}`;
  }
  return value.toFixed(3);
}
