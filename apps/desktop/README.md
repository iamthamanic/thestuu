# @thestuu/desktop

Tauri v2 desktop shell for TheStuu. **Does not own DAW state** — only provides a native window and (later) process lifecycle.

## Quick start (phase 1)

1. From repo root, start the normal stack:

   ```bash
   npm run start
   ```

2. In another terminal:

   ```bash
   npm run desktop:dev
   ```

If the dashboard is up on `http://127.0.0.1:3010`, the window navigates there. Otherwise you see the bundled offline page.

Full documentation: [docs/desktop-tauri.md](../../docs/desktop-tauri.md).
