import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipOffsetBars,
  expandPatternNotesForClipLength,
  isPlayheadInsideClip,
  noteOverlapsPatternBar,
  patternBarAtPlayhead,
  resolvePatternBarAtPlayhead,
} from '../src/pattern-timeline-map.js';

test('clip offset and pattern bar (FL: clip @ 7, playhead @ 12 → pattern bar 5)', () => {
  assert.equal(clipOffsetBars(12, 7), 5);
  assert.equal(patternBarAtPlayhead(12, 7, 16), 5);
});

test('pattern bar wraps on loop length', () => {
  assert.equal(patternBarAtPlayhead(11, 7, 4), 0);
  assert.equal(patternBarAtPlayhead(12, 7, 4), 1);
});

test('resolvePatternBarAtPlayhead returns null outside clip', () => {
  assert.equal(
    resolvePatternBarAtPlayhead({
      playlistBar: 20,
      clipStartBars: 7,
      clipLengthBars: 8,
      patternLoopBars: 4,
    }),
    null,
  );
});

test('expand keeps pattern_start for clip-local layout', () => {
  const expanded = expandPatternNotesForClipLength(
    [{ id: 'n1', pitch: 60, start: 1, length: 0.25 }],
    4,
    10,
  );
  assert.equal(expanded.length, 3);
  assert.equal(expanded[0].pattern_start, 1);
  assert.equal(expanded[0].start, 1);
  assert.equal(expanded[1].pattern_start, 1);
  assert.equal(expanded[1].start, 5);
});

test('noteOverlapsPatternBar', () => {
  assert.equal(noteOverlapsPatternBar(5, 0.5, 5), true);
  assert.equal(noteOverlapsPatternBar(5, 0.5, 4), false);
});
