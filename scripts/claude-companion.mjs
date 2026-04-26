#!/usr/bin/env node
// claude-companion.mjs — CLI entry point for claude-rescue plugin
import { readFileSync, existsSync, writeFileSync, openSync, closeSync, createWriteStream } from 'fs';
import { join } from 'path';
import { PassThrough } from 'stream';
import { fileURLToPath } from 'url';
import { spawnClaude } from './lib/claude.mjs';
import { startJob, getJob, listJobs, cancelJob, runTaskWorker, waitForJob, DEFAULT_WAIT_TIMEOUT_MS, listRunningJobs } from './lib/job-control.mjs';
import { loadSources, resolveSource } from './lib/sources.mjs';
import { jobDir, getConfig, setConfig, validateJobId, newJobId, ensureJobDir, writeJobMeta } from './lib/state.mjs';
import { SESSION_ID_ENV } from './lib/tracked-jobs.mjs';
import { createRenderer } from './lib/render.mjs';
import { parseStdoutLiveness } from './lib/log-parser.mjs';

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const result = { cmd, flags: {}, positional: [] };

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--background') { result.flags.background = true; }
    else if (a === '--raw') { result.flags.raw = true; }
    else if (a === '--json') { result.flags.json = true; }
    else if (a === '--wait') { result.flags.wait = true; }
    else if (a === '--liveness') { result.flags.liveness = true; }
    else if (a === '--running') { result.flags.running = true; }
    else if (a === '--force') { result.flags.force = true; }
    else if (a === '--source' && args[i + 1]) { result.flags.source = args[++i]; }
    else if (a === '--model' && args[i + 1]) { result.flags.model = args[++i]; }
    else if (a === '--cwd' && args[i + 1]) { result.flags.cwd = args[++i]; }
    else if (a === '--resume' && args[i + 1]) { result.flags.resume = args[++i]; }
    else if (a === '--job-id' && args[i + 1]) { result.flags.jobId = args[++i]; }
    else if (a === '--timeout-ms' && args[i + 1]) { result.flags.timeoutMs = parseInt(args[++i], 10); }
    else if (a === '--poll-interval-ms' && args[i + 1]) { result.flags.pollIntervalMs = parseInt(args[++i], 10); }
    else if (a === '--enable') { result.flags.enable = true; }
    else if (a === '--disable') { result.flags.disable = true; }
    else if (a === '--toggle') { result.flags.toggle = true; }
    else if (a === '--status') { result.flags.status = true; }
    else if (!a.startsWith('--')) { result.positional.push(a); }
  }
  return result;
}

function printTable(rows, cols) {
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map(r => String(r[i] ?? '').length)));
  const line = widths.map(w => '-'.repeat(w)).join('-+-');
  const fmt = row => widths.map((w, i) => String(row[i] ?? '').padEnd(w)).join(' | ');
  console.log(fmt(cols));
  console.log(line);
  rows.forEach(r => console.log(fmt(r)));
}

// Gap 3 — Duplicate dispatch guard
const SIMILARITY_THRESHOLD = 0.85;

function computeJaccard(a, b) {
  const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const shingles = s => {
    const out = new Set();
    s = norm(s);
    for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3));
    return out;
  };
  const A = shingles(a);
  const B = shingles(b);
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return uni ? inter / uni : 0;
}

function findSimilarRunningJob(cwd, prompt) {
  const running = listRunningJobs();
  for (const job of running) {
    const jobId = job.id || job.jobId;
    const jobCwd = job.cwd;
    // cwd must strictly match
    if (jobCwd !== cwd) continue;
    // Read prompt.txt
    const promptPath = join(jobDir(jobId), 'prompt.txt');
    if (!existsSync(promptPath)) continue;
    let existingPrompt;
    try {
      existingPrompt = readFileSync(promptPath, 'utf8');
    } catch {
      continue;
    }
    const similarity = computeJaccard(prompt, existingPrompt);
    if (similarity >= SIMILARITY_THRESHOLD) {
      const age_seconds = job.started_at
        ? Math.floor((Date.now() - new Date(job.started_at)) / 1000)
        : null;
      return { jobId, age_seconds, similarity };
    }
  }
  return null;
}

