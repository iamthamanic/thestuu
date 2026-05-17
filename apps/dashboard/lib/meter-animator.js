/**
 * Single requestAnimationFrame loop for all registered level meters (replaces per-LevelMeter rAF).
 * Location: apps/dashboard/lib — used by LevelMeter.jsx
 */

/** @type {Map<object, { getTarget: () => number, setPaint: (env: number, held: number) => void, variant: string, peakHoldEnabled: boolean, peakHoldMs: number, state: { envelope: number, held: number, holdUntil: number, lastTs: number | null, lastEmit: { env: number, held: number } } }>} */
const registrations = new Map();
let rafId = 0;
let running = false;

const releaseTauByVariant = {
  arrangement: 0.11,
  mix: 0.18,
};

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function tick(ts) {
  if (registrations.size === 0) {
    running = false;
    rafId = 0;
    return;
  }

  const now = ts ?? performance.now();
  registrations.forEach((entry) => {
    const state = entry.state;
    const t = clamp01(entry.getTarget());
    const releaseTauSec = releaseTauByVariant[entry.variant] ?? 0.18;
    const last = state.lastTs;
    state.lastTs = now;
    const dt = last == null ? 0 : Math.min(0.08, Math.max(0, (now - last) / 1000));

    let env = state.envelope;
    if (t >= env) {
      env = t;
    } else if (dt > 0) {
      const k = 1 - Math.exp(-dt / releaseTauSec);
      env += (t - env) * k;
    }
    state.envelope = env;

    let held = state.held;
    if (entry.peakHoldEnabled) {
      if (env >= held - 1e-5) {
        held = env;
        state.holdUntil = now + entry.peakHoldMs;
      } else if (now >= state.holdUntil) {
        held = env;
      }
    } else {
      held = env;
    }
    state.held = held;

    const prev = state.lastEmit;
    if (
      Math.abs(env - prev.env) > 0.0015
      || Math.abs(held - prev.held) > 0.0015
      || (env < 0.025 && t < 0.025 && Math.abs(env - prev.env) > 1e-6)
    ) {
      state.lastEmit = { env, held };
      entry.setPaint(env, held);
    }
  });

  rafId = requestAnimationFrame(tick);
}

function ensureRunning() {
  if (!running && registrations.size > 0) {
    running = true;
    rafId = requestAnimationFrame(tick);
  }
}

/**
 * @param {object} id Stable registration id (e.g. useRef object).
 * @param {{ getTarget: () => number, setPaint: (env: number, held: number) => void, variant?: string, peakHoldEnabled?: boolean, peakHoldMs?: number }} handlers
 */
export function registerMeterAnimator(id, handlers) {
  registrations.set(id, {
    getTarget: handlers.getTarget,
    setPaint: handlers.setPaint,
    variant: handlers.variant || 'mix',
    peakHoldEnabled: handlers.peakHoldEnabled !== false,
    peakHoldMs: handlers.peakHoldMs ?? 750,
    state: {
      envelope: 0,
      held: 0,
      holdUntil: 0,
      lastTs: null,
      lastEmit: { env: -1, held: -1 },
    },
  });
  ensureRunning();
  return () => {
    registrations.delete(id);
    if (registrations.size === 0 && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
      running = false;
    }
  };
}
