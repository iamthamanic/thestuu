/**
 * Parse .mid/.midi files into pattern notes (bar units).
 * Location: apps/dashboard/lib/midi-import.js
 */

import { Midi } from '@tonejs/midi';

const GRID_STEP = 1 / 16;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value, step = GRID_STEP) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const snapped = Math.round(value / step) * step;
  return Number(snapped.toFixed(6));
}

function barsToSeconds(bars, bpm, timeSignature = { numerator: 4, denominator: 4 }) {
  if (!Number.isFinite(bars) || !Number.isFinite(bpm) || bpm <= 0) {
    return 0;
  }
  const num = Number(timeSignature?.numerator) || 4;
  const denom = Number(timeSignature?.denominator) || 4;
  const quarterNotesPerBar = (num * 4) / denom;
  return (bars * quarterNotesPerBar * 60) / bpm;
}

function secondsToBars(seconds, bpm, timeSignature = { numerator: 4, denominator: 4 }) {
  if (!Number.isFinite(seconds) || !Number.isFinite(bpm) || bpm <= 0) {
    return 0;
  }
  const num = Number(timeSignature?.numerator) || 4;
  const denom = Number(timeSignature?.denominator) || 4;
  const quarterNotesPerBar = (num * 4) / denom;
  return (seconds * bpm) / (quarterNotesPerBar * 60);
}

/**
 * @param {ArrayBuffer} arrayBuffer
 * @param {{ bpm?: number, timeSignature?: { numerator: number, denominator: number } }} options
 * @returns {Promise<Array<{ id: string, start: number, length: number, pitch: number, velocity: number }>>}
 */
export async function parseMidiFileToPatternNotes(arrayBuffer, options = {}) {
  const midi = new Midi(arrayBuffer);
  const bpm = Number.isFinite(Number(options.bpm)) && Number(options.bpm) > 0
    ? Number(options.bpm)
    : (Number.isFinite(Number(midi.header?.tempos?.[0]?.bpm)) && Number(midi.header.tempos[0].bpm) > 0
      ? Number(midi.header.tempos[0].bpm)
      : 120);
  const timeSignature = options.timeSignature || { numerator: 4, denominator: 4 };

  const notes = [];
  let noteIndex = 0;
  for (const track of midi.tracks || []) {
    for (const note of track.notes || []) {
      const startSec = Number(note.time);
      const endSec = Number(note.time) + Number(note.duration);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
        continue;
      }
      const startBars = Math.max(0, secondsToBars(startSec, bpm, timeSignature));
      const endBars = Math.max(startBars, secondsToBars(endSec, bpm, timeSignature));
      const lengthBars = Math.max(GRID_STEP, endBars - startBars);
      const pitch = clamp(Math.round(Number(note.midi)), 0, 127);
      const velocity = clamp(Number(note.velocity) || 0.8, 0, 1);
      if (velocity <= 0) {
        continue;
      }
      notes.push({
        id: `note_import_${noteIndex + 1}`,
        start: roundToStep(startBars),
        length: roundToStep(lengthBars),
        pitch,
        velocity: Number(velocity.toFixed(2)),
      });
      noteIndex += 1;
    }
  }

  notes.sort((a, b) => {
    if (a.start === b.start) {
      return a.pitch - b.pitch;
    }
    return a.start - b.start;
  });

  return notes;
}

export { barsToSeconds, secondsToBars };
