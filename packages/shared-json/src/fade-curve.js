/**
 * Shared fade curve math — UI waveform, SVG path, and Tracktion curve type mapping.
 * Control point (u, v): u along fade width (0–1), v from clip top (0) to bottom (1) in fade triangle.
 */

export const FADE_CURVE_ORDER = Object.freeze(['linear', 'convex', 'concave', 'sCurve']);

const FADE_CURVES = new Set(FADE_CURVE_ORDER);

/** Normalized quadratic control (u, v) per Tracktion curve preset. */
const PRESET_CONTROL = Object.freeze({
  linear: { u: 0.52, v: 0.74 },
  convex: { u: 0.68, v: 0.94 },
  concave: { u: 0.35, v: 0.48 },
  sCurve: { u: 0.52, v: 0.62 },
});

export function normalizeFadeCurve(value) {
  const s = String(value ?? 'linear');
  if (s === 'scurve' || s === 'SCurve') return 'sCurve';
  return FADE_CURVES.has(s) ? s : 'linear';
}

export function controlFromCurveType(curve) {
  const key = normalizeFadeCurve(curve);
  return { ...PRESET_CONTROL[key] };
}

export function curveTypeFromControl(u, v) {
  const uu = clamp(Number(u) || 0, 0, 1);
  const vv = clamp(Number(v) || 0, 0, 1);
  let best = 'linear';
  let bestDist = Infinity;
  for (const name of FADE_CURVE_ORDER) {
    const preset = PRESET_CONTROL[name];
    const du = uu - preset.u;
    const dv = vv - preset.v;
    const dist = du * du + dv * dv;
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function quadBezierPoint(t, x0, y0, x1, y1, x2, y2) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  return {
    x: uu * x0 + 2 * u * t * x1 + tt * x2,
    y: uu * y0 + 2 * u * t * y1 + tt * y2,
  };
}

/** Invert quadratic bezier x(t) so gain follows horizontal position in the fade triangle (matches SVG). */
function solveBezierTForX(targetX, x0, y0, x1, y1, x2, y2) {
  const xAt = (t) => quadBezierPoint(t, x0, y0, x1, y1, x2, y2).x;
  const xStart = xAt(0);
  const xEnd = xAt(1);
  const increasing = xEnd >= xStart;
  const tx = clamp(targetX, Math.min(xStart, xEnd), Math.max(xStart, xEnd));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) * 0.5;
    const x = xAt(mid);
    if (increasing) {
      if (x < tx) lo = mid;
      else hi = mid;
    } else if (x > tx) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) * 0.5;
}

function readControlFromClip(clip, which) {
  const uKey = which === 'in' ? 'fade_in_cx' : 'fade_out_cx';
  const vKey = which === 'in' ? 'fade_in_cy' : 'fade_out_cy';
  const uAlt = which === 'in' ? 'fadeInCx' : 'fadeOutCx';
  const vAlt = which === 'in' ? 'fadeInCy' : 'fadeOutCy';
  const uRaw = clip?.[uKey] ?? clip?.[uAlt];
  const vRaw = clip?.[vKey] ?? clip?.[vAlt];
  if (Number.isFinite(Number(uRaw)) && Number.isFinite(Number(vRaw))) {
    return { u: clamp(Number(uRaw), 0, 1), v: clamp(Number(vRaw), 0, 1) };
  }
  const curve = normalizeFadeCurve(
    which === 'in'
      ? (clip?.fade_in_curve ?? clip?.fadeInCurve)
      : (clip?.fade_out_curve ?? clip?.fadeOutCurve),
  );
  return controlFromCurveType(curve);
}

/**
 * @param {'in'|'out'} which
 * @param {object} clip
 * @param {{ u?: number, v?: number, fadeInCurve?: string, fadeOutCurve?: string }} [draft]
 */
export function resolveFadeControl(which, clip, draft = null) {
  let control;
  if (draft) {
    if (which === 'in' && Number.isFinite(Number(draft.fadeInCx)) && Number.isFinite(Number(draft.fadeInCy))) {
      control = {
        u: clamp(Number(draft.fadeInCx), 0, 1),
        v: clamp(Number(draft.fadeInCy), 0, 1),
      };
    } else if (which === 'out' && Number.isFinite(Number(draft.fadeOutCx)) && Number.isFinite(Number(draft.fadeOutCy))) {
      control = {
        u: clamp(Number(draft.fadeOutCx), 0, 1),
        v: clamp(Number(draft.fadeOutCy), 0, 1),
      };
    } else if (Number.isFinite(Number(draft.u)) && Number.isFinite(Number(draft.v))) {
      control = { u: clamp(Number(draft.u), 0, 1), v: clamp(Number(draft.v), 0, 1) };
    } else {
      control = readControlFromClip(clip, which);
    }
  } else {
    control = readControlFromClip(clip, which);
  }
  const curve = curveTypeFromControl(control.u, control.v);
  return { ...control, curve };
}

