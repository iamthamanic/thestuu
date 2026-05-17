'use client';

/**
 * Top-bar connection status + unified LOGS panel (engine + Tauri desktop diagnostics).
 * Location: apps/dashboard/components — used by stuu-shell.jsx
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, ExternalLink } from 'lucide-react';
import {
  clearDesktopDiagnosticLogs,
  copyDiagnosticsText,
  exportDiagnosticsBundle,
  fetchDesktopDiagnostics,
  isTauriDesktopShell,
  restartNativeEngine,
  restartNodeEngine,
  subscribeDesktopDiagnostics,
} from '../lib/desktop-diagnostics-bridge.js';
import {
  formatLiveLogTime,
  formatLogLineLabel,
} from '../lib/live-logs.js';
import { mergeLogsPanelHealth } from '../lib/engine-diagnostics.js';

/**
 * @param {object} props
 * @param {'connecting'|'online'|'offline'} props.connection
 * @param {string} props.enginePort
 * @param {boolean} props.dawEngineReady
 * @param {boolean} props.nativeTransport
 * @param {object | null} props.engineDiagnostics
 * @param {import('react').Dispatch<import('react').SetStateAction<Array>>} props.setConnectionLogs
 * @param {Array} props.connectionLogs
 * @param {(entry: object) => void} props.appendLogEntry
 */
