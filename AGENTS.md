# AGENTS.md — TheStuu project instructions

Full multi-line project guardrails for agents and contributors (not a minified or abbreviated export).

Canonical rules for coding agents and contributors. When anything conflicts with a one-off prompt, **this file and `docs/daw-authority-guardrails.md` win** for architecture and DAW behavior.

**Current baseline (main):** native-first QA, legacy smoke, Tauri shell with native + Node sidecars, LOGS panel diagnostics. Do not regress these without explicit intent.

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

`apps/desktop` (Tauri) manages **process lifecycle only**:

| Sidecar | Behavior |
|---------|----------|
| **native-engine** | Spawn or reuse Unix socket; stop on exit only if Tauri launched it |
| **Node engine** | Spawn `node apps/engine/src/server.js` or reuse `/health` on `:3990`; stop on exit only if Tauri launched it |
| **Dashboard URL** | Navigate webview when `THESTUU_DASHBOARD_URL` is reachable (does not spawn Next.js) |

Tauri must **not**:

- Own clips, transport, mixer, or project files
- Mutate DAW state over IPC except documented read-only health probes
- Implement arrangement, mixer, or transport logic in Rust

Shell and sidecar stdout/stderr feed the dashboard **LOGS** panel via `get_diagnostic_logs` / `desktop://diagnostics`. See `docs/desktop-tauri.md`.

### New DAW-core features must be native-first

Required order:

1. Define or extend the command in `packages/protocol` and/or `docs/native-ipc.md`
2. Implement in `apps/native-engine` and emit snapshot/events (`transport.tick`, `edit.snapshot`, etc.)
3. In `apps/engine`: forward IPC only; update cache inside `runDuringNativeReconcile` / merge helpers
4. In `apps/dashboard`: render confirmed state; reconcile optimistic UI after native response

Do **not** ship new arrangement/mixer/transport features as JSON-only Node mutations.

### Legacy mode is compatibility-only

- **Default:** `npm run start` → native-first (`STUU_NATIVE_CLIP_OPS=1`, track ops, edit undo, project sidecar, `STUU_NATIVE_LEGACY_SYNC=0`)
- **Legacy:** `npm run start -- --legacy-daw` → JSON arrangement path for smoke tests only (`qa:legacy-daw`)

Legacy mode is **not** a performance or product target. The LOGS panel warns when `clipOps=false` / `dawAuthority=legacy-json`.

Do not add product features that only work in legacy mode.

---

## Diagnostics

### LOGS panel is the canonical diagnostics UI

All operators and agents should use the **dashboard top-bar → logs** panel for:

- Health: **Dashboard**, **Node engine**, **native-engine**, **IPC**, **Tracktion**, **Audio device** (separate rows — Node online ≠ DAW ready)
- Structured log stream (`engine`, `tauri-shell`, `native-engine`, `desktop-lifecycle`)
- Actions: copy, export, clear, restart native / restart node (Tauri only)

There is **no** separate first-class diagnostics product UI. Legacy `diagnostics.html` redirects to the dashboard.

**UI online ≠ DAW ready.** Health can show Node reachable while `nativeTransport` / `dawReady` is false — transport and DAW editing must stay disabled until the native path is usable.

Reference: `docs/desktop-diagnostics.md`, `apps/dashboard/components/connection-status-logs.jsx`, `apps/dashboard/lib/desktop-diagnostics-bridge.js`.

### Browser DevTools are frontend-only

Use browser DevTools for:

- React/component debugging, CSS, client-side performance
- Socket.IO message inspection (supplement only)

Do **not** treat DevTools console as the canonical place for native-engine, IPC, audio-device, or Tauri sidecar diagnosis. Use the **LOGS** panel and `npm run start` terminal output.

---

## Development workflow

### Start commands (reference)

| Goal | Command |
|------|---------|
| Full stack (normal) | `npm run start` |
| Stack without browser | `npm run start -- --no-browser` |
| Legacy QA | `npm run start -- --legacy-daw --no-browser` |
| Dashboard only (needs engine) | `npm run dev --prefix apps/dashboard` |
| Desktop shell | `npm run desktop:dev` (reuses or spawns native + Node; dashboard must be up for full UI) |

Ports (default): dashboard `3010`, engine `3990`.

### Tracktion vendor (local only)

Native build expects a local `tracktion_engine` tree — **not** committed to git (see audit below).

```bash
# From repo root
./scripts/setup-tracktion.sh
# or: git clone tracktion_engine into vendor/tracktion_engine with JUCE submodules
export STUU_NATIVE_VENDOR_DIR="$(pwd)/vendor/tracktion_engine"
```

CMake output: `apps/native-engine/build/thestuu-native` (ignored by `.gitignore`).

---

## Required QA before merge

Run for any change touching `apps/engine`, `apps/native-engine`, `apps/dashboard` DAW paths, `apps/desktop` lifecycle, or `packages/protocol`:

```bash
npm run check:daw-authority    # static pattern guard
npm run test:daw-authority     # unit tests (merge + assertions)
```

