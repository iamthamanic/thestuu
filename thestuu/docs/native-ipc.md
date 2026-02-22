# Native IPC v1

## Ziel

IPC zwischen Node-Orchestrator (`apps/engine`) und nativer C++ Engine (`apps/native-engine`) fuer Transport und VST-Hosting.

## Transport

- Kanal: Unix Domain Socket
- Socket-Pfad: `STUU_NATIVE_SOCKET` (Fallback `/tmp/thestuu-native.sock`)
- Framing: `uint32_be length` + MessagePack payload

## Nachrichtentypen

- Request:
  - `{ type: "request", id: <number>, cmd: <string>, payload: <object> }`
- Response:
  - `{ type: "response", id: <number>, ok: <bool>, payload?: <object>, error?: <string> }`
- Event:
  - `{ type: "event", event: <string>, payload: <object> }`

## Implementierte Commands (v1)

- `transport.get_state`
- `transport.play`
- `transport.stop`
- `transport.set_bpm`
- `edit:reset`
- `health.ping`
- `vst:scan`
- `vst:load`
- `vst:param:set`
- `clip:import-file`

## Events (v1)

- `transport.tick` (ca. alle 40ms)

## Payload: Transport Snapshot

- `playing` (bool)
- `bpm` (number)
- `bar` (int, 1-basiert)
- `beat` (int, 1-basiert)
- `step` (int, 1-basiert)
- `stepIndex` (int, 0-basiert)
- `positionBars` (number)
- `positionBeats` (number)
- `timestamp` (epoch ms)

## Payload: VST Commands

- `vst:scan`:
  - Request payload: `{}` (optional)
  - Response payload: `{ plugins: Array<{ name, uid, type, parameters: Array<{ id, name, min, max, value }> }> }`
- `vst:load`:
  - Request payload: `{ plugin_uid: <string>, track_id: <int> }`
  - Response payload: `{ plugin: { name, uid, type, trackId, pluginIndex, parameters: [...] } }`
- `vst:param:set`:
  - Request payload: `{ track_id: <int>, plugin_index: <int>, param_id: <string>, value: <0..1> }`
  - Response payload: `{ trackId, pluginIndex, parameter: { id, name, min, max, value } }`
- `clip:import-file`:
  - Request payload: `{ source_path: <string>, track_id: <int>, start?: <number>, length?: <number>, type?: "audio" | "midi" }`
  - Response payload: `{ trackId, startBars, lengthBars, sourcePath }`

## Default Edit (Tracktion Backend)

- Beim Backend-Start wird ein leeres Tracktion-`Edit` erzeugt.
- Es werden standardmaessig `16` Audio-Tracks als "TheStuu Default Template" vorbereitet.
- Interner Synth `ultrasound` ist als Tracktion Built-in Plugin verfuegbar (`plugin_uid: "internal:ultrasound"`).

## Erweiterungspfad Richtung Tracktion/JUCE

1. `apps/native-engine` auf JUCE/Tracktion Engine Core umstellen.
2. Weitere IPC-Commands fuer Playback, Routing, Plugin-Hosting, Parameterautomation.
3. Shared-Memory Stream fuer Meter/Analyzer/Waveform-Daten ergaenzen.

## Phase-1 Stand (2026-02-20)

- CMake-Integration ist vorhanden (`apps/native-engine/CMakeLists.txt`).
- Native Backend ist umschaltbar:
  - `tracktion` (Default; wenn Vendor-Dependencies vorhanden)
  - `stub` (optional, ohne JUCE/Tracktion)
- CLI-Start-Flags:
  - `--native-backend stub|tracktion`
  - `--native-vendor-dir <path>`
  - `--native-socket <path>`
