# UltraSlim Engine — Full-Fidelity Drop-in Backend Specification

> **Scope:** Architecture document only. No code changes in TheStuu.
>
> **Goal:** Replace `tracktion_engine` with a self-written DAW core while retaining **JUCE** as the audio I/O, plugin hosting, and device abstraction layer. Full feature parity with Tracktion. REAPER-grade efficiency target.
>
> **Not a lightweight engine.** Not a mobile compromise. This is a professional DAW engine that happens to be more efficient than Tracktion.

---

## 1. Concept: What Actually Changes

### TheStuu Today

```
┌─────────────┐     Socket.IO      ┌─────────────┐    Unix Socket     ┌─────────────────────────────────────┐
│  Dashboard  │ ─────────────────→ │ Node Engine │ ────────────────→ │ thestuu-native (Tracktion + JUCE)   │
│  (Next.js)  │                    │  (Router)   │                   │  • Edit graph                       │
└─────────────┘                    └─────────────┘                   │  • Transport + Clock                │
                                                                   │  • Mixer + Plugins + VST hosting    │
                                                                   │  • Audio I/O (via JUCE)             │
                                                                   └─────────────────────────────────────┘
```

**Binary:** ~22–73 MB. Tracktion owns the edit graph. JUCE owns audio devices and plugin hosting.

### UltraSlim Target (Phase 1)

```
┌─────────────┐     Socket.IO      ┌─────────────┐    Unix Socket     ┌─────────────────────────────────────┐
│  Dashboard  │ ─────────────────→ │ Node Engine │ ────────────────→ │ thestuu-native (UltraSlim + JUCE)   │
│  (Next.js)  │                    │  (Router)   │                   │  • UltraSlim: Edit graph            │
└─────────────┘                    └─────────────┘                   │  • UltraSlim: Transport + Clock     │
                                                                   │  • UltraSlim: Mixer + Routing       │
                                                                   │  • UltraSlim: Undo/Redo             │
                                                                   │  • JUCE: Audio devices              │
                                                                   │  • JUCE: MIDI I/O                   │
                                                                   │  • JUCE: VST3/AU plugin hosting     │
                                                                   │  • JUCE: Audio format decoding      │
                                                                   └─────────────────────────────────────┘
```

**Binary target:** ~15–25 MB. **Tracktion is gone.** UltraSlim owns the DAW logic. JUCE stays as the hardware/plugin abstraction layer.

### Phase 2 (Optional — Long Term)

Replace JUCE's audio I/O and plugin hosting with custom implementations (REAPER model). Binary target: **<15 MB**. No external framework dependencies.

---

## 2. Why Not Rust?

Rust is memory-safe and has excellent cross-compilation. For a **new** audio project from scratch, Rust is compelling.

However, for **this** project:

| Factor                   | Rust                                                                                                     | C++ (JUCE layer)                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **VST3 SDK**             | C++ API. FFI via `cxx` or manual C wrappers. Adds weeks of binding work.                                 | Native. Direct `#include <vst3sdk/...>`.                |
| **JUCE audio I/O**       | Must write or find Rust equivalents for CoreAudio/ALSA/ASIO/AAudio. `cpal` exists but is not JUCE-grade. | Kept as-is. Zero work.                                  |
| **Plugin UI embedding**  | No Rust crate hosts VST3 editor windows.                                                                 | JUCE `AudioPluginInstance::createEditor()` works today. |
| **Time-to-first-sound**  | 6–12 months                                                                                              | 2–4 months                                              |
| **Team size assumption** | 1–2 developers                                                                                           | 1–2 developers                                          |
| **Migration path**       | Hard — would rewrite `main.cpp` IPC in Rust                                                              | Trivial — swaps `tracktion_backend_*.cpp`               |

**Decision:** UltraSlim is written in **C++**, compiles into the existing `thestuu-native` binary, and links against JUCE (for now). The IPC boundary (`tracktion_backend.hpp` → `main.cpp`) requires **zero changes**.

