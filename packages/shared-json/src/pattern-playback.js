/**
 * Pattern playback scheduling (FL-style: playlist clip → pattern notes at playhead).
 * Pure functions — shared by dashboard preview audio and future native sync.
 * Location: packages/shared-json/src/pattern-playback.js
 */

import {
  isPlayheadInsideClip,
  patternBarAtPlayhead,
  PATTERN_GRID_STEP,
  resolvePatternBarAtPlayhead,
} from './pattern-timeline-map.js';

const GRID_STEP = PATTERN_GRID_STEP;
const STEPS_PER_BAR = 16;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function getClipPatternId(clip) {
  if (!isObject(clip)) {
    return null;
  }
  if (isNonEmptyString(clip.pattern_id)) {
    return clip.pattern_id.trim();
  }
  if (isNonEmptyString(clip.patternId)) {
    return clip.patternId.trim();
  }
  if (isNonEmptyString(clip.pattern)) {
    return clip.pattern.trim();
  }
  return null;
}

/** Pattern loop length in bars (16 steps = 1 bar). */
export function patternLoopBars(pattern) {
  const steps = Math.max(4, Math.round(Number(pattern?.length) || STEPS_PER_BAR));
  return Math.max(GRID_STEP, steps / STEPS_PER_BAR);
}

/**
 * @param {Array<object>} playlist
 * @returns {Array<{ trackId: number, clipId: string, patternId: string, start: number, length: number }>}
 */
export function collectPatternClipInstances(playlist) {
  const instances = [];
  if (!Array.isArray(playlist)) {
    return instances;
  }
  for (const track of playlist) {
    const trackId = Number(track?.track_id);
    if (!Number.isInteger(trackId) || trackId < 1) {
      continue;
    }
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    for (const clip of clips) {
      const patternId = getClipPatternId(clip);
      if (!patternId || !isNonEmptyString(clip?.id)) {
        continue;
      }
      const start = Math.max(0, Number(clip.start) || 0);
      const length = Math.max(GRID_STEP, Number(clip.length) || 1);
      instances.push({
        trackId,
        clipId: String(clip.id),
        patternId,
        start,
        length,
      });
    }
  }
  return instances;
}

export { isPlayheadInsideClip, patternBarAtPlayhead as clipLocalPatternBar } from './pattern-timeline-map.js';

/**
 * Note-on events when playhead crosses note starts (pattern-local bars).
 * @param {Array<object>} notes
 * @param {number} prevLocalBar
 * @param {number} nextLocalBar
 * @param {number} loopBars
 * @returns {Array<object>}
 */
export function scanPatternNoteOnEvents(notes, prevLocalBar, nextLocalBar, loopBars) {
  if (!Array.isArray(notes) || notes.length === 0) {
    return [];
  }
  const loop = Math.max(GRID_STEP, Number(loopBars) || 1);
  const prev = Math.max(0, Number(prevLocalBar) || 0);
  const next = Math.max(0, Number(nextLocalBar) || 0);
  if (next <= prev) {
    return [];
  }

  const events = [];
  const span = next - prev;
  const loopCount = span > loop ? Math.ceil(span / loop) : 1;

  for (let lap = 0; lap < loopCount; lap += 1) {
    const lapPrev = lap === 0 ? prev : 0;
    const lapNext = lap === loopCount - 1 ? next : loop;
    for (const note of notes) {
      const pitch = Math.round(Number(note?.pitch));
      if (!Number.isFinite(pitch)) {
        continue;
      }
      const start = Number(note?.start) || 0;
      if (start >= lapPrev && start < lapNext) {
        events.push(note);
      }
    }
  }
  return events;
}

/**
 * Active pattern clips at timeline position + note-ons since previous position.
 * @param {{
 *   playlist: Array<object>,
 *   patternsById: Map<string, object>,
 *   positionBars: number,
 *   prevPositionBars: number,
 * }} input
 * @returns {Array<{ trackId: number, patternId: string, note: object }>}
 */
export function schedulePatternNoteOns({
  playlist,
  patternsById,
  positionBars,
  prevPositionBars,
}) {
  const hits = [];
  const instances = collectPatternClipInstances(playlist);

  for (const inst of instances) {
    if (!isPlayheadInsideClip(positionBars, inst.start, inst.length)) {
      continue;
    }

    const pattern = patternsById.get(inst.patternId);
    if (!pattern) {
      continue;
    }
    const notes = Array.isArray(pattern.notes) ? pattern.notes : [];
    const loopBars = patternLoopBars(pattern);

    let prevLocal = patternBarAtPlayhead(prevPositionBars, inst.start, loopBars);
    const nextLocal = patternBarAtPlayhead(positionBars, inst.start, loopBars);
    if (nextLocal == null) {
      continue;
    }
    if (prevLocal == null) {
      prevLocal = Math.max(0, nextLocal - GRID_STEP);
    }

    const noteOns = scanPatternNoteOnEvents(notes, prevLocal, nextLocal, loopBars);
    for (const note of noteOns) {
      hits.push({ trackId: inst.trackId, patternId: inst.patternId, note });
    }
  }

  return hits;
}

/**
 * @param {number} positionBars
 * @param {number} clipStartBars
 * @param {number} clipLengthBars
 * @param {number} patternLoopBars
 * @returns {number | null}
 */
export function pianoRollPlayheadBar(positionBars, clipStartBars, clipLengthBars, patternLoopBars) {
  return resolvePatternBarAtPlayhead({
    playlistBar: positionBars,
    clipStartBars,
    clipLengthBars,
    patternLoopBars,
  });
}