**Native-first E2E** (required before merging engine/native/dashboard DAW work):

```bash
# Stop stale processes on :3990 / :3010 first
npm run start -- --no-browser   # wait until /health shows nativeTransport: true
npm run qa:native-daw           # expect 23/23 pass
```

**Legacy regression** (when touching legacy paths):

```bash
npm run start -- --legacy-daw --no-browser
npm run qa:legacy-daw
```

**Desktop shell** (when touching `apps/desktop`):

```bash
npm run desktop:dev   # Cargo build + window; verify Node reuse on :3990 and spawn when port free
```

Performance-sensitive dashboard changes: `docs/performance.md`.

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
| DAW logic in Tauri Rust or desktop shell IPC beyond health/lifecycle | Shell only |

Runtime guards: `apps/engine/src/daw-authority.js`.

Static guard: `scripts/check-daw-authority.sh` (allowlisted files only).

Allowed JSON-only (sidecar): clip `gain`, fades, `waveform_peaks`, `name`, `color`, trim metadata; patterns; `playlist_view_bars`; song structure UI; VST node metadata. See `docs/daw-authority-guardrails.md`.

---

## Git and repository hygiene

### Do not commit

| Path / pattern | Reason |
|----------------|--------|
| `node_modules/` | npm install |
| `vendor/` | Tracktion/JUCE — clone locally (`scripts/setup-tracktion.sh`) |
| `apps/native-engine/build/` | CMake output (default build dir) |
| `apps/native-engine/build-tracktion/` | Alternate CMake build dir (must not be tracked) |
| `apps/desktop/src-tauri/target/` | Rust/Tauri build |
| `*.o`, `*.a`, `*.dylib`, `a.out`, `CMakeCache.txt` under build dirs | Generated objects |
| `thestuu-native`, `thestuu-native.exe` | Compiled binary |
| `.env`, secrets, `*.sock` | Local/runtime |

Stage only deliberate source, docs, and small config changes. If `git status` shows hundreds of `vendor/` or `build-tracktion/` files, **do not** `git add -A`.

### Commits

- One logical change per commit; clear message (`feat:`, `fix:`, `docs:`)
- Do not commit unless the user asked
- Run `check:daw-authority` / `test:daw-authority` before DAW-related commits when feasible

---

## Tracked artifacts audit

**Status on `main` (post `3d6afb2`):** historical commits still track generated/vendor trees. **New commits must not add more.** Recent feature commits (e.g. Node sidecar) are clean.

| Category | Tracked count | Introduced | Risk |
|----------|---------------|------------|------|
| `vendor/tracktion_engine/**` | **559** files | `d23e269` (monorepo flatten) | Huge PR noise; wrong platform binaries; submodule drift; license footprint |
| `apps/native-engine/build-tracktion/**` | **415** files | `d23e269` | Machine-specific CMake cache, `.o`, `a.out`, compiled **`thestuu-native`** — breaks other OS/arch |
| Binaries / objects in index | **~50+** `.o`, `.bin`, `a.out`, **1×** `thestuu-native` | same | Bloated clone; accidental overwrite of working local builds |

**What is *not* tracked (good):** `node_modules/`, `apps/native-engine/build/` (default), `apps/desktop/src-tauri/target/` — listed in `.gitignore` and respected for new work.

**Why this is risky**

1. Agents running `git add -A` can re-stage thousands of vendor/build files despite local `.gitignore`.
2. Tracked `thestuu-native` may not match the developer’s OS/arch or vendor path.
3. CI and clones pull megabytes of generated junk unrelated to application source.
4. Contradicts documented workflow (`vendor/` should be local via `setup-tracktion.sh`).

### Proposed cleanup plan (separate PR — do not run blindly)

**Phase 1 — Harden ignores (safe, this repo)**

- Extend `.gitignore` for `vendor/`, `build-tracktion/`, `target/`, `*.o`, binaries (done in `.gitignore`).
- Keep `AGENTS.md` + `README.md` as the source of truth for `setup-tracktion.sh`.

**Phase 2 — Stop tracking generated files (requires explicit maintainer PR)**

```bash
# Preview what would be removed from the index only (files stay on disk):
git ls-files 'vendor/*' 'apps/native-engine/build-tracktion/*' | wc -l

# When approved:
git rm -r --cached vendor/tracktion_engine apps/native-engine/build-tracktion
git commit -m "chore: stop tracking vendor and cmake build artifacts"
```

**Phase 3 — Verify**

- Fresh clone + `./scripts/setup-tracktion.sh` + `npm run start -- --no-browser` + `npm run qa:native-daw`
- Confirm `git status` stays clean after local builds

**Do not** delete local `vendor/` or `build/` directories on disk during Phase 2 — only remove from git index.

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
| `docs/desktop-tauri.md` | Desktop shell + Node/native sidecars |
| `docs/performance.md` | Performance QA and env vars |
| `README.md` | Human onboarding and commands |
| `.cursor/rules/daw-state-authority.mdc` | Cursor-specific DAW rule mirror |
