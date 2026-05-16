# Native IPC

IPC between the Node orchestrator (`apps/engine`) and the native Tracktion engine (`apps/native-engine`).

**Related:** [architecture-state-authority.md](./architecture-state-authority.md) · [refactor-plan-daw-authority.md](./refactor-plan-daw-authority.md) · shared constants: `packages/protocol`

**Authoritative command list:** `apps/native-engine/src/main.cpp` (`handleRequest`). Keep this doc in sync when adding commands.

## Transport

| Setting | Value |
|--------|--------|
| Channel | Unix domain socket |
| Path | `STUU_NATIVE_SOCKET` (fallback `/tmp/thestuu-native.sock`) |
| Framing | `uint32_be` length + MessagePack body |

## Message types

**Request**

```json
{ "type": "request", "id": <number>, "cmd": "<string>", "payload": <object> }
```

**Response**

```json
{ "type": "response", "id": <number>, "ok": <bool>, "payload"?: <object>, "error"?: <string> }
```

**Event** (native → engine, unsolicited)

```json
{ "type": "event", "event": "<string>", "payload": <object> }
```

## Commands implemented today

Status: **native-first** = applies change in Tracktion first; **legacy bridge** = used by Node JSON sync path; **system** = devices/health.

### Transport

| Command | Aliases | Status | Request | Response `payload` |
|---------|---------|--------|---------|-------------------|
| `transport.get_state` | — | native-first | `{}` | `{ transport: TransportSnapshot }` |
| `transport.ensure-context` | `transport:ensure-context` | native-first | `{}` | `{}` |
| `transport.play` | — | native-first | `{}` | `{ transport: TransportSnapshot }` |
| `transport.record` | — | native-first | `{}` | `{ transport: TransportSnapshot }` |
| `transport.pause` | — | native-first | `{}` | `{ transport: TransportSnapshot }` |
| `transport.stop` | — | native-first | `{}` | `{ transport: TransportSnapshot }` |
| `transport.set_bpm` | — | native-first | `{ bpm: number }` | `{ transport: TransportSnapshot }` |
| `transport.seek` | — | native-first | `position_beats` / `positionBeats` / `position_bars` / `positionBars` | `{ transport: TransportSnapshot }` |
| `transport.get_meters` | — | native-first | `{ track_count \| trackCount: int }` | `{ meters: [{ track_id, peak, rms }, ...] }` |

### Edit / clips

