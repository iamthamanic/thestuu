# TheStuu desktop shell (Tauri)

Tauri is a **desktop window and OS integration layer only**. It does not own, mutate, or reconcile DAW state.

| Layer | Role |
|-------|------|
| `apps/native-engine` | **DAW truth** (Tracktion) — clips, tracks, transport, mixer, undo |
| `apps/engine` | Node router + JSON sidecar (patterns, view, metadata) |
| `apps/dashboard` | Next.js UI |
| `apps/cli` | Dev/start workflow (`npm run start`) |
| `apps/desktop` | **Tauri shell** — window, native + Node lifecycle, diagnostics |

See also: `docs/daw-authority-guardrails.md`, `docs/architecture-state-authority.md`.

## Architecture (phase 2 — native + Node sidecars)

```mermaid
flowchart LR
  subgraph dev["Developer machine"]
    CLI["apps/cli\nnpm run start"]
    NAT["native-engine\nUnix IPC"]
    ENG["apps/engine\n:3990"]
    DASH["apps/dashboard\n:3010"]
    TAU["apps/desktop\nTauri"]
  end
  CLI --> NAT
  CLI --> ENG
  CLI --> DASH
  TAU -->|"spawn or reuse"| NAT
  TAU -->|"spawn or reuse"| ENG
  TAU -->|"HTTP if up"| DASH
  DASH --> ENG
  ENG --> NAT
```

**Tauri never sits in the DAW data path.** It may spawn `thestuu-native` and the Node engine, probe health, and capture stdout/stderr into the dashboard LOGS panel; it does not implement clip/track/project logic.

## Status model (shell UI)

The bundled shell page (`apps/desktop/offline/index.html`) and dashboard LOGS panel distinguish:

| Indicator | Meaning |
|-----------|---------|
| **Dashboard** | Dashboard HTTP reachable (`127.0.0.1:3010` or `THESTUU_DASHBOARD_URL`) |
| **Node engine** | `GET /health` on engine port returns `ok` + `service: "thestuu-engine"` |
| **native-engine process** | Unix socket accepting connections (spawned by Tauri or reused from `npm run start`) |
| **IPC connected** | `health.ping` → `{ pong: true }` over native MessagePack IPC |
| **Tracktion backend ready** | `backend.info` → `{ tracktion: true }` |
| **Audio device ready** | `audio.get_outputs` returns devices or a current output id |
| **DAW ready** | IPC + Tracktion + audio (native truth path usable) |

Node health is **separate** from native IPC, Tracktion, and audio. A green Node row only means the Socket.IO router is up; DAW readiness still requires native IPC + Tracktion + audio.

If a managed sidecar fails to start, the shell shows an error and **Retry** / **restart** actions — it does not fake DAW state.

## Current dev flow

### Full stack (unchanged)

```bash
npm run start
```

Starts native-engine, Node engine, and dashboard via `apps/cli`. Tauri is not required.

### Desktop shell

**Option A — desktop manages native + Node** (dashboard still manual unless already running):

```bash
# Build native binary once (CMake)
# apps/native-engine/build/thestuu-native

npm run desktop:dev
```

Tauri startup order:

1. **native-engine** — spawn or reuse Unix socket
2. **Node engine** — spawn `node apps/engine/src/server.js` with `STUU_NATIVE_SOCKET` matching native, or reuse existing `/health` on port 3990
3. **Dashboard URL** — navigate webview when `THESTUU_DASHBOARD_URL` is reachable (does not spawn Next.js; run dashboard separately or use `npm run start` in another terminal)

Managed processes are stopped on app exit **only when Tauri launched them**. Reused processes from `npm run start` are left running.

**Option B — stack already running** (`npm run start` in another terminal):

```bash
npm run desktop:dev
```

Tauri **reuses** existing native socket and Node `/health`. It does **not** kill reused processes on exit.

### Scripts

| Command | Description |
|---------|-------------|
| `npm run start` | CLI: native + engine + dashboard (unchanged) |
| `npm run desktop:dev` | Tauri dev window + native + Node sidecar lifecycle |
| `npm run desktop:build` | Tauri release bundle (native binary must exist for sidecar) |

### Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `THESTUU_DASHBOARD_URL` | `http://127.0.0.1:3010` | Dashboard URL for webview navigation |
| `ENGINE_HOST` | `127.0.0.1` | Node engine bind host |
| `ENGINE_PORT` | `3990` | Node engine port (`/health` probe + spawn env) |
| `STUU_NATIVE_SOCKET` | `/tmp/thestuu-native.sock` | Unix socket for native IPC (match CLI when reusing) |
| `STUU_HOME` | `~/.thestuu` | Home dir passed to Node engine |
| `STUU_ENGINE_SCRIPT` | `apps/engine/src/server.js` | Override Node entry script |
| `STUU_NODE_BIN` / `NODE` | *(auto on PATH)* | Override Node.js binary |
| `STUU_NATIVE_BIN` / `THESTUU_NATIVE_BIN` | *(auto)* | Override path to `thestuu-native` |
| `THESTUU_REPO_ROOT` | *(auto from crate path)* | Repo root for spawn `cwd` |

Native-first env for spawned Node (aligned with `apps/cli` `buildEngineSpawnEnv`): `STUU_NATIVE_TRANSPORT=1`, `STUU_NATIVE_CLIP_OPS`, `STUU_NATIVE_EDIT_UNDO`, `STUU_NATIVE_TRACK_OPS`, `STUU_NATIVE_PROJECT_SIDECAR`, `STUU_NATIVE_LEGACY_SYNC`, `STUU_METER_INTERVAL_MS`.

