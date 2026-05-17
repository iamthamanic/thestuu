'use client';

/**
 * Memoized meter UI fragments — subscribe to meter-store only, not full shell state.
 * Location: apps/dashboard/components/daw — used by stuu-shell.jsx
 */

import { memo } from 'react';
import LevelMeter from '../LevelMeter.jsx';
import { useMeterPeak, useMixMasterPeak } from '../../lib/meter-store.js';

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

export const MixStripLevelMeter = memo(function MixStripLevelMeter({ trackId }) {
  const peak = useMeterPeak(trackId);
  return <LevelMeter variant="mix" value={clamp01(peak)} />;
});

export const MixMasterLevelMeter = memo(function MixMasterLevelMeter({ tracks }) {
  const peak = useMixMasterPeak(tracks);
  return <LevelMeter variant="mix" value={clamp01(peak)} />;
});

export const ArrangementTrackLevelMeter = memo(function ArrangementTrackLevelMeter({
  trackId,
  ariaLabel,
}) {
  const peak = useMeterPeak(trackId);
  return (
    <LevelMeter
      variant="arrangement"
      ariaLabel={ariaLabel}
      value={clamp01(peak)}
    />
  );
});

export const ArrangementTrackHotIndicator = memo(function ArrangementTrackHotIndicator({
  trackId,
  exists,
  children,
}) {
  const peak = useMeterPeak(trackId);
  const isHot = exists && peak > 0.12;
  return children(isHot);
});
