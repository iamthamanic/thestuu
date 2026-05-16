import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSongStructureNode } from '@thestuu/shared-json';
import {
  getStructureTotalBars,
  removeStructureNodeAt,
  removeStructureNodeById,
} from '../lib/song-structure.js';

function mk(id, length) {
  return normalizeSongStructureNode({
    id,
    title: 'Section',
    note: '',
    color: '#7dd3fc',
    length,
  });
}

test('removeStructureNodeAt: last remaining node yields empty array', () => {
  const nodes = [mk('only', 8)];
  const next = removeStructureNodeAt(nodes, 0);
  assert.deepEqual(next, []);
});

test('removeStructureNodeAt: neighbors keep length (middle removed)', () => {
  const nodes = [mk('a', 4), mk('b', 6), mk('c', 3)];
  const next = removeStructureNodeAt(nodes, 1);
  assert.equal(next.length, 2);
  assert.equal(next[0].id, 'a');
  assert.equal(next[0].length, 4);
  assert.equal(next[1].id, 'c');
  assert.equal(next[1].length, 3);
  assert.equal(getStructureTotalBars(next), 7);
});

test('removeStructureNodeAt: neighbors keep length (first removed)', () => {
  const nodes = [mk('a', 5), mk('b', 2)];
  const next = removeStructureNodeAt(nodes, 0);
  assert.equal(next.length, 1);
  assert.equal(next[0].id, 'b');
  assert.equal(next[0].length, 2);
});

test('removeStructureNodeAt: neighbors keep length (last removed)', () => {
  const nodes = [mk('a', 5), mk('b', 2)];
  const next = removeStructureNodeAt(nodes, 1);
  assert.equal(next.length, 1);
  assert.equal(next[0].id, 'a');
  assert.equal(next[0].length, 5);
});

test('removeStructureNodeAt: invalid index returns original array', () => {
  const nodes = [mk('a', 4)];
  assert.equal(removeStructureNodeAt(nodes, -1), nodes);
  assert.equal(removeStructureNodeAt(nodes, 2), nodes);
});

test('removeStructureNodeById: removes by id and preserves neighbor lengths', () => {
  const nodes = [mk('x', 8), mk('y', 4)];
  const next = removeStructureNodeById(nodes, 'y');
  assert.equal(next.length, 1);
  assert.equal(next[0].id, 'x');
  assert.equal(next[0].length, 8);
});

test('removeStructureNodeById: unknown id returns original array', () => {
  const nodes = [mk('x', 8)];
  assert.equal(removeStructureNodeById(nodes, 'missing'), nodes);
});
