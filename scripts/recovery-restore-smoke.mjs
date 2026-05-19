#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { io } = require('../apps/dashboard/node_modules/socket.io-client/build/cjs/index.js');

const home = process.env.STUU_HOME || path.join(os.homedir(), '.thestuu');
const latest = path.join(home, 'autosave', 'latest.autosave.stu');
const primary = path.join(home, 'projects', 'welcome.stu');

const socket = io('http://127.0.0.1:3990', { transports: ['websocket'] });
const logs = [];
socket.on('engine:log', (e) => {
  if (e?.category === 'recovery' || String(e?.text || '').includes('[recovery]')) {
    logs.push(e.text);
  }
});

await new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', reject);
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('ready timeout')), 20000);
  socket.once('engine:ready', () => { clearTimeout(t); resolve(); });
});

const before = readFileSync(primary, 'utf8');
const res = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('restore timeout')), 120000);
  socket.emit('recovery:restore', { path: latest }, (r) => {
    clearTimeout(t);
    r?.ok ? resolve(r) : reject(new Error(r?.error || 'restore failed'));
  });
});
const after = readFileSync(primary, 'utf8');
console.log('restore:', res.ok, 'primary unchanged:', before === after);

await new Promise((resolve, reject) => {
  socket.emit('recovery:dismiss', {}, (r) => {
    r?.ok ? resolve() : reject(new Error(r?.error || 'dismiss failed'));
  });
});
console.log('dismiss ok, primary exists:', existsSync(primary));
console.log('recovery log lines:', logs.length);
socket.close();
