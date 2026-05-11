import { io } from 'socket.io-client';

export function createEngineSocket() {
  const url = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://127.0.0.1:3990';
  return io(url, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelayMax: 4000,
  });
}
