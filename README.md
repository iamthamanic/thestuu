# TheStuu

TheStuu ist eine DAW-orientierte Musikproduktions-App mit Fokus auf:
- schnelle Arrangement-Bearbeitung im Edit-Flow,
- Track-/Node-/Mix-Workflows in einer UI,
- nativen Audio- und Plugin-Funktionen via C++ Backend (Tracktion/JUCE),
- erweiterbaren AI-gestuetzten Produktions-Features.

Die App ist als Monorepo aufgebaut und trennt klar zwischen UI, Orchestrierung und nativer Engine.

## Was ist bereits integriert

### 1) Produkt- und Laufzeitarchitektur
- Dashboard (`Next.js`) als Hauptoberflaeche.
- Engine (`Node.js`) als zentrale Session- und Mutations-Schicht.
- Native Engine (`C++`) fuer Transport, Audio-/Plugin-Bruecke und Tracktion-Integration.
- IPC zwischen Engine und Native ueber Unix Socket + MessagePack.
- CLI, die den kompletten Stack startet und Prozesse koordiniert.

### 2) Edit-Workflow (Arrangement)
- Import von Audio/MIDI-Clips.
- Timeline mit Grid, Taktlineal und Playhead.
- Clip-Aktionen wie Create/Move/Resize/Delete.
- Edit-Tools inkl. Select/Delete/Slice/Slip/Zoom.
- Clip-Fades inkl. Kurvensteuerung.
- Track-Management (u. a. Name, Reihenfolge, grundlegende Kanalsteuerung).

### 3) Transport und Timing
- Transport: Play, Pause, Stop, Seek.
- BPM-Steuerung inkl. Eingabevalidierung.
- Time-Signature-Unterstuetzung.
- Metronom mit Audio-Tick und visueller Nadelanimation.
- Native Transport-Ticks fuer konsistente Wiedergabe-Synchronisation.

### 4) Mixer- und Plugin-Flow
- Channel-Controls: Volume, Pan, Mute, Solo, Record-Arm.
- FX-Chain-Slots pro Track inkl. Reorder/Bypass/Remove.
- VST-Scan, Laden und Parametersteuerung.
- Oeffnen von Plugin-Editorfenstern (sofern verfuegbar).
- Tracktion-Core- und externe Plugin-Anbindung (je nach Setup).

### 5) Persistenz und Projektzustand
- Projektdateien unter `~/.thestuu/projects`.
- Default-Projekt-Erstellung beim ersten Start.
- Zustandssynchronisation zwischen UI und Engine.
- Undo/Redo auf Projektebene.

### 6) Audio-Umgebung
- Auswahl von Audio-Ausgabegeraeten (Native/Tracktion-Flow).
- Native Backend mit Tracktion als Standard-Backend.
- Fallback-/Stub-Pfade fuer Entwicklungs- und Testfaelle.

## Was laut Konzept als naechstes kommen soll

Die folgenden Features sind im Repo bereits konzeptionell ausgearbeitet und als naechste Produktphasen vorgesehen:

- `Sync Button` (Grid/Reference/Vocal-Alignment-Workflow)
  - Konzept: `docs/sync%20button.md`
- `Analyze BPM/Key`
  - Konzept: `docs/analyze-bpm-key.md`
- `Extract Stems`
  - Konzept: `docs/extract-stems.md`
- `Fit To Tempo`
  - Konzept: `docs/fit-to-tempo.md`
- `Rename and Color` als Clip-/Arrangement-Verbesserung
  - Konzept: `docs/rename-and-color.md`
- Erweiterter Node-/Mixer-Flow im Edit-Kontext
  - Konzept: `docs/node-mixer-konzept-fuer-edit-tab.md`
- Premium-Plugin-UI (u. a. EQ Hero-UI, Easy/Pro-Ansicht)
  - Konzept: `docs/plugin-ui-recherche-und-konzept.md`

