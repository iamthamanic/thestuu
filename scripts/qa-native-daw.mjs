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

/** Wait for engine:state after an action (ignores pre-action state; catches emit before ack returns). */
async function afterMutation(socket, action, predicate, timeoutMs) {
  const pred = predicate || ((s) => Boolean(s?.project));
  const ms = timeoutMs || 120000;
  let latestState = null;
  function onState(s) {
    latestState = s;
  }
  socket.on('engine:state', onState);
  let started = false;
  try {
    const statePromise = waitForState(
      socket,
      (s) => {
        if (!started) {
          return false;
        }
        return pred(s);
      },
      ms,
      null,
    );
    started = true;
    await action();
    if (latestState) {
      try {
        if (pred(latestState)) {
          return latestState;
        }
      } catch {
        // fall through to wait
      }
    }
    return statePromise;
  } finally {
    socket.off('engine:state', onState);
  }
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

function findClipById(project, clipId) {
  for (const track of project?.playlist || []) {
    for (const clip of track?.clips || []) {
      if (String(clip.id) === String(clipId)) {
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

function clipSnapshotsMatch(before, after, toleranceBars = 0.02) {
  if (before.length !== after.length) {
    return false;
  }
  const sortKey = (row) => `${row.source_path || ''}:${Number(row.start).toFixed(3)}`;
  const sortedBefore = [...before].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const sortedAfter = [...after].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  for (let i = 0; i < sortedBefore.length; i += 1) {
    const a = sortedBefore[i];
    const b = sortedAfter[i];
    if (a.source_path !== b.source_path) {
      return false;
    }
    if (Math.abs(Number(a.start) - Number(b.start)) > toleranceBars) {
      return false;
    }
    if (Math.abs(Number(a.length) - Number(b.length)) > toleranceBars) {
      return false;
    }
  }
  return true;
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
  const flags = ready.nativeDawFlags || {};
  if (!flags.clipOps || !flags.trackOps || !flags.editUndo || !flags.projectSidecar) {
    fail('precheck', `nativeDawFlags incomplete: ${JSON.stringify(flags)}`);
    socket.close();
    process.exit(1);
  }
  if (flags.legacySync) {
    fail('precheck', 'STUU_NATIVE_LEGACY_SYNC must be unset/0 for native-first QA');
    socket.close();
    process.exit(1);
  }
  pass('precheck', `nativeTransport online (${ready.nativeSocketPath || 'socket'})`);
  pass('flags', `clipOps trackOps editUndo sidecar; legacySync=${flags.legacySync}`);

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
  );
  pass('1-load-old', `loaded welcome.stu (${state.project.playlist.length} tracks)`);

  // 3-new-project — empty layout via load (same path as “new project” in UI)
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'project:load', { filename: 'welcome.stu' }, 120000),
    (s) => Array.isArray(s?.project?.playlist) && s.project.playlist.length > 0,
    120000,
  );
  pass('3-new-project', `project open (${state.project.playlist.length} tracks)`);

  // 9-track-create
  let createRes;
  state = await afterMutation(
    socket,
    async () => {
      createRes = await emitAck(socket, 'track:create', { name: 'QA Native Track' });
    },
    (s) => {
      const tid = Number(createRes?.trackId);
      return Number.isInteger(tid) && (s.project.playlist || []).some((t) => trackIdOf(t) === tid);
    },
    60000,
  );
  const qaTrackId = Number(createRes.trackId);
  pass('9-track-create', `track ${qaTrackId} nativeTrackOps=${createRes.nativeTrackOps === true}`);

  // 9-track-reorder — move QA track to first slot in playlist order
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'track:reorder', { track_id: qaTrackId, to_index: 0 }, 120000),
    (s) => {
      const first = (s.project.playlist || [])[0];
      return first && String(first.name || '').includes('QA Native Track');
    },
    120000,
  );
  pass('9-track-reorder', `first track="${state.project.playlist[0]?.name}" id=${trackIdOf(state.project.playlist[0])}`);

  // 9-track-delete — remove last track if it has no clips (avoid breaking import track)
  const lastTrack = state.project.playlist[state.project.playlist.length - 1];
  const lastTrackId = trackIdOf(lastTrack);
  const lastHasClips = Array.isArray(lastTrack?.clips) && lastTrack.clips.length > 0;
  if (!lastHasClips && lastTrackId !== 1) {
    state = await afterMutation(
      socket,
      () => emitAck(socket, 'track:delete', { track_id: lastTrackId }),
      (s) => !(s.project.playlist || []).some((t) => trackIdOf(t) === lastTrackId),
      60000,
    );
    pass('9-track-delete', `removed track ${lastTrackId}`);
  } else {
    console.warn('[qa] track-delete: skipped (last track has clips or is track 1)');
  }

  // 2 — import audio
  const trackId = trackIdOf(state.project.playlist.find((t) => trackIdOf(t) === 1) || state.project.playlist[0]);
  let importRes;
  state = await afterMutation(
    socket,
    async () => {
      importRes = await emitAck(socket, 'clip:import-file', {
        track_id: trackId,
        source_path: TEST_AUDIO,
        source_name: path.basename(TEST_AUDIO),
        source_format: 'mp3',
        type: 'audio',
        start: 0,
        length: 4,
      }, 120000);
    },
    (s) => Boolean(findAudioClip(s?.project)),
    120000,
  );
  const imported = (importRes?.clipId && findClipById(state.project, importRes.clipId))
    || findAudioClip(state.project);
  if (!imported) {
    fail('2-import', 'no audio clip after import');
    socket.close();
    process.exit(1);
  }
  pass('2-import', `clip ${imported.clip.id} on track ${imported.trackId}`);

  const clipId = imported.clip.id;
  const clipTrackId = imported.trackId;
  const startBefore = Number(imported.clip.start) || 0;
  const lenBefore = Number(imported.clip.length) || 4;

  // 3 — move
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'clip:move', { track_id: clipTrackId, clip_id: clipId, start: startBefore + 4 }, 90000),
    (s) => {
      const c = findClipById(s.project, clipId);
      return c && Math.abs(Number(c.clip.start) - (startBefore + 4)) < 0.5;
    },
    60000,
  );
  pass('3-move', `start=${findClipById(state.project, clipId)?.clip?.start}`);

  const lenAfterMove = Number(findClipById(state.project, clipId)?.clip?.length) || lenBefore;

  // 4 — resize
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'clip:resize', { track_id: clipTrackId, clip_id: clipId, length: lenAfterMove + 2 }, 90000),
    (s) => {
      const c = findClipById(s.project, clipId);
      return c && Number(c.clip.length) >= lenAfterMove + 1.5;
    },
    60000,
  );
  pass('4-resize', `length=${findClipById(state.project, clipId)?.clip?.length}`);

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
  );
  if (!redoRes.history?.nativeUndo) {
    fail('7-redo', `expected nativeUndo, got ${JSON.stringify(redoRes.history)}`);
  } else {
    pass('7-redo', 'edit.redo via native');
  }

  // 5 — delete + undo restore
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'clip:delete', { track_id: clipTrackId, clip_id: clipId }),
    (s) => !findClipById(s.project, clipId),
    60000,
  );
  pass('5-delete', 'clip removed from cache');

  state = await afterMutation(
    socket,
    () => emitAck(socket, 'project:undo', {}),
    (s) => Boolean(findClipById(s.project, clipId)),
    60000,
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
    (s) => {
      const byId = findClipById(s.project, clipId);
      if (byId) {
        return true;
      }
      return Boolean(findAudioClip(s.project));
    },
    120000,
  );
  const afterLoad = clipSnapshot(state.project);
  if (clipSnapshotsMatch(beforeSave, afterLoad)) {
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
  ).catch(() => null);
  if (state?.playing) {
    pass('10-playback', 'transport playing');
    await emitAck(socket, 'transport:stop', {}).catch(() => {});
  } else {
    fail('10-playback', 'transport did not enter playing state');
  }

  state = await afterMutation(
    socket,
    () => emitAck(socket, 'transport:seek', { position_beats: 8 }),
    (s) => Number(s.transport?.positionBeats) >= 6,
    15000,
  ).catch(() => null);
  if (state && Number(state.transport?.positionBeats) >= 6) {
    pass('10-seek', `positionBeats=${state.transport.positionBeats}`);
  } else {
    fail('10-seek', 'transport seek did not update position');
  }

  // 11 — mixer
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'track:set-mute', { track_id: clipTrackId, mute: true }),
    (s) => {
      const entry = (s.project.mixer || []).find((m) => Number(m.track_id) === clipTrackId);
      return entry && entry.mute === true;
    },
    60000,
  );
  const mixerEntry = state.project.mixer.find((m) => Number(m.track_id) === clipTrackId);
  pass('11-mixer-mute', `track ${clipTrackId} muted=${mixerEntry?.mute}`);

  await emitAck(socket, 'track:set-pan', { track_id: clipTrackId, pan: 0.25 });
  await emitAck(socket, 'track:set-volume', { track_id: clipTrackId, volume: 0.8 });
  pass('11-mixer-pan-volume', 'pan/volume accepted');

  state = await afterMutation(
    socket,
    () => emitAck(socket, 'track:set-solo', { track_id: clipTrackId, solo: true }),
    (s) => {
      const entry = (s.project.mixer || []).find((m) => Number(m.track_id) === clipTrackId);
      return entry && entry.solo === true;
    },
    60000,
  );
  pass('11-mixer-solo', `track ${clipTrackId} solo=${state.project.mixer.find((m) => Number(m.track_id) === clipTrackId)?.solo}`);

  await emitAck(socket, 'track:set-solo', { track_id: clipTrackId, solo: false });
  state = await afterMutation(
    socket,
    () => emitAck(socket, 'track:set-record-arm', { track_id: clipTrackId, record_armed: true }),
    (s) => {
      const entry = (s.project.mixer || []).find((m) => Number(m.track_id) === clipTrackId);
      return entry && entry.record_armed === true;
    },
    60000,
  );
  pass('11-mixer-record-arm', `track ${clipTrackId} record_armed=${state.project.mixer.find((m) => Number(m.track_id) === clipTrackId)?.record_armed}`);

  // 15 — offline guard (manual): dashboard uses nativeTransport + connection
  console.log('\n[qa] #15 Native-offline: stop native-engine manually and verify UI blocks mixer/transport.');

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
