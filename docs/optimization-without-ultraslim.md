# TheStuu Optimierungsanalyse — ohne UltraSlim Engine

> **Scope:** Dokumentation nur. Kein Code geändert.
>
> **Frage:** Wie effizient und klein können wir TheStuu machen, ohne die Engine zu ersetzen?

---

## 1. Aktuelle Größen (Stand 2026-05-17)

| Komponente                      | Pfad                             | Größe      | Typ                      |
| ------------------------------- | -------------------------------- | ---------- | ------------------------ |
| Dashboard `.next/` (Build)      | `apps/dashboard/.next/`          | **637 MB** | Build-Artefakt           |
| Dashboard `node_modules/`       | `apps/dashboard/node_modules/`   | **459 MB** | Dependencies             |
| Engine `node_modules/`          | `apps/engine/node_modules/`      | **34 MB**  | Dependencies             |
| Native binary (dev build)       | `build/thestuu-native`           | **22 MB**  | Dev-Build                |
| Native binary (tracktion build) | `build-tracktion/thestuu-native` | **73 MB**  | Älterer/anderer Build    |
| Tauri `target/`                 | `apps/desktop/src-tauri/target/` | **2,7 GB** | Rust Build-Artefakte     |
| **Gesamter Repo-Zustand**       | —                                | **>4 GB**  | Inkl. vendor/ und build/ |

**Was bei Verteilung/Download relevant ist:**

- > 95 % dieser Größe sind **Build-Artefakte** (`.next/`, `target/`, `node_modules/`).
- Die **Laufzeit** ist deutlich kleiner.
- Dennoch: Die Architektur hat bisher nicht auf Verteilungsgröße optimiert.

---

## 2. Laufzeit-Größe (was wirklich läuft)

Wenn TheStuu per `npm run start` gestartet wird:

| Prozess                  | Speicher (geschätzt) | Binary/Runtime                   |
| ------------------------ | -------------------- | -------------------------------- |
| Dashboard                | 100–300 MB RAM       | Next.js Server + Browser         |
| Node Engine              | 50–100 MB RAM        | Node.js + 34 MB node_modules     |
| Native Engine            | 50–150 MB RAM        | 22–73 MB Binary + Tracktion Heap |
| Browser (Dashboard UI)   | 100–300 MB RAM       | Chrome/Edge/Safari               |
| **Gesamtsystem laufend** | **300–850 MB RAM**   | —                                |

Das sind **Desktop-Größen** (macOS/Windows/Linux). Nicht riesig für eine DAW, aber auch nicht schlank.

---

## 3. Optimierungsrouten — was geht ohne Engine-Tausch

### Route A: Statischer Dashboard-Export (größter Hebel)

#### Problem

Das Dashboard ist ein Next.js-Server, der SSR (Server-Side Rendering) und Build-Time-Optimierungen nutzt. Für TheStuus Use-Case braucht es das **nicht**:

- Das Dashboard kommuniziert **ausschließlich** über `socket.io-client` mit dem Node-Engine (Port 3990).
- Keine Next.js-API-Routen werden genutzt (`apps/dashboard/pages/api/` existiert nicht).
- Kein `getServerSideProps`. Kein Edge-Rendering.
- Das Dashboard ist ein **Single-Page Application (SPA)** mit Echtzeit-Socket-Verbindung.

#### Lösung

Next.js kann als **statischer Export** gebaut werden:

```js
// next.config.js
const nextConfig = {
  output: "export",
  distDir: "dist",
};
module.exports = nextConfig;
```

Das produziert:

- `index.html` (und weitere Routen als HTML)
- Minifizierte JS-Bundles
- CSS
- Assets
- **Kein Node.js-Server für das Dashboard**

| Vorher                        | Nachher                                |
| ----------------------------- | -------------------------------------- |
| 637 MB `.next/` build output  | **5–15 MB** `dist/` (gzip/komprimiert) |
| 459 MB node_modules (Runtime) | **0 MB** (nur Build-Time)              |
| Next.js Server starten        | Reiner static HTML serve               |

#### Einsparung

- **Deployment-Größe:** ~1 GB → **~15 MB** (~99 % Ersparnis)
- **RAM:** Dashboard-Server-Prozess (~100–200 MB) entfällt
- **Startzeit:** Kein Next.js Boot mehr

#### Aufwand

- **Sehr klein.** `next.config.js` anpassen (1 Zeile).
- Eventuelle dynamischen Routen (`pages/`) prüfen, dass keine SSR genutzt wird.
- Socket.IO-Client muss weiterhin zu `localhost:3990` (oder `window.location`) connecten — das funktioniert aus statischem HTML identisch.

