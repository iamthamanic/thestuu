# Konzept: EXTRACT STEMS

## Ziel
Aus einem Audioclip per KI Stems erzeugen (z. B. Vocals, Drums, Bass, Other) und die Ergebnisse als neue Clips oder neue Spuren/Dateien ins Projekt übernehmen. Der Menüpunkt „EXTRACT STEMS“ im Clip-Dropdown startet die Stems-Extraktion für den gewählten Clip.

## Nutzen
- Remix, Karaoke, Reamping: Einzelne Spuren getrennt bearbeiten.
- FL-Studio-ähnliche „Stem Separation“-Funktion direkt in TheStuu.

## Optionen für die Umsetzung

### 1. StemSplit API (empfohlen)
- **REST-API**, Stems in 2-/4-/6-Stem-Modi.
- BPM/Key automatisch bei jedem Job (librosa) – Synergie mit ANALYZE.
- Formate: MP3, WAV, FLAC, M4A, OGG, WEBM.
- Authentifizierung: Bearer Token.
- Free Trial: 10 Minuten ohne Karte.
- Docs: https://stemsplit.io/developers/docs  
- Referenz: https://stemsplit.io/developers/reference

### 2. LALAL.ai
- Stems per API; ähnlicher Use-Case wie StemSplit.

### 3. Self-hosted (Demucs)
- **Demucs** (Meta) als Python-Service: Hohe Qualität, keine laufenden API-Kosten; erfordert GPU/Rechenzeit und Wartung.

### 4. VocalRemover.org
- **Keine öffentliche API** – nur Webseite. Nicht als Backend integrierbar; höchstens Link „Im Browser Stems erstellen“.

## Ablauf (Vorschlag)
1. User wählt „EXTRACT STEMS“ im Clip-Dropdown.
2. Optional: Dialog für Modus (2/4/6 Stems) und Ziel (neue Spuren vs. neue Clips in gleichem Track).
3. Frontend sendet Mutation (z. B. `clip:extract-stems`) mit `trackId`, `clipId`.
4. Engine prüft `source_path`, lädt Datei hoch oder sendet URL an StemSplit (bzw. anderen Anbieter).
5. Asynchron: Job wird erstellt; optional Webhook oder Polling für Ergebnis.
6. Bei Fertigkeit: Herunterladen der Stem-Dateien; Anlegen neuer Clips/Spuren und Import in Playlist; Sync mit Native-Engine.

## Datenmodell
- Neue Clips/Spuren mit eigenen `source_path` auf die erzeugten Stem-Dateien.
- Optional: Verknüpfung zum Quell-Clip (z. B. `clip.stem_source_clip_id`) für Gruppierung/UI.

## Fehlerbehandlung
- Keine `source_path` oder Datei nicht lesbar → Hinweis wie bei ANALYZE.
- API-Limit / Timeout → klare Fehlermeldung, evtl. Retry-Option.
- Teilweise fehlgeschlagene Stems → nur erfolgreiche Stems importieren und User informieren.

## Offene Punkte
- Standard-Modus (4-Stem: Drums, Bass, Vocals, Other)?
- Wo speichern: Projekt-Ordner, temporärer Cache, Nutzer wählt?
- Sollen BPM/Key aus dem StemSplit-Job direkt in die neuen Clips übernommen werden?
