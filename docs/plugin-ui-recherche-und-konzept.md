# Plugin UI Recherche und Konzept

## Ziel

Wir wollen Plugin-Interfaces in TheStuu so intuitiv machen, dass auch User ohne Musiktheorie und ohne technische Audio-Begriffe schnell gute Ergebnisse erzielen.

Konkret:

- Effektfenster sollen immer aufgehen, wenn ein Slot geklickt wird.
- Core-Effekte sollen visuell und bedienbar auf Premium-Niveau wirken.
- Der Equalizer soll in der Bedienlogik klar an FabFilter Pro-Q angelehnt sein (ohne 1:1 Copy).

---

## Recherche-Ergebnis: Gibt es eine Lib, die das automatisch macht?

Kurz: **Nein**.

Es gibt keine Library, die aus Tracktion-Core-Effekten automatisch eine fertige "FabFilter/Logic/iZotope"-UI generiert.

Was es gibt:

- JUCE `GenericAudioProcessorEditor`: generische Parameterliste (Slider/Buttons), funktional aber nicht Premium-UX.
- `foleys_gui_magic`: GUI-Builder fuer JUCE, hilft beim schnellen Bauen und Parameter-Binding.
- `chowdsp_utils` (`EqualizerPlot`): guter Baustein fuer moderne EQ-Visualisierung.
- `iPlug2` / `VSTGUI`: Plugin-Frameworks fuer Plugin-Entwicklung, kein Drop-in fuer unseren Host-Flow.

Fazit:

- Externe VSTs koennen ihre eigene UI mitbringen.
- Fuer Tracktion-Core-Effekte muessen wir die UI in TheStuu selbst bauen (mindestens als Fallback-UI, spaeter Premium-UI).

---

## Aktueller Stand in TheStuu (technisch)

- Der Klick auf belegte FX-Slots ist bereits auf `vst:editor:open` verdrahtet.
- Fuer Plugin-Fenster wurde im Native-Backend eine eigene `UIBehaviour` + Window-Bridge eingebaut.
- Problem bei Core-Effekten bleibt: Wenn kein Editor erzeugt wird, gibt es kein Fenster.

Relevante Stellen:

- `apps/dashboard/components/stuu-shell.jsx`
- `apps/engine/src/server.js`
- `apps/native-engine/src/main.cpp`
- `apps/native-engine/src/tracktion_backend_tracktion.cpp`
- `vendor/tracktion_engine/modules/tracktion_engine/plugins/effects/tracktion_Equaliser.h`
- `vendor/tracktion_engine/modules/tracktion_engine/plugins/tracktion_Plugin.h`

Interpretation:

- Externe Plugins: meist echte UI verfuegbar.
- Core-Effekte: DSP + Parameter da, aber kein fertiges Editorfenster im aktuellen Flow.

---

## UX-Strategie fuer Nicht-Techniker

### 1) Zwei Ebenen: Easy und Pro

- **Easy-Modus**:
  - Sprache in Alltagssprache: "Mehr Klarheit", "Weniger Scharf", "Mehr Druck".
  - Nur wenige starke Controls.
  - Tooltips erklaeren Wirkung in 1 Satz.
- **Pro-Modus**:
  - Frequenz/Hz, Gain/dB, Q, Slope, Mid/Side, Dynamic.
  - Volle Kontrolle fuer fortgeschrittene User.

### 2) Direktmanipulation statt Fachmenues

- Punkte im EQ-Graph direkt ziehen.
- Scroll/Wheel aendert Q.
- Modifier (z. B. Alt/Shift) fuer feinere Kontrolle.
- Doppelklick erzeugt Band, Rechtsklick oeffnet Band-Menue.

### 3) Kontext statt Theorie

- Vorschlaege anhand Signalverhalten:
  - "Mumpf reduzieren" (z. B. Low-Mid-Cut Vorschlag)
  - "Vocal klarer" (Praesenzbereich hervorheben)
- Visuelle Hinweise fuer Problemstellen (Resonanzen/Masking).