async function cmdListSources() {
  const config = loadSources();
  const rows = Object.entries(config.sources).map(([name, s]) => {
    const baseUrl = s.env?.ANTHROPIC_BASE_URL || '(default Anthropic)';
    const envKeys = Object.keys(s.env || {}).join(', ');
    return [name === config.default ? `${name} *` : name, s.description, s.model, envKeys];
  });
  printTable(rows, ['name', 'description', 'model', 'env keys']);
  console.log('\n* = default source');
}

async function cmdTask(parsed) {
  const prompt = parsed.positional[0];
  if (!prompt) { console.error('Usage: task "<prompt>" [--source <name>] [--model <model>] [--cwd <dir>] [--background] [--raw] [--force]'); process.exit(1); }

  // Read CLAUDE_RESCUE_SESSION_ID from environment if set (propagated via CLAUDE_ENV_FILE by session-lifecycle-hook)
  const sessionId = process.env[SESSION_ID_ENV] || null;

  const opts = {
    prompt,
    source: parsed.flags.source,
    model: parsed.flags.model,
    cwd: parsed.flags.cwd,
    resume: parsed.flags.resume,
    sessionId, // Pass to startJob if provided
  };

  // Gap 3: duplicate dispatch guard
  if (!parsed.flags.force) {
    const currentCwd = parsed.flags.cwd || process.cwd();
    const similar = findSimilarRunningJob(currentCwd, prompt);
    if (similar) {
      process.stderr.write(
        `Refusing to launch: similar job already running (jobId=${similar.jobId}, age=${similar.age_seconds}s, similarity=${similar.similarity.toFixed(2)}).\n` +
        `Re-run with --force to launch anyway, or attach with: rescue-status ${similar.jobId}\n`
      );
      process.exit(2);
    }
  }

  if (parsed.flags.background) {
    const jobId = await startJob(opts);
    console.log(`[claude-rescue] Job started: ${jobId}`);
    console.log(`[claude-rescue] Tail logs: tail -f ~/.claude/plugins/data/claude-rescue/jobs/${jobId}/stdout.log`);
    console.log(`[claude-rescue] Check status: node scripts/claude-companion.mjs status ${jobId}`);
    return;
  }

  // Foreground: stream through renderer (unless --raw)
  // === Gap 2: register a real foreground job dir ===
  const fgJobId = newJobId();
  const fgDir = ensureJobDir(fgJobId);

  writeFileSync(join(fgDir, 'prompt.txt'), prompt);

  const fgSource = resolveSource(parsed.flags.source);
  const fgMeta = {
    jobId: fgJobId,
    source: fgSource.name,
    model: parsed.flags.model || fgSource.model,
    depth: 1,
    cwd: opts.cwd || process.cwd(),
    prompt_preview: prompt.slice(0, 120),
    resume: opts.resume || null,
    started_at: new Date().toISOString(),
    pid: process.pid,
    status: 'running',
    exit_code: null,
    ended_at: null,
    session_id: opts.sessionId || null,
    mode: 'foreground',
  };
  writeJobMeta(fgJobId, fgMeta);

  process.stderr.write(`Job started: ${fgJobId}\n`);

  const fgStdoutFd = openSync(join(fgDir, 'stdout.log'), 'a');
  const fgLogStream = createWriteStream(null, { fd: fgStdoutFd, flags: 'a' });

  // Note: rendererSessionId is the session ID from the child claude process output,
  // separate from the parent sessionId (CLAUDE_RESCUE_SESSION_ID env var) passed to startJob.
  let rendererSessionId = null;
  const renderer = createRenderer({
    raw: parsed.flags.raw,
    onSessionId: (id) => { rendererSessionId = id; },
  });

  const fgTee = new PassThrough();
  fgTee.pipe(fgLogStream);
  fgTee.pipe(renderer);
  renderer.pipe(process.stdout);

  const code = await spawnClaude({ ...opts, stdout: fgTee, stderr: process.stderr });

  const finalStatus = code === 0 ? 'completed' : 'failed';
  writeJobMeta(fgJobId, {
    ...fgMeta,
    status: finalStatus,
    pid: null,
    exit_code: code,
    ended_at: new Date().toISOString(),
  });

  try { closeSync(fgStdoutFd); } catch {}

  if (rendererSessionId) {
    console.log(`[claude-rescue] session-id: ${rendererSessionId}`);
  }
  process.exit(code);
}