export default function ConnectionStatusLogs({
  connection,
  enginePort,
  dawEngineReady,
  nativeTransport,
  engineDiagnostics,
  connectionLogs,
  setConnectionLogs,
  appendLogEntry,
}) {
  const [showLogs, setShowLogs] = useState(false);
  const [portalLayout, setPortalLayout] = useState(null);
  const [desktopHealth, setDesktopHealth] = useState(null);
  const [isTauri, setIsTauri] = useState(false);
  const [logFilter, setLogFilter] = useState('all');

  const dropdownRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const viewportRef = useRef(null);
  const desktopLogIdsRef = useRef(new Set());
  const autoScrollRef = useRef(true);
  const appendLogEntryRef = useRef(appendLogEntry);
  appendLogEntryRef.current = appendLogEntry;

  const connectionStatusVariant = dawEngineReady
    ? 'online'
    : connection === 'online'
      ? 'no-audio'
      : connection;

  const connectionStatusTitle = connection === 'offline' || connection === 'connecting'
    ? `Engine nicht erreichbar (${enginePort}). Starte: npm run start`
    : connection === 'online' && !nativeTransport
      ? 'Node online — DAW/native noch nicht bereit (UI online ≠ DAW ready)'
      : undefined;

  const connectionStatusText = dawEngineReady
    ? 'online'
    : connection === 'online'
      ? 'no audio'
      : connection;

  const health = mergeLogsPanelHealth(connection, dawEngineReady, engineDiagnostics, desktopHealth);
  const legacyClipOpsOff =
    engineDiagnostics?.nativeDawFlags?.clipOps === false
    || health.dawAuthority === 'legacy-json';

  const updatePortalLayout = useCallback(() => {
    if (typeof window === 'undefined') return;
    const anchorEl = triggerRef.current || dropdownRef.current;
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const gutter = vw <= 1080 ? 12 : 20;
    const width = Math.max(280, Math.min(vw <= 1080 ? 300 : 360, vw - gutter * 2));
    const left = Math.min(Math.max(rect.right - width - 8, gutter), Math.max(gutter, vw - width - gutter));
    const maxHeight = Math.min(420, Math.max(160, vh - rect.bottom - gutter - 8));
    const top = rect.bottom + 8;
    setPortalLayout({ left, top, width, maxHeight });
  }, []);

  useEffect(() => {
    const tauri = isTauriDesktopShell();
    setIsTauri(tauri);
    if (!tauri) return undefined;

    const unsub = subscribeDesktopDiagnostics(
      (h) => setDesktopHealth(h),
      (entry) => {
        if (entry) appendLogEntryRef.current(entry);
      },
    );

    const poll = async () => {
      try {
        const { health: h, newLogs, isTauri: inTauri } = await fetchDesktopDiagnostics(desktopLogIdsRef.current);
        setIsTauri(inTauri);
        setDesktopHealth(h);
        for (const entry of newLogs) {
          appendLogEntryRef.current(entry);
        }
      } catch (err) {
        console.warn('[desktop-diagnostics]', err);
      }
    };

    poll();
    const id = setInterval(poll, 2000);
    return () => {
      clearInterval(id);
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!showLogs) {
      setPortalLayout(null);
      return undefined;
    }
    updatePortalLayout();
    const onResize = () => updatePortalLayout();
    window.addEventListener('resize', onResize);
    const handlePointerDown = (event) => {
      const target = event.target;
      if (!dropdownRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setShowLogs(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setShowLogs(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showLogs, updatePortalLayout]);

  useEffect(() => {
    if (!autoScrollRef.current || !viewportRef.current) return;
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
  }, [connectionLogs]);

  const filteredLogs = connectionLogs.filter((entry) => {
    if (logFilter === 'all') return true;
    return entry.category === logFilter || entry.source === logFilter;
  });

  const handleClear = async () => {
    setConnectionLogs([]);
    desktopLogIdsRef.current.clear();
    if (isTauri) {
      await clearDesktopDiagnosticLogs();
    }
  };

  const handleCopy = async () => {
    if (isTauri) {
      const text = await copyDiagnosticsText();
      if (text) {
        await navigator.clipboard.writeText(text);
        return;
      }
    }
    const text = connectionLogs
      .map((e) => `${formatLiveLogTime(e.ts)} [${e.level}] ${formatLogLineLabel(e)}${e.text}`)
      .join('\n');
    await navigator.clipboard.writeText(text);
  };

  const handleExport = async () => {
    let payload;
    if (isTauri) {
      payload = await exportDiagnosticsBundle();
    } else {
      payload = {
        exportedAtMs: Date.now(),
        logs: connectionLogs,
        connection,
        enginePort,
        nativeTransport,
      };
    }
    const json = JSON.stringify(payload, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `thestuu-logs-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRestartNative = async () => {
    if (!isTauri) return;
    appendLogEntry({
      level: 'info',
      source: 'desktop-lifecycle',
      category: 'startup',
      event: 'restart',
      message: '[desktop] restart native-engine requested',
    });
    await restartNativeEngine();
  };

  const handleRestartNode = async () => {
    if (!isTauri) return;
    appendLogEntry({
      level: 'info',
      source: 'desktop-lifecycle',
      category: 'startup',
      event: 'restart',
      message: '[desktop] restart Node engine requested',
    });
    await restartNodeEngine();
  };

  const terminalHeight = Math.min(220, Math.max(120, (portalLayout?.maxHeight ?? 280) - 140));

  const healthRow = (id, label, on) => (
    <div className="status-health-row" key={id}>
      <span className={`status-health-dot ${on ? 'on' : ''}`} />
      <span>{label}</span>
    </div>
  );

  return (
    <span className="status-terminal-wrap" ref={dropdownRef}>
      <span className={`status status-badge ${connectionStatusVariant}`} title={connectionStatusTitle}>
        {connectionStatusText}
        <span className="status-port" title={`Engine: ${enginePort}`}>:{enginePort}</span>
        <a
          href={`http://127.0.0.1:${enginePort}`}
          target="_blank"
          rel="noopener noreferrer"
          className="status-open-icon"
          title="Engine in neuem Tab öffnen"
          aria-label="Engine in neuem Tab öffnen"
        >
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      </span>
      <div className={`status-log-dropdown ${showLogs ? 'open' : ''}`}>
        <button
          type="button"
          ref={triggerRef}
          className="status-log-trigger"
          onClick={() => {
            updatePortalLayout();
            setShowLogs((p) => !p);
          }}
          aria-expanded={showLogs}
          aria-haspopup="dialog"
          aria-label={showLogs ? 'Logs schließen' : 'Logs öffnen'}
          title="Logs & diagnostics"
        >
          logs
          <ChevronRight className="status-log-trigger-icon" size={12} aria-hidden="true" />
        </button>
      </div>
      {showLogs && portalLayout && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panelRef}
              className="status-log-panel status-log-panel-diagnostics"
              style={{
                position: 'fixed',
                left: portalLayout.left,
                top: portalLayout.top,
                width: portalLayout.width,
                maxHeight: portalLayout.maxHeight,
              }}
              role="dialog"
              aria-label="Logs and diagnostics"
            >
              <div className="status-log-panel-header">
                <span className="status-log-panel-title">Logs</span>
                <span className="status-log-panel-meta">{connectionLogs.length} lines</span>
              </div>
              <div className="status-health-grid" title="UI online does not imply DAW ready">
                {healthRow('dash', 'Dashboard', health.dashboardOnline)}
                {healthRow('node', 'Node engine', health.engineOnline)}
                {healthRow('native', 'native-engine', health.nativeProcessRunning)}
                {healthRow('ipc', 'IPC', health.ipcConnected)}
                {healthRow('track', 'Tracktion', health.tracktionReady)}
                {healthRow('audio', 'Audio device', health.audioDeviceReady)}
              </div>
              {legacyClipOpsOff ? (
                <div className="status-log-native-error" role="status">
                  Legacy JSON mode (clipOps=false): not optimized for smooth playback. Start with npm run start (native-first). Use --legacy-daw only for QA.
                </div>
              ) : null}
              {health.lastEngineError ? (
                <div className="status-log-native-error" role="alert">
                  Node: {health.lastEngineError}
                </div>
              ) : null}
              {health.lastNativeError ? (
                <div className="status-log-native-error" role="alert">
                  Native: {health.lastNativeError}
                </div>
              ) : null}
              <div className="status-log-panel-actions">
                {isTauri ? (
                  <>
                    <button type="button" className="status-log-panel-clear" onClick={handleRestartNode}>
                      restart node
                    </button>
                    <button type="button" className="status-log-panel-clear" onClick={handleRestartNative}>
                      restart native
                    </button>
                  </>
                ) : null}
                <button type="button" className="status-log-panel-clear" onClick={handleCopy}>
                  copy
                </button>
                <button type="button" className="status-log-panel-clear" onClick={handleExport}>
                  export
                </button>
                <button type="button" className="status-log-panel-clear" onClick={handleClear}>
                  clear
                </button>
                <label className="status-log-autoscroll">
                  <input
                    type="checkbox"
                    defaultChecked
                    onChange={(e) => { autoScrollRef.current = e.target.checked; }}
                  />
                  auto-scroll
                </label>
                <select
                  className="status-log-filter"
                  value={logFilter}
                  onChange={(e) => setLogFilter(e.target.value)}
                  aria-label="Filter logs"
                >
                  <option value="all">all</option>
                  <option value="engine">engine</option>
                  <option value="tauri-shell">tauri-shell</option>
                  <option value="native-engine">native-engine</option>
                  <option value="ipc">ipc</option>
                  <option value="audio">audio</option>
                  <option value="startup">startup</option>
                  <option value="desktop-lifecycle">desktop-lifecycle</option>
                </select>
              </div>
              <div
                ref={viewportRef}
                className="status-log-terminal"
                style={{ height: terminalHeight, maxHeight: terminalHeight }}
                role="log"
                aria-live="polite"
              >
                {filteredLogs.length === 0 ? (
                  <div className="status-log-empty">Noch keine Logs…</div>
                ) : (
                  filteredLogs.map((entry) => (
                    <div key={entry.id} className={`status-log-line level-${entry.level}`}>
                      <span className="status-log-time">{formatLiveLogTime(entry.ts)}</span>
                      <span className="status-log-meta">
                        {entry.source}
                        {entry.category && entry.category !== 'unknown' ? ` · ${entry.category}` : ''}
                      </span>
                      <span className="status-log-text">
                        {formatLogLineLabel(entry)}
                        {entry.text}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
