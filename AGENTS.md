# AGENTS.md — TheStuu project instructions

Canonical rules for coding agents and contributors. When anything conflicts with a one-off prompt, **this file and `docs/daw-authority-guardrails.md` win** for architecture and DAW behavior.

---

## Architecture (who owns what)

```text
Dashboard (Next.js)     →  renders confirmed state; optimistic UI must reconcile
Engine (Node.js)        →  router / cache / orchestrator only — NOT a second DAW
native-engine (C++/TE)  →  authoritative DAW: transport, clips, tracks, mixer, plugins, undo, project I/O
Tauri (apps/desktop)    →  shell + process lifecycle only — NOT DAW state
CLI (apps/cli)          →  spawns and coordinates the stack (npm run start)
```

### Native / Tracktion owns DAW-critical state

When native-first flags are active (default via `npm run start`), **only** `apps/native-engine` may own:

- Transport (play, pause, stop, seek, BPM, playhead)
- Audio clip arrangement (`start`, `length`, `source_path`, track placement)
- Track layout (create, delete, reorder, native-backed names where synced)
- Mixer (volume, pan, mute, solo, record arm, master)
- VST/plugin graph in the edit engine
- DAW undo/redo (`edit.undo` / `edit.redo`)
- DAW project export/import (`project.export` / `project.import`)

The Node engine holds a **reconciled cache** plus JSON **sidecar** metadata (patterns, view bars, clip gain/fades/waveform UI, song structure lane, VST node UI metadata). That cache is updated from native export/reconcile — not the other way around for arrangement.

### Node is router / cache / orchestrator only

`apps/engine` may:

- Expose Socket.IO commands and forward to native IPC
- Merge native snapshots into `engine:state` for the dashboard
- Run AI, cloud, import preparation, plugin catalog cache, logging
- Manage process expectations and diagnostics payloads

`apps/engine` must **not**:

- Become the source of truth for timeline, clips, tracks, mixer, or transport
- Invent a parallel DAW model that native never confirmed
- Fake transport or arrangement when native is offline

### Tauri is shell / process lifecycle only

`apps/desktop` (Tauri):

- Spawns or reuses `thestuu-native`, probes health, surfaces lifecycle logs
- Loads the dashboard URL in a webview when reachable
- Does **not** own clips, transport, mixer, or project files

Do not add DAW logic to Rust shell code. Shell diagnostics feed the dashboard LOGS panel (see below).

---

## Diagnostics

### LOGS panel is the canonical diagnostics UI

All operators and agents should use the **dashboard top-bar → logs** panel for:

- Health: Dashboard, Node engine, native-engine, IPC, Tracktion, Audio device
- Structured log stream (engine, Tauri shell, native lifecycle when in desktop)
- Actions: copy, export, clear, restart native (Tauri only)

There is **no** separate first-class diagnostics product UI. Legacy `diagnostics.html` redirects to the dashboard.

**UI online ≠ DAW ready.** Health can show Node reachable while `nativeTransport` / `dawReady` is false — transport and DAW editing must stay disabled until native path is usable.

Reference: `docs/desktop-diagnostics.md`, component `apps/dashboard/components/connection-status-logs.jsx`.

### Browser DevTools are frontend-only

Use browser DevTools for:

- React/component debugging, CSS, client-side performance
- Socket.IO message inspection (supplement only)

Do **not** treat DevTools console as the canonical place for native-engine, IPC, or audio-device diagnosis. Use the **LOGS** panel and engine terminal output from `npm run start`.

---

## Development workflow

### New DAW features must be native-first

Required order:

1. Define or extend the command in `packages/protocol` and/or `docs/native-ipc.md`
2. Implement in `apps/native-engine` and emit snapshot/events (`transport.tick`, `edit.snapshot`, etc.)
3. In `apps/engine`: forward IPC only; update cache inside `runDuringNativeReconcile` / merge helpers
4. In `apps/dashboard`: render confirmed state; reconcile optimistic UI after native response

Do **not** ship new arrangement/mixer/transport features as JSON-only Node mutations.

### Legacy mode is compatibility-only

- **Default:** `npm run start` → native-first (`STUU_NATIVE_CLIP_OPS=1`, track ops, edit undo, project sidecar, `STUU_NATIVE_LEGACY_SYNC=0`)
- **Legacy:** `npx thestuu start --legacy-daw` → JSON arrangement path for smoke tests only (`qa:legacy-daw`)

Legacy mode is **not** a performance or product target. The LOGS panel warns when `clipOps=false` / `dawAuthority=legacy-json`.

Do not add product features that only work in legacy mode.

### Start commands (reference)

| Goal | Command |
|------|---------|
| Full stack (normal) | `npm run start` |
| Legacy QA | `npm run start -- --legacy-daw` |
| Dashboard only (needs engine) | `npm run dev --prefix apps/dashboard` |
| Desktop shell | `npm run desktop:dev` (dashboard must be up) |

