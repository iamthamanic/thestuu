/**
 * Playhead highlight on pattern-local MIDI notes (FL-style).
 * Location: apps/dashboard/lib/playlist-bar-pulse.js
 */

import {
  floorPatternBarIndex,
  noteOverlapsPatternBar,
  resolvePatternBarAtPlayhead,
} from '@thestuu/shared-json';

export const PLAYHEAD_NOTE_ACTIVE_CLASS = 'is-playhead-bar-active';

/**
 * @param {HTMLElement} gridEl
 * @param {number | null | undefined} patternBarIndex — pattern-local bar, or null to clear
 */
export function syncPlayheadBarNotes(gridEl, patternBarIndex) {
  if (patternBarIndex == null || !Number.isFinite(Number(patternBarIndex))) {
    delete gridEl.dataset.activePlayheadBar;
    gridEl.querySelectorAll(`.piano-roll-note.${PLAYHEAD_NOTE_ACTIVE_CLASS}`).forEach((el) => {
      el.classList.remove(PLAYHEAD_NOTE_ACTIVE_CLASS);
    });
    return;
  }

  const bar = floorPatternBarIndex(patternBarIndex);
  gridEl.dataset.activePlayheadBar = String(bar);

  const notes = gridEl.querySelectorAll('.piano-roll-note:not(.piano-roll-note--draft)');
  for (const el of notes) {
    if (!(el instanceof HTMLElement)) {
      continue;
    }
    const patternStart = Number(el.dataset.patternStart);
    const length = Number(el.dataset.patternLength);
    if (!Number.isFinite(patternStart) || !Number.isFinite(length)) {
      el.classList.remove(PLAYHEAD_NOTE_ACTIVE_CLASS);
      continue;
    }
    el.classList.toggle(
      PLAYHEAD_NOTE_ACTIVE_CLASS,
      noteOverlapsPatternBar(patternStart, length, bar),
    );
  }
}

/**
 * @param {HTMLElement} gridEl
 */
function clearPlayheadBarNotes(gridEl) {
  syncPlayheadBarNotes(gridEl, null);
}

/**
 * @param {HTMLElement} gridEl
 * @param {number} playlistBar
 */
function syncGridPlayheadNotes(gridEl, playlistBar) {
  const clipStart = Number(gridEl.dataset.clipStartBars) || 0;
  const clipLength = Math.max(1 / 16, Number(gridEl.dataset.clipLengthBars) || 1);
  const patternLoop = Math.max(1 / 16, Number(gridEl.dataset.patternLoopBars) || 1);
  const patternBar = resolvePatternBarAtPlayhead({
    playlistBar,
    clipStartBars: clipStart,
    clipLengthBars: clipLength,
    patternLoopBars: patternLoop,
  });
  syncPlayheadBarNotes(gridEl, patternBar);
}

/**
 * Sync mini piano rolls in pattern clips with the global playhead.
 * @param {number} playlistBar — global timeline bars
 */
export function syncPianoRollClipBarPulses(playlistBar) {
  if (typeof document === 'undefined') {
    return;
  }
  const globalBars = Math.max(0, Number(playlistBar) || 0);
  const grids = document.querySelectorAll('.piano-roll-grid[data-bar-pulse="clip"]');
  for (const grid of grids) {
    if (!(grid instanceof HTMLElement)) {
      continue;
    }
    const start = Number(grid.dataset.clipStartBars) || 0;
    const length = Math.max(1 / 16, Number(grid.dataset.clipLengthBars) || 1);
    if (globalBars < start - 1e-6 || globalBars >= start + length - 1e-6) {
      clearPlayheadBarNotes(grid);
      continue;
    }
    syncGridPlayheadNotes(grid, globalBars);
  }
}
