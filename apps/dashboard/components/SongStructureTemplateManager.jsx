/**
 * Template library modal: search, date filter, load/save/export structure templates.
 * Location: apps/dashboard/components — opened from Structure menu in stuu-shell.
 */

import { useMemo, useState } from 'react';
import { Download, FolderOpen, Pencil, Plus, Save, X } from 'lucide-react';

function formatDate(iso) {
  if (!iso) {
    return '—';
  }
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function matchesDateFilter(modifiedAt, from, to) {
  if (!from && !to) {
    return true;
  }
  const ts = Date.parse(modifiedAt);
  if (!Number.isFinite(ts)) {
    return true;
  }
  if (from) {
    const fromTs = Date.parse(`${from}T00:00:00`);
    if (Number.isFinite(fromTs) && ts < fromTs) {
      return false;
    }
  }
  if (to) {
    const toTs = Date.parse(`${to}T23:59:59`);
    if (Number.isFinite(toTs) && ts > toTs) {
      return false;
    }
  }
  return true;
}

export default function SongStructureTemplateManager({
  open,
  templates = [],
  loadedTemplateId = null,
  onClose,
  onRefresh,
  onLoad,
  onSaveLoaded,
  onSaveAsNew,
  onExport,
  onEditMeta,
}) {
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return templates.filter((tpl) => {
      if (!matchesDateFilter(tpl.modified_at, dateFrom, dateTo)) {
        return false;
      }
      if (!q) {
        return true;
      }
      const hay = `${tpl.name || ''} ${tpl.note || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [templates, search, dateFrom, dateTo]);

  if (!open) {
    return null;
  }

  return (
    <div className="structure-template-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="structure-template-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="structure-template-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="structure-template-modal-head">
          <h2 id="structure-template-modal-title">Structure Templates</h2>
          <div className="structure-template-modal-head-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="Save loaded template"
              disabled={!loadedTemplateId}
              onClick={() => onSaveLoaded?.()}
            >
              <Save size={15} aria-hidden="true" />
            </button>
            <button type="button" className="structure-template-modal-close" onClick={onClose} aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="structure-template-modal-toolbar">
          <input
            type="search"
            placeholder="Search templates…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="structure-template-search"
          />
          <label className="structure-template-date-field">
            <span>From</span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label className="structure-template-date-field">
            <span>To</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRefresh?.()}>
            Refresh
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onSaveAsNew?.()}>
            Save as New
          </button>
        </div>
        <div className="structure-template-list-wrap">
          <table className="structure-template-list">
            <thead>
              <tr>
                <th>Name</th>
                <th>Modified</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={3} className="structure-template-empty">No templates found</td>
                </tr>
              ) : (
                filtered.map((tpl) => (
                  <tr key={tpl.id} className={tpl.id === loadedTemplateId ? 'is-loaded' : ''}>
                    <td>
                      <strong>{tpl.name}</strong>
                      {tpl.note ? <span className="structure-template-note">{tpl.note}</span> : null}
                    </td>
                    <td>{formatDate(tpl.modified_at)}</td>
                    <td className="structure-template-row-actions">
                      <button type="button" title="Edit name/note" onClick={() => onEditMeta?.(tpl)}>
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                      <button type="button" title="Export JSON" onClick={() => onExport?.(tpl)}>
                        <Download size={14} aria-hidden="true" />
                      </button>
                      <button type="button" title="Load into project" onClick={() => onLoad?.(tpl)}>
                        <Plus size={14} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <footer className="structure-template-modal-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            <FolderOpen size={14} aria-hidden="true" />
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
