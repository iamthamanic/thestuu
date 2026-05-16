# AGENTS.md

## Pflichtvorgabe: UI-Stil

Ab sofort gilt fuer alle Agent-Aenderungen in diesem Repo:

1. UI- und UX-Aenderungen muessen den Styleguide in `docs/styleguide-ui.md` einhalten.
2. Der Stil ist app-weit verbindlich (`Edit`, `Node`, `Mix`, Inspector, Chat, neue Views): modern schwarz/weiss.
3. Farbige Defaults oder abweichende Designsprachen sind nur erlaubt, wenn der User sie explizit verlangt.
4. Bei Unsicherheit hat `docs/styleguide-ui.md` Vorrang.

## Pflichtvorgabe: Icons

5. **Alle UI-Icons aus Lucide React:** Buttons, Toolbars, Status und vergleichbare Elemente verwenden ausschliesslich Icons aus der Bibliothek `lucide-react` (siehe `docs/styleguide-ui.md`, Abschnitt 6). Keine ad-hoc SVG-Icons einfuehren; bei neuen Features passende Lucide-Icons waehlen, damit das Erscheinungsbild einheitlich bleibt.

## Pflichtvorgabe: Edit-Layout

1. Pattern-Browser bleibt entfernt.
2. Track/Grid-Aufteilung orientiert sich an der FL-Playlist.
3. Track 1 behaelt den primaren `+`-Button fuer Pattern/Clip-Erstellung.

## Pflichtvorgabe: DAW-Zustand (Single Source of Truth)

**Autoritativ:** `apps/native-engine` (Tracktion) fuer Timeline, Transport, Tracks, Clips, Mixer, Plugins, DAW-Undo/Redo und DAW-Projekt-Persistenz.

**Node (`apps/engine`):** Nur API/WebSocket/IPC-Router, Prozess-Management, AI/Cloud/Metadaten, Plugin-Cache, read-only letzter Native-Snapshot, Logs. **Kein zweites beschreibbares DAW-Modell.**

**Dashboard (`apps/dashboard`):** Rendert Native-bestätigten State. Optimistic UI beim Drag ist erlaubt; nach Response/Event **reconcilen**.

### Reihenfolge bei DAW-Aenderungen

1. Command in `packages/protocol` oder `docs/native-ipc.md` definieren/erweitern
2. In `apps/native-engine` implementieren + Snapshot/Event emittieren
3. In `apps/engine` nur forwarden (kein `state.project` fuer DAW-Logik mutieren)
4. Dashboard an bestätigtem State ausrichten

Migration inkrementell: Transport → Clips → Tracks → Mixer → Plugins → Save/Load → Undo/Redo.

### Verboten (neuer Code in Node)

- `state.project.playlist` / Clips / Mixer fuer DAW-Operationen mutieren
- `projectHistory` fuer Tracks/Clips/Mixer/Plugins erweitern
- Neue Sync-Strategien via `syncNativeArrangementFromPlaylist` / `edit:clear-audio-clips`
- Fake-Transport bei Native-Ausfall — UI zeigt Engine offline

### Erlaubt in Node

HTTP/WebSocket, IPC, Prozess-Start, AI, Cloud, Import-Vorbereitung, Metadaten, read-only Cache, Logging.

### Legacy (Uebergang)

Native-first flags are **opt-in** (`STUU_NATIVE_*=1`). Without flags, legacy JSON + `syncNativeArrangementFromPlaylist` still runs.

`state.project` = reconciled **cache/sidecar** (patterns, view, UI). `projectHistory` = JSON undo for legacy/pattern only — disabled for arrangement when any native DAW flag is on.

Do not mutate tracks/clips/mixer/timeline in JSON when native flags are enabled; `assertLegacyJsonArrangementAllowed` guards the legacy clip path.

**Details:** `docs/architecture-state-authority.md` · **Refactor-Plan:** `docs/refactor-plan-daw-authority.md` · **IPC:** `docs/native-ipc.md` · **Cursor-Regel:** `.cursor/rules/daw-state-authority.mdc`
