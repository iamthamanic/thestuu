# Node Mixer Konzept fuer Edit-Tab

## Zweck
Dieses Dokument beschreibt den aktuellen Stand der Node-Mixer-Funktionalitaet rund um den Edit-Tab, den Bezug zum Mix-Tab, die vorhandenen Bausteine und die offenen Luecken.

## Scope
Dieses Konzept deckt ab:
1. Track-Mix-Controls in Edit und Mix.
2. Node-Kette pro Track (VST-Slots, Reihenfolge, Bypass, Remove, Add).
3. Datenfluss von UI nach Engine.
4. UX-Zielbild fuer "Edit als Quelle, Mix als vollwertiger Mixer".

Dieses Konzept deckt nicht ab:
1. Vollstaendiges Routing-System mit Sends/Bussen.
2. Neue Audio-DSP-Architektur.
3. Plugin-GUI-Embedding im Mixer.

## Ist-Zustand (was bereits da ist)

### A) Navigation und Grundstruktur
1. Es gibt aktuell genau zwei DAW-Tabs: `Edit` und `Mix`.
2. Beide Tabs arbeiten auf denselben Projektdaten (`playlist`, `mixer`, `nodes`).

Referenzen:
1. `apps/dashboard/components/stuu-shell.jsx:33`
2. `apps/dashboard/components/stuu-shell.jsx:1525`

### B) Datenmodell fuer Mixer und Nodes
1. Default-Mixerwerte sind definiert (`volume`, `pan`, `mute`, `solo`, `record_armed`).
2. Projekt-JSON enthaelt `mixer` und `nodes` als zentrale Arrays.
3. Frontend normalisiert Mixer-Eintraege robust.
4. Engine erstellt fehlende Mixer-Eintraege automatisch pro Track.

Referenzen:
1. `packages/shared-json/index.js:29`
2. `packages/shared-json/index.js:52`
3. `apps/dashboard/components/stuu-shell.jsx:751`
4. `apps/dashboard/components/stuu-shell.jsx:762`
5. `apps/engine/src/server.js:320`
6. `apps/engine/src/server.js:353`

### C) Edit-Tab: Mini-Mixer pro Track
1. Jede Track-Row im Edit-Tab hat bereits Mute, Solo, Record Arm.
2. Volume ist als Slider plus dB-Feld vorhanden.
3. Pan ist als Slider plus Prozentfeld vorhanden.
4. Pegelanzeige pro Track ist vorhanden.

Referenzen:
1. `apps/dashboard/components/stuu-shell.jsx:4569`
2. `apps/dashboard/components/stuu-shell.jsx:4573`
3. `apps/dashboard/components/stuu-shell.jsx:4611`
4. `apps/dashboard/components/stuu-shell.jsx:4638`
5. `apps/dashboard/components/stuu-shell.jsx:4485`
6. `apps/dashboard/app/globals.css:1002`
7. `apps/dashboard/app/globals.css:942`

### D) Edit-Tab: Node-Kette pro Track
1. Pro Track werden VST-Nodes gruppiert und nach `plugin_index` sortiert.
2. In der Track-Row gibt es eine kompakte Slot-Ansicht.
3. Slot-Aktionen sind vorhanden: Add, Select, Bypass, Remove, Reorder.
4. Effektkette kann trackweise aktiviert/deaktiviert werden.
5. Es gibt ein Node-Modal pro Track mit vertikaler Slot-Liste.

Referenzen:
1. `apps/dashboard/components/stuu-shell.jsx:1769`
2. `apps/dashboard/components/stuu-shell.jsx:1770`
3. `apps/dashboard/components/stuu-shell.jsx:4675`
4. `apps/dashboard/components/stuu-shell.jsx:4716`
5. `apps/dashboard/components/stuu-shell.jsx:4734`
6. `apps/dashboard/components/stuu-shell.jsx:4757`
7. `apps/dashboard/components/stuu-shell.jsx:4769`
8. `apps/dashboard/components/stuu-shell.jsx:3326`
9. `apps/dashboard/components/stuu-shell.jsx:5150`
10. `apps/dashboard/components/stuu-shell.jsx:5209`
11. `apps/dashboard/app/globals.css:1291`

