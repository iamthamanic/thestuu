/**
 * FL-style pattern ↔ playlist time mapping (single source of truth).
 * Pattern notes are pattern-local; clips only place patterns on the timeline.
 * Location: packages/shared-json/src/pattern-timeline-map.js
 */

export const PATTERN_GRID_STEP = 1 / 16;

/**
 * @param {number} bars
 * @returns {number}
 */
export function floorPatternBarIndex(bars) {
  return Math.floor(Math.max(0, Number(bars) || 0));
}

/**
 * @param {number} playlistBar
 * @param {number} clipStartBars
 * @returns {number | null}
 */
export function clipOffsetBars(playlistBar, clipStartBars) {
  const pos = Number(playlistBar);
  const start = Number(clipStartBars) || 0;
  if (!Number.isFinite(pos)) {
    return null;
  }
  const offset = pos - start;
  return offset < 0 ? null : Number(offset.toFixed(6));
}

/**
 * @param {number} playlistBar
 * @param {number} clipStartBars
 * @param {number} clipLengthBars
 * @returns {boolean}
 */
export function isPlayheadInsideClip(playlistBar, clipStartBars, clipLengthBars) {
  const offset = clipOffsetBars(playlistBar, clipStartBars);
  if (offset == null) {
    return false;
  }
  const len = Math.max(PATTERN_GRID_STEP, Number(clipLengthBars) || 1);
  return offset < len - 1e-9;
}

/**
 * Pattern-local bar under playhead (loop wrap), 0 … patternLoopBars.
 * @param {number} playlistBar
 * @param {number} clipStartBars
 * @param {number} patternLoopBars
 * @returns {number | null}
 */
export function patternBarAtPlayhead(playlistBar, clipStartBars, patternLoopBars) {
  const offset = clipOffsetBars(playlistBar, clipStartBars);
  if (offset == null) {
    return null;
  }
  const loop = Math.max(PATTERN_GRID_STEP, Number(patternLoopBars) || 1);
  const wrapped = offset % loop;
  return Number(wrapped.toFixed(6));
}

/** @deprecated Use patternBarAtPlayhead */
export const clipLocalPatternBar = patternBarAtPlayhead;

/**
 * @param {{
 *   playlistBar: number,
 *   clipStartBars: number,
 *   clipLengthBars: number,
 *   patternLoopBars: number,
 * }} input
 * @returns {number | null}
 */
export function resolvePatternBarAtPlayhead({
  playlistBar,
  clipStartBars,
  clipLengthBars,
  patternLoopBars,
}) {
  if (!isPlayheadInsideClip(playlistBar, clipStartBars, clipLengthBars)) {
    return null;
  }
  return patternBarAtPlayhead(playlistBar, clipStartBars, patternLoopBars);
}

/**
 * @param {number} noteStart — pattern-local
 * @param {number} noteLength
 * @param {number} patternBarIndex — 0-based pattern bar
 * @returns {boolean}
 */
export function noteOverlapsPatternBar(noteStart, noteLength, patternBarIndex) {
  const start = Number(noteStart) || 0;
  const len = Math.max(PATTERN_GRID_STEP, Number(noteLength) || PATTERN_GRID_STEP);
  const barStart = patternBarIndex;
  const barEnd = patternBarIndex + 1;
  return start < barEnd - 1e-9 && start + len > barStart + 1e-9;
}

/**
 * Repeat pattern notes for a longer playlist clip (display only). Keeps pattern_start for sync.
 * @param {Array<object>} notes
 * @param {number} patternLoopBars
 * @param {number} clipLengthBars
 * @returns {Array<object>}
 */
export function expandPatternNotesForClipLength(notes, patternLoopBars, clipLengthBars) {
  const loop = Math.max(PATTERN_GRID_STEP, Number(patternLoopBars) || 1);
  const clipLen = Math.max(loop, Number(clipLengthBars) || loop);
  if (!Array.isArray(notes) || notes.length === 0) {
    return [];
  }
  const expanded = [];
  for (const note of notes) {
    const patternStart = Number(note?.start) || 0;
    if (patternStart < 0 || patternStart >= loop) {
      continue;
    }
    for (let offset = 0; offset < clipLen - 1e-9; offset += loop) {
      const clipLocalStart = patternStart + offset;
      if (clipLocalStart >= clipLen) {
        break;
      }
      if (offset === 0) {
        expanded.push({
          ...note,
          pattern_start: patternStart,
          start: clipLocalStart,
        });
      } else {
        expanded.push({
          ...note,
          id: `${note.id || 'note'}@o${Math.round(offset * 1024)}`,
          pattern_start: patternStart,
          start: clipLocalStart,
        });
      }
    }
  }
  return expanded;
}