**Schätzung: 1–2 Tage.**

#### Was man testen muss

```bash
cd apps/dashboard
# next.config.js: output: 'export' hinzufügen
npm run build
# Prüfen: dist/ existiert? index.html vorhanden? Socket.IO noch da?
# Dashboard aus dist/ statisch hosten und Engine verbinden
```

---

### Route B: Native Engine Release + Strip

#### Problem

Die aktuellen Binaries sind **Debug-Builds** oder mit unoptimierten Flags gelinkt:

- `build-tracktion/thestuu-native`: **73 MB**
- `build/thestuu-native`: **22 MB** (vermutlich schon etwas optimiert, aber nicht gestrippt)

Tracktion + JUCE komprimieren sich mit Release-Optimierungen drastisch.

#### Lösung

CMake-Build als `Release` mit Strip + Link-Time-Optimization:

```cmake
# CMakeLists.txt oder cmake preset
set(CMAKE_BUILD_TYPE Release)
set(CMAKE_INTERPROCEDURAL_OPTIMIZATION ON)  # LTO

# Compiler flags
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG -ffunction-sections -fdata-sections")
set(CMAKE_EXE_LINKER_FLAGS_RELEASE "-Wl,--gc-sections")

# Für macOS
if(APPLE)
  set_target_properties(thestuu-native PROPERTIES
    XCODE_ATTRIBUTE_DEBUG_INFORMATION_FORMAT "dwarf-with-dsym"
    XCODE_ATTRIBUTE_STRIP_INSTALLED_PRODUCT YES
  )
endif()
```

Nach dem Linken:

```bash
strip thestuu-native  # entfernt Debug-Symbole
```

#### Einsparung

| Vorher        | Nachher                              |
| ------------- | ------------------------------------ |
| 73 MB (Debug) | **15–25 MB** (Release + Strip)       |
| 22 MB (Dev)   | **15–20 MB** (mit LTO + gc-sections) |

#### Aufwand

- **Sehr klein.** CMake-Preset o. Build-Skript anpassen.
- `strip` als Post-Build-Schritt.

**Schätzung: 1 Tag.**

**Hinweis:** Debug-Symbole sollten separat gespeichert werden (`.dSYM` auf macOS), für Crash-Reports. Das Binary selbst wird gestrippt.

---

### Route C: Node Engine als Single Executable

#### Problem

Der Node-Engine läuft als separater Prozess und braucht:

- Node.js Runtime (~100 MB installiert)
- 34 MB `node_modules/`
- `package.json` + Source-Dateien

Für eine **Verteilung** ist das unpraktisch — der Nutzer muss Node.js installiert haben.

#### Optionen

| Tool                                          | Ergebnis                              | Geschätzte Größe | Einschränkungen                                                      |
| --------------------------------------------- | ------------------------------------- | ---------------- | -------------------------------------------------------------------- |
| **pkg** (Vercel)                              | Single `.exe` / `.app` / Linux-Binary | ~50–80 MB        | Unterstützt **keine** nativen Node-Module out-of-the-box             |
| **nexe**                                      | Ähnlich                               | ~50–80 MB        | Gleiches Problem                                                     |
| **Node.js SEA** (Single Executable, Node 20+) | Single Binary                         | ~40–70 MB        | Experimentell. Native Module problematisch.                          |
| **Bun**                                       | Bun compiliert zu Single Binary       | ~30–50 MB        | Sehr schnell, aber experimentell. `socket.io` kompatibilität prüfen. |

#### Das native-Module-Problem

`apps/engine/package.json`:

```json
"dependencies": {
  "audio-decode": "^2.2.3",
  "msgpackr": "^1.11.5",
  "socket.io": "^4.8.1"
}
```

- `msgpackr` hat native C++-Bindings für Performance.
- `audio-decode` hat native Decoder (ffmpeg, etc.).

**Wenn native Module mitgebundelt werden müssen**, wird `pkg`/`nexe`/`SEA` kompliziert.

#### Einsparung

- **Deployment-Größe:** ~134 MB (Node + node_modules) → **30–80 MB** Single Binary
- **RAM:** Gleich — Node läuft als Prozess
- **Nutzer-Experience:** Keine Node.js-Installation nötig mehr

#### Aufwand

- **Mittel.** 2–3 Tage.
- Native-Module-Kompatibilität testen
- Eventuell `msgpackr` durch pure-JS-Alternative ersetzen (`@msgpack/msgpack` oder JSON-Framing)
- `audio-decode` optional für Legacy-Modus; bei native-first evtl. nicht länger nötig

