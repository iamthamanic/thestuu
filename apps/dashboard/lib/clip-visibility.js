/**
 * Clip and track visibility helpers for arrangement virtualization (viewport culling).
 * Location: apps/dashboard/lib — used by stuu-shell arrangement rendering.
 */

const DEFAULT_BAR_BUFFER = 4;

/**
 * @param {{ start?: number, length?: number }} clip
 * @param {number} viewStartBars
 * @param {number} viewEndBars
 */
export function clipIntersectsViewport(clip, viewStartBars, viewEndBars) {
  const start = Number(clip?.start);
  const length = Number(clip?.length);
  if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) {
    return true;
  }
  const end = start + length;
  return end >= viewStartBars && start <= viewEndBars;
}

/**
 * Visible bar range from horizontal scroll (Edit tab timeline).
 * @param {number} scrollLeftPx
 * @param {number} clientWidthPx
 * @param {number} barWidthPx
 * @param {number} [bufferBars]
 */
export function getVisibleBarRange(scrollLeftPx, clientWidthPx, barWidthPx, bufferBars = DEFAULT_BAR_BUFFER) {
  const bw = Number.isFinite(barWidthPx) && barWidthPx > 0 ? barWidthPx : 48;
  const start = Math.max(0, scrollLeftPx / bw - bufferBars);
  const end = (scrollLeftPx + Math.max(0, clientWidthPx)) / bw + bufferBars;
  return { start, end };
}

/**
 * Track row visible in vertical scroll container.
 * @param {number} trackIndex
 * @param {number} rowHeightPx
 * @param {number} scrollTopPx
 * @param {number} clientHeightPx
 * @param {number} [bufferRows]
 */
export function trackRowIntersectsViewport(trackIndex, rowHeightPx, scrollTopPx, clientHeightPx, bufferRows = 2) {
  const rh = Number.isFinite(rowHeightPx) && rowHeightPx > 0 ? rowHeightPx : 56;
  const top = trackIndex * rh;
  const bottom = top + rh;
  const viewTop = scrollTopPx - bufferRows * rh;
  const viewBottom = scrollTopPx + clientHeightPx + bufferRows * rh;
  return bottom >= viewTop && top <= viewBottom;
}
