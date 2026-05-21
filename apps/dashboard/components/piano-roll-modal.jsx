/**
 * Full-screen Piano Roll editor modal (FL-style tools + purple notes).
 * Location: apps/dashboard/components/piano-roll-modal.jsx
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Eraser,
  MousePointer2,
  Paintbrush,
  Pencil,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import PianoRollView from './piano-roll-view.jsx';
import {
  formatSnapStepLabel,
  normalizeSnapMode,
  resolveGridLineDensity,
  resolveSnapStep,
  SNAP_MODE_OPTIONS,
} from '../lib/daw-snap-mode.js';
import {
  DEFAULT_STEPS_PER_BAR,
  PIANO_ROLL_BAR_WIDTH_PX,
  PIANO_ROLL_MAX_BAR_WIDTH_PX,
  PIANO_ROLL_MIN_BAR_WIDTH_PX,
  patternLengthBarsFromSteps,
  patternLengthStepsFromBars,
  resolvePianoRollVisibleBars,
} from '../lib/piano-roll-layout.js';
import { DEFAULT_PIANO_ROLL_TOOL, PIANO_ROLL_TOOLS } from '../lib/piano-roll-tools.js';

const PATTERN_LOOP_BAR_OPTIONS = [1, 2, 4, 8, 16, 32];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {{
 *   open: boolean,
 *   pattern: object | null,
 *   notes: Array<object>,
 *   clipLengthBars?: number,
 *   patternLoopBars?: number,
 *   playlistViewBars?: number,
 *   playheadBars?: number | null,
 *   onSeekBars?: (localBars: number, options?: { shiftKey?: boolean }) => void,
 *   onSeekEnd?: () => void,
 *   soundLabel?: string,
 *   snapMode?: string,
 *   onSnapModeChange?: (mode: string) => void,
 *   onClose: () => void,
 *   onNotesChange: (notes: Array<object>) => void,
 *   onPatternLengthChange?: (lengthSteps: number) => void,
 *   trackId?: number | null,
 *   onPreviewNote?: (payload: { pitch: number, on: boolean, place?: boolean }) => void,
 * }} props
 */
