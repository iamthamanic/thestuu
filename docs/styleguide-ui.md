# TheStuu UI Styleguide (Verbindlich)

Stand: 2026-02-21

## 1. Geltungsbereich

- Gilt fuer **die gesamte App**: `Edit`, `Node`, `Mix`, Inspector, Chat, Toolbars und alle neuen Screens.
- Ziel ist ein konsistenter **modern black/white look** mit hohem Kontrast und klarer Informationshierarchie.

## 2. Farbprinzip

- Erlaubte Basis: Schwarz, Weiss und neutrale Graustufen.
- Keine bunten Primarakzente als Standard-UI-Farbe.
- Akzentfarbe fuer Interaktion: Weiss/helles Grau (`#fff` bis ca. `#d6d6da`).
- Hintergruende: dunkle Flaechen mit subtilen Verlaeufen statt flacher Vollfarbe.
- Statusfarben nur, wenn fachlich notwendig (z. B. Error-Warnung). Sonst neutral.

## 3. Typografie und Dichte

- Sans-Serif fuer UI, Monospace nur fuer Timecode/technische Readouts.
- Labels und Toolbar-Texte kompakt, eindeutig, in konsistenter Gross-/Kleinschreibung.
- Keine visuelle Ueberladung durch zu viele Font-Groessen.

## 4. Layout- und Komponentenvorgaben

- Edit-Ansicht bleibt FL-inspiriert:
  - Pattern-Browser nicht anzeigen.
  - Track/Grid-Aufteilung mit mindestens 25 sichtbaren Track-Lanes.
  - Track 1 enthaelt den primaren `+`-Button (neues Pattern + Clip-Flow).
- Grid-Linien und Ruler muessen klar lesbar, aber visuell dezent sein.
- Buttons und Controls: rechteckig/kompakt, klare Hover-/Active-States in Graustufen.

## 5. UX-Regeln

- Interaktive Elemente brauchen sofort sichtbares Feedback (Hover, Active, Focus).
- Click-Targets nicht zu klein gestalten.
- Tastaturbedienung fuer wichtige Controls sicherstellen.
- Neue UI-Elemente duerfen den bestehenden Schwarz-Weiss-Charakter nicht brechen.

## 6. Icons

- **Quelle:** Alle UI-Icons kommen aus **Lucide React** (`lucide-react`).
- **Paket:** `lucide-react` im Dashboard (bzw. dort, wo UI gerendert wird).
- **Verwendung:** Icons als Komponenten importieren (z. B. `import { Play, Pause } from 'lucide-react'`) und mit einheitlicher Groesse/Strichstaerke verwenden (z. B. `size={14}` oder `size={12}`, `strokeWidth={2}`).
- **Keine** eigenen SVG-Icons fuer Buttons, Toolbars oder Status – stattdessen passende Lucide-Icons waehlen (z. B. Scissors, Pencil, Trash2, VolumeX, ExternalLink, Check).
- **Ausnahme:** Custom Cursor (z. B. Edit-Tool-Cursor) duerfen weiterhin als SVG-Data-URL umgesetzt sein; optisch sollten sie sich an Lucide anlehnen, wo sinnvoll.

## 7. Umsetzungsregel fuer Agents

- Vor jeder UI-Aenderung gegen diese Datei pruefen.
- Bei Konflikten hat dieses Dokument Vorrang gegenueber ad-hoc Styling.
- Neue Icons nur aus `lucide-react` verwenden (siehe Abschnitt 6).
