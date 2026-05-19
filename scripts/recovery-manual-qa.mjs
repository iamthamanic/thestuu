#!/usr/bin/env node
/**
 * Manual recovery QA against a running native-first engine.
 * Usage: ENGINE_URL=http://127.0.0.1:3990 node scripts/recovery-manual-qa.mjs
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { io } = require('../apps/dashboard/node_modules/socket.io-client/build/cjs/index.js');

const engineUrl = process.env.ENGINE_URL || 'http://127.0.0.1:3990';
const stuuHome = process.env.STUU_HOME || path.join(os.homedir(), '.thestuu');
const projectsDir = path.join(stuuHome, 'projects');
const autosaveDir = path.join(stuuHome, 'autosave');
const primaryPath = path.join(projectsDir, 'welcome.stu');

const results = [];

function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? `: ${detail}` : ''}`);
}

function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
  console.error(`✗ ${name}${detail ? `: ${detail}` : ''}`);
}

function emitAck(socket, event, payload = {}, timeoutMs = 60000) {
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

async function statMtime(filePath) {
  try {
    const s = await fs.stat(filePath);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

async function main() {
  const recoveryLogs = [];
  const socket = io(engineUrl, { transports: ['websocket'], timeout: 15000 });
  socket.on('engine:log', (entry) => {
    if (entry?.category === 'recovery' || String(entry?.text || '').includes('[recovery]')) {
      recoveryLogs.push(entry);
    }
  });

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
  if (!flags.projectSidecar || !flags.clipOps) {
    fail('precheck-native-first', 'engine must run native-first (sidecar + clipOps)');
    process.exit(1);
  }
  pass('precheck-native-first', 'sidecar enabled');

  const healthRes = await fetch(`${engineUrl}/health`);
  const health = await healthRes.json();
  const sessionRecovery = health?.diagnostics?.sessionRecovery;
  if (sessionRecovery && sessionRecovery.autosaveDir) {
    pass('diagnostics-sessionRecovery', `autosaveDir=${sessionRecovery.autosaveDir}`);
  } else {
    fail('diagnostics-sessionRecovery', 'missing diagnostics.sessionRecovery');
  }

  const primaryMtimeBefore = await statMtime(primaryPath);
  if (primaryMtimeBefore == null) {
    fail('primary-exists', primaryPath);
    process.exit(1);
  }

  await emitAck(socket, 'pattern:create', { name: 'Recovery QA Pattern' });
  const autosaveWaitMs = Number(process.env.STUU_AUTOSAVE_INTERVAL_MS) || 6000;
  await new Promise((r) => setTimeout(r, autosaveWaitMs + 1500));

  const primaryMtimeAfterDirty = await statMtime(primaryPath);
  if (primaryMtimeAfterDirty === primaryMtimeBefore) {
    pass('autosave-not-overwrite-primary', 'primary mtime unchanged after dirty session');
  } else {
    fail('autosave-not-overwrite-primary', `mtime changed ${primaryMtimeBefore} -> ${primaryMtimeAfterDirty}`);
  }

  let autosaveFiles = [];
  try {
    autosaveFiles = (await fs.readdir(autosaveDir)).filter((n) => n.endsWith('.autosave.stu'));
  } catch {
    autosaveFiles = [];
  }
  if (autosaveFiles.length > 0) {
    pass('autosave-files-created', `${autosaveFiles.length} snapshot(s) in ${autosaveDir}`);
  } else {
    fail('autosave-files-created', 'no .autosave.stu files (wait longer or lower STUU_AUTOSAVE_INTERVAL_MS)');
  }

  const listRes = await emitAck(socket, 'recovery:list', {});
  const candidates = Array.isArray(listRes.candidates) ? listRes.candidates : [];
  const autosaveCandidates = candidates.filter((c) => String(c.kind || '').includes('autosave'));
  if (autosaveCandidates.length > 0) {
    pass('recovery-list-autosaves', `${autosaveCandidates.length} autosave candidate(s)`);
  } else {
    fail('recovery-list-autosaves', `candidates=${candidates.length}`);
  }

  const latest = autosaveCandidates[0] || candidates.find((c) => c.path?.includes('latest.autosave'));
  if (!latest?.path) {
    fail('recovery-restore-skip', 'no candidate to restore');
  } else {
    const primaryRawBefore = await fs.readFile(primaryPath, 'utf8');
    const restored = await emitAck(socket, 'recovery:restore', { path: latest.path }, 180000);
    const primaryRawAfter = await fs.readFile(primaryPath, 'utf8');
    if (primaryRawBefore === primaryRawAfter) {
      pass('recovery-dismiss-not-delete-primary', 'primary file bytes unchanged after restore (memory-only)');
    } else {
      fail('recovery-restore-primary-unchanged', 'primary file was modified on disk');
    }
    if (restored.ok) {
      pass('recovery-restore-ok', latest.path);
    }
    const stateAfter = await new Promise((resolve) => {
      socket.once('engine:state', resolve);
      setTimeout(() => resolve(null), 5000);
    });
    if (stateAfter?.project) {
      pass('recovery-restore-native-state', 'engine:state received after restore');
    } else {
      fail('recovery-restore-native-state', 'no engine:state after restore');
    }
  }

  await emitAck(socket, 'recovery:dismiss', {});
  const primaryExistsAfterDismiss = await statMtime(primaryPath);
  if (primaryExistsAfterDismiss != null) {
    pass('recovery-dismiss-keeps-primary', primaryPath);
  } else {
    fail('recovery-dismiss-keeps-primary', 'primary missing after dismiss');
  }

  if (recoveryLogs.length > 0) {
    pass('logs-recovery-events', `${recoveryLogs.length} recovery log line(s)`);
  } else {
    fail('logs-recovery-events', 'no engine:log recovery entries observed');
  }

  socket.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[recovery-manual-qa] ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[recovery-manual-qa] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
