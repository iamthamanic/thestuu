/**
 * Crash-safe persistence and session recovery unit tests.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultProject, serializeProject } from '@thestuu/shared-json';
import {
  findOrphanTempProjectWrites,
  saveProjectAtomic,
  writeProjectFileAtomic,
} from '../src/project-persistence.js';
import {
  buildAutosaveSnapshotPath,
  getRecoveryPaths,
  scanRecoveryCandidates,
  writeSessionMarker,
} from '../src/session-recovery.js';

test('atomic save replaces primary only after validation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stu-atomic-'));
  const target = path.join(dir, 'welcome.stu');
  const project = createDefaultProject();
  await saveProjectAtomic(target, project);
  const raw = await readFile(target, 'utf8');
  assert.match(raw, /"bpm"/);
  const backupPath = `${target}.bak`;
  await assert.rejects(() => stat(backupPath));
  await rm(dir, { recursive: true, force: true });
});

test('interrupted save leaves tmp orphan without corrupting primary', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stu-orphan-'));
  const target = path.join(dir, 'welcome.stu');
  const project = createDefaultProject();
  await saveProjectAtomic(target, project);

  const tmpPath = `${target}.tmp.${process.pid}.interrupted`;
  await writeFile(tmpPath, '{ not valid project json', 'utf8');

  const orphans = await findOrphanTempProjectWrites(dir);
  assert.equal(orphans.length, 1);
  const primaryRaw = await readFile(target, 'utf8');
  assert.match(primaryRaw, /"bpm"/);
  await rm(dir, { recursive: true, force: true });
});

test('recovery detects crash marker and newer autosave', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stu-recovery-'));
  const projectsDir = path.join(home, 'projects');
  const paths = getRecoveryPaths(home);
  await import('node:fs/promises').then((fs) => fs.mkdir(projectsDir, { recursive: true }));
  await import('node:fs/promises').then((fs) => fs.mkdir(paths.autosaveDir, { recursive: true }));

  const primaryPath = path.join(projectsDir, 'welcome.stu');
  const project = createDefaultProject();
  project.meta = { ...(project.meta || {}), label: 'primary' };
  await writeFile(primaryPath, serializeProject(project), 'utf8');

  await new Promise((resolve) => setTimeout(resolve, 5));

  const autosavePath = buildAutosaveSnapshotPath(paths.autosaveDir, primaryPath, Date.now());
  const autosaveProject = createDefaultProject();
  autosaveProject.meta = { ...(autosaveProject.meta || {}), label: 'autosave-newer' };
  await writeFile(autosavePath, serializeProject(autosaveProject), 'utf8');
  await writeFile(paths.latestAutosavePath, serializeProject(autosaveProject), 'utf8');

  await writeSessionMarker(paths.markerPath, {
    pid: 999999,
    dirty: true,
    cleanShutdown: false,
    primaryProjectPath: primaryPath,
  });

  const scan = await scanRecoveryCandidates({
    stuuHome: home,
    projectsDir,
    primaryProjectPath: primaryPath,
    currentPid: process.pid,
  });

  assert.equal(scan.crashDetected, true);
  const newer = scan.candidates.filter((c) => c.newerThanPrimary && c.kind !== 'primary');
  assert.ok(newer.length >= 1);
  await rm(home, { recursive: true, force: true });
});

test('autosave restore candidate validates project file', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stu-restore-'));
  const paths = getRecoveryPaths(home);
  await import('node:fs/promises').then((fs) => fs.mkdir(paths.autosaveDir, { recursive: true }));
  const autosavePath = path.join(paths.autosaveDir, 'welcome.123.autosave.stu');
  const project = createDefaultProject();
  await writeProjectFileAtomic(autosavePath, serializeProject(project));
  const scan = await scanRecoveryCandidates({
    stuuHome: home,
    projectsDir: path.join(home, 'projects'),
    primaryProjectPath: path.join(home, 'projects', 'missing.stu'),
    currentPid: process.pid,
  });
  const match = scan.candidates.find((c) => c.path === autosavePath);
  assert.ok(match);
  assert.equal(match.valid, true);
  await rm(home, { recursive: true, force: true });
});
