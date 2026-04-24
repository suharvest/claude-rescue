// lib/job-control.mjs — background job lifecycle management
import { writeFileSync, readFileSync, readdirSync, existsSync, openSync, closeSync, statSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { newJobId, ensureJobDir, jobDir, stateRoot, readJobMeta, listRunningJobs, listAllJobs, sortJobsNewestFirst } from './state.mjs';
import { resolveSource, resolveEnv, assertDepthOk, currentDepth } from './sources.mjs';

function writeMeta(dir, data) {
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(data, null, 2));
}

export function getJob(jobId) {
  return readJobMeta(jobId);
}

export function listJobs(n = 10) {
  const allIds = listAllJobs();
  const sorted = sortJobsNewestFirst(allIds).slice(0, n);
  return sorted.map(id => {
    const meta = readJobMeta(id);
    return meta ? { id, ...meta } : null;
  }).filter(Boolean);
}

export { listRunningJobs, listAllJobs, sortJobsNewestFirst };

export function cancelJob(jobId) {
  const meta = getJob(jobId);
  if (!meta) throw new Error(`Job not found: ${jobId}`);
  if (meta.status !== 'running') {
    throw new Error(`Job ${jobId} is not running (status: ${meta.status})`);
  }

  const dir = jobDir(jobId);
  try {
    process.kill(meta.pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') {
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

// Double-fork pattern: parent (this process) spawns a task-worker that spawns claude.
// The parent returns immediately; the worker stays detached and manages claude.
export async function startJob(opts) {
  // opts: { prompt, source, model, cwd, resume }
  assertDepthOk();
  const jobId = newJobId();
  const dir = ensureJobDir(jobId);

  const source = resolveSource(opts.source);
  const env = resolveEnv(source);
  const model = opts.model || source.model;
  const depth = currentDepth() + 1;

  writeFileSync(join(dir, 'prompt.txt'), opts.prompt);

  const meta = {
    jobId,
    source: source.name,
    model,
    depth,
    cwd: opts.cwd || process.cwd(),
    prompt_preview: opts.prompt.slice(0, 120),
    resume: opts.resume || null,
    started_at: new Date().toISOString(),
    pid: null,
    status: 'running',
    exit_code: null,
    ended_at: null,
    session_id: null,
  };
  writeMeta(dir, meta);

  // Double-fork: spawn task-worker with stdio: 'ignore', detached: true.
  // Resolve the companion script relative to this file's location so it works
  // wherever the plugin is installed.
  const companionPath = join(new URL('.', import.meta.url).pathname, '..', 'claude-companion.mjs');

  const workerArgs = [
    companionPath,
    'task-worker',
    '--job-id', jobId,
  ];

  const worker = spawn(process.execPath, workerArgs, {
    cwd: dir,
    env: { ...process.env, ...env },
    detached: true,
    stdio: 'ignore',
  });

  worker.unref();

  // Update meta with worker pid
  meta.pid = worker.pid;
  writeMeta(dir, meta);

  return jobId;
}

// Run task-worker: spawned by startJob to actually run claude
export async function runTaskWorker(jobId) {
  const dir = jobDir(jobId);
  const meta = readJobMeta(jobId);
  if (!meta) throw new Error(`Job not found: ${jobId}`);

  // Open log files in append mode (get file descriptors)
  const stdoutFd = openSync(join(dir, 'stdout.log'), 'a');
  const stderrFd = openSync(join(dir, 'stderr.log'), 'a');

  const source = resolveSource(meta.source);
  const env = resolveEnv(source);
  const model = meta.model || source.model;

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--verbose',
  ];
  if (model) args.push('--model', model);
  if (meta.resume) args.push('--resume', meta.resume);
  // Read prompt from prompt.txt
  const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8');
  args.push(prompt);

  // Spawn claude grandchild
  const claude = spawn('claude', args, {
    env,
    cwd: meta.cwd || process.cwd(),
    stdio: ['ignore', stdoutFd, stderrFd],
    detached: false, // Not detached - we want to wait for it
  });

  // SIGTERM handler: propagate to claude, update status
  const onSigterm = () => {
    try {
      claude.kill('SIGTERM');
    } catch {}
    meta.status = 'cancelled';
    meta.exit_code = -15;
    meta.ended_at = new Date().toISOString();
    writeMeta(dir, meta);
    closeSync(stdoutFd);
    closeSync(stderrFd);
    process.exit(0);
  };
  process.on('SIGTERM', onSigterm);

  // Wait for claude to exit
  claude.on('close', (code) => {
    // Scan first ~4KB of stdout.log for session_id
    try {
      const logData = readFileSync(join(dir, 'stdout.log'), 'utf8');
      const firstChunk = logData.slice(0, 4096);
      const lines = firstChunk.split('\n');
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.session_id) {
            meta.session_id = event.session_id;
            break;
          }
        } catch {}
      }
    } catch {}

    meta.status = code === 0 ? 'done' : 'failed';
    meta.exit_code = code ?? -1;
    meta.ended_at = new Date().toISOString();
    writeMeta(dir, meta);

    closeSync(stdoutFd);
    closeSync(stderrFd);
    process.exit(code ?? 0);
  });

  claude.on('error', (err) => {
    meta.status = 'failed';
    meta.exit_code = -1;
    meta.error_message = err.message;
    meta.ended_at = new Date().toISOString();
    writeMeta(dir, meta);
    closeSync(stdoutFd);
    closeSync(stderrFd);
    process.exit(1);
  });
}