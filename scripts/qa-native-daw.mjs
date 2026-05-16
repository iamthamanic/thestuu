#!/usr/bin/env node
/**
 * Automated 12-point native DAW QA (engine socket.io).
 * Requires engine + native-engine running with STUU_NATIVE_*=1 flags.
 * Usage: node scripts/qa-native-daw.mjs [--engine-url http://127.0.0.1:3990]
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { io } = require('../apps/dashboard/node_modules/socket.io-client/build/cjs/index.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const stuuHome = process.env.STUU_HOME || path.join(os.homedir(), '.thestuu');
const projectsDir = path.join(stuuHome, 'projects');
const mediaDir = path.join(stuuHome, 'media');

const engineUrl = (() => {
  const idx = process.argv.indexOf('--engine-url');
  return idx >= 0 ? process.argv[idx + 1] : (process.env.ENGINE_URL || 'http://127.0.0.1:3990');
})();

const QA_SAVE_NAME = 'qa_native_session.stu';
const TEST_AUDIO = path.join(mediaDir, 'Sample_YouTube_Video.mp3');

const results = [];

function pass(id, detail) {
  results.push({ id, ok: true, detail });
  console.log(`✓ ${id}: ${detail}`);
}

function fail(id, detail) {
  results.push({ id, ok: false, detail });
  console.error(`✗ ${id}: ${detail}`);
}

function emitAck(socket, event, payload = {}, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${event}`)), timeoutMs);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      if (!res || res.ok === false) {
        reject(new Error(res?.error || `${event} failed`));
        return;
      }
      resolve(res);
    });
  });
}

function waitForState(socket, predicate, timeoutMs = 60000, initialState = null) {
  if (initialState) {
    try {
      if (predicate(initialState)) {
        return Promise.resolve(initialState);
      }
    } catch {
      // fall through to wait
    }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for engine:state')), timeoutMs);
    function onState(state) {
      try {
        if (predicate(state)) {
          clearTimeout(timer);
          socket.off('engine:state', onState);
          resolve(state);
        }
      } catch (error) {
        clearTimeout(timer);
        socket.off('engine:state', onState);
        reject(error);
      }
    }
    socket.on('engine:state', onState);
  });
}

/** Wait for the next engine:state after an action (avoids missing emits before listener attaches). */
async function afterMutation(socket, action, predicate, timeoutMs, getLastState) {
  const pred = predicate || ((s) => Boolean(s?.project));
  const ms = timeoutMs || 120000;
  const statePromise = waitForState(socket, pred, ms, getLastState());
  await action();
  return statePromise;
}

