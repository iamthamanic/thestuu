import { io } from 'socket.io-client';

/** Engine Socket.IO URL — build-time env, Tauri inject, or default local Node sidecar. */
export function resolveEngineUrl() {
  if (typeof window !== 'undefined') {
    const runtime = window.__THESTUU_ENGINE_URL__;
    if (typeof runtime === 'string' && runtime.trim()) {
      return runtime.trim();
    }
  }
  return process.env.NEXT_PUBLIC_ENGINE_URL || 'http://127.0.0.1:3990';
}

export function createEngineSocket() {
  const url = resolveEngineUrl();
  return io(url, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelayMax: 4000,
  });
}
