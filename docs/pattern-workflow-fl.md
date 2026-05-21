# FL-style pattern workflow (TheStuu)

Reference for patterns, playlist pattern clips, and the Pattern Editor dock. Aligns with `docs/daw-authority-guardrails.md`: **patterns are JSON sidecar** in Node; audio arrangement stays native.

## FL mapping

| FL Studio | TheStuu (current) |
|-----------|-------------------|
| Channel Rack (step grid) | **Removed** — drum sequencer deferred to a separate module |
| Pattern | `project.patterns[]` — **midi** (`notes[]`) is the default for new patterns |
| Playlist pattern clip | Track clip with `pattern_id` |
| Pattern Editor (bottom) | `PatternEditorPanel` — docked under playlist in Edit |
| Sound per channel | One **track** sound: sample via `track_sound` sidecar or VST instrument on that track |
| Piano Roll | Stub button in Pattern Editor (full editor later) |

## Data model

```json
{
  "id": "pattern_…",
  "type": "midi",
  "name": "Pattern 1",
  "color": "#c4b5fd",
  "length": 16,
  "swing": 0,
  "notes": [{ "pitch": 60, "start": 0, "length": 0.25, "velocity": 0.9 }]
}
```

Track sample sidecar (JSON only):

```json
{
  "track_id": 1,
  "track_sound": {
    "kind": "sample",
    "source_path": "/path/to/file.wav",
    "label": "kick.wav"
  }
}
```

- **16 steps = 1 bar** when converting imported MIDI step grid (see `midi-import.js`).
- Pattern clips: `{ "id", "start", "length", "pattern_id" }` — no `type` field on the clip.

### Time mapping (FL-style, single source)

| Layer | Coordinates | Example |
|-------|-------------|---------|
| Pattern `notes[].start` | Pattern-local bars `0 … pattern.length` | Note at bar 5 in Pattern 6 |
| Playlist clip `start` | Global song bars | Clip placed at bar 7 |
| Playback / highlight | `patternBarAtPlayhead(playlist, clip.start, loop)` | Song bar 12 → pattern bar 5 when clip @ 7 and loop ≥ 6 |

Implementation: `packages/shared-json/src/pattern-timeline-map.js` (re-exported from `@thestuu/shared-json`). Mini clip ruler shows **playlist** bar numbers; piano roll editor shows **pattern** 1…N. Not 1:1 labels — same BPM/grid sync.

## Socket commands

| Command | Purpose |
|---------|---------|
| `pattern:create` | New pattern (`name`, `color`, `type`, `notes`) |
| `pattern:update` | Meta: `length`, `swing`, `name`, `color` |
| `pattern:set-notes` | Replace `notes[]` (e.g. Import MIDI from clip tools) |
| `pattern:delete` | Remove pattern |
| `track:set-sound` | Set/clear `track_sound` on a playlist track |
| `clip:create` | Place pattern on track |
| `clip:delete` / `clip:move` / `clip:resize` | Sidecar pattern clips (no native IPC) |

## UI entry points

1. **Edit → Track + → Pattern** — creates a **midi** pattern + clip, opens Pattern Editor dock
2. **Grid icon** (top bar) — toggle Pattern Editor dock
3. **Click pattern clip** — select pattern, open dock, show inspector
4. **Pattern clip → Clip Tools (corner)** — Rename, **Import MIDI** (`.mid` / `.midi`)
5. **Pattern Editor → add Sound** — modal: local file or generative VST; drag-drop audio onto **add Sound**
6. **Inspector** — pattern name/color + note count hint

Import MIDI is **not** in the Add Sound modal.

## Phase status

### Done (this refactor)

- Channel Rack + drum step UI removed from Edit
- Pattern Editor dock (`pattern-editor-panel.jsx`)
- Sound chooser modal + `track:set-sound` / VST instrument load
- Import MIDI via clip quick tools + `pattern:set-notes`
- Mini note preview in playlist clips (`pattern-clip-preview.jsx`)
- **Preview playback** — `packages/shared-json/src/pattern-playback.js` + `use-pattern-playback` (browser synth, synced to transport)
- Piano roll playhead follows transport when clip is playing

### Next

- **Native playback** — `pattern.sync` IPC → Tracktion MIDI clips (replaces browser preview synth)
- **Piano Roll** — full FL tool set (ghost notes, velocity lane)
- **Drum sequencer** — separate module (not Channel Rack)
- Ghost patterns, duplicate, make unique
- Native or UltraSlim scheduler (see `docs/ultraslim-engine-spec.md`)

## Files

| File | Role |
|------|------|
| `apps/dashboard/components/pattern-editor-panel.jsx` | Docked pattern row UI |
| `apps/dashboard/components/pattern-sound-chooser-modal.jsx` | Sample / VST picker |
| `apps/dashboard/components/pattern-clip-preview.jsx` | Playlist clip preview |
| `apps/dashboard/lib/clip-quick-tools.js` | Clip corner menu (Import MIDI on patterns) |
| `apps/dashboard/lib/midi-import.js` | `.mid` → bar-unit notes |
| `apps/dashboard/components/stuu-shell.jsx` | Integration, dock, handlers |
| `apps/engine/src/server.js` | Pattern + track sound mutations |
| `packages/shared-json/src/index.js` | `normalizePattern`, `track_sound` |
