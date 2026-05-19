import test from 'node:test';
import assert from 'node:assert/strict';
import {
  curveTypeFromControl,
  controlFromCurveType,
  resolveFadeControl,
  buildFadeCurvePathD,
  gainAtFadeInLocal,
  gainAtFadeOutLocal,
} from '../src/fade-curve.js';

test('controlFromCurveType round-trips through curveTypeFromControl', () => {
  for (const name of ['linear', 'convex', 'concave', 'sCurve']) {
    const { u, v } = controlFromCurveType(name);
    assert.equal(curveTypeFromControl(u, v), name);
  }
});

test('resolveFadeControl uses clip cx/cy when present', () => {
  const clip = {
    fade_in_curve: 'linear',
    fade_in_cx: 0.2,
    fade_in_cy: 0.9,
  };
  const resolved = resolveFadeControl('in', clip);
  assert.equal(resolved.u, 0.2);
  assert.equal(resolved.v, 0.9);
});

test('buildFadeCurvePathD returns path for valid fade', () => {
  const path = buildFadeCurvePathD('in', 80, 200, 0.52, 0.74);
  assert.ok(path.startsWith('M 0 100 Q'));
});

test('gainAtFadeInLocal is ~0 at fade start and ~1 at fade end', () => {
  const u = 0.68;
  const v = 0.94;
  assert.ok(gainAtFadeInLocal(0, u, v) < 0.02);
  assert.ok(gainAtFadeInLocal(1, u, v) > 0.98);
});

test('gainAtFadeOutLocal is ~1 at fade start and ~0 at clip end', () => {
  const u = 0.52;
  const v = 0.74;
  assert.ok(gainAtFadeOutLocal(1, u, v) > 0.98);
  assert.ok(gainAtFadeOutLocal(0, u, v) < 0.02);
});
