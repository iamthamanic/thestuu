import net from 'node:net';
import { EventEmitter } from 'node:events';
import { pack, unpack } from 'msgpackr';

const FRAME_HEADER_BYTES = 4;

function encodeFrame(payload) {
  const body = pack(payload);
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export class NativeTransportClient extends EventEmitter {
  constructor({ socketPath, requestTimeoutMs = 2000, reconnectDelayMs = 750 } = {}) {
    super();
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.reconnectDelayMs = reconnectDelayMs;
    this.socket = null;
    this.connected = false;
    this.stopped = false;
    this.reconnectTimer = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.incomingBuffer = Buffer.alloc(0);
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectPending(new Error('native transport client stopped'));
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.incomingBuffer = Buffer.alloc(0);
  }

  async connect() {
    if (this.connected && this.socket) {
      return;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = net.createConnection({ path: this.socketPath });

      socket.once('connect', () => {
        this.socket = socket;
        this.connected = true;
        if (!settled) {
          settled = true;
          resolve();
        }
        this.emit('connect');
      });

      socket.on('data', (chunk) => {
        this.handleData(chunk);
      });

      socket.on('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.emit('error', error);
      });

      socket.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        this.incomingBuffer = Buffer.alloc(0);
        this.rejectPending(new Error('native transport disconnected'));
        if (wasConnected) {
          this.emit('disconnect');
        }
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      });
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(cmd, payload = {}) {
    if (!this.connected || !this.socket) {
      throw new Error('native transport is not connected');
    }

    const id = this.nextRequestId++;
    const message = {
      type: 'request',
      id,
      cmd,
      payload,
    };

    const frame = encodeFrame(message);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`native transport request timeout: ${cmd}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(frame, (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  handleData(chunk) {
    this.incomingBuffer = Buffer.concat([this.incomingBuffer, chunk]);

    while (this.incomingBuffer.length >= FRAME_HEADER_BYTES) {
      const frameLength = this.incomingBuffer.readUInt32BE(0);
      const frameEnd = FRAME_HEADER_BYTES + frameLength;
      if (this.incomingBuffer.length < frameEnd) {
        return;
      }

      const frame = this.incomingBuffer.subarray(FRAME_HEADER_BYTES, frameEnd);
      this.incomingBuffer = this.incomingBuffer.subarray(frameEnd);

      let message;
      try {
        message = unpack(frame);
      } catch (error) {
        this.emit('error', error);
        continue;
      }

      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if (message.ok === false) {
        pending.reject(new Error(message.error || 'native transport request failed'));
        return;
      }

      pending.resolve(message.payload ?? {});
      return;
    }

    if (message.type === 'event') {
      this.emit('event', message.event, message.payload ?? {});
    }
  }
}
