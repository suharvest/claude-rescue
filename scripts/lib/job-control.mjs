// lib/job-control.mjs — background job lifecycle management
import { writeFileSync, readFileSync, openSync, closeSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { newJobId, ensureJobDir, jobDir, readJobMeta, writeJobMeta, listRunningJobs, listAllJobs, sortJobsNewestFirst, validateJobId } from './state.mjs';
import { resolveSource, resolveEnv, assertDepthOk, currentDepth } from './sources.mjs';
import { trackJob } from './tracked-jobs.mjs';

// Default timeout for waitForJob (30 minutes)
export const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

export function getJob(jobId) {
  validateJobId(jobId);
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

// Cancel a job: send SIGTERM to worker, poll until status leaves running/cancelling.
// Worker handles killing the grandchild and writing final meta.
export function cancelJob(jobId) {
  validateJobId(jobId);
  const meta = getJob(jobId);
  if (!meta) throw new Error(`Job not found: ${jobId}`);
  if (meta.status !== 'running') {
    throw new Error(`Job ${jobId} is not running (status: ${meta.status})`);
  }
  if (!meta.pid) throw new Error(`Job ${jobId} has no PID recorded`);

  // Send SIGTERM to the worker (worker will handle everything else)
  try {
    process.kill(meta.pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') {
      // Worker already dead - mark orphaned
      const orphanMeta = { ...meta, status: 'orphaned', ended_at: new Date().toISOString(), exit_code: meta.exit_code ?? -1 };
      writeJobMeta(jobId, orphanMeta);
      return orphanMeta;
    }
    throw err;
  }

  // Poll meta.json for up to 10s waiting for status to leave 'running'/'cancelling'
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = readJobMeta(jobId);
    if (!current || current.status !== 'running' && current.status !== 'cancelling') {
      return current || meta;
    }
    // Brief sleep (20-50ms)
    const end = Date.now() + 20 + Math.floor(Math.random() * 30);
    while (Date.now() < end) {}
  }
  // Timeout - return whatever we have
  return readJobMeta(jobId) || meta;
}

// Wait for a job to reach a terminal state (done/failed/cancelled/orphaned).
// timeoutMs = 0 means wait forever.
export async function waitForJob(jobId, { pollIntervalMs = 1000, timeoutMs = 0 } = {}) {
  validateJobId(jobId);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  while (true) {
    const meta = readJobMeta(jobId);
    if (!meta) throw new Error(`Job not found: ${jobId}`);
    if (meta.status !== 'running' && meta.status !== 'cancelling') {
      return meta; // terminal: done | failed | cancelled | orphaned
    }
    if (Date.now() >= deadline) {
      throw new Error(`Wait timeout (${timeoutMs}ms) for job ${jobId}; current status: ${meta.status}`);
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
}

// Double-fork pattern: parent (this process) spawns a task-worker that spawns claude.
// The parent returns immediately; the worker stays detached and manages claude.
export async function startJob(opts) {
  // opts: { prompt, source, model, cwd, resume, sessionId }
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
    session_id: opts.sessionId || null,
  };
  writeJobMeta(jobId, meta);

  // Track job under session if sessionId provided
  if (opts.sessionId) {
    trackJob(opts.sessionId, jobId);
  }

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
  writeJobMeta(jobId, meta);

  return jobId;
}

// Run task-worker: spawned by startJob to actually run claude
export async function runTaskWorker(jobId) {
  validateJobId(jobId);
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

  // Spawn claude grandchild with detached: true so it gets its own process group
  const claude = spawn('claude', args, {
    env,
    cwd: meta.cwd || process.cwd(),
    stdio: ['ignore', stdoutFd, stderrFd],
    detached: true, // Grandchild gets own process group (pgid == pid)
  });

  // Track whether we're in cancelling state
  let cancelling = false;
  let killTimer = null;

  // SIGTERM handler: worker-owned cancel
  const onSigterm = () => {
    // 1. Write meta.status = 'cancelling' (atomic write)
    cancelling = true;
    const cancellingMeta = { ...meta, status: 'cancelling' };
    writeJobMeta(jobId, cancellingMeta);

    // 2. Send SIGTERM to grandchild's process group
    try {
      process.kill(-claude.pid, 'SIGTERM');
    } catch (e) {
      // Process may already be dead
    }

    // 3. Set 5-second timer: if still alive, SIGKILL
    killTimer = setTimeout(() => {
      try {
        process.kill(-claude.pid, 'SIGKILL');
      } catch (e) {
        // Process may already be dead
      }
    }, 5000);

    // 4. Do NOT call process.exit - let child close handler run
  };
  process.on('SIGTERM', onSigterm);

  // Wait for claude to exit - this handler writes final meta (terminal status)
  claude.on('close', (code) => {
    // Clear kill timer if set
    if (killTimer) clearTimeout(killTimer);

    // Scan first ~4KB of stdout.log for session_id
    let capturedSessionId = null;
    try {
      const logData = readFileSync(join(dir, 'stdout.log'), 'utf8');
      const firstChunk = logData.slice(0, 4096);
      const lines = firstChunk.split('\n');
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.session_id) {
            capturedSessionId = event.session_id;
            break;
          }
        } catch {}
      }
    } catch {}

    // Final meta write - EXACTLY ONCE
    const finalMeta = {
      ...meta,
      session_id: capturedSessionId || meta.session_id,
      // If we were cancelling and got here, mark cancelled
      status: cancelling ? 'cancelled' : (code === 0 ? 'done' : 'failed'),
      exit_code: cancelling ? -15 : (code ?? -1),
      ended_at: new Date().toISOString(),
    };
    writeJobMeta(jobId, finalMeta);

    closeSync(stdoutFd);
    closeSync(stderrFd);
    process.exit(finalMeta.exit_code);
  });

  claude.on('error', (err) => {
    // Clear kill timer if set
    if (killTimer) clearTimeout(killTimer);

    const errorMeta = {
      ...meta,
      status: 'failed',
      exit_code: -1,
      error_message: err.message,
      ended_at: new Date().toISOString(),
    };
    writeJobMeta(jobId, errorMeta);
    closeSync(stdoutFd);
    closeSync(stderrFd);
    process.exit(1);
  });
}