// lib/watch.mjs — observability: tail subagent transcripts (the source of truth).
//
// Claude Code writes a per-subagent JSONL transcript to:
//   ~/.claude/projects/<slug>/<sessionId>/subagents/agent-*.jsonl
// where <slug> is the cwd with '/' replaced by '-'.
//
// For Agent(subagent_type=claude-rescue) (the dominant path), this transcript IS
// the live record of what the subagent is doing — there is no jobs/<id>/ entry
// because the companion is invoked synchronously from the subagent's Bash call.
//
// `watch` finds the freshest agent-*.jsonl files in the project that matches
// `cwd` and tails them, optionally pretty-printing events.

import { existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOME = homedir();
const PROJECTS_ROOT = join(HOME, '.claude', 'projects');

export function cwdToSlug(cwd) {
  // Claude Code's project slugs are the absolute path with '/' → '-'.
  return cwd.replace(/\//g, '-');
}

export function findProjectDir(cwd) {
  const slug = cwdToSlug(cwd);
  const dir = join(PROJECTS_ROOT, slug);
  if (!existsSync(dir)) return null;
  return dir;
}

// Walk into <project>/<sessionId>/subagents/agent-*.jsonl, return entries sorted
// by mtime desc. Each entry: { path, mtime, size, agentId, sessionId }.
export function listSubagentTranscripts(cwd, { limit = 0, sinceMs = 0 } = {}) {
  const projectDir = findProjectDir(cwd);
  if (!projectDir) return [];
  const out = [];
  let sessionDirs;
  try {
    sessionDirs = readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of sessionDirs) {
    if (!ent.isDirectory()) continue;
    const subDir = join(projectDir, ent.name, 'subagents');
    if (!existsSync(subDir)) continue;
    let files;
    try {
      files = readdirSync(subDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
      const p = join(subDir, f);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (sinceMs > 0 && st.mtimeMs < sinceMs) continue;
      out.push({
        path: p,
        mtime: st.mtimeMs,
        size: st.size,
        agentId: f.replace(/^agent-/, '').replace(/\.jsonl$/, ''),
        sessionId: ent.name,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return limit > 0 ? out.slice(0, limit) : out;
}

// Render one JSONL event in a compact human-readable line. Returns null to skip.
export function prettyEvent(evt, { agentId } = {}) {
  if (!evt || typeof evt !== 'object') return null;
  const ts = evt.timestamp ? evt.timestamp.replace(/\.\d+Z$/, 'Z') : '';
  const tag = `[${agentId || ''}]`;
  const t = evt.type;

  if (t === 'user') {
    const c = evt.message?.content;
    if (typeof c === 'string') {
      const head = c.length > 200 ? c.slice(0, 200) + '…' : c;
      return `${ts} ${tag} USER: ${head.replace(/\n/g, ' ⏎ ')}`;
    }
    if (Array.isArray(c)) {
      // Most likely tool_result blocks coming back to the model.
      const parts = c.map(b => {
        if (b.type === 'tool_result') {
          const inner = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content) ? b.content.map(x => x.text || '').join('') : '';
          const head = inner.length > 160 ? inner.slice(0, 160) + '…' : inner;
          return `tool_result(${b.tool_use_id?.slice(-8) ?? '?'}, ${b.is_error ? 'error' : 'ok'}): ${head.replace(/\n/g, ' ⏎ ')}`;
        }
        if (b.type === 'text') return `text: ${(b.text || '').slice(0, 160)}`;
        return b.type || 'block';
      });
      return `${ts} ${tag} USER: ${parts.join(' | ')}`;
    }
    return `${ts} ${tag} USER`;
  }

  if (t === 'assistant') {
    const blocks = evt.message?.content || [];
    const lines = [];
    for (const b of blocks) {
      if (b.type === 'thinking') {
        const head = (b.thinking || '').replace(/\n/g, ' ').slice(0, 120);
        lines.push(`thinking: ${head}${(b.thinking || '').length > 120 ? '…' : ''}`);
      } else if (b.type === 'text') {
        const head = (b.text || '').replace(/\n/g, ' ').slice(0, 200);
        lines.push(`text: ${head}${(b.text || '').length > 200 ? '…' : ''}`);
      } else if (b.type === 'tool_use') {
        const name = b.name || '?';
        let arg = '';
        try {
          if (name === 'Bash') arg = (b.input?.command || '').slice(0, 160);
          else if (name === 'Read') arg = b.input?.file_path || '';
          else if (name === 'Edit' || name === 'Write') arg = b.input?.file_path || '';
          else arg = JSON.stringify(b.input || {}).slice(0, 160);
        } catch { arg = ''; }
        lines.push(`tool_use ${name}: ${arg.replace(/\n/g, ' ⏎ ')}`);
      } else {
        lines.push(b.type || 'block');
      }
    }
    return lines.length ? `${ts} ${tag} ASSIST: ${lines.join(' | ')}` : null;
  }

  return null;
}

// Tail-follow a JSONL file. Calls onLine(rawLine, parsedOrNull) per line.
// Returns a stop() function.
export function tailFile(path, onLine, { fromStart = false, pollMs = 250 } = {}) {
  let pos = 0;
  if (!fromStart) {
    try { pos = statSync(path).size; } catch { pos = 0; }
  }
  let buf = '';
  let stopped = false;

  function tick() {
    if (stopped) return;
    let st;
    try { st = statSync(path); } catch { setTimeout(tick, pollMs); return; }
    if (st.size < pos) {
      // file truncated/rotated — restart from 0
      pos = 0;
      buf = '';
    }
    if (st.size > pos) {
      const fd = openSync(path, 'r');
      const len = st.size - pos;
      const chunk = Buffer.alloc(Math.min(len, 1 << 20));
      let read = 0;
      while (read < len) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, len - read), pos + read);
        if (!n) break;
        buf += chunk.slice(0, n).toString('utf8');
        read += n;
      }
      closeSync(fd);
      pos += read;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        let parsed = null;
        try { parsed = JSON.parse(line); } catch {}
        try { onLine(line, parsed); } catch {}
      }
    }
    setTimeout(tick, pollMs);
  }
  tick();
  return () => { stopped = true; };
}

export function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}
