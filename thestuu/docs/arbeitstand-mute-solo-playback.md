# Arbeitsstand: Mute/Solo/Vol/Pan & Playback (Februar 2026)

Dokumentation für alle, die neu ins Projekt einsteigen oder den letzten Stand verstehen wollen. Beschreibt **genau**, was gebaut wurde, wo das Problem liegt und welche Dateien betroffen sind.

---

## 1. Projekt-Kontext (kurz)

- **TheStuu**: DAW-ähnliche Web-App (Arrangement, Mixer, Clips, Native-Audio).
- **Stack**: Next.js (Dashboard), Node (Engine mit Socket.IO), **Native-Engine (C++)** mit Tracktion Engine für echten Audio-Output.
- **Start**: `npm run dev` = `thestuu start` → baut Native-Engine, startet Native-Prozess + Engine + Dashboard. Native-Binary: `apps/native-engine/build/thestuu-native`.
- **Relevante Pfade**:
  - Frontend/UI: `apps/dashboard/` (v. a. `components/stuu-shell.jsx`, `app/globals.css`)
  - Engine (Node): `apps/engine/src/server.js`
  - Native (C++): `apps/native-engine/src/` (v. a. `tracktion_backend_tracktion.cpp`)

Ohne diesen Kontext wirken die folgenden Änderungen und das aktuelle Problem schwer einordbar.

---

## 2. Was bisher umgesetzt wurde (chronologisch, detailliert)

### 2.1 Playlist-Grid: gleiche Optik wie Track-Kopf bei Mute/Solo

**Ziel:** Die **Spur im Grid** (die Zeile, in der die Clips liegen) soll bei **Solo gelb** und bei **Mute blass** aussehen – wie der Track-Kopf links daneben.

**Änderungen:**

| Wo | Was |
|----|-----|
| **`apps/dashboard/components/stuu-shell.jsx`** | An der **Grid-Zeile** (`arrangement-grid-row`) dieselben Klassen wie am Track-Kopf gesetzt: `track.mix?.mute ? 'track-muted' : ''` und `track.mix?.solo ? 'track-soloed' : ''`. (Zeile ca. 6021, im `arrangementTracks.map` für die Grid-Lanes.) |
| **`apps/dashboard/app/globals.css`** | Neue Regeln für **`.arrangement-grid-row.track-muted`** und **`.arrangement-grid-row.track-soloed`** (opacity/filter für Mute, Hintergrund/box-shadow für Solo), angeglichen an die bestehenden **`.arrangement-track-row.track-muted`** / **.track-soloed** Styles. |

Ergebnis: Die komplette Zeile (Track-Kopf + zugehörige Grid-Spur) ist bei Solo gelb und bei Mute blass.

---

### 2.2 Mute-Zeile noch blasser, Mute-Button kräftiger und nicht mitverblassen

**Ziel:**  
- Mute-Zeile **deutlich blasser**.  
- **Mute-Button** im aktiven Zustand **kräftig** und **sofort erkennbar** (nicht gelb, damit Abgrenzung zu Solo).  
- Der **Mute-Button darf nicht mitverblassen**, wenn die Zeile gemuted ist.

**Änderungen:**

| Wo | Was |
|----|-----|
| **`globals.css`** | **Mute-Zeilen** (Track-Zeile + Grid-Zeile): Opacity von 0,55 auf **0,38**, Saturation auf **0,45** (und angepasste Hover/Active-Werte). |
| **`globals.css`** | **Mute-Button aktiv:** Neue Klasse **`.mute-toggle.active`** (und Varianten für Mix-Strip/Mix-Channel): kräftiger Rand, heller Hintergrund, **weiß/neutral** (kein Gelb/Orange). |
| **`globals.css`** | **Verblassen nur für Kopf, nicht für Mix:** Statt die ganze **`.arrangement-track-row.track-muted`** zu verblassen, wird Opacity/Filter nur auf **`.arrangement-track-row.track-muted .arrangement-track-head`** und **`.arrangement-track-row.track-muted .arrangement-track-chain`** angewendet. **`.arrangement-track-mix`** (Mute/Solo/Record, Vol, Pan) bleibt unverändert → Mute-Button bleibt voll sichtbar. |
| **`stuu-shell.jsx`** | An **allen** Mute-Buttons die Klasse **`mute-toggle`** ergänzt (Arrangement-Zeile, Mix-Strip, Mix-Channel-Inspector). |

Ergebnis: Gemutete Zeilen wirken stark abgedunkelt; der Mute-Button ist aktiv klar sichtbar und verblasst nicht.

---

### 2.3 Solo: Audio- und MIDI-Clips in der Spur gelb