function viewBoxControl(which, xSpan, u, v) {
  const uu = clamp(u, 0, 1);
  const vv = clamp(v, 0, 1);
  const cy = vv * 100;
  if (which === 'in') {
    return { cx: xSpan * uu, cy };
  }
  const xStart = 100 - xSpan;
  return { cx: xStart + xSpan * uu, cy };
}

/** SVG path for fade overlay (viewBox 0 0 100 100). */
export function buildFadeCurvePathD(which, fadePx, wrapWidthPx, u, v) {
  const wrapW = Math.max(1, Number(wrapWidthPx) || 1);
  const fadeW = Math.max(0, Number(fadePx) || 0);
  if (fadeW < 0.5) {
    return '';
  }
  const xSpan = Math.min(99, (fadeW / wrapW) * 100);
  const { cx, cy } = viewBoxControl(which, xSpan, u, v);
  if (which === 'in') {
    return `M 0 100 Q ${cx.toFixed(2)} ${cy.toFixed(2)}, ${xSpan.toFixed(2)} 0`;
  }
  const xStart = 100 - xSpan;
  return `M 100 100 Q ${cx.toFixed(2)} ${cy.toFixed(2)}, ${xStart.toFixed(2)} 0`;
}

/** Handle position (% of waveform wrap) — sits on the curve at t=0.5. */
export function getFadeCurveHandlePercent(which, fadePx, wrapWidthPx, u, v) {
  const wrapW = Math.max(1, Number(wrapWidthPx) || 1);
  const fadeW = Math.max(0, Number(fadePx) || 0);
  if (fadeW < 10) {
    return null;
  }
  const xSpan = Math.min(99, (fadeW / wrapW) * 100);
  const { cx, cy } = viewBoxControl(which, xSpan, u, v);
  if (which === 'in') {
    const pt = quadBezierPoint(0.5, 0, 100, cx, cy, xSpan, 0);
    return { leftPercent: pt.x, topPercent: pt.y };
  }
  const xStart = 100 - xSpan;
  const pt = quadBezierPoint(0.5, 100, 100, cx, cy, xStart, 0);
  return { leftPercent: pt.x, topPercent: pt.y };
}

/** Map pointer inside fade region to normalized control (u, v). */
export function controlFromPointerInFade(which, pointerX, pointerY, fadeWidthPx, regionHeightPx) {
  const w = Math.max(1, Number(fadeWidthPx) || 1);
  const h = Math.max(1, Number(regionHeightPx) || 1);
  const localX = clamp(pointerX, 0, w);
  const localY = clamp(pointerY, 0, h);
  const u = localX / w;
  const v = localY / h;
  if (which === 'out') {
    return { u: 1 - u, v };
  }
  return { u, v };
}

export function applyFadeCurveT(t, curve) {
  const clamped = clamp(t, 0, 1);
  switch (normalizeFadeCurve(curve)) {
    case 'convex':
      return clamped * clamped;
    case 'concave':
      return Math.sqrt(clamped);
    case 'sCurve':
      return clamped * clamped * (3 - 2 * clamped);
    default:
      return clamped;
  }
}

/**
 * Gain 0–1 for fade-in at horizontal position localX 0–1 across the fade region.
 * localX is timeline progress through the fade (not the bezier parameter t).
 */
export function gainAtFadeInLocal(localX, u, v) {
  const cx = clamp(u, 0, 1);
  const cy = clamp(v, 0, 1);
  const t = solveBezierTForX(clamp(localX, 0, 1), 0, 1, cx, cy, 1, 0);
  const pt = quadBezierPoint(t, 0, 1, cx, cy, 1, 0);
  return clamp(1 - pt.y, 0, 1);
}

/**
 * Gain multiplier for fade-out at horizontal position localX 0–1
 * (0 = clip end / silent, 1 = start of fade-out / full level).
 */
export function gainAtFadeOutLocal(localX, u, v) {
  const cx = 1 - clamp(u, 0, 1);
  const cy = clamp(v, 0, 1);
  // Fade-out bezier runs x: 1→0 as localX goes 0 (clip end) → 1 (fade start).
  const targetX = 1 - clamp(localX, 0, 1);
  const t = solveBezierTForX(targetX, 1, 1, cx, cy, 0, 0);
  const pt = quadBezierPoint(t, 1, 1, cx, cy, 0, 0);
  return clamp(1 - pt.y, 0, 1);
}

export function getFadeEnvelopeAtX(progress, fadeInFrac, fadeOutFrac, fadeInControl, fadeOutControl) {
  let env = 1;
  const p = clamp(progress, 0, 1);
  if (fadeInFrac > 0 && p < fadeInFrac) {
    const localT = p / fadeInFrac;
    env = gainAtFadeInLocal(localT, fadeInControl.u, fadeInControl.v);
  }
  if (fadeOutFrac > 0 && p > 1 - fadeOutFrac) {
    const localT = (1 - p) / fadeOutFrac;
    env *= gainAtFadeOutLocal(localT, fadeOutControl.u, fadeOutControl.v);
  }
  return clamp(env, 0, 1);
}
