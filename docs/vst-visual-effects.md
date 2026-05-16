# VST Visual Effects

Stand: 2026-02-23

## Ziel

Dieses Dokument beschreibt das TheStuu-Konzept fuer intuitive, audioreaktive Effekt-Visualisierungen direkt im Plugin-Fenster (JUCE/VST Host-Seite), inspiriert von dem "gleiche Basis + pro Effekt sichtbare Transformation"-Prinzip (wie im Referenzbild mit dem Hund).

Zielgruppe:

- User ohne Musiktheorie / Technik-Hintergrund
- User, die schneller verstehen wollen, was ein Effekt macht
- User, die schneller auswaehlen und mit mehr Spass arbeiten wollen

Nicht-Ziel:

- 1:1 Nachbau fremder Plugin-Designs
- Ersetzen externer VST-UIs (vorerst)

## Festgelegte Produktentscheidungen (aus dem Briefing)

- Scope: alle Effekte aus dem Referenzbild (EQ, Delay, Distortion, Chorus, Compression, Saturation, Phaser, Limiter, Reverb, Tremolo, Vocoder)
- Ort: im Plugin selbst (nicht nur im Browser/Picker)
- Plattform: echte Plugins im TheStuu/JUCE/Tracktion-Flow
- Visuals: echtzeit-audioreaktiv
- Stil: Mix aus spielerisch + professionell
- Ziel: schneller verstehen + schneller auswaehlen + mehr Spass
- Darstellung: immer `Input vs Output` gleichzeitig
- Parameterzustaende sollen visuell sichtbar sein (nicht nur Effekt-Typ)
- Fokus fuer TheStuu-Core-Plugins (nicht Overlay ueber externe VST-UIs)

## Executive Summary

Die wichtigste Erkenntnis aus der Codebase:

- TheStuu ist bereits weit ueber "Idee" hinaus.
- Es gibt bereits hochwertige, eigene Fallback/Hero-UIs fuer `EQ`, `Chorus` und `Reverb` im nativen JUCE-Backend.
- Reverb ist bereits audioreaktiv (LevelMeter-gekoppelt, 30 Hz Animation, partielle Repaints).
- Es gibt eine globale Spectrum-Analyzer-Pipeline, aktuell als MVP auf Master/Post.

Das bedeutet:

- Wir muessen das System nicht neu erfinden.
- Wir sollten die bestehenden UIs in ein gemeinsames `HeroEffectEditorScaffold` ueberfuehren.
- Danach lassen sich weitere Effekte konsistent und performant ausrollen.

## Bereits vorhandene Basis in TheStuu (Codebase-Audit)

### 1) Tracktion-Core-Plugin-Katalog (kuratiert in TheStuu)

TheStuu fuehrt aktuell 10 interne Tracktion-Core-Plugins im eigenen Katalog:

- `4bandEq`, `compressor`, `reverb`, `delay`, `chorus`, `phaser`, `pitchShifter`, `lowpass`, `4osc`, `sampler`

Referenz:

- `thestuu/apps/native-engine/src/tracktion_backend_tracktion.cpp:52`
- `thestuu/apps/native-engine/src/tracktion_backend_tracktion.cpp:59`

### 2) Eigene Fallback/Hero-Editoren existieren bereits

Custom JUCE-Editoren (wenn `plugin.createEditor()` kein Fenster liefert):

- `EqualiserFallbackEditor`
- `ChorusFallbackEditor`
- `ReverbFallbackEditor`
- generischer `FallbackPluginEditor` als letztes Fallback

Referenzen:

- `thestuu/apps/native-engine/src/tracktion_backend_tracktion.cpp:362`
- `thestuu/apps/native-engine/src/tracktion_backend_tracktion.cpp:1105`
- `thestuu/apps/native-engine/src/tracktion_backend_tracktion.cpp:1880`
- `thestuu/apps/native-engine/src/tracktion_backend_tracktion.cpp:3274`
- Dispatch im Plugin-Window: `thestuu/apps/native-engine/src/tracktion_backend_tracktion.cpp:3482`

### 3) Reverb ist bereits audioreaktiv (sehr wichtige Grundlage)

Der Reverb-Fallback haengt sich an den Track-LevelMeter und berechnet daraus:

- `inputReactiveEnergy`
- `inputReactivePeakHold`
- `inputReactiveTransient`
- `inputReactiveStereoBias`

Das wird fuer die Visualisierung genutzt (Room Field, Reflections, Tail etc.).

Referenzen:

- LevelMeter-Anbindung: `thestuu/apps/native-engine/src/tracktion_backend_tracktion.cpp:2442`
- Envelope-Update: `thestuu/apps/native-engine/src/tracktion_backend_tracktion.cpp:2472`
- Reverb-Timer/Animation: `thestuu/apps/native-engine/src/tracktion_backend_tracktion.cpp:3185`

### 4) Globale Analyzer-Pipeline existiert bereits (MVP)

Es gibt eine `SpectrumAnalyzerSnapshot`-Struktur im nativen Backend.
Aktuell ist die Quelle global/master-orientiert, PRE/POST werden im MVP gespiegelt.

Referenzen:

- Analyzer-Snapshot-Datenstruktur + Kommentar: `thestuu/apps/native-engine/src/tracktion_backend.hpp:128`
- Analyzer wird in `transport.tick` payload gepusht: `thestuu/apps/native-engine/src/main.cpp:748`

### 5) Dashboard hat bereits Plugin-Meta + EQ-UX-Logik

Im Dashboard existieren bereits:

- Plugin-UI-Metadaten pro Tracktion-Plugin (`TRACKTION_PLUGIN_UI_META`)
- Token-Aliases fuer robuste Erkennung
- EQ-Analyzer-Overlay-Aufbereitung
- Easy/Pro-EQ-Inspector-UI mit Analyzer und Presets

Referenzen:

- Plugin UI Meta / Token Mapping: `thestuu/apps/dashboard/components/stuu-shell.jsx:166`
- EQ Analyzer Overlay Builder: `thestuu/apps/dashboard/components/stuu-shell.jsx:698`
- EQ Easy/Pro Inspector mit Analyzer: `thestuu/apps/dashboard/components/stuu-shell.jsx:9449`

### 6) Intuitive Sprache ist bereits Teil eurer Richtung

Es gibt bereits Plain-Language-Hints fuer generische Parameter (z. B. Threshold, Ratio, Attack, Release, Mix, Delay/Time).

Referenz:

- `thestuu/apps/native-engine/src/tracktion_backend_tracktion.cpp:329`

## Tracktion-Verfuegbarkeitscheck fuer die Effekte aus dem Referenzbild

Wichtig: Hier unterscheiden wir zwei Ebenen:

- **Tier A (Tracktion Core Effects):** dedizierte Effekt-Plugins in `plugins/effects/tracktion_*.{h,cpp}`
- **Tier B (Tracktion-Engine Built-in via AirWindows):** mitgelieferte AirWindows-Plugins, in `PluginManager` registriert

### Ergebnis-Tabelle

| Effekt (Bild) | Status in Codebase | Bewertung fuer TheStuu Core |
|---|---|---|
| EQ | Tier A vorhanden (`EqualiserPlugin`, `4bandEq`) | Sofort nutzbar, Hero-UI existiert bereits |
| Compression | Tier A vorhanden (`CompressorPlugin`) | Sofort nutzbar |
| Limiter | Kein dedizierter Tier-A-Limiter gefunden; `CompressorPlugin` ist als "Compressor/Limiter" benannt | Phase 1 als Limiter-Mode/Preset auf Compressor-UI, spaeter optional eigener TheStuu Limiter |
| Reverb | Tier A vorhanden (`ReverbPlugin`) | Sofort nutzbar, Hero-UI existiert bereits |
| Delay | Tier A vorhanden (`DelayPlugin`) | Sofort nutzbar |
| Chorus | Tier A vorhanden (`ChorusPlugin`) | Sofort nutzbar, Hero-UI existiert bereits |
| Phaser | Tier A vorhanden (`PhaserPlugin`) | Sofort nutzbar |
| Pitch Shift | Tier A vorhanden (`PitchShiftPlugin`) | Sofort nutzbar |
| Lowpass / Filter | Tier A vorhanden (`LowPassPlugin`) | Sofort nutzbar |
| Distortion | Kein dediziertes Tier-A-Plugin gefunden; viele AirWindows-Distortion-Typen vorhanden | Ueber Tier B (AirWindows) schnell moeglich oder eigener TheStuu Core bauen |
| Saturation | Kein dediziertes Tier-A-Plugin gefunden; AirWindows-Drive/Compresaturator/PurestDrive etc. vorhanden | Zunaechst Ueber Tier B, spaeter eigener TheStuu Saturation Core |
| Tremolo | Kein dediziertes Tier-A-Plugin in `plugins/effects`; `AirWindowsTremolo` vorhanden | Ueber Tier B sofort moeglich |
| Vocoder | Kein Treffer im vendored `tracktion_engine` gefunden | Muss gebaut werden (TheStuu Core) oder externes VST |