Rust can be revisited for Phase 2 if the team grows.

---

## 3. Feature Parity Checklist

UltraSlim must implement everything Tracktion currently provides to TheStuu. No exceptions.

### 3.1 Transport

| Feature                        | Tracktion | UltraSlim Must       |
| ------------------------------ | --------- | -------------------- |
| Play / Pause / Stop            | ✓         | ✓                    |
| Seek (bars/beats/seconds)      | ✓         | ✓                    |
| BPM change (smooth, no glitch) | ✓         | ✓                    |
| Loop playback                  | ✓         | ✓                    |
| Record (audio + MIDI)          | ✓         | ✓                    |
| Punch-in / Punch-out           | ✓         | ✓                    |
| Metronome                      | ✓         | ✓ (if exposed in UI) |
| Transport tick event (~40 ms)  | ✓         | ✓                    |

### 3.2 Edit Graph / Timeline

| Feature                                  | Tracktion      | UltraSlim Must                         |
| ---------------------------------------- | -------------- | -------------------------------------- |
| Audio clips (non-destructive references) | ✓              | ✓                                      |
| MIDI clips (pattern data, not audio)     | ✓              | ✓                                      |
| Clip move, resize, split, merge          | ✓              | ✓                                      |
| Clip gain, fade in/out, crossfade        | ✓              | ✓                                      |
| Clip time-stretch / pitch-shift          | ✓ (RubberBand) | ✓ (integrate RubberBand or SoundTouch) |
| Clip trim (source offset)                | ✓              | ✓                                      |
| Multiple takes / comping                 | ✓              | Phase 2                                |
| Track freeze / bounce                    | ✓              | Phase 2                                |

### 3.3 Tracks & Mixer

| Feature                                  | Tracktion | UltraSlim Must                                               |
| ---------------------------------------- | --------- | ------------------------------------------------------------ |
| Unlimited audio tracks                   | ✓         | ✓ (limited by CPU, not engine)                               |
| Unlimited MIDI tracks                    | ✓         | ✓                                                            |
| Volume, pan, mute, solo per track        | ✓         | ✓                                                            |
| Record arm per track                     | ✓         | ✓                                                            |
| Mono / Stereo track config               | ✓         | ✓                                                            |
| Plugin chain per track (VST3/AU)         | ✓         | **JUCE hosts plugins**; UltraSlim routes audio through chain |
| Plugin chain on master bus               | ✓         | ✓                                                            |
| Sends / Returns (aux busses)             | ✓         | Phase 1.5                                                    |
| Sidechain routing                        | ✓         | Phase 2                                                      |
| Latency compensation across plugin graph | ✓         | ✓ (JUCE provides per-plugin latency; UltraSlim sums)         |

### 3.4 Plugins / VST

| Feature                                | Tracktion | UltraSlim Must                     |
| -------------------------------------- | --------- | ---------------------------------- |
| VST3 plugin hosting                    | ✓         | **JUCE** (`juce_audio_processors`) |
| AU plugin hosting (macOS)              | ✓         | **JUCE**                           |
| Plugin parameter automation            | ✓         | ✓                                  |
| Plugin editor window open/close        | ✓         | **JUCE**                           |
| Plugin preset save/load                | ✓         | ✓                                  |
| Plugin bypass                          | ✓         | ✓                                  |
| Internal synth (`internal:ultrasound`) | ✓         | ✓ (own instrument)                 |

**Key insight:** UltraSlim does NOT reimplement VST hosting. JUCE does that. UltraSlim only manages **which plugins are on which tracks** and **routes audio buffers through them**.

### 3.5 MIDI

| Feature                                  | Tracktion | UltraSlim Must                  |
| ---------------------------------------- | --------- | ------------------------------- |
| MIDI input from devices                  | ✓         | **JUCE** (`juce_audio_devices`) |
| MIDI clip recording                      | ✓         | ✓                               |
| MIDI clip playback                       | ✓         | ✓                               |
| MIDI editing (piano roll)                | ✓         | UI-side; engine plays events    |
| Internal synth (sine/sampler/ultrasound) | ✓         | ✓                               |
| MIDI-to-audio rendering (freeze)         | ✓         | Phase 2                         |

