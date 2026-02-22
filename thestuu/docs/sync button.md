# Konzept: Sync Button

## Ziel
Ein neuer `Sync`-Button (neben `Zoom`) startet kuenftig einen gefuehrten Workflow, um Audio-Spuren zeitlich zu synchronisieren:
- musikalisch zum Grid/Tempo,
- relativ zu einer Referenzspur,
- oder speziell fuer Vocal-Doubles/Backings.

## Recherche-Synthese

### Logic Pro Muster
- **Groove-Track-Prinzip**: Eine Spur wird als Referenz gesetzt, andere Spuren folgen deren Timing-Charakter.
- **Flex + Quantize/Reference Track**: Timing-Korrektur erfolgt markerbasiert und nicht-destruktiv.
- **Smart Tempo + Flex & Follow**: Erst grobe Tempo-Anpassung, dann feinere zeitliche Korrektur.

### Ableton Live Muster
- **Warp Marker** als explizite Ankerpunkte fuer Timing.
- **Multiclip-Warping**: Marker koennen auf mehrere zusammengehoerende Clips gleichzeitig wirken (wichtig fuer mehrspurige Aufnahmen).
- **Track Delay**: Feinkorrektur im Millisekundenbereich fuer Micro-Timing.

### Vocal Alignment Plugin Muster
- **Guide vs Dub Workflow** (z. B. VocAlign, Revoice Pro):
  1. Guide auswaehlen,
  2. Dub/Targets auswaehlen,
  3. Prozess mit Tightness/Preset,
  4. Ergebnis committen.
- **Pattern-/Region-basiertes Alignment** (z. B. iZotope VocalSync): Ziel ist kontrollierte, reproduzierbare Ausrichtung statt blinder Quantisierung.

## Produktkonzept fuer TheStuu

### UX-Positionierung
- Der neue Button sitzt direkt neben `Zoom` in der Edit-Toolbar.
- Icon: drei horizontale Striche von links nach rechts (duenn, dick, duenn) als eindeutige Sync-Metapher.
- Klick auf `Sync` oeffnet spaeter ein `Sync Panel` (rechts oder Modal).

### Sync Panel (MVP)
1. **Scope**
- `Reference`: 1 Spur oder 1 Clip
- `Targets`: 1..n Spuren/Clips
- Option `Nur ausgewaehlte Clips`

2. **Mode**
- `Beat Sync` (Grid/Tempo-orientiert, Ableton/Smart-Tempo-Logik)
- `Reference Sync` (Groove/Guide-orientiert, Logic-Groove-Prinzip)
- `Vocal Align` (Guide/Dub-orientiert, Plugin-Workflow)

3. **Controls**
- `Strength`: Loose / Balanced / Tight
- `Max Shift (ms)`: harte Grenze gegen Artefakte
- `Preserve Starts`: Clip-Anfaenge fix lassen
- `Formant Safe` (nur Vocal Align): aggressives Strecken vermeiden

4. **Output**
- `Preview` (A/B)
- `Apply` (nicht-destruktiv)
- `Revert` pro Clip/Spur

## Technisches Umsetzungskonzept

### Datenmodell (Erweiterung pro Clip)
- `clip.sync.version` (number)
- `clip.sync.mode` (`beat` | `reference` | `vocal`)
- `clip.sync.reference_clip_id` (string | null)
- `clip.sync.offset_ms` (number)
- `clip.sync.warp_markers` (array)
- `clip.sync.confidence` (0..1)
- `clip.sync.created_at` (ISO string)

### Engine-Pipeline (MVP)
1. Onset/Transient-Erkennung fuer Reference und Targets.
2. Grobausrichtung per Cross-Correlation (Offset).
3. Feinabgleich per segmentiertem Matching (markerbasiert; optional DTW-light).
4. Constraint-Phase:
- `max_shift_ms` erzwingen,
- Startpunkte optional locken,
- Marker glatten.
5. Ergebnis als nicht-destruktive `warp_markers` + `offset_ms` speichern.

