/**
 * Modal to edit a song structure node (title, note, color); optional delete control in header.
 * Location: apps/dashboard/components — opened from SongStructureLane in stuu-shell.
 */

import { useEffect, useState } from 'react';
import { PaintBucket, Trash2, X } from 'lucide-react';

export const STRUCTURE_COLOR_SWATCHES = [
  { id: 'sky', label: 'Sky', color: '#60a5fa' },
  { id: 'emerald', label: 'Emerald', color: '#34d399' },
  { id: 'pink', label: 'Pink', color: '#e879a8' },
  { id: 'cyan', label: 'Cyan', color: '#7dd3fc' },
  { id: 'amber', label: 'Amber', color: '#fbbf24' },
  { id: 'rose', label: 'Rose', color: '#fb7185' },
  { id: 'violet', label: 'Violet', color: '#a78bfa' },
  { id: 'lime', label: 'Lime', color: '#a3e635' },
];

export default function SongStructureNodeModal({ node, onClose, onSave, onDelete }) {
  const [title, setTitle] = useState(node?.title || '');
  const [note, setNote] = useState(node?.note || '');
  const [color, setColor] = useState(node?.color || '#7dd3fc');

  useEffect(() => {
    setTitle(node?.title || '');
    setNote(node?.note || '');
    setColor(node?.color || '#7dd3fc');
  }, [node]);

  if (!node) {
    return null;
  }

  return (
    <div className="structure-node-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="structure-node-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="structure-node-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="structure-node-modal-head">
          <h2 id="structure-node-modal-title">Structure Section</h2>
          <div className="structure-node-modal-head-actions">
            {typeof onDelete === 'function' ? (
              <button
                type="button"
                className="structure-node-modal-delete"
                aria-label="Section löschen"
                onClick={() => {
                  if (window.confirm('Section wirklich löschen?')) {
                    onDelete(node.id);
                  }
                }}
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            ) : null}
            <button type="button" className="structure-node-modal-close" onClick={onClose} aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="structure-node-modal-body">
          <label className="structure-node-modal-field">
            <span>Title</span>
            <input type="text" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="structure-node-modal-field">
            <span>Note</span>
            <textarea value={note} maxLength={500} rows={3} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="structure-node-modal-field">
            <span>
              <PaintBucket size={11} strokeWidth={2} aria-hidden="true" />
              Color
            </span>
            <div className="structure-node-modal-swatches">
              {STRUCTURE_COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch.id}
                  type="button"
                  className={`structure-node-modal-swatch ${color === swatch.color ? 'active' : ''}`}
                  style={{ '--swatch-color': swatch.color }}
                  aria-label={swatch.label}
                  onClick={() => setColor(swatch.color)}
                />
              ))}
            </div>
            <input type="text" value={color} maxLength={7} placeholder="#7dd3fc" onChange={(e) => setColor(e.target.value)} />
          </div>
        </div>
        <footer className="structure-node-modal-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onSave?.({ id: node.id, title: title.trim() || 'Section', note, color })}
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