### 3.6 Audio Decoding / Encoding

| Feature                | Tracktion | UltraSlim Must                  |
| ---------------------- | --------- | ------------------------------- |
| WAV import             | ✓         | **JUCE** (`juce_audio_formats`) |
| AIFF import            | ✓         | **JUCE**                        |
| FLAC import            | ✓         | **JUCE**                        |
| MP3 import             | ✓         | **JUCE**                        |
| OGG import             | ✓         | **JUCE**                        |
| Export (bounce) to WAV | ✓         | Phase 1.5                       |
| Export to MP3/FLAC     | ✓         | Phase 2                         |

### 3.7 Undo / Redo

| Feature                                 | Tracktion | UltraSlim Must  |
| --------------------------------------- | --------- | --------------- |
| Infinite undo levels (configurable)     | ✓         | ✓ (default 100) |
| Undo for clip move/resize/delete/import | ✓         | ✓               |
| Undo for track changes                  | ✓         | ✓               |
| Undo for mixer changes                  | ✓         | ✓               |
| Undo for plugin add/remove              | ✓         | ✓               |
| Undo for transport state                | Optional  | Optional        |
| Branching undo history                  | Optional  | No              |

### 3.8 Project Save / Load

| Feature                         | Tracktion             | UltraSlim Must                           |
| ------------------------------- | --------------------- | ---------------------------------------- |
| Save project (audio + metadata) | ✓ (Tracktion `.edit`) | UltraSlim **JSON format** + audio folder |
| Load project                    | ✓                     | ✓                                        |
| Backward-compatible load        | ✓                     | Import from TheStuu JSON sidecar         |
| Auto-save                       | Optional              | Phase 2                                  |

---

## 4. Architecture: What UltraSlim Implements vs What JUCE Keeps

### 4.1 UltraSlim Core (Self-Written)

```
ultraslim_core/
├── transport/
│   ├── clock.h/cpp              ← BPM→samples, playhead, loop boundaries
│   └── state.h/cpp              ← Atomic play/pause/seek/record flags
│
├── edit_model/
│   ├── project.h/cpp            ← Root object: owns tracks, transport, undo
│   ├── track.h/cpp              ← Track: id, name, type (audio/midi), chain
│   ├── audio_clip.h/cpp         ← AudioClip: bounds, source, gain, fades, stretch
│   ├── midi_clip.h/cpp          ← MidiClip: events (note on/off, CC), quantization
│   ├── plugin_slot.h/cpp        ← PluginInstance wrapper: uid, state, bypass
│   └── automation.h/cpp         ← Automation curves per parameter
│
├── mixer/
│   ├── graph.h/cpp              ← AudioProcessorGraph equivalent (simpler)
│   ├── track_bus.h/cpp          ← Per-track buffer processing
│   ├── master_bus.h/cpp         ← Master summing + master chain
│   └── latency_calculator.h/cpp ← Traverses graph, sums latency per path
│
├── undo/
│   ├── command.h                ← Abstract base: execute(), undo(), describe()
│   ├── commands/
│   │   ├── move_clip_cmd.cpp
│   │   ├── resize_clip_cmd.cpp
│   │   ├── delete_clip_cmd.cpp
│   │   ├── import_clip_cmd.cpp
│   │   ├── set_track_volume_cmd.cpp
│   │   ├── add_plugin_cmd.cpp
│   │   └── remove_plugin_cmd.cpp
│   └── history.h/cpp            ← Stack of unique_ptr<Command>
│
├── renderer/
│   ├── clip_scheduler.h/cpp     ← Which clips are active at sample position N
│   ├── midi_renderer.h/cpp       ← Converts MIDI events to audio (via JUCE Synth)
│   ├── time_stretch.h/cpp        ← RubberBand wrapper (or SoundTouch)
│   └── export_renderer.h/cpp     ← Offline bounce (Phase 1.5)
│
└── serialize/
    ├── project_serializer.h/cpp   ← JSON ↔ edit_model
    └── json_schema.h            ← Validation for project JSON
```

