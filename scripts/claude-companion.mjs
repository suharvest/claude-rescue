#!/usr/bin/env node
// claude-companion.mjs — CLI entry point for claude-rescue plugin
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnClaude } from './lib/claude.mjs';
import { startJob, getJob, listJobs, cancelJob, runTaskWorker, listRunningJobs } from './lib/job-control.mjs';
import { loadSources } from './lib/sources.mjs';
import { jobDir, getConfig, setConfig } from './lib/state.mjs';
import { SESSION_ID_ENV } from './lib/tracked-jobs.mjs';
import { createRenderer } from './lib/render.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const result = { cmd, flags: {}, positional: [] };

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--background') { result.flags.background = true; }
    else if (a === '--wait') { result.flags.wait = true; }
    else if (a === '--raw') { result.flags.raw = true; }
    else if (a === '--json') { result.flags.json = true; }
    else if (a === '--source' && args[i + 1]) { result.flags.source = args[++i]; }
    else if (a === '--model' && args[i + 1]) { result.flags.model = args[++i]; }
    else if (a === '--cwd' && args[i + 1]) { result.flags.cwd = args[++i]; }
    else if (a === '--resume' && args[i + 1]) { result.flags.resume = args[++i]; }
    else if (a === '--job-id' && args[i + 1]) { result.flags.jobId = args[++i]; }
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
  if (!prompt) { console.error('Usage: task "<prompt>" [--source <name>] [--model <model>] [--cwd <dir>] [--background] [--raw]'); process.exit(1); }

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

  if (parsed.flags.background) {
    const jobId = await startJob(opts);
    console.log(`[claude-rescue] Job started: ${jobId}`);
    console.log(`[claude-rescue] Tail logs: tail -f ~/.claude/plugins/data/claude-rescue/jobs/${jobId}/stdout.log`);
    console.log(`[claude-rescue] Check status: node scripts/claude-companion.mjs status ${jobId}`);
    return;
  }

  // Foreground: stream through renderer (unless --raw)
  // Note: rendererSessionId is the session ID from the child claude process output,
  // separate from the parent sessionId (CLAUDE_RESCUE_SESSION_ID env var) passed to startJob.
  let rendererSessionId = null;
  const renderer = createRenderer({
    raw: parsed.flags.raw,
    onSessionId: (id) => { rendererSessionId = id; },
  });
  renderer.pipe(process.stdout);

  const code = await spawnClaude({ ...opts, stdout: renderer, stderr: process.stderr });

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
  if (jobId) {
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
  const logPath = join(jobDir(jobId), 'stdout.log');
  if (!existsSync(logPath)) { console.error(`No stdout.log found for job: ${jobId}`); process.exit(1); }
  process.stdout.write(readFileSync(logPath));
}

async function cmdCancel(parsed) {
  const jobId = parsed.positional[0];
  if (!jobId) { console.error('Usage: cancel <job-id>'); process.exit(1); }
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