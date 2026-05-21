/**
 * Modal: pick local sample or generative VST for the active pattern track.
 * Location: apps/dashboard/components/pattern-sound-chooser-modal.jsx
 */

import { FolderOpen, Waves, X } from 'lucide-react';

export default function PatternSoundChooserModal({
  open,
  generators = [],
  onClose,
  onPickLocalFile,
  onPickGenerator,
  pluginLoadPending = false,
}) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="pattern-sound-chooser-overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="pattern-sound-chooser-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Sound hinzufuegen"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pattern-sound-chooser-head">
          <h2>Sound hinzufuegen</h2>
          <button type="button" className="pattern-sound-chooser-close" onClick={onClose} aria-label="Schliessen">
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>
        <p className="pattern-sound-chooser-hint muted">
          Audio-Dateien kannst du auch direkt auf add Sound ziehen.
        </p>
        <div className="pattern-sound-chooser-tiles">
          <button type="button" className="pattern-sound-chooser-tile" onClick={onPickLocalFile}>
            <FolderOpen size={22} strokeWidth={1.75} aria-hidden="true" />
            <strong>Lokale Datei</strong>
            <small>Sample oder Loop importieren</small>
          </button>
        </div>
        <section className="pattern-sound-chooser-generators" aria-label="Generatoren">
          <h3>
            <Waves size={14} strokeWidth={2} aria-hidden="true" />
            Generator (VST)
          </h3>
          {generators.length === 0 ? (
            <p className="pattern-sound-chooser-empty muted">Keine Generatoren — bitte zuerst Plugins scannen (Settings).</p>
          ) : (
            <div className="pattern-sound-chooser-plugin-list">
              {generators.map((plugin) => (
                <button
                  key={plugin.uid}
                  type="button"
                  className="pattern-sound-chooser-plugin-row"
                  disabled={pluginLoadPending}
                  onClick={() => onPickGenerator(plugin.uid)}
                >
                  <span className="truncate">{plugin.name}</span>
                  {plugin.type ? <small>{plugin.type}</small> : null}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}