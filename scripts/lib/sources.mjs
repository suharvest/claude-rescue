// lib/sources.mjs — load sources.json and resolve @secret: placeholders
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dir, '..', 'sources.json');
const SOURCES_EXAMPLE_PATH = join(__dir, '..', 'sources.example.json');
const SECRETS_PATH = join(homedir(), '.claude', 'secrets.json');

let _secrets = null;
function loadSecrets() {
  if (_secrets) return _secrets;
  try {
    _secrets = JSON.parse(readFileSync(SECRETS_PATH, 'utf8'));
  } catch {
    _secrets = {};
  }
  return _secrets;
}

function resolveSecretValue(placeholder) {
  // placeholder: "@secret:KEY_NAME"
  const key = placeholder.slice('@secret:'.length);
  const secrets = loadSecrets();
  const entry = secrets[key];
  if (!entry || entry.value === undefined) {
    throw new Error(`Missing secret: "${key}" not found in ~/.claude/secrets.json. Add it with: {"${key}": {"value": "...", "description": "..."}}`);
  }
  return entry.value;
}

export function loadSources() {
  try {
    return JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`sources.json not found at ${SOURCES_PATH}. Copy sources.example.json to sources.json and edit it:\n  cp ${SOURCES_EXAMPLE_PATH} ${SOURCES_PATH}`);
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
  // Strip all ANTHROPIC_* vars from parent env first
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('ANTHROPIC_')) delete env[k];
  }

  // Overlay source env, resolving @secret: placeholders
  for (const [k, v] of Object.entries(source.env || {})) {
    if (typeof v === 'string' && v.startsWith('@secret:')) {
      env[k] = resolveSecretValue(v); // throws with clear message if missing
    } else {
      env[k] = v;
    }
  }
  return env;
}
