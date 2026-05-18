# Session recovery and crash-safe saves

TheStuu protects JSON sidecar projects (`.stu` under `~/.thestuu/projects`) from partial writes and offers recovery after crashes. **Native-engine remains authoritative** for DAW state: autosave and manual save call `project.export` before writing the sidecar when `STUU_NATIVE_PROJECT_SIDECAR=1`.

## Autosave behavior

- **Interval**: default 60s (`STUU_AUTOSAVE_INTERVAL_MS`, minimum 5s). Disable with `STUU_AUTOSAVE=0`.
- **Trigger**: timer runs only while the session is **dirty** (after successful mutations). One snapshot is also attempted at boot when native transport is online.
- **Flow**: native export → `mergeAuthoritativeProjectState` → validate → write timestamped file under `~/.thestuu/autosave/`, then mirror to `latest.autosave.stu`.
- **Primary files**: autosaves never overwrite `~/.thestuu/projects/*.stu` unless you explicitly save or restore into the session.

## Atomic save (manual `project:save`)

1. Write to `*.tmp.<pid>.<time>` in the project directory.
2. Parse and validate JSON with `@thestuu/shared-json`.
3. Optionally copy previous file to `*.bak`.
4. `rename` temp → primary (atomic on POSIX).

Failed validation deletes the temp file and leaves the primary unchanged.

## Recovery on startup

Runtime marker: `~/.thestuu/session/runtime.json`

| Field | Meaning |
|-------|---------|
| `cleanShutdown` | `true` after SIGINT/SIGTERM shutdown handler |
| `dirty` | Session had unsaved edits |
| `pid` | Last engine PID |
| `lastAutosaveAtMs` | Last successful autosave |
| `lastSaveError` | Last failed save/autosave |
| `lastRestoreResult` | Last `recovery:restore` outcome |

**Crash detected** when a previous marker has `dirty: true`, `cleanShutdown: false`, and a different PID.

Candidates (newest first):

- `latest.autosave.stu`
- `*.autosave.stu` in autosave dir
- Orphan `*.tmp.*` files in projects dir (interrupted atomic save)
- Primary project (reference)

Socket API:

- `recovery:list` — refresh candidates
- `recovery:restore` `{ path }` — load snapshot into memory (native import when sidecar enabled)
- `recovery:dismiss` — clear crash notice in marker

Dashboard **LOGS** panel shows recovery rows and structured `[recovery]` log lines.

## Plugin diagnostics (groundwork)

Structured logs (category `plugin`) for:

- `vst:load` / `vst:add` failures
- `vst:scan` failure or timeout
- Native disconnect while a plugin action is in flight

No plugin sandboxing yet.

## Diagnostics export

Tauri **export** bundle includes `engineHealth`, `sessionRecovery`, `crashMarkers`, `lastNativeDisconnectReason`, `lastProjectRestoreResult`, and `autosaveMetadata` from `GET /health` → `diagnostics.sessionRecovery`.

## Storage locations

| Path | Purpose |
|------|---------|
| `~/.thestuu/projects/` | Primary `.stu` projects |
| `~/.thestuu/autosave/` | Timestamped autosave snapshots + `latest.autosave.stu` |
| `~/.thestuu/session/runtime.json` | Session / crash marker |
| `~/.thestuu/projects/*.tmp.*` | In-flight atomic writes (orphans if killed mid-save) |
| `~/.thestuu/projects/*.bak` | Previous primary before last successful atomic save |

Override home: `STUU_HOME`.

## Limitations

- Recovery restores **sidecar JSON + native import**; it does not replay unsent real-time edits held only in memory.
- Autosave frequency trades disk use vs. data loss window (up to one interval).
- Plugin crashes may still take down native-engine; detection/logging only, no isolation.
- No cloud sync or multi-machine merge.
- Legacy JSON-only mode (`STUU_NATIVE_PROJECT_SIDECAR=0`) skips native export on save/autosave; sidecar may drift from native until reconnect.

## QA

```bash
npm run check:daw-authority
npm run test:daw-authority
npm run qa:native-daw
npm run qa:legacy-daw
npm run test --prefix apps/engine
```
