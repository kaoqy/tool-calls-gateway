// live 脚本共用：读取 .env、脱敏、调用额度（MAX_LIVE_CALLS）、起"真上游"网关、写报告。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, getFreePort, startProcess, stopProcess, waitForHealth, sleep } from './harness.mjs';

export const OUT_DIR = path.join(ROOT, 'out');

/** 极简 .env 解析（不引第三方依赖）；已存在的环境变量优先 */
export function loadDotEnv(env = process.env) {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return env;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined || env[key] === '') env[key] = value;
  }
  return env;
}

/** 报告/日志脱敏：抹掉任何形如 sk-xxx 的串以及当前真实 key */
export function maskSecret(text) {
  if (text === undefined || text === null) return '';
  let out = typeof text === 'string' ? text : JSON.stringify(text);
  if (out === undefined) return '';
  const key = process.env.UPSTREAM_API_KEY;
  if (key && key.length > 8) out = out.split(key).join('sk-***');
  return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}

/**
 * 调用额度：限制本次运行最多打多少次真实上游。
 * @param {{limit:number, label:string}} opts
 */
export function createBudget({ limit, label }) {
  const state = { label, limit, used: 0, log: [] };
  return {
    get used() {
      return state.used;
    },
    get limit() {
      return state.limit;
    },
    get remaining() {
      return Math.max(0, state.limit - state.used);
    },
    spend(what = '') {
      if (state.used + 1 > state.limit) {
        throw new Error(`超出 MAX_LIVE_CALLS=${state.limit}（本次 ${state.label} 已用 ${state.used} 次），拒绝继续调用真实上游`);
      }
      state.used += 1;
      state.log.push({ n: state.used, what, at: new Date().toISOString() });
      return state.used;
    },
    summary() {
      return { label: state.label, used: state.used, limit: state.limit, calls: state.log };
    },
  };
}

/** 起一个指向真实上游的网关（不缓存、不落盘密钥；日志里密钥会被脱敏） */
export async function startLiveGateway({ extraEnv = {}, logLevel } = {}) {
  loadDotEnv();
  const baseUrlUpstream = process.env.UPSTREAM_BASE_URL ?? '';
  const apiKey = process.env.UPSTREAM_API_KEY ?? '';
  if (!baseUrlUpstream || !apiKey) {
    const err = new Error('缺少 UPSTREAM_BASE_URL / UPSTREAM_API_KEY（请写进 toolcall-gateway/.env 或用环境变量注入）');
    err.code = 'NO_CREDENTIALS';
    throw err;
  }
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = startProcess('gateway-live', 'src/server.mjs', {
    env: {
      PORT: String(port),
      UPSTREAM_BASE_URL: baseUrlUpstream,
      UPSTREAM_API_KEY: apiKey,
      DEFAULT_MODEL: process.env.DEFAULT_MODEL ?? '',
      MODEL_MAP: process.env.MODEL_MAP ?? '',
      MODEL_OVERRIDE: process.env.MODEL_OVERRIDE ?? '',
      GATEWAY_API_KEY: process.env.GATEWAY_API_KEY ?? '',
      REASONING_PASSTHROUGH: process.env.REASONING_PASSTHROUGH ?? 'on',
      LOG_LEVEL: logLevel ?? process.env.LOG_LEVEL ?? 'info',
      REQUEST_TIMEOUT_MS: process.env.REQUEST_TIMEOUT_MS ?? '120000',
      MAX_BODY_BYTES: process.env.MAX_BODY_BYTES ?? '2097152',
      ...extraEnv,
    },
  });
  await waitForHealth(`${baseUrl}/healthz`, { timeoutMs: 20000 });
  return {
    baseUrl,
    child,
    async close() {
      stopProcess(child);
      await sleep(30);
    },
  };
}

/** 起一个"上游不可达"的网关，用来在不烧额度的前提下验证 504 */
export async function startUnreachableGateway({ timeoutMs = 600 } = {}) {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = startProcess('gateway-timeout', 'src/server.mjs', {
    env: {
      PORT: String(port),
      UPSTREAM_BASE_URL: 'http://127.0.0.1:9', // discard 端口，必然连不上
      UPSTREAM_API_KEY: 'sk-timeout-probe',
      REQUEST_TIMEOUT_MS: String(timeoutMs),
      LOG_LEVEL: 'error',
    },
  });
  await waitForHealth(`${baseUrl}/healthz`, { timeoutMs: 20000 });
  return {
    baseUrl,
    child,
    async close() {
      stopProcess(child);
      await sleep(30);
    },
  };
}

export function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

/** 写 JSON + Markdown 报告，返回路径 */
export function writeReports(name, report, markdown) {
  ensureOutDir();
  const jsonPath = path.join(OUT_DIR, `${name}.json`);
  const mdPath = path.join(OUT_DIR, `${name}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, markdown, 'utf8');
  return { jsonPath, mdPath };
}

export function parseFlags(argv = process.argv.slice(2)) {
  const flags = { live: false, dryRun: false, out: null, runs: null, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--live') flags.live = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--out') flags.out = argv[++i];
    else if (a === '--runs') flags.runs = Number.parseInt(argv[++i], 10);
    else if (a === '--only') flags.only = String(argv[++i] ?? '').split(',').map((s) => s.trim().toUpperCase());
  }
  if (!flags.live) flags.dryRun = true; // 默认 dry-run
  return flags;
}

export function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
