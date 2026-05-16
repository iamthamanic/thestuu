/**
 * Song structure timeline lane: colored section blocks, resize/split, playhead scrub strip, drag-reorder,
 * optional selection ring for keyboard/delete flows.
 * When Structure↔Playlist link is on, optional playlistLinkTintSegments draws matching vertical tint stripes (pointer-events none).
 * Location: apps/dashboard/components — Edit arrangement + Mix read-only strip.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  computeStructureStarts,
  getStructureTotalBars,
  insertionIndexFromBars,
  pxToBars,
  snapStructureBars,
} from '../lib/song-structure.js';

/** Match `.arrangement-layout` / `.mix-layout` `--structure-strip-height` in globals.css */
const STRUCTURE_LANE_HEIGHT_PX = 36;
const NODE_DRAG_THRESHOLD_PX = 6;

export { STRUCTURE_LANE_HEIGHT_PX };

export default function SongStructureLane({
  nodes = [],
  barWidth = 92,
  snapStep = 1,
  timelineWidth = 0,
  readOnly = false,
  onResize,
  onAddAtBoundary,
  onNodeClick,
  onReorder,
  onPlayheadPointerDown,
  selectedNodeId = null,
  onSelectStructureNode,
  onStructureKeyboardDelete,
  /** When Structure↔Playlist link active: vertical tint strips aligned with sections (from parent useMemo). */
  playlistLinkTintSegments = null,
}) {
  const laneRef = useRef(null);
  const dragRef = useRef(null);
  const nodeDragMaxDeltaRef = useRef(0);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const [nodeDragVisual, setNodeDragVisual] = useState(null);
  /** Insert index (0…nodes.length) while reorder-dragging; drives dropzone geometry. */
  const [dropInsertBefore, setDropInsertBefore] = useState(null);

  const starts = useMemo(() => computeStructureStarts(nodes), [nodes]);
  const totalBars = useMemo(() => getStructureTotalBars(nodes), [nodes]);
  const laneWidth = Math.max(timelineWidth, totalBars * barWidth, barWidth * 4);

  const beginResize = useCallback((event, index) => {
    if (readOnly || typeof onResizeRef.current !== 'function') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const node = nodes[index];
    if (!node) {
      return;
    }

    const drag = {
      index,
      startX: event.clientX,
      startLength: node.length,
      lastLength: node.length,
    };
    dragRef.current = drag;

    const onMove = (moveEvent) => {
      const deltaBars = pxToBars(moveEvent.clientX - drag.startX, barWidth);
      const nextLength = snapStructureBars(drag.startLength + deltaBars, snapStep);
      if (nextLength !== drag.lastLength) {
        drag.lastLength = nextLength;
        onResizeRef.current?.(drag.index, nextLength);
      }
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [barWidth, nodes, readOnly, snapStep]);

  const dropZoneGeometry = useMemo(() => {
    if (
      nodeDragVisual == null
      || dropInsertBefore == null
      || readOnly
      || nodeDragVisual.index < 0
      || nodeDragVisual.index >= nodes.length
    ) {
      return null;
    }
    const dragIndex = nodeDragVisual.index;
    const dragged = nodes[dragIndex];
    if (!dragged) {
      return null;
    }
    const without = nodes.filter((_, i) => i !== dragIndex);
    let ins = dropInsertBefore;
    if (dragIndex < dropInsertBefore) {
      ins -= 1;
    }
    ins = Math.max(0, Math.min(ins, without.length));
    const hypothetical = [...without.slice(0, ins), dragged, ...without.slice(ins)];
    const previewStarts = computeStructureStarts(hypothetical);
    const leftBars = previewStarts[ins] ?? 0;
    const widthPx = Math.max(dragged.length * barWidth, 4);
    return { leftPx: leftBars * barWidth, widthPx };
  }, [barWidth, dropInsertBefore, nodeDragVisual, nodes, readOnly]);

  /** Focus lane early so Delete targets this strip (avoid BPM/other inputs stealing focus). */
  const focusLaneFromPointerCapture = useCallback(
    (event) => {
      if (readOnly || event.button !== 0) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.structure-node-title-btn, .structure-boundary-add, .structure-node-resize-handle')
      ) {
        return;
      }
      laneRef.current?.focus?.({ preventScroll: true });
      queueMicrotask(() => {
        laneRef.current?.focus?.({ preventScroll: true });
      });
    },
    [readOnly],
  );

  const handleLaneKeyDown = useCallback(
    (event) => {
      if (readOnly || selectedNodeId == null || typeof onStructureKeyboardDelete !== 'function') {
        return;
      }
      if (event.repeat) {
        return;
      }
      const wantsDelete =
        event.key === 'Delete'
        || event.key === 'Backspace'
        || event.code === 'Delete'
        || event.code === 'Backspace';
      if (!wantsDelete) {
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onStructureKeyboardDelete();
    },
    [onStructureKeyboardDelete, readOnly, selectedNodeId],
  );

  const handleNodePointerDown = useCallback(
    (event, index) => {
      if (readOnly) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      if (event.target.closest('.structure-node-resize-handle, .structure-boundary-add, .structure-node-title-btn')) {
        return;
      }

      const pickedId = nodes[index]?.id;
      if (pickedId) {
        onSelectStructureNode?.(pickedId);
      }

      const canReorder = typeof onReorder === 'function';
      const startX = event.clientX;
      nodeDragMaxDeltaRef.current = 0;
      setDropInsertBefore(null);

      laneRef.current?.focus?.({ preventScroll: true });
      queueMicrotask(() => {
        laneRef.current?.focus?.({ preventScroll: true });
      });

      if (canReorder) {
        event.preventDefault();
      }

      const onMove = (moveEvent) => {
        const delta = Math.abs(moveEvent.clientX - startX);
        nodeDragMaxDeltaRef.current = Math.max(nodeDragMaxDeltaRef.current, delta);
        if (canReorder && delta >= NODE_DRAG_THRESHOLD_PX && laneRef.current) {
          const scrollEl = laneRef.current.closest('.arrangement-scroll');
          const scrollLeft = scrollEl?.scrollLeft ?? 0;
          const rect = laneRef.current.getBoundingClientRect();
          const bars = (scrollLeft + moveEvent.clientX - rect.left) / barWidth;
          setDropInsertBefore(insertionIndexFromBars(nodes, bars));
          setNodeDragVisual({ index, deltaPx: moveEvent.clientX - startX });
        }
      };

      const finish = (clientX) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        setNodeDragVisual(null);
        setDropInsertBefore(null);

        const moved = nodeDragMaxDeltaRef.current >= NODE_DRAG_THRESHOLD_PX;
        if (!canReorder || !moved || !laneRef.current) {
          return;
        }
        const scrollEl = laneRef.current.closest('.arrangement-scroll');
        const scrollLeft = scrollEl?.scrollLeft ?? 0;
        const rect = laneRef.current.getBoundingClientRect();
        const bars = (scrollLeft + clientX - rect.left) / barWidth;
        const insertBefore = insertionIndexFromBars(nodes, bars);
        onReorder(index, insertBefore);
      };

      const onUp = (upEvent) => {
        finish(upEvent.clientX);
      };

      const onCancel = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        setNodeDragVisual(null);
        setDropInsertBefore(null);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    },
    [barWidth, nodes, onReorder, onSelectStructureNode, readOnly],
  );

  const playheadEl = (
    <div
      className="timeline-playhead arrangement-structure-playhead"
      aria-hidden="true"
      onPointerDown={typeof onPlayheadPointerDown === 'function' ? onPlayheadPointerDown : undefined}
    />
  );

  if (!nodes.length) {
    return (
      <div
        ref={laneRef}
        tabIndex={readOnly ? undefined : -1}
        className={`arrangement-structure-lane is-empty ${readOnly ? 'is-readonly' : ''}`}
        style={{ width: `${laneWidth}px`, minHeight: `${STRUCTURE_LANE_HEIGHT_PX}px` }}
        aria-label="Song structure"
        onPointerDownCapture={readOnly ? undefined : focusLaneFromPointerCapture}
        onKeyDown={readOnly ? undefined : handleLaneKeyDown}
        onClick={
          readOnly
            ? undefined
            : (event) => {
                if (event.target.closest('button')) {
                  return;
                }
                if (event.target.closest('.timeline-playhead')) {
                  return;
                }
                onAddAtBoundary?.(-1);
              }
        }
      >
        {playheadEl}
        {!readOnly ? (
          <button
            type="button"
            className="structure-boundary-add structure-boundary-add-start"
            aria-label="Add first section"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onAddAtBoundary?.(-1);
            }}
          >
            <Plus size={10} strokeWidth={2.2} aria-hidden="true" />
          </button>
        ) : null}
        <span className="arrangement-structure-empty-hint">No structure — use + or Structure menu</span>
      </div>
    );
  }

  return (
    <div
      ref={laneRef}
      tabIndex={readOnly ? undefined : -1}
      className={`arrangement-structure-lane ${readOnly ? 'is-readonly' : ''}${
        nodeDragVisual ? ' is-structure-reordering' : ''
      }`}
      style={{ width: `${laneWidth}px`, minHeight: `${STRUCTURE_LANE_HEIGHT_PX}px` }}
      aria-label="Song structure"
      onPointerDownCapture={readOnly ? undefined : focusLaneFromPointerCapture}
      onKeyDown={readOnly ? undefined : handleLaneKeyDown}
    >
      {nodes.map((node, index) => {
        const start = starts[index] ?? 0;
        const leftPx = start * barWidth;
        const widthPx = node.length * barWidth;
        const dragging = nodeDragVisual?.index === index;
        const selected = !readOnly && selectedNodeId != null && node.id === selectedNodeId;
        return (
          <div
            key={node.id}
            className={`structure-node${dragging ? ' is-structure-node-dragging' : ''}${
              selected ? ' is-structure-node-selected' : ''
            }`}
            style={{
              left: `${leftPx}px`,
              width: `${Math.max(widthPx, 4)}px`,
              '--structure-node-color': node.color,
              transform: dragging ? `translateX(${nodeDragVisual.deltaPx}px)` : undefined,
            }}
            title={node.note ? `${node.title} — ${node.note}` : node.title}
            onPointerDown={(event) => handleNodePointerDown(event, index)}
            role="presentation"
          >
            {readOnly ? (
              <span className="structure-node-title">{node.title}</span>
            ) : (
              <button
                type="button"
                className="structure-node-title structure-node-title-btn"
                aria-label={`${node.title} bearbeiten`}
                title={node.note ? `${node.title} — ${node.note}` : undefined}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onNodeClick?.(node);
                }}
              >
                {node.title}
              </button>
            )}
            {!readOnly ? (
              <button
                type="button"
                className="structure-node-resize-handle"
                aria-label={`Resize ${node.title}`}
                onPointerDown={(moveEvent) => beginResize(moveEvent, index)}
              />
            ) : null}
            {!readOnly && index < nodes.length - 1 ? (
              <button
                type="button"
                className="structure-boundary-add"
                style={{ right: 0 }}
                aria-label={`Split after ${node.title}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onAddAtBoundary?.(index);
                }}
              >
                <Plus size={10} strokeWidth={2.2} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        );
      })}
      {Array.isArray(playlistLinkTintSegments) && playlistLinkTintSegments.length > 0 ? (
        <div
          className="arrangement-structure-playlist-tint arrangement-structure-playlist-tint--lane"
          aria-hidden="true"
        >
          {playlistLinkTintSegments.map((seg) => (
            <div
              key={`struct_tint_lane_${seg.id}`}
              className="arrangement-structure-playlist-tint-strip"
              style={{
                left: `${seg.leftPx}px`,
                width: `${seg.widthPx}px`,
                background: `linear-gradient(180deg, rgba(${seg.rgb}, 0.38), rgba(${seg.rgb}, 0.12))`,
              }}
            />
          ))}
        </div>
      ) : null}
      {dropZoneGeometry ? (
        <div
          className="structure-node-dropzone"
          aria-hidden="true"
          style={{
            left: `${dropZoneGeometry.leftPx}px`,
            width: `${dropZoneGeometry.widthPx}px`,
          }}
        />
      ) : null}
      {!readOnly && nodes.length > 0 ? (
        <button
          type="button"
          className="structure-boundary-add structure-boundary-add-end"
          style={{ left: `${totalBars * barWidth}px` }}
          aria-label="Add section at end"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onAddAtBoundary?.(nodes.length - 1)}
        >
          <Plus size={10} strokeWidth={2.2} aria-hidden="true" />
        </button>
      ) : null}
      {playheadEl}
    </div>
  );
}
