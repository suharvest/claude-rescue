// lib/render.mjs — pretty-print stream-json output from claude CLI
import { Transform } from 'stream';

const GREY = '\x1b[90m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

// Strip dangerous terminal control sequences while preserving useful CSI colors.
// Removes: C0 controls (except \n\t\r and ESC), OSC sequences (x1b]...x07 or x1b]...x1b\x)
// Keeps: CSI color sequences (x1b[...m) intact.
function sanitizeForTerminal(s) {
  if (!s) return s;
  // Strip OSC sequences: ESC ] ... (BEL or ESC \)
  let result = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  // Strip C0 controls except newline (0x0a), tab (0x09), CR (0x0d), ESC (0x1b)
  // Range: 0x00-0x08, 0x0b-0x0c, 0x0e-0x1a, 0x1c-0x1f, 0x7f
  result = result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, '');
  return result;
}

function previewInput(input) {
  if (!input) return '';
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  if (str.length <= 40) return str;
  return str.slice(0, 40) + '...';
}

function renderLine(line, opts) {
  const useColor = opts.color && process.stdout.isTTY;
  let out = '';

  try {
    const event = JSON.parse(line);
    const type = event.type;

    if (type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text') {
          out += sanitizeForTerminal(block.text || '');
        } else if (block.type === 'tool_use') {
          const name = block.name || 'unknown';
          const preview = sanitizeForTerminal(previewInput(block.input));
          if (useColor) {
            out += `${GREY}→ ${name}(${preview})${RESET}\n`;
          } else {
            out += `→ ${name}(${preview})\n`;
          }
        }
      }
    } else if (type === 'result' && event.is_error) {
      const msg = event.result || 'Unknown error';
      if (useColor) {
        out += `${RED}[error] ${msg}${RESET}\n`;
      } else {
        out += `[error] ${msg}\n`;
      }
    } else if (type === 'system' && event.subtype === 'api_retry') {
      const n = event.retry_number || 1;
      const max = event.max_retries || 5;
      const err = event.error?.message || 'Unknown retry error';
      if (useColor) {
        out += `${YELLOW}[retry ${n}/${max}] ${err}${RESET}\n`;
      } else {
        out += `[retry ${n}/${max}] ${err}\n`;
      }
    }
    // All other event types: silently skip
  } catch {
    // Not valid JSON, skip
  }

  return out;
}

// Export sanitizeForTerminal for testing / direct use
export { sanitizeForTerminal };

export function createRenderer(opts = {}) {
  const options = {
    raw: opts.raw ?? false,
    color: opts.color ?? true,
    onSessionId: opts.onSessionId ?? null,
    sanitize: opts.sanitize ?? true, // Default: sanitize output
  };

  if (options.raw) {
    // Passthrough mode
    const pass = new Transform({ transform(chunk, enc, cb) { cb(null, chunk); } });
    return pass;
  }

  let buffer = '';
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      let out = '';
      for (const line of lines) {
        if (!line.trim()) continue;
        // Capture session_id from first event
        if (options.onSessionId) {
          try {
            const event = JSON.parse(line);
            if (event.session_id) {
              options.onSessionId(event.session_id);
            }
          } catch {}
        }
        out += renderLine(line, options);
      }
      callback(null, out);
    },
    flush(callback) {
      if (buffer.trim()) {
        if (options.onSessionId) {
          try {
            const event = JSON.parse(buffer);
            if (event.session_id) {
              options.onSessionId(event.session_id);
            }
          } catch {}
        }
        callback(null, renderLine(buffer, options));
      } else {
        callback(null);
      }
    },
  });

  return transform;
}