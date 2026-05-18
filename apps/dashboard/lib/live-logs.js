/**
 * Structured live log normalization for the dashboard LOGS panel.
 * Used by engine Socket.IO events and Tauri desktop diagnostics.
 */

export const LIVE_LOG_LIMIT = 500;

export const LIVE_LOG_SOURCES = Object.freeze({
  ENGINE: 'engine',
  TAURI_SHELL: 'tauri-shell',
  NATIVE_ENGINE: 'native-engine',
  IPC: 'ipc',
  AUDIO: 'audio',
  DESKTOP_LIFECYCLE: 'desktop-lifecycle',
  UI: 'ui',
});

export const LIVE_LOG_CATEGORIES = Object.freeze({
  STARTUP: 'startup',
  IPC: 'ipc',
  AUDIO: 'audio',
  PLUGIN: 'plugin',
  PROJECT: 'project',
  TRANSPORT: 'transport',
  RECOVERY: 'recovery',
  UNKNOWN: 'unknown',
});

/**
 * @param {string | undefined} level
 */
export function normalizeLiveLogLevel(level) {
  if (level === 'error' || level === 'warn' || level === 'info') {
    return level;
  }
  return 'log';
}

/**
 * @param {Record<string, unknown> | null | undefined} entry
 */
export function normalizeStructuredLogEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const text = typeof entry.text === 'string'
    ? entry.text
    : typeof entry.message === 'string'
      ? entry.message
      : '';
  if (!text.trim()) {
    return null;
  }
  const tsValue = Number(entry.ts ?? entry.timestamp ?? entry.timestampMs);
  const ts = Number.isFinite(tsValue) ? tsValue : Date.now();
  const id = typeof entry.id === 'string' && entry.id.trim()
    ? entry.id
    : `log_${ts}_${Math.random().toString(36).slice(2, 8)}`;

  let source = typeof entry.source === 'string' ? entry.source.trim() : LIVE_LOG_SOURCES.ENGINE;
  if (source === 'shell') source = LIVE_LOG_SOURCES.TAURI_SHELL;
  if (source === 'native-stdout' || source === 'native-stderr') {
    source = LIVE_LOG_SOURCES.NATIVE_ENGINE;
  }

  const category = typeof entry.category === 'string' && entry.category.trim()
    ? entry.category.trim()
    : LIVE_LOG_CATEGORIES.UNKNOWN;

  const eventName = typeof entry.event === 'string' ? entry.event.trim() : '';

  return {
    id,
    ts,
    level: normalizeLiveLogLevel(entry.level),
    text: text.replace(/\r/g, ''),
    source,
    category,
    event: eventName,
    metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : undefined,
  };
}

/** @deprecated use normalizeStructuredLogEntry */
export const normalizeLiveEngineLogEntry = normalizeStructuredLogEntry;

/**
 * @param {number} ts
 */
export function formatLiveLogTime(ts) {
  const date = new Date(Number.isFinite(Number(ts)) ? Number(ts) : Date.now());
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/**
 * @param {import('./live-logs.js').normalizeStructuredLogEntry extends Function ? ReturnType<typeof normalizeStructuredLogEntry> : never} entry
 */
export function formatLogLineLabel(entry) {
  const parts = [];
  if (entry.source) parts.push(entry.source);
  if (entry.category && entry.category !== 'unknown') parts.push(entry.category);
  if (entry.event) parts.push(entry.event);
  return parts.length ? `[${parts.join(' · ')}] ` : '';
}
