/**
 * Dropdown menu on the Structure label: save, export, import, create new.
 * Rendered via portal (fixed to viewport) so track rows never paint over it.
 * Location: apps/dashboard/components — triggered from stuu-shell.jsx.
 */

import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileDown, FileUp, FolderPlus, Save } from 'lucide-react';

export default function SongStructureAddMenu({
  open,
  anchorRef,
  onClose,
  onSaveAsNew,
  onExportJson,
  onImportJson,
  onCreateNew,
  onOpenTemplates,
}) {
  const [coords, setCoords] = useState(null);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return undefined;
    }
    const anchor = anchorRef?.current;
    if (!anchor) {
      setCoords(null);
      return undefined;
    }
    const update = () => {
      const r = anchor.getBoundingClientRect();
      setCoords({ top: r.bottom + 4, left: r.left });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef]);

  if (!open || coords == null || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="structure-add-menu structure-add-menu-portal"
      role="menu"
      style={{ top: coords.top, left: coords.left }}
      data-structure-add-menu="true"
    >
      <button type="button" role="menuitem" onClick={() => { onOpenTemplates?.(); onClose?.(); }}>
        <FolderPlus size={14} aria-hidden="true" />
        Templates…
      </button>
      <button type="button" role="menuitem" onClick={() => { onSaveAsNew?.(); onClose?.(); }}>
        <Save size={14} aria-hidden="true" />
        Save as New
      </button>
      <button type="button" role="menuitem" onClick={() => { onExportJson?.(); onClose?.(); }}>
        <FileDown size={14} aria-hidden="true" />
        Export JSON
      </button>
      <button type="button" role="menuitem" onClick={() => { onImportJson?.(); onClose?.(); }}>
        <FileUp size={14} aria-hidden="true" />
        Import JSON
      </button>
      <button type="button" role="menuitem" onClick={() => { onCreateNew?.(); onClose?.(); }}>
        Create New
      </button>
    </div>,
    document.body,
  );
}
