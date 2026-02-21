# TheStuu Monorepo (MVP)

MVP-Implementierung auf Basis des Konzepts aus `TheStuu Konzept.pdf`.

## Struktur

```text
/apps
  /dashboard   # Next.js UI (Edit / Node / Mix + Inspector + AI-Chat Sidebar)
  /engine      # Node-Orchestrator (Socket.IO fuer Dashboard + IPC-Bridge)
  /native-engine # Native C++ Transport + VST-Bridge (Unix Socket + MessagePack)
  /cli         # CLI: `thestuu start`
/packages
  /shared-json # .stu Schema + Parser/Serializer
  /dsp-modules # DSP-Placeholders (Stuu-Q, Stuu-Comp)
```

## Schnellstart

```bash
npm install
npm run start
```

Danach:
- legt die CLI `~/.thestuu`, `~/.thestuu/projects` und `~/.thestuu/config.json` an
- erstellt ein Default-Projekt `~/.thestuu/projects/welcome.stu`
- baut/startet den nativen Transport-Prozess (Unix Socket IPC)
- startet Engine (`:3987`) und Dashboard (`:3000`)
- oeffnet den Browser automatisch

## CLI

```bash
npx thestuu start
```

Optionen:

```bash
npx thestuu start --port 3000 --engine-port 3987 --no-browser
```

Native-Bridge optional deaktivieren:

```bash
npx thestuu start --no-native
```

Tracktion-Backend ist Standard (Vendor-Setup vorausgesetzt):

```bash
npx thestuu start
```

Stub-Backend explizit nutzen:

```bash
npx thestuu start --native-backend stub
```

## Hinweise

- Die Architektur ist jetzt dreistufig: Dashboard -> CLI/Node-Orchestrator -> Native C++ Engine (IPC).
- Der native Prozess liefert Transport plus grundlegende Plugin-IPC (`vst:scan`, `vst:load`, `vst:param:set`).
- Das Tracktion-Backend startet mit einem Default-Edit (16 Audio-Tracks) und internem `ultrasound` Built-in.
- JUCE/Tracktion Build-Setup ist vorhanden (siehe `docs/tracktion-setup.md`, Defaults sind auf feste Vendor-Commits gepinnt).