### Belege (Tier A / Tracktion Core)

Core-Plugin Klassen / XML-IDs:

- EQ `4bandEq`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/effects/tracktion_Equaliser.cpp:64`
- Compressor `compressor`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/effects/tracktion_Compressor.cpp:62`
- Reverb `reverb`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/effects/tracktion_Reverb.cpp:74`
- Delay `delay`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/effects/tracktion_Delay.cpp:42`
- Chorus `chorus`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/effects/tracktion_Chorus.cpp:29`
- Phaser `phaser`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/effects/tracktion_Phaser.cpp:28`
- PitchShifter `pitchShifter`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/effects/tracktion_PitchShift.cpp:162`
- LowPass `lowpass`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/effects/tracktion_LowPass.cpp:35`

Compressor/Limiter-Benennung im Tracktion-Plugin:

- `getPluginName() -> "Compressor/Limiter"`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/effects/tracktion_Compressor.h:27`
- Selektierbare Beschreibung `"Compressor/Limiter Plugin"`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/effects/tracktion_Compressor.h:40`

### Belege (Tier B / AirWindows Built-ins in Tracktion Engine)

AirWindows-Plugins sind im PluginManager registriert, u. a.:

- `AirWindowsCompresaturator`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/tracktion_PluginManager.cpp:140`
- `AirWindowsDrive`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/tracktion_PluginManager.cpp:167`
- `AirWindowsPurestDrive`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/tracktion_PluginManager.cpp:238`
- `AirWindowsTremolo`: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/tracktion_PluginManager.cpp:279`

AirWindows Tremolo / Distortion-nahe Typen:

- `AirWindowsTremolo` xmlType: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/airwindows/tracktion_AirWindows3.cpp:58`
- `AirWindowsTremolo` deklariert: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/airwindows/tracktion_AirWindows.h:292`
- `AirWindowsPurestDrive` xmlType: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/airwindows/tracktion_AirWindows3.cpp:17`
- `AirWindowsCompresaturator` xmlType: `thestuu/vendor/tracktion_engine/modules/tracktion_engine/plugins/airwindows/tracktion_AirWindows1.cpp:49`

### Konsequenz fuer TheStuu Core

Pragmatisch:

- `Distortion`, `Saturation`, `Tremolo` muessen **nicht sofort DSP-seitig neu gebaut** werden, wenn wir AirWindows als TheStuu-Core-Kandidaten zulassen (mit eigener TheStuu Hero-UI + Friendly Mappings).
- `Vocoder` ist in der aktuellen vendored Tracktion-Engine nicht vorhanden und muss fuer echten TheStuu-Core-Support gebaut werden.

## Warum das Referenzbild so intuitiv ist (und wie wir es serioes uebersetzen)

Das Referenzbild funktioniert als `small multiples`-System:

1. Gleiche Ausgangsfigur = stabiler mentaler Anker
2. Pro Effekt 1 dominante visuelle Idee (Ghosting, Blur, Grain, Pulsing, etc.)
3. Vergleichbarkeit auf Thumbnail-Groesse
4. Humor + Ueberzeichnung = Lernbeschleuniger

Uebersetzung in TheStuu:

- nicht memey als Haupt-UI
- aber dieselbe Logik als "visuelle Effekt-Metapher"
- plus echtes Audio-Feedback und Parameter-Mapping

## Design-Prinzipien fuer TheStuu VST Visual Effects

### 1) Immer `Input vs Output` gleichzeitig (fixe Produktentscheidung)

Jeder Hero-Editor zeigt immer zwei Ebenen:

- `Input` (Referenz / unveraendertes Signalbild)
- `Output` (veraendertes Signalbild)

Das kann je nach Effekt unterschiedlich visualisiert werden:

- nebeneinander
- davor/dahinter (Ghosting)
- uebereinander (z. B. Linien in zwei Farben)
- Split-Screen (L/R oder Dry/Wet)

### 2) Parameter muessen sichtbar im Bild "landen"

Nicht nur "schicke Animation":

- Jeder Hauptparameter veraendert ein klar erkennbares Bildmerkmal.
- User soll nach 2-3 Sekunden sagen koennen: "Aha, `Time` = mehr Abstand", "`Feedback` = mehr Wiederholungen".

### 3) Easy + Pro (bestehende TheStuu-Richtung beibehalten)

Bestehende Richtung aus `plugin-ui-recherche-und-konzept.md` bleibt gueltig:

- Easy = Alltagssprache + wenige starke Regler
- Pro = exakte Parameter + technischere Kontrolle

Referenz:

- `thestuu/docs/plugin-ui-recherche-und-konzept.md:57`

### 4) TheStuu Styleguide einhalten

UI-Chrome (Fenster, Panels, Controls) bleibt TheStuu-typisch:

- Schwarz / Weiss / Graustufen
- Farbigkeit primar im Canvas (Effektvisual)
- klare, kompakte Controls

Referenz:

- `thestuu/docs/styleguide-ui.md:8`
- `thestuu/docs/styleguide-ui.md:12`
- `thestuu/docs/styleguide-ui.md:31`

## Vorschlag: Gemeinsames System statt Einzel-Editoren

### Neues Zielobjekt: `HeroEffectEditorScaffold`

Die bestehenden EQ/Chorus/Reverb-Editoren zeigen bereits die Richtung, sind aber aktuell effect-spezifisch organisiert.
Naechster Schritt: gemeinsame Infrastruktur.

Empfohlene Schichten:

1. `HeroEffectEditorScaffold`
   - Header (Name, Easy/Pro, Hinweistext)
   - Canvas-Bereich (Input/Output)
   - Control-Bereich (Easy-Makros / Pro-Dials)
   - Preset-Bereich
   - Readout/Info-Zeile

2. `InputReactiveModel`
   - normierte Inputs fuer Visuals
   - `energy`, `peakHold`, `transient`, `stereoBias`
   - optional spaeter: band-spezifische Werte / analyzer-derived features

3. `EffectParameterAdapter`
   - robuste Param-Erkennung per ID/Name-Hints (wie im Dashboard bereits bei EQ)
   - Friendly-Namen fuer Easy-Modus
   - Default-/Range-/Double-Click-Reset

4. `EffectVisualCanvas` (pro Effekt unterschiedlich)
   - rendert die Metapher
   - nutzt Parameter + Audio-Reactive-Daten
   - partielle Repaints

5. `PresetModel`
   - musikalische Startpunkte
   - in Easy-Modus klar benannt
   - keine "theoretischen" Namen als Default

### Warum das wichtig ist

Ohne Scaffold:

- jedes neue Plugin wird ein Einzelprojekt
- Inkonsistenzen in Layout, Interaktion, Performance
- mehr Wartung

Mit Scaffold:

- schnellere Umsetzung weiterer Effekte
- konsistente Bedienung
- bessere Testbarkeit

## Signal-/Analyzer-Daten fuer Visuals: Ist-Zustand und Ausbau

### Ist-Zustand (gut genug fuer Start)

- Reverb nutzt Track-LevelMeter reaktiv (sehr gut fuer Energy/Transient/Stereo)
- Global Analyzer kommt als `transport.tick` mit (Master-orientiert)

Das reicht bereits fuer:

- Delay-Trails (an Energy/Transient gekoppelt)
- Compressor/Limiter-GR-Animationen (mit Level-Energy als Trigger)
- Phaser/Tremolo Bewegungsvisuals (rate/depth + input energy)

### Aktuelle Limitation

Analyzer ist aktuell global/master-lastig; PRE/POST sind im MVP gespiegelt:

- `preMirrorsPost = true` moeglich / erwartbar im MVP

Referenz:

- `thestuu/apps/native-engine/src/tracktion_backend.hpp:129`

### Ausbau (spaeter)

Fuer echte "Input vs Output pro Plugin" Visuals mit hoher Genauigkeit:

- per-Plugin oder per-Slot PRE/POST taps
- kleine Visual-Probes im nativen Backend (kein Full-Analyzer fuer alles)
- nur fuer offenes Plugin-Fenster aktiv

Wichtig:

- Nicht sofort global fuer alle Slots bauen (Performance)
- Demand-driven aktivieren/deaktivieren

## Effekt-Metaphern (TheStuu Visual Grammar v1)

Hinweis:

- Diese Metaphern sind absichtlich stark lesbar.
- Farben sind funktional im Canvas erlaubt, aber UI-Chrome bleibt TheStuu-neutral.
- `Input` und `Output` sind immer gleichzeitig sichtbar.

### EQ (bereits weit fortgeschritten)

Visual:

- Kurve + Nodes + Analyzer-Overlay
- `Input` (Analyzer PRE) vs `Output` (Analyzer POST) als zwei Layer

Parameter -> Bild:

- `Freq/Gain/Q` = Node Position / Breite
- Analyzer = Problemstellen / Energieverteilung

Status:

- Bereits im Dashboard-Inspector vorhanden
- Nativer Hero-Fallback fuer Tracktion EQ vorhanden

### Reverb (bereits weit fortgeschritten)

Visual:

- Room Field (Raumform)
- Reflection Meter
- Stereo Badge
- Tail Curve

Parameter -> Bild:

- `Size` = Raumgeometrie / Tail-Laenge
- `Damp` = Tail-Helligkeit / Dichte
- `Width` = Stereo-Spreizung
- `Dry/Wet` = Tail-/Mix-Gewichtung
- `Freeze` = Badge + Bewegungsverhalten

Status:

- Nativer Hero-Fallback vorhanden + audioreaktiv

### Chorus (bereits fortgeschritten)

Visual:

- Voice Field / Motion Lanes
- Modulation Wave Display
- Stereo Field

Parameter -> Bild:

- `Depth` = Auslenkung
- `Rate` = Bewegungsgeschwindigkeit
- `Width` = Stereo-Abstand / Orbit
- `Mix` = Intensitaet / Wet-Anteil

Status:

- Nativer Hero-Fallback vorhanden

### Delay (Phase 1)

Visual-Metapher:

- `Input`-Impulse links / `Output`-Ghost-Trails rechts
- Wiederholungen als sichtbar abklingende Spur
- optional PingPong: L/R alternierende Trails

Parameter -> Bild:

- `Time` = horizontaler Abstand zwischen Echos
- `Feedback` = Anzahl + Decay der Wiederholungen
- `Mix` = Sichtbarkeit der Output-Spur
- `Filter/Tone` (falls vorhanden) = Trail-Helligkeit/Weichheit

Easy-Makros (Beispiel):

- "Mehr Echo"
- "Rhythmischer"
- "Dunkler"

### Compression / Limiter (Phase 1, gemeinsame UI-Basis)

Wichtige Klarstellung:

- Tracktion liefert einen `CompressorPlugin` (als "Compressor/Limiter" benannt), aber keinen separaten dedizierten Limiter-Plugin-Typ in eurem aktuellen Core-Katalog.

Empfehlung:

- Ein gemeinsamer `Dynamics Hero Editor`
- Zwei Easy-Seiten/Presets:
  - `Compression`
  - `Limiter`

Visual-Metapher:

- Pegelverlauf trifft auf Threshold-Linie
- Gain-Reduction-Klemme / "Abfangen" sichtbar
- `Input` vs `Output` Pegelkurve gleichzeitig

Parameter -> Bild:

- `Threshold` = Eingriffslinie
- `Ratio` = Kompressions-Slope / Steilheit
- `Attack` = Ansprechkurve (Schulter)
- `Release` = Rueckfederung / Trailing
- `Output` = finaler Pegel

Limiter-View (Easy):

- ratio sehr hoch / kurzer attack / kontrollierter release
- "Spitzen abfangen" als primaere Metapher

### Phaser (Phase 1)

Visual-Metapher:

- wandernde Notches / Phasenringe im Spektrum
- `Input` statischere Referenz, `Output` sweepende Kerben

Parameter -> Bild:

- `Rate` = Sweep-Speed
- `Depth` = Notch-Auslenkung
- `Feedback/Resonance` = Ring-/Kerbenschaerfe
- `Mix` = Sichtbarkeit der Modulationsspur

Warum frueh:

- Testet den "motion"-Teil der Visual Grammar (anders als Delay/Dynamics)

### Lowpass (Phase 2)

Visual-Metapher:

- "Vorhang" / Helligkeits-Filter ueber dem Output
- Frequenz-Cutoff-Linie in mini graph

Parameter -> Bild:

- `Cutoff` = Grenzlinie
- `Resonance` = Spitze / Glow an der Cutoff-Kante

### Pitch Shifter (Phase 2)

Visual-Metapher:

- Spektral-/Waveform-Shift nach oben/unten
- Formant/Texture-Hinweis (falls vorhanden) als Farb-/Kornverschiebung

Parameter -> Bild:

- `Pitch` = vertikale Verschiebung
- `Mix` = Blend

### Distortion (Phase 3 oder AirWindows-Wrapper frueher)

Visual-Metapher:

- Transfer-Kurve + abgeflachte Wellenform + Grain
- `Input` (clean) vs `Output` (clipped/warmer)

Parameter -> Bild:

- `Drive` = Kurvenbiegung/Clipping
- `Tone` = Helligkeit/Grain
- `Mix` = Blend

Pragmatischer Start:

- AirWindows-basierte TheStuu-UI (Drive/PurestDrive/Compresaturator)
- Friendly Mappings statt rohe AirWindows-Parameterlabels

### Saturation (Phase 3 oder AirWindows-Wrapper frueher)

Visual-Metapher:

- Soft-Knee / "warm bloom" statt hartem Clip
- harmonisches Aufleuchten

Parameter -> Bild:

- `Drive` = Knee / Verdichtung
- `Color/Tone` = Spektralgewicht
- `Mix` = Blend

Pragmatischer Start:

- `AirWindowsCompresaturator`, `PurestDrive`, `Drive` als Basis testbar

### Tremolo (Phase 2/3 ueber AirWindows moeglich)

Visual-Metapher:

- Lautstaerke-Puls im Zeitband
- `Input` gleichmaessig, `Output` pulsiert

Parameter -> Bild:

- `Rate` = Pulsfrequenz
- `Depth` = Modulationstiefe
- `Shape` (falls vorhanden) = Sinus/Square-Charakter

Pragmatischer Start:

- AirWindows Tremolo mit TheStuu-Hero-UI

### Vocoder (eigener Build erforderlich)

Visual-Metapher:

- Carrier/Modulator zwei Inputs
- Bandmatrix / sprechende Spektralmaske
- `Input` (Sprachformanten) vs `Output` (synthesisiert)

Parameter -> Bild:

- `Bands` = Matrix-Aufloesung
- `Attack/Release` = Glattung/Traegheit
- `Formant/Shift` = vertikale Verschiebung
- `Mix` = Blend

Status:

- Kein Tracktion-Core / AirWindows Vocoder im vendored Code gefunden
- TheStuu Core Plugin noetig (DSP + UI)

## Phase-Plan (Empfehlung)

### Phase 0 (kurz, aber wichtig): Scaffold-Refactor

Ziel:

- Bestehende `EQ`, `Chorus`, `Reverb` Fallbacks auf gemeinsame Bausteine ausrichten
- keine Voll-Rewrites

Lieferobjekte:

- `HeroEffectEditorScaffold` (Header/Canvas/Controls/Info)
- `InputReactiveModel` (shared)
- gemeinsame UI-Utils (Panels, Dials, Presets, Labels, Glow, partial repaint helper)

Warum zuerst:

- beschleunigt die naechsten 5-8 Effekte massiv
- reduziert UI-Drift

### Phase 1 (empfohlen): `Delay + Compressor/Limiter + Phaser`

Warum diese Reihenfolge:

- Alle drei sind in eurem aktuellen Tracktion-Core-Katalog vorhanden
- Decken drei unterschiedliche Verstehensprobleme ab:
  - Zeit (`Delay`)
  - Dynamik (`Compressor/Limiter`)
  - Bewegung/Modulation (`Phaser`)
- Starker Produktwert fuer Nicht-Techniker
- "Limiter" kann sofort als Easy-Mode/Preset im Dynamics-Editor starten

Phase-1 Deliverables:

- `DelayFallbackEditor` (Hero-UI)
- `DynamicsFallbackEditor` fuer `CompressorPlugin` mit Easy-Seiten `Compression` und `Limiter`
- `PhaserFallbackEditor` (Hero-UI)
- Erweiterung des Editor-Dispatch in `NativePluginWindow::recreateEditor`

### Phase 2: `Lowpass + Pitch Shifter + Tremolo (AirWindows)`

Warum:

- Lowpass/PitchShifter komplettieren das vorhandene Tier-A-Set
- Tremolo ist per AirWindows verfuegbar und visuell leicht verstaendlich

Phase-2 Deliverables:

- `LowPassFallbackEditor`
- `PitchShifterFallbackEditor`
- `TremoloFallbackEditor` (AirWindows-Wrapper + Friendly Labels)
- Erweiterung des internen Plugin-Katalogs um kuratierte AirWindows-UIDs (wenn gewuenscht)

### Phase 3: `Distortion + Saturation` (AirWindows-first, TheStuu-core later)

Empfehlung:

- zuerst AirWindows-basierte TheStuu Hero-UIs (schnell, lernbar, shipping)
- spaeter dedizierte TheStuu-DSPs, wenn Klang/UX/Branding es erfordert

### Phase 4: `Vocoder` (TheStuu Core Build)

Noetig:

- eigener DSP-Block (Carrier/Modulator/Bandbank/Envelope Followers)
- eigener Plugin-Typ + Parameter + Hero-UI

## Umsetzung im nativen JUCE-Backend (konkret)

### 1) Editor-Dispatch erweitern

Aktuell:

- EQ / Reverb / Chorus custom
- sonst generischer `FallbackPluginEditor`

Referenz:

- `thestuu/apps/native-engine/src/tracktion_backend_tracktion.cpp:3482`

Naechster Schritt:

- weitere `dynamic_cast` branches fuer Delay/Compressor/Phaser/LowPass/PitchShifter
- spaeter AirWindows-UID/Class-Erkennung fuer Tremolo/Distortion/Saturation

### 2) Friendly Parameter Mapping standardisieren

Ihr habt bereits robuste Token-/Hint-Muster im Dashboard.
Dasselbe Prinzip sollte in JUCE-Fallbacks wiederverwendet werden:

- Parameter via ID/Name-Hints finden
- fehlende Parameter sauber degradieren (`n/a`, disabled controls)
- Friendly Texte in Easy-Modus

### 3) Audio-Reaktivitaet standardisieren

Shared Model:

- `energy`
- `peakHold`
- `transient`
- `stereoBias`
- optional `analyzerFrame`

Input-Quelle je nach Effekt:

- Reverb/Dynamics/Delay: LevelMeter reicht oft
- EQ/Filter/Phaser: Analyzer + params
- Vocoder: spaeter eigene Band-Envelope-Daten

### 4) Performance-Guardrails (muss ueberall laufen)

Beibehalten / erweitern:

- `juce::Timer` 24-30 Hz
- partielle Repaints statt Full Window
- keine Allokationen in `paint()`
- nur aktives Plugin-Fenster reaktiv rechnen
- Analyzer/Audioprobe nur bei sichtbarem Editor aktivieren (spaeter)

## UI/UX Leitplanken (TheStuu)

Aus bestehenden Docs uebernommen und konkretisiert:

- Easy/Pro in jedem Hero-Plugin
- Alltagssprache im Easy-Modus
- sofort sichtbares Feedback bei jeder Interaktion
- kompakte, rechteckige Controls im TheStuu-Chrome
- Farbigkeit primar im Effekt-Canvas, nicht im Standard-UI-Chrome

Referenzen:

- `thestuu/docs/plugin-ui-recherche-und-konzept.md:57`
- `thestuu/docs/plugin-ui-recherche-und-konzept.md:83`
- `thestuu/docs/styleguide-ui.md:10`
- `thestuu/docs/styleguide-ui.md:33`

## Offene Architekturfragen (spaeter, nicht blocker fuer Phase 1)

1. Per-Plugin PRE/POST Analyzer Taps:
   - Fuer "echtes" Input-vs-Output je Plugin waere das langfristig besser als globaler Master-Analyzer.
2. AirWindows-Kuration:
   - Welche AirWindows-Plugins werden offiziell zu "TheStuu Core Visual Effects" gezaehlt?
3. Vocoder-Scope:
   - Minimal-Vocoder (8-16 Baender) zuerst oder direkt produktreif mit mehr Baendern/Formant-Optionen?

## Konkrete Naechste Schritte (implementierbar)

1. `Phase 0` beginnen: gemeinsame Scaffold-Bausteine aus Chorus/Reverb/EQ extrahieren.
2. `DynamicsFallbackEditor` (Compressor/Limiter) bauen.
3. `DelayFallbackEditor` bauen.
4. `PhaserFallbackEditor` bauen.
5. Danach `LowPass` + `PitchShifter`.
6. Entscheiden: AirWindows-Kuration fuer Tremolo/Distortion/Saturation aktivieren oder direkt TheStuu-DSP.

## Inspiration / Referenzen (offizielle Seiten)

Diese Referenzen sind Inspirationsquellen fuer Interaktionsqualitaet, Visualisierung, Parameter-Metaphern und Lernbarkeit (nicht fuer Designkopie):

- FabFilter Pro-Q (Analyzer / direkte EQ-Interaktion)  
  https://www.fabfilter.com/help/pro-q/using/analyzing
- FabFilter Timeless (Delay-UI / Zeit- und Feedback-Denke)  
  https://www.fabfilter.com/help/timeless/using/delay
- FabFilter Pro-C (Dynamik-/GR-Visualisierung)  
  https://www.fabfilter.com/help/pro-c/using/inputoutput
- FabFilter Pro-L (Limiter-Metering/Peak-Fokus)  
  https://www.fabfilter.com/help/pro-l/using/interface
- FabFilter Pro-R (Reverb-Tail-/Raum-Visualisierung)  
  https://www.fabfilter.com/help/pro-r/using/tips
- FabFilter Saturn 2 (Distortion/Saturation + Modulationssichtbarkeit)  
  https://www.fabfilter.com/products/saturn-2-multiband-distortion-saturation-plug-in
- FabFilter Volcano 3 (Filter/Phaser-nahe Modulation + Zielvisualisierung)  
  https://www.fabfilter.com/products/volcano-3-filter-plug-in
- Cableguys DriveShaper (Transfer-Kurve / Distortion-Formgebung)  
  https://www.cableguys.com/driveshaper
- Cableguys LiquidShaper (modulierter Filter/Phaser/Bewegung + Draw/LFO-Pattern)  
  https://www.cableguys.com/liquidshaper
- Minimal Audio Cluster Delay (explizite Delay-Visualisierung + Tooltips)  
  https://www.minimal.audio/products/cluster-delay
- Soundtoys Tremolator (rhythmische Tremolo-Visual-Denke)  
  https://www.soundtoys.com/product/tremolator/
- Soundtoys PhaseMistress (Phaser-Varianten/Bewegung)  
  https://www.soundtoys.com/product/phasemistress/
- iZotope VocalSynth (Vocoder/Voice-FX Orientierung)  
  https://www.izotope.com/en/products/vocalsynth/features
- BLEASS Chorus (visuelle Chorus-Interaktion, leichter Footprint)  
  https://www.bleass.com/plugins/chorus/
- Baby Audio Crystalline (Reverb-UX / kreative, aber klare Darstellung)  
  https://babyaud.io/crystalline

## Bezug zu bestehenden TheStuu-Dokumenten

Dieses Dokument ergaenzt und konkretisiert:

- `thestuu/docs/plugin-ui-recherche-und-konzept.md`
- `thestuu/docs/styleguide-ui.md`

Der Schwerpunkt hier ist:

- konkrete technische Umsetzungsarchitektur
- Effekt-Verfuegbarkeitscheck in der Codebase
- priorisierte Rollout-Reihenfolge

