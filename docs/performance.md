# DAW performance baseline and verification

How to measure smoothness before/after performance work. Use a **production** dashboard build for realistic numbers (`next dev` is not the benchmark).

## Commands

```bash
# Full stack (native-first)
npm run start

# Production dashboard (smoothness benchmark)
npm run build --prefix apps/dashboard
npm run start --prefix apps/dashboard

# QA gates (run after each performance PR)
npm run check:daw-authority
npm run test:daw-authority
npm run qa:native-daw
npm run qa:legacy-daw
```

## Environment

| Variable | Effect |
|----------|--------|
| `STUU_METER_INTERVAL_MS` | Engine meter poll interval (default 80 via CLI) |
| `STUU_PERF=low` | Slower meters (120–150 ms), lighter UI defaults |
| `STUU_METER_UI_FALLBACK=1` | Fake meters when native has no `get_meters` (tests only) |
| `--legacy-daw` | Legacy JSON mode (not a smoothness target) |

## Manual scenarios

1. **Idle** — App open, transport stopped, Mix tab visible. Note CPU % (Activity Monitor / Task Manager).
2. **Play 16 tracks** — Load or create 16-track session, Mix tab, play 30 s. React Profiler: `StuuShell` should not commit on every `engine:meter`.
3. **Arrangement drag** — Edit tab, drag a clip for 10 s. UI should stay responsive; no multi-second stalls.
4. **Structure link toggle** — Toggle Structure↔Playlist link repeatedly; should feel instant (optimistic UI).

## Target metrics

| Metric | Target |
|--------|--------|
| `StuuShell` re-render on `engine:meter` | 0 |
| `engine:transport` + `engine:meter` per second (play, native) | ≤ 25 |
| rAF loops (16 tracks, Mix visible) | ≤ 2 |
| `qa:native-daw` | pass |
| TTI after `npm run start` (prod build) | < 4 s |

## React Profiler

1. Open dashboard in Chrome, React DevTools → Profiler.
2. Record during scenario 2 (play).
3. Filter commits by `StuuShell` — meter ticks should not appear as full-shell commits after Phase B.

## Socket rate (optional)

In browser console while playing:

```js
let t = 0, m = 0;
const s = window.__thestuuSocket; // if exposed for debug
// Or count from Network WS frames in DevTools
```

Engine logs `STUU_DEBUG_METERS=1` for meter diagnostics only.

## Recording a baseline

Before a performance PR, note:

- Date, machine, `STUU_METER_INTERVAL_MS`, native vs legacy
- CPU % for scenarios 1–2
- Profiler screenshot or commit count for `StuuShell` during play
- QA script results

After the PR, repeat the same scenarios and compare.