export default function PianoRollModal({
  open,
  pattern,
  notes = [],
  clipLengthBars = 1,
  patternLoopBars = 1,
  playlistViewBars = 32,
  playheadBars = null,
  onSeekBars,
  onSeekEnd,
  soundLabel = '',
  snapMode = 'auto',
  onSnapModeChange,
  onClose,
  onNotesChange,
  onPatternLengthChange,
  trackId = null,
  onPreviewNote,
}) {
  const [tool, setTool] = useState(DEFAULT_PIANO_ROLL_TOOL);
  const [selectedNoteIds, setSelectedNoteIds] = useState([]);
  const [zoomBarWidth, setZoomBarWidth] = useState(PIANO_ROLL_BAR_WIDTH_PX);

  const resolvedSnapMode = normalizeSnapMode(snapMode);
  const gridLineDensity = useMemo(
    () => resolveGridLineDensity(zoomBarWidth),
    [zoomBarWidth],
  );
  const snapStep = useMemo(
    () => resolveSnapStep(resolvedSnapMode, zoomBarWidth, gridLineDensity),
    [resolvedSnapMode, zoomBarWidth, gridLineDensity],
  );
  const snapStepLabel = formatSnapStepLabel(snapStep);

  const patternName = typeof pattern?.name === 'string' && pattern.name.trim()
    ? pattern.name.trim()
    : 'Pattern';

  const loopBars = Math.max(1, Number(patternLoopBars) || 1);
  const patternLengthBars = patternLengthBarsFromSteps(pattern?.length);
  const totalBars = useMemo(
    () => resolvePianoRollVisibleBars({
      patternLoopBars: loopBars,
      clipLengthBars,
      playlistViewBars,
      notes,
    }),
    [loopBars, clipLengthBars, playlistViewBars, notes],
  );

  useEffect(() => {
    if (open) {
      setZoomBarWidth(PIANO_ROLL_BAR_WIDTH_PX);
      setTool(PIANO_ROLL_TOOLS.SELECT);
      setSelectedNoteIds([]);
    }
  }, [open, pattern?.id]);

  const adjustZoom = useCallback((delta) => {
    setZoomBarWidth((previous) => clamp(
      previous + delta,
      PIANO_ROLL_MIN_BAR_WIDTH_PX,
      PIANO_ROLL_MAX_BAR_WIDTH_PX,
    ));
  }, []);

  const handleModalWheel = useCallback((event) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      adjustZoom(event.deltaY > 0 ? -6 : 6);
    }
  }, [adjustZoom]);

  if (!open || !pattern) {
    return null;
  }

  const ariaLabel = ['Piano roll', patternName, soundLabel].filter(Boolean).join(' — ');

  const toolButtons = [
    { id: PIANO_ROLL_TOOLS.DRAW, label: 'Draw', icon: Pencil },
    { id: PIANO_ROLL_TOOLS.PAINT, label: 'Paint', icon: Paintbrush },
    { id: PIANO_ROLL_TOOLS.SELECT, label: 'Select', icon: MousePointer2 },
    { id: PIANO_ROLL_TOOLS.ERASE, label: 'Erase', icon: Eraser },
  ];

  return (
    <div
      className="piano-roll-modal-overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="piano-roll-modal"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="piano-roll-modal-head">
          <h2>
            Piano roll
            <span className="piano-roll-modal-subtitle">
              {' — '}
              {patternName}
              {soundLabel ? ` — ${soundLabel}` : ''}
            </span>
          </h2>
          <button type="button" className="piano-roll-modal-close" onClick={onClose} aria-label="Schliessen">
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>
        <div className="piano-roll-modal-toolbar" aria-label="Piano roll tools">
          {toolButtons.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`piano-roll-tool-btn${tool === id ? ' active' : ''}`}
              title={label}
              aria-label={label}
              aria-pressed={tool === id}
              onClick={() => setTool(id)}
            >
              <Icon size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          ))}
          <label className="snap-field compact piano-roll-snap-mode-field" title="Snap mode (wie Playlist)">
            <span className="piano-roll-snap-mode-label">SNAP</span>
            <select
              value={resolvedSnapMode}
              aria-label="Snap mode"
              onChange={(event) => {
                onSnapModeChange?.(normalizeSnapMode(event.target.value));
              }}
            >
              {SNAP_MODE_OPTIONS.map((option) => (
                <option key={`pr_snap_${option.id}`} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="piano-roll-snap-step-readout muted" title="Aktuelles Raster">
              {snapStepLabel}
            </span>
          </label>
          {onPatternLengthChange ? (
            <label className="piano-roll-length-control" title="Pattern loop length">
              <span className="piano-roll-length-label">Pattern</span>
              <select
                className="piano-roll-length-select"
                value={String(patternLengthBars)}
                aria-label="Pattern length in bars"
                onChange={(event) => {
                  const bars = Number(event.target.value);
                  onPatternLengthChange(patternLengthStepsFromBars(bars));
                }}
              >
                {PATTERN_LOOP_BAR_OPTIONS.map((bars) => (
                  <option key={`pl_${bars}`} value={bars}>
                    {bars}
                    {' '}
                    {bars === 1 ? 'Bar' : 'Bars'}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="piano-roll-zoom-control" aria-label="Horizontal zoom">
            <button
              type="button"
              className="piano-roll-tool-btn"
              title="Zoom out (Ctrl+Wheel)"
              aria-label="Zoom out"
              onClick={() => adjustZoom(-8)}
            >
              <ZoomOut size={14} strokeWidth={2} aria-hidden="true" />
            </button>
            <span className="piano-roll-zoom-readout muted">{Math.round(zoomBarWidth)}px</span>
            <button
              type="button"
              className="piano-roll-tool-btn"
              title="Zoom in (Ctrl+Wheel)"
              aria-label="Zoom in"
              onClick={() => adjustZoom(8)}
            >
              <ZoomIn size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
          <span className="piano-roll-toolbar-hint muted">
            {tool === PIANO_ROLL_TOOLS.PAINT && 'Ziehen = Noten malen'}
            {tool === PIANO_ROLL_TOOLS.DRAW && 'Ziehen = Laenge · rechte Kante ziehen · Klick Note = loeschen'}
            {tool === PIANO_ROLL_TOOLS.SELECT && 'Ziehen leer = Auswahl · Shift = hinzufuegen · Note ziehen = verschieben · Delete = loeschen'}
            {tool === PIANO_ROLL_TOOLS.ERASE && 'Ziehen = loeschen'}
            {' · Ctrl+Wheel = Zoom'}
          </span>
        </div>
        <div
          className="piano-roll-modal-body"
          onWheel={handleModalWheel}
        >
          <PianoRollView
            notes={notes}
            totalBars={totalBars}
            stepsPerBar={DEFAULT_STEPS_PER_BAR}
            variant="full"
            interactive
            tool={tool}
            snapStep={snapStep}
            playheadBars={playheadBars}
            playheadPatternBars={playheadBars}
            onSeekBars={onSeekBars}
            onSeekEnd={onSeekEnd}
            editorBarWidthPx={zoomBarWidth}
            selectedNoteIds={selectedNoteIds}
            onSelectionChange={setSelectedNoteIds}
            onNotesChange={onNotesChange}
            onPreviewNote={onPreviewNote}
          />
        </div>
      </div>
    </div>
  );
}