**Ziel:** Bei Solo sollen nicht nur Track-Kopf und Grid-Hintergrund gelb sein, sondern auch die **Clips** (Audio/MIDI) in dieser Spur.

**Änderungen:**

| Wo | Was |
|----|-----|
| **`globals.css`** | **`.arrangement-grid-row.track-soloed .timeline-clip`**: Gelber Rand und leichter Innen-Schatten. |
| **`globals.css`** | **`.arrangement-grid-row.track-soloed .timeline-clip.clip-type-audio`**: Dunkelgelber/Amber-Hintergrund, hellgelbe Textfarbe; Label-Leiste angepasst. |
| **`globals.css`** | **`.arrangement-grid-row.track-soloed .timeline-clip.clip-type-midi`**: Gleicher dunkelgelber Hintergrund, hellgelbe Textfarbe. |
| **`globals.css`** | **`.arrangement-grid-row.track-soloed .timeline-clip .timeline-clip-waveform-shape`**: Füllung der Waveform in Gelb getönt. |

Ergebnis: Die sichtbaren Audio- und MIDI-Clips in einer Solo-Spur erscheinen einheitlich gelb.

---

### 2.4 Playback soll bei Mute/Solo/Vol/Pan nicht stoppen (Native-Engine)

**Ziel:** Beim Betätigen von **Mute**, **Solo**, **Vol** oder **Pan** soll die **Wiedergabe weiterlaufen**, damit man beim Mixen nicht unterbrochen wird.

**Hintergrund (technisch):**  
- Mute/Solo/Vol/Pan ändern den **Playback-Graph** (welche Tracks hörbar sind, mit welchem Pegel/Pan).  
- Die Native-Engine baut den Graph mit **`transportRebuildGraphOnly()`** neu auf (ruft intern `ensureContextAllocated(true)` auf).  
- Tracktion hält intern ein **`playingFlag`** und einen **Playhead**. Nach dem Neubau des Graphs war das Flag noch gesetzt, der **neue** Playhead wurde aber nie gestartet.  
- Der **Timer** in Tracktion prüft: `isPlaying() && !playHead->isPlaying()` → dann wird **`stop()`** aufgerufen. Dadurch stoppte die Wiedergabe nach jeder Mute/Solo/Vol/Pan-Änderung.

**Umsetzung (aktuelle Logik):**

| Wo | Was |
|----|-----|
| **`apps/native-engine/src/tracktion_backend_tracktion.cpp`** | In **`transportRebuildGraphOnlyImpl()`**: 1) **`wasPlaying`** und **`savedPosition`** merken. 2) **`transport.freePlaybackContext()`** aufrufen → zerstört den alten Context und setzt **`playingFlag`** zurück. 3) **`transport.ensureContextAllocated(true)`** → neuer Graph mit aktuellem Mute/Solo/Vol/Pan. 4) Wenn **`wasPlaying`**: **`transport.setPosition(savedPosition)`**, dann **`transport.play(false)`**. Dadurch läuft **`performPlay()`** (weil kein PlayingFlag mehr), und der **neue** Playhead wird korrekt gestartet. |

Aufrufkette:  
- Engine (Node) z. B. `track:set-mute` / `track:set-solo` / `track:set-volume` / `track:set-pan` → Native-Transport-Request.  
- Native: `setTrackMute` / `setTrackSolo` / `setTrackVolume` / `setTrackPan` → am Ende jeweils **`transportRebuildGraphOnly()`** → **`transportRebuildGraphOnlyImpl()`** wie oben.

Ergebnis in der Theorie: Playback läuft nach Mute/Solo/Vol/Pan an derselben Position weiter.

---

## 3. Aktuelles Problem (Stand Dokumentation)

**Symptom:** Beim Klicken auf **Mute**, **Solo** oder beim Ändern von **Vol/Pan** **stoppt die Wiedergabe** trotz der beschriebenen Native-Änderung.

**Mögliche Ursachen (zum Abklären):**

1. **Alte Binary im Einsatz**  
   Es wird nicht die zuletzt gebaute Native-Binary verwendet (z. B. alter Prozess läuft noch, oder anderer Build-Pfad).

2. **Build nicht sauber**  
   Objektdateien/Cache waren noch von vor dem Fix → Binary enthält die neue Logik nicht.

3. **Logik/Verhalten in Tracktion**  
   Z. B. `freePlaybackContext()` / `ensureContextAllocated(true)` / `performPlay()` verhalten sich unter Last oder mit bestimmten Edit-Zuständen anders als erwartet (z. B. kurzer Stopp, Position-Sprung, oder Timer-Stop doch noch getriggert).

