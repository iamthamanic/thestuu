/**
 * Mix-tab mini playlist overview: composite waveform + synced scrubbable playhead.
 * Location: apps/dashboard/components — rendered in stuu-shell.jsx transport strip (Mix only).
 */

import { forwardRef, useCallback, useMemo } from 'react';
import { getWaveformPolygonPoints } from '../lib/playlist-overview-peaks';

const OVERVIEW_WIDTH_PX = 280;
const OVERVIEW_HEIGHT_PX = 28;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const MixPlaylistOverview = forwardRef(function MixPlaylistOverview({
  peaks = [],
  maxClipEndBars = 0,
  onSeekBars,
  onSeekEnd,
  ariaLabel = 'Playlist-Übersicht',
}, ref) {
  const polygonPoints = useMemo(() => getWaveformPolygonPoints(peaks), [peaks]);
  const hasWaveform = polygonPoints.length > 0;

  const seekFromPointer = useCallback((event) => {
    const root = ref?.current;
    if (!root || typeof onSeekBars !== 'function') {
      return null;
    }
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) {
      return null;
    }
    const safeEnd = Math.max(0.001, Number(maxClipEndBars) || 0);
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const rawBars = ratio * safeEnd;
    onSeekBars(rawBars, { shiftKey: Boolean(event.shiftKey) });
    return rawBars;
  }, [maxClipEndBars, onSeekBars, ref]);

  const handlePointerDown = useCallback((event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    seekFromPointer(event);

    const handleMove = (moveEvent) => {
      seekFromPointer(moveEvent);
    };
    const handleUp = (upEvent) => {
      seekFromPointer(upEvent);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      if (typeof onSeekEnd === 'function') {
        onSeekEnd();
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }, [onSeekEnd, seekFromPointer]);

  return (
    <div
      ref={ref}
      className="mix-playlist-overview"
      style={{ width: OVERVIEW_WIDTH_PX, height: OVERVIEW_HEIGHT_PX }}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, Number(maxClipEndBars) || 0)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
    >
      <svg
        className="mix-playlist-overview-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line className="mix-playlist-overview-center" x1="0" y1="50" x2="100" y2="50" />
        {hasWaveform ? (
          <polygon className="mix-playlist-overview-shape" points={polygonPoints} />
        ) : null}
      </svg>
      <div className="mix-playlist-overview-playhead" aria-hidden="true" />
    </div>
  );
});

export default MixPlaylistOverview;
