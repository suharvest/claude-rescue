// lib/sources.mjs — load sources.json and resolve ${ENV_VAR} placeholders from process.env
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dir, '..', 'sources.json');
const SOURCES_EXAMPLE_PATH = join(__dir, '..', 'sources.example.json');

const MAX_DEPTH = parseInt(process.env.CLAUDE_RESCUE_MAX_DEPTH || '3', 10);

export function currentDepth() {
  return parseInt(process.env.CLAUDE_RESCUE_DEPTH || '0', 10);
}

export function assertDepthOk() {
  const d = currentDepth();
  if (d >= MAX_DEPTH) {
    throw new Error(
      `claude-rescue nesting depth ${d} has reached the limit of ${MAX_DEPTH}. ` +
      `Refusing to spawn another level to avoid runaway cost. ` +
      `Override with CLAUDE_RESCUE_MAX_DEPTH=<n> if you know what you're doing.`,
    );
  }
}

// Resolve ${VAR} placeholders against process.env.
// Supports "${VAR}" (whole value) or embedded "prefix-${VAR}-suffix".
function resolvePlaceholders(value, seenVars) {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, name) => {
    seenVars.add(name);
    const v = process.env[name];
    if (v === undefined || v === '') {
      throw new Error(
        `Env var "${name}" is not set. claude-rescue does not read secret stores directly — ` +
        `export it in your shell, or inject via direnv / 1Password CLI / pass / your own wrapper before invoking.`,
      );
    }
    return v;
  });
}

export function loadSources() {
  try {
    return JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(
        `sources.json not found at ${SOURCES_PATH}. Copy the template and edit it:\n  cp ${SOURCES_EXAMPLE_PATH} ${SOURCES_PATH}`,
      );
    }
    throw e;
  }
}

export function resolveSource(name) {
  const config = loadSources();
  const sourceName = name || config.default;
  const source = config.sources[sourceName];
  if (!source) {
    const available = Object.keys(config.sources).join(', ');
    throw new Error(`Unknown source: "${sourceName}". Available sources: ${available}`);
  }
  return { name: sourceName, ...source };
}

export function resolveEnv(source) {
  // Strip all ANTHROPIC_* from parent env so the subprocess doesn't inherit
  // the main thread's subscription token.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('ANTHROPIC_')) delete env[k];
  }

  const seenVars = new Set();
  for (const [k, v] of Object.entries(source.env || {})) {
    env[k] = typeof v === 'string' ? resolvePlaceholders(v, seenVars) : v;
  }

  // Propagate nesting depth to the child so it can enforce the same cap.
  env.CLAUDE_RESCUE_DEPTH = String(currentDepth() + 1);
  return env;
}