Ports (default): dashboard `3010`, engine `3990`.

---

## Required QA before merge

Run these for any change touching `apps/engine`, `apps/native-engine`, `apps/dashboard` DAW paths, or `packages/protocol`:

```bash
npm run check:daw-authority    # static pattern guard
npm run test:daw-authority     # unit tests (merge + assertions)
```

For native DAW behavior (required before merging engine/native/dashboard DAW work):

```bash
npm run start -- --no-browser   # terminal 1 — wait until healthy
npm run qa:native-daw           # terminal 2 — expect 23/23 pass
```

For legacy regression (when touching legacy paths):

```bash
npm run start -- --legacy-daw --no-browser
npm run qa:legacy-daw
```

Performance-sensitive dashboard changes: see `docs/performance.md` (prod build benchmark, Profiler scenarios).

CI (`.github/workflows/daw-qa.yml`): `check:daw-authority` + `test:daw-authority` on PR.

---

## Forbidden Node mutation patterns

Do **not** add or reintroduce:

| Pattern | Why |
|---------|-----|
| Direct writes to `clip.start`, `clip.length`, `source_path` for audio clips when native clip ops are on | Arrangement is native-owned; use IPC + reconcile |
| Mutating `state.project.playlist` / mixer for DAW commands without native round-trip | Second DAW in Node |
| Extending `projectHistory` for tracks/clips/mixer/plugins when `STUU_NATIVE_EDIT_UNDO=1` | Undo must be native |
| New calls to `syncNativeArrangementFromPlaylist` / `edit:clear-audio-clips` outside the legacy hub | Legacy sync only |
| `emitTransport` driven by a JS clock while native transport is active | Desyncs playhead |
| Fake meters or fake transport when native is down | Misleads UI; show offline |
| `STUU_NATIVE_LEGACY_SYNC=1` in default/start paths | Breaks native-first QA |

Runtime guards: `apps/engine/src/daw-authority.js` (`assertLegacyJsonArrangementAllowed`, `assertDirectArrangementMutationAllowed`, `assertJsonProjectHistoryAllowed`).

Static guard: `scripts/check-daw-authority.sh` (allowlisted files only).

Allowed JSON-only (sidecar): clip `gain`, fades, `waveform_peaks`, `name`, `color`, trim metadata; patterns; `playlist_view_bars`; song structure UI; VST node metadata. See `docs/daw-authority-guardrails.md`.

---

## Git and repository hygiene

### Do not commit

- `node_modules/`
- `vendor/` (Tracktion/JUCE trees — use `scripts/setup-tracktion.sh` / `STUU_NATIVE_VENDOR_DIR` locally)
- Build outputs: `apps/native-engine/build/`, `build-tracktion/`, `target/`, `*.o`, `thestuu-native` binaries
- `.env`, secrets, local sockets, user home project files

Stage only deliberate source, docs, and small config changes. If `git status` shows thousands of vendor or build files, **do not** `git add -A`.

### Commits

- One logical change per commit; clear message (e.g. `feat:`, `fix:`, `docs:`)
- Do not commit unless the user asked
- Run `check:daw-authority` / `test:daw-authority` before DAW-related commits when feasible

---

## UI rules (dashboard)

### Styleguide

1. UI/UX changes must follow `docs/styleguide-ui.md`.
2. App-wide style (`Edit`, `Mix`, Node, Inspector, Chat): modern black/white.
3. No colored defaults unless the user explicitly requests them.
4. On conflict, `docs/styleguide-ui.md` wins for visual design.

### Icons

Use **Lucide React** (`lucide-react`) only for buttons, toolbars, status — no ad-hoc SVG icon sets.

### Edit layout

1. Pattern browser stays removed.
2. Track/grid layout follows FL-style playlist.
3. Track 1 keeps the primary `+` for pattern/clip creation.

---

## Performance (dashboard)

High-frequency paths must not re-render the full shell on every meter tick:

- Meters: `apps/dashboard/context/meters-context.jsx`, `apps/dashboard/lib/meter-store.js`
- Global meter animation: `apps/dashboard/lib/meter-animator.js`
- Engine meter gating: `client:meter_pause` when tab hidden or not Edit/Mix

See `docs/performance.md`.

---

## Further reading

| Doc | Topic |
|-----|--------|
| `docs/daw-authority-guardrails.md` | Authority tables, flags, code locations |
| `docs/architecture-state-authority.md` | State flow architecture |
| `docs/native-ipc.md` | IPC commands and events |
| `docs/desktop-diagnostics.md` | LOGS panel and Tauri diagnostics |
| `docs/desktop-tauri.md` | Desktop shell setup |
| `docs/performance.md` | Performance QA and env vars |
| `README.md` | Human onboarding and commands |
| `.cursor/rules/daw-state-authority.mdc` | Cursor-specific DAW rule mirror |
