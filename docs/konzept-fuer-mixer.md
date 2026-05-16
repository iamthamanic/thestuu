# Konzept fuer Mixer

## Zielbild
Die Mix-Ansicht soll sich in Aufbau und Bedienfluss an FL Studio orientieren, aber im Look-and-Feel zu TheStuu passen.  
Jeder Track aus der Edit-Ansicht erscheint als eigener vertikaler Channel-Strip im Mix-Tab.  
Die Effektkette bleibt die bestehende Node-Engine, wird im Mixer aber als vertikale Top-down-Kette pro Kanal dargestellt.

## Was bereits vorhanden ist
1. Es gibt bereits die Tabs `Edit` und `Mix`.
2. Die Track-Mix-Daten sind zentral vorhanden (`volume`, `pan`, `mute`, `solo`, `record_armed`).
3. Die Edit-Ansicht hat pro Track schon einen Mini-Mixer.
4. Der Mix-Tab hat bereits Channel-Strips und rechts einen Inspector.
5. Die VST-Node-Kette ist pro Track vorhanden und per `plugin_index` sortiert.
6. VST-Operationen (add, remove, reorder, bypass, param set) existieren bereits.

## Kernanforderung
1. Der Mix-Tab wird zur primaeren Mixer-Arbeitsflaeche.
2. Kanalstruktur pro Strip:
   - Header mit Track-Nummer und Name
   - Meter
   - Mute, Solo, Record Arm
   - Pan-Regler
   - Volume-Fader
   - Slot-Status
3. Rechter Kanalbereich zeigt den selektierten Track im Detail:
   - gleiche Werte wie im Strip
   - vertikale Slot-Liste der Node-Kette
   - Add, Remove, Bypass, Reorder
4. Edit-Ansicht bleibt kompakt, teilt sich aber dieselben Mixer-Daten und Aktionen.

## Abgleich mit FL-Studio-Logik
1. Horizontal scrollbare Strip-Bank mit Master links.
2. Selektionsmodell wie bei Mixer-Insert-Kanaelen: ein aktiver Kanal steuert die Detailansicht rechts.
3. FX-Slots als Kette pro Kanal, bei uns weiterhin auf Node-Daten basierend.
4. Keine FL-1:1-Kopie, aber gleiche mentale Modelle:
   - Kanalzug
   - Slot-Kette
   - schneller Zugriff auf M/S/R, Pan, Volume

## Technische Leitplanken
1. Kein neues Mixer-Datenmodell notwendig.
2. Kein Bruch mit bestehender Node-Engine.
3. UI-Komponenten fuer Mix-Controls in Edit und Mix angleichen, um Duplikation zu reduzieren.
4. Bestehende Socket-Mutationen weiterverwenden.

## Bekannte Luecken
1. Metering ist aktuell nicht echt:
   - bei aktivem Native-Transport derzeit `0`
   - ohne Native-Transport random simuliert
2. Master-Kanal ist aktuell nur teilweise dynamisch.
3. Es gibt Restlogik fuer einen alten `Node`-Tab, obwohl nur `Edit` und `Mix` aktiv sind.

## Umsetzungsplan in Phasen
1. Phase 1: UI-Struktur und visuelle Sprache
   - Mix-Layout schaerfen
   - klare Kanalhierarchie
   - FL-aehnlicher Strip-Flow in TheStuu-Design
2. Phase 2: Komponentenharmonisierung
   - gemeinsame Mix-Control-Bausteine fuer Edit und Mix
   - konsistente Interaktionen und Werteanzeige
3. Phase 3: FX-Kette im Mixer finalisieren
   - vertikale Slot-Darstellung
   - Reorder, Bypass, Remove, Add ueber bestehende Node-APIs
4. Phase 4: technische Qualitaet
   - echte Meterdaten aus Native-Engine
   - Master-Verhalten und Routing sauber modellieren
5. Phase 5: Aufraeumen
   - alte `Node`-Tab-Reste entfernen
   - CSS und Zustandslogik entkoppeln und vereinheitlichen

## UX-Prinzipien
1. Mixer muss auf einen Blick lesbar sein: Name, Pegel, Zustand, Lautstaerke.
2. Direktmanipulation bleibt zentral: keine unnötigen Modaldialoge fuer Standardaktionen.
3. Konsistenz vor Feature-Breite: dieselbe Aktion darf in Edit und Mix nicht unterschiedlich reagieren.
4. Mobile und kleinere Viewports muessen einen klaren Fallback behalten.

