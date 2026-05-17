'use client';

/**
 * Isolated meter state and engine:meter subscription — avoids re-rendering StuuShell on every tick.
 * Location: apps/dashboard/context — wrap via daw-shell.jsx
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getMeterMap } from '../lib/meter-map.js';
import { setMetersMap, useMixMasterPeak } from '../lib/meter-store.js';

const MetersBindContext = createContext(null);

/**
 * Register socket meter handler from StuuShell once socket connects.
 * @param {import('socket.io-client').Socket | null} socket
 */
export function useBindMeterSocket() {
  return useContext(MetersBindContext);
}

/**
 * @param {import('socket.io-client').Socket} socket
 * @param {(payload: unknown) => void} handler
 */
export function bindMeterSocketListener(socket, handler) {
  if (!socket) {
    return () => {};
  }
  socket.on('engine:meter', handler);
  return () => socket.off('engine:meter', handler);
}

export default function MetersProvider({ children }) {
  const handlerRef = useRef((payload) => {
    setMetersMap(getMeterMap(payload));
  });

  const bindMeterSocket = useCallback((socket) => {
    if (!socket) {
      return () => {};
    }
    const handler = (payload) => handlerRef.current(payload);
    socket.on('engine:meter', handler);
    return () => socket.off('engine:meter', handler);
  }, []);

  return (
    <MetersBindContext.Provider value={bindMeterSocket}>
      {children}
    </MetersBindContext.Provider>
  );
}

export { useMeterPeak, useMixMasterPeak, useMetersMap } from '../lib/meter-store.js';

/**
 * Flat meter warning when native plays but all peaks stay near zero.
 * @param {object} props
 * @param {boolean} props.playing
 * @param {boolean} props.nativeOn
 * @param {number} props.trackCount
 * @param {Array<{ track_id?: number }>} props.tracks
 */
export function MixMeterFlatHint({ playing, nativeOn, trackCount, tracks }) {
  const mixMasterPeak = useMixMasterPeak(tracks);
  const [warning, setWarning] = useState(false);
  const sinceRef = useRef(null);

  useEffect(() => {
    const flat =
      playing && nativeOn && trackCount > 0 && Number(mixMasterPeak) < 0.001;
    if (!flat) {
      sinceRef.current = null;
      setWarning(false);
      return;
    }
    const now = Date.now();
    if (sinceRef.current == null) {
      sinceRef.current = now;
    }
    if (now - sinceRef.current > 2000) {
      setWarning(true);
    }
  }, [playing, nativeOn, trackCount, mixMasterPeak]);

  if (!warning) {
    return null;
  }

  return (
    <div className="alert alert-warning mix-meter-flat-hint" role="status">
      Pegelanzeige bleibt bei 0 während der Wiedergabe: die Native-Bridge liefert keine Pegel. Im
      Engine-Terminal nach <code className="mix-meter-flat-hint-code">transport.get_meters</code> schauen
      oder <code className="mix-meter-flat-hint-code">thestuu-native</code> neu bauen. Mit{' '}
      <code className="mix-meter-flat-hint-code">STUU_DEBUG_METERS=1</code> erscheinen Rohdaten im Log.
    </div>
  );
}
