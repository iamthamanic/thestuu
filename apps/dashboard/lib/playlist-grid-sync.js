/**
 * Playlist grid alignment for pattern clips (timeline bar width + phase offset).
 * Time mapping: @thestuu/shared-json pattern-timeline-map.js
 * Location: apps/dashboard/lib/playlist-grid-sync.js
 */

export { expandPatternNotesForClipLength } from '@thestuu/shared-json';

/**
 * Horizontal offset so vertical grid lines inside a clip line up with the arrangement grid.
 * @param {number} clipStartBars — playlist position where the clip begins
 * @param {number} barWidthPx — timeline --bar-width in pixels
 */
export function playlistGridPhaseOffsetPx(clipStartBars, barWidthPx) {
  const width = Number(barWidthPx);
  if (!Number.isFinite(width) || width <= 0) {
    return 0;
  }
  const start = Number(clipStartBars) || 0;
  const frac = ((start % 1) + 1) % 1;
  if (frac < 1e-9) {
    return 0;
  }
  return (1 - frac) * width;
}

/**
 * 1-based bar labels for mini ruler (playlist song bars, not pattern 1..n).
 * @param {number} clipStartBars
 * @param {number} clipLengthBars
 * @returns {number[]}
 */
export function playlistRulerBarLabels(clipStartBars, clipLengthBars) {
  const start = Number(clipStartBars) || 0;
  const len = Math.max(1, Math.round(Number(clipLengthBars) || 1));
  const frac = ((start % 1) + 1) % 1;
  const first = frac < 1e-9
    ? Math.floor(start) + 1
    : Math.ceil(start) + 1;
  return Array.from({ length: len }, (_, index) => first + index);
}
