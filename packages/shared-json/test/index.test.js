import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultProject, parseProject, serializeProject, validateProject } from '../src/index.js';

test('legacy project clips stay compatible and generate pattern stubs', () => {
  const legacyProject = {
    version: '1.0.0-alpha',
    project_name: 'Legacy Session',
    bpm: 124,
    nodes: [],
    playlist: [
      {
        track_id: 1,
        name: 'Track 1',
        clips: [{ start: 0, length: 4, pattern: 'midi_legacy_1' }],
      },
    ],
    mixer: [{ track_id: 1, volume: 0.85, pan: 0 }],
  };

  const parsed = parseProject(JSON.stringify(legacyProject));
  assert.equal(Array.isArray(parsed.patterns), true);
  assert.equal(parsed.patterns.some((pattern) => pattern.id === 'midi_legacy_1'), true);

  const clip = parsed.playlist[0].clips[0];
  assert.equal(clip.pattern_id, 'midi_legacy_1');
  assert.equal(typeof clip.id, 'string');
});

test('serialize -> parse roundtrip keeps drum pattern and clip fields', () => {
  const project = createDefaultProject('Roundtrip Session');
  project.patterns.push({
    id: 'drum_custom',
    type: 'drum',
    length: 16,
    swing: 0.2,
    steps: [
      { lane: 'Kick', index: 0, velocity: 1 },
      { lane: 'OH', index: 7, velocity: 0.6 },
    ],
  });
  project.playlist[0].clips.push({
    id: 'clip_custom',
    start: 1.25,
    length: 0.75,
    pattern_id: 'drum_custom',
  });

  const serialized = serializeProject(project);
  const parsed = parseProject(serialized);

  const customPattern = parsed.patterns.find((pattern) => pattern.id === 'drum_custom');
  assert.equal(customPattern?.type, 'drum');
  assert.equal(customPattern?.length, 16);
  assert.equal(customPattern?.swing, 0.2);
  assert.equal(customPattern?.steps.length, 2);

  const customClip = parsed.playlist[0].clips.find((clip) => clip.id === 'clip_custom');
  assert.equal(customClip?.pattern_id, 'drum_custom');
  assert.equal(customClip?.start, 1.25);
  assert.equal(customClip?.length, 0.75);
});

test('serialize -> parse roundtrip keeps imported clip metadata', () => {
  const project = createDefaultProject('Imported Clip Session');
  project.playlist[0].clips.push({
    id: 'clip_audio_1',
    start: 2,
    length: 8,
    type: 'audio',
    source_name: 'lead.wav',
    source_format: 'wav',
    source_mime: 'audio/wav',
    source_size_bytes: 128000,
    source_duration_seconds: 12.345678,
    waveform_peaks: [0, 0.12, 0.48, 0.31, 0.08, 0.02],
    source_path: '/tmp/lead.wav',
  });

  const parsed = parseProject(serializeProject(project));
  const importedClip = parsed.playlist[0].clips.find((clip) => clip.id === 'clip_audio_1');

  assert.equal(importedClip?.type, 'audio');
  assert.equal(importedClip?.source_name, 'lead.wav');
  assert.equal(importedClip?.source_format, 'wav');
  assert.equal(importedClip?.source_mime, 'audio/wav');
  assert.equal(importedClip?.source_size_bytes, 128000);
  assert.equal(importedClip?.source_duration_seconds, 12.345678);
  assert.deepEqual(importedClip?.waveform_peaks, [0, 0.12, 0.48, 0.31, 0.08, 0.02]);
  assert.equal(importedClip?.source_path, '/tmp/lead.wav');
});

test('validateProject catches invalid waveform metadata', () => {
  const project = createDefaultProject('Waveform Validation Session');
  project.playlist[0].clips.push({
    id: 'clip_audio_bad',
    start: 0,
    length: 4,
    type: 'audio',
    source_name: 'clip.wav',
    source_format: 'wav',
    source_path: '/tmp/clip.wav',
    source_duration_seconds: -1,
    waveform_peaks: [0.2, 1.4],
  });

  const validation = validateProject(project);
  assert.equal(validation.ok, false);
  assert.equal(validation.errors.some((error) => error.includes('source_duration_seconds')), true);
  assert.equal(validation.errors.some((error) => error.includes('waveform_peaks')), true);
});

test('validateProject catches unknown pattern references', () => {
  const project = createDefaultProject('Validation Session');
  project.playlist[0].clips[0].pattern_id = 'missing_pattern';

  const validation = validateProject(project);
  assert.equal(validation.ok, false);
  assert.equal(validation.errors.some((error) => error.includes('unknown pattern')), true);
});

test('playlist view settings are normalized and preserved', () => {
  const project = createDefaultProject('View Settings Session');
  project.playlist_view_bars = 512;
  project.playlist_bar_width = 128;
  project.playlist_show_track_nodes = false;

  const serialized = serializeProject(project);
  const parsed = parseProject(serialized);

  assert.equal(parsed.playlist_view_bars, 512);
  assert.equal(parsed.playlist_bar_width, 128);
  assert.equal(parsed.playlist_show_track_nodes, false);
});

test('vst node metadata roundtrip keeps routing and parameters', () => {
  const project = createDefaultProject('VST Metadata Session');
  project.nodes.push({
    id: 'vst_meta_1',
    type: 'vst_instrument',
    plugin: 'Ultrasound',
    plugin_uid: 'internal:ultrasound',
    track_id: 3,
    plugin_index: 1,
    bypassed: true,
    params: {
      cutoff: 0.42,
      resonance: 0.31,
    },
    parameter_schema: [
      { id: 'cutoff', name: 'Cutoff', min: 0, max: 1, value: 0.42 },
      { id: 'resonance', name: 'Resonance', min: 0, max: 1, value: 0.31 },
    ],
  });

  const parsed = parseProject(serializeProject(project));
  const node = parsed.nodes.find((entry) => entry.id === 'vst_meta_1');

  assert.equal(node?.plugin_uid, 'internal:ultrasound');
  assert.equal(node?.track_id, 3);
  assert.equal(node?.plugin_index, 1);
  assert.equal(node?.bypassed, true);
  assert.equal(node?.params?.cutoff, 0.42);
  assert.equal(node?.params?.resonance, 0.31);
  assert.equal(Array.isArray(node?.parameter_schema), true);
  assert.equal(node?.parameter_schema?.length, 2);
});

test('track chain collapse flag survives parse roundtrip', () => {
  const project = createDefaultProject('Track Chain Session');
  project.playlist[0].chain_collapsed = false;

  const parsed = parseProject(serializeProject(project));
  assert.equal(parsed.playlist[0]?.chain_collapsed, false);
  assert.equal(parsed.playlist[1]?.chain_collapsed, true);
});

test('mixer flags and pan/volume survive parse roundtrip', () => {
  const project = createDefaultProject('Mixer Flags Session');
  project.mixer[0].mute = true;
  project.mixer[0].solo = true;
  project.mixer[0].record_armed = true;
  project.mixer[0].pan = -0.35;
  project.mixer[0].volume = 0.93;

  const parsed = parseProject(serializeProject(project));
  const trackOne = parsed.mixer.find((entry) => entry.track_id === 1);

  assert.equal(trackOne?.mute, true);
  assert.equal(trackOne?.solo, true);
  assert.equal(trackOne?.record_armed, true);
  assert.equal(trackOne?.pan, -0.35);
  assert.equal(trackOne?.volume, 0.93);
});