### E) Mix-Tab: FL-aehnliche Strip-Bank + Inspector
1. Mix-Tab hat eine horizontale Strip-Bank inkl. Master-Strip links.
2. Jeder Strip zeigt M/S/R, Pan, Fader, Meter und Slot-Statuspunkte.
3. Rechts gibt es einen Track-Inspector mit detaillierter Node-Slot-Liste.
4. Im Inspector sind Add, Bypass, Remove und Reorder aktiv.

Referenzen:
1. `apps/dashboard/components/stuu-shell.jsx:5528`
2. `apps/dashboard/components/stuu-shell.jsx:5540`
3. `apps/dashboard/components/stuu-shell.jsx:5590`
4. `apps/dashboard/components/stuu-shell.jsx:5657`
5. `apps/dashboard/components/stuu-shell.jsx:5677`
6. `apps/dashboard/components/stuu-shell.jsx:5765`
7. `apps/dashboard/components/stuu-shell.jsx:5795`
8. `apps/dashboard/components/stuu-shell.jsx:5824`
9. `apps/dashboard/app/globals.css:2884`
10. `apps/dashboard/app/globals.css:3273`

### F) Mutationen und Sync UI -> Engine
1. Frontend patched Mixerwerte lokal optimistisch und sendet danach Socket-Mutation.
2. Engine-Events fuer Track-Mix sind vorhanden (`track:set-volume/pan/mute/solo/record-arm`).
3. VST-Events sind vorhanden (`vst:add/remove/reorder/bypass:set/param:set`).
4. `showTrackNodes` wird als View-State persistiert.

Referenzen:
1. `apps/dashboard/components/stuu-shell.jsx:2916`
2. `apps/dashboard/components/stuu-shell.jsx:2955`
3. `apps/dashboard/components/stuu-shell.jsx:2963`
4. `apps/dashboard/components/stuu-shell.jsx:2994`
5. `apps/dashboard/components/stuu-shell.jsx:3001`
6. `apps/dashboard/components/stuu-shell.jsx:3008`
7. `apps/dashboard/components/stuu-shell.jsx:3256`
8. `apps/dashboard/components/stuu-shell.jsx:3332`
9. `apps/dashboard/components/stuu-shell.jsx:3344`
10. `apps/dashboard/components/stuu-shell.jsx:3309`
11. `apps/dashboard/components/stuu-shell.jsx:3287`
12. `apps/dashboard/components/stuu-shell.jsx:2276`
13. `apps/engine/src/server.js:2223`
14. `apps/engine/src/server.js:2239`
15. `apps/engine/src/server.js:2255`
16. `apps/engine/src/server.js:2270`
17. `apps/engine/src/server.js:2285`
18. `apps/engine/src/server.js:2688`
19. `apps/engine/src/server.js:2756`
20. `apps/engine/src/server.js:2811`
21. `apps/engine/src/server.js:2859`
22. `apps/engine/src/server.js:2895`
23. `apps/engine/src/server.js:2577`

## Gap-Liste (was noch fehlt)

### P0 (kritisch)
1. Echtes Metering aus Native-Engine fehlt.
2. Bei aktivem Native-Transport liefert Engine aktuell fuer Meter `peak: 0, rms: 0`.
3. Ohne Native-Transport werden Meter simuliert per Zufall.
4. Die vorhandene "Node"-Tab-Restlogik sollte entfernt werden, da nur Edit/Mix aktiv sind.

Referenzen:
1. `apps/engine/src/server.js:3133`
2. `apps/engine/src/server.js:3138`
3. `apps/dashboard/components/stuu-shell.jsx:3385`

