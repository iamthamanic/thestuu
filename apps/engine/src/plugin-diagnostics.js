/**
 * Structured plugin failure / disconnect diagnostics (no sandboxing).
 * Location: apps/engine/src — consumed by server.js for LOGS + /health.
 */

/**
 * @returns {{
 *   lastLoadFailure: object | null,
 *   lastScanFailure: object | null,
 *   lastScanAtMs: number | null,
 *   lastDisconnectDuringPluginAction: object | null,
 * }}
 */
export function createPluginDiagnosticsState() {
  return {
    lastLoadFailure: null,
    lastScanFailure: null,
    lastScanAtMs: null,
    lastDisconnectDuringPluginAction: null,
  };
}

/**
 * @param {ReturnType<typeof createPluginDiagnosticsState>} state
 * @param {Record<string, unknown>} patch
 */
export function recordPluginLoadFailure(state, patch) {
  state.lastLoadFailure = {
    atMs: Date.now(),
    ...patch,
  };
}

/**
 * @param {ReturnType<typeof createPluginDiagnosticsState>} state
 * @param {Record<string, unknown>} patch
 */
export function recordPluginScanFailure(state, patch) {
  state.lastScanFailure = {
    atMs: Date.now(),
    ...patch,
  };
}

/**
 * @param {ReturnType<typeof createPluginDiagnosticsState>} state
 * @param {Record<string, unknown>} patch
 */
export function recordPluginDisconnectDuringAction(state, patch) {
  state.lastDisconnectDuringPluginAction = {
    atMs: Date.now(),
    ...patch,
  };
}

/**
 * @param {ReturnType<typeof createPluginDiagnosticsState>} state
 */
export function snapshotPluginDiagnostics(state) {
  return {
    lastLoadFailure: state.lastLoadFailure,
    lastScanFailure: state.lastScanFailure,
    lastScanAtMs: state.lastScanAtMs,
    lastDisconnectDuringPluginAction: state.lastDisconnectDuringPluginAction,
  };
}