### API-Skizze
- `sync:preview` (liefert vorgeschlagene Marker/Offsets, noch kein Commit)
- `sync:apply` (persistiert Sync-Daten)
- `sync:revert` (setzt auf pre-sync Zustand zurueck)

## User Journey

### Journey A: Lead Vocal + Doubles synchronisieren
1. User markiert Lead als `Reference` und 2 Double-Spuren als `Targets`.
2. Klick auf `Sync`.
3. Mode `Vocal Align`, Strength `Balanced`, Max Shift `80 ms`.
4. `Preview` zeigt vor/nach Vergleich.
5. User hoert A/B und klickt `Apply`.
6. Falls unnatuerlich: Strength auf `Loose`, erneut `Preview`, dann `Apply`.

### Journey B: Mehrspurige Drums enger auf Groove
1. User waehlt Kick als `Reference`, Snare/Overheads als `Targets`.
2. Mode `Reference Sync`, `Preserve Starts` aktiv.
3. `Preview` pruefen (insb. Attack-Erhalt).
4. `Apply`; bei Bedarf per `Revert` einzelne Spuren zuruecknehmen.

## Akzeptanzkriterien

### UI (jetzt)
1. In der Edit-Toolbar existiert ein `Sync`-Button direkt neben `Zoom`.
2. Der Button nutzt ein eindeutiges Sync-Icon (drei horizontale Striche: duenn, dick, duenn) und hat `aria-label="Sync"`.
3. Der Button ist in derselben visuellen Button-Gruppe wie die Edit-Tools.

### Feature-MVP (naechster Schritt)
1. `Sync` oeffnet ein Panel mit `Reference`, `Targets`, `Mode`, `Strength`, `Max Shift`, `Preview`, `Apply`, `Revert`.
2. `Preview` veraendert keine persistierten Clipdaten.
3. `Apply` speichert pro betroffenem Clip `clip.sync.*` nicht-destruktiv.
4. `Revert` entfernt nur die letzte Sync-Version des gewaehlten Clips/Targets.
5. Bei fehlender Referenz oder leeren Targets wird eine klare Fehlermeldung angezeigt.
6. Bei Analysefehlern bleibt der Originalzustand unveraendert.

### Qualitaet
1. Bei `Balanced` liegt die erkannte mittlere Timing-Abweichung nach `Apply` messbar unter der Vorher-Abweichung.
2. `Max Shift` wird nie ueberschritten.
3. Undo/Redo integriert den gesamten Sync-Vorgang als atomaren Schritt.

## Quellen
- Apple Logic Pro User Guide - Groove Track: https://support.apple.com/en-ng/guide/logicpro/lgcp2158d14b/mac
- Apple Logic Pro User Guide - Flex in Arrangement: https://support.apple.com/en-ng/guide/logicpro/lgcp6635fdbf/mac
- Apple Logic Pro User Guide - Flex and Follow: https://support.apple.com/en-ng/guide/logicpro/lgcp7165a3cf/mac
- Apple Logic Pro User Guide - Smart Tempo: https://support.apple.com/en-ng/guide/logicpro/lgcp4f103162/mac
- Ableton Live Manual - Audio Clips, Tempo, and Warping: https://www.ableton.com/en/live-manual/11/audio-clips-tempo-and-warping/
- Ableton Live Manual - Mixing (Track Delay): https://www.ableton.com/en/live-manual/11/mixing/
- Ableton Help - Recording in sync: https://help.ableton.com/hc/en-us/articles/209072409-Recording-in-sync-with-Live
- Synchro Arts VocAlign Project 6 - Quick Start: https://www.synchroarts.com/manuals/VocAlignProject/quick_start.html
- Synchro Arts Revoice Pro 5 - Quick Start: https://www.synchroarts.com/manuals/RevoiceProV5/QuickStart.php
- iZotope VocalSync 2 - User Guide: https://s3.amazonaws.com/izotopedownloads/docs/vocalsync2/en/index.html
