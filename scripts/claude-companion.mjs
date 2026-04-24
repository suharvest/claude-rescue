#!/usr/bin/env node
// claude-companion.mjs — CLI entry point for claude-rescue plugin
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnClaude } from './lib/claude.mjs';
import { startJob, getJob, listJobs } from './lib/job-control.mjs';
import { loadSources } from './lib/sources.mjs';
import { jobDir } from './lib/state.mjs';

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const result = { cmd, flags: {}, positional: [] };

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--background') { result.flags.background = true; }
    else if (a === '--wait') { result.flags.wait = true; }
    else if (a === '--source' && args[i + 1]) { result.flags.source = args[++i]; }
    else if (a === '--model' && args[i + 1]) { result.flags.model = args[++i]; }
    else if (a === '--cwd' && args[i + 1]) { result.flags.cwd = args[++i]; }
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
  if (!prompt) { console.error('Usage: task "<prompt>" [--source <name>] [--model <model>] [--cwd <dir>] [--background]'); process.exit(1); }

  const opts = {
    prompt,
    source: parsed.flags.source,
    model: parsed.flags.model,
    cwd: parsed.flags.cwd,
  };

  if (parsed.flags.background) {
    const jobId = await startJob(opts);
    console.log(`[claude-rescue] Job started: ${jobId}`);
    console.log(`[claude-rescue] Tail logs: tail -f ~/.claude/plugins/data/claude-rescue/jobs/${jobId}/stdout.log`);
    console.log(`[claude-rescue] Check status: node claude-companion.mjs status ${jobId}`);
    return;
  }

  // Foreground: stream directly to stdout
  const code = await spawnClaude({ ...opts, stdout: process.stdout, stderr: process.stderr });
  process.exit(code);
}

async function cmdStatus(parsed) {
  const jobId = parsed.positional[0];
  if (jobId) {
    const meta = getJob(jobId);
    console.log(JSON.stringify(meta, null, 2));
  } else {
    const jobs = listJobs(10);
    if (!jobs.length) { console.log('No jobs found.'); return; }
    const rows = jobs.map(j => [j.jobId || j.id, j.status, j.source, j.started_at, j.prompt_preview]);
    printTable(rows, ['job-id', 'status', 'source', 'started_at', 'prompt_preview']);
  }
}

async function cmdResult(parsed) {
  const jobId = parsed.positional[0];
  if (!jobId) { console.error('Usage: result <job-id>'); process.exit(1); }
  const logPath = join(jobDir(jobId), 'stdout.log');
  if (!existsSync(logPath)) { console.error(`No stdout.log found for job: ${jobId}`); process.exit(1); }
  process.stdout.write(readFileSync(logPath));
}

async function main() {
  const parsed = parseArgs(process.argv);
  try {
    switch (parsed.cmd) {
      case 'task':         await cmdTask(parsed); break;
      case 'status':       await cmdStatus(parsed); break;
      case 'result':       await cmdResult(parsed); break;
      case 'list-sources': await cmdListSources(); break;
      default:
        console.error(`Unknown command: ${parsed.cmd}`);
        console.error('Commands: task, status, result, list-sources');
        process.exit(1);
    }
  } catch (err) {
    console.error(`[claude-rescue] Error: ${err.message}`);
    process.exit(1);
  }
}

main();
