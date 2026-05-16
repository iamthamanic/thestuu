## Summary

<!-- What does this PR change and why? -->

## DAW state authority (required for DAW / engine / native changes)

- [ ] Native IPC command defined or extended (`packages/protocol` + `apps/native-engine`; `docs/native-ipc.md` updated)
- [ ] Node does **not** mutate `state.project` playlist/clips/mixer for **new** DAW logic (forward + read-only cache only)
- [ ] `docs/native-ipc.md` updated if native `main.cpp` commands changed
- [ ] `docs/refactor-audit-server.md` updated if new DAW-relevant socket handlers were added
- [ ] `npm run check:daw-authority` passes (no new `syncNativeArrangementFromPlaylist` / `projectHistory.*.push` outside allowlist)

## Test plan

- [ ] Manual / automated checks performed