### 4.2 JUCE Layer (Retained from TheStuu)

```
juce_kept/
├── juce_audio_devices            ← CoreAudio, ALSA, ASIO, WASAPI, MIDI
│   └── AudioDeviceManager
├── juce_audio_processors         ← VST3/AU hosting, plugin editor
│   └── AudioPluginInstance, PluginDescription
├── juce_audio_formats            ← WAV, AIFF, FLAC, MP3, OGG decode
│   └── AudioFormatManager
└── juce_core / juce_events       ← String, File, Time, Thread, MessageManager
```

**Not used from JUCE:**

- `juce_gui_basics` / `juce_gui_extra` — no native editor UI (TheStuu has React dashboard)
- `tracktion_engine` — **replaced entirely by UltraSlim**

### 4.3 Interface Boundary

`tracktion_backend.hpp` is the existing contract. UltraSlim implements all functions declared there. `main.cpp` requires **zero changes**.

```cpp
// tracktion_backend.hpp (existing, unchanged)
bool initBackend(const std::string& userDataPath);
bool startAudio();
void stopAudio();
bool transportPlay();  // etc.
bool importClipFile(const ClipImportRequest& req, ClipImportResult& out, std::string& err);
// ... all existing functions
```

UltraSlim provides:

- `ultraslim_backend.cpp` — implements all functions from `tracktion_backend.hpp`
- Under the hood, calls UltraSlim core + JUCE for audio I/O and plugins

---

## 5. The Audio Callback (Critical Design)

This is where Tracktion and UltraSlim differ most. Tracktion's callback is deep and complex. UltraSlim's must be **leaner**.

### Design

```cpp
void audioCallback(const float** inputChannels, int numInputChannels,
                   float** outputChannels, int numOutputChannels,
                   int numFrames) {
    // 1. Read atomic transport state (no locks in callback!)
    auto transport = transportState.load(); // playhead, playing, recording

    // 2. For each track:
    //    a. Build MIDI buffer for this block (from MidiClips active at playhead)
    //    b. Process plugin chain: synth plugin (if MIDI track) → FX plugins
    //       JUCE handles: AudioPluginInstance::processBlock()
    //    c. For audio tracks: find active AudioClips, read source buffers
    //       Apply gain, fades, time-stretch
    //    d. Sum into track buffer
    //    e. Apply track volume + pan

    // 3. Solo/Mute matrix:
    //    If any track is solo'd, only solo tracks go to master
    //    Muted tracks are zeroed

    // 4. Sum all audible tracks into master bus
    //    Process master plugin chain (via JUCE)

    // 5. Write to outputChannels (interleaved or non-interleaved)

    // 6. If recording: write input channels to armed track buffers (for later flush)

    // 7. Advance playhead by numFrames
    advancePlayhead(numFrames);
}
```

### Memory Rules (Audio Thread)

| Rule                                | Enforcement                                          |
| ----------------------------------- | ---------------------------------------------------- |
| No heap allocation (`new`/`malloc`) | Static analysis + code review                        |
| No mutex locks                      | All data is lock-free (atomics or SPSC ring buffers) |
| No file I/O                         | All audio data decoded to RAM at load time           |
| No plugin UI calls                  | JUCE `MessageManager` is separate thread             |
| Plugin `processBlock()` only        | JUCE guarantees real-time safety for this call       |

### Lock-Free Communication

Commands from IPC thread → Audio thread:

```cpp
// Command queue: single-producer (IPC), single-consumer (audio)
struct CommandQueue {
    std::atomic<size_t> writeIndex{0};
    std::atomic<size_t> readIndex{0};
    std::array<Command, 256> buffer;
};
```