| Command | Status | Request | Response |
|---------|--------|---------|----------|
| `edit:reset` | legacy bridge | `{ track_count?: int }` (default 16) | `{ trackCount }` |
| `edit:clear-audio-clips` | **legacy bridge** — full clear before JSON re-import | `{}` | `{}` |
| `edit:get-audio-clips` | read-only | `{}` | `{ clips: [{ track_id, source_path, start_seconds, length_seconds, name }] }` |
| `clip:import-file` | native-first (per clip) | see [Clip import](#clip-import) | `{ trackId, startBars, lengthBars, sourcePath }` |
| `clip.move` | `clip:move` | native-first | `{ track_id, source_path, start, old_start?, to_track_id? }` | `{ trackId, startBars }` |
| `clip.resize` | `clip:resize` | native-first | `{ track_id, source_path, length, start?, old_start? }` | `{ trackId, startBars, lengthBars }` |
| `clip.delete` | `clip:delete` | native-first | `{ track_id, source_path, old_start? }` | `{ trackId, deleted: true }` |
| `edit.undo` | `edit:undo` | native-first | `{}` | `{ ok: true }` |
| `edit.redo` | `edit:redo` | native-first | `{}` | `{ ok: true }` |

Enable Node path: `STUU_NATIVE_CLIP_OPS=1`, `STUU_NATIVE_EDIT_UNDO=1` (see README).

### Tracks / mixer

| Command | Status | Request | Response |
|---------|--------|---------|----------|
| `track:set-mute` | native-first | `{ track_id, mute }` | `{ trackId, mute }` |
| `track:set-solo` | native-first | `{ track_id, solo }` | `{ trackId, solo }` |
| `track:set-volume` | native-first | `{ track_id, volume }` (0..1+) | `{ trackId, volume }` |
| `track:set-pan` | native-first | `{ track_id, pan }` (-1..1) | `{ trackId, pan }` |
| `track:set-record-arm` | native-first | `{ track_id, record_armed \| recordArmed }` | `{ trackId, record_armed }` |

Master bus uses `track_id: 0` where supported.

### VST / plugins

| Command | Status | Request | Response |
|---------|--------|---------|----------|
| `vst:scan` | read-only catalog | `{}` | `{ plugins: PluginInfo[] }` |
| `vst:load` | native-first | `{ plugin_uid, track_id }` | `{ plugin: LoadPluginResult }` |
| `vst:editor:open` | native-first | `{ track_id, plugin_index }` | `{ trackId, pluginIndex, opened }` |
| `vst:preview:get` | utility | `{ plugin_uid, output_path, width?, height? }` | `{ uid, path, width, height, generated }` |
| `vst:param:set` | native-first | `{ track_id, plugin_index, param_id, value }` | `{ trackId, pluginIndex, parameter }` |

### Audio devices

| Command | Status | Request | Response |
|---------|--------|---------|----------|
| `audio.get_outputs` | system | `{}` | `{ devices[], currentId, sampleRate?, blockSize?, ... }` |
| `audio.set_output` | system | `{ device_id \| deviceId }` | `{ ok: true }` |
| `audio.get_inputs` | system | `{}` | `{ devices[], currentId }` |
| `audio.set_input` | system | `{ device_id \| deviceId }` | `{ ok: true }` |

### Analyzer

| Command | Aliases | Status | Request | Response |
|---------|---------|--------|---------|----------|
| `analyzer:set-target` | `analyzer.set_target` | native-first | `{ mode: "master" \| "track", track_id?, plugin_index? }` | `{ ok, mode, trackId, pluginIndex }` |

### System

| Command | Status | Response |
|---------|--------|----------|
| `backend.info` | system | `{ tracktion: bool }` |
| `health.ping` | system | `{ pong: true }` |

## Events (native → engine)

| Event | Status | Payload |
|-------|--------|---------|
| `transport.tick` | **implemented** (~40 ms) | Transport snapshot fields (see below) |

### Target events (refactor plan; not all emitted yet)

`engine.ready`, `engine.offline`, `transport.changed`, `edit.snapshot`, `edit.saved`, `edit.loaded`, `track.changed`, `clip.changed`, `mixer.changed`, `plugin.changed`, `command.failed`

Engine mirrors transport to the dashboard on `engine:transport` and native ticks on `transport.tick`.

## Payload: Transport snapshot

Used in `transport.*` responses and `transport.tick` events.

| Field | Type | Notes |
|-------|------|--------|
| `playing` | bool | |
| `bpm` | number | |
| `bar` | int | 1-based |
| `beat` | int | 1-based |
| `step` | int | 1-based |
| `stepIndex` | int | 0-based |
| `positionBars` | number | |
| `positionBeats` | number | |
| `timestamp` | number | epoch ms |

## Clip import

`clip:import-file` request (snake_case or camelCase accepted):

| Field | Type | Notes |
|-------|------|--------|
| `track_id` / `trackId` | int | default 1 |
| `source_path` / `sourcePath` | string | required |
| `start` | number | bars |
| `length` | number | bars |
| `start_seconds` / `startSeconds` | number | optional |
| `length_seconds` / `lengthSeconds` | number | optional |
| `fade_in`, `fade_out`, curves | number / string | optional |
| `type` | `"audio"` \| `"midi"` | optional |
| `source_offset_seconds` | number | trim offset |

Response: `{ trackId, startBars, lengthBars, sourcePath }`.

## Target commands (not in main.cpp yet)

Planned native-first replacements for Node JSON mutations — see [refactor-plan-daw-authority.md](./refactor-plan-daw-authority.md):

`clip.move`, `clip.resize`, `clip.delete`, `clip.setFade`, `clip.setGain`, `track.create`, `track.delete`, `track.rename`, `track.reorder`, `edit.undo`, `edit.redo`, `edit.save`, `edit.open`, …

Constants: `packages/protocol` (`NATIVE_COMMANDS_TARGET`).

## Socket ↔ native mapping (engine)

Dashboard uses Socket.IO events (`transport:play`, `clip:move`, …). Engine adapts to native `cmd` strings above. Canonical socket names: `packages/protocol` (`SOCKET_COMMANDS`).

**Legacy:** clip move/resize/delete still mutate `state.project` then call `edit:clear-audio-clips` + re-import via `syncNativeArrangementFromPlaylist` — do not extend.

## Default edit (Tracktion)

- Empty Tracktion `Edit` at backend start.
- Default template: 16 audio tracks (“TheStuu Default Template”).
- Built-in synth: `plugin_uid: "internal:ultrasound"`.

## Backend modes

- `tracktion` (default when vendor deps present)
- `stub` (no JUCE/Tracktion)

CLI: `--native-backend`, `--native-vendor-dir`, `--native-socket` — see `docs/tracktion-setup.md`.
