/**
 * @thestuu/shared-json – shared project JSON schema and helpers.
 * Used by engine, dashboard, and CLI for project load/save and validation.
 */

const DEFAULT_BPM = 120;
const TRACK_NAME_LIMIT = 25;
const DEFAULT_METRONOME_ENABLED = false;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function defaultTrack(trackId = 1, name) {
  const id = Number.isInteger(trackId) && trackId > 0 ? trackId : 1;
  const n = isNonEmptyString(name) ? name.trim().slice(0, TRACK_NAME_LIMIT) : `Track ${id}`;
  return {
    track_id: id,
    name: n,
    chain_collapsed: true,
    chain_enabled: true,
    clips: [],
  };
}

function defaultMixerEntry(trackId = 1) {
  const id = Number.isInteger(trackId) && trackId > 0 ? trackId : 1;
  return {
    track_id: id,
    volume: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    record_armed: false,
  };
}

/**
 * @param {string} title - Project title
 * @returns {object}
 */
export function createDefaultProject(title) {
  const t = isNonEmptyString(title) ? title.trim() : 'Untitled';
  return {
    title: t,
    bpm: DEFAULT_BPM,
    metronome_enabled: DEFAULT_METRONOME_ENABLED,
    playlist: [defaultTrack(1, 'Track 1')],
    patterns: [],
    mixer: [defaultMixerEntry(1)],
    nodes: [],
  };
}

/**
 * @param {object} project
 * @returns {object}
 */
export function normalizeProject(project) {
  if (!isObject(project)) {
    return createDefaultProject('Untitled');
  }
  const p = { ...project };
  p.title = isNonEmptyString(p.title) ? p.title.trim() : 'Untitled';
  p.bpm = Number.isFinite(p.bpm) && p.bpm > 0 ? Math.round(p.bpm) : DEFAULT_BPM;
  p.metronome_enabled = typeof p.metronome_enabled === 'boolean' ? p.metronome_enabled : DEFAULT_METRONOME_ENABLED;
  p.playlist = Array.isArray(p.playlist) ? p.playlist : [];
  p.patterns = Array.isArray(p.patterns) ? p.patterns : [];
  p.mixer = Array.isArray(p.mixer) ? p.mixer : [];
  p.nodes = Array.isArray(p.nodes) ? p.nodes : [];
  return p;
}

/**
 * @param {string} raw - JSON string of a project
 * @returns {object}
 */
export function parseProject(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return createDefaultProject('Untitled');
  }
  try {
    const data = JSON.parse(raw);
    return normalizeProject(data);
  } catch {
    return createDefaultProject('Untitled');
  }
}

/**
 * @param {object} project
 * @returns {string}
 */
export function serializeProject(project) {
  const p = normalizeProject(project);
  return JSON.stringify(p, null, 2);
}

/**
 * @param {object} project
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateProject(project) {
  const errors = [];
  if (!isObject(project)) {
    errors.push('project must be an object');
    return { ok: false, errors };
  }
  if (!Array.isArray(project.playlist)) errors.push('playlist must be an array');
  if (!Array.isArray(project.patterns)) errors.push('patterns must be an array');
  if (!Array.isArray(project.mixer)) errors.push('mixer must be an array');
  if (!Array.isArray(project.nodes)) errors.push('nodes must be an array');
  if (!Number.isFinite(project.bpm) || project.bpm <= 0) errors.push('bpm must be a positive number');
  if (typeof project.metronome_enabled !== 'boolean') errors.push('metronome_enabled must be a boolean');
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
