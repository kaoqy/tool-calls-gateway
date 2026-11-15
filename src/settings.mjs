// 应用内设置：把「上游地址 / 密钥 / 模型映射」等从"只能改 env"变成"网页里改、热生效"。
//
// 优先级：设置文件（UI 保存） > 环境变量 > 内置默认值。
// 文件里只存"覆盖项"，密钥以 0600 落盘（Windows 上 chmod 不生效，靠目录权限/磁盘加密）。
// 任何公开视图都不返回密钥明文，只给 hint（sk-***abcd）。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, parseModelMap } from './config.mjs';

/** 允许在 UI 里修改的字段（其余字段只能走环境变量） */
export const EDITABLE_FIELDS = Object.freeze({
  upstreamBaseUrl: { env: 'UPSTREAM_BASE_URL', label: '上游 Base URL', type: 'url' },
  upstreamApiKey: { env: 'UPSTREAM_API_KEY', label: '上游 API Key', type: 'secret' },
  defaultModel: { env: 'DEFAULT_MODEL', label: '默认模型', type: 'string' },
  modelMap: { env: 'MODEL_MAP', label: '模型映射', type: 'modelMap' },
  modelOverride: { env: 'MODEL_OVERRIDE', label: '强制覆盖模型', type: 'string' },
  gatewayApiKey: { env: 'GATEWAY_API_KEY', label: '下游网关 Key', type: 'secret' },
  toolMode: { env: 'TOOL_MODE', label: '工具模拟模式', type: 'enum', values: ['auto', 'off'] },
  reasoningPassthrough: { env: 'REASONING_PASSTHROUGH', label: '透传 reasoning', type: 'boolean' },
  requestTimeoutMs: { env: 'REQUEST_TIMEOUT_MS', label: '上游超时(ms)', type: 'int', min: 1000, max: 600000 },
  maxBodyBytes: { env: 'MAX_BODY_BYTES', label: '请求体上限(B)', type: 'int', min: 1024, max: 67108864 },
});

const SECRET_FIELDS = new Set(['upstreamApiKey', 'gatewayApiKey']);

