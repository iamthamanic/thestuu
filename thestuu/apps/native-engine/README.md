# TheStuu Native Engine

Die App benötigt die **Native-Engine mit Tracktion/JUCE** für Audio-Ausgabe und alle DAW-Features. Tracktion ist verpflichtend (kein Stub-Backend mehr).

## Tracktion-Backend einrichten

### Option A: Setup-Skript (empfohlen)

Aus dem Monorepo-Root (`thestuu/thestuu`):

```bash
./scripts/setup-tracktion.sh
```

Das klont Tracktion Engine in `vendor/tracktion_engine`. Anschließend:

```bash
export STUU_NATIVE_VENDOR_DIR="$(pwd)/vendor/tracktion_engine"
# Im äußeren Projektordner thestuu:
cd ../..
npm run dev
```

### Option B: Manuell

#### 1. Tracktion Engine klonen (mit JUCE-Submodule)

```bash
# Beliebiges Verzeichnis, z.B. neben dem Projekt
cd "/Users/halteverbotsocialmacpro/Desktop/arsvivai/2) DEV PROJEKTE"
git clone --recurse-submodules https://github.com/Tracktion/tracktion_engine.git
```

**Hinweis:** Tracktion Engine und JUCE haben eigene Lizenzen (GPL/Commercial). Siehe [Tracktion Develop](https://www.tracktion.com/develop/tracktion-engine) und [JUCE](https://juce.com).

#### 2. Umgebungsvariable setzen

```bash
export STUU_NATIVE_VENDOR_DIR="/Users/halteverbotsocialmacpro/Desktop/arsvivai/2) DEV PROJEKTE/tracktion_engine"
```

Oder dauerhaft in `~/.zshrc` / `~/.bashrc` eintragen.

#### 3. App starten

```bash
cd thestuu   # Projekt-Root (äußerer Ordner)
npm run dev
```

Die CLI übergibt `STUU_THIRD_PARTY_DIR` an CMake; der Native-Build nutzt dann JUCE und Tracktion und liefert echten Audio-Output.

### Alternative: Vendor-Pfad beim Start

```bash
STUU_NATIVE_VENDOR_DIR="/pfad/zu/tracktion_engine" npm run dev
```

Oder mit CLI-Option (aus dem inneren Monorepo-Root `thestuu/thestuu`):

```bash
node apps/cli/bin/thestuu.js start --native-vendor-dir /pfad/zu/tracktion_engine
```
