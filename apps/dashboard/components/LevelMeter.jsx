/**
 * Vertical peak meter (0–1): Mix strip (tall) or Arrangement row (compact).
 * FL-style ballistics: instant attack, exponential release toward the engine sample;
 * optional short peak-hold segment. Optional graded gradient via CSS modifiers.
 * Location: apps/dashboard/components — consumed by stuu-shell Mix + Arrangement meters.
 */

import { useEffect, useRef, useState } from 'react';

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
}) {
  const targetRef = useRef(0);
  const envelopeRef = useRef(0);
  const heldPeakRef = useRef(0);
  const holdUntilRef = useRef(0);
  const lastFrameTsRef = useRef(null);
  const lastEmitRef = useRef({ env: -1, held: -1 });

  const [paint, setPaint] = useState({ env: 0, held: 0 });

  targetRef.current = clamp01(value);

  useEffect(() => {
    if (!ballistics) {
      const v = targetRef.current;
      envelopeRef.current = v;
      heldPeakRef.current = v;
      setPaint({ env: v, held: v });
      return undefined;
    }

    const releaseTauSec = variant === 'arrangement' ? 0.11 : 0.18;
    let cancelled = false;
    let rafId = 0;

    const tick = (ts) => {
      if (cancelled) {
        return;
      }
      const now = ts ?? performance.now();
      const last = lastFrameTsRef.current;
      lastFrameTsRef.current = now;
      const dt = last == null ? 0 : Math.min(0.08, Math.max(0, (now - last) / 1000));

      const t = targetRef.current;
      let env = envelopeRef.current;
      if (t >= env) {
        env = t;
      } else if (dt > 0) {
        const k = 1 - Math.exp(-dt / releaseTauSec);
        env += (t - env) * k;
      }
      envelopeRef.current = env;

      let held = heldPeakRef.current;
      let holdUntil = holdUntilRef.current;
      if (peakHoldEnabled) {
        if (env >= held - 1e-5) {
          held = env;
          holdUntil = now + peakHoldMs;
        } else if (now >= holdUntil) {
          held = env;
        }
        heldPeakRef.current = held;
        holdUntilRef.current = holdUntil;
      } else {
        held = env;
        heldPeakRef.current = held;
      }

      const prev = lastEmitRef.current;
      if (
        Math.abs(env - prev.env) > 0.0015
        || Math.abs(held - prev.held) > 0.0015
        || (env < 0.025 && t < 0.025 && Math.abs(env - prev.env) > 1e-6)
      ) {
        lastEmitRef.current = { env, held };
        setPaint({ env, held });
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      lastFrameTsRef.current = null;
    };
  }, [ballistics, peakHoldEnabled, peakHoldMs, variant]);

  const v = ballistics ? paint.env : clamp01(value);
  const held = ballistics ? paint.held : v;
  const pct = toPct(v);
  const showPeakHold = peakHoldEnabled && ballistics && held > v + 0.004;

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
          style={{ bottom: `${Math.min(100, Math.max(0, held * 100)).toFixed(2)}%` }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
