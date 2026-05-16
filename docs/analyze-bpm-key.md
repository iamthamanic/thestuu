# Konzept: ANALYZE (BPM / KEY)

## Ziel
Pro Audioclip BPM und musikalische Tonart (Key) automatisch ermitteln und in den Clip-Metadaten speichern. Der Menüpunkt "ANALYZE (BPM / KEY)" im Clip-Dropdown startet die Analyse für den gewählten Clip.

## Nutzen
- Projekt-Tempo und Clip-Tempo abgleichen (Fit to Tempo, Grid).
- Key-Information für Melodie/Harmonie, Transpose, Kompatibilität mit anderen Clips.
- Anzeige in der UI (z. B. in der Clip-Info oder im Inspector).

## Datenmodell (Playlist / Clip)
- `clip.bpm` (optional, number): erkanntes Tempo.
- `clip.key` (optional, string): z. B. "C major", "A minor" oder Kurzform "Am".
- `clip.analyzed_at` (optional, ISO string): Zeitpunkt der letzten Analyse (für Cache/Invalidierung).

## Optionen für die Umsetzung

### 1. Externe APIs (empfohlen für schnelle Integration)
- **MusicGPT API**  
  Key- und BPM-Extraktion aus Upload oder URL. Webhooks für asynchrone Jobs. Docs: https://docs.musicgpt.com/
- **StemSplit API**  
  BPM/Key automatisch bei jedem Stem-Job (librosa). Sinnvoll, wenn "EXTRACT STEMS" ohnehin genutzt wird.
- **Cyanite**  
  Audio Analysis (BPM/Key) mit Segment-Auflösung. https://api-docs.cyanite.ai/

### 2. Eigenes Backend (librosa)
- Node.js/Python-Service mit **librosa** (beat_track, chroma) für BPM und Key.
- Volle Kontrolle, keine Drittanbieter; erfordert Hosting und Wartung.

### 3. VocalRemover.org
- Keine öffentliche API – nur Web-Frontend. Nicht als Backend integrierbar; höchstens Link "Im Browser analysieren".

## Ablauf (Vorschlag)
1. User wählt im Clip-Dropdown "ANALYZE (BPM / KEY)".
2. Frontend sendet Mutation (z. B. `clip:analyze-bpm-key`) mit `trackId`, `clipId`; Engine prüft `source_path` und ob Datei lesbar ist.
3. Engine lädt Datei an gewählten Dienst (API oder eigenes Backend).
4. Antwort (BPM, Key) wird in der Playlist am Clip gespeichert und an alle Clients gesendet.
5. UI zeigt BPM/Key am Clip oder im Inspector; optional "Analyse läuft…" mit Spinner.

## Fehlerbehandlung
- Keine `source_path` oder Datei nicht lesbar: Hinweis "Datei fehlt oder nicht lesbar".
- API-Timeout / Fehler: Fehlermeldung, Clip-Daten unverändert.
- Rate-Limits der API beachten (Backoff, Queue).

## Offene Punkte
- Welcher Anbieter zuerst? (MusicGPT vs. StemSplit vs. eigenes Backend.)
- Sollen BPM/Key auch in der Native-Engine genutzt werden (z. B. für Fit to Tempo)?
