# Desktop diagnostics and logging

Integrated diagnostics for the Tauri desktop shell (`apps/desktop`). This layer helps users and developers understand engine state **without relying on terminal output**.

Tauri remains a **shell only** — diagnostics probes and logs do not mutate DAW state.

## Opening diagnostics

| Method | Where it works |
|--------|----------------|
| **Diagnostics** button | Shell offline page (`index.html`) |
| **⌘⇧D** (Ctrl+Shift+D on Windows/Linux) | Shell pages (`index.html`, `diagnostics.html`) |
| `open_diagnostics` Tauri command | Programmatic |

When the dashboard URL is loaded in the webview, use shell pages or restart via `index.html` to open diagnostics. Browser devtools on the Next.js app are separate (see below).

## What the panel shows

| Indicator | Meaning |
|-----------|---------|
| Dashboard | HTTP reachable at `THESTUU_DASHBOARD_URL` (default `:3010`) |
| Node engine | `GET /health` on engine port (default `:3990`) |
| native-engine process | Unix socket accepting connections |
| IPC connected | `health.ping` over native MessagePack IPC |
| Tracktion backend | `backend.info` → `tracktion: true` |
| Audio device | `audio.get_outputs` returned devices or current id |
| DAW ready | IPC + Tracktion + audio (native path usable) |

Also shown:

- Active **socket path**
- **Native mode** and `STUU_NATIVE_*` flags (from shell process environment)
- **Error category**: `startup` \| `ipc` \| `audio` \| `plugin` \| `project` \| `transport` \| `unknown`
- **Last native error** (if any)

## Log viewer

Rolling in-memory log (up to ~2000 entries):

| Field | Description |
|-------|-------------|
| timestamp | Local time + ms |
| level | `info` \| `warn` \| `error` |
| source | `shell` \| `native-stdout` \| `native-stderr` |
| category | Auto-classified from message text |
| message | Raw line |

Features:

- Auto-scroll toggle
- Category filter
- **Clear logs**
- **Copy diagnostics** (JSON to clipboard)
- **Export JSON** / **Export text** (download)

### Where logs live

| Location | Persisted? |
|----------|------------|
| In-memory `DiagnosticsLog` (Rust) | No — cleared when desktop app exits |
| Export JSON/text download | Yes — user saves file |
| Terminal (`npm run start`) | Separate — CLI/engine/native still log to terminal |

There is no automatic log file on disk yet.

## Actions (no DAW control)

| Button | Effect |
|--------|--------|
| Retry native-engine | Stop managed native (if any) and spawn/reconnect |
| Restart native-engine | Same as retry (full managed restart) |
| Clear logs | Clears in-memory diagnostic log buffer |
| Copy / Export | Diagnostics bundle (see below) |

These do **not** start/stop Node, open projects, or change transport/mixer state.

## Export bundle

`export_diagnostics_bundle` / Copy / Export produce JSON containing:

- `exportedAtMs`, `appVersion`
- `platform` (os, arch)
- Full `status` object (dashboard, engine, native health, flags)
- All log entries
- Default socket path

ZIP packaging and crash upload are **future work**.

## Tauri commands

| Command | Purpose |
|---------|---------|
| `get_desktop_diagnostics` | Full status struct |
| `get_diagnostic_logs` | Structured log entries |
| `get_desktop_status` | Legacy subset for offline page |
| `get_native_logs` | Plain-text log lines (compat) |
| `clear_diagnostic_logs` | Clear buffer |
| `retry_native_startup` | Retry native sidecar |
| `restart_native_engine` | Restart native sidecar |
| `export_diagnostics_bundle` | JSON export |
| `copy_diagnostics_text` | Pretty JSON string |
| `open_diagnostics` | Navigate to `diagnostics.html` |
| `open_shell_home` | Navigate to `index.html` |

Events: `desktop://diagnostics`, `desktop://status` (every ~2s).

## Browser devtools vs integrated diagnostics

| Need | Use |
|------|-----|
| Native-engine / IPC / audio readiness | **Desktop diagnostics** |
| Sidecar spawn errors, socket path | **Desktop diagnostics** |
| Node engine HTTP health | **Desktop diagnostics** |
| React/UI bugs in dashboard | Browser devtools on `localhost:3010` |
| WebSocket IPC message traces | Browser devtools + engine logs |
| CI / scripted QA | `npm run qa:native-daw`, etc. |

## Future: crash reporting

Planned (not implemented):

- Optional crash log directory under `~/.thestuu/logs/`
- User-consented upload bundle
- Symbolicated native stack traces (platform-specific)

## Files

```
apps/desktop/offline/
  index.html           # Shell home + link to diagnostics
  diagnostics.html     # Diagnostics panel
  diagnostics.js
  diagnostics.css
apps/desktop/src-tauri/src/
  diagnostics.rs       # Log store, engine probe, export
  native_sidecar.rs    # Forwards native stdout/stderr to log store
  lib.rs               # Commands + events
```

See also: `docs/desktop-tauri.md`, `docs/daw-authority-guardrails.md`.