### P1 (wichtig)
1. Mix-Strip zeigt Node-Slots nur als Punkte, nicht als direkt bedienbare vertikale Kette.
2. Detaillierte Node-Bedienung liegt aktuell nur im rechten Inspector oder im Node-Modal.
3. Edit und Mix nutzen teils doppelte UI-Logik fuer dieselben Mix-Operationen.
4. Master-Strip ist funktional noch statisch (`0.0 dB`, `1-2`) und nicht als echter Routing-Kanal modelliert.

Referenzen:
1. `apps/dashboard/components/stuu-shell.jsx:5657`
2. `apps/dashboard/components/stuu-shell.jsx:5765`
3. `apps/dashboard/components/stuu-shell.jsx:5548`
4. `apps/dashboard/components/stuu-shell.jsx:5549`

### P2 (qualitativ)
1. Einheitliche Fehlermeldungsstrategie fuer alle Slot-Aktionen ist ausbaufaehig.
2. Keyboard-Flow und Accessibility fuer Drag/Reorder koennen verbessert werden.
3. Visuelle Konsistenz zwischen Edit-Track-Mix und Mix-Inspector kann weiter harmonisiert werden.

## Zielbild fuer "Node Mixer im Edit-Kontext"
1. Edit bleibt die Produktionsansicht mit kompaktem Mini-Mixer und schneller Track-Node-Interaktion.
2. Mix bleibt die Hauptmixer-Ansicht mit FL-aehnlicher Strip-Bank und Fokus auf Balancing.
3. Dieselbe Node-Engine bleibt Quelle der Wahrheit in beiden Ansichten.
4. Node-Signalfluss wird top-down lesbar im Mix-Inspector gefuehrt und darf optional pro Strip staerker sichtbar werden.
5. Alle Aktionen muessen in Edit und Mix identisch reagieren, da sie dieselben Mutationen nutzen.

## User Journey (Edit-zentriert)

### Journey 1: Track im Edit vorbereiten
1. User waehlt Track in Edit.
2. User setzt Mute/Solo/Record Arm sowie Pan/Volume im Mini-Mixer.
3. User sieht sofortige Rueckmeldung im Track und in der Engine-Session.

### Journey 2: Node-Kette direkt im Edit anpassen
1. User nutzt die Track-Chain-Slots in der Row.
2. User fuegt Plugin hinzu oder oeffnet bestehendes Plugin.
3. User schaltet Bypass, entfernt Plugin oder ordnet Slots neu.

### Journey 3: Detailliertes Chain-Editing
1. User oeffnet Node-Modal fuer den Track.
2. User bearbeitet die vertikale Slot-Liste mit denselben Aktionen.
3. Aenderungen sind sofort in Mix-Inspector und Strip-Status sichtbar.

### Journey 4: Uebergang in Mix fuer Feintuning
1. User wechselt in Mix.
2. Der gleiche Track ist selektiert und zeigt konsistente Werte.
3. User macht Feintuning an Fader/Pan und Node-Slots im Inspector.
4. Rueckwechsel zu Edit zeigt dieselben finalen Werte.

## Umsetzungsleitplanken (ohne Code in diesem Schritt)
1. Kein neues Mixer-Datenmodell bauen, solange `mixer` + `nodes` ausreichen.
2. Komponentenharmonisierung priorisieren, statt parallele UI-Varianten weiter auszubauen.
3. Native-Metering als Grundlage fuer glaubwuerdiges Mixer-Feedback priorisieren.
4. Legacy-Reste (`activeTab === 'Node'`) entfernen.

## Abnahmekriterien
1. Jede Mixer-Aktion verhaelt sich in Edit und Mix identisch.
2. Node-Reihenfolge bleibt nach Reorder stabil ueber Save/Reload.
3. Meter reagieren live und nachvollziehbar im Mix.
4. Nutzer kann komplette Chain-Bearbeitung ohne Kontextbruch zwischen Edit und Mix ausfuehren.

## Bisherige Dokumentation im Repo
1. Vorhanden: `docs/konzept-fuer-mixer.md`.
2. Weitere dedizierte Konzeptdatei zum Node-Mixer fuer den Edit-Tab gab es vorher nicht.
