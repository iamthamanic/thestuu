# Konzept: FIT TO TEMPO

## Ziel
Einen Audioclip so zeitstrecken (time-stretch), dass sein Tempo zum Projekt-BPM passt – ohne Pitch-Änderung. Der Menüpunkt "FIT TO TEMPO" im Clip-Dropdown nutzt die (manuell eingegebene oder per ANALYZE ermittelte) Clip-BPM und das Projekt-BPM und passt die Clip-Länge an.

## Nutzen
- Loops und Samples sauber ins Projekt-Tempo bringen.
- Einheitliches Grid ohne manuelles Schneiden/Stretchen.
- Typische DAW-Funktion (FL Studio, Ableton, Logic).

## Voraussetzungen
- Projekt-BPM bekannt (`state.project.bpm` o. ä.).
- Clip hat Clip-BPM (aus ANALYZE oder manuell) oder User gibt Ziel-BPM/Verhältnis im Dialog ein.
- Audiodatei unter `source_path` vorhanden und lesbar.

## Technische Optionen

### 1. Lokale Bibliotheken (empfohlen)
- **SoundTouch (C++)**  
  Time-Stretch ohne Pitch-Änderung, geringe Latenz. Kann in der Native-Engine integriert oder als separates Tool aufgerufen werden.
- **Rubber Band**  
  Hochwertiger Time-Stretcher, CLI oder Library.
- **ffmpeg**  
  Filter `atempo` oder in Kombination; für einfache Fälle ausreichend.
- **librosa / audiomentations (Python)**  
  Phase-Vocoder; sinnvoll wenn bereits ein Python-Service für ANALYZE existiert.

### 2. Cloud-APIs
- Keinen verbreiteten "Fit to Tempo"-Cloud-API-Standard; Time-Stretch üblicherweise lokal oder in eigener Infrastruktur.

### 3. Tracktion Engine
- Prüfen, ob Tracktion/JUCE Time-Stretch anbietet; falls ja, in der Native-Engine nutzen.

## Ablauf (Vorschlag)
1. User wählt "FIT TO TEMPO" im Clip-Dropdown.
2. Optional: Dialog für Quell-BPM (wenn nicht analysiert) und Bestätigung Ziel-BPM (Projekt-BPM).
3. Engine berechnet Streckfaktor: `ratio = projectBpm / clipBpm`. Neue Länge aus aktueller Clip-Länge mal ratio.
4. Time-Stretch ausführen: neue Datei erzeugen (Cache/Projekt-Ordner) und Clip auf neue Datei und neue Länge umstellen; oder Native-Engine übernimmt Stretch beim Abspielen.
5. Playlist aktualisieren; Native-Engine-Sync wie bei "One Authority".

## Datenmodell
- Nach Fit to Tempo: Clip zeigt neue Länge; `clip.length` und ggf. `clip.source_path` (wenn neue Datei) werden aktualisiert.
- Optional: `clip.original_bpm` / `clip.stretched_from_path` für Undo/Revert.

## Fehlerbehandlung
- Kein Projekt-BPM oder keine Clip-BPM: Dialog zur Eingabe oder Abbruch mit Hinweis.
- Time-Stretch schlägt fehl: Fehlermeldung, Clip unverändert.

## Offene Punkte
- Neue Datei erzeugen vs. Stretch in der Engine?
- Soll Undo "Revert Fit to Tempo" die ursprüngliche Datei wiederherstellen?
