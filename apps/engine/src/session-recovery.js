/**
 * Session markers, autosave snapshots, and recovery candidate discovery.
 * Location: apps/engine/src — orchestration only; project truth stays native-first via caller.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseProject, validateProject } from '@thestuu/shared-json';
import { findOrphanTempProjectWrites } from './project-persistence.js';

/**
 * @param {string} stuuHome
 */
export function getRecoveryPaths(stuuHome) {
  return {
    sessionDir: path.join(stuuHome, 'session'),
    autosaveDir: path.join(stuuHome, 'autosave'),
    markerPath: path.join(stuuHome, 'session', 'runtime.json'),
    latestAutosavePath: path.join(stuuHome, 'autosave', 'latest.autosave.stu'),
  };
}

/**
 * @param {string} markerPath
 */
export async function readSessionMarker(markerPath) {
  try {
    const raw = await fs.readFile(markerPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} markerPath
 * @param {Record<string, unknown>} patch
 */
export async function writeSessionMarker(markerPath, patch) {
  const dir = path.dirname(markerPath);
  await fs.mkdir(dir, { recursive: true });
  const existing = (await readSessionMarker(markerPath)) || {};
  const next = {
    ...existing,
    ...patch,
    updatedAtMs: Date.now(),
  };
  const tmp = `${markerPath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, markerPath);
  return next;
}

/**
 * @param {string} filePath
 */
export async function statProjectFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * @param {string} autosaveDir
 */
export async function listAutosaveSnapshots(autosaveDir) {
  let names = [];
  try {
    names = await fs.readdir(autosaveDir);
  } catch {
    return [];
  }
  const snapshots = [];
  for (const name of names) {
    if (!name.endsWith('.autosave.stu')) {
      continue;
    }
    const fullPath = path.join(autosaveDir, name);
    const stat = await statProjectFile(fullPath);
    if (stat) {
      snapshots.push({ ...stat, name });
    }
  }
  return snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * @param {string} filePath
 */
export async function validateProjectFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const project = parseProject(raw);
    const validation = validateProject(project);
    return { ok: validation.ok, errors: validation.errors, project };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      project: null,
    };
  }
}

/**
 * @param {{
 *   stuuHome: string,
 *   projectsDir: string,
 *   primaryProjectPath: string,
 *   currentPid?: number,
 * }} options
 */
export async function scanRecoveryCandidates(options) {
  const { stuuHome, projectsDir, primaryProjectPath, currentPid = process.pid } = options;
  const paths = getRecoveryPaths(stuuHome);
  const marker = await readSessionMarker(paths.markerPath);
  const primaryStat = await statProjectFile(primaryProjectPath);
  const autosaves = await listAutosaveSnapshots(paths.autosaveDir);
  const orphans = await findOrphanTempProjectWrites(projectsDir);
  const latestStat = await statProjectFile(paths.latestAutosavePath);

  const crashDetected = Boolean(
    marker
    && marker.cleanShutdown === false
    && marker.pid !== currentPid
    && marker.dirty === true,
  );

  /** @type {Array<Record<string, unknown>>} */
  const candidates = [];

  if (latestStat) {
    const valid = await validateProjectFile(latestStat.path);
    if (valid.ok) {
      candidates.push({
        id: 'latest-autosave',
        kind: 'autosave-latest',
        path: latestStat.path,
        label: 'Latest autosave snapshot',
        mtimeMs: latestStat.mtimeMs,
        newerThanPrimary: primaryStat ? latestStat.mtimeMs > primaryStat.mtimeMs : true,
        valid: true,
      });
    }
  }

  for (const snap of autosaves.slice(0, 8)) {
    const valid = await validateProjectFile(snap.path);
    if (!valid.ok) {
      continue;
    }
    candidates.push({
      id: `autosave-${snap.name}`,
      kind: 'autosave',
      path: snap.path,
      label: snap.name,
      mtimeMs: snap.mtimeMs,
      newerThanPrimary: primaryStat ? snap.mtimeMs > primaryStat.mtimeMs : true,
      valid: true,
    });
  }

  for (const orphan of orphans.slice(0, 3)) {
    const valid = await validateProjectFile(orphan.path);
    if (!valid.ok) {
      continue;
    }
    candidates.push({
      id: `orphan-${path.basename(orphan.path)}`,
      kind: 'orphan-temp',
      path: orphan.path,
      label: path.basename(orphan.path),
      mtimeMs: orphan.mtimeMs,
      newerThanPrimary: primaryStat ? orphan.mtimeMs > primaryStat.mtimeMs : true,
      valid: true,
    });
  }

  if (primaryStat?.path) {
    const valid = await validateProjectFile(primaryStat.path);
    candidates.push({
      id: 'primary',
      kind: 'primary',
      path: primaryStat.path,
      label: path.basename(primaryStat.path),
      mtimeMs: primaryStat.mtimeMs,
      newerThanPrimary: false,
      valid: valid.ok,
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const entry of candidates) {
    if (seen.has(entry.path)) {
      continue;
    }
    seen.add(entry.path);
    deduped.push(entry);
  }

  deduped.sort((a, b) => Number(b.mtimeMs) - Number(a.mtimeMs));

  return {
    crashDetected,
    marker,
    primaryProjectPath,
    paths,
    candidates: deduped,
    lastAutosaveAtMs: marker?.lastAutosaveAtMs ?? latestStat?.mtimeMs ?? null,
    lastSaveError: marker?.lastSaveError ?? null,
    lastRestoreResult: marker?.lastRestoreResult ?? null,
  };
}

/**
 * @param {string} primaryProjectPath
 * @param {number} [nowMs]
 */
export function buildAutosaveSnapshotPath(autosaveDir, primaryProjectPath, nowMs = Date.now()) {
  const base = path.basename(primaryProjectPath, '.stu') || 'project';
  return path.join(autosaveDir, `${base}.${nowMs}.autosave.stu`);
}
