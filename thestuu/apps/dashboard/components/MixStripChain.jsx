'use client';

/**
 * MixStripChain — Vertical FX chain for mixer strips (Mix tab).
 * Mirrors Edit arrangement chain slot info (index, plugin label, bypass/remove) and click behavior;
 * Always shows at least the same slot count as Edit arrangement chain (7); extra rows if more plugins + append slot.
 * Location: apps/dashboard/components/MixStripChain.jsx; used by stuu-shell.jsx.
 */

import { Power, Trash2 } from 'lucide-react';

/** Match `TRACK_CHAIN_VISIBLE_SLOTS` in stuu-shell.jsx (arrangement-track-chain-rail). */
const MIX_STRIP_CHAIN_MIN_SLOTS = 7;

function MixStripBypassIcon({ active = false }) {
  return <Power size={11} strokeWidth={2} opacity={active ? 0.5 : 1} aria-hidden="true" />;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export default function MixStripChain({
  trackId,
  trackNodes,
  chainEnabled,
  pluginNameByUid,
  resolveNodePluginDisplayName,
  formatTrackChainPluginName,
  resolveTracktionPluginUiMeta,
  buildPluginHelpTooltip,
  openTrackChainModalSlotPluginPicker,
  setInspector,
  openVstNodeEditor,
  setVstNodeBypassed,
  removeVstNode,
  reorderTrackVstNodes,
}) {
  const chainDisabled = chainEnabled === false;
  const slotCount = Math.max(MIX_STRIP_CHAIN_MIN_SLOTS, trackNodes.length + 1);

  return (
    <div
      className={`mix-strip-chain ${chainDisabled ? 'mix-strip-chain-disabled' : ''}`}
      data-track-plugin-picker-root="true"
    >
      <span className="mix-strip-chain-label">Effects</span>
      <div className="mix-strip-chain-scroll">
        {Array.from({ length: slotCount }, (_, slotIndex) => {
          const node = slotIndex < trackNodes.length ? trackNodes[slotIndex] : null;
          const hasNode = Boolean(node);
          const isBypassed = Boolean(node?.bypassed);
          const pluginDisplayName = hasNode
            ? resolveNodePluginDisplayName(node, pluginNameByUid)
            : '';
          const pluginUiMeta = hasNode
            ? resolveTracktionPluginUiMeta(node?.plugin_uid, pluginDisplayName)
            : null;
          const SlotPluginIcon = pluginUiMeta?.icon || null;
          const slotLabel = hasNode
            ? `${slotIndex + 1} ${formatTrackChainPluginName(pluginDisplayName)}`
            : `${slotIndex + 1}`;
          const slotTooltip = hasNode
            ? buildPluginHelpTooltip(pluginDisplayName, pluginUiMeta)
            : `Slot ${slotIndex + 1}: Plugin hinzufuegen`;

          return (
            <div
              key={`mix_strip_chain_${trackId}_${slotIndex}`}
              className={`mix-strip-chain-slot ${hasNode ? 'filled' : 'empty'} ${isBypassed ? 'bypassed' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const sourceSlotIndex = Number(event.dataTransfer.getData('text/plain'));
                if (
                  !Number.isInteger(sourceSlotIndex)
                  || sourceSlotIndex < 0
                  || sourceSlotIndex >= trackNodes.length
                ) {
                  return;
                }
                const targetSlotIndex = clamp(slotIndex, 0, Math.max(0, trackNodes.length - 1));
                reorderTrackVstNodes(trackId, sourceSlotIndex, targetSlotIndex);
              }}
            >
              <button
                type="button"
                className="mix-strip-chain-slot-main"
                draggable={hasNode}
                title={slotTooltip}
                onDragStart={(event) => {
                  if (!hasNode) {
                    return;
                  }
                  event.stopPropagation();
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', String(slotIndex));
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!hasNode) {
                    openTrackChainModalSlotPluginPicker(trackId, slotIndex);
                    return;
                  }
                  setInspector({ type: 'node', nodeId: node.id });
                  openVstNodeEditor(node);
                }}
              >
                <span className="mix-strip-chain-slot-label">
                  {hasNode && SlotPluginIcon ? (
                    <SlotPluginIcon size={9} strokeWidth={2} aria-hidden="true" />
                  ) : null}
                  <span className="mix-strip-chain-slot-label-text">{slotLabel}</span>
                </span>
              </button>
              {hasNode ? (
                <div className="mix-strip-chain-slot-tools">
                  <button
                    type="button"
                    className={`mix-strip-chain-slot-bypass ${isBypassed ? 'active' : ''}`}
                    title={isBypassed ? 'Bypass deaktivieren' : 'Bypass aktivieren'}
                    aria-label={isBypassed ? 'Bypass deaktivieren' : 'Bypass aktivieren'}
                    onClick={(event) => {
                      event.stopPropagation();
                      setVstNodeBypassed(node, !isBypassed);
                    }}
                  >
                    <MixStripBypassIcon active={isBypassed} />
                  </button>
                  <button
                    type="button"
                    className="mix-strip-chain-slot-remove"
                    title="Plugin entfernen"
                    aria-label="Plugin entfernen"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeVstNode(node);
                    }}
                  >
                    <Trash2 size={9} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
