/**
 * DAW authority guardrails — single source of truth for native vs Node-owned state.
 * Location: apps/engine/src (imported by server.js; tested in apps/engine/test).
 *
 * Tracktion/native owns arrangement, transport, mixer, plugins, and DAW undo when flags are on.
 * Node may only hold a reconciled cache plus JSON sidecar metadata (patterns, view, clip UI fields).
 */

/** Arrangement fields on audio clips — must come from native reconcile when STUU_NATIVE_CLIP_OPS=1. */
export const NATIVE_AUTHORITATIVE_CLIP_FIELDS = Object.freeze([
  'start',
  'length',
  'source_path',
  'sourcePath',
  'type',
]);

/** Node sidecar only — safe to mutate without native IPC (documented in docs/daw-authority-guardrails.md). */
export const JSON_ONLY_CLIP_FIELDS = Object.freeze([
  'gain',
  'fade_in',
  'fade_out',
  'fade_in_curve',
  'fade_out_curve',
  'fadeIn',
  'fadeOut',
  'fadeInCurve',
  'fadeOutCurve',
  'waveform_peaks',
  'source_duration_seconds',
  'trim_start_seconds',
  'name',
  'color',
  'source_name',
  'source_format',
  'id',
]);

/** Playlist/track layout owned by native when STUU_NATIVE_TRACK_OPS=1. */
export const NATIVE_AUTHORITATIVE_TRACK_FIELDS = Object.freeze([
  'track_id',
  'name',
]);

/** Per-track UI / pattern lane metadata (Node). */
export const JSON_ONLY_TRACK_FIELDS = Object.freeze([
  'chain_collapsed',
  'chain_enabled',
  'clips', // pattern clips remain JSON; audio clip *arrangement* fields inside clips are native-owned
]);

export const JSON_ONLY_PROJECT_FIELDS = Object.freeze([
  'project_name',
  'patterns',
  'nodes',
  'song_structure',
  'playlist_view_bars',
  'playlist_bar_width',
  'playlist_show_track_nodes',
  'bpm', // transport BPM may be native-owned when playing; sidecar stores last known
]);

let nativeReconcileDepth = 0;

export function isNativeClipOpsEnabled() {
  return process.env.STUU_NATIVE_CLIP_OPS === '1';
}

export function isNativeTrackOpsEnabled() {
  return process.env.STUU_NATIVE_TRACK_OPS === '1';
}

export function isNativeEditUndoEnabled() {
  return process.env.STUU_NATIVE_EDIT_UNDO === '1';
}

export function isNativeProjectSidecarEnabled() {
  return process.env.STUU_NATIVE_PROJECT_SIDECAR === '1';
}

/** Any native-first DAW domain flag enabled (all opt-in). */
export function isNativeDawModeEnabled() {
  return isNativeClipOpsEnabled() || isNativeEditUndoEnabled() || isNativeTrackOpsEnabled();
}

/** Native owns arrangement clips/tracks when clip or track ops flag is on. */
export function isNativeArrangementAuthorityEnabled() {
  return isNativeClipOpsEnabled() || isNativeTrackOpsEnabled();
}

/** JSON projectHistory stacks are only for legacy / pattern-view when native DAW mode is off. */
export function shouldUseJsonProjectHistory() {
  return !isNativeEditUndoEnabled() && !isNativeClipOpsEnabled() && !isNativeTrackOpsEnabled();
}

export function getNativeReconcileDepth() {
  return nativeReconcileDepth;
}

/**
 * Run fn while allowing arrangement cache writes derived from a native snapshot/export.
 * Used by reconcilePlaylistAudioClipsFromNative, reconcileTracksFromNative, merge paths.
 */
export async function runDuringNativeReconcile(fn) {
  nativeReconcileDepth += 1;
  try {
    return await fn();
  } finally {
    nativeReconcileDepth -= 1;
  }
}

export function runDuringNativeReconcileSync(fn) {
  nativeReconcileDepth += 1;
  try {
    return fn();
  } finally {
    nativeReconcileDepth -= 1;
  }
}

/**
 * Development/runtime guard: direct playlist/clip/mixer arrangement mutation is forbidden
 * when native arrangement authority is enabled, except inside native reconcile.
 */
export function assertDirectArrangementMutationAllowed(operation) {
  if (process.env.DAW_AUTHORITY_STRICT === '0') {
    return;
  }
  if (!isNativeArrangementAuthorityEnabled()) {
    return;
  }
  if (nativeReconcileDepth > 0) {
    return;
  }
  const strictDev = process.env.NODE_ENV !== 'production' || process.env.DAW_AUTHORITY_STRICT === '1';
  if (!strictDev) {
    return;
  }
  throw new Error(
    `${operation}: direct Node arrangement mutation blocked while native arrangement authority is enabled `
    + `(STUU_NATIVE_CLIP_OPS / STUU_NATIVE_TRACK_OPS). Use native IPC + reconcile instead. `
    + 'See docs/daw-authority-guardrails.md',
  );
}

/** Forbid legacy JSON-first arrangement handlers when native clip/track ops are enabled. */
export function assertLegacyJsonArrangementAllowed(operation) {
  if (isNativeClipOpsEnabled() || isNativeTrackOpsEnabled()) {
    throw new Error(
      `${operation}: legacy JSON arrangement path is disabled. `
      + 'Set STUU_NATIVE_CLIP_OPS=1 and STUU_NATIVE_TRACK_OPS=1 (native required), '
      + 'or unset those flags to use legacy sync. See docs/daw-authority-guardrails.md',
    );
  }
}

/** Forbid JSON projectHistory push for DAW arrangement when native undo is enabled. */
export function assertJsonProjectHistoryAllowed(operation) {
  if (!shouldUseJsonProjectHistory()) {
    throw new Error(
      `${operation}: JSON projectHistory is disabled when native DAW undo/clip/track flags are on. `
      + 'Use edit.undo / edit.redo via native. See docs/daw-authority-guardrails.md',
    );
  }
}

export function logDawAuthorityBoot() {
  if (process.env.NODE_ENV === 'production' && process.env.DAW_AUTHORITY_STRICT !== '1') {
    return;
  }
  const mode = isNativeDawModeEnabled() ? 'native-first (opt-in flags)' : 'legacy JSON (default)';
  console.log(
    `[thestuu-engine] DAW authority: ${mode} | `
    + `clipOps=${isNativeClipOpsEnabled()} trackOps=${isNativeTrackOpsEnabled()} `
    + `editUndo=${isNativeEditUndoEnabled()} sidecar=${isNativeProjectSidecarEnabled()} `
    + `strict=${process.env.DAW_AUTHORITY_STRICT !== '0'}`,
  );
}
