# TheStuu — one dev entry point

Use **one command per session** so Native, Node, and UI share the same Unix socket and ports.

## Browser (default) — not Tauri

`npm run dev` opens **http://127.0.0.1:3010** in the browser. It does **not** build or launch the Tauri `.app`.

For a desktop window use `npm run dev -- --desktop`.

```bash
export STUU_NATIVE_VENDOR_DIR="$(pwd)/vendor/tracktion_engine"   # once
npm run dev
```

Starts (after cleaning stale processes on `:3990` / `:3010`):

1. `thestuu-native` → `/tmp/thestuu-native.sock`
2. Node engine → `http://127.0.0.1:3990`
3. Dashboard → `http://127.0.0.1:3010` (browser opens automatically)

Waits until `/health` reports `nativeTransport: true` (Tracktion ready) before finishing startup.

## Desktop window

```bash
npm run dev -- --desktop
# or
npm run desktop:dev
```

Same native + engine startup, then **Tauri** opens the UI (dashboard via `tauri dev` on `:3010`).

## Reuse (advanced)

```bash
npm run dev -- --reuse
```

Skips port/socket cleanup and reuses an engine on `:3990` **only if** it is already DAW-ready on the canonical socket.

## Do not mix

Avoid in parallel:

- `npm run dev` + separate `npm run desktop:dev` without `--desktop`
- Old engine on `:3990` from a previous socket path
- Dashboard-only `next dev` without the stack

Symptom: badge **NO AUDIO :3990** = Node online, native/Tracktion not connected to this engine.

## QA / CI

```bash
npm run start -- --no-browser          # same as dev (clean + stack)
npm run start -- --legacy-daw --no-browser
```
