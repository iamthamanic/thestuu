/**
 * Piano-roll / track key preview routing for the dashboard.
 * Piano-roll preview: immediate browser WebAudio blip plus native `track:preview-note` when the audio device is ready.
 * Location: apps/dashboard/lib/track-preview.js
 */

/** @type {AudioContext | null} */
let browserPreviewCtx = null;
/** @type {GainNode | null} */
let browserPreviewMaster = null;
/** @type {Map<number, { osc: OscillatorNode, gain: GainNode, stopTimer: ReturnType<typeof setTimeout> | null }>} */
const browserPreviewVoices = new Map();

/**
 * @param {number} pitch
 * @returns {number}
 */
function midiPitchToFrequency(pitch) {
  return 440 * (2 ** ((Math.round(Number(pitch) || 60) - 69) / 12));
}

/**
 * @returns {AudioContext | null}
 */
function getBrowserPreviewContext() {
  if (typeof window === 'undefined') {
    return null;
  }
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) {
    return null;
  }
  if (!browserPreviewCtx) {
    browserPreviewCtx = new Ctor();
    browserPreviewMaster = browserPreviewCtx.createGain();
    browserPreviewMaster.gain.value = 0.42;
    browserPreviewMaster.connect(browserPreviewCtx.destination);
  }
  if (browserPreviewCtx.state === 'suspended') {
    browserPreviewCtx.resume().catch(() => {});
  }
  return browserPreviewCtx;
}

/**
 * Interim dashboard-only preview when native `track:preview-note` is unavailable.
 * @param {number} pitch MIDI note number
 * @param {{ on?: boolean, velocity?: number, durationMs?: number }} [options]
 * @returns {boolean} false when Web Audio is unavailable
 */
export function playBrowserPreviewNote(pitch, options = {}) {
  const ctx = getBrowserPreviewContext();
  if (!ctx || !browserPreviewMaster) {
    return false;
  }
  const p = Math.round(Number(pitch) || 60);
  const noteOn = options.on !== false;

  if (!noteOn) {
    const voice = browserPreviewVoices.get(p);
    if (!voice) {
      return true;
    }
    if (voice.stopTimer) {
      clearTimeout(voice.stopTimer);
    }
    const now = ctx.currentTime;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), now);
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
      voice.osc.stop(now + 0.05);
    } catch {
      /* already stopped */
    }
    browserPreviewVoices.delete(p);
    return true;
  }

  playBrowserPreviewNote(p, { on: false });

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = midiPitchToFrequency(p);
  osc.connect(gain);
  gain.connect(browserPreviewMaster);

  const vel = Math.max(0.04, Math.min(1, (Number(options.velocity) || 100) / 127));
  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(vel * 0.55, now + 0.012);
  osc.start(now);

  const durationMs = Math.max(40, Number(options.durationMs) || 140);
  const stopTimer = setTimeout(() => {
    playBrowserPreviewNote(p, { on: false });
  }, durationMs);
  browserPreviewVoices.set(p, { osc, gain, stopTimer });
  return true;
}

/**
 * @param {number | string | null | undefined} trackId
 * @param {{
 *   vstNodes?: Array<object>,
 *   playlistTracks?: Array<object>,
 * }} [options]
 * @returns {{
 *   hasVstInstrument: boolean,
 *   hasTrackSound: boolean,
 *   useDefaultPiano: boolean,
 * }}
 */
export function resolvePreviewMode(trackId, options = {}) {
  const tid = Number(trackId);
  const vstNodes = Array.isArray(options.vstNodes) ? options.vstNodes : [];
  const playlistTracks = Array.isArray(options.playlistTracks) ? options.playlistTracks : [];

  const hasVstInstrument = Number.isInteger(tid) && tid > 0
    && vstNodes.some((node) => Number(node?.track_id ?? node?.trackId) === tid);

  const track = playlistTracks.find((row) => Number(row?.track_id ?? row?.trackId) === tid);
  const sample = track?.track_sound ?? track?.trackSound;
  const hasTrackSound = sample?.kind === 'sample';

  const useDefaultPiano = !hasVstInstrument;

  return { hasVstInstrument, hasTrackSound, useDefaultPiano };
}

/** Minimum ms between preview note-on IPC during glissando (~20/sec). */
export const TRACK_PREVIEW_MIN_INTERVAL_MS = 50;

/** Ms after note-on ack before note-off for placement preview (native guide-note attack). */
export const TRACK_PREVIEW_PLACEMENT_OFF_MS = 280;

/** Browser blip length when placing a note in the piano roll. */
export const TRACK_PREVIEW_BROWSER_PLACEMENT_MS = 240;

/** Browser blip length for virtual-key / glissando preview. */
export const TRACK_PREVIEW_BROWSER_KEY_MS = 130;

/**
 * Resume Web Audio after a user gesture (piano roll interaction counts).
 * @returns {boolean}
 */
export function primeBrowserPreviewAudio() {
  const ctx = getBrowserPreviewContext();
  return Boolean(ctx);
}

/**
 * Whether native `track:preview-note` can reach the audio device (not just IPC/transport).
 * @param {ReturnType<import('./engine-diagnostics.js').mapEngineDiagnostics> | null | undefined} engineDiagnostics
 * @returns {boolean}
 */
