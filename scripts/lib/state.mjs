// lib/state.mjs — state directory layout for claude-rescue jobs
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

export function stateRoot() {
  return join(homedir(), '.claude', 'plugins', 'data', 'claude-rescue');
}

export function jobDir(jobId) {
  return join(stateRoot(), 'jobs', jobId);
}

export function newJobId() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const hex = randomBytes(3).toString('hex');
  return `${date}-${time}-${hex}`;
}

export function ensureJobDir(jobId) {
  const dir = jobDir(jobId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