## Native-engine sidecar (Tauri `externalBin`)

Configured in `apps/desktop/src-tauri/tauri.conf.json`:

```json
"externalBin": ["../../native-engine/build/thestuu-native"]
```

Tauri expects a target-triplet suffix at build time, e.g.:

| Platform | Sidecar filename (examples) |
|----------|-------------------------------|
| macOS Apple Silicon | `thestuu-native-aarch64-apple-darwin` |
| macOS Intel | `thestuu-native-x86_64-apple-darwin` |
| Linux x86_64 | `thestuu-native-x86_64-unknown-linux-gnu` |
| Windows | `thestuu-native-x86_64-pc-windows-msvc.exe` |

`apps/desktop/src-tauri/build.rs` copies `apps/native-engine/build/thestuu-native` (or `Release/`) to the suffixed name when present.

**Dev binary paths (CMake, not committed):**

- `apps/native-engine/build/thestuu-native`
- `apps/native-engine/build/Release/thestuu-native` (MSVC / multi-config)

Rust spawn API: `app.shell().sidecar("thestuu-native")` with args `--socket <path>`.

## Node engine sidecar (dev spawn)

Implementation: `apps/desktop/src-tauri/src/node_sidecar.rs`

| Behavior | Detail |
|----------|--------|
| Reuse | `GET http://127.0.0.1:3990/health` (or `ENGINE_*`) returns `thestuu-engine` |
| Spawn | `node <repo>/apps/engine/src/server.js` with native socket env |
| Logs | stdout/stderr → LOGS panel as `engine` source (`engine-stdout` / `engine-stderr`) |
| Stop on exit | Only if `engine_managed_by_desktop` |

**Dev fallback:** if shell spawn is blocked (permissions), start the stack with `npm run start` and launch `npm run desktop:dev` — Tauri will reuse Node on 3990.

**Packaged flow:** not implemented yet (no bundled Node runtime in the app).

## Future packaged desktop flow (not implemented)

| Sidecar | Status | Notes |
|---------|--------|-------|
| Native | **Phase 2** — spawn/stop in dev | Production bundling + signing not done |
| Engine (Node) | **Phase 2** — spawn/stop in dev | Bundled Node runtime not done |
| Dashboard | Planned | static export or embedded server |

Target order when complete: native → engine → dashboard → Tauri window.

**Out of scope:** auto-update, code signing, shipping Tracktion/JUCE in git, installers.

## Per-platform build notes

### macOS

- Build native: CMake target `thestuu-native` under `apps/native-engine/build/`.
- `npm run desktop:build` → `.app` under `src-tauri/target/release/bundle/`.
- Notarization / signing: not configured.

### Windows

- Binary: `thestuu-native.exe` in `build/` or `build/Release/`.
- Native IPC uses Unix domain sockets in current code — validate Windows support before shipping.

### Linux

- Rust + `webkit2gtk` (Tauri prerequisites).
- Sidecar: `thestuu-native-x86_64-unknown-linux-gnu` (or arm64 triple).

## Diagnostics UI

Integrated diagnostics panel: **`docs/desktop-diagnostics.md`**

- Open via **Diagnostics** button on shell home or **⌘⇧D**
- Log viewer, status grid, export/copy bundle
- No DAW control actions

## Tauri commands (shell ↔ UI)

| Command | Purpose |
|---------|---------|
| `get_desktop_diagnostics` | Full diagnostics (dashboard, engine, native, flags) |
| `get_diagnostic_logs` | Structured log entries |
| `get_desktop_status` | Legacy status subset |
| `export_diagnostics_bundle` | JSON export for support |
| `retry_native_startup` / `restart_native_engine` | Native sidecar lifecycle |
| `retry_node_startup` / `restart_node_engine` | Node sidecar lifecycle |

Events: `desktop://status`, `desktop://diagnostics` (polled every ~2s).

## QA

```bash
npm run check:daw-authority
npm run test:daw-authority
```

Native QA (engine on `:3990` with native flags):

```bash
STUU_NATIVE_CLIP_OPS=1 STUU_NATIVE_EDIT_UNDO=1 STUU_NATIVE_TRACK_OPS=1 \
STUU_NATIVE_PROJECT_SIDECAR=1 STUU_NATIVE_LEGACY_SYNC=0 npm run qa:native-daw
```

Legacy smoke requires engine **without** `STUU_NATIVE_*=1`:

```bash
npm run qa:legacy-daw
```

If legacy fails with *"engine has native-first flags enabled"*, restart the engine without native env vars — not a desktop regression.

Desktop changes do not modify `apps/engine` DAW authority paths.

## Repository layout

```
apps/desktop/
  offline/index.html       # shell status + retry (not DAW UI)
  src-tauri/
    src/lib.rs             # Tauri app + status poller
    src/native_sidecar.rs  # spawn / reuse / stop native-engine
    src/node_sidecar.rs    # spawn / reuse / stop Node engine
    src/native_health.rs   # IPC health probes (read-only)
    src/diagnostics.rs     # engine /health probe + log buffer
    build.rs               # copy native bin for externalBin triple
  package.json
```

Do not commit: `src-tauri/target/`, `node_modules/`, `vendor/`, native build artifacts.
