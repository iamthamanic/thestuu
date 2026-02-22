# Tracktion Setup (Phase 1)

Stand: 2026-02-21

## Ziel

Vendor-Setup fuer das Standard-Backend `tracktion` bereitstellen, damit JUCE/Tracktion im nativen Prozess initialisiert wird.

## 1. Vendor-Dependencies holen

```bash
bash apps/native-engine/scripts/bootstrap-vendor.sh
```

Optional eigene Versionen:

```bash
JUCE_REF=<branch|tag|commit> TRACKTION_REF=<branch|tag|commit> bash apps/native-engine/scripts/bootstrap-vendor.sh
```

Default-Refs (gepinnt):

- `JUCE`: `75fee9639a855a1b0c8b2b3e2cb9265d9bcaaf4d`
- `tracktion_engine`: `2877b621f2fbee564d0696a616b86bf8ba8c8ab0`

## 2. Native Engine mit Tracktion bauen

```bash
STUU_ENABLE_TRACKTION=1 npm run build --workspace @thestuu/native-engine
```

## 3. App starten (Tracktion ist Default)

```bash
npx thestuu start
```

Optional mit abweichendem Vendor-Pfad:

```bash
npx thestuu start --native-vendor-dir /abs/path/to/vendor
```

Optional Stub erzwingen:

```bash
npx thestuu start --native-backend stub
```

## 4. Erwartete Logs

- CLI:
  - `native backend: tracktion`
- Native Prozess:
  - `backend: tracktion backend ready (...)`
- Node Engine:
  - `native transport: online (...)`

## Hinweise

- Bootstrap ist jetzt auf feste, getestete Commits gepinnt (siehe oben) und damit reproduzierbarer.
- Native IPC unterstuetzt jetzt zusaetzlich `vst:scan`, `vst:load` und `vst:param:set`.
- `ultrasound` ist als internes Built-in Plugin verfuegbar (`internal:ultrasound`).