async function cmdTaskWorker(parsed) {
  const jobId = parsed.flags.jobId;
  if (!jobId) {
    console.error('Usage: task-worker --job-id <job-id>');
    process.exit(1);
  }
  await runTaskWorker(jobId);
}

async function cmdStatus(parsed) {
  const jobId = parsed.positional[0];

  // Gap 1: --liveness requires jobId
  if (parsed.flags.liveness) {
    if (!jobId) {
      console.error('status --liveness requires a job id');
      process.exit(1);
    }
    validateJobId(jobId);
    const logPath = join(jobDir(jobId), 'stdout.log');
    const result = parseStdoutLiveness(logPath);
    if (parsed.flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Job:            ${jobId}`);
      console.log(`Last event:     ${result.last_event_ts || '(none)'}`);
      console.log(`Age (seconds):  ${result.age_seconds ?? '(unknown)'}`);
      console.log(`Health:         ${result.health}`);
      console.log(`Tool use /60s:  ${result.tool_use_last_60s}`);
    }
    return;
  }

  // Gap 4: --running overview (no jobId required)
  if (parsed.flags.running) {
    const running = listRunningJobs();
    // Sort by started_at ascending (oldest first = largest age at top)
    running.sort((a, b) => {
      const ta = a.started_at ? new Date(a.started_at).getTime() : 0;
      const tb = b.started_at ? new Date(b.started_at).getTime() : 0;
      return ta - tb;
    });
    const now = new Date();
    const enriched = running.map(job => {
      const jId = job.id || job.jobId;
      const logPath = join(jobDir(jId), 'stdout.log');
      const liveness = parseStdoutLiveness(logPath, now);
      const age_seconds = job.started_at
        ? Math.floor((now - new Date(job.started_at)) / 1000)
        : null;
      return {
        jobId: jId,
        age_seconds,
        last_event_age_seconds: liveness.age_seconds,
        cwd: job.cwd || '',
      };
    });
    if (parsed.flags.json) {
      console.log(JSON.stringify(enriched, null, 2));
    } else {
      if (!enriched.length) {
        console.log('No running jobs.');
        return;
      }
      for (const e of enriched) {
        const ageFmt = e.age_seconds != null ? `${Math.floor(e.age_seconds / 60)}m${e.age_seconds % 60}s` : '?';
        const lastFmt = e.last_event_age_seconds != null ? `${e.last_event_age_seconds}s` : '?';
        const cwdTrunc = e.cwd.length > 40 ? '...' + e.cwd.slice(-37) : e.cwd;
        console.log(`${e.jobId}  age=${ageFmt}  last=${lastFmt}  cwd=${cwdTrunc}`);
      }
    }
    return;
  }

  // --wait requires a jobId
  if (parsed.flags.wait && !jobId) {
    console.error('status --wait requires a job id');
    process.exit(1);
  }

  if (jobId) {
    validateJobId(jobId);

    // If --wait, poll until terminal state
    if (parsed.flags.wait) {
      const timeoutMs = parsed.flags.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const pollIntervalMs = parsed.flags.pollIntervalMs ?? 1000;
      const meta = await waitForJob(jobId, { timeoutMs, pollIntervalMs });

      // Print final status section
      if (parsed.flags.json) {
        console.log(JSON.stringify(meta, null, 2));
      } else {
        const durationMs = meta.started_at && meta.ended_at
          ? (new Date(meta.ended_at) - new Date(meta.started_at))
          : null;
        console.log(`=== Job ${jobId} finished: ${meta.status} (exit_code=${meta.exit_code ?? 'none'}) ===`);
        console.log(`Session: ${meta.session_id || 'none'}`);
        console.log(`Started: ${meta.started_at}  Ended: ${meta.ended_at}  Duration: ${durationMs ? durationMs + 'ms' : 'unknown'}`);
        console.log(`Source: ${meta.source}  Model: ${meta.model}`);

        // Tail last ~100 lines of stdout.log
        const logPath = join(jobDir(jobId), 'stdout.log');
        if (existsSync(logPath)) {
          console.log('\n--- Last 100 lines of stdout.log ---');
          const logData = readFileSync(logPath, 'utf8');
          const lines = logData.split('\n').filter(l => l.trim());
          const tail = lines.slice(-100);
          tail.forEach(l => console.log(l));
        } else {
          console.log('\n--- stdout.log not found ---');
        }
      }
      return;
    }

    // No --wait: just show current status
    const meta = getJob(jobId);
    if (parsed.flags.json) {
      console.log(JSON.stringify(meta, null, 2));
    } else {
      console.log(`Job: ${jobId}`);
      console.log(`Status: ${meta?.status}`);
      console.log(`Source: ${meta?.source}`);
      console.log(`Model: ${meta?.model}`);
      console.log(`Started: ${meta?.started_at}`);
      console.log(`Ended: ${meta?.ended_at || '(still running)'}`);
      console.log(`Session: ${meta?.session_id || '(not captured yet)'}`);
      console.log(`Exit code: ${meta?.exit_code ?? '(none)'}`);
      console.log(`PID: ${meta?.pid}`);
    }
  } else {
    const jobs = listJobs(10);
    if (!jobs.length) { console.log('No jobs found.'); return; }
    if (parsed.flags.json) {
      console.log(JSON.stringify(jobs, null, 2));
    } else {
      const rows = jobs.map(j => [j.id || j.jobId, j.status, j.source, j.started_at, (j.prompt_preview || '').slice(0, 40)]);
      printTable(rows, ['job-id', 'status', 'source', 'started_at', 'prompt_preview']);
    }
  }
}

async function cmdResult(parsed) {
  const jobId = parsed.positional[0];
  if (!jobId) { console.error('Usage: result <job-id>'); process.exit(1); }
  validateJobId(jobId);
  const logPath = join(jobDir(jobId), 'stdout.log');
  if (!existsSync(logPath)) { console.error(`No stdout.log found for job: ${jobId}`); process.exit(1); }
  process.stdout.write(readFileSync(logPath));
}

async function cmdCancel(parsed) {
  const jobId = parsed.positional[0];
  if (!jobId) { console.error('Usage: cancel <job-id>'); process.exit(1); }
  validateJobId(jobId);
  const meta = cancelJob(jobId);
  console.log(`[claude-rescue] Cancelled job ${jobId} (pid ${meta.pid})`);
}

async function cmdSetup(parsed) {
  const config = getConfig();

  if (parsed.flags.status || (!parsed.flags.enable && !parsed.flags.disable && !parsed.flags.toggle)) {
    console.log(`stopReviewGate: ${config.stopReviewGate ? 'enabled' : 'disabled'}`);
    console.log('');
    console.log('When enabled, Stop events are blocked if jobs are running for this session.');
    console.log('When disabled, Stop events always proceed without blocking.');
  } else if (parsed.flags.enable) {
    setConfig('stopReviewGate', true);
    console.log('[claude-rescue] Enabled stop-review-gate.');
    console.log('Stop events will be blocked if jobs are running for this session.');
  } else if (parsed.flags.disable) {
    setConfig('stopReviewGate', false);
    console.log('[claude-rescue] Disabled stop-review-gate.');
    console.log('Stop events will always proceed without blocking.');
  } else if (parsed.flags.toggle) {
    const newValue = !config.stopReviewGate;
    setConfig('stopReviewGate', newValue);
    console.log(`[claude-rescue] Toggled stop-review-gate to ${newValue ? 'enabled' : 'disabled'}.`);
  } else {
    console.error(`Usage: setup [--enable|--disable|--toggle|--status]`);
    process.exit(1);
  }
}

async function main() {
  const parsed = parseArgs(process.argv);
  try {
    switch (parsed.cmd) {
      case 'task':         await cmdTask(parsed); break;
      case 'task-worker':  await cmdTaskWorker(parsed); break;
      case 'status':       await cmdStatus(parsed); break;
      case 'result':       await cmdResult(parsed); break;
      case 'cancel':       await cmdCancel(parsed); break;
      case 'setup':        await cmdSetup(parsed); break;
      case 'list-sources': await cmdListSources(parsed); break;
      default:
        console.error(`Unknown command: ${parsed.cmd}`);
        console.error('Commands: task, task-worker, status, result, cancel, setup, list-sources');
        process.exit(1);
    }
  } catch (err) {
    console.error(`[claude-rescue] Error: ${err.message}`);
    process.exit(1);
  }
}

main();
