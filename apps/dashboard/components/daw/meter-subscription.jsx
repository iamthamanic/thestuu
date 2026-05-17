'use client';

/**
 * Tells the engine when to pause meter IPC (hidden tab or non Edit/Mix view).
 * Location: apps/dashboard/components/daw — mount inside StuuShell
 */

import { useEffect, useRef } from 'react';

const METER_TABS = new Set(['Edit', 'Mix']);

/**
 * @param {object} props
 * @param {import('react').MutableRefObject<import('socket.io-client').Socket | null>} props.socketRef
 * @param {'connecting'|'online'|'offline'} props.connection
 * @param {string} props.activeTab
 */
export default function MeterSubscription({ socketRef, connection, activeTab }) {
  const pausedRef = useRef(true);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || connection !== 'online') {
      return undefined;
    }

    const paused =
      typeof document !== 'undefined' && document.hidden
        ? true
        : !METER_TABS.has(activeTab);

    pausedRef.current = paused;
    socket.emit('client:meter_pause', { paused });

    const onVisibility = () => {
      const nextPaused =
        document.hidden || !METER_TABS.has(activeTab);
      if (nextPaused !== pausedRef.current) {
        pausedRef.current = nextPaused;
        socketRef.current?.emit('client:meter_pause', { paused: nextPaused });
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [socketRef, connection, activeTab]);

  return null;
}
