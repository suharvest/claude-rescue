// lib/job-control.mjs — background job lifecycle management
import { writeFileSync, readFileSync, readdirSync, createWriteStream, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { newJobId, ensureJobDir, jobDir, stateRoot } from './state.mjs';
import { resolveSource, resolveEnv } from './sources.mjs';

function writeMeta(dir, data) {
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(data, null, 2));
}

export function getJob(jobId) {
  const metaPath = join(jobDir(jobId), 'meta.json');
  if (!existsSync(metaPath)) throw new Error(`Job not found: ${jobId}`);
  return JSON.parse(readFileSync(metaPath, 'utf8'));
}

export function listJobs(n = 10) {
  const jobsDir = join(stateRoot(), 'jobs');
  if (!existsSync(jobsDir)) return [];
  const dirs = readdirSync(jobsDir).sort().reverse().slice(0, n);
  return dirs.map(id => {
    try { return { id, ...getJob(id) }; } catch { return null; }
  }).filter(Boolean);
}

export async function startJob(opts) {
  // opts: { prompt, source, model, cwd }
  const jobId = newJobId();
  const dir = ensureJobDir(jobId);

  const source = resolveSource(opts.source);
  const env = resolveEnv(source);
  const model = opts.model || source.model;

  writeFileSync(join(dir, 'prompt.txt'), opts.prompt);

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--verbose',
  ];
  if (model) args.push('--model', model);
  args.push(opts.prompt);

  const stdoutLog = createWriteStream(join(dir, 'stdout.log'));
  const stderrLog = createWriteStream(join(dir, 'stderr.log'));

  const meta = {
    jobId,
    source: source.name,
    model,
    cwd: opts.cwd || process.cwd(),
    prompt_preview: opts.prompt.slice(0, 120),
    started_at: new Date().toISOString(),
    pid: null,
    status: 'running',
    exit_code: null,
    ended_at: null,
  };
  writeMeta(dir, meta);

  const child = spawn('claude', args, {
    env,
    cwd: opts.cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  meta.pid = child.pid;
  writeMeta(dir, meta);

  child.stdout.pipe(stdoutLog);
  child.stderr.pipe(stderrLog);

  child.on('close', (code) => {
    meta.status = code === 0 ? 'done' : 'failed';
    meta.exit_code = code ?? -1;
    meta.ended_at = new Date().toISOString();
    writeMeta(dir, meta);
    stdoutLog.end();
    stderrLog.end();
  });

  child.unref();
  return jobId;
}
