# Desktop diagnostics and logging

Native-engine and Tauri shell diagnostics are integrated into the **dashboard LOGS panel** (top bar → **logs**). There is no separate diagnostics window.

Tauri remains a **shell only** — probes and logs do not mutate DAW state.

## Opening diagnostics

| Context | How |
|---------|-----|
| **Browser / desktop webview** | Top bar → **logs** (connection status area) |
| **Shell offline page** | **Open dashboard** — use **logs** in the loaded UI |
| **Legacy `diagnostics.html`** | Redirects to dashboard (`:3010`) |

## What the LOGS panel shows

### Health indicators

| Indicator | Meaning |
|-----------|---------|
| Dashboard | Node Socket.IO reachable (UI session online) |
| Node engine | Same as dashboard online in browser; Tauri also probes `GET /health` |
| native-engine | Managed native process / socket accepting connections |
| IPC | `health.ping` over native MessagePack IPC |
| Tracktion | `backend.info` → Tracktion backend ready |
| Audio device | `audio.get_outputs` returned devices or current id |

**UI online does not imply DAW ready.** Transport/play controls stay disabled until `nativeTransport` is true (DAW path usable).

In Tauri, health rows also reflect `desktop://status` / `get_desktop_diagnostics`.

### Structured log stream

Normalized entries:

| Field | Description |
|-------|-------------|
| `timestamp` | Local time (ms) |
| `source` | `engine`, `tauri-shell`, `native-engine`, `ipc`, `audio`, `desktop-lifecycle`, `ui` |
| `category` | `startup`, `ipc`, `audio`, `plugin`, `project`, `transport`, `unknown` |
| `level` | `info`, `warn`, `error`, `log` |
| `event` | Optional event name |
| `message` / `text` | Log line |

Sources:

- **engine** — Node engine via Socket.IO `engine:log` / `engine:logs:init`
- **tauri-shell**, **native-engine**, **ipc**, **audio**, **desktop-lifecycle** — Tauri sidecar (when running in desktop webview)

### Actions (LOGS panel)

| Action | Browser | Tauri desktop |
|--------|---------|---------------|
| **restart native** | — | Restarts managed native-engine |
| **copy** | Clipboard (log lines) | `copy_diagnostics_text` (full bundle) |
| **export** | JSON (logs + connection snapshot) | `export_diagnostics_bundle` |
| **clear** | Clears UI log buffer | Also clears Rust diagnostic buffer |

These do **not** start/stop Node, open projects, or change transport/mixer state.

## Export bundle (Tauri)

`export_diagnostics_bundle` includes:

- `exportedAtMs`, `appVersion`
- `platform` (os, arch)
- Full status (dashboard, engine, native health, enabled flags)
- All log entries
- Audio device info when available
- Default socket path

## Tauri commands (used by dashboard bridge)

| Command | Purpose |
|---------|---------|
| `get_desktop_diagnostics` | Full status struct |
| `get_diagnostic_logs` | Structured log entries |
| `clear_diagnostic_logs` | Clear Rust buffer |
| `retry_native_startup` | Retry native sidecar |
| `restart_native_engine` | Restart native sidecar |
| `export_diagnostics_bundle` | JSON export |
| `copy_diagnostics_text` | Pretty JSON string |

Events: `desktop://diagnostics`, `desktop://status`.

## Browser devtools vs LOGS panel

| Need | Use |
|------|-----|
| Native-engine / IPC / audio readiness | **LOGS panel** (Tauri: full health; browser: engine + UI logs) |
| Sidecar spawn errors, socket path | **LOGS panel** (Tauri) |
| React/UI bugs, CSS, component state | Browser devtools on `localhost:3010` |
| CI / scripted QA | `npm run qa:native-daw`, `npm run check:daw-authority` |

Browser **console is not required** for normal engine/native diagnostics when using the desktop app or LOGS panel.

## Implementation files

```
apps/dashboard/
  components/connection-status-logs.jsx   # LOGS UI + health grid + actions
  lib/live-logs.js                        # Structured log normalization
  lib/desktop-diagnostics-bridge.js       # Tauri invoke + events
apps/desktop/src-tauri/src/
  diagnostics.rs                          # Log store, probes, export
  native_sidecar.rs                       # Forwards native stdout/stderr
```

See also: `docs/desktop-tauri.md`, `docs/daw-authority-guardrails.md`.
