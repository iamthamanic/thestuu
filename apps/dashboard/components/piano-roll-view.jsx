/**
 * Piano roll grid + purple MIDI notes (FL-style keys, tools: draw/paint/select/erase).
 * Visual theme: shared CSS variables on `.piano-roll-view` (mini clip + full modal).
 * Location: apps/dashboard/components/piano-roll-view.jsx
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { playlistRulerBarLabels } from '../lib/playlist-grid-sync.js';
import {
  addNoteAtCell,
  buildPitchRows,
  createNoteId,
  DEFAULT_PITCH_MAX,
  DEFAULT_PITCH_MIN,
  DEFAULT_STEPS_PER_BAR,
  hitTestNotes,
  layoutNoteRects,
  PIANO_ROLL_BAR_WIDTH_PX,
  PIANO_ROLL_MAX_VISIBLE_BARS,
  PIANO_ROLL_GRID_STEP,
  PIANO_ROLL_KEY_WIDTH_PX,
  PIANO_ROLL_ROW_HEIGHT_PX,
  pointerToCell,
  removeNoteById,
  removeNotesAtCell,
  removeNotesByIds,
  resizeNoteById,
  snapBar,
} from '../lib/piano-roll-layout.js';
import { DEFAULT_PIANO_ROLL_TOOL, PIANO_ROLL_TOOLS } from '../lib/piano-roll-tools.js';
import { syncPlayheadBarNotes } from '../lib/playlist-bar-pulse.js';

const MINI_ROW_HEIGHT_PX = 8;
const PLAYHEAD_SCRUB_EDGE_PX = 24;
const PLAYHEAD_SCRUB_SCROLL_PX = 24;

/** @param {EventTarget | null} target */
function isEditableKeyboardTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/** @param {Array<object>} notes */
function allNoteIdsFromNotes(notes) {
  const ids = [];
  const seen = new Set();
  for (const note of notes || []) {
    const id = note?.id;
    if (id == null || id === '') {
      continue;
    }
    const key = String(id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ids.push(key);
  }
  return ids;
}

/**
 * @param {{
 *   notes: Array<object>,
 *   totalBars?: number,
 *   stepsPerBar?: number,
 *   pitchMin?: number,
 *   pitchMax?: number,
 *   variant?: 'mini' | 'full',
 *   interactive?: boolean,
 *   tool?: string,
 *   snapStep?: number,
 *   selectedNoteIds?: string[],
 *   onSelectionChange?: (ids: string[]) => void,
 *   onNotesChange?: (notes: Array<object>) => void,
 *   playheadBars?: number | null,
 *   onSeekBars?: (localBars: number, options?: { shiftKey?: boolean }) => void,
 *   onSeekEnd?: () => void,
 *   syncPlaylistGrid?: boolean,
 *   timelineBarWidthPx?: number,
 *   gridPhaseOffsetPx?: number,
 *   clipStartBars?: number,
 *   clipLengthBars?: number,
 *   editorBarWidthPx?: number,
 *   onRequestOpen?: () => void,
 *   onPreviewNote?: (payload: { pitch: number, on: boolean, place?: boolean }) => void,
 *   className?: string,
 * }} props
 */
export default function PianoRollView({
  notes = [],
  totalBars = 4,
  stepsPerBar = DEFAULT_STEPS_PER_BAR,
  pitchMin = DEFAULT_PITCH_MIN,
  pitchMax = DEFAULT_PITCH_MAX,
  variant = 'mini',
  interactive = false,
  tool = DEFAULT_PIANO_ROLL_TOOL,
  snapStep = PIANO_ROLL_GRID_STEP,
  playheadBars = null,
  onSeekBars,
  onSeekEnd,
  syncPlaylistGrid = false,
  timelineBarWidthPx = 0,
  gridPhaseOffsetPx = 0,
  clipStartBars = 0,
  clipLengthBars = 1,
  patternLoopBars = 1,
  playheadPatternBars = null,
  editorBarWidthPx = 0,
  selectedNoteIds = [],
  onSelectionChange,
  onNotesChange,
  onRequestOpen,
  onPreviewNote,
  className = '',
}) {
  const gridRef = useRef(null);
  const keysRef = useRef(null);
  const scrollRef = useRef(null);
  const rulerTrackRef = useRef(null);
  const rulerScrubHandlersRef = useRef(/** @type {{ handleMove: (e: PointerEvent) => void, handleUp: (e: PointerEvent) => void, handleCancel: () => void } | null} */ (null));
  const interactionRef = useRef(null);
  const notesRef = useRef(notes);
  const marqueeElRef = useRef(null);
  const marqueeRectRef = useRef(null);
  const marqueeRafRef = useRef(0);
  const draftNoteElRef = useRef(null);
  const draftNoteRectRef = useRef(null);
  const draftNoteRafRef = useRef(0);
  const activePitchRef = useRef(null);
  const activeKeyElRef = useRef(null);
  const activeRowElRef = useRef(null);
  const pitchDomRef = useRef(/** @type {{ keys: Map<number, Element>, rows: Map<number, Element> }} */ ({
    keys: new Map(),
    rows: new Map(),
  }));
  const pointerMoveHandlerRef = useRef(/** @type {((event: PointerEvent) => void) | null} */ (null));
  const windowMoveListenerRef = useRef(/** @type {((event: PointerEvent) => void) | null} */ (null));
  const pointerMoveAttachedRef = useRef(false);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  const isFull = variant === 'full';
  const bars = Math.max(1, Math.min(PIANO_ROLL_MAX_VISIBLE_BARS, Math.round(Number(totalBars) || 1)));
  const steps = Math.max(4, Math.round(Number(stepsPerBar) || DEFAULT_STEPS_PER_BAR));
  const rowHeightPx = isFull ? PIANO_ROLL_ROW_HEIGHT_PX : MINI_ROW_HEIGHT_PX;
  const syncPlaylist = !isFull && syncPlaylistGrid && Number(timelineBarWidthPx) > 0;
  const editorZoomWidth = Number(editorBarWidthPx);
  const barWidthPx = syncPlaylist
    ? Number(timelineBarWidthPx)
    : (isFull && Number.isFinite(editorZoomWidth) && editorZoomWidth > 0
      ? editorZoomWidth
      : (isFull ? PIANO_ROLL_BAR_WIDTH_PX : Math.max(12, Math.floor(120 / bars))));
  const keyWidthPx = isFull ? 88 : 0;
  const gridOffsetPx = syncPlaylist ? Math.max(0, Number(gridPhaseOffsetPx) || 0) : 0;

  const pitchRows = useMemo(() => buildPitchRows(pitchMin, pitchMax), [pitchMin, pitchMax]);
  const rowCount = pitchRows.length;
  const gridWidthPx = bars * barWidthPx;
  const gridHeightPx = rowCount * rowHeightPx;

  const layoutConfig = useMemo(() => ({
    totalBars: bars,
    pitchMin,
    pitchMax,
    barWidthPx,
    rowHeightPx,
  }), [bars, pitchMin, pitchMax, barWidthPx, rowHeightPx]);

  const noteRects = useMemo(
    () => layoutNoteRects(notes, layoutConfig),
    [notes, layoutConfig],
  );

  const barNumbers = useMemo(() => Array.from({ length: bars }, (_, i) => i + 1), [bars]);
  const playlistRulerLabels = useMemo(() => {
    if (!syncPlaylist) {
      return [];
    }
    return playlistRulerBarLabels(clipStartBars, bars);
  }, [syncPlaylist, clipStartBars, bars]);
  const selectedSet = useMemo(() => new Set((selectedNoteIds || []).map(String)), [selectedNoteIds]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      return;
    }
    const patternBar = Number.isFinite(Number(playheadPatternBars))
      ? Number(playheadPatternBars)
      : (isFull && Number.isFinite(Number(playheadBars)) ? Number(playheadBars) : null);
    syncPlayheadBarNotes(grid, patternBar);
  }, [isFull, playheadBars, playheadPatternBars, notes]);

  const getGridRect = useCallback(() => gridRef.current?.getBoundingClientRect() ?? null, []);

  const scheduleMarqueePaint = useCallback(() => {
    if (marqueeRafRef.current) {
      return;
    }
    marqueeRafRef.current = requestAnimationFrame(() => {
      marqueeRafRef.current = 0;
      applyMarqueeDom(marqueeElRef.current, marqueeRectRef.current);
    });
  }, []);

  const setMarqueeVisual = useCallback((rect) => {
    marqueeRectRef.current = rect;
    scheduleMarqueePaint();
  }, [scheduleMarqueePaint]);

  const clearMarqueeVisual = useCallback(() => {
    marqueeRectRef.current = null;
    scheduleMarqueePaint();
  }, [scheduleMarqueePaint]);

  const scheduleDraftNotePaint = useCallback((note) => {
    if (!note) {
      draftNoteRectRef.current = null;
      if (draftNoteRafRef.current) {
        return;
      }
      draftNoteRafRef.current = requestAnimationFrame(() => {
        draftNoteRafRef.current = 0;
        applyDraftNoteDom(draftNoteElRef.current, null);
      });
      return;
    }
    const rects = layoutNoteRects([note], layoutConfig);
    draftNoteRectRef.current = rects[0] || null;
    if (draftNoteRafRef.current) {
      return;
    }
    draftNoteRafRef.current = requestAnimationFrame(() => {
      draftNoteRafRef.current = 0;
      applyDraftNoteDom(draftNoteElRef.current, draftNoteRectRef.current);
    });
  }, [layoutConfig]);

  const clearDraftNoteVisual = useCallback(() => {
    scheduleDraftNotePaint(null);
  }, [scheduleDraftNotePaint]);

  const setActivePitchVisual = useCallback((pitch) => {
    const prev = activePitchRef.current;
    if (prev === pitch) {
      return;
    }
    if (activeKeyElRef.current) {
      activeKeyElRef.current.classList.remove('is-active');
      activeKeyElRef.current = null;
    }
    if (activeRowElRef.current) {
      activeRowElRef.current.classList.remove('is-pitch-active');
      activeRowElRef.current = null;
    }
    activePitchRef.current = pitch;
    if (pitch != null) {
      const { keys, rows } = pitchDomRef.current;
      const keyEl = keys.get(pitch);
      const rowEl = rows.get(pitch);
      if (keyEl) {
        keyEl.classList.add('is-active');
        activeKeyElRef.current = keyEl;
      }
      if (rowEl) {
        rowEl.classList.add('is-pitch-active');
        activeRowElRef.current = rowEl;
      }
      if (typeof onPreviewNote === 'function' && pitch !== prev) {
        onPreviewNote({ pitch, on: true });
      }
    } else if (typeof onPreviewNote === 'function' && prev != null) {
      onPreviewNote({ pitch: prev, on: false });
    }
  }, [onPreviewNote]);

  const attachWindowPointerMove = useCallback(() => {
    if (pointerMoveAttachedRef.current) {
      return;
    }
    pointerMoveAttachedRef.current = true;
    const onMove = (event) => pointerMoveHandlerRef.current?.(event);
    windowMoveListenerRef.current = onMove;
    window.addEventListener('pointermove', onMove, { passive: false });
  }, []);

  const detachWindowPointerMove = useCallback(() => {
    const onMove = windowMoveListenerRef.current;
    if (!onMove) {
      return;
    }
    window.removeEventListener('pointermove', onMove);
    windowMoveListenerRef.current = null;
    pointerMoveAttachedRef.current = false;
  }, []);

  const setSelection = useCallback((ids) => {
    onSelectionChange?.(ids);
  }, [onSelectionChange]);

  const captureGridPointer = useCallback((event) => {
    const grid = gridRef.current;
    if (!grid || typeof grid.setPointerCapture !== 'function') {
      return;
    }
    try {
      grid.setPointerCapture(event.pointerId);
    } catch {
      /* ignore if capture not allowed */
    }
  }, []);

  const bindInteraction = useCallback((state, event) => {
    interactionRef.current = state;
    attachWindowPointerMove();
    captureGridPointer(event);
  }, [attachWindowPointerMove, captureGridPointer]);

  const releaseGridPointer = useCallback((pointerId) => {
    const grid = gridRef.current;
    if (!grid || typeof grid.releasePointerCapture !== 'function' || pointerId == null) {
      return;
    }
    try {
      if (grid.hasPointerCapture?.(pointerId)) {
        grid.releasePointerCapture(pointerId);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const endInteraction = useCallback(() => {
    const pointerId = interactionRef.current?.pointerId;
    interactionRef.current = null;
    clearMarqueeVisual();
    clearDraftNoteVisual();
    detachWindowPointerMove();
    releaseGridPointer(pointerId);
    if (typeof document !== 'undefined') {
      document.body.style.cursor = '';
    }
    if (gridRef.current) {
      gridRef.current.style.cursor = '';
    }
  }, [releaseGridPointer, clearMarqueeVisual, clearDraftNoteVisual, detachWindowPointerMove]);

  const beginNoteResize = useCallback((event, noteId) => {
    const note = notesRef.current.find((n) => String(n.id) === String(noteId));
    bindInteraction({
      mode: 'resize',
      noteId,
      pointerId: event.pointerId,
      originX: event.clientX,
      originLength: Number(note?.length) || snapStep,
    }, event);
    if (tool === PIANO_ROLL_TOOLS.SELECT) {
      setSelection([noteId]);
    }
  }, [snapStep, tool, setSelection, bindInteraction]);

  const applyNotes = useCallback((next) => {
    onNotesChange?.(next);
  }, [onNotesChange]);

  /** Audible blip when a note is committed (draw release / paint cell); not during length drag. */
  const previewPlacedNote = useCallback((pitch) => {
    if (typeof onPreviewNote !== 'function' || pitch == null) {
      return;
    }
    onPreviewNote({ pitch, on: true, place: true });
  }, [onPreviewNote]);

  const canEditNotes = Boolean(interactive && onNotesChange);
  const canSelectNotes = Boolean(interactive && onSelectionChange);

  const handlePointerDown = useCallback((event) => {
    if (event.button !== 0) {
      return;
    }
    if (!interactive && onRequestOpen) {
      event.stopPropagation();
      onRequestOpen();
      return;
    }
    if (!canEditNotes && !canSelectNotes) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();

    const rect = getGridRect();
    if (!rect) {
      return;
    }

    const hit = hitTestNotes(event.clientX, event.clientY, rect, notesRef.current, layoutConfig);
    const cell = pointerToCell(event.clientX, event.clientY, rect, {
      totalBars: bars,
      pitchMin,
      pitchMax,
      snapStep,
    });

    if (tool === PIANO_ROLL_TOOLS.ERASE) {
      if (!canEditNotes) {
        return;
      }
      if (hit) {
        applyNotes(removeNoteById(notesRef.current, hit.noteId));
      } else {
        applyNotes(removeNotesAtCell(notesRef.current, cell.pitch, cell.start, snapStep));
      }
      bindInteraction({
        mode: 'erase',
        pointerId: event.pointerId,
        lastCellKey: `${cell.pitch}:${cell.start}`,
      }, event);
      return;
    }

    if (tool === PIANO_ROLL_TOOLS.DRAW) {
      if (!canEditNotes) {
        return;
      }
      if (hit?.mode === 'resize') {
        beginNoteResize(event, hit.noteId);
        return;
      }
      if (hit?.mode === 'move') {
        applyNotes(removeNoteById(notesRef.current, hit.noteId));
        return;
      }
      const noteId = createNoteId();
      const draftNote = {
        id: noteId,
        pitch: cell.pitch,
        start: cell.start,
        length: snapStep,
        velocity: 0.85,
      };
      bindInteraction({
        mode: 'drawLength',
        pointerId: event.pointerId,
        pitch: cell.pitch,
        start: cell.start,
        noteId,
        placed: false,
        draftNote,
        originX: event.clientX,
        originY: event.clientY,
      }, event);
      scheduleDraftNotePaint(draftNote);
      return;
    }

    if (tool === PIANO_ROLL_TOOLS.PAINT) {
      if (!canEditNotes) {
        return;
      }
      if (hit?.mode === 'resize') {
        beginNoteResize(event, hit.noteId);
        return;
      }
      applyNotes(addNoteAtCell(notesRef.current, cell.pitch, cell.start, { snapStep, defaultLength: snapStep * 4 }));
      previewPlacedNote(cell.pitch);
      bindInteraction({
        mode: 'paint',
        pointerId: event.pointerId,
        lastCellKey: `${cell.pitch}:${cell.start}`,
      }, event);
      return;
    }

    if (tool === PIANO_ROLL_TOOLS.SELECT) {
      if (hit?.mode === 'move' || hit?.mode === 'resize') {
        const ids = selectedSet.has(String(hit.noteId))
          ? [...selectedSet]
          : [hit.noteId];
        setSelection(ids);
        if (!canEditNotes) {
          return;
        }
        if (hit.mode === 'resize') {
          beginNoteResize(event, hit.noteId);
          return;
        }
        const snapshots = notesRef.current
          .filter((n) => ids.includes(String(n.id)))
          .map((n) => ({
            id: n.id,
            start: Number(n.start) || 0,
            pitch: Number(n.pitch) || 60,
            length: Number(n.length) || snapStep,
          }));
        bindInteraction({
          mode: 'move',
          pointerId: event.pointerId,
          snapshots,
          originX: event.clientX,
          originY: event.clientY,
        }, event);
        return;
      }
      if (isFull) {
        bindInteraction({
          mode: 'marquee',
          pointerId: event.pointerId,
          originClientX: event.clientX,
          originClientY: event.clientY,
          addToSelection: event.shiftKey || event.metaKey,
        }, event);
        setMarqueeVisual(marqueeRectFromClient(
          event.clientX,
          event.clientY,
          event.clientX,
          event.clientY,
          rect,
        ));
        return;
      }
      if (canSelectNotes) {
        setSelection([]);
      }
    }
  }, [
    canEditNotes,
    canSelectNotes,
    interactive,
    onRequestOpen,
    getGridRect,
    isFull,
    layoutConfig,
    bars,
    pitchMin,
    pitchMax,
    snapStep,
    tool,
    selectedSet,
    applyNotes,
    setSelection,
    beginNoteResize,
    bindInteraction,
    setMarqueeVisual,
    scheduleDraftNotePaint,
    previewPlacedNote,
  ]);

  const handleGridPointerMove = useCallback((event) => {
    if (!interactive || interactionRef.current) {
      return;
    }
    const rect = getGridRect();
    const grid = gridRef.current;
    if (!rect || !grid) {
      return;
    }
    const hit = hitTestNotes(event.clientX, event.clientY, rect, notesRef.current, layoutConfig);
    if (
      hit?.mode === 'resize'
      && (tool === PIANO_ROLL_TOOLS.DRAW || tool === PIANO_ROLL_TOOLS.SELECT || tool === PIANO_ROLL_TOOLS.PAINT)
    ) {
      grid.style.cursor = 'ew-resize';
      return;
    }
    if (tool === PIANO_ROLL_TOOLS.DRAW && hit?.mode === 'move') {
      grid.style.cursor = 'pointer';
      return;
    }
    grid.style.cursor = '';
  }, [interactive, getGridRect, layoutConfig, tool]);

  const handlePointerMove = useCallback((event) => {
    const state = interactionRef.current;
    if (!state || !interactive) {
      return;
    }
    const rect = getGridRect();
    if (!rect) {
      return;
    }
    if (state.pointerId != null && event.pointerId !== state.pointerId) {
      return;
    }
    if (state.mode === 'marquee' || state.mode === 'move' || state.mode === 'resize' || state.mode === 'drawLength') {
      event.preventDefault();
    }

    if (state.mode === 'drawLength') {
      if (!canEditNotes) {
        return;
      }
      const xRatio = (event.clientX - rect.left) / Math.max(1, rect.width);
      const endBar = snapBar(xRatio * bars, snapStep);
      const length = Math.max(snapStep, endBar - (Number(state.start) || 0));
      const draftNote = {
        id: state.noteId,
        pitch: state.pitch,
        start: state.start,
        length,
        velocity: 0.85,
      };
      state.draftNote = draftNote;
      state.placed = true;
      scheduleDraftNotePaint(draftNote);
      return;
    }

    if (state.mode === 'erase' || state.mode === 'paint') {
      if (!canEditNotes) {
        return;
      }
      const cell = pointerToCell(event.clientX, event.clientY, rect, {
        totalBars: bars,
        pitchMin,
        pitchMax,
        snapStep,
      });
      const key = `${cell.pitch}:${cell.start}`;
      if (key === state.lastCellKey) {
        return;
      }
      state.lastCellKey = key;
      if (state.mode === 'erase') {
        applyNotes(removeNotesAtCell(notesRef.current, cell.pitch, cell.start, snapStep));
      } else {
        applyNotes(addNoteAtCell(notesRef.current, cell.pitch, cell.start, { snapStep, defaultLength: snapStep * 4 }));
        previewPlacedNote(cell.pitch);
      }
      return;
    }

    if (state.mode === 'move' && Array.isArray(state.snapshots)) {
      if (!canEditNotes) {
        return;
      }
      const cell = pointerToCell(event.clientX, event.clientY, rect, {
        totalBars: bars,
        pitchMin,
        pitchMax,
        snapStep,
      });
      const originCell = pointerToCell(state.originX, state.originY, rect, {
        totalBars: bars,
        pitchMin,
        pitchMax,
        snapStep,
      });
      const deltaStart = cell.start - originCell.start;
      const deltaPitch = cell.pitch - originCell.pitch;
      const snapMap = new Map(state.snapshots.map((s) => [String(s.id), s]));
      applyNotes(notesRef.current.map((note) => {
        const snap = snapMap.get(String(note.id));
        if (!snap) {
          return note;
        }
        const start = Math.max(0, snapBar(snap.start + deltaStart, snapStep));
        const pitch = Math.min(pitchMax, Math.max(pitchMin, Math.round(snap.pitch + deltaPitch)));
        return { ...note, start, pitch };
      }));
      return;
    }

    if (state.mode === 'resize') {
      if (!canEditNotes) {
        return;
      }
      const note = notesRef.current.find((n) => String(n.id) === String(state.noteId));
      if (!note) {
        return;
      }
      const deltaPx = event.clientX - state.originX;
      const deltaBars = (deltaPx / Math.max(1, rect.width)) * bars;
      const newLength = Math.max(
        snapStep,
        snapBar((Number(state.originLength) || snapStep) + deltaBars, snapStep),
      );
      applyNotes(resizeNoteById(notesRef.current, state.noteId, newLength, snapStep));
      return;
    }

    if (state.mode === 'marquee') {
      setMarqueeVisual(marqueeRectFromClient(
        state.originClientX,
        state.originClientY,
        event.clientX,
        event.clientY,
        rect,
      ));
    }
  }, [
    interactive,
    canEditNotes,
    getGridRect,
    bars,
    pitchMin,
    pitchMax,
    snapStep,
    applyNotes,
    setMarqueeVisual,
    scheduleDraftNotePaint,
    previewPlacedNote,
  ]);

  useEffect(() => {
    pointerMoveHandlerRef.current = handlePointerMove;
  }, [handlePointerMove]);

  useEffect(() => {
    if (!interactive) {
      return undefined;
    }
    const onUp = (event) => {
      const state = interactionRef.current;
      if (canEditNotes && state?.mode === 'drawLength') {
        const placedPitch = state.placed && state.draftNote
          ? state.draftNote.pitch
          : state.pitch;
        if (state.placed && state.draftNote) {
          const without = removeNoteById(notesRef.current, state.noteId);
          applyNotes([...without, state.draftNote]);
        } else if (!state.placed) {
          applyNotes(addNoteAtCell(notesRef.current, state.pitch, state.start, {
            snapStep,
            defaultLength: snapStep * 4,
          }));
        }
        if (placedPitch != null) {
          previewPlacedNote(placedPitch);
        }
      }
      if (state?.mode === 'marquee') {
        const gridRect = getGridRect();
        if (gridRect && canSelectNotes) {
          const endClientX = Number.isFinite(event?.clientX)
            ? event.clientX
            : state.originClientX;
          const endClientY = Number.isFinite(event?.clientY)
            ? event.clientY
            : state.originClientY;
          const box = marqueeRectFromClient(
            state.originClientX,
            state.originClientY,
            endClientX,
            endClientY,
            gridRect,
          );
          const isTiny = box.width < 4 && box.height < 4;
          const rects = layoutNoteRects(notesRef.current, layoutConfig);
          const hitIds = rects
            .filter((noteRect) => noteRectIntersectsMarquee(noteRect, box))
            .map((noteRect) => String(noteRect.id));
          if (isTiny && hitIds.length === 0) {
            if (!state.addToSelection) {
              setSelection([]);
            }
          } else if (state.addToSelection) {
            setSelection([...new Set([...(selectedNoteIds || []).map(String), ...hitIds])]);
          } else {
            setSelection(hitIds);
          }
        }
      }
      endInteraction();
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [interactive, canEditNotes, canSelectNotes, endInteraction, applyNotes, snapStep, getGridRect, layoutConfig, selectedNoteIds, setSelection, previewPlacedNote]);

  useEffect(() => {
    if (!interactive) {
      return undefined;
    }
    const scroll = scrollRef.current;
    if (scroll) {
      scroll.style.touchAction = 'none';
    }
    return () => {
      detachWindowPointerMove();
      if (scroll) {
        scroll.style.touchAction = '';
      }
    };
  }, [interactive, detachWindowPointerMove]);

  useLayoutEffect(() => {
    if (!isFull) {
      return;
    }
    const keys = new Map();
    const rows = new Map();
    keysRef.current?.querySelectorAll('[data-piano-pitch]').forEach((el) => {
      const pitch = Number(el.getAttribute('data-piano-pitch'));
      if (Number.isFinite(pitch)) {
        keys.set(pitch, el);
      }
    });
    gridRef.current?.querySelectorAll('.piano-roll-grid-row[data-piano-pitch]').forEach((el) => {
      const pitch = Number(el.getAttribute('data-piano-pitch'));
      if (Number.isFinite(pitch)) {
        rows.set(pitch, el);
      }
    });
    pitchDomRef.current = { keys, rows };
  }, [isFull, pitchRows, bars, barWidthPx, rowHeightPx]);

  useEffect(() => () => {
    if (marqueeRafRef.current) {
      cancelAnimationFrame(marqueeRafRef.current);
      marqueeRafRef.current = 0;
    }
    if (draftNoteRafRef.current) {
      cancelAnimationFrame(draftNoteRafRef.current);
      draftNoteRafRef.current = 0;
    }
    detachWindowPointerMove();
  }, [detachWindowPointerMove]);

  useEffect(() => {
    if (!interactive || (!canEditNotes && !canSelectNotes)) {
      return undefined;
    }
    const onKeyDown = (event) => {
      if (isEditableKeyboardTarget(event.target)) {
        return;
      }

      const isSelectAll = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a';
      if (isSelectAll && canSelectNotes) {
        event.preventDefault();
        event.stopPropagation();
        setSelection(allNoteIdsFromNotes(notesRef.current));
        return;
      }

      if (!canEditNotes) {
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return;
      }
      const ids = selectedNoteIds || [];
      if (ids.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      applyNotes(removeNotesByIds(notesRef.current, ids));
      setSelection([]);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [interactive, canEditNotes, canSelectNotes, selectedNoteIds, applyNotes, setSelection]);

  const pitchFromPointerTarget = useCallback((target) => {
    if (!(target instanceof Element)) {
      return null;
    }
    const keyEl = target.closest('[data-piano-pitch]');
    if (!keyEl) {
      return null;
    }
    const pitch = Number(keyEl.getAttribute('data-piano-pitch'));
    return Number.isFinite(pitch) ? pitch : null;
  }, []);

  const handleKeyPointerDown = useCallback((event, pitch) => {
    if (!interactive || !isFull) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    setActivePitchVisual(pitch);
    const keys = keysRef.current;
    try {
      keys?.setPointerCapture?.(event.pointerId);
    } catch {
      /* ignore capture errors */
    }
  }, [interactive, isFull, setActivePitchVisual]);

  const handleKeysPointerMove = useCallback((event) => {
    if (!interactive || !isFull || event.buttons === 0) {
      return;
    }
    const pitch = pitchFromPointerTarget(
      document.elementFromPoint(event.clientX, event.clientY),
    );
    if (pitch != null) {
      setActivePitchVisual(pitch);
    }
  }, [interactive, isFull, pitchFromPointerTarget, setActivePitchVisual]);

  const seekFromRulerPointer = useCallback((event) => {
    const track = rulerTrackRef.current;
    if (!track || typeof onSeekBars !== 'function') {
      return null;
    }
    const scrollEl = scrollRef.current;
    if (scrollEl) {
      const scrollRect = scrollEl.getBoundingClientRect();
      if (event.clientX >= scrollRect.right - PLAYHEAD_SCRUB_EDGE_PX) {
        scrollEl.scrollLeft += PLAYHEAD_SCRUB_SCROLL_PX;
      } else if (event.clientX <= scrollRect.left + PLAYHEAD_SCRUB_EDGE_PX) {
        scrollEl.scrollLeft = Math.max(0, scrollEl.scrollLeft - PLAYHEAD_SCRUB_SCROLL_PX);
      }
    }
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0 || barWidthPx <= 0) {
      return null;
    }
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const localBars = ratio * bars;
    onSeekBars(localBars, { shiftKey: Boolean(event.shiftKey) });
    return localBars;
  }, [onSeekBars, bars, barWidthPx]);

  const beginRulerPlayheadScrub = useCallback((event) => {
    if (event.button !== 0 || typeof onSeekBars !== 'function') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    seekFromRulerPointer(event);

    const handleMove = (moveEvent) => {
      seekFromRulerPointer(moveEvent);
    };
    const cleanupRulerScrub = (pointerEvent) => {
      if (pointerEvent) {
        seekFromRulerPointer(pointerEvent);
      }
      const prev = rulerScrubHandlersRef.current;
      if (prev) {
        window.removeEventListener('pointermove', prev.handleMove);
        window.removeEventListener('pointerup', prev.handleUp);
        window.removeEventListener('pointercancel', prev.handleCancel);
        rulerScrubHandlersRef.current = null;
      }
      if (typeof onSeekEnd === 'function') {
        onSeekEnd();
      }
    };
    const handleUp = (upEvent) => {
      cleanupRulerScrub(upEvent);
    };
    const handleCancel = () => {
      cleanupRulerScrub();
    };

    const prev = rulerScrubHandlersRef.current;
    if (prev) {
      window.removeEventListener('pointermove', prev.handleMove);
      window.removeEventListener('pointerup', prev.handleUp);
      window.removeEventListener('pointercancel', prev.handleCancel);
    }
    rulerScrubHandlersRef.current = { handleMove, handleUp, handleCancel };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
  }, [onSeekBars, onSeekEnd, seekFromRulerPointer]);

  useEffect(() => () => {
    const prev = rulerScrubHandlersRef.current;
    if (prev) {
      window.removeEventListener('pointermove', prev.handleMove);
      window.removeEventListener('pointerup', prev.handleUp);
      window.removeEventListener('pointercancel', prev.handleCancel);
      rulerScrubHandlersRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!interactive || !isFull) {
      setActivePitchVisual(null);
      return undefined;
    }
    const clearActivePitch = () => setActivePitchVisual(null);
    window.addEventListener('pointerup', clearActivePitch);
    window.addEventListener('pointercancel', clearActivePitch);
    return () => {
      window.removeEventListener('pointerup', clearActivePitch);
      window.removeEventListener('pointercancel', clearActivePitch);
    };
  }, [interactive, isFull, setActivePitchVisual]);

  const rootClass = [
    'piano-roll-view',
    isFull ? 'piano-roll-view--full' : 'piano-roll-view--mini',
    syncPlaylist ? 'piano-roll-view--playlist-sync' : '',
    interactive ? 'is-interactive' : '',
    interactive ? `tool-${tool}` : '',
    onRequestOpen && !interactive ? 'is-open-trigger' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div
      className={rootClass}
      style={{
        '--piano-roll-bars': String(bars),
        '--piano-roll-steps': String(steps),
        '--piano-roll-rows': String(rowCount),
        '--piano-roll-bar-width': `${barWidthPx}px`,
        '--piano-roll-row-height': `${rowHeightPx}px`,
        '--piano-roll-key-width': `${keyWidthPx}px`,
        '--piano-roll-grid-width': syncPlaylist ? '100%' : `${gridWidthPx}px`,
        '--piano-roll-grid-height': `${gridHeightPx}px`,
        '--piano-roll-grid-offset-x': syncPlaylist ? `${gridOffsetPx}px` : '0',
      }}
    >
      <div className="piano-roll-scroll" ref={scrollRef}>
        {isFull ? (
          <div
            className={`piano-roll-ruler${typeof onSeekBars === 'function' ? ' is-scrubbable' : ''}`}
            aria-hidden="true"
          >
            <div className="piano-roll-ruler-spacer" />
            <div
              ref={rulerTrackRef}
              className="piano-roll-ruler-track"
              style={{ width: `${gridWidthPx}px` }}
              onPointerDown={beginRulerPlayheadScrub}
            >
              {barNumbers.map((bar) => (
                <span
                  key={`bar_${bar}`}
                  data-bar-index={bar - 1}
                  className="piano-roll-ruler-tick"
                  style={{ width: `${barWidthPx}px` }}
                >
                  {bar}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {syncPlaylist && playlistRulerLabels.length > 0 ? (
          <div className="piano-roll-mini-ruler" aria-hidden="true">
            <div
              className="piano-roll-mini-ruler-track"
              style={{
                width: `${bars * barWidthPx}px`,
                marginLeft: `-${gridOffsetPx}px`,
              }}
            >
              {playlistRulerLabels.map((bar, index) => (
                <span
                  key={`playlist_bar_${bar}`}
                  data-bar-index={index}
                  className="piano-roll-mini-ruler-tick"
                  style={{ width: `${barWidthPx}px` }}
                >
                  {bar}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <div
          className="piano-roll-scroll-inner"
          style={{
            width: syncPlaylist ? '100%' : `${gridWidthPx + keyWidthPx}px`,
            minHeight: `${gridHeightPx}px`,
          }}
        >
          {keyWidthPx > 0 ? (
            <div
              ref={keysRef}
              className="piano-roll-keys"
              style={{ width: `${keyWidthPx}px` }}
              onPointerMove={handleKeysPointerMove}
            >
              {pitchRows.map((row) => (
                <div
                  key={`key_${row.pitch}`}
                  data-piano-pitch={row.pitch}
                  className={`piano-roll-key${row.isBlack ? ' is-black' : ' is-white'}`}
                  style={{ height: `${rowHeightPx}px` }}
                  onPointerDown={(event) => handleKeyPointerDown(event, row.pitch)}
                >
                  {row.isBlack ? (
                    <>
                      <span className="piano-roll-key-black-face" aria-hidden="true" />
                      {row.showLabel ? (
                        <span className="piano-roll-key-label piano-roll-key-label--black">{row.label}</span>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <span className="piano-roll-key-white-face" aria-hidden="true" />
                      {row.showLabel ? (
                        <span className="piano-roll-key-label piano-roll-key-label--white">{row.label}</span>
                      ) : null}
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : null}
          <div
            ref={gridRef}
            className="piano-roll-grid"
            data-bar-pulse={syncPlaylist ? 'clip' : undefined}
            data-clip-start-bars={syncPlaylist ? String(Number(clipStartBars) || 0) : undefined}
            data-clip-length-bars={syncPlaylist ? String(Math.max(1 / 16, Number(clipLengthBars) || 1)) : undefined}
            data-pattern-loop-bars={syncPlaylist ? String(Math.max(1 / 16, Number(patternLoopBars) || 1)) : undefined}
            data-bar-width-px={syncPlaylist ? String(barWidthPx) : undefined}
            data-grid-offset-px={syncPlaylist ? String(gridOffsetPx) : undefined}
            style={{
              width: syncPlaylist ? '100%' : `${gridWidthPx}px`,
              height: `${gridHeightPx}px`,
            }}
            role={onRequestOpen && !interactive ? 'button' : 'presentation'}
            tabIndex={onRequestOpen && !interactive ? 0 : undefined}
            title={onRequestOpen && !interactive ? 'Piano Roll oeffnen' : undefined}
            onPointerDown={handlePointerDown}
            onPointerMove={handleGridPointerMove}
            onPointerLeave={() => {
              if (gridRef.current) {
                gridRef.current.style.cursor = '';
              }
            }}
            onKeyDown={(event) => {
              if ((event.key === 'Enter' || event.key === ' ') && onRequestOpen && !interactive) {
                event.preventDefault();
                onRequestOpen();
              }
            }}
          >
            <div className="piano-roll-rows" aria-hidden="true">
              {pitchRows.map((row) => (
                <div
                  key={`row_${row.pitch}`}
                  data-piano-pitch={row.pitch}
                  className={`piano-roll-grid-row${row.isBlack ? ' is-black' : ' is-white'}`}
                  style={{ height: `${rowHeightPx}px` }}
                >
                  <span
                    className={`piano-roll-grid-row-fill${syncPlaylist ? ' piano-roll-grid-bars-only' : ''}`}
                    style={{ width: syncPlaylist ? '100%' : `${gridWidthPx}px` }}
                  />
                </div>
              ))}
            </div>
            {isFull && Number.isFinite(Number(playheadBars)) ? (
              <div
                className="piano-roll-playhead"
                style={{ left: `${(Number(playheadBars) / bars) * 100}%` }}
                aria-hidden="true"
              />
            ) : null}
            <div
              ref={marqueeElRef}
              className="piano-roll-marquee is-hidden"
              aria-hidden="true"
            />
            <div
              ref={draftNoteElRef}
              className="piano-roll-note piano-roll-note--draft is-hidden"
              aria-hidden="true"
            />
            {noteRects.map((rect) => {
              const isSelected = selectedSet.has(String(rect.id));
              return (
                <div
                  key={rect.id}
                  data-note-id={rect.id}
                  data-pattern-start={rect.patternStart ?? rect.start}
                  data-pattern-length={rect.length}
                  className={`piano-roll-note${isSelected ? ' is-selected' : ''}`}
                  style={{
                    left: `${rect.leftPx}px`,
                    width: `${rect.widthPx}px`,
                    top: `${rect.topPx}px`,
                    height: `${rect.heightPx}px`,
                    opacity: 0.55 + (rect.velocity || 0.8) * 0.45,
                  }}
                  title={`${pitchToLabel(rect.pitch)} @ ${rect.start}`}
                >
                  {isFull && rect.widthPx >= 12 ? (
                    <span className="piano-roll-note-label" aria-hidden="true">
                      {pitchToLabel(rect.pitch)}
                    </span>
                  ) : null}
                  {interactive && isFull && tool !== PIANO_ROLL_TOOLS.ERASE && rect.widthPx >= 8 ? (
                    <span className="piano-roll-note-resize-handle" aria-hidden="true" />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function pitchToLabel(pitch) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const p = Math.round(pitch);
  const octave = Math.floor(p / 12) - 1;
  return `${names[((p % 12) + 12) % 12]}${octave}`;
}

/** Paint draw-tool draft note via DOM only (no React commit during drag). */
function applyDraftNoteDom(el, rect) {
  if (!el) {
    return;
  }
  if (!rect) {
    el.classList.add('is-hidden');
    return;
  }
  el.classList.remove('is-hidden');
  el.style.left = `${rect.leftPx}px`;
  el.style.width = `${rect.widthPx}px`;
  el.style.top = `${rect.topPx}px`;
  el.style.height = `${rect.heightPx}px`;
}

/** Paint marquee via DOM only (no React commit during drag). */
function applyMarqueeDom(el, rect) {
  if (!el) {
    return;
  }
  if (!rect || rect.width + rect.height <= 0) {
    el.classList.add('is-hidden');
    return;
  }
  el.classList.remove('is-hidden');
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

function normalizeMarqueeRect(x0, y0, x1, y1) {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  return {
    left,
    top,
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/** Grid-local marquee from viewport client coords (stable when the scroll area moves). */
function marqueeRectFromClient(originClientX, originClientY, clientX, clientY, gridRect) {
  const x0 = originClientX - gridRect.left;
  const y0 = originClientY - gridRect.top;
  const x1 = clientX - gridRect.left;
  const y1 = clientY - gridRect.top;
  return normalizeMarqueeRect(x0, y0, x1, y1);
}

function noteRectIntersectsMarquee(noteRect, marquee) {
  const noteBox = {
    left: noteRect.leftPx,
    top: noteRect.topPx,
    width: noteRect.widthPx,
    height: noteRect.heightPx,
  };
  return (
    noteBox.left < marquee.left + marquee.width
    && noteBox.left + noteBox.width > marquee.left
    && noteBox.top < marquee.top + marquee.height
    && noteBox.top + noteBox.height > marquee.top
  );
}