**Was bereits getan wurde, um 1 und 2 auszuschließen:**

- **Sauberer Neubau der Native-Engine:**  
  - `apps/native-engine/build` gelöscht.  
  - CMake mit **`STUU_THIRD_PARTY_DIR="$(pwd)/vendor/tracktion_engine"`** konfiguriert.  
  - **`cmake --build apps/native-engine/build --target thestuu-native --config Release`** ausgeführt → Build erfolgreich, **`tracktion_backend_tracktion.cpp`** wurde neu kompiliert.  
- Die Binary **`apps/native-engine/build/thestuu-native`** ist vorhanden und aktuell (Datum des Builds prüfbar).

**Empfehlung für dich:**  
- Alle laufenden **`npm run dev`** / **thestuu start** Prozesse beenden.  
- Neu starten mit gesetztem **`STUU_NATIVE_VENDOR_DIR`** (siehe README), damit dieselbe, frisch gebaute Binary verwendet wird.  
- Wenn es dann **weiterhin** stoppt: Fokus auf **3** (Timer, performPlay, Position nach `freePlaybackContext`), ggf. mit Logs in der Native-Engine (z. B. ob `wasPlaying` true ist, ob `setPosition`/`play` aufgerufen werden).

---

## 4. Wichtige Dateien und Stellen (zum schnellen Finden)

| Zweck | Datei | ungefähre Stelle / Suchbegriffe |
|------|--------|----------------------------------|
| Grid-Zeile Mute/Solo-Klassen | `apps/dashboard/components/stuu-shell.jsx` | `arrangement-grid-row` + `track.mix?.mute` / `track.mix?.solo` |
| Track-Zeile Mute/Solo-Klassen | `apps/dashboard/components/stuu-shell.jsx` | `arrangement-track-row` + `track-muted` / `track-soloed` |
| Mute-Button-Klasse | `apps/dashboard/components/stuu-shell.jsx` | `mute-toggle` |
| Mute/Solo/Grid-Styles | `apps/dashboard/app/globals.css` | `track-muted`, `track-soloed`, `arrangement-grid-row`, `mute-toggle.active` |
| Mute nur Kopf verblassen | `apps/dashboard/app/globals.css` | `arrangement-track-row.track-muted .arrangement-track-head` |
| Solo-Clip-Styles (gelb) | `apps/dashboard/app/globals.css` | `arrangement-grid-row.track-soloed .timeline-clip` |
| Rebuild ohne Stop (Native) | `apps/native-engine/src/tracktion_backend_tracktion.cpp` | `transportRebuildGraphOnlyImpl`, `freePlaybackContext`, `ensureContextAllocated`, `setPosition`, `play` |
| Aufruf Rebuild (Mute/Solo/Vol/Pan) | `apps/native-engine/src/tracktion_backend_tracktion.cpp` | `setTrackMute`, `setTrackSolo`, `setTrackVolume`, `setTrackPan` → `transportRebuildGraphOnly()` |
| Engine: Mute/Solo/Vol/Pan | `apps/engine/src/server.js` | `track:set-mute`, `track:set-solo`, `track:set-volume`, `track:set-pan` |

---

## 5. Build & Test (Native-Engine)

**Vorraussetzung:** Tracktion/JUCE unter `vendor/tracktion_engine` (oder `STUU_NATIVE_VENDOR_DIR` zeigt darauf).

**Sauberer Rebuild (z. B. nach Code-Änderungen in der Native-Engine):**

```bash
cd /pfad/zum/thestuu/thestuu   # inneres Monorepo-Root

rm -rf apps/native-engine/build

export STUU_NATIVE_VENDOR_DIR="$(pwd)/vendor/tracktion_engine"
cmake -S apps/native-engine -B apps/native-engine/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DSTUU_ENABLE_TRACKTION=ON \
  -DSTUU_THIRD_PARTY_DIR="$(pwd)/vendor/tracktion_engine" \
  -DTE_ADD_EXAMPLES=OFF

cmake --build apps/native-engine/build --target thestuu-native --config Release
```

**App starten (nutzt dieselbe Binary):**

```bash
export STUU_NATIVE_VENDOR_DIR="$(pwd)/vendor/tracktion_engine"
npm run dev
```

Vor dem Test: Kein alter `npm run dev` / thestuu-Prozess mehr laufen lassen, damit die neue Binary wirklich verwendet wird.

---

## 6. Kurzfassung für „Was wurde zuletzt gemacht?“

