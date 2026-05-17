/**
 * Bridge Tauri desktop shell diagnostics into the dashboard LOGS panel.
 * No-op when not running inside the Tauri webview (__TAURI__ absent).
 */

import {
  LIVE_LOG_CATEGORIES,
  LIVE_LOG_SOURCES,
  normalizeStructuredLogEntry,
} from './live-logs.js';

export function isTauriDesktopShell() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI__);
}

/**
 * @returns {import('@tauri-apps/api/core').Invoke | null}
 */
function getInvoke() {
  if (!isTauriDesktopShell()) return null;
  return window.__TAURI__.core.invoke;
}

const defaultHealth = () => ({
  dashboardOnline: false,
  engineOnline: false,
  engineManagedByDesktop: false,
  engineProcessRunning: false,
  nativeProcessRunning: false,
  ipcConnected: false,
  tracktionReady: false,
  audioDeviceReady: false,
  dawReady: false,
  socketPath: '',
  lastEngineError: null,
  lastNativeError: null,
  errorCategory: 'unknown',
  nativeFlags: {},
});

/**
 * @param {Record<string, unknown> | null} diag
 */
export function mapDesktopDiagnostics(diag) {
  if (!diag || typeof diag !== 'object') {
    return defaultHealth();
  }
  return {
    dashboardOnline: Boolean(diag.dashboardOnline),
    engineOnline: Boolean(diag.engine?.online),
    engineManagedByDesktop: Boolean(diag.engineManagedByDesktop),
    engineProcessRunning: Boolean(diag.engineProcessRunning ?? diag.engine?.online),
    nativeProcessRunning: Boolean(diag.nativeProcessRunning),
    ipcConnected: Boolean(diag.ipcConnected),
    tracktionReady: Boolean(diag.tracktionReady),
    audioDeviceReady: Boolean(diag.audioDeviceReady),
    dawReady: Boolean(diag.dawReady),
    socketPath: typeof diag.socketPath === 'string' ? diag.socketPath : '',
    lastEngineError: typeof diag.lastEngineError === 'string' ? diag.lastEngineError : null,
    lastNativeError: typeof diag.lastNativeError === 'string' ? diag.lastNativeError : null,
    errorCategory: typeof diag.errorCategory === 'string' ? diag.errorCategory : 'unknown',
    nativeFlags: diag.nativeFlags && typeof diag.nativeFlags === 'object' ? diag.nativeFlags : {},
    dashboardUrl: typeof diag.dashboardUrl === 'string' ? diag.dashboardUrl : '',
  };
}

/**
 * @param {Record<string, unknown>} entry
 */
export function mapTauriLogEntry(entry) {
  let source = typeof entry.source === 'string' ? entry.source : LIVE_LOG_SOURCES.TAURI_SHELL;
  if (source === 'shell') source = LIVE_LOG_SOURCES.TAURI_SHELL;
  if (source === 'native-stdout' || source === 'native-stderr') {
    source = LIVE_LOG_SOURCES.NATIVE_ENGINE;
  }
  if (source === 'engine-stdout' || source === 'engine-stderr') {
    source = LIVE_LOG_SOURCES.ENGINE;
  }

  return normalizeStructuredLogEntry({
    id: `desk_${entry.timestampMs ?? Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ts: entry.timestampMs,
    level: entry.level,
    source,
    category: entry.category || LIVE_LOG_CATEGORIES.UNKNOWN,
    message: entry.message,
  });
}

/**
 * @param {Set<string>} seenIds
 */
export async function fetchDesktopDiagnostics(seenIds) {
  const invoke = getInvoke();
  if (!invoke) {
    return { health: defaultHealth(), newLogs: [], isTauri: false };
  }

  const [diag, logs] = await Promise.all([
    invoke('get_desktop_diagnostics'),
    invoke('get_diagnostic_logs'),
  ]);

  const health = mapDesktopDiagnostics(diag);
  const newLogs = [];
  if (Array.isArray(logs)) {
    for (const raw of logs) {
      const mapped = mapTauriLogEntry(raw);
      if (mapped && !seenIds.has(mapped.id)) {
        seenIds.add(mapped.id);
        newLogs.push(mapped);
      }
    }
  }

  return { health, newLogs, isTauri: true };
}

export async function restartNativeEngine() {
  const invoke = getInvoke();
  if (!invoke) return null;
  return invoke('restart_native_engine');
}

export async function restartNodeEngine() {
  const invoke = getInvoke();
  if (!invoke) return null;
  return invoke('restart_node_engine');
}

export async function exportDiagnosticsBundle() {
  const invoke = getInvoke();
  if (!invoke) return null;
  return invoke('export_diagnostics_bundle');
}

export async function copyDiagnosticsText() {
  const invoke = getInvoke();
  if (!invoke) return null;
  return invoke('copy_diagnostics_text');
}

export async function clearDesktopDiagnosticLogs() {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('clear_diagnostic_logs');
}

/**
 * @param {(payload: ReturnType<typeof mapDesktopDiagnostics>) => void} onHealth
 * @param {(entry: ReturnType<typeof mapTauriLogEntry>) => void} onLog
 */
export function subscribeDesktopDiagnostics(onHealth, onLog) {
  if (!isTauriDesktopShell()) {
    return () => {};
  }
  const { listen } = window.__TAURI__.event;
  const unsubs = [];

  listen('desktop://diagnostics', (event) => {
    onHealth(mapDesktopDiagnostics(event.payload));
  }).then((fn) => unsubs.push(fn));

  listen('desktop://status', (event) => {
    const p = event.payload || {};
    onHealth(mapDesktopDiagnostics({
      dashboardOnline: p.uiOnline,
      engine: { online: p.engineOnline ?? p.uiOnline },
      engineManagedByDesktop: p.engineManagedByDesktop,
      engineProcessRunning: p.engineOnline,
      nativeProcessRunning: p.nativeProcessRunning,
      ipcConnected: p.ipcConnected,
      tracktionReady: p.tracktionReady,
      audioDeviceReady: p.audioDeviceReady,
      dawReady: p.dawReady,
      socketPath: p.socketPath,
      lastEngineError: p.engineStartupError,
      lastNativeError: p.startupError,
    }));
  }).then((fn) => unsubs.push(fn));

  return () => {
    for (const fn of unsubs) {
      if (typeof fn === 'function') fn();
    }
  };
}
