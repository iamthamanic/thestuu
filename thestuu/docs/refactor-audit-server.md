# Engine socket handler audit (DAW)

Generated in **Phase 0** from `apps/engine/src/server.js`. Re-audit when adding handlers.

**Classes:** **A** = app/UI metadata (stay in Node) · **B** = read-only cache / forward-only · **C** = illegal DAW mutation (migrate to native-first)

**Plans:** [refactor-plan-daw-authority.md](./refactor-plan-daw-authority.md) · [architecture-state-authority.md](./architecture-state-authority.md)

Legacy snake_case aliases (`move_clip`, `create_pattern`, …) bind to the same functions as the colon events below — not listed separately.

| Event | Class | Mutates `state.project`? | Calls native? | Migration phase | Notes |
|-------|-------|--------------------------|---------------|-----------------|-------|
| `transport:play` | C | yes (`bpm`, `playing`) | yes (`transport.play` / `transport.record`) | 1 | Fake JS playhead on native error |
| `transport:pause` | C | yes (`playing`, `recording`) | yes (`transport.pause`) | 1 | Merges recorded clips into playlist |
| `transport:stop` | C | yes | yes (`transport.stop`) | 1 | Resets clock; merge native clips |
| `transport:set-bpm` | C | yes (`project.bpm`) | yes (`transport.set_bpm`) | 1 | |
| `transport:seek` | C | yes (transport clock) | yes when native active | 1 | |
| `track:set-volume` | C | yes (`mixer` / `master_mix`) | yes (await native first) | 4 | Done |
| `track:set-pan` | C | yes | yes (await native first) | 4 | Done |
| `track:set-mute` | C | yes | yes (await native first) | 4 | Master bus JSON-only |
| `track:set-solo` | C | yes | yes (await native first) | 4 | Done |
| `track:set-record-arm` | C | yes | yes (await native first) | 4 | Done |
| `track:create` | C | yes | yes (`track.create` when `STUU_NATIVE_TRACK_OPS=1`) | 3 | Legacy: `safeRestoreNativeNodesAfterTrackLayoutChange` |
| `track:insert` | C | yes | yes (`track.sync-layout` when flag) | 3 | |
| `track:reorder` | C | yes | yes (`track.reorder` when flag) | 3 | |
| `track:delete` | C | yes | yes (`track.delete` when flag) | 3 | |
| `track:bulk-delete` | C | yes | yes (layout sync when flag) | 3 | |
| `track:duplicate` | C | yes | yes (layout sync when flag) | 3 | Clones clips + nodes |
| `track:set-name` | A | yes (track name) | no | — | Persists `.stu` file |
| `track:set-chain-collapsed` | A | yes (UI flag) | no | — | |
| `track:set-chain-enabled` | C | yes (track + VST bypass) | no | 4 | Should follow native plugin chain |
| `clip:create` | C | yes (pattern clip on track) | no | 2 / pattern | Pattern sequencer; Node-owned |
| `clip:import-file` | C | yes | yes (`clip:import-file` + reconcile) | 2 | Legacy full sync when flag off |
| `track:import-file` | C | yes | yes (same as `clip:import-file`) | 2 | Alias handler |
| `clip:move` | C | yes | `clip.move` when `STUU_NATIVE_CLIP_OPS=1` | 2 | Else `reconcileNativeClipState` → legacy sync |
| `clip:resize` | C | yes | `clip.resize` when flag | 2 | |
| `clip:set-fade` | C | yes | reconcile path | 2 | |
| `clip:set-gain` | C | yes | no | 2 | Comment: native clip gain not wired |
| `clip:set-properties` | A | yes (name/color) | no | — | Display metadata |
| `clip:analyze-bpm-key` | A | yes (`clip.bpm` / `key` hints) | no | — | Analysis metadata, not arrangement |
| `clip:delete` | C | yes | via full sync | 2 | |
| `pattern:create` | A | yes (`patterns`) | no | — | Out of native scope (plan) |
| `pattern:update-step` | A | yes | no | — | |
| `pattern:update` | A | yes | no | — | |
| `pattern:delete` | A | yes | no | — | |
| `pattern:move-midi-note` | A | yes | no | — | |
| `project:update-view` | A | yes (view prefs, metronome flags) | no | — | Not timeline audio graph |
| `project:load` | C | yes (full project) | yes (`project.import` when `STUU_NATIVE_PROJECT_SIDECAR=1`) | 5 | |
| `project:apply` | C | yes | yes | 5 | |
| `project:undo` | C | yes | `edit.undo` when `STUU_NATIVE_EDIT_UNDO=1` | 5 | Else JSON `projectHistory` |
| `project:redo` | C | yes | `edit.redo` when flag | 5 | |
| `project:save` | C | yes | `project.export` merge when sidecar flag | 5 | Patterns/view in JSON sidecar |
| `song-structure:set-nodes` | A | yes (`song_structure`; may move clips) | via sync if link+geometry | — | App metadata lane; ripple uses legacy sync |
| `song-structure:set-playlist-link` | A | yes | no | — | |
| `song-structure:update-node` | A | yes | no | — | |
| `song-structure:clear` | A | yes | no | — | |
| `song-structure:set-template-meta` | A | yes | no | — | |
| `vst:scan` | B | no (catalog cache) | yes (`vst:scan`) | 4 | |
| `vst:add` | C | yes (`nodes`) | yes (`vst:load`) + layout restore | 4 | Dual JSON + native |
| `vst:editor:open` | B | no | yes | 4 | |
| `vst:remove` | C | yes | layout restore | 4 | |
| `vst:reorder` | C | yes | layout restore | 4 | |
| `vst:bypass:set` | C | yes | no | 4 | JSON bypass only |
| `vst:param:set` | C | yes (`nodes.params`) | yes (`vst:param:set`) | 4 | Updates cache after native |
| `analyzer:set-target` | B | no | yes (`analyzer:set-target`) | — | |

## Summary

| Class | Count |
|-------|------:|
| A | 15 |
| B | 3 |
| C | 35 |
| **Total** | **53** |

## Non-DAW handlers (excluded)

`structure-template:*`, `app-preferences:update`, `audio:get-outputs`, `audio:set-output`, `audio:get-inputs`, `audio:set-input` — device/templates/preferences, not arrangement authority.

## Internal legacy (not socket events)

| Symbol | Class | Notes |
|--------|-------|-------|
| `syncNativeArrangementFromPlaylist` | C | 7 call sites in `server.js`; CI allowlisted |
| `projectHistory.undo.push` / `redo.push` | C | JSON DAW undo; CI allowlisted |