### 4) Permanente Rueckmeldung

- Spectrum Analyzer live.
- Delta/Hear-What-Changed Funktion.
- Bypass pro Band und global.
- Undo/Redo fuer schnelle Experimente.

---

## Equalizer-Konzept (Pro-Q-inspiriert, TheStuu-Style)

### Kerninteraktionen

- Bis zu N Baender als Nodes im Graph.
- Band-Typen: Bell, Shelf, High/Low Cut, Notch, Tilt.
- Dynamic pro Band (optional).
- Solo pro Band (zum "hoeren wo ich schneide").
- Analyzer + Peak-Grab Workflow.

### Easy View (Default)

- Vorlagen:
  - Clean Up
  - Vocal Klarheit
  - Bass Tight
  - Air/Brillanz
- Regler mit Wirkung statt Theorie:
  - "Weniger dumpf"
  - "Mehr Praesenz"
  - "Weicher"
- Optionaler "Auto-Hinweis":
  - markiert 1-3 Frequenzbereiche als Startpunkt.

### Pro View

- Voller Band-Editor rechts:
  - Freq, Gain, Q, Slope, Dyn Amount, Channel Mode.
- Multi-Band-Selection.
- M/S oder L/R pro Band.
- Optionales "Collision/Masking"-Overlay (spaeter Phase).

### Wichtig

- Keine visuelle 1:1 Kopie von FabFilter.
- Gleiche Bedienqualitaet und Geschwindigkeit, aber eigene TheStuu-Designsprache.

---

## Architektur-Vorschlag

### Phase 1: Immer editierbar

- Wenn Plugin-Editor nicht verfuegbar:
  - TheStuu Parameter-Window als Fallback oeffnen.
- Basis-Komponenten:
  - Knob/Slider, Toggle, Dropdown, Value-Readout.

### Phase 2: EQ Hero-UI

- Eigener EQ-Screen mit Graph + Nodes + Analyzer.
- Parameter-Mapping auf bestehende Tracktion-Parameter.
- Easy/Pro Umschaltung.

### Phase 3: Weitere Premium-Effekte

- Compressor UI.
- Reverb UI.
- Delay UI.

### Phase 4: Assistenz

- Smart Hints (signalbasiert).
- Presets + "Why this suggestion?" Erklaerung.

---

## Risiken und Leitplanken

- Premium-UI kostet Zeit: zuerst generischer Fallback, dann Hero-EQ.
- Performance: Analyzer/GPU effizient halten.
- Accessibility: Kontraste, Keyboard, klare Labels.
- Produktrechtlich: keine 1:1 Designkopie fremder GUIs.

---

## Konkrete Empfehlung

1. Sofort: generische Fallback-UI fuer alle Core-Effekte.
2. Danach: eigener "TheStuu EQ" als erstes Premium-Plugin.
3. Danach: gleiche UX-Logik auf Compressor/Reverb uebertragen.

So haben wir schnell nutzbare Funktion und bauen parallel die Premium-Experience auf.

---

## Quellen

- JUCE Generic AudioProcessor Editor  
  https://docs.juce.com/master/classjuce_1_1GenericAudioProcessorEditor.html

- foleys_gui_magic (GUI Builder fuer JUCE)  
  https://github.com/ffAudio/foleys_gui_magic

- chowdsp_utils (u. a. `EqualizerPlot`)  
  https://github.com/Chowdhury-DSP/chowdsp_utils

- iPlug2 Framework  
  https://github.com/iPlug2/iPlug2
  https://iplug2.github.io/

- FabFilter Pro-Q 3 Feature-News  
  https://www.fabfilter.com/news/1543478400/fabfilter-releases-fabfilter-pro-q-3-equalizer-plug-in-with-dynamic-eq

- Logic Pro Channel EQ (Apple Support)  
  https://support.apple.com/en-tm/guide/logicpro/lgcpbc219e52/mac

- iZotope Neutron Equalizer Features  
  https://www.izotope.com/en/products/neutron/features/equalizer