---

### Route D: Tauri-Bundle (Alles zusammenpacken)

#### Konzept

Tauri ist bereits vorhanden (`apps/desktop/`). Tauri kann:

1. Das **statische Dashboard-HTML** hosten (kein Next.js-Server nötig)
2. Den **Node-Engine als Sidecar** mitbundeln
3. Die **native-engine als External Binary** mitbundeln

```
TheStuu.app / TheStuu.exe (Tauri Bundle)
├── Tauri-Shell (Rust Binary)           ← ~3–5 MB
├── Node-Engine (Single Executable)       ← ~30–80 MB
├── Native-Engine (Release + Strip)     ← ~15–25 MB
├── Dashboard (Statischer Export)       ← ~5–15 MB (im Resources-Bundle)
└── Icons, Meta, Plist                  ← ~1 MB
```

**Gesamtpaket als installierbare App: ~55–130 MB**

Das ist ein **vertretbares Paket** für eine Desktop-DAW.

#### Vergleich mit anderen DAWs

| DAW                     | Installationsgröße |
| ----------------------- | ------------------ |
| REAPER                  | ~15 MB             |
| FL Studio               | ~1 GB              |
| Ableton Live            | ~3 GB              |
| Tracktion Waveform Free | ~200 MB            |
| Studio One              | ~400 MB            |
| **TheStuu (optimiert)** | **~55–130 MB**     |

**Ergebnis:** Schlanker als Waveform Free, schwerer als REAPER. Passt.

| Vorher (Dev-Stack)                        | Nachher (Tauri-Bundle)           |
| ----------------------------------------- | -------------------------------- |
| 2,7 GB `target/` + 4 GB Repo              | **55–130 MB** installierbare App |
| Nutzer braucht Node.js + Tracktion Vendor | Ein Doppelklick, App läuft       |
| 3 Prozesse separat starten                | 1 App startet alles              |

#### Aufwand

- **Mittel.** 3–5 Tage.
- `tauri.conf.json`: `frontendDist` auf statischen Export zeigen
- `externalBin`: Node-Engine als Sidecar einbinden
- Tauri process-spawning für Node + Native
- CI/Pipeline: Release-Build + Bundle signieren

---

## 4. Was damit NICHT gelöst bleibt

| Problem                           | Bleibt?       | Warum                                                                                                                       |
| --------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **RAM bei leerem Projekt**        | **Ja**        | Tracktion + JUCE allokieren ~50–100 MB Heap für Edit-Kontext, Plugin-Scan, etc.                                             |
| **RAM bei 20 Clips**              | **Ja**        | Tracktions Edit-Graph + JUCE AudioFormatReader + Plugin-Stakes: 150–300 MB                                                  |
| **Native Binary > 15 MB**         | **Ja**        | Tracktion + JUCE sind halt groß. Release + Strip bringt 15–25 MB — aber nicht <10 MB.                                       |
| **Startup 2–5 s**                 | **Teilweise** | Release-Build schneller, aber Tracktion braucht Kontext-Init. Nicht sub-second.                                             |
| **VST-Plugin-Scan**               | **Ja**        | JUCE scannt Plugins beim ersten Start. Dauert Sekunden bis Minuten.                                                         |
| **CPU-Last bei vielen Plugins**   | **Ja**        | JUCEs Plugin-Hosting-Overhead bleibt.                                                                                       |
| **Raspberry Pi 4 mit 2–4 GB RAM** | **Nein**      | 80–130 MB Binary + 100–200 MB RAM: läuft, aber nicht angenehm. CPU-bound bei >8 Spuren.                                     |
| **ARM64-Builds**                  | **Nein**      | Tracktion sagt "Raspberry Pi supported" auf GitHub, aber kein Cross-Build in CI. Manuell kompilierbar, aber nicht getestet. |
| **Mobile (iOS/Android)**          | **Nein**      | Architektur ist Multi-Prozess-Desktop. Mobile braucht Single-Process-App.                                                   |

---

## 5. Zusammenfassung der Hebel

| Route                                  | Aktuell                             | Machbar                     | Einsparung   | Aufwand  |
| -------------------------------------- | ----------------------------------- | --------------------------- | ------------ | -------- |
| **A: Dashboard statisch exportieren**  | 1,1 GB (`.next/` + `node_modules/`) | **5–15 MB**                 | **~99 %**    | 1–2 Tage |
| **B: Native Release + Strip**          | 73 MB                               | **15–25 MB**                | **~65–85 %** | 1 Tag    |
| **C: Node Single Executable**          | ~134 MB                             | **30–80 MB**                | **~40–75 %** | 2–3 Tage |
| **D: Tauri-Bundle (A+B+C kombiniert)** | ~4 GB (gesamtes Repo/Build)         | **55–130 MB installierbar** | **~97 %**    | 3–5 Tage |

