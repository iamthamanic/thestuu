/**
 * Vertical peak meter (0–1): Mix strip (tall) or Arrangement row (compact).
 * FL-style ballistics via shared MeterAnimator (single rAF for all meters).
 * Location: apps/dashboard/components — consumed by stuu-shell Mix + Arrangement meters.
 */

import { useEffect, useRef, useState } from 'react';
import { registerMeterAnimator } from '../lib/meter-animator.js';
import { levelMeterLightMode, getPerformanceProfile } from '../lib/performance-prefs.js';

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function toPct(x) {
  return Math.round(Math.min(100, Math.max(0, x * 100)));
}

export default function LevelMeter({
  value,
  variant = 'mix',
  graded = true,
  ariaLabel = undefined,
  ballistics = true,
  peakHoldEnabled = true,
  peakHoldMs = 750,
  light = undefined,
}) {
  const targetRef = useRef(0);
  const registrationIdRef = useRef({});
  const [paint, setPaint] = useState({ env: 0, held: 0 });

  const perfLight = light ?? levelMeterLightMode(getPerformanceProfile());
  const useBallistics = ballistics && !perfLight;
  const usePeakHold = peakHoldEnabled && !perfLight;

  targetRef.current = clamp01(value);

  useEffect(() => {
    if (!useBallistics) {
      const v = targetRef.current;
      setPaint({ env: v, held: v });
      return undefined;
    }

    return registerMeterAnimator(registrationIdRef.current, {
      getTarget: () => targetRef.current,
      setPaint: (env, held) => setPaint({ env, held }),
      variant,
      peakHoldEnabled: usePeakHold,
      peakHoldMs,
    });
  }, [useBallistics, usePeakHold, peakHoldMs, variant]);

  const v = useBallistics ? paint.env : clamp01(value);
  const held = useBallistics ? paint.held : v;
  const pct = toPct(v);
  const showPeakHold = usePeakHold && useBallistics && held > v + 0.004;

  const wrapClass = variant === 'arrangement' ? 'arrangement-track-meter' : 'mix-strip-meter';
  const fillClass =
    variant === 'arrangement'
      ? `arrangement-track-meter-fill${graded ? ' arrangement-track-meter-fill--graded' : ''}`
      : `mix-strip-meter-fill${graded ? ' mix-strip-meter-fill--graded' : ''}`;

  const a11y =
    variant === 'arrangement' && typeof ariaLabel === 'string' && ariaLabel.trim()
      ? { role: 'img', 'aria-label': ariaLabel.trim() }
      : {};

  return (
    <div className={wrapClass} {...a11y}>
      <div className={fillClass} style={{ height: `${pct}%` }} />
      {showPeakHold ? (
        <div
          className="level-meter-peak-hold"
          style={{ bottom: `${toPct(held)}%` }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