export function isNativeAudioPreviewReady(engineDiagnostics) {
  if (!engineDiagnostics || typeof engineDiagnostics !== 'object') {
    return false;
  }
  return Boolean(
    engineDiagnostics.audioDeviceReady
    && (engineDiagnostics.dawReady || engineDiagnostics.tracktionReady),
  );
}

/**
 * Resolve playlist track id for piano-roll preview (modal target, selection, pattern clip, or first track).
 * @param {{ trackId?: number | null, patternId?: string | null } | null | undefined} target
 * @param {Array<object>} [playlistTracks]
 * @param {number | string | null | undefined} [selectedTrackId]
 * @returns {number | null}
 */
export function resolvePianoRollPreviewTrackId(target, playlistTracks = [], selectedTrackId = null) {
  const fromTarget = Number(target?.trackId);
  if (Number.isInteger(fromTarget) && fromTarget > 0) {
    return fromTarget;
  }
  const fromSelected = Number(selectedTrackId);
  if (Number.isInteger(fromSelected) && fromSelected > 0) {
    return fromSelected;
  }
  const patternId = target?.patternId != null ? String(target.patternId) : '';
  if (patternId) {
    for (const track of playlistTracks) {
      const clips = Array.isArray(track?.clips) ? track.clips : [];
      const hasPatternClip = clips.some(
        (clip) => String(clip?.pattern_id ?? clip?.patternId ?? '') === patternId,
      );
      if (!hasPatternClip) {
        continue;
      }
      const tid = Number(track?.track_id ?? track?.trackId);
      if (Number.isInteger(tid) && tid > 0) {
        return tid;
      }
    }
  }
  for (const track of playlistTracks) {
    const tid = Number(track?.track_id ?? track?.trackId);
    if (Number.isInteger(tid) && tid > 0) {
      return tid;
    }
  }
  return null;
}

/**
 * Throttle `track:preview-note` note-on during key glissando; note-off is immediate.
 * @param {(payload: { pitch: number, on: boolean }) => void} emit
 * @param {number} [minIntervalMs]
 * @returns {(payload: { pitch: number, on: boolean }) => void}
 */
export function createThrottledPreviewEmitter(emit, minIntervalMs = TRACK_PREVIEW_MIN_INTERVAL_MS) {
  let lastOnMs = 0;
  let activePitch = null;
  let trailingTimer = null;

  const flushOn = (pitch) => {
    const p = Math.round(Number(pitch) || 60);
    if (activePitch != null && activePitch !== p) {
      emit({ pitch: activePitch, on: false });
    }
    if (activePitch !== p) {
      emit({ pitch: p, on: true });
      activePitch = p;
      lastOnMs = performance.now();
    }
  };

  return function throttledPreview({ pitch, on }) {
    if (!on) {
      if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
      }
      if (activePitch != null) {
        emit({ pitch: activePitch, on: false });
        activePitch = null;
      }
      return;
    }
    const p = Math.round(Number(pitch) || 60);
    if (p === activePitch) {
      return;
    }
    const now = performance.now();
    const elapsed = now - lastOnMs;
    if (activePitch == null || elapsed >= minIntervalMs) {
      flushOn(p);
      return;
    }
    if (trailingTimer) {
      clearTimeout(trailingTimer);
    }
    const waitMs = Math.max(0, minIntervalMs - elapsed);
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      if (activePitch !== p) {
        flushOn(p);
      }
    }, waitMs);
  };
}

/**
 * One-shot preview when a note is placed in the piano roll (not key glissando).
 * @param {(payload: { pitch: number, on: boolean }, onAck?: (result: { ok?: boolean }) => void) => void} emit
 * @param {number} [minIntervalMs]
 * @param {number} [offDelayMs]
 * @returns {(pitch: number) => void}
 */
export function createPlacementPreviewEmitter(
  emit,
  minIntervalMs = TRACK_PREVIEW_MIN_INTERVAL_MS,
  offDelayMs = TRACK_PREVIEW_PLACEMENT_OFF_MS,
) {
  let lastPlacedMs = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let offTimer = null;
  /** @type {number | null} */
  let pendingOffPitch = null;

  const scheduleNoteOff = (pitch, delayMs) => {
    if (offTimer) {
      clearTimeout(offTimer);
    }
    pendingOffPitch = pitch;
    offTimer = setTimeout(() => {
      offTimer = null;
      pendingOffPitch = null;
      emit({ pitch, on: false });
    }, Math.max(0, delayMs));
  };

  return function previewPlacedNote(pitch) {
    const p = Math.round(Number(pitch) || 60);
    const now = performance.now();
    if (now - lastPlacedMs < minIntervalMs) {
      return;
    }
    lastPlacedMs = now;

    if (offTimer) {
      clearTimeout(offTimer);
      offTimer = null;
      if (pendingOffPitch != null) {
        emit({ pitch: pendingOffPitch, on: false });
        pendingOffPitch = null;
      }
    }

    let ackHandled = false;
    const onAck = (result) => {
      if (ackHandled) {
        return;
      }
      ackHandled = true;
      if (result?.ok === false) {
        return;
      }
      if (result?.fallback) {
        return;
      }
      scheduleNoteOff(p, offDelayMs);
    };
    emit({ pitch: p, on: true }, onAck);
    setTimeout(() => {
      if (!ackHandled) {
        onAck({ ok: true });
      }
    }, 400);
  };
}
