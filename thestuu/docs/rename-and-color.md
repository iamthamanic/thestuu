# Konzept: RENAME AND COLOR

## Ziel
Pro Audioclip Namen und Farbe direkt aus dem Clip-Dropdown ändern („RENAME AND COLOR“). Keine externe API – nur App-State und UI.

## Nutzen
- Übersichtliche Arrangements (z. B. „Verse Vocals“, „Chorus Drums“).
- Farbige Clips für Kategorien (z. B. nach Instrument, Sektion).
- Entspricht FL Studio / Logic „Rename and Color“ bzw. Clip-Properties.

## Datenmodell (Playlist / Clip)
- `clip.name` (optional, string): Anzeigename. Falls nicht gesetzt, wird weiterhin aus Dateiname o. ä. abgeleitet.
- `clip.color` (optional, string): Farbe für die Clip-Darstellung.  
  - Empfehlung: Hex (z. B. `#3b82f6`) oder vordefinierte Token (z. B. `blue`, `green`) für DaisyUI/Tailwind-Konsistenz.

## UI
- Menüpunkt „RENAME AND COLOR“ öffnet ein kleines Modal oder Inline-Bereich mit:
  - **Name:** Textfeld (vorausgefüllt mit aktuellem Clip-Namen oder Dateiname).
  - **Farbe:** Farbpicker oder feste Palette (z. B. 8–12 Farben wie in FL Studio).
- Buttons: „Übernehmen“, „Abbrechen“.

## Engine / Mutations
- **clip:rename** (oder erweitert **clip:set-properties**):  
  Payload: `{ trackId, clipId, name?, color? }`.  
  Engine aktualisiert in `state.project.playlist` den entsprechenden Clip und pusht State an alle Clients.
- Kein Aufruf der Native-Engine nötig (nur Darstellung); Sync wie gewohnt für Arrangement, keine Änderung an Audio-Pfad oder -Länge.

## Darstellung im UI
- **Name:** Wird in der Clip-Label-Bar (`timeline-clip-label`) angezeigt; falls `clip.name` gesetzt, diesen nutzen, sonst Fallback (z. B. Dateiname).
- **Farbe:** Clip-Hintergrund oder linke Randfarbe (z. B. `border-left` oder `background` mit niedriger Sättigung/Transparenz), definiert in `stuu-shell.jsx` und `globals.css` (z. B. `--clip-color` oder Klasse pro Farbe).

## Fehlerbehandlung
- Leerer Name: Erlaubt oder Fallback auf Dateiname – Konvention festlegen.
- Ungültige Farbe: Auf Default zurücksetzen oder eine der vordefinierten Farben verwenden.

## Offene Punkte
- Vordefinierte Farbpalette (wie FL) oder freier Farbpicker?
- Sollen Name/Farbe auch in Projektdatei (.stu) persistiert werden? (Vermutlich ja – Playlist ist Teil des Projekts.)