IPC pushes commands. Audio thread reads and applies at block boundary. No locks.

---

## 6. Undo / Redo Implementation

Tracktion uses a deep transaction system. UltraSlim uses a **command stack** — sufficient for all DAW operations.

```cpp
class Command {
public:
    virtual ~Command() = default;
    virtual void execute() = 0;
    virtual void undo() = 0;
    virtual std::string describe() const = 0;
};

class MoveClipCmd : public Command {
    Project* project;
    Clip* clip;
    double oldStart, newStart;
    int oldTrack, newTrack;
public:
    void execute() override {
        clip->start = newStart;
        clip->trackId = newTrack;
        project->clipMoved(clip);
    }
    void undo() override {
        clip->start = oldStart;
        clip->trackId = oldTrack;
        project->clipMoved(clip);
    }
};
```

**Architecture:**

- `UndoHistory` owns two `std::vector<std::unique_ptr<Command>>`: `undoStack` and `redoStack`
- Every mutation goes through `project->executeCommand(std::make_unique<MoveClipCmd>(...))`
- `edit.undo` IPC command → pop from undoStack, call `undo()`, push to redoStack
- `edit.redo` IPC command → pop from redoStack, call `execute()`, push to undoStack
- Commands that change the audio graph emit a `CommandQueue` entry for the audio thread

---

## 7. Project File Format

Tracktion saves `.edit` files (proprietary, binary). UltraSlim uses **JSON**.

### Why JSON?

- Human-readable for debugging
- Dashboard already speaks JSON
- Easy versioning and migration
- TheStuu already has `packages/shared-json` with schemas

### File Layout

```
project.thestu/                 ← Folder (not single file)
├── project.json                ← UltraSlim project state
├── audio/                      ← Source audio files
│   ├── kick_01.wav
│   ├── loop_44.wav
│   └── imported_2025_05_17.wav
└── exports/                    ← Bounced files (Phase 1.5)
```

### project.json Schema (Subset)

```json
{
  "version": "ultraslim-v1",
  "transport": {
    "bpm": 128.0,
    "time_signature": { "numerator": 4, "denominator": 4 }
  },
  "tracks": [
    {
      "id": 1,
      "name": "Kick",
      "type": "audio",
      "volume": 0.8,
      "pan": 0.0,
      "mute": false,
      "solo": false,
      "record_armed": false,
      "plugins": [],
      "clips": [
        {
          "type": "audio",
          "source_path": "audio/kick_01.wav",
          "start_bars": 1.0,
          "length_bars": 0.5,
          "trim_start_seconds": 0.0,
          "gain": 1.0,
          "fade_in_seconds": 0.0,
          "fade_out_seconds": 0.0
        }
      ]
    },
    {
      "id": 2,
      "name": "Lead Synth",
      "type": "midi",
      "plugins": [{ "uid": "internal:ultrasound", "state": "..." }],
      "clips": [
        {
          "type": "midi",
          "start_bars": 4.0,
          "length_bars": 8.0,
          "events": [
            { "type": "note_on", "note": 60, "velocity": 100, "beat": 0.0 },
            { "type": "note_off", "note": 60, "beat": 0.5 }
          ]
        }
      ]
    }
  ],
  "master": {
    "volume": 0.9,
    "plugins": []
  }
}
```

**Import from TheStuu:** The existing JSON sidecar (`packages/shared-json`) maps closely to this schema. A migration tool converts TheStuu sidecar → UltraSlim project.

**Export to TheStuu:** UltraSlim emits a compatible sidecar so the Dashboard can load projects without knowing which engine created them.

---

## 8. IPC Protocol: Drop-in Requirement

UltraSlim must implement **100 % of commands** in `docs/native-ipc.md` with **identical MsgPack framing**.

### Essential Commands (must match exactly)

All transport, edit, clip, track, mixer, VST, audio device, and system commands documented in `native-ipc.md`.