## User Journey
### Journey 1: Vom Track im Edit zum Kanal im Mix
1. User erstellt oder waehlt in `Edit` einen Track.
2. User sieht dort bereits Mini-Mixer-Werte (M/S/R, Pan, Volume).
3. User wechselt in den `Mix`-Tab.
4. Der gleiche Track ist als Channel-Strip sichtbar, mit identischen Werten.
5. Aenderungen im Mix sind sofort in Edit konsistent und umgekehrt.

### Journey 2: FX-Chain pro Kanal aufbauen
1. User selektiert einen Kanal im Mix.
2. Rechts erscheint die vertikale Slot-Liste (Top-down-Signalfluss).
3. User fuegt Plugins in freie Slots ein.
4. User schaltet einzelne Slots per Bypass an/aus.
5. User zieht Slots per Drag-and-drop um und hoert/sehen direkt den Effekt.

### Journey 3: Schnelles Balancing mehrerer Kanaele
1. User arbeitet links in der Strip-Bank kanalweise von Kick bis Vocals.
2. Pro Kanal stellt User Mute/Solo, Pan und Volume ein.
3. Pegel helfen bei der Balance, ohne dauernd in Untermenues zu wechseln.
4. Aktiver Kanal bleibt im rechten Detailbereich fuer Feintuning offen.

### Journey 4: Fehler- und Fallback-Verhalten
1. Wenn Native/Metering nicht verfuegbar ist, wird das klar kommuniziert.
2. Bedienung im Mixer bleibt dennoch konsistent (keine stillen Ausfaelle).
3. Slot-Aktionen zeigen klare Rueckmeldungen bei Fehlern (z. B. Plugin-Load fehlgeschlagen).
4. User kann ohne Kontextverlust weiterarbeiten.

## Journey Map
| Goal | Action | UI | Feedback | Pain Point | Metric |
| --- | --- | --- | --- | --- | --- |
| Track aus Edit im Mixer weiterbearbeiten | Track in `Edit` auswaehlen und zu `Mix` wechseln | Tab-Leiste + selektierter Channel-Strip | Gleicher Track ist aktiv, Werte sind identisch | Selektionssprung auf falschen Track | Track-Konsistenzrate (%) |
| Grundbalance herstellen | Mute/Solo/Rec setzen, Pan und Volume je Kanal anpassen | Strip-Bank mit direkten Controls | Sofort sichtbare Zustandswechsel und Pegelreaktion | Zu viele Klicks pro Kanal | Zeit bis Grobbalance (Sek.) |
| FX-Chain aufbauen | Slot klicken, Plugin hinzufuegen | Rechter Kanalbereich mit vertikalen Slots | Slot wird befuellt, Name/Status sichtbar | Plugin-Picker wirkt langsam/unklar | Erfolgsquote Plugin-Insert (%) |
| FX-Reihenfolge optimieren | Plugin-Slot drag-and-drop umsortieren | Vertikale Slot-Liste mit Reorder | Neue Reihenfolge bleibt stabil erhalten | Reorder springt oder ist unpraezise | Reorder-Fehlerrate (%) |
| Problemfall robust abfangen | Aktion bei fehlendem Native/Metering ausfuehren | Inline-Hinweis + Systemmeldung | Klare Fehlermeldung ohne UI-Blockade | Stille Fehler ohne Ursache | Anteil erklaerter Fehler (%) |
| Session durchgaengig halten | Zwischen Edit und Mix hin- und herwechseln | Edit-Mini-Mixer + Mix-Strips | Werte bleiben synchron | Inkonsistente Darstellung beider Views | Sync-Abweichungen pro Session |

## Ergebnisdefinition
Der Mixer gilt als erfolgreich umgesetzt, wenn:
1. alle Edit-Track-Mix-Werte in Mix 1:1 sichtbar und steuerbar sind,
2. die Node-FX-Kette pro Kanal vertikal und robust bedienbar ist,
3. der Mix-Tab visuell und funktional als Haupt-Mixer erkannt wird,
4. die Bedienung sich FL-vertraut anfuehlt, aber eindeutig TheStuu bleibt.