- **UI:** Mute/Solo-Optik im Grid und an Clips; Mute-Button kräftig und nicht mitverblassend; Mute-Zeile nur am Kopf verblasst.
- **Native:** Nach Mute/Solo/Vol/Pan wird der Playback-Graph neu aufgebaut, **ohne** dass die Wiedergabe dauerhaft stoppen soll: Position und Play-Status werden gesichert, Context wird mit `freePlaybackContext()` zurückgesetzt, Graph mit `ensureContextAllocated(true)` neu erstellt, bei vorherigem Play wird Position wiederhergestellt und `play(false)` aufgerufen, damit `performPlay()` den neuen Playhead startet.
- **Offenes Problem:** Bei Nutzern stoppt die Wiedergabe beim Betätigen von Mute/Solo/Vol/Pan weiterhin; nach sauberem Rebuild und Neustart der App muss geprüft werden, ob das Verhalten bleibt oder ob die aktuelle Binary das Problem behebt.

Wenn jemand neu einsteigt: Dieses Dokument + die Tabelle in Abschnitt 4 reichen, um zu verstehen, **was** gemacht wurde, **wo** es liegt und **woran** aktuell gearbeitet wird.

---

## 7. Nächste Schritte / Weiterarbeiten

### 7.1 Sofort prüfen (Verifikation)

1. **Neue Binary wirklich im Einsatz?**
   - Alle Terminals mit `npm run dev` / `thestuu start` beenden (Ctrl+C).
   - Einmal starten: `export STUU_NATIVE_VENDOR_DIR="$(pwd)/vendor/tracktion_engine"` dann `npm run dev`.
   - Beim ersten Mute/Solo/Vol/Pan-Klick im **selben** Terminal, in dem die App läuft, nach der Zeile **`[thestuu-native] transportRebuildGraphOnly: wasPlaying=1 resume`** suchen. Wenn diese Zeile erscheint, wird der Resume-Pfad ausgeführt (siehe 7.2).

2. **Repro**
   - Play drücken, dann Mute oder Solo oder Vol/Pan ändern.
   - Erwartung: Playback läuft weiter (evtl. kurzer Glitch).
   - Wenn es trotzdem stoppt: Log-Ausgabe notieren (was steht bei `transportRebuildGraphOnly`?) und in 7.3 gehen.

### 7.2 Debug-Logging (bereits eingebaut)

In **`tracktion_backend_tracktion.cpp`** in **`transportRebuildGraphOnlyImpl()`** steht Ausgabe auf **stderr**:

- `wasPlaying=0` → Wiedergabe war aus; es wird kein Resume versucht (erwartet).
- `wasPlaying=1 resume` → Wiedergabe war an; free → rebuild → setPosition → play wurden ausgeführt. Wenn danach trotzdem Stopp kommt, liegt das Problem eher in Tracktion (z. B. Timer oder performPlay).

Die Logs erscheinen im **Terminal**, in dem du `npm run dev` gestartet hast (der Native-Prozess gibt dort aus).

### 7.3 Wenn es weiterhin stoppt (mögliche nächste Schritte)

- **Timer-Verhalten:** In Tracktion prüft ein Timer periodisch `isPlaying() && !playHeadWrapper->isPlaying()` und ruft dann `stop()`. Mögliche Idee: Nach unserem `play(false)` den Playhead explizit einen Tick warten lassen oder prüfen, ob Tracktion eine API hat, die „Playhead starten, ohne Stop zu erlauben“ garantiert.
- **performPlay() direkt aufrufen:** Derzeit lösen wir `performPlay()` nur indirekt über `play(false)` (ValueTree-Listener) aus. Theoretisch könnte man in der Native-Engine nach dem Rebuild gezielt die gleiche Logik wie in `performPlay()` aufrufen (Position setzen, Playhead starten) – erfordert aber Zugriff auf interne TransportControl-API oder Duplikation von Logik.
- **Alternative: Rebuild ohne freePlaybackContext:** Statt Context zu zerstören, nur den Graph neu aufbauen und den **Playhead** des bestehenden Contexts neu starten (z. B. nur `postPlay()` + State setzen), ohne `playingFlag` zu clearen. Bisher hat das nicht gereicht, weil `performPlay()` mit gesetztem Flag nichts macht – aber in Kombination mit explizitem Start des Playheads (falls API vorhanden) könnte es einen anderen Weg geben.

### 7.4 Dokumentation aktuell halten

- Wenn sich am Ablauf in **`transportRebuildGraphOnlyImpl()`** etwas ändert (z. B. anderes API-Nutzung, neues Logging): Abschnitt **2.4** und **4** (Tabellenzeile „Rebuild ohne Stop“) anpassen.
- Wenn das Problem behoben ist: In **Abschnitt 3** kurz vermerken („Behoben mit …“) und in **7.1/7.3** den Status aktualisieren.