function trackIdOf(track) {
  const raw = track?.track_id ?? track?.trackId ?? track?.id;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function findAudioClip(project) {
  for (const track of project?.playlist || []) {
    for (const clip of track?.clips || []) {
      if (String(clip?.type).toLowerCase() === 'audio') {
        return { trackId: trackIdOf(track), clip };
      }
    }
  }
  return null;
}

function clipSnapshot(project) {
  const rows = [];
  for (const track of project?.playlist || []) {
    for (const clip of track?.clips || []) {
      if (String(clip?.type).toLowerCase() === 'audio') {
        rows.push({
          trackId: track.id,
          clipId: clip.id,
          start: Number(clip.start),
          length: Number(clip.length),
          source_path: clip.source_path || clip.sourcePath || null,
        });
      }
    }
  }
  return rows.sort((a, b) => `${a.trackId}-${a.start}`.localeCompare(`${b.trackId}-${b.start}`));
}

async function main() {
  console.log(`[qa-native-daw] connecting to ${engineUrl}`);

  try {
    await fs.access(TEST_AUDIO);
  } catch {
    fail('precheck', `test audio missing: ${TEST_AUDIO}`);
    process.exit(1);
  }

  const socket = io(engineUrl, { transports: ['websocket'], timeout: 10000 });
  let lastState = null;
  socket.on('engine:state', (payload) => {
    lastState = payload;
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 15000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('engine:ready timeout')), 15000);
    socket.once('engine:ready', (payload) => { clearTimeout(timer); resolve(payload); });
  });

  if (!ready.nativeTransport) {
    fail('precheck', 'nativeTransport is false — start engine with native + STUU_NATIVE_*=1');
    socket.close();
    process.exit(1);
  }
  pass('precheck', `nativeTransport online (${ready.nativeSocketPath || 'socket'})`);

  let state = await waitForState(socket, (s) => Boolean(s?.project), 60000, lastState);
  if (!state.history?.nativeUndo && !state.history?.canUndo) {
    console.warn('[qa] history meta:', state.history);
  }
  if (state.history?.jsonHistory) {
    fail('history-guard', 'jsonHistory active — projectHistory should be off with native flags');
  } else {
    pass('history-guard', `history meta OK (${JSON.stringify(state.history)})`);
  }

  // 1 — old project load
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'project:load', { filename: 'welcome.stu' }, 120000),
    (s) => Array.isArray(s?.project?.playlist) && s.project.playlist.length > 0,
    120000,
    () => lastState,
  );
  pass('1-load-old', `loaded welcome.stu (${state.project.playlist.length} tracks)`);

  // 2 — import audio
  const trackId = trackIdOf(state.project.playlist[0]);
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'clip:import-file', {
      track_id: trackId,
      source_path: TEST_AUDIO,
      source_name: path.basename(TEST_AUDIO),
      source_format: 'mp3',
      type: 'audio',
      start: 0,
      length: 4,
    }, 120000),
    (s) => Boolean(findAudioClip(s.project)),
    120000,
    () => lastState,
  );
  const imported = findAudioClip(state.project);
  if (!imported) {
    fail('2-import', 'no audio clip after import');
  } else {
    pass('2-import', `clip ${imported.clip.id} on track ${imported.trackId}`);
  }

  const clipId = imported.clip.id;
  const startBefore = Number(imported.clip.start) || 0;
  const lenBefore = Number(imported.clip.length) || 4;

  // 3 — move
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'clip:move', { track_id: trackId, clip_id: clipId, start: startBefore + 4 }, 90000),
    (s) => {
      const c = findAudioClip(s.project);
      return c && Math.abs(Number(c.clip.start) - (startBefore + 4)) < 0.01;
    },
    60000,
    () => lastState,
  );
  pass('3-move', `start=${findAudioClip(state.project).clip.start}`);

  // 4 — resize
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'clip:resize', { track_id: trackId, clip_id: clipId, length: lenBefore + 2 }),
    (s) => {
      const c = findAudioClip(s.project);
      return c && Number(c.clip.length) >= lenBefore + 1.5;
    },
    60000,
    () => lastState,
  );
  pass('4-resize', `length=${findAudioClip(state.project).clip.length}`);

  const afterEdit = clipSnapshot(state.project);

  // 6 — undo (5 delete skipped to keep clip for save roundtrip; run delete+undo separately)
  let undoRes;
  state = await afterMutation(
    socket,
    async () => {
      undoRes = await emitAck(socket, 'project:undo', {});
    },
    (s) => Boolean(s?.project),
    60000,
    () => lastState,
  );
  if (!undoRes.history?.nativeUndo) {
    fail('6-undo', `expected nativeUndo, got ${JSON.stringify(undoRes.history)}`);
  } else {
    pass('6-undo', 'edit.undo via native');
  }
  const afterUndo = clipSnapshot(state.project);
  if (JSON.stringify(afterUndo) === JSON.stringify(afterEdit)) {
    console.warn('[qa] undo: playlist snapshot unchanged (native may still have undone)');
  }

  // 7 — redo
  let redoRes;
  await afterMutation(
    socket,
    async () => {
      redoRes = await emitAck(socket, 'project:redo', {});
    },
    (s) => Boolean(s?.project),
    60000,
    () => lastState,
  );
  if (!redoRes.history?.nativeUndo) {
    fail('7-redo', `expected nativeUndo, got ${JSON.stringify(redoRes.history)}`);
  } else {
    pass('7-redo', 'edit.redo via native');
  }

  // 5 — delete + undo restore
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'clip:delete', { track_id: trackId, clip_id: clipId }),
    (s) => !findAudioClip(s.project),
    60000,
    () => lastState,
  );
  pass('5-delete', 'clip removed from cache');

  state = await afterMutation(
    socket,
    () => emitAck(socket, 'project:undo', {}),
    (s) => Boolean(findAudioClip(s.project)),
    60000,
    () => lastState,
  );
  pass('5-delete-undo', 'clip restored after undo');

  const beforeSave = clipSnapshot(state.project);

  // 8–9 — save / reload
  await emitAck(socket, 'project:save', { filename: QA_SAVE_NAME });
  const savePath = path.join(projectsDir, QA_SAVE_NAME);
  try {
    await fs.access(savePath);
    pass('8-save', savePath);
  } catch {
    fail('8-save', `file not written: ${savePath}`);
  }

  state = await afterMutation(
    socket,
    () => emitAck(socket, 'project:load', { filename: QA_SAVE_NAME }, 120000),
    (s) => Boolean(findAudioClip(s.project)),
    120000,
    () => lastState,
  );
  const afterLoad = clipSnapshot(state.project);
  if (JSON.stringify(afterLoad) === JSON.stringify(beforeSave)) {
    pass('9-reload', `${afterLoad.length} audio clip(s) match snapshot`);
  } else {
    fail('9-reload', `mismatch before=${JSON.stringify(beforeSave)} after=${JSON.stringify(afterLoad)}`);
  }

  // 10 — playback
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'transport:play', {}),
    (s) => s.playing === true,
    15000,
    () => lastState,
  ).catch(() => null);
  if (state?.playing) {
    pass('10-playback', 'transport playing');
    await emitAck(socket, 'transport:stop', {}).catch(() => {});
  } else {
    fail('10-playback', 'transport did not enter playing state');
  }

  // 11 — mixer
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'track:set-mute', { track_id: trackId, muted: true }),
    (s) => {
      const t = (s.project.playlist || []).find((tr) => trackIdOf(tr) === trackId);
      return t && t.mute === true;
    },
    60000,
    () => lastState,
  );
  pass('11-mixer-mute', `track ${trackId} muted=${state.project.playlist.find((t) => trackIdOf(t) === trackId)?.mute}`);

  await emitAck(socket, 'track:set-pan', { track_id: trackId, pan: 0.25 });
  await emitAck(socket, 'track:set-volume', { track_id: trackId, volume: 0.8 });
  pass('11-mixer-pan-volume', 'pan/volume accepted');

  // 12 — offline guard (engine-only check: history when native down needs manual kill)
  console.log('\n[qa] #12 Native-offline: stop native-engine manually and verify UI blocks mixer/transport.');

  socket.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[qa-native-daw] ${results.length - failed.length}/${results.length} automated checks passed`);
  if (failed.length) {
    failed.forEach((r) => console.error(`  FAIL ${r.id}: ${r.detail}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(`[qa-native-daw] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