/** 密钥脱敏：sk-***abcd */
export function maskSecret(value) {
  const s = value == null ? '' : String(value);
  if (!s) return '';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 3)}***${s.slice(-4)}`;
}

export class SettingsValidationError extends Error {
  constructor(errors) {
    super(`设置校验失败：${errors.map((e) => `${e.field} ${e.message}`).join('；')}`);
    this.name = 'SettingsValidationError';
    this.code = 'SETTINGS_INVALID';
    this.errors = errors;
  }
}

function normalizeOne(field, raw) {
  const spec = EDITABLE_FIELDS[field];
  switch (spec.type) {
    case 'url': {
      const v = String(raw ?? '').trim();
      if (!v) return null; // 清空 = 取消覆盖，回落 env
      if (!/^https?:\/\/[^\s]+$/i.test(v)) throw new SettingsValidationError([{ field, message: '必须是 http(s) URL' }]);
      return v.replace(/\/+$/, '');
    }
    case 'secret': {
      const v = String(raw ?? '').trim();
      return v === '' ? null : v;
    }
    case 'string': {
      const v = String(raw ?? '').trim();
      return v === '' ? null : v;
    }
    case 'modelMap': {
      if (raw === null || raw === undefined || raw === '') return null;
      const value = typeof raw === 'string' ? parseModelMap(raw) : parseModelMap(JSON.stringify(raw));
      if (typeof raw === 'object' && raw !== null && Object.keys(raw).length === 0) return null;
      if (!Object.keys(value).length) {
        throw new SettingsValidationError([{ field, message: '解析后为空，格式应为 {"客户端模型":"上游模型"}' }]);
      }
      return value;
    }
    case 'enum': {
      const v = String(raw ?? '').trim();
      if (!v) return null;
      if (!spec.values.includes(v)) {
        throw new SettingsValidationError([{ field, message: `只能是 ${spec.values.join(' / ')}` }]);
      }
      return v;
    }
    case 'boolean': {
      if (raw === null || raw === undefined || raw === '') return null;
      const v = typeof raw === 'boolean' ? raw : ['on', 'true', '1', 'yes'].includes(String(raw).trim().toLowerCase());
      return v;
    }
    case 'int': {
      if (raw === null || raw === undefined || raw === '') return null;
      const n = Number.parseInt(String(raw).trim(), 10);
      if (!Number.isFinite(n)) throw new SettingsValidationError([{ field, message: '必须是整数' }]);
      if (n < spec.min || n > spec.max) {
        throw new SettingsValidationError([{ field, message: `必须在 ${spec.min}~${spec.max} 之间` }]);
      }
      return n;
    }
    default:
      throw new SettingsValidationError([{ field, message: '未知字段类型' }]);
  }
}

/** 校验并归一化一批补丁；未知字段直接报错（避免静默丢配置） */
export function normalizePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new SettingsValidationError([{ field: 'settings', message: '必须是 JSON 对象' }]);
  }
  const errors = [];
  const clean = {};
  for (const [field, raw] of Object.entries(patch)) {
    if (!EDITABLE_FIELDS[field]) {
      errors.push({ field, message: '不是可修改的配置项' });
      continue;
    }
    try {
      clean[field] = normalizeOne(field, raw);
    } catch (err) {
      if (err instanceof SettingsValidationError) errors.push(...err.errors);
      else errors.push({ field, message: err.message });
    }
  }
  if (errors.length) throw new SettingsValidationError(errors);
  return clean;
}

function envProvidedKeys(env) {
  const set = new Set();
  for (const [field, spec] of Object.entries(EDITABLE_FIELDS)) {
    const value = env[spec.env];
    if (value !== undefined && value !== null && String(value).trim() !== '') set.add(field);
  }
  return set;
}

/**
 * 设置存储：内存缓存 + JSON 文件持久化 + 原子写。
 * @param {{env?:Record<string,string|undefined>, filePath:string, logger?:object, version?:string}} opts
 */
export function createSettingsStore({ env = process.env, filePath, logger = console, version = '' } = {}) {
  if (!filePath) throw new Error('createSettingsStore 需要 filePath');
  const baseline = loadConfig(env);
  const envSet = envProvidedKeys(env);
  let overrides = {};
  let updatedAt = null;
  let cached = null;

  function readFromDisk() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const doc = JSON.parse(raw);
      const settings = doc && typeof doc === 'object' ? doc.settings : null;
      if (!settings || typeof settings !== 'object') return { settings: {}, updatedAt: null };
      const safe = {};
      for (const [field, value] of Object.entries(settings)) {
        if (!EDITABLE_FIELDS[field]) continue;
        try {
          const normalized = normalizeOne(field, value);
          if (normalized !== null) safe[field] = normalized;
        } catch {
          logger.warn?.('忽略非法的已保存配置项', { field });
        }
      }
      return { settings: safe, updatedAt: doc.updatedAt ?? null };
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn?.('设置文件读取失败，已忽略（可用 UI 重置）', { message: err.message, filePath });
      return { settings: {}, updatedAt: null };
    }
  }

  function buildConfig() {
    const cfg = { ...baseline };
    for (const [field, value] of Object.entries(overrides)) {
      if (value !== null && value !== undefined) cfg[field] = value;
    }
    return Object.freeze(cfg);
  }

  function saveToDisk() {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const doc = { version: 1, updatedAt: new Date().toISOString(), settings: overrides };
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* Windows 上可能不支持，忽略 */
    }
    updatedAt = doc.updatedAt;
  }

  const loaded = readFromDisk();
  overrides = loaded.settings;
  updatedAt = loaded.updatedAt;

  return {
    filePath,
    get() {
      if (!cached) cached = buildConfig();
      return cached;
    },
    getBaseline() {
      return { ...baseline };
    },
    /** UI 用的公开视图：不含密钥明文 */
    publicView() {
      const cfg = this.get();
      const settings = {};
      const sources = {};
      for (const [field, spec] of Object.entries(EDITABLE_FIELDS)) {
        const fromFile = overrides[field] !== undefined && overrides[field] !== null;
        sources[field] = fromFile ? 'file' : envSet.has(field) ? 'env' : 'default';
        if (SECRET_FIELDS.has(field)) {
          const value = cfg[field] ?? '';
          settings[field] = { set: Boolean(value), hint: maskSecret(value) };
        } else if (spec.type === 'modelMap') {
          settings[field] = cfg.modelMap ?? {};
        } else {
          settings[field] = cfg[field] ?? (spec.type === 'boolean' ? true : '');
        }
      }
      let exists = false;
      try {
        exists = fs.existsSync(filePath);
      } catch {
        exists = false;
      }
      return {
        settings,
        sources,
        fields: Object.fromEntries(
          Object.entries(EDITABLE_FIELDS).map(([k, v]) => [
            k,
            { label: v.label, type: v.type, values: v.values ?? null, env: v.env },
          ]),
        ),
        meta: {
          file: filePath,
          exists,
          updatedAt,
          version,
          envProvided: [...envSet],
          activeOverrides: Object.keys(overrides).filter((k) => overrides[k] !== null && overrides[k] !== undefined),
        },
      };
    },
    /** @param {object} patch 只允许 EDITABLE_FIELDS 里的键；空值/null 表示取消覆盖 */
    update(patch) {
      const clean = normalizePatch(patch);
      const next = { ...overrides };
      for (const [field, value] of Object.entries(clean)) {
        if (value === null) delete next[field];
        else next[field] = value;
      }
      overrides = next;
      saveToDisk();
      cached = null;
      logger.info?.('settings updated', { fields: Object.keys(clean), overrides: Object.keys(overrides) });
      return this.publicView();
    },
    reset() {
      overrides = {};
      updatedAt = null;
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* ignore */
      }
      cached = null;
      logger.info?.('settings reset to env defaults', { filePath });
      return this.publicView();
    },
  };
}
