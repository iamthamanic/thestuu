#!/usr/bin/env node
/**
 * Legacy DAW smoke test — engine must run WITHOUT STUU_NATIVE_CLIP_OPS / TRACK_OPS / EDIT_UNDO.
 * Verifies JSON arrangement path still works when native-first flags are off.
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { io } = require('../apps/dashboard/node_modules/socket.io-client/build/cjs/index.js');

const engineUrl = process.env.ENGINE_URL || 'http://127.0.0.1:3990';
const stuuHome = process.env.STUU_HOME || path.join(os.homedir(), '.thestuu');
const TEST_AUDIO = path.join(stuuHome, 'media', 'Sample_YouTube_Video.mp3');

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

async function main() {
  try {
    await fs.access(TEST_AUDIO);
  } catch {
    console.error(`[qa-legacy-daw] test audio missing: ${TEST_AUDIO}`);
    process.exit(1);
  }

  const socket = io(engineUrl, { transports: ['websocket'], timeout: 10000 });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 15000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', reject);
  });

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('engine:ready timeout')), 15000);
    socket.once('engine:ready', (p) => { clearTimeout(timer); resolve(p); });
  });

  const flags = ready.nativeDawFlags || {};
  if (flags.clipOps || flags.trackOps || flags.editUndo) {
    console.error('[qa-legacy-daw] engine has native-first flags enabled — restart engine without STUU_NATIVE_*=1');
    process.exit(1);
  }

  let lastState = null;
  socket.on('engine:state', (s) => { lastState = s; });

  await emitAck(socket, 'project:load', { filename: 'welcome.stu' }, 120000);

  const state = await new Promise((resolve, reject) => {
    if (lastState?.history?.jsonHistory) {
      resolve(lastState);
      return;
    }
    const timer = setTimeout(() => reject(new Error('engine:state timeout')), 30000);
    socket.once('engine:state', (s) => {
      clearTimeout(timer);
      resolve(s);
    });
  });

  if (!state.history?.jsonHistory) {
    console.error('[qa-legacy-daw] expected jsonHistory in engine state');
    process.exit(1);
  }

  const trackId = Number(state.project?.playlist?.[0]?.track_id) || 1;
  const importRes = await emitAck(socket, 'clip:import-file', {
    track_id: trackId,
    source_path: TEST_AUDIO,
    source_name: path.basename(TEST_AUDIO),
    source_format: 'mp3',
    type: 'audio',
    start: 0,
    length: 2,
  }, 120000);

  console.log(`[qa-legacy-daw] OK — legacy import clip ${importRes.clipId} on track ${trackId}`);
  socket.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(`[qa-legacy-daw] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
