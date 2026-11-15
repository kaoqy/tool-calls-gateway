// 配置读取：全部来自环境变量，不硬编码任何密钥。
// 纯函数 loadConfig(env)，便于测试注入。

const DEFAULT_PORT = 8787;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_BODY = 2 * 1024 * 1024; // 2MB
const DEFAULT_LIVE_MODEL = 'deepseek-web-flash';
const DEFAULT_MAX_LIVE_CALLS = 40;

function toInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function trimTrailingSlash(url) {
  return String(url).replace(/\/+$/, '');
}

/**
 * 解析 MODEL_MAP，支持两种写法：
 *   JSON:  {"gpt-5-codex":"deepseek-web-flash","gpt-4o":"deepseek-web-flash"}
 *   简写:  gpt-5-codex:deepseek-web-flash,gpt-4o:deepseek-web-flash
 * @returns {Record<string,string>}
 */
export function parseModelMap(value) {
  const out = {};
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return out;

  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      for (const [from, to] of Object.entries(obj)) {
        if (from && typeof to === 'string' && to.trim()) out[from.trim()] = to.trim();
      }
    } catch {
      // JSON 坏了就当空表，避免把坏配置带进请求
    }
    return out;
  }

  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const from = pair.slice(0, idx).trim();
    const to = pair.slice(idx + 1).trim();
    if (from && to) out[from] = to;
  }
  return out;
}

/**
 * 模型映射优先级：MODEL_OVERRIDE（硬覆盖） > MODEL_MAP 命中 > DEFAULT_MODEL > 原 model。
 * @param {string|undefined} requested
 * @param {{modelOverride?:string, modelMap?:Record<string,string>, defaultModel?:string}} cfg
 */
export function resolveModel(requested, cfg = {}) {
  const key = typeof requested === 'string' ? requested.trim() : '';
  if (cfg.modelOverride) return cfg.modelOverride;
  if (key && cfg.modelMap && cfg.modelMap[key]) return cfg.modelMap[key];
  if (cfg.defaultModel) return cfg.defaultModel;
  return key || 'deepseek-chat';
}

/**
 * @param {Record<string,string|undefined>} env
 */
export function loadConfig(env = process.env) {
  const toolMode = String(env.TOOL_MODE ?? 'auto').trim().toLowerCase();
  const logLevel = String(env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  const reasoning = String(env.REASONING_PASSTHROUGH ?? 'on').trim().toLowerCase();
  return Object.freeze({
    port: toInt(env.PORT, DEFAULT_PORT),
    // 只保留 scheme://host[:port] 部分由调用方拼 /v1/...；允许带 /v1 后缀的写法
    upstreamBaseUrl: trimTrailingSlash(env.UPSTREAM_BASE_URL ?? 'https://api.deepseek.com'),
    upstreamApiKey: env.UPSTREAM_API_KEY ?? '',
    defaultModel: env.DEFAULT_MODEL ?? '',
    toolMode: toolMode === 'off' ? 'off' : 'auto',
    requestTimeoutMs: toInt(env.REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    maxBodyBytes: toInt(env.MAX_BODY_BYTES, DEFAULT_MAX_BODY) || DEFAULT_MAX_BODY,
    logLevel: ['debug', 'info', 'warn', 'error'].includes(logLevel) ? logLevel : 'info',
    // ---- 第二轮新增 ----
    modelMap: parseModelMap(env.MODEL_MAP),
    modelOverride: (env.MODEL_OVERRIDE ?? '').trim(),
    gatewayApiKey: (env.GATEWAY_API_KEY ?? '').trim(),
    reasoningPassthrough: !(reasoning === 'off' || reasoning === 'false' || reasoning === '0'),
    liveModel: (env.LIVE_MODEL ?? '').trim() || DEFAULT_LIVE_MODEL,
    maxLiveCalls: toInt(env.MAX_LIVE_CALLS, DEFAULT_MAX_LIVE_CALLS) || DEFAULT_MAX_LIVE_CALLS,
  });
}

export const config = loadConfig();