**Gesamtes installierbares TheStuu-Desktop-Paket ohne UltraSlim: ~55–130 MB**

---

## 6. Pragmatische Empfehlung

### Kurzfristig (diesen Monat) — sofort umsetzbar:

1. **Route A: Dashboard `output: 'export'`** — Einzeler Zugewinn. Trivialer Code-Change. Test: `npm run build` in Dashboard.
2. **Route B: Native Release-Build** — CMake-Preset oder Build-Flag. Strip als Post-Build. Test: Binary läuft noch.
3. **Tauri-Bundle experimentieren** — Statisches Dashboard + Release-Native als Proof-of-Concept. Nicht perfekt, aber zeigt das Ziel.

### Mittelfristig (2. Monat):

4. **Node Single Executable** — `pkg` oder Bun testen. Wenn `msgpackr` Probleme macht, durch pure-JS-Alternative ersetzen.

### Langfristig (3. Monat+):

5. **Tauri Release-Pipeline** — CI baut signed `.app`, `.exe`, `.dmg`, `.AppImage` automatisch.

### Was das bringt:

- **Ein installierbares TheStuu-Paket von 55–130 MB**
- **Keine Node.js-Installation nötig**
- **Ein Doppelklick, App läuft**
- **Desktop: Mac, Windows, Linux**

### Was das nicht bringt:

- **Keine Kartoffel-Optimierung** (Pi 4/3 bleibt angestrengt)
- **Kein Mobile** (iOS/Android)
- **Keine Sub-15-MB-Binary** (für UltraSlim nötig)

---

## 7. Grenze: Wann braucht man UltraSlim?

| Ziel                          | Geht ohne UltraSlim? | Wie?                                            |
| ----------------------------- | -------------------- | ----------------------------------------------- |
| Desktop-Installation < 150 MB | **Ja**               | Routes A+B+C+D                                  |
| Startup < 1 s                 | **Teilweise**        | Release-Build, aber Tracktion-Init braucht Zeit |
| RAM leer < 50 MB              | **Nein**             | Tracktion + JUCE sind größer                    |
| Raspberry Pi 4 (smooth)       | **Nein**             | RAM + CPU zu knapp                              |
| Mobile (iOS/Android)          | **Nein**             | Architektur falsch                              |
| Binary < 10 MB                | **Nein**             | Tracktion + JUCE > 10 MB                        |
| Keine JUCE-Abhängigkeit       | **Nein**             | Braucht UltraSlim                               |

**Die Grenze ist klar:** Wenn du unterhalb von ~15 MB Binary, ~50 MB RAM leer, oder auf Mobile/Pi willst, brauchst du **UltraSlim Engine**.

Wenn du eine **schrumpfgesichtigte Desktop-Version** willst: Die Routes A–D reichen.

---

## 8. Optionale Zusatz-Optimierungen

| Optimierung                                | Größen-Einsparung                  | Aufwand  | Risiko                                                                                                                  |
| ------------------------------------------ | ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Dashboard Dependencies aufräumen**       | node_modules 459 MB → ~200 MB      | 1–2 Tage | Gering. Nicht benutzte Dependencies (ReactFlow? Framer Motion?) entfernen.                                              |
| **Tree-shaking aggressiver**               | JS-Bundle weiter verkleinern       | 1 Tag    | Gering. Next.js macht das größtenteils selbst.                                                                          |
| **Dashboard kein Font-Loading**            | ~5–10 MB Fonts entfernen           | 30 Min   | Gering. System-Fonts nutzen.                                                                                            |
| **Native: `dlopen` statt statisch linken** | Nicht signifikant                  | 1 Woche  | Mittel. Komplex, bringt wenig für Binary-Größe.                                                                         |
| **JUCE Module reduzieren**                 | Minimal                            | 1 Tag    | Mittel. Nur `juce_audio_devices` + `juce_audio_processors` + `juce_audio_formats` + `juce_core` linken. Rest weglassen. |
| **UPX komprimieren**                       | ~30–50 % kleiner (entpackt gleich) | 1 Stunde | Gering. UPX packt Binaries. Verlangsamt Start minimal.                                                                  |

---

_Dokument erstellt: 2026-05-17_
