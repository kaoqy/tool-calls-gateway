// 极简结构化日志：级别过滤 + 敏感字段脱敏（永不打印 API key）。
import { config } from './config.mjs';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const SECRET_RE = /(api[-_]?key|authorization|bearer|token|secret|password)/i;

function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_RE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function formatFields(fields) {
  const safe = redact(fields);
  const parts = [];
  for (const [k, v] of Object.entries(safe)) {
    let text;
    if (typeof v === 'string') text = v;
    else {
      try {
        text = JSON.stringify(v);
      } catch {
        text = String(v);
      }
    }
    parts.push(`${k}=${text}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

/**
 * @param {{level?:keyof LEVELS, sink?:{write:(s:string)=>void}, now?:()=>Date}} [opts]
 */
export function createLogger(opts = {}) {
  const level = opts.level ?? config.logLevel ?? 'info';
  const sink = opts.sink ?? process.stdout;
  const now = opts.now ?? (() => new Date());
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(lvl, msg, fields) {
    if ((LEVELS[lvl] ?? 0) < threshold) return;
    const line = `${now().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}${formatFields(fields ?? {})}\n`;
    try {
      sink.write(line);
    } catch {
      // 日志失败不允许影响请求
    }
  }

  return {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

export const logger = createLogger();
export { redact };
