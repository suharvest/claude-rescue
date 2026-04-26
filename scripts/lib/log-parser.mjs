// lib/log-parser.mjs — parse stdout.log NDJSON for liveness signals
import { readFileSync, existsSync, statSync } from 'fs';

/**
 * Returns true if the event is an assistant message containing a tool_use block.
 */
export function isAssistantToolUse(event) {
  if (!event || event.type !== 'assistant') return false;
  const content = event.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(c => c.type === 'tool_use');
}

/**
 * Parse stdout.log for liveness signals.
 * @param {string} logPath  - absolute path to stdout.log
 * @param {Date}   now      - reference time (default: new Date())
 * @returns {{ last_event_ts: string|null, age_seconds: number|null, health: string, tool_use_last_60s: number }}
 */
export function parseStdoutLiveness(logPath, now = new Date()) {
  if (!existsSync(logPath)) {
    return { last_event_ts: null, age_seconds: null, health: 'stuck', tool_use_last_60s: 0 };
  }

  let raw;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return { last_event_ts: null, age_seconds: null, health: 'stuck', tool_use_last_60s: 0 };
  }

  const lines = raw.split('\n').filter(l => l.trim());
  const events = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      events.push(parsed);
    } catch {
      // skip malformed lines
    }
  }

  // Prefer event-level timestamps (precise activity); fall back to file mtime
  // when none of the events carry one — claude SDK's stream-json only stamps
  // certain event shapes (user/tool_result), so short or pure-reasoning runs
  // can produce a log full of untimestamped lines.
  let last_event_ts = null;
  let ts_source = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].timestamp) {
      last_event_ts = events[i].timestamp;
      ts_source = 'event';
      break;
    }
  }
  if (!last_event_ts) {
    try {
      last_event_ts = statSync(logPath).mtime.toISOString();
      ts_source = 'mtime';
    } catch {
      // unreadable; leave as null
    }
  }

  let age_seconds = null;
  let health = 'stuck';

  if (last_event_ts) {
    const lastTime = new Date(last_event_ts);
    age_seconds = Math.floor((now - lastTime) / 1000);

    if (age_seconds < 60) {
      health = 'healthy';
    } else if (age_seconds < 300) {
      health = 'slow';
    } else if (age_seconds < 900) {
      health = 'idle';
    } else {
      health = 'stuck';
    }
  }

  // Count tool_use events in the last 60 seconds
  const windowStart = new Date(now.getTime() - 60 * 1000);
  let tool_use_last_60s = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev.timestamp) continue;
    const evTime = new Date(ev.timestamp);
    if (evTime < windowStart) break;
    if (isAssistantToolUse(ev)) {
      tool_use_last_60s++;
    }
  }

  return { last_event_ts, age_seconds, health, tool_use_last_60s, ts_source };
}