Weitere Leitdokumente:
- `docs/konzept-fuer-mixer.md`
- `docs/native-ipc.md`
- `docs/tracktion-setup.md`

## Schnellstart

### Voraussetzungen
- Node.js `>=20.10.0`
- `npm`
- `cmake`
- `clang++` (oder ueber `STUU_NATIVE_CXX` gesetzt)
- Tracktion/JUCE Vendor-Setup (siehe unten)

### Setup

```bash
npm install
```

Tracktion Vendor einrichten (empfohlen):

```bash
bash scripts/setup-tracktion.sh
```

Alternative: eigenen Vendor-Pfad ueber `STUU_NATIVE_VENDOR_DIR` setzen.

### Starten

```bash
npm run start
```

Die CLI:
- legt `~/.thestuu`, `~/.thestuu/projects` und `~/.thestuu/config.json` an,
- erstellt `welcome.stu`, falls noch nicht vorhanden,
- baut/startet Native Engine,
- startet Engine auf `127.0.0.1:3987`,
- startet Dashboard auf `127.0.0.1:3000`,
- oeffnet den Browser (wenn nicht deaktiviert).

## Bedienanleitung

### 1) Projekt starten
1. `npm run start` ausfuehren.
2. Im Browser das Dashboard oeffnen (`http://127.0.0.1:3000`).

### 2) Audio/MIDI importieren
1. Im Edit-Tab Clip-Import verwenden.
2. Dateien landen als Clips in der Arrangement-Timeline.
3. Clips mit Drag/Resize auf das Grid setzen.

### 3) Tempo und Transport einstellen
1. BPM im Transportfeld setzen.
2. Taktart (`time signature`) waehlen.
3. Metronom aktivieren/deaktivieren.
4. Mit Play/Pause/Stop arbeiten.

### 4) Arrangement bearbeiten
1. Tool waehlen (`select`, `delete`, `slice`, `slip`, `zoom`).
2. Clips schneiden, verschieben, laengenanpassen.
3. Bei Bedarf Fades und Kurven setzen.

### 5) Mischen und Plugins
1. Track-Lautstaerke/Pan/Mute/Solo/Arm einstellen.
2. FX-Slots pro Track nutzen.
3. Plugins scannen/laden.
4. Parameter in UI oder Plugin-Editor anpassen.

### 6) Rueckgaengig und speichern
1. Undo/Redo ueber die dafuer vorgesehenen Controls nutzen.
2. Projektstatus wird ueber die Engine verwaltet und persistiert.

## CLI Nutzung

Standard:

```bash
npx thestuu start
```

Typische Optionen:

```bash
npx thestuu start --port 3000 --engine-port 3987 --no-browser
```

Native deaktivieren:

```bash
npx thestuu start --no-native
```

Tracktion explizit:

```bash
npx thestuu start --native-backend tracktion
```

Stub explizit:

```bash
npx thestuu start --native-backend stub
```

## Repo-Struktur

```text
/apps
  /dashboard      Next.js UI (Edit / Node / Mix, Inspector, Chat)
  /engine         Node-Orchestrator + Socket.IO + Native IPC Bridge
  /native-engine  C++ Runtime (Transport, Audio, VST/Tracktion)
  /cli            thestuu Start-CLI
/packages
  /shared-json    .stu Schema, Parser, Serializer
  /dsp-modules    DSP-Module (Platzhalter/Erweiterungspunkt)
/docs             Konzepte, IPC, Roadmap-nahe Spezifikationen
```

## Hinweise fuer Entwicklung

- UI- und Verhaltenkonventionen: `docs/styleguide-ui.md`
- Native IPC Spezifikation: `docs/native-ipc.md`
- Tracktion Build/Setup: `docs/tracktion-setup.md`

Wenn Native/Tracktion nicht startet:
1. Vendor-Pfad pruefen (`STUU_NATIVE_VENDOR_DIR`).
2. CMake/Compiler-Verfuegbarkeit pruefen.
3. Native- und Engine-Logs in der CLI-Ausgabe lesen.
