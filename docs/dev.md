# TheStuu — one dev entry point

Use **one command per session** so Native, Node, and UI share the same Unix socket and ports.

## Browser (default) — not Tauri

`npm run dev` opens **http://127.0.0.1:3010** in the browser. It does **not** build or launch the Tauri `.app`.

```bash
export STUU_NATIVE_VENDOR_DIR="$(pwd)/vendor/tracktion_engine"   # once
npm run dev
```

Starts (after cleaning stale processes on `:3990` / `:3010`):

1. `thestuu-native` → `/tmp/thestuu-native.sock`
2. Node engine → `http://127.0.0.1:3990`
3. Dashboard → `http://127.0.0.1:3010` (browser opens when dashboard is up)

Tracktion may still be syncing after the browser opens — check the LOGS badge. A brief **NO AUDIO** state is normal until `/health` reports `nativeTransport: true`.

## Tauri window (dev)

```bash
npm run tauri
# same as:
npm run dev -- --desktop
npm run desktop:dev
```

Same native + engine startup, then **Tauri** opens the UI (dashboard via `tauri dev` on `:3010`).

## Release `.app` (not daily dev)

```bash
npm run tauri:build
# or: npm run build:native-release && npm run desktop:build
```

## Reuse (advanced)

```bash
npm run dev -- --reuse
```

Skips port/socket cleanup and reuses an engine on `:3990` **only if** it is already DAW-ready on the canonical socket.

## Stale processes

If startup fails or you see `ENOENT /tmp/thestuu-native.sock` spam:

```bash
lsof -ti :3990 | xargs kill -9 2>/dev/null
lsof -ti :3010 | xargs kill -9 2>/dev/null
pkill -f thestuu-native 2>/dev/null
pkill -f "apps/engine/src/server.js" 2>/dev/null
rm -f /tmp/thestuu-native.sock
npm run dev
```

Default `npm run dev` runs `--clean` automatically (kills stale engine, native, dashboard).

## Do not mix

Avoid in parallel:

- `npm run dev` + separate `npm run tauri` in two terminals
- Old engine on `:3990` from a previous socket path
- Dashboard-only `next dev` without the stack

Symptom: badge **NO AUDIO :3990** = Node online, native/Tracktion not connected to this engine.

## QA / CI

```bash
npm run start -- --no-browser          # same as dev (clean + stack)
npm run start -- --legacy-daw --no-browser
```
