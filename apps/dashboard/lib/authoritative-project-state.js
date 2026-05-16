/**
 * Helpers for reconciling optimistic UI with native-confirmed engine state.
 * Location: apps/dashboard/lib (used by stuu-shell).
 */

/**
 * Drop clip drag drafts after the engine has confirmed a mutation.
 * @param {() => void} setClipDrafts
 */
export function clearClipDraftsAfterEngineConfirm(setClipDrafts) {
  if (typeof setClipDrafts === 'function') {
    setClipDrafts({});
  }
}

/**
 * Whether DAW editing controls should be enabled (socket online + native transport).
 * @param {string} connection
 * @param {boolean | undefined} nativeTransport
 */
export function isDawEngineReady(connection, nativeTransport) {
  return connection === 'online' && nativeTransport === true;
}
