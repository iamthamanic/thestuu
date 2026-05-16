# TheStuu TODO

## Playlist + Drum Sequencer MVP

Stand: 2026-02-20

1. [x] T1: `.stu` Schema fuer Patterns erweitern
- Ziel: Echtes Drum-/MIDI-Pattern-Modell statt nur `pattern: "midi_p1"`.
- Dateien: `packages/shared-json/src/index.js`
- Akzeptanz: `project.patterns[]` mit `id`, `type`, `length`, `steps`/`notes`; Validator prueft Struktur; bestehende Projekte bleiben kompatibel.

2. [x] T2: Engine-Events fuer Pattern-CRUD
- Ziel: Socket-API fuer `pattern:create`, `pattern:update-step`, `pattern:delete`.
- Dateien: `apps/engine/src/server.js`
- Akzeptanz: Aenderungen werden an alle Clients via `engine:state` gepusht; invalid payloads werden abgefangen.

3. [x] T3: Engine-Events fuer Playlist-Clip-Editing
- Ziel: `clip:create`, `clip:move`, `clip:resize`, `clip:delete`.
- Dateien: `apps/engine/src/server.js`
- Akzeptanz: Clips pro Track sind editierbar (Start/Laenge/Pattern-ID), inklusive Snap auf Takt (z. B. 1/16).

4. [x] T4: Edit-Tab auf echte Timeline umbauen
- Ziel: Statt Track-Karten eine horizontale Takt-Ansicht mit Grid + Clips.
- Dateien: `apps/dashboard/components/stuu-shell.jsx`, `apps/dashboard/app/globals.css`
- Akzeptanz: Sichtbares Bar/Grid, Track-Rows, Clip-Bloecke an `start/length` positioniert.

5. [x] T5: Clip-Interaktion (Drag/Resize)
- Ziel: Playlist benutzbar machen.
- Dateien: `apps/dashboard/components/stuu-shell.jsx`
- Akzeptanz: Clip draggt/resized per Maus, sendet Socket-Events, Zustand bleibt nach Reconnect korrekt.

6. [x] T6: Drum-Sequenzer UI (MVP)
- Ziel: 16-Step-Grid mit typischen Lanes (Kick/Snare/CH/OH/Clap).
- Dateien: `apps/dashboard/components/stuu-shell.jsx`, `apps/dashboard/app/globals.css`
- Akzeptanz: Step-Toggle klickbar, aktives Pattern auswaehlbar, visuelles Playhead-Feedback.

7. [x] T7: Pattern-Inspector
- Ziel: Rechtes Inspector-Panel mit editierbaren Pattern-Parametern statt reinem JSON.
- Dateien: `apps/dashboard/components/stuu-shell.jsx`
- Akzeptanz: Laenge, Swing (optional), Step-Velocity (mind. 2 Stufen) editierbar.

8. [x] T8: Transport-Position/Playhead-Event
- Ziel: Timeline und Sequencer synchron zur Engine-Zeit.
- Dateien: `apps/engine/src/server.js`, `apps/dashboard/components/stuu-shell.jsx`
- Akzeptanz: `engine:transport` (bar/beat/step), Playhead bewegt sich im Edit-Tab + Sequencer.

9. [x] T9: Save/Load Roundtrip absichern
- Ziel: Keine Datenverluste bei Patterns/Clips.
- Dateien: `packages/shared-json/src/index.js` (+ Tests in `packages/shared-json`)
- Akzeptanz: `serialize -> parse` Roundtrip fuer neue Felder stabil.

10. [x] T10: MCP-Tool-Vertraege als Vorbereitung
- Ziel: AI-ready Schnittstellen laut Konzept (`create_pattern`, `move_midi_note` etc.).
- Dateien: `apps/engine/src/server.js`, optional `apps/cli`
- Akzeptanz: Tool-kompatible Events existieren; Chat kann sie vorerst mocken, API steht.

## Umsetzungsreihenfolge

`T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> T8 -> T7 -> T9 -> T10`
