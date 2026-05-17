// TheStuu desktop diagnostics UI — shell-only, no DAW control.

const CATEGORY_FILTER_ALL = 'all';

let autoScroll = true;
let categoryFilter = CATEGORY_FILTER_ALL;
let latestDiagnostics = null;

function tauri() {
  return window.__TAURI__;
}

function formatTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function setDot(el, on, err) {
  if (!el) return;
  el.className = 'dot ' + (on ? 'ok' : err ? 'err' : 'warn');
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function renderDiagnostics(d) {
  latestDiagnostics = d;
  setDot(document.getElementById('dot-dashboard'), d.dashboardOnline);
  setDot(document.getElementById('dot-engine'), d.engine?.online);
  setDot(document.getElementById('dot-native'), d.nativeProcessRunning, !!d.lastNativeError);
  setDot(document.getElementById('dot-ipc'), d.ipcConnected);
  setDot(document.getElementById('dot-tracktion'), d.tracktionReady);
  setDot(document.getElementById('dot-audio'), d.audioDeviceReady);
  setDot(document.getElementById('dot-daw'), d.dawReady);

  document.getElementById('socket-path').textContent = d.socketPath || '—';
  document.getElementById('dashboard-url').textContent = d.dashboardUrl || '—';
  document.getElementById('engine-url').textContent = d.engine?.url || '—';

  const flags = d.nativeFlags || {};
  document.getElementById('flags-text').textContent = [
    `nativeTransport=${flags.nativeTransport}`,
    `clipOps=${flags.nativeClipOps}`,
    `editUndo=${flags.nativeEditUndo}`,
    `trackOps=${flags.nativeTrackOps}`,
    `sidecar=${flags.nativeProjectSidecar}`,
    `legacySync=${flags.nativeLegacySync}`,
  ].join(' · ');

  document.getElementById('native-mode').textContent = d.nativeModeEnabled ? 'enabled' : 'disabled';

  const errEl = document.getElementById('last-error');
  const catEl = document.getElementById('error-category');
  if (d.lastNativeError) {
    errEl.textContent = d.lastNativeError;
    errEl.hidden = false;
  } else {
    errEl.hidden = true;
  }
  catEl.textContent = d.errorCategory || 'unknown';
  catEl.className = 'badge' + (d.lastNativeError ? ' err' : '');
}

function renderLogs(entries) {
  const view = document.getElementById('log-view');
  const filtered = entries.filter((e) => {
    if (categoryFilter === CATEGORY_FILTER_ALL) return true;
    return e.category === categoryFilter;
  });

  if (!filtered.length) {
    view.innerHTML = '<div class="log-empty">No log entries</div>';
    return;
  }

  view.innerHTML = filtered
    .map((e) => {
      const levelClass = 'level-' + (e.level || 'info');
      return `<div class="log-line ${levelClass}" data-ts="${e.timestampMs}">
        <span>${formatTime(e.timestampMs)}</span>
        <span>${e.level}</span>
        <span>${e.source}</span>
        <span>${e.category}</span>
        <span>${escapeHtml(e.message)}</span>
      </div>`;
    })
    .join('');

  if (autoScroll) {
    view.scrollTop = view.scrollHeight;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function refreshAll() {
  if (!tauri()) return;
  const { invoke } = tauri().core;
  try {
    const [diag, logs] = await Promise.all([
      invoke('get_desktop_diagnostics'),
      invoke('get_diagnostic_logs'),
    ]);
    renderDiagnostics(diag);
    renderLogs(logs);
  } catch (e) {
    console.warn('diagnostics refresh failed', e);
  }
}

async function bindActions() {
  const { invoke } = tauri().core;

  document.getElementById('btn-back').addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  document.getElementById('btn-retry').addEventListener('click', async () => {
    await invoke('retry_native_startup');
    await refreshAll();
  });

  document.getElementById('btn-restart').addEventListener('click', async () => {
    await invoke('restart_native_engine');
    await refreshAll();
  });

  document.getElementById('btn-clear').addEventListener('click', async () => {
    await invoke('clear_diagnostic_logs');
    await refreshAll();
  });

  document.getElementById('btn-copy').addEventListener('click', async () => {
    const text = await invoke('copy_diagnostics_text');
    await navigator.clipboard.writeText(text);
  });

  document.getElementById('btn-export').addEventListener('click', async () => {
    const bundle = await invoke('export_diagnostics_bundle');
    const json = JSON.stringify(bundle, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadText(`thestuu-diagnostics-${stamp}.json`, json);
  });

  document.getElementById('btn-export-txt').addEventListener('click', async () => {
    const text = await invoke('copy_diagnostics_text');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadText(`thestuu-diagnostics-${stamp}.txt`, text, 'text/plain');
  });

  document.getElementById('auto-scroll').addEventListener('change', (e) => {
    autoScroll = e.target.checked;
  });

  document.getElementById('category-filter').addEventListener('change', (e) => {
    categoryFilter = e.target.value;
    refreshAll();
  });
}

function bindShortcut() {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      if (!window.location.pathname.endsWith('diagnostics.html')) {
        window.location.href = 'diagnostics.html';
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      window.location.href = 'index.html';
    }
  });
}

export async function initDiagnostics() {
  bindShortcut();
  if (!tauri()) {
    document.getElementById('log-view').innerHTML =
      '<div class="log-empty">Tauri API unavailable — run via npm run desktop:dev</div>';
    return;
  }
  await bindActions();
  const { listen } = tauri().event;
  listen('desktop://diagnostics', (event) => {
    renderDiagnostics(event.payload);
  });
  listen('desktop://status', async () => {
    await refreshAll();
  });
  await refreshAll();
  setInterval(refreshAll, 2000);
}

initDiagnostics();