### Wire Format (unchanged)

1. Unix domain socket at `STUU_NATIVE_SOCKET`
2. `uint32_be` length prefix + MessagePack body
3. `MsgValue` schema: objects, arrays, strings, ints, doubles, booleans, nil

**If the Node engine sends `{ type: "request", id: 42, cmd: "transport.play", payload: {} }`,**
**UltraSlim must respond `{ type: "response", id: 42, ok: true, payload: { transport: { ... } } }`**

**No key renaming.** No protocol changes. The Node engine is untouched.

### Event Emission

| Event            | When                                               |
| ---------------- | -------------------------------------------------- |
| `transport.tick` | Every ~40 ms (same timer as Tracktion)             |
| `edit.snapshot`  | After any edit mutation (optional but recommended) |
| `clip.changed`   | After clip move/resize/import/delete               |
| `track.changed`  | After mixer/track changes                          |
| `mixer.changed`  | After volume/pan/mute/solo                         |

---

## 9. Phase Plan

### Phase 0: Foundation (Weeks 1–4)

- [ ] Implement `tracktion_backend.hpp` interface with stubs returning `ok: true`
- [ ] UltraSlim project JSON loader (read-only)
- [ ] Basic transport clock (BPM → samples, no audio)
- [ ] Build passes: `cmake -DSTUU_NATIVE_BACKEND=ultraslim`
- [ ] TheStuu starts, Dashboard connects, IPC commands reach UltraSlim

**Milestone:** Dashboard shows "UltraSlim Backend" in health check. Transport play/pause toggles (no sound yet).

### Phase 1: Audio Playback (Months 2–4)

- [ ] Audio callback with `juce_audio_devices`
- [ ] Audio clip scheduling (read from memory buffer, apply gain)
- [ ] Basic mixer (track gain + master summing)
- [ ] `clip:import-file` → decode via JUCE → store in memory
- [ ] `edit:get-audio-clips` → return clip metadata
- [ ] Undo/redo for clip operations
- [ ] Transport seek + BPM change

**Milestone:** Play a WAV file on track 1. Change BPM. Seek. Undo clip import.

### Phase 2: Full Edit Model (Months 5–8)

- [ ] Clip move, resize, delete, split
- [ ] Fade in/out curves
- [ ] MIDI clips + internal synth (`internal:ultrasound`)
- [ ] Plugin chain per track (JUCE hosts VST3/AU)
- [ ] Plugin parameter automation
- [ ] Mixer: pan, mute, solo, record arm
- [ ] Latency compensation across plugin graph
- [ ] Project save/load in JSON format

**Milestone:** Load a TheStuu project. Play audio + MIDI + VST synth. Mix tracks. Undo chain of 20 commands.

### Phase 3: Polish & REAPER-Grade (Months 9–14)

- [ ] Time-stretch / pitch-shift (RubberBand integration)
- [ ] Audio recording (input → armed track → WAV file → clip)
- [ ] Sends / Returns (aux busses)
- [ ] Offline export / bounce
- [ ] Metering (peak/RMS per track)
- [ ] Freeze / bounce in place
- [ ] Crossfades between adjacent clips
- [ ] Performance optimization: lock-free everywhere, cache-friendly clip lookup

**Milestone:** Feature parity with current Tracktion-based TheStuu.

### Phase 4: JUCE-Free (Optional, Years 2–3)

- [ ] Replace `juce_audio_devices` with direct CoreAudio/ALSA/ASIO/AAudio backends
- [ ] Replace `juce_audio_processors` with custom VST3 hosting layer
- [ ] Replace `juce_audio_formats` with dedicated decoders (dr_libs, etc.)
- [ ] Binary target: **<15 MB**, zero external dependencies

**Milestone:** TheStuu runs with only OS audio APIs and its own engine.

---

## 9. Mobile Considerations (Research Update)

### 9.1 Existing Mobile Audio Engines/FW — None Are a Tracktion Replacement

