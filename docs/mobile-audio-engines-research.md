# Mobile Engines: Was gibt es? Und warum Trackton/iOS/Android-Claims nicht reichen

> **Status:** Recherche-Ergebnis. Kein Code geändert.
>
> **Kern-Erkenntnis:** Tracktion Engine listet iOS + Android als Supported Platforms. JUCE ebenfalls. Aber **das ist nicht das Problem**. Das Problem ist die Multi-Prozess-Desktop-Architektur von TheStuu (Node-Engine + Unix Socket + Next.js Dashboard). Eine Engine für Mobile muss im selben Prozess laufen.

---

## 1. Existierende Mobile-DSP-Engines/Frameworks

### 1.1 AudioKit (iOS / macOS / tvOS)

|                  |                                                         |
| ---------------- | ------------------------------------------------------- |
| **Sprache**      | Swift                                                   |
| **Plattformen**  | iOS, macOS, tvOS                                        |
| **Features**     | Synthesis, Sampling, Effects, MIDI, Recording, Analysis |
| **Binary-Größe** | ~5–15 MB (modular)                                      |
| **Lizenz**       | MIT (Open Source)                                       |
| **Github**       | ~11.300 Stars                                           |
| **Gut für**      | Synthesizer-Apps, Loop-Player, einfache DAWs            |
| **Schlecht für** | Vollwertige DAW mit VST-Hosting (kein VST auf iOS)      |

AudioKit ist das populärste iOS-Audio-Framework. Es bietet eine Swift-API und macht komplexe Audio-Wiedergabe auf iOS einfach. Es ist aber **keine DAW-Engine** — es hat keinen Edit-Graph, kein Non-Destructive-Timeline-Modell, kein Projekt-Management. Es ist ein **DSP-Baukasten**.

**Was es hat:**

- AudioPlayer,Sampler,Synth (OSC, FM, etc.)
- Effekte (Delay, Reverb, EQ, Distortion)
- MIDI-Sequencing
- Recording

**Was es nicht hat:**

- VST/AU-Hosting (App Store verbietet Code-Loading)
- Multi-Track-Arrangement-Edit-Graph
- Projekt-Load/Save mit komplexen Referenzen
- Plugin-Latenz-Kompensation

---

### 1.2 Superpowered SDK (iOS / Android / macOS / Windows / Linux / Web)

|                  |                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| **Sprache**      | C++ (Header + statische Libs)                                                                  |
| **Plattformen**  | iOS, Android, macOS, Windows, Linux, tvOS, WebAssembly                                         |
| **Features**     | Low-Latency Audio I/O, Decoder, Effects, Time-Stretch, HLS, Spatializer                        |
| **Lizenz**       | Kommerziell (kostenlos für kleine Projekte, aber Lizenz erforderlich für kommerzielle Nutzung) |
| **Github**       | ~1.400 Stars                                                                                   |
| **Gut für**      | DJ-Apps, Loop-Player, Streaming, einfache Sequenzer                                            |
| **Schlecht für** | Vollwertige DAW mit Plugin-Hosting und komplexem Routing                                       |

Superpowered ist das **professionellste** Mobile-Audio-SDK. Es ist in C++ und bietet sehr geringe Latenz. Es wird von vielen DJ-Apps und Musik-Apps genutzt.

**Was es hat:**

- Audio I/O (AAudio auf Android, CoreAudio auf iOS)
- MP3/AAC-Decoder (sehr schnell)
- Effects (Flanger, Reverb, Filter, etc.)
- Time-Stretch / Pitch-Shift
- HLS-Streaming
- USB-Audio und USB-MIDI auf Android
- Offline-Processing (Bounce)

**Was es nicht hat:**

- Plugin-Hosting (weder VST noch AU)
- Komplexer Edit-Graph (Timeline-Modell fehlt)
- Send/Return Routing
- Automation
- Projekt-Datei-Format

**Bewertung:** Sehr gut für Player/Looper/Streamer. Keine DAW-Engine.

---

### 1.3 MWEngine (Android)

|                  |                                                            |
| ---------------- | ---------------------------------------------------------- |
| **Sprache**      | C++ (mit Java/Kotlin-API via JNI)                          |
| **Plattformen**  | Android (OpenSL / AAudio)                                  |
| **Features**     | Sequencing, Synthesis, Effects, Recording, Sample Playback |
| **Lizenz**       | MIT                                                        |
| **Github**       | ~280 Stars                                                 |
| **Gut für**      | Android-Musik-Apps, Sequenzer, Sampler                     |
| **Schlecht für** | iOS (nur Android), Plugin-Hosting                          |

MWEngine ist eine Android-spezifische Audio-Engine. Sie bietet einen musikalischen Kontext (Tempo-basiertes Sequencing) und ist für Android optimiert.

**Was es hat:**

- Tempo-basierte Sequencing
- Sample-Playback mit Pitch-Shifting
- Effekt-Ketten
- Live-Recording
- Offline-Bounce zu WAV

**Was es nicht hat:**

- iOS-Support
- Plugin-Hosting
- Komplexes Arrangement-Modell

---

### 1.4 Switchboard Audio SDK (iOS / Android / macOS / Windows / Linux / Web)

|                  |                                          |
| ---------------- | ---------------------------------------- |
| **Sprache**      | C++ / Swift / Kotlin (Bindings)          |
| **Plattformen**  | iOS, Android, macOS, Windows, Linux, Web |
| **Features**     | Modularer Node-basierter Audio-Pipeline  |
| **Lizenz**       | Freemium (kostenlos mit Einschränkungen) |
| **Web**          | docs.switchboard.audio                   |
| **Gut für**      | VoIP, Audio-Apps mit real-time-Pipeline  |
| **Schlecht für** | DAW mit vollem Edit-Graph                |

Switchboard ist ein moderner Ansatz: visueller Pipeline-Editor, modulare Nodes. Gut für Audio-Apps, aber nicht als Ersatz für Tracktion gedacht.

---

### 1.5 Sezo Audio Engine (iOS / Android)

|                  |                                                   |
| ---------------- | ------------------------------------------------- |
| **Sprache**      | Android-Package + Expo-Modul (JS/TS API)          |
| **Plattformen**  | iOS, Android                                      |
| **Features**     | Multi-Track, Pitch/Speed, Recording, Extraction   |
| **Lizenz**       | Unklar (Experimentell)                            |
| **Gut für**      | Expo/React-Native-Apps, einfache Audio-Wiedergabe |
| **Schlecht für** | Professionelle DAW                                |

sehr unbekannt, experimentell.

---

### 1.6 JUCE (iOS / Android)

|                  |                                                      |
| ---------------- | ---------------------------------------------------- |
| **Sprache**      | C++                                                  |
| **Plattformen**  | iOS (12+), Android (7+), macOS, Windows, Linux       |
| **Features**     | Audio I/O, Plugin-Hosting (AUv3 auf iOS), GUI, MIDI  |
| **Lizenz**       | GPL / Kommerziell                                    |
| **Gut für**      | Alles — aber **kein Edit-Graph**                     |
| **Schlecht für** | Mobile als komplette DAW-Engine (nur Audio-IO-Layer) |

JUCE unterstützt Mobile. Aber JUCE ist ein **Framework**, keine DAW-Engine. Es gibt dir Audio-IO, MIDI, und du kannst AUv3-Plugins hosten (auf iOS). Du musst aber **alles andere selbst schreiben**: Timeline, Edit-Graph, Mixer-Logic, Projekt-Management.

**Wichtig:** JUCE auf iOS kann **AUv3-Erweiterungen** hosten, nicht VST3. AUv3 ist das iOS-Plugin-Format. Aber App-Store-Apps können **keine fremden Plugins nachladen** — Plugins müssen als App-Erweiterungen gebündelt werden. Das ist ein komplett anderes Ökosystem als Desktop-VST3.

---

### 1.7 Tracktion Engine (iOS / Android / Raspberry Pi)

|                 |                                                                          |
| --------------- | ------------------------------------------------------------------------ |
| **Sprache**     | C++20                                                                    |
| **Plattformen** | Offiziell: macOS, Windows, Linux, **iOS**, **Android**, **Raspberry Pi** |
| **Features**    | Vollwertige DAW-Data-Model, Edit-Graph, Timeline                         |
| **Lizenz**      | GPL / Kommerziell                                                        |
| **Github**      | ~1.400 Stars                                                             |

**DAS ist der Hammer.** Tracktion Engine listet **iOS und Android als supported platforms**.

Aber:

- **Keine VST3-Hosting auf Mobile.** Tracktion kann auf Mobile keine VST3-Plugins laden (App-Store-Verbot + ARM64-VST3-Rarität).
- **Keine Desktop-Fenster.** Plugin-Editor-Fenster sind ein Desktop-Konzept. Auf Mobile gibt es kein "Fenster öffnen".
- **UI in JUCE.** Tracktion Engine ist eine Daten-Modell-Engine. Die UI ist JUCE. Auf Mobile müsstest du die UI komplett neu schreiben (SwiftUI / Jetpack Compose).
- **Projucer/CMake** für Mobile-Builds. Technisch machbar, aber nicht trivial.
- **Binary-Größe.** Tracktion + JUCE auf Mobile = vermutlich 30–50 MBBinary + Edit-Graph-RAM.

---

## 2. Die entscheidende Unterscheidung

### Was Tracktion/JUCE für Mobile KANN:

- ✅ Audio I/O (CoreAudio auf iOS, AAudio auf Android)
- ✅ MIDI I/O
- ✅ AUv3-Plugin-Hosting (nur iOS, nicht VST3)
- ✅ Edit-Graph, Timeline, Transport (Tracktion Engine)
- ✅ Projekt-Load/Save

### Was TheStuu auf Mobile NICHT kann (wegen Architektur, nicht Engine):

- ❌ **Node.js Engine läuft nicht als Hintergrundprozess auf iOS/Android**
- ❌ **Unix Domain Socket IPC zwischen Prozessen ist auf iOS sandboxed**
- ❌ **Next.js Dashboard als Web-App braucht keinen Server** — kann man theoretisch statisch bauen, aber die Echtzeit-Socket.IO-Kommunikation zum Node-Server fehlt
- ❌ **VST3-Plugins** auf Mobile existieren praktisch nicht
- ❌ **Multi-Prozess-Architektur** (Dashboard + Node + Native als getrennte Prozesse) ist Mobile-Antipattern. Mobile-Apps sind Single-Prozess.

---

## 3. Was gibt es also für Mobile?

| Engine                  | Sprache      | VST/AU-Hosting       | Edit-Graph    | Mobile-Plattformen    | Nutzbar als Tracktion-Ersatz?                      |
| ----------------------- | ------------ | -------------------- | ------------- | --------------------- | -------------------------------------------------- |
| **Tracktion Engine**    | C++20        | ❌ (nur AUv3 iOS)    | ✅ Vollwertig | iOS, Android, Pi      | Ja, aber: Mobile-UI fehlt, Node-Architektur kaputt |
| **JUCE (nur Audio IO)** | C++          | ❌ (nur AUv3 iOS)    | ❌            | iOS, Android          | Nein (nur Layer)                                   |
| **AudioKit**            | Swift        | ❌                   | ❌            | iOS, macOS, tvOS      | Nein (DSP-Sammlung)                                |
| **Superpowered SDK**    | C++          | ❌                   | ❌            | iOS, Android, Desktop | Nein (Player/FX)                                   |
| **MWEngine**            | C++/JNI      | ❌                   | ❌            | Android               | Nein (Android-only)                                |
| **Switchboard**         | C++/Bindings | Nein                 | Nein (Pipes)  | iOS, Android, Desktop | Nein (VoIP/Pipeline)                               |
| **SunVox**              | C            | ❌ (interne Plugine) | ✅ Tracker    | Android, iOS, Desktop | Nein (Tracker, nicht Arrangement)                  |

**Ergebnis:** Es gibt **keine** Mobile-DAW-Engine, die ein 1:1-Ersatz für Tracktion auf Desktop ist. Tracktion selbst kommt am nähesten, aber die **Architektur um TheStuu herum** (Node + Socket + Next.js) macht einen Mobile-Port unmöglich.

---

## 4. Der einzige sinnvolle Weg zu Mobile

Wenn du TheStuu auf Mobile willst, gibt es zwei Optionen:

### Option A: Tracktion auf Mobile mit nativem Mobile-UI

- Tracktion Engine kompiliert für iOS/Android
- Keine Node-Engine — die App ist eine **Single-Prozess-Native-App**
- Kein Unix-Socket — direkte C++-Methodenaufrufe
- Kein Next.js-Dashboard — SwiftUI (iOS) oder Jetpack Compose (Android)
- Keine Socket.IO-Events — UI ist direkt im selben Prozess wie die Engine
- Projekt-Format: Tracktion `.edit` oder JSON

**Das ist KEIN TheStuu mehr.** Das ist eine neue App, die Tracktion als Engine nutzt.

### Option B: UltraSlim Engine für Mobile

- Eigene C++-Engine (wie in `ultraslim-engine-spec.md`)
- Kein Tracktion, kein JUCE (oder minimal JUCE nur für Audio-IO)
- Direkt in die Mobile-App gelinkt
- SwiftUI/Jetpack Compose als UI
- JSON-Projektformat
- Keine Plugins (nur interne DSP)

**Auch das ist KEIN TheStuu.** Das ist ein neues Produkt.

---

## 5. Fazit

**Die Frage "gibt es sowas für mobile?" hat zwei Antworten:**

1. **Gibt es Mobile-DAW-Engines?** → Ja. Tracktion Engine selbst unterstützt iOS/Android. JUCE auch. Aber:
2. **Kann man damit TheStuu auf Mobile bauen?** → Nein. Nicht ohne die komplette Architektur (Node + Socket + Next.js + Multi-Prozess) über den Haufen zu werfen.

**Mobile-Audio-Engines existieren**, aber **keine** davon passt in TheStuus Multi-Prozess-Desktop-Socket-Architektur. Jede Mobile-Version von TheStuu wäre ein **neues Produkt** mit:

- Anderer Architektur (Single-Prozess)
- Anderer UI-Sprache (SwiftUI/Jetpack Compose statt React/Next.js)
- Keinem Node-Engine
- Keinem Socket.IO
- Gleicher oder ähnlicher Engine-Core (entweder Tracktion oder UltraSlim)

**Empfehlung:** Desktop zuerst mit UltraSlim-Engine (Phase 1–3) perfektionieren. Mobile ist eine **separate Produktsparte**, die den gleichen Backend-Core teilen kann, aber eine komplett eigene App-Schicht braucht.
