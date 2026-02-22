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