| Engine                   | Language     | Plattformen               | Edit-Graph    | VST/AU-Hosting        | Nutzbar als Tracktion-Ersatz?                         |
| ------------------------ | ------------ | ------------------------- | ------------- | --------------------- | ----------------------------------------------------- |
| **Tracktion Engine**     | C++20        | iOS, Android, Pi, Desktop | ✅ Vollwertig | ❌ (nur AUv3 auf iOS) | **Ja, aber Mobile-UI fehlt, Node-Architektur kaputt** |
| **JUCE (Audio IO only)** | C++          | iOS, Android              | ❌            | ❌ (nur AUv3 iOS)     | Nein — nur Layer                                      |
| **AudioKit**             | Swift        | iOS, macOS, tvOS          | ❌            | ❌                    | Nein — DSP-Sammlung                                   |
| **Superpowered SDK**     | C++          | iOS, Android, Desktop     | ❌            | ❌                    | Nein — Player/FX                                      |
| **MWEngine**             | C++/JNI      | Android                   | ❌            | ❌                    | Nein — Android-only                                   |
| **Switchboard SDK**      | C++/Bindings | iOS, Android, Desktop     | ❌            | ❌                    | Nein — Pipeline/VoIP                                  |
| **SunVox**               | C            | iOS, Android, Desktop     | ✅ (Tracker)  | ❌ (interne Plugine)  | Nein — Tracker, nicht Arrangement                     |

### 9.2 Why No Mobile Engine Replaces Tracktion

**AudioKit** (11k Stars) ist die populärste iOS-Audio-Library. Aber es ist ein **DSP-Baukasten** (Synth, FX, Sampler), keine DAW-Engine. Kein Edit-Graph, kein Arrangement, kein Projekt-Management.

**Superpowered SDK** (1.4k Stars) ist das professionellste Mobile-Cross-Platform-Audio-SDK. Aber es ist ein **Player + FX** — kein Edit-Graph, kein Plugin-Hosting, kein Timeline-Modell.

**Tracktion Engine selbst** listet iOS + Android als supported platforms (offiziell auf GitHub). Aber:

- Keine VST3-Hosting auf Mobile (App-Store verbietet Code-Loading)
- Keine Desktop-Fenster (Plugin-Editor ist Desktop-Konzept)
- UI ist JUCE — auf Mobile müsste man SwiftUI/Jetpack Compose neu schreiben
- Binary + RAM: 30–50 MB auf Mobile — machbar, aber schwer

**Ergebnis:** Es gibt **keine** Mobile-DAW-Engine, die ein 1:1-Ersatz für Tracktion wäre. Tracktion selbst ist die Einzige mit vollwertigem Edit-Graph — aber sie braucht eine komplett neue App-Schicht drumherum.

### 9.3 Why TheStuu Cannot Run on Mobile As-Is

| TheStuu Component             | Mobile Problem                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js Engine**            | Kein Hintergrundprozess auf iOS/Android. React Native hat JS-Runtime, aber kein Express/Socket.IO-Server.                           |
| **Unix Socket IPC**           | iOS-Sandbox blockiert Inter-Prozess-Kommunikation. Kein `/tmp/thestuu-native.sock`.                                                 |
| **Next.js Dashboard**         | Braucht Server (`npm run dev`). Kein Next.js-Server in einer App. Statischer Export geht, aber keine Echtzeit-Socket-Kommunikation. |
| **VST3 Plugins**              | Existieren nicht auf Mobile.App-Store verbietet Code-Loading.                                                                       |
| **Multi-Prozess-Architektur** | Dashboard + Node + Native als getrennte Prozesse ist Mobile-Antipattern. Mobile-Apps sind Single-Prozess.                           |

### 9.4 The Only Viable Mobile Path

A Mobile "TheStuu" would be a **separate product**, not a port:

```
TheStuu Mobile (conceptual):
┌─────────────────────────────────────────┐
│  SwiftUI (iOS) / Jetpack Compose (Android)│
│      ↓                                  │
│  Direct C++ API calls (same process)     │
│      ↓                                  │
│  UltraSlim Core (or Tracktion) linked   │
│      ↓                                  │
│  AAudio (Android) / AVAudioEngine (iOS)│
└─────────────────────────────────────────┘
```

- **No Node engine.**
- **No Socket.IO.**
- **No Unix socket.**
- **No Next.js.**
- **No VST3.** Only internal DSP + AUv3 on iOS.

**This is out of scope for the UltraSlim drop-in specification.** The goal here is a desktop backend replacement. Mobile requires a separate architecture document (`docs/mobile-product-spec.md`).

---

## 10. Performance Targets

| Metric                           | Tracktion (Current)   | UltraSlim Phase 1 Target | UltraSlim Phase 3 Target |
| -------------------------------- | --------------------- | ------------------------ | ------------------------ |
| Binary size                      | 22–73 MB              | **15–25 MB**             | **10–15 MB**             |
| Empty project RAM                | ~50 MB                | **<40 MB**               | **<30 MB**               |
| Startup time                     | 2–5 s                 | **<1 s**                 | **<0.5 s**               |
| Project load (20 clips)          | 1–3 s                 | **<1 s**                 | **<0.5 s**               |
| Audio latency                    | 10–30 ms              | **<15 ms**               | **<10 ms**               |
| Tracks @48kHz/256samples (Pi 4)  | ~8 before dropouts    | **16**                   | **32**                   |
| Tracks @48kHz/256samples (M1/M2) | Unlimited (CPU-bound) | Unlimited                | Unlimited                |
| Plugin chain latency comp        | ✓                     | ✓                        | ✓ (exact)                |

---

## 11. What Is Intentionally Deferred to Phase 2+

| Feature                       | Why Deferred                                                  |
| ----------------------------- | ------------------------------------------------------------- |
| Surround (5.1/7.1)            | Stereo is 99 % of TheStuu use                                 |
| Complex video sync            | Out of scope                                                  |
| Networked audio (Dante/AES67) | Out of scope                                                  |
| Scripting / JSFX              | Optional; REAPER feature                                      |
| ARA (Melodyne integration)    | Complex protocol, optional                                    |
| VST2 hosting                  | Deprecated by Steinberg; skip it                              |
| iOS/Android native port       | Separate product — requires new UI, architecture, no Node/VST |

---

## 12. Conclusion

UltraSlim Engine is a **professional DAW core** that replaces Tracktion while retaining JUCE for audio I/O, MIDI, and VST plugin hosting. It is **not lightweight** — it has full feature parity with Tracktion. It is **efficient** — written from scratch for TheStuu's exact needs without Tracktion's general-purpose overhead.

**Key architectural decisions:**

1. **C++**, not Rust (VST3 + JUCE integration + speed-to-market)
2. **JUCE retained** as hardware/plugin abstraction (Phase 1–3)
3. **Zero changes** to TheStuu Node engine, Dashboard, CLI, or IPC protocol
4. **JSON project format** replacing proprietary `.edit`
5. **Command-pattern undo** replacing Tracktion's transaction system
6. **Lock-free audio callback** with atomic transport + SPSC command queues

**Time estimate:**

- Phase 0–1 (first sound): 2–4 months (1 developer)
- Phase 2 (feature parity): 5–8 months (1 developer)
- Phase 3 (REAPER-grade polish): 9–14 months (1 developer)
- Phase 4 (JUCE-free): 1–2 additional years

**Mobile is explicitly out of scope.** UltraSlim targets Desktop (macOS, Linux, Windows) as a drop-in Tracktion replacement. A Mobile version of TheStuu would require a separate product architecture (new UI framework, single-process design, no Node/VST).

**The Node engine, Dashboard, and entire TypeScript codebase remain untouched.** Only `apps/native-engine/` changes. TheStuu stays TheStuu.
