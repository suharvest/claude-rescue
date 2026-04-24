// lib/claude.mjs — spawn claude CLI with resolved source environment
import { spawn } from 'child_process';
import { resolveSource, resolveEnv } from './sources.mjs';

// Verified flags from `claude --help`:
//   -p / --print           non-interactive mode
//   --output-format        text|json|stream-json (only with --print)
//   --permission-mode      acceptEdits|auto|bypassPermissions|default|dontAsk|plan
//   --model                model name or alias
//   --verbose              override verbose mode

export function spawnClaude(opts) {
  // opts: { prompt, source, model, cwd, stdout, stderr }
  const source = resolveSource(opts.source);
  const env = resolveEnv(source);
  const model = opts.model || source.model;

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--verbose',
  ];
  if (model) args.push('--model', model);
  // prompt is last positional arg
  args.push(opts.prompt);

  const outStream = opts.stdout || process.stdout;
  const errStream = opts.stderr || process.stderr;

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      env,
      cwd: opts.cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: opts.detached || false,
    });

    child.stdout.pipe(outStream, { end: false });
    child.stderr.pipe(errStream, { end: false });

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));

    if (opts.detached) {
      child.unref();
      resolve(child.pid);
    }
  });
}
