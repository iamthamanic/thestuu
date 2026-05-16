# Refactor plan: Native-first DAW state

**Status:** planned · **Start:** 2026-05 · **Owner:** team  
**North star:** [architecture-state-authority.md](./architecture-state-authority.md)  
**Rules for agents:** [AGENTS.md](../AGENTS.md), `.cursor/rules/daw-state-authority.mdc`

Principles: **KISS** (one domain per sprint), **DRY** (one protocol, one snapshot path), **SOLID** (native = DAW, node = router, dashboard = UI).

---

## Summary

| Phase | Focus | Risk | Depends on |
|-------|--------|------|------------|
| 0 | Protocol, audit, CI guard | Low | — |
| 1 | Transport authoritative | Medium | 0 |
| 2 | Clips native-first | **High** | 0, native C++ |
| 3 | Tracks native-first | High | 2 |
| 4 | Mixer & plugins truth | Medium | 3 |
| 5 | Undo/redo & save/load | High | 2–4 |
| 6 | Dashboard reconcile & offline | Medium | 1–5 |

**Do not:** big-bang rewrite, new `syncNativeArrangementFromPlaylist` call sites, or new `projectHistory` for DAW.

---

## Phase 0 — Foundation (Sprint A, ~3–5 days)

**Goal:** Contract and guardrails; almost no behavior change.

### Tasks

| ID | Task | Layer | Files |
|----|------|-------|-------|
| 0.1 | Create `packages/protocol` (command + event name constants, JSDoc payload shapes) | protocol | `packages/protocol/` |
| 0.2 | Sync `docs/native-ipc.md` with `apps/native-engine/src/main.cpp` | docs | `docs/native-ipc.md` |
| 0.3 | Audit all DAW socket handlers → table A/B/C | docs | `docs/refactor-audit-server.md` (generated) |
| 0.4 | CI script: fail on **new** `syncNativeArrangementFromPlaylist` / `projectHistory.push` outside allowlist | ci | `scripts/check-daw-authority.sh` |
| 0.5 | PR template checkboxes (native command, no node DAW mutation) | process | `.github/pull_request_template.md` |

### Definition of done

- [ ] Protocol package exists and is imported by engine (names only, no behavior change yet)
- [ ] IPC doc matches native `main.cpp` command list
- [ ] Audit table lists every `clip:*`, `track:*`, `transport:*`, `project:*` handler with classification
- [ ] CI runs on PR (allowlist for legacy paths in `server.js`)

### Breakage risk

**Minimal** — documentation and CI only.

---

## Phase 1 — Transport (Sprint B, ~1 week)

**Goal:** Play/pause/seek/BPM reflect native only; no fake JS playhead on native failure.

### Tasks

| ID | Task | Layer | Notes |
|----|------|-------|-------|
| 1.1 | Single `applyTransportSnapshot(payload)` in engine | node | DRY entry point |
| 1.2 | `transport:play/pause/stop/seek/set-bpm` → forward only; cache from response/tick | node | Remove duplicate `state.playing` writes |
| 1.3 | Remove “start UI playhead anyway” on native error | node | Replace with `engine.offline` / error event |
| 1.4 | Dashboard: transport UI from snapshot; disable when native down | ui | Banner + disabled controls |
| 1.5 | Manual test matrix (see below) | qa | Record results in audit doc |

### Definition of done

- [ ] Transport acceptance criteria in [architecture-state-authority.md](./architecture-state-authority.md) met for transport domain
- [ ] No new code path sets `state.playing` without native tick/response (except explicit stub mode, documented)
- [ ] `STUU_NATIVE_TRANSPORT=0` behavior documented (demo vs unsupported)

### Test matrix (manual)

- [ ] Play → pause → play
- [ ] Seek while stopped and while playing
- [ ] BPM change before/during play
- [ ] Record-arm + play (no false record)
- [ ] Kill native process → UI shows offline, no ghost playhead

### Breakage risk

**Medium:** recording start, metronome sync, BPM pre/post native calls.

---

## Phase 2 — Clips (Sprints C–E, ~3–4 weeks)

**Goal:** Clip CRUD in Tracktion first; retire full-arrangement resync per edit.

### Native (blocking — do before or with node/ui)

| ID | Command | Replaces |
|----|---------|----------|
| 2.N1 | `clip.move` (incl. `to_track_id`) | JSON splice + sync |
| 2.N2 | `clip.resize` (+ trim if needed) | JSON resize + sync |
| 2.N3 | `clip.delete` | JSON delete + sync |
| 2.N4 | `clip.import` (alias existing `clip:import-file`) | dual write |
| 2.N5 | `clip.set-fade`, `clip.set-gain` | JSON + sync |
| 2.N6 | Event `clip.changed` or `edit.snapshot` after each | — |

### Node

| ID | Task |
|----|------|
| 2.1 | Forwarders for 2.N1–2.N5; update read-only cache from response only |
| 2.2 | Shrink `syncNativeArrangementFromPlaylist` allowlist (one callsite per sprint) |
| 2.3 | Keep `mergeNativeClipsIntoPlaylist` only for **recording** until native emits live clip events |
| 2.4 | Deprecate `moveClip` / `resizeClip` JSON mutation (feature flag `STUU_NATIVE_CLIP_OPS=1`) |

### Dashboard

| ID | Task |
|----|------|
| 2.5 | On pointer-up after drag: reconcile `clipDrafts` → server snapshot |
| 2.6 | Copy/paste uses native import path only (already near this) |

### Sprint split (KISS)

- **C:** `clip.move` only (same track + cross track)
- **D:** `clip.resize`, `clip.delete`
- **E:** import, fade, gain; remove clear+reimport for those paths

### Definition of done

- [ ] Move/resize/delete/import do not call `edit:clear-audio-clips` for normal edits
- [ ] Playback matches clip positions after each operation
- [ ] `nativeClipSyncSummary` failures visible in UI when sync still needed

### Breakage risk

**High:** cross-track move, split, waveform display, copy/paste, silence-after-sync bugs.

---

## Phase 3 — Tracks (Sprint F, ~1–2 weeks)

**Goal:** Track list and IDs owned by native edit.

| ID | Task |
|----|------|
| 3.N1 | Native: `track.create`, `track.delete`, `track.rename`, `track.reorder` |
| 3.1 | Node forward only; playlist rows = projection of native snapshot |
| 3.2 | Remove `reindexTracks` / JSON-only reorder as source of truth |
| 3.3 | Fix track_id mapping tests (master = 0, audio tracks 1..n) |

### Definition of done

- [ ] Create/delete/reorder track survives save/reload via native project
- [ ] Mixer rows stay aligned with track ids from snapshot

### Breakage risk

**High:** plugin slots per track, mixer strip count, import target track.

---

## Phase 4 — Mixer & plugins (Sprint G, ~1 week)

**Goal:** Mute/solo/vol/pan/arm and VST state confirmed by native.

| ID | Task |
|----|------|
| 4.1 | Mixer UI changes → native command only; cache from `mixer.changed` / snapshot |
| 4.2 | Stop writing `state.project.mixer` before native ack |
| 4.3 | VST load/unload/param: snapshot includes plugin list per track |

### Definition of done

- [ ] Solo/mute during playback matches audio
- [ ] No post-sync “force volume 0.85” workarounds for normal operation

### Breakage risk

**Medium:** solo logic, master bus (track_id 0), VST editor open.

---

## Phase 5 — Undo/redo & save/load (Sprints H–I, ~2–3 weeks)

**Goal:** Tracktion undo stack and project file are authoritative.

| ID | Task |
|----|------|
| 5.1 | Native `edit.undo` / `edit.redo` + snapshot |
| 5.2 | Remove `projectHistory` for DAW domains (keep allowlist period) |
| 5.3 | Native `edit.save` / `edit.open` (or Tracktion project path) |
| 5.4 | Node sidecar: title, cloud id, tags, AI notes only |
| 5.5 | Migration: load old shared-json projects → one-time import native |

### Definition of done

- [ ] Undo after clip move restores audio + UI
- [ ] Save/reload round-trip without JSON reconstruction

### Breakage risk

**High:** existing user projects on disk, undo history limit in UI.

---

## Phase 6 — Dashboard reconcile & offline (Sprint J, ~1 week)

**Goal:** One mental model for UI state.

| ID | Task |
|----|------|
| 6.1 | `useAuthoritativeProject()` or equivalent: merge engine:state + optimistic drafts |
| 6.2 | Engine offline: disable DAW toolbar, show status from `engine.offline` |
| 6.3 | Delete `syncNativeArrangementFromPlaylist` and `edit:clear-audio-clips` from hot path |
| 6.4 | Optional: extract `engine/native-client.js`, `engine/state-cache.js` (after behavior stable) |

### Definition of done

- [ ] Full acceptance checklist in architecture doc green
- [ ] No C-class handlers left in audit table (or explicit permanent exceptions documented)

### Breakage risk

**Low–medium** if phases 1–5 done; **high** if skipped earlier phases.

---

## Out of scope (this refactor)

- Song structure lane → native (stay Node metadata until product asks)
- Full pattern/MIDI sequencer → native (separate track; keep `pattern:*` in Node for now)
- Desktop single-binary packaging
- Replacing `shared-json` (still used for schema/sidecar)

---

## Handler audit template (Phase 0.3)

Fill one row per socket handler in `apps/engine/src/server.js`:

| Event | Class | Mutates `state.project`? | Calls native? | Migration phase |
|-------|-------|--------------------------|---------------|-----------------|
| `transport:play` | C→B | yes (today) | yes | 1 |
| `clip:move` | C | yes | via sync | 2 |
| `song-structure:*` | A | metadata | no | — |
| … | | | | |

**Classes:** A = app metadata, B = read-only cache, C = illegal (must migrate).

---

## Rollback strategy

- Feature flags per domain: `STUU_NATIVE_CLIP_OPS`, keep JSON path behind flag until stable
- Allowlist in CI: legacy files can call sync until phase removes last callsite
- Git: one phase per PR series; revert single PR if regression

---

## Success metrics

| Metric | Before | After |
|--------|--------|-------|
| `syncNativeArrangementFromPlaylist` callsites | ~many | 0 |
| Clip edit → full native clear+reimport | yes | no |
| Transport without native | fake playhead | offline UI |
| Source of truth | Node JSON | Native snapshot |

---

## Links

- [architecture-state-authority.md](./architecture-state-authority.md)
- [native-ipc.md](./native-ipc.md)
- [tracktion-setup.md](./tracktion-setup.md)
- Engine entry: `apps/engine/src/server.js`
- Native dispatch: `apps/native-engine/src/main.cpp`
