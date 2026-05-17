/**
 * DAW authority guardrails — unit tests (no native process required).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JSON_ONLY_CLIP_FIELDS,
  NATIVE_AUTHORITATIVE_CLIP_FIELDS,
  assertDirectArrangementMutationAllowed,
  assertJsonProjectHistoryAllowed,
  assertLegacyJsonArrangementAllowed,
  isNativeArrangementAuthorityEnabled,
  runDuringNativeReconcileSync,
  shouldUseJsonProjectHistory,
} from '../src/daw-authority.js';
import { mergeAuthoritativeProjectState } from '../src/authoritative-merge.js';

const ENV_KEYS = [
  'STUU_NATIVE_CLIP_OPS',
  'STUU_NATIVE_TRACK_OPS',
  'STUU_NATIVE_EDIT_UNDO',
  'DAW_AUTHORITY_STRICT',
  'NODE_ENV',
];

function saveEnv() {
  const snapshot = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

function clearNativeFlags() {
  delete process.env.STUU_NATIVE_CLIP_OPS;
  delete process.env.STUU_NATIVE_TRACK_OPS;
  delete process.env.STUU_NATIVE_EDIT_UNDO;
}

test('JSON_ONLY_CLIP_FIELDS excludes arrangement fields', () => {
  for (const field of NATIVE_AUTHORITATIVE_CLIP_FIELDS) {
    assert.equal(JSON_ONLY_CLIP_FIELDS.includes(field), false, `sidecar must not include ${field}`);
  }
  assert.ok(JSON_ONLY_CLIP_FIELDS.includes('gain'));
  assert.ok(JSON_ONLY_CLIP_FIELDS.includes('fade_in'));
});

test('assertLegacyJsonArrangementAllowed throws when native clip ops enabled', () => {
  const snap = saveEnv();
  try {
    process.env.STUU_NATIVE_CLIP_OPS = '1';
    assert.throws(
      () => assertLegacyJsonArrangementAllowed('clip:resize'),
      /legacy JSON arrangement path is disabled/,
    );
  } finally {
    restoreEnv(snap);
  }
});

test('assertDirectArrangementMutationAllowed allows writes during native reconcile', () => {
  const snap = saveEnv();
  try {
    clearNativeFlags();
    process.env.STUU_NATIVE_CLIP_OPS = '1';
    process.env.NODE_ENV = 'development';
    process.env.DAW_AUTHORITY_STRICT = '1';
    assert.equal(isNativeArrangementAuthorityEnabled(), true);
    assert.throws(
      () => assertDirectArrangementMutationAllowed('clip.start = x'),
      /direct Node arrangement mutation blocked/,
    );
    runDuringNativeReconcileSync(() => {
      assert.doesNotThrow(() => assertDirectArrangementMutationAllowed('reconcile clip.start'));
    });
    assert.throws(
      () => assertDirectArrangementMutationAllowed('clip.start = x after reconcile'),
      /direct Node arrangement mutation blocked/,
    );
  } finally {
    restoreEnv(snap);
  }
});

test('assertJsonProjectHistoryAllowed blocks when native undo enabled', () => {
  const snap = saveEnv();
  try {
    clearNativeFlags();
    process.env.STUU_NATIVE_EDIT_UNDO = '1';
    assert.equal(shouldUseJsonProjectHistory(), false);
    assert.throws(
      () => assertJsonProjectHistoryAllowed('projectHistory.undo.push'),
      /JSON projectHistory is disabled/,
    );
  } finally {
    restoreEnv(snap);
  }
});

test('mergeAuthoritativeProjectState keeps JSON clip start when native export reports 0', () => {
  const jsonProject = {
    bpm: 120,
    playlist: [{
      track_id: 1,
      name: 'Track 1',
      clips: [{
        id: 'clip_test_1',
        type: 'audio',
        start: 4.55,
        length: 8,
        source_path: '/tmp/test-audio.mp3',
        gain: 0.9,
        fade_in: 0.1,
      }],
    }],
    mixer: [{ track_id: 1, volume: 0.85, pan: 0, mute: false, solo: false }],
    patterns: [],
    nodes: [],
  };
  const nativeExport = {
    tracks: [{ track_id: 1, name: 'Track 1' }],
    clips: [{
      track_id: 1,
      source_path: '/tmp/test-audio.mp3',
      start_seconds: 0,
      length_seconds: 16,
    }],
    mixer: [{ track_id: 1, volume: 0.85, pan: 0, mute: false, solo: false }],
  };
  const merged = mergeAuthoritativeProjectState(jsonProject, nativeExport);
  const audio = merged.playlist[0].clips.find((c) => c.type === 'audio');
  assert.ok(audio);
  assert.equal(audio.id, 'clip_test_1');
  assert.ok(Math.abs(Number(audio.start) - 4.55) < 0.01, `expected JSON start preserved, got ${audio.start}`);
  assert.equal(audio.gain, 0.9);
  assert.equal(audio.fade_in, 0.1);
});

test('mergeAuthoritativeProjectState uses native start when JSON has no match', () => {
  const jsonProject = {
    bpm: 120,
    playlist: [{ track_id: 1, name: 'Track 1', clips: [] }],
    mixer: [],
    patterns: [],
    nodes: [],
  };
  const nativeExport = {
    tracks: [{ track_id: 1, name: 'Track 1' }],
    clips: [{
      track_id: 1,
      source_path: '/tmp/only-native.mp3',
      start_seconds: 2,
      length_seconds: 4,
    }],
    mixer: [],
  };
  const merged = mergeAuthoritativeProjectState(jsonProject, nativeExport);
  const audio = merged.playlist[0].clips.find((c) => c.type === 'audio');
  assert.ok(audio);
  const expectedBars = Number(((2 * 120) / (60 * 4)).toFixed(6));
  assert.ok(Math.abs(Number(audio.start) - expectedBars) < 0.01);
});
