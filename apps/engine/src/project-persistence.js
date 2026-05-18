/**
 * Crash-safe project file writes (atomic replace) for .stu JSON sidecars.
 * Location: apps/engine/src — used by server.js save/autosave paths.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  normalizeProject,
  parseProject,
  serializeProject,
  validateProject,
} from '@thestuu/shared-json';

/**
 * @param {string} targetPath
 * @param {string} content
 * @param {{ backup?: boolean }} [options]
 */
export async function writeProjectFileAtomic(targetPath, content, options = {}) {
  const { backup = true } = options;
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, content, 'utf8');

  // Validate written bytes before replacing the primary file.
  const parsed = parseProject(await fs.readFile(tmpPath, 'utf8'));
  const validation = validateProject(parsed);
  if (!validation.ok) {
    await fs.unlink(tmpPath).catch(() => {});
    throw new Error(`autosave validation failed: ${validation.errors.join('; ')}`);
  }

  let backupPath = null;
  if (backup) {
    try {
      await fs.access(targetPath);
      backupPath = `${targetPath}.bak`;
      await fs.copyFile(targetPath, backupPath);
    } catch {
      backupPath = null;
    }
  }

  await fs.rename(tmpPath, targetPath);
  return { path: targetPath, backupPath, validatedProject: parsed };
}

/**
 * @param {string} targetPath
 * @param {unknown} projectData
 * @param {{ backup?: boolean }} [options]
 */
export async function saveProjectAtomic(targetPath, projectData, options = {}) {
  const normalizedProject = normalizeProject(projectData);
  const validation = validateProject(normalizedProject);
  if (!validation.ok) {
    throw new Error(validation.errors.join('; '));
  }
  const content = serializeProject(normalizedProject);
  const writeResult = await writeProjectFileAtomic(targetPath, content, options);
  return {
    project: normalizedProject,
    filePath: writeResult.path,
    backupPath: writeResult.backupPath,
  };
}

/**
 * @param {string} dir
 */
export async function findOrphanTempProjectWrites(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const orphans = [];
  for (const name of entries) {
    if (!name.endsWith('.stu') && name.includes('.tmp.')) {
      const fullPath = path.join(dir, name);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isFile()) {
          orphans.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
        }
      } catch {
        // ignore
      }
    }
  }
  return orphans.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
