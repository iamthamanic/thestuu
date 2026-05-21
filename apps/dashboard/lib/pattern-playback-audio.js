/**
 * Browser preview synth for pattern MIDI (until native schedules pattern clips).
 * Location: apps/dashboard/lib/pattern-playback-audio.js
 */

const DEFAULT_VELOCITY = 0.8;

function midiToHz(pitch) {
  return 440 * (2 ** ((Math.round(pitch) - 69) / 12));
}

export class PatternPlaybackAudio {
  constructor() {
    /** @type {AudioContext | null} */
    this.ctx = null;
  }

  ensureContext() {
    if (typeof window === 'undefined') {
      return null;
    }
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        return null;
      }
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /**
   * @param {object} note
   * @param {number} bpm
   */
  playNote(note, bpm = 120) {
    const ctx = this.ensureContext();
    if (!ctx) {
      return;
    }
    const pitch = Math.round(Number(note?.pitch));
    if (!Number.isFinite(pitch)) {
      return;
    }
    const velocity = Number.isFinite(Number(note?.velocity))
      ? Math.max(0.05, Math.min(1, Number(note.velocity)))
      : DEFAULT_VELOCITY;
    const lengthBars = Math.max(1 / 16, Number(note?.length) || 1 / 4);
    const durationSec = Math.max(0.05, (lengthBars * 4 * 60) / Math.max(20, bpm));

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = midiToHz(pitch);

    const t0 = ctx.currentTime;
    const attack = 0.008;
    const release = Math.min(durationSec, 2);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.12 * velocity, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + release);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + release + 0.05);
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    }
  }
}
