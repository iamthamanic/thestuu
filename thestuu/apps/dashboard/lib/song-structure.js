/**
 * Pure helpers for song structure nodes (resize with follower shift, split, insert).
 * Used by SongStructureLane and stuu-shell socket handlers.
 */

import {
  computeStructureStarts,
  getStructureTotalBars,
  normalizeSongStructureNode,
} from '@thestuu/shared-json';

export { computeStructureStarts, getStructureTotalBars };

const MIN_NODE_LENGTH = 1;
const DEFAULT_NODE_TITLE = 'Section';
const DEFAULT_NODE_COLOR = '#7dd3fc';

export function snapStructureBars(value, snapStep = 1) {
  if (!Number.isFinite(value) || !Number.isFinite(snapStep) || snapStep <= 0) {
    return MIN_NODE_LENGTH;
  }
  const snapped = Math.round(value / snapStep) * snapStep;
  return Math.max(MIN_NODE_LENGTH, Number(snapped.toFixed(6)));
}

function cloneNodes(nodes) {
  return nodes.map((node) => ({ ...node }));
}

export function createStructureNodeId() {
  return `str_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function createDefaultStructureNode(length = 8) {
  return normalizeSongStructureNode({
    id: createStructureNodeId(),
    title: DEFAULT_NODE_TITLE,
    note: '',
    color: DEFAULT_NODE_COLOR,
    length: Math.max(MIN_NODE_LENGTH, length),
  });
}

/**
 * Resize node right edge. Middle nodes: only length[i] changes (followers shift).
 * Last node: only last length changes.
 */
export function resizeNodeRight(nodes, index, targetLength, snapStep = 1) {
  if (!Array.isArray(nodes) || index < 0 || index >= nodes.length) {
    return nodes;
  }
  const next = cloneNodes(nodes);
  const snapped = snapStructureBars(targetLength, snapStep);
  next[index] = { ...next[index], length: snapped };
  return next;
}

/**
 * Split node at boundary between node index and index+1 (50/50 of node at index).
 * boundaryIndex is the index of the node whose end is split (insert after node at boundaryIndex).
 */
export function splitNodeAtBoundary(nodes, boundaryIndex, snapStep = 1) {
  if (!Array.isArray(nodes) || boundaryIndex < 0 || boundaryIndex >= nodes.length) {
    return nodes;
  }
  const node = nodes[boundaryIndex];
  const total = node.length;
  if (total <= MIN_NODE_LENGTH) {
    return nodes;
  }
  const half = snapStructureBars(total / 2, snapStep);
  const remainder = snapStructureBars(total - half, snapStep);
  if (half < MIN_NODE_LENGTH || remainder < MIN_NODE_LENGTH) {
    return nodes;
  }
  const next = cloneNodes(nodes);
  const newNode = createDefaultStructureNode(remainder);
  next[boundaryIndex] = { ...next[boundaryIndex], length: half };
  next.splice(boundaryIndex + 1, 0, newNode);
  return next;
}

/**
 * Insert new node after `boundaryIndex` without shortening neighbors (timeline grows).
 * boundaryIndex -1 → prepend; last index or beyond → append; otherwise splice after that node.
 */
export function insertNodeAtBoundary(nodes, boundaryIndex, snapStep = 1) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return [createDefaultStructureNode(snapStructureBars(8, snapStep))];
  }
  if (boundaryIndex < 0) {
    return [createDefaultStructureNode(snapStructureBars(4, snapStep)), ...cloneNodes(nodes)];
  }
  if (boundaryIndex >= nodes.length - 1) {
    return [...cloneNodes(nodes), createDefaultStructureNode(snapStructureBars(8, snapStep))];
  }
  const next = cloneNodes(nodes);
  next.splice(
    boundaryIndex + 1,
    0,
    createDefaultStructureNode(snapStructureBars(8, snapStep)),
  );
  return next;
}

export function updateNodeMeta(nodes, id, patch) {
  if (!Array.isArray(nodes) || !id) {
    return nodes;
  }
  return nodes.map((node) => {
    if (node.id !== id) {
      return node;
    }
    return normalizeSongStructureNode({
      ...node,
      ...patch,
      id: node.id,
      length: node.length,
    });
  });
}

/**
 * Remove node at index; its bar length is merged into the previous sibling, or into the next if it was first.
 * Removing the last remaining node yields an empty array (no sections).
 */
export function removeStructureNodeAt(nodes, index) {
  if (!Array.isArray(nodes) || index < 0 || index >= nodes.length) {
    return nodes;
  }
  if (nodes.length === 1) {
    return [];
  }
  const next = cloneNodes(nodes);
  const removed = next[index];
  const removedLen = Math.max(MIN_NODE_LENGTH, Number(removed.length) || MIN_NODE_LENGTH);
  next.splice(index, 1);
  if (index > 0) {
    const prev = next[index - 1];
    next[index - 1] = {
      ...prev,
      length: Math.max(MIN_NODE_LENGTH, (Number(prev.length) || MIN_NODE_LENGTH) + removedLen),
    };
  } else {
    const head = next[0];
    next[0] = {
      ...head,
      length: Math.max(MIN_NODE_LENGTH, (Number(head.length) || MIN_NODE_LENGTH) + removedLen),
    };
  }
  return next;
}

export function removeStructureNodeById(nodes, id) {
  if (!Array.isArray(nodes) || typeof id !== 'string' || !id.trim()) {
    return nodes;
  }
  const index = nodes.findIndex((node) => node.id === id);
  if (index < 0) {
    return nodes;
  }
  return removeStructureNodeAt(nodes, index);
}

export function barsToPx(bars, barWidth) {
  return bars * barWidth;
}

export function pxToBars(px, barWidth) {
  if (!barWidth) {
    return 0;
  }
  return px / barWidth;
}

/**
 * Bar position → insertion index before node `insertBeforeIndex` (0…nodes.length) for reorder drag-drop.
 */
export function insertionIndexFromBars(nodes, bars) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return 0;
  }
  const starts = computeStructureStarts(nodes);
  const total = getStructureTotalBars(nodes);
  const b = Math.min(Math.max(Number(bars) || 0, 0), total);
  if (b <= starts[0]) {
    return 0;
  }
  for (let i = 0; i < nodes.length; i++) {
    const end = starts[i] + nodes[i].length;
    if (b < end) {
      const mid = starts[i] + nodes[i].length * 0.5;
      return b < mid ? i : i + 1;
    }
  }
  return nodes.length;
}

/**
 * Move node `fromIndex` so it ends up immediately before `insertBeforeIndex` (in the order before the move).
 */
export function reorderStructureNodes(nodes, fromIndex, insertBeforeIndex) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return nodes;
  }
  if (fromIndex < 0 || fromIndex >= nodes.length) {
    return nodes;
  }
  let insert = Math.max(0, Math.min(insertBeforeIndex, nodes.length));
  const next = cloneNodes(nodes);
  const [item] = next.splice(fromIndex, 1);
  if (fromIndex < insert) {
    insert -= 1;
  }
  insert = Math.max(0, Math.min(insert, next.length));
  next.splice(insert, 0, item);
  return next;
}
