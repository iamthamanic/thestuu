/**
 * Stop stale TheStuu dev processes and remove the canonical native socket.
 * Used by `npm run dev` so CLI, Engine, and Tauri share one stack.
 */

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Same default as apps/engine and Tauri native_health. */
export const CANONICAL_NATIVE_SOCKET = process.platform === 'win32'
  ? '\\\\.\\pipe\\thestuu-native'
  : '/tmp/thestuu-native.sock';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killPids(pids, signal = 'SIGTERM') {
  for (const pid of pids) {
    const n = Number(pid);
    if (!Number.isFinite(n) || n <= 0 || n === process.pid) {
      continue;
    }
    try {
      process.kill(n, signal);
    } catch {
      // already gone
    }
  }
}

async function listListenPidsOnPort(port) {
  if (process.platform === 'win32') {
    return [];
  }

  const patterns = [
    ['-nP', `-iTCP:${port}@127.0.0.1`, '-sTCP:LISTEN', '-t'],
    ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
    ['-ti', `:${port}`, '-sTCP:LISTEN'],
  ];

  for (const args of patterns) {
    try {
      const { stdout } = await execFileAsync('lsof', args, { maxBuffer: 1024 * 1024 });
      const pids = [...new Set(stdout.split('\n').map((l) => l.trim()).filter((l) => /^[0-9]+$/.test(l)))];
      if (pids.length) {
        return pids;
      }
    } catch {
      // try next pattern
    }
  }

  return [];
}

/**
 * @param {number} port
 */
export async function killListenersOnPort(port) {
  const pids = await listListenPidsOnPort(port);
  if (!pids.length) {
    return [];
  }

  await killPids(pids, 'SIGTERM');
  await sleep(400);
  await killPids(pids, 'SIGKILL');
  return pids;
}

export async function killTheStuuEngineProcesses() {
  if (process.platform === 'win32') {
    return [];
  }

  const patterns = [
    ['-f', '[a]pps/engine/src/server.js'],
    ['-f', '[t]hestuu.*server.js'],
  ];
  const killed = [];

  for (const args of patterns) {
    try {
      const { stdout } = await execFileAsync('pgrep', args, { maxBuffer: 256 * 1024 });
      const pids = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      if (pids.length) {
        await killPids(pids, 'SIGTERM');
        killed.push(...pids);
      }
    } catch {
      // none
    }
  }

  if (killed.length) {
    await sleep(300);
    await killPids(killed, 'SIGKILL');
  }

  return [...new Set(killed)];
}

/**
 * @param {object} options
 * @param {number} [options.enginePort]
 * @param {number} [options.dashboardPort]
 * @param {string} [options.nativeSocket]
 */
export async function cleanDevSession(options = {}) {
  const enginePort = options.enginePort ?? 3990;
  const dashboardPort = options.dashboardPort ?? 3010;
  const nativeSocket = options.nativeSocket ?? CANONICAL_NATIVE_SOCKET;

  console.log('[thestuu-cli] cleaning previous dev session…');

  const enginePids = await killListenersOnPort(enginePort);
  const engineNodePids = await killTheStuuEngineProcesses();
  const dashPids = await killListenersOnPort(dashboardPort);

  if (enginePids.length || engineNodePids.length) {
    console.log(
      `[thestuu-cli] stopped engine on :${enginePort} (pids: ${[...new Set([...enginePids, ...engineNodePids])].join(', ')})`,
    );
  }
  if (dashPids.length) {
    console.log(`[thestuu-cli] stopped dashboard listener(s) on :${dashboardPort} (pids: ${dashPids.join(', ')})`);
  }

  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-f', '[t]hestuu-native'], { maxBuffer: 256 * 1024 });
      const nativePids = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      if (nativePids.length) {
        await killPids(nativePids, 'SIGTERM');
        await sleep(300);
        await killPids(nativePids, 'SIGKILL');
        console.log(`[thestuu-cli] stopped thestuu-native (pids: ${nativePids.join(', ')})`);
      }
    } catch {
      // none running
    }
  }

  try {
    await fs.unlink(nativeSocket);
    console.log(`[thestuu-cli] removed stale socket: ${nativeSocket}`);
  } catch {
    // absent
  }

  await sleep(200);
}
