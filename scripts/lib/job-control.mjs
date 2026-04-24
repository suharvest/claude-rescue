// lib/job-control.mjs — background job lifecycle management
import { writeFileSync, readFileSync, readdirSync, createWriteStream, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { newJobId, ensureJobDir, jobDir, stateRoot } from './state.mjs';
import { resolveSource, resolveEnv, assertDepthOk, currentDepth } from './sources.mjs';

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

export function cancelJob(jobId) {
  const meta = getJob(jobId);
  if (meta.status !== 'running') {
    throw new Error(`Job ${jobId} is not running (status: ${meta.status})`);
  }

  const dir = jobDir(jobId);
  try {
    process.kill(meta.pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') {
      // Process already dead — mark as orphaned but still succeed
      meta.status = 'orphaned';
    } else {
      throw err;
    }
  }

  if (meta.status !== 'orphaned') {
    meta.status = 'cancelled';
  }
  meta.exit_code = -15;
  meta.ended_at = new Date().toISOString();
  writeMeta(dir, meta);
  return meta;
}

export async function startJob(opts) {
  // opts: { prompt, source, model, cwd }
  assertDepthOk();
  const jobId = newJobId();
  const dir = ensureJobDir(jobId);

  const source = resolveSource(opts.source);
  const env = resolveEnv(source);
  const model = opts.model || source.model;
  const depth = currentDepth() + 1;

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
    depth,
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
