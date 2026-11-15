// HTTP 服务 + 路由。
//   GET  /healthz              健康检查
//   GET  /v1/models            透传上游
//   POST /v1/chat/completions  含 tools/functions → 模拟工具调用；否则原样透传
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config as defaultConfig, resolveModel } from './config.mjs';
import { logger as defaultLogger } from './logger.mjs';
import { createSettingsStore, normalizePatch } from './settings.mjs';
import { renderAdminHtml, renderLoginHtml, renderSetupHtml } from './admin-ui.mjs';
import {
  AuthError,
  SESSION_COOKIE,
  clearCookie,
  createAuthStore,
  createLoginLimiter,
  createSessionStore,
  DEFAULT_SESSION_TTL_MS,
  isSecureRequest,
  readCookie,
  sessionCookie,
} from './auth.mjs';
import {
  callUpstreamGet,
  callUpstreamJson,
  openUpstreamStream,
  upstreamHeaders,
  upstreamUrl,
} from './upstream.mjs';
import { buildUpstreamRequest, hasTools } from './prompt.mjs';
import {
  buildChatCompletion,
  buildSseChunks,
  extractNativeToolCalls,
  parseModelOutput,
} from './protocol.mjs';
import { collectStreamText, encodeSse, SSE_DONE_LINE } from './sse.mjs';
import {
  countMediaInBody,
  hasMedia,
  listMedia,
  mediaSizeStats,
  normalizeContent,
} from './content.mjs';

/** 发送 JSON 响应 */
export function sendJson(res, status, obj, headers = {}) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    ...headers,
  });
  res.end(body);
}

/** OpenAI 风格错误体 */
export function sendError(res, status, type, message, extra = {}) {
  sendJson(res, status, { error: { type, message, ...extra } });
}

/** 读取请求体：边读边累加字节，超限立刻中断（不做切片，避免破坏 base64 / JSON） */
export async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error(`请求体超过 ${maxBytes} 字节上限`);
      err.code = 'BODY_TOO_LARGE';
      err.size = size;
      err.limit = maxBytes;
      throw err; // 停止继续累积，交给调用方回 413 并断开
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 人类可读的字节数（错误信息用，不涉及内容） */
export function formatBytes(n) {
  const num = Number(n) || 0;
  if (num < 1024) return `${num}B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)}KB`;
  return `${(num / (1024 * 1024)).toFixed(2)}MB`;
}

/** 把上游流原样转发给客户端（零缓冲） */
async function pipeUpstreamStream(res, opened, logger) {
  const { response, finish } = opened;
  try {
    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (!response.body) {
      res.end();
      return;
    }
    await new Promise((resolve, reject) => {
      const src = Readable.fromWeb(response.body);
      src.on('error', reject);
      res.on('error', reject);
      res.on('close', () => {
        src.destroy();
        resolve();
      });
      src.pipe(res);
      src.on('end', resolve);
    });
  } catch (err) {
    logger.warn('stream passthrough interrupted', { message: err?.message ?? String(err) });
    if (!res.headersSent) sendError(res, 502, 'upstream_error', '上游流式响应失败');
    else res.destroy();
  } finally {
    finish();
  }
}

export function createServer({ settings, config = defaultConfig, logger = defaultLogger, auth, sessions, limiter } = {}) {
  // 有 settings 时每个请求都取最新配置（UI 保存后立即热生效，无需重启）
  const getConfig = typeof settings?.get === 'function' ? () => settings.get() : () => config;
  const active = getConfig();
  const authStore =
    auth ??
    createAuthStore({
      filePath: path.resolve(active.authFile || path.join(active.dataDir, 'auth.json')),
      logger,
    });
  const sessionStore = sessions ?? createSessionStore({ ttlMs: DEFAULT_SESSION_TTL_MS });
  const loginLimiter = limiter ?? createLoginLimiter({});
  const ctx = { getConfig, settings, logger, auth: authStore, sessions: sessionStore, limiter: loginLimiter };
  const server = http.createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => {
      logger.error('unhandled request error', { message: err?.message ?? String(err) });
      sendError(res, 500, 'internal_error', '网关内部错误');
    });
  });
  server.adminState = () => authStore.summary();
  server.sessions = sessionStore;
  return server;
}

/** 下游鉴权：仅当设置了 GATEWAY_API_KEY 时校验；上游鉴权始终用 UPSTREAM_API_KEY 覆盖。 */
function rejectUnauthorized(req, res, config) {
  if (!config.gatewayApiKey) return false;
  const header = String(req.headers.authorization ?? '');
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (token && token === config.gatewayApiKey) return false;
  sendError(res, 401, 'invalid_api_key', '无效的网关 API key（请使用 Authorization: Bearer <GATEWAY_API_KEY>）');
  return true;
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
};

/**
 * 设置页鉴权（两种凭据，任一即可）：
 *   1. ADMIN_TOKEN —— Bearer，用于自动化 / 忘记密码时的兜底；不设则关闭
 *   2. 登录会话 —— 首次访问创建的管理员账号，HttpOnly Cookie
 */
function adminAuth(req, { config, auth, sessions }) {
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (config.adminToken && bearer && bearer === config.adminToken) {
    return { ok: true, via: 'token', username: auth.summary().username || 'admin' };
  }
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  const sess = sessions.verify(token);
  if (sess) return { ok: true, via: 'session', username: sess.username, token };
  return { ok: false, via: '', username: '', token: '' };
}

function rejectAdmin(req, res, ctx) {
  const state = adminAuth(req, ctx);
  if (state.ok) return state;
  sendError(res, 401, 'admin_unauthorized', '请先登录管理设置（打开 /admin）');
  return null;
}

/** 首次运行：还没创建管理员账号 */
function setupRequired(ctx) {
  return !ctx.auth.configured();
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '';
}

async function handleAdminSetup(req, res, ctx) {
  const { auth, settings, sessions, limiter, logger, config } = ctx;
  if (auth.configured()) {
    return sendError(res, 409, 'auth_already_setup', '管理员账号已创建，请直接登录 /admin');
  }
  const parsed = await readJsonBody(req, 16 * 1024);
  if (parsed.error) return sendError(res, parsed.error.status, parsed.error.type, parsed.error.message);
  const body = parsed.json ?? {};

  const ip = clientIp(req);
  const gate = limiter.check(`setup:${ip}`);
  if (gate.blocked) {
    res.setHeader('retry-after', String(Math.ceil(gate.retryAfterMs / 1000)));
    return sendError(res, 429, 'too_many_attempts', '尝试过于频繁，请稍后再试');
  }

  let patch;
  try {
    patch = normalizePatch({
      upstreamBaseUrl: body.upstreamBaseUrl,
      upstreamApiKey: body.upstreamApiKey ?? '',
      defaultModel: body.defaultModel ?? '',
    });
  } catch (err) {
    return sendSettingsError(res, err);
  }
  if (!patch.upstreamBaseUrl) {
    return sendError(res, 400, 'settings_invalid', '请填写上游 Base URL', {
      errors: [{ field: 'upstreamBaseUrl', message: '必填，例如 https://api.deepseek.com' }],
    });
  }

  try {
    auth.create({ username: body.username, password: body.password });
  } catch (err) {
    limiter.fail(`setup:${ip}`);
    if (err instanceof AuthError) return sendError(res, err.status, err.type, err.message, { field: err.field });
    throw err;
  }

  try {
    settings.update(patch);
  } catch (err) {
    return sendSettingsError(res, err);
  }

  const token = sessions.issue(auth.summary().username, { ip });
  res.setHeader('set-cookie', sessionCookie(token, { ttlMs: sessions.ttlMs, secure: isSecureRequest(req) }));
  logger.info('admin setup completed', { username: auth.summary().username, upstream: patch.upstreamBaseUrl });
  return sendJson(res, 201, { ok: true, ...adminView(settings, ctx) });
}

async function handleAdminLogin(req, res, ctx) {
  const { auth, sessions, limiter, settings, logger } = ctx;
  if (setupRequired(ctx)) {
    return sendError(res, 409, 'auth_not_setup', '尚未初始化，请打开 /admin 完成首次配置');
  }
  const parsed = await readJsonBody(req, 8 * 1024);
  if (parsed.error) return sendError(res, parsed.error.status, parsed.error.type, parsed.error.message);
  const ip = clientIp(req);
  const key = `login:${ip}`;
  const gate = limiter.check(key);
  if (gate.blocked) {
    res.setHeader('retry-after', String(Math.ceil(gate.retryAfterMs / 1000)));
    return sendError(res, 429, 'too_many_attempts', `尝试过于频繁，请 ${Math.ceil(gate.retryAfterMs / 60000)} 分钟后再试`);
  }

  const body = parsed.json ?? {};
  // 兼容旧行为：ADMIN_TOKEN 直接贴进密码框也能进（方便自动化）
  const adminToken = auth.summary().username;
  const tokenInput = String(body.token ?? '').trim();
  if (ctx.config.adminToken && tokenInput && tokenInput === ctx.config.adminToken) {
    limiter.reset(key);
    const token = sessions.issue(adminToken, { ip });
    res.setHeader('set-cookie', sessionCookie(token, { ttlMs: sessions.ttlMs, secure: isSecureRequest(req) }));
    return sendJson(res, 200, { ok: true, via: 'token', ...adminView(settings, ctx) });
  }

  const ok = auth.verify({ username: body.username, password: body.password });
  if (!ok) {
    const st = limiter.fail(key);
    return sendError(res, 401, 'auth_bad_credentials', '用户名或密码不正确', {
      remainingAttempts: Math.max(0, 5 - st.count),
    });
  }
  limiter.reset(key);
  const token = sessions.issue(auth.summary().username, { ip });
  res.setHeader('set-cookie', sessionCookie(token, { ttlMs: sessions.ttlMs, secure: isSecureRequest(req) }));
  logger.info('admin login', { username: auth.summary().username, ip });
  return sendJson(res, 200, { ok: true, via: 'session', ...adminView(settings, ctx) });
}

async function handleRequest(req, res, ctx) {
  const { getConfig, settings, logger } = ctx;
  const config = getConfig();
  const rctx = { ...ctx, config }; // 每请求带上最新配置（UI 热更新后立即生效）
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  logger.debug('request', { method: req.method, path: url.pathname });

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return sendJson(res, 200, {
      status: 'ok',
      setupRequired: setupRequired(rctx),
      upstreamConfigured: Boolean(String(config.upstreamBaseUrl ?? '').trim()),
      // 图片处理模式：pass（默认，原样转发）/ placeholder（占位文本）/ reject（400）
      imageMode: config.imageMode ?? 'pass',
      maxBodyBytes: config.maxBodyBytes,
    });
  }

  // ---- 首次初始化（账号不存在时开放；创建后永久 409）----
  if (req.method === 'POST' && url.pathname === '/admin/api/setup') {
    return handleAdminSetup(req, res, rctx);
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/setup/test' && setupRequired(rctx)) {
    return handleAdminTest(req, res, rctx);
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/login') {
    return handleAdminLogin(req, res, rctx);
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/session') {
    const state = adminAuth(req, rctx);
    return sendJson(res, 200, {
      setupRequired: setupRequired(rctx),
      authenticated: state.ok,
      via: state.via,
      username: state.username,
      adminMode: config.adminToken ? 'token-or-account' : 'account',
      upstreamConfigured: Boolean(String(config.upstreamBaseUrl ?? '').trim()),
    });
  }

  if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
    if (setupRequired(rctx)) {
      res.writeHead(200, HTML_HEADERS);
      res.end(renderSetupHtml({ version: packageVersion() }));
      return;
    }
    const state = adminAuth(req, rctx);
    if (!state.ok) {
      res.writeHead(200, HTML_HEADERS);
      res.end(renderLoginHtml({ version: packageVersion(), username: ctx.auth.summary().username }));
      return;
    }
    res.writeHead(200, HTML_HEADERS);
    res.end(renderAdminHtml({ version: packageVersion(), username: state.username }));
    return;
  }

  if (url.pathname.startsWith('/admin/api/')) {
    if (!rejectAdmin(req, res, rctx)) return;
    return handleAdminApi(req, res, url, rctx);
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    if (rejectUnauthorized(req, res, config)) return;
    if (rejectUnconfigured(res, config)) return;
    return handleModels(res, config, logger);
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    if (rejectUnauthorized(req, res, config)) return;
    if (rejectUnconfigured(res, config)) return;
    return handleChatCompletions(req, res, config, logger);
  }

  return sendError(res, 404, 'not_found', `未知路由: ${req.method} ${url.pathname}`);
}

/** 没配上游时给出可操作的 503，而不是打到一个猜的默认地址 */
function rejectUnconfigured(res, config) {
  if (String(config.upstreamBaseUrl ?? '').trim()) return false;
  sendError(
    res,
    503,
    'upstream_not_configured',
    '网关尚未配置上游。打开 /admin 首次配置（网页里创建管理员并填写上游地址与模型），保存后立即生效。',
  );
  return true;
}

// ---------------------------------------------------------------- 设置页 API
let cachedVersion = null;
function packageVersion() {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    cachedVersion = JSON.parse(fs.readFileSync(file, 'utf8')).version ?? '';
  } catch {
    cachedVersion = '';
  }
  return cachedVersion;
}

async function readJsonBody(req, maxBytes) {
  let raw;
  try {
    raw = await readBody(req, maxBytes);
  } catch (err) {
    if (err.code === 'BODY_TOO_LARGE') return { error: { status: 413, type: 'payload_too_large', message: '请求体过大' } };
    throw err;
  }
  try {
    return { json: JSON.parse(raw.toString('utf8') || '{}') };
  } catch {
    return { error: { status: 400, type: 'invalid_json', message: '请求体不是合法 JSON' } };
  }
}

function sendSettingsError(res, err) {
  if (err?.code === 'SETTINGS_INVALID') {
    return sendError(res, 400, 'settings_invalid', err.message, { errors: err.errors });
  }
  if (err?.code === 'UPSTREAM_TIMEOUT') {
    return sendError(res, 504, 'upstream_timeout', '上游响应超时');
  }
  return sendError(res, 500, 'settings_error', err?.message ?? '设置操作失败');
}

/** 用候选配置覆盖当前配置（不落盘），用于"保存前先测一下" */
function withCandidate(config, patch) {
  const clean = normalizePatch(patch ?? {});
  const next = { ...config };
  for (const [field, value] of Object.entries(clean)) {
    if (value === null) continue;
    next[field] = value;
  }
  return next;
}

/** 设置页视图：附带账号/鉴权模式，让页面能显示"账号登录 + 令牌可用" */
function adminView(settings, ctx) {
  const view = settings.publicView();
  const summary = ctx?.auth?.summary?.() ?? { configured: false, username: '' };
  return {
    ...view,
    account: {
      username: summary.username,
      createdAt: summary.createdAt ?? null,
      updatedAt: summary.updatedAt ?? null,
    },
    meta: {
      ...view.meta,
      adminMode: ctx?.config?.adminToken ? 'token-or-account' : 'account',
      tokenEnabled: Boolean(ctx?.config?.adminToken),
      sessions: ctx?.sessions?.size?.() ?? 0,
      imageMode: ctx?.config?.imageMode ?? 'pass',
    },
  };
}

/** 用候选配置探一次 GET /v1/models（保存前先验证，避免存了打不通的地址） */
async function handleAdminTest(req, res, ctx) {
  const { config, logger } = ctx;
  const parsed = await readJsonBody(req, 64 * 1024);
  if (parsed.error) return sendError(res, parsed.error.status, parsed.error.type, parsed.error.message);
  const body = parsed.json ?? {};
  const patch = body.settings ?? body;
  let candidate;
  try {
    candidate = withCandidate(config, patch);
  } catch (err) {
    return sendSettingsError(res, err);
  }
  if (!String(candidate.upstreamBaseUrl ?? '').trim()) {
    return sendError(res, 400, 'settings_invalid', '请先填写上游 Base URL', {
      errors: [{ field: 'upstreamBaseUrl', message: '必填' }],
    });
  }
  const started = Date.now();
  try {
    const result = await callUpstreamGet({
      url: upstreamUrl(candidate.upstreamBaseUrl, '/v1/models'),
      apiKey: candidate.upstreamApiKey,
      timeoutMs: Math.min(candidate.requestTimeoutMs || 15000, 15000),
    });
    const latencyMs = Date.now() - started;
    if (result.status >= 400) {
      return sendError(res, 502, 'upstream_error', `上游返回 HTTP ${result.status}`, {
        upstream: String(result.text ?? '').slice(0, 300),
      });
    }
    const models = (Array.isArray(result.json?.data) ? result.json.data : []).map((m) => ({
      id: m?.id ?? '',
      supports_tool_call: m?.supports_tool_call,
    }));
    logger.debug?.('admin test ok', { baseUrl: candidate.upstreamBaseUrl, models: models.length, latencyMs });
    return sendJson(res, 200, {
      ok: true,
      status: result.status,
      latencyMs,
      baseUrl: candidate.upstreamBaseUrl,
      models,
    });
  } catch (err) {
    return sendSettingsError(res, err);
  }
}

async function handleAdminApi(req, res, url, ctx) {
  const { config, settings, logger, auth, sessions } = ctx;
  if (!settings) return sendError(res, 503, 'settings_unavailable', '本实例没有启用设置存储');
  const pathname = url.pathname.replace(/\/+$/, '');

  if (pathname === '/admin/api/logout' && req.method === 'POST') {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token) sessions?.revoke(token);
    res.setHeader('set-cookie', clearCookie());
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/admin/api/password' && req.method === 'POST') {
    const parsed = await readJsonBody(req, 8 * 1024);
    if (parsed.error) return sendError(res, parsed.error.status, parsed.error.type, parsed.error.message);
    try {
      auth.changePassword({
        currentPassword: parsed.json?.currentPassword,
        newPassword: parsed.json?.newPassword,
      });
    } catch (err) {
      if (err instanceof AuthError) return sendError(res, err.status, err.type, err.message, { field: err.field });
      throw err;
    }
    // 改完密码让所有旧会话失效，再给当前浏览器发一个新会话
    sessions?.revokeAll();
    const token = sessions.issue(auth.summary().username, { ip: clientIp(req) });
    res.setHeader('set-cookie', sessionCookie(token, { ttlMs: sessions.ttlMs, secure: isSecureRequest(req) }));
    logger.info('admin password rotated', { username: auth.summary().username });
    return sendJson(res, 200, { ok: true, ...adminView(settings, ctx) });
  }

  if (pathname === '/admin/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, adminView(settings, ctx));
  }

  if (pathname === '/admin/api/settings' && (req.method === 'PUT' || req.method === 'POST')) {
    const parsed = await readJsonBody(req, 256 * 1024);
    if (parsed.error) return sendError(res, parsed.error.status, parsed.error.type, parsed.error.message);
    const patch = parsed.json?.settings ?? parsed.json ?? {};
    try {
      settings.update(patch);
      const view = adminView(settings, ctx);
      logger.info('settings applied', { overrides: view.meta.activeOverrides });
      return sendJson(res, 200, view);
    } catch (err) {
      return sendSettingsError(res, err);
    }
  }

  if (pathname === '/admin/api/settings/reset' && req.method === 'POST') {
    settings.reset();
    return sendJson(res, 200, adminView(settings, ctx));
  }

  if (pathname === '/admin/api/test' && req.method === 'POST') {
    return handleAdminTest(req, res, ctx);
  }

  if (pathname === '/admin/api/test-tool' && req.method === 'POST') {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_time',
          description: '获取指定时区的当前时间',
          parameters: {
            type: 'object',
            properties: { timezone: { type: 'string' } },
            required: ['timezone'],
          },
        },
      },
    ];
    const started = Date.now();
    try {
      const built = buildUpstreamRequest(
        {
          model: config.defaultModel || 'deepseek-chat',
          messages: [{ role: 'user', content: '请调用 get_time 工具告诉我上海现在的时间。' }],
          tools,
          max_tokens: 256,
        },
        config,
      );
      const result = await callUpstreamJson({
        url: built.url,
        headers: built.headers,
        body: JSON.stringify(built.body),
        timeoutMs: config.requestTimeoutMs,
      });
      const latencyMs = Date.now() - started;
      if (result.status >= 400) {
        return sendError(res, 502, 'upstream_error', `上游返回 HTTP ${result.status}`, {
          upstream: String(result.text ?? '').slice(0, 300),
        });
      }
      const parsed = resolveToolCalls({
        text: assistantTextFrom(result.json),
        nativeToolCalls: extractNativeToolCalls(result.json),
      });
      logger.info('admin self-test', {
        finish: parsed.finishReason,
        toolCalls: parsed.toolCalls.length,
        latencyMs,
      });
      return sendJson(res, 200, {
        ok: true,
        finishReason: parsed.finishReason,
        toolCalls: parsed.toolCalls.length,
        sample: parsed.toolCalls[0]?.function?.arguments?.slice(0, 200) ?? null,
        model: result.json?.model ?? built.body.model,
        latencyMs,
      });
    } catch (err) {
      return sendSettingsError(res, err);
    }
  }

  if (pathname === '/admin/api/test-vision' && req.method === 'POST') {
    return handleAdminVisionTest(req, res, ctx);
  }

  return sendError(res, 404, 'not_found', `未知设置接口: ${req.method} ${pathname}`);
}

/** 1x1 黑色 PNG（69 字节），内嵌常量：自检用，不读文件、不引依赖 */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';

const VISION_SELF_TEST_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'describe_image',
      description: '描述图片内容',
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
  },
];

/**
 * 视觉自检：发一次「1x1 PNG + tools」的真实上游请求，看上游是否接受图片。
 * 结果里同时提示 file/PDF 的支持情况（网关不会把 PDF 转图片）。
 */
async function handleAdminVisionTest(req, res, ctx) {
  const { config, logger } = ctx;
  const started = Date.now();
  const runConfig = {
    ...config,
    requestTimeoutMs: Math.max(Number(config.requestTimeoutMs) || 60000, Number(config.mediaTimeoutMs) || 120000),
  };
  const body = {
    model: config.defaultModel || 'deepseek-chat',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是一张 1x1 的图片，请用一句普通话描述它（可以说明它是纯色）。' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` } },
        ],
      },
    ],
    tools: VISION_SELF_TEST_TOOLS,
    max_tokens: 128,
  };

  const fileSupport =
    '未验证：本自检只发 image_url。file/PDF 需要上游明确支持 input_file，很多 OpenAI 兼容上游不支持；网关不会把 PDF 转成图片（零依赖做不了，也不打算引入依赖）。';

  try {
    const built = buildUpstreamRequest(body, { ...runConfig, logger });
    const result = await runUpstreamOnce({ config: runConfig, upstreamBody: built.body });
    const latencyMs = Date.now() - started;
    const parsed = resolveToolCalls(result);
    const sent = listMedia(body);
    logger.info('vision self-test ok', { latencyMs, finish: parsed.finishReason, bytes: sent[0]?.bytes });
    return sendJson(res, 200, {
      ok: true,
      visionAccepted: true,
      status: 200,
      latencyMs,
      model: result.model ?? built.body.model,
      finishReason: parsed.finishReason,
      toolCalls: parsed.toolCalls.length,
      text: String(result.text ?? '').slice(0, 200),
      mediaSent: sent.map((d) => ({ type: d.type, mime: d.mime, bytes: d.bytes })),
      fileSupport,
      note: '本次自检消耗 1 次上游调用',
    });
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (err?.upstreamStatus) {
      const vision = isVisionRejection(err.upstreamStatus, err.upstreamText);
      logger.warn('vision self-test rejected', { status: err.upstreamStatus, vision, latencyMs });
      return sendJson(res, 200, {
        ok: false,
        visionAccepted: !vision,
        status: err.upstreamStatus,
        errorType: vision ? 'upstream_vision_unsupported' : 'upstream_error',
        latencyMs,
        message: vision
          ? '上游似乎不接受图片输入：把它设成默认模型时，请把 imageMode 调成 placeholder，或换支持视觉的上游模型。'
          : `上游返回 HTTP ${err.upstreamStatus}`,
        upstream: sanitizeUpstreamSnippet(err.upstreamText),
        fileSupport,
        note: '本次自检消耗 1 次上游调用',
      });
    }
    return sendSettingsError(res, err);
  }
}

async function handleModels(res, config, logger) {
  try {
    const result = await callUpstreamGet({
      url: upstreamUrl(config.upstreamBaseUrl, '/v1/models'),
      apiKey: config.upstreamApiKey,
      timeoutMs: config.requestTimeoutMs,
    });
    logger.debug('models fetched', { status: result.status });
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(result.text);
  } catch (err) {
    handleUpstreamFailure(res, err, logger);
  }
}

async function handleChatCompletions(req, res, config, logger) {
  let raw;
  try {
    raw = await readBody(req, config.maxBodyBytes);
  } catch (err) {
    if (err.code === 'BODY_TOO_LARGE') {
      // 已停止读取：回完 413 再断开，避免客户端把剩余几百 MB 继续灌进来
      res.setHeader('connection', 'close');
      res.once('finish', () => {
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
      });
      return sendError(
        res,
        413,
        'payload_too_large',
        `请求体过大：读取到 ${formatBytes(err.size)} 时已超过上限 ${formatBytes(err.limit)}。` +
          `可在 /admin「网关」分区调大 maxBodyBytes（多模态图片按 base64 体积计算）。`,
        { size: err.size, limit: err.limit },
      );
    }
    throw err;
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return sendError(res, 400, 'invalid_json', '请求体不是合法 JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendError(res, 400, 'invalid_request_error', '请求体必须是 JSON 对象');
  }
  if (!Array.isArray(body.messages)) {
    return sendError(res, 400, 'invalid_request_error', '缺少 messages 数组');
  }

  // 内存保护：图片数量 / 单 part 体积超限直接拒绝，避免 base64 撑爆进程
  const mediaCounts = countMediaInBody(body);
  const mediaSizes = mediaSizeStats(body);
  const maxImages = config.maxImagesPerRequest ?? 8;
  const maxPartBytes = config.maxMediaPartBytes ?? 8 * 1024 * 1024;
  if (mediaCounts.images > maxImages) {
    logger.warn('media guard: too many images', { images: mediaCounts.images, limit: maxImages });
    return sendError(res, 413, 'payload_too_large', `单次请求图片过多（${mediaCounts.images} 张，上限 ${maxImages} 张）`, {
      images: mediaCounts.images,
      limit: maxImages,
    });
  }
  if (mediaSizes.maxPartBytes > maxPartBytes) {
    logger.warn('media guard: media part too large', { bytes: mediaSizes.maxPartBytes, limit: maxPartBytes });
    return sendError(
      res,
      413,
      'payload_too_large',
      `单个媒体 part 过大（${formatBytes(mediaSizes.maxPartBytes)}，上限 ${formatBytes(maxPartBytes)}）`,
      { bytes: mediaSizes.maxPartBytes, limit: maxPartBytes },
    );
  }

  const simulate = config.toolMode !== 'off' && hasTools(body);
  if (simulate && config.imageMode === 'reject' && hasMedia(body)) {
    logger.warn('imageMode=reject blocked a media request', mediaCounts);
    return sendError(res, 400, 'vision_unsupported', '当前 imageMode=reject，已拒绝含媒体的请求', {
      imageMode: 'reject',
      media: mediaCounts,
    });
  }
  if (simulate) {
    return handleSimulated(req, res, config, logger, body, raw);
  }
  return handlePassthrough(req, res, config, logger, raw, body);
}

/** 无工具：字节级透传（仅当模型映射生效时改写 model 字段，其余原样发出） */
async function handlePassthrough(req, res, config, logger, raw, body) {
  const url = upstreamUrl(config.upstreamBaseUrl, '/v1/chat/completions');
  const headers = upstreamHeaders(config.upstreamApiKey, {
    accept: body?.stream === true ? 'text/event-stream' : 'application/json',
  });

  let payload = raw;
  const resolved = resolveModel(body?.model, config);
  if (resolved && resolved !== body?.model) {
    payload = Buffer.from(JSON.stringify({ ...body, model: resolved }), 'utf8');
    logger.debug('passthrough model mapped', { from: body?.model, to: resolved });
  }
  logger.debug('passthrough', { model: body?.model, stream: body?.stream === true });

  if (body?.stream === true) {
    try {
      const opened = await openUpstreamStream({
        url,
        headers,
        body: payload,
        timeoutMs: config.requestTimeoutMs,
      });
      if (opened.response.status >= 400) {
        const text = await opened.response.text();
        opened.finish();
        res.writeHead(opened.response.status, {
          'content-type': opened.response.headers.get('content-type') ?? 'application/json; charset=utf-8',
        });
        res.end(text);
        return;
      }
      return pipeUpstreamStream(res, opened, logger);
    } catch (err) {
      return handleUpstreamFailure(res, err, logger);
    }
  }

  try {
    const result = await callUpstreamJson({ url, headers, body: payload, timeoutMs: config.requestTimeoutMs });
    res.writeHead(result.status, {
      'content-type': result.headers.get('content-type') ?? 'application/json; charset=utf-8',
    });
    res.end(result.text);
  } catch (err) {
    handleUpstreamFailure(res, err, logger);
  }
}

function handleUpstreamFailure(res, err, logger) {
  if (err?.code === 'UPSTREAM_TIMEOUT') {
    logger.warn('upstream timeout', { message: err.message });
    return sendError(res, 504, 'upstream_timeout', '上游响应超时');
  }
  logger.warn('upstream failure', { message: err?.message ?? String(err) });
  return sendError(res, 502, 'upstream_error', `上游请求失败: ${err?.message ?? err}`);
}

// ---------------------------------------------------------------- 模拟模式
/** 从上游非流式响应里取出 assistant 文本 */
function assistantTextFrom(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

/** 带工具时必须命中工具；否则按文本返回 */
function toolChoiceRequiresTools(toolChoice) {
  if (toolChoice === 'required' || toolChoice === 'any') return true;
  if (toolChoice && typeof toolChoice === 'object') {
    return Boolean(toolChoice.function?.name ?? toolChoice.name);
  }
  return false;
}

/** 重试时追加的强化指令 */
const RETRY_HINT =
  '\n\n【再次提醒】你刚才没有按格式输出工具调用。本轮必须只输出 <tool_call>{"name":"工具名","arguments":{...}}</tool_call> 块，禁止输出任何解释文字。';

function upstreamStatusError(status, text) {
  const err = new Error(`上游返回 ${status}`);
  err.upstreamStatus = status;
  err.upstreamText = text;
  return err;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 取上游的思考内容（reasoning_content / reasoning），REASONING_PASSTHROUGH=off 时不透传 */
function pickReasoning(message, config) {
  if (!config.reasoningPassthrough) return { text: null, key: 'reasoning_content' };
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content) {
    return { text: message.reasoning_content, key: 'reasoning_content' };
  }
  if (typeof message?.reasoning === 'string' && message.reasoning) {
    return { text: message.reasoning, key: 'reasoning' };
  }
  return { text: null, key: 'reasoning_content' };
}

/** 调一次「已改写」的上游请求；流式也在这里读完（buffer-then-synthesize）。 */
async function runUpstreamOnce({ config, upstreamBody }) {
  const url = upstreamUrl(config.upstreamBaseUrl, '/v1/chat/completions');
  const wantStream = upstreamBody.stream === true;
  const headers = upstreamHeaders(config.upstreamApiKey, {
    accept: wantStream ? 'text/event-stream' : 'application/json',
  });
  const payload = JSON.stringify(upstreamBody);

  if (!wantStream) {
    const result = await callUpstreamJson({ url, headers, body: payload, timeoutMs: config.requestTimeoutMs });
    if (result.status >= 400) throw upstreamStatusError(result.status, result.text);
    const message = result.json?.choices?.[0]?.message;
    const reasoning = pickReasoning(message, config);
    return {
      text: assistantTextFrom(result.json),
      nativeToolCalls: extractNativeToolCalls(result.json),
      reasoning: reasoning.text,
      reasoningKey: reasoning.key,
      usage: result.json?.usage ?? null,
      model: result.json?.model,
    };
  }

  const opened = await openUpstreamStream({ url, headers, body: payload, timeoutMs: config.requestTimeoutMs });
  try {
    if (opened.response.status >= 400) {
      const text = await opened.response.text();
      throw upstreamStatusError(opened.response.status, text);
    }
    const contentType = opened.response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const json = safeParseJson(await opened.response.text());
      const message = json?.choices?.[0]?.message;
      const reasoning = pickReasoning(message, config);
      return {
        text: assistantTextFrom(json),
        nativeToolCalls: extractNativeToolCalls(json),
        reasoning: reasoning.text,
        reasoningKey: reasoning.key,
        usage: json?.usage ?? null,
        model: json?.model,
      };
    }
    const collected = await collectStreamText(opened.response.body);
    return {
      text: collected.text,
      nativeToolCalls: (collected.toolCalls ?? []).filter((c) => c.function?.name),
      reasoning: config.reasoningPassthrough ? collected.reasoning || null : null,
      reasoningKey: collected.reasoningKey,
      usage: collected.usage,
      model: collected.model,
    };
  } finally {
    opened.finish();
  }
}

function withRetryHint(upstreamBody) {
  return {
    ...upstreamBody,
    messages: [
      { role: 'system', content: `${upstreamBody.messages[0]?.content ?? ''}${RETRY_HINT}` },
      ...upstreamBody.messages.slice(1),
    ],
  };
}

/**
 * 上游原生 tool_calls 优先（直接转换，不二次包裹）；否则解析 <tool_call> 文本块。
 */
function resolveToolCalls(result) {
  if (Array.isArray(result.nativeToolCalls) && result.nativeToolCalls.length > 0) {
    return {
      content: typeof result.text === 'string' && result.text.trim() ? result.text : null,
      toolCalls: result.nativeToolCalls,
      finishReason: 'tool_calls',
      matched: 0,
      failed: 0,
      native: true,
    };
  }
  return { ...parseModelOutput(result.text), native: false };
}

/** 判定上游的错误是否属于"不接受图片/多模态" */
function isVisionRejection(status, text) {
  if (status !== 400 && status !== 422) return false;
  const s = String(text ?? '');
  return /image|vision|multimodal|multi-modal|content[-_ ]?type|unsupported.*(content|part)/i.test(s);
}

/** 上游错误体脱敏：去掉 data URL / base64 长串 / key，再截断 */
export function sanitizeUpstreamSnippet(text, max = 500) {
  let s = String(text ?? '');
  s = s.replace(/data:[^\s"']{40,}/gi, '<inline data URL>');
  s = s.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
  s = s.replace(/[A-Za-z0-9+/]{200,}={0,2}/g, (m) => `<base64 ${m.length} chars>`);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function handleSimulated(req, res, config, logger, body) {
  const mediaCounts = countMediaInBody(body);
  const withMedia = mediaCounts.images + mediaCounts.files + mediaCounts.audios > 0;
  if (config.logLevel === 'debug' || mediaCounts.unknownParts) {
    logger.debug('media parts', { parts: listMedia(body, { limit: 8 }) });
  }
  logger.info('media forwarded', {
    images: mediaCounts.images,
    files: mediaCounts.files,
    audios: mediaCounts.audios,
    unknownParts: mediaCounts.unknownParts,
    mode: config.imageMode,
    parts: listMedia(body, { limit: 6 }).map((d) => ({
      type: d.type,
      mime: d.mime || undefined,
      bytes: d.bytes || undefined,
      urlKind: d.urlKind,
      host: d.host || undefined,
    })),
  });

  // 含媒体的请求放宽超时（视觉推理更慢），并记录放宽原因
  const runConfig = withMedia
    ? {
        ...config,
        requestTimeoutMs: Math.max(
          Number(config.requestTimeoutMs) || 60000,
          Number(config.mediaTimeoutMs) || 120000,
        ),
      }
    : config;
  if (withMedia && runConfig.requestTimeoutMs !== config.requestTimeoutMs) {
    logger.info('media timeout widened', {
      from: config.requestTimeoutMs,
      to: runConfig.requestTimeoutMs,
      reason: 'request contains media parts',
    });
  }

  const built = buildUpstreamRequest(body, { ...runConfig, logger });
  const upstreamBody = built.body;
  const wantStream = body?.stream === true;
  const includeUsage = body?.stream_options?.include_usage === true;
  const model = upstreamBody.model ?? body?.model;

  logger.debug('simulated request', {
    model,
    stream: wantStream,
    messages: upstreamBody.messages.length,
    systemChars: upstreamBody.messages[0]?.content?.length ?? 0,
  });
  if (logger.level === 'debug') {
    logger.debug('upstream prompt', { messages: upstreamBody.messages });
  }

  try {
    if (!wantStream) {
      let result = await runUpstreamOnce({ config: runConfig, upstreamBody });
      let parsed = resolveToolCalls(result);

      // tool_choice 要求调用但模型没给 → 带强化指令重试一次
      if (parsed.toolCalls.length === 0 && toolChoiceRequiresTools(body?.tool_choice)) {
        logger.warn('tool_choice requires a tool call but model returned text, retrying once', {
          finishReason: parsed.finishReason,
        });
        result = await runUpstreamOnce({ config: runConfig, upstreamBody: withRetryHint(upstreamBody) });
        parsed = resolveToolCalls(result);
      }

      if (parsed.failed > 0) {
        logger.warn('some <tool_call> blocks could not be parsed, kept as text', { failed: parsed.failed });
      }
      const completion = buildChatCompletion({
        model: result.model ?? model,
        content: parsed.content,
        toolCalls: parsed.toolCalls,
        finishReason: parsed.finishReason,
        usage: result.usage ?? null,
        reasoning: result.reasoning ?? null,
        reasoningKey: result.reasoningKey,
      });
      logger.debug('simulated response', {
        finish: completion.choices[0].finish_reason,
        toolCalls: parsed.toolCalls.length,
      });
      return sendJson(res, 200, completion);
    }

    // buffer-then-synthesize：先把上游整段流读完，再判定并合成 SSE
    let result = await runUpstreamOnce({ config: runConfig, upstreamBody });
    let parsed = resolveToolCalls(result);
    if (parsed.toolCalls.length === 0 && toolChoiceRequiresTools(body?.tool_choice)) {
      logger.warn('stream: tool_choice requires a tool call but model returned text, retrying once', {
        finishReason: parsed.finishReason,
      });
      result = await runUpstreamOnce({ config: runConfig, upstreamBody: withRetryHint(upstreamBody) });
      parsed = resolveToolCalls(result);
    }
    if (parsed.failed > 0) {
      logger.warn('some <tool_call> blocks could not be parsed, kept as text', { failed: parsed.failed });
    }

    const chunks = buildSseChunks({
      model: result.model ?? model,
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      usage: result.usage,
      includeUsage,
      reasoning: result.reasoning ?? null,
      reasoningKey: result.reasoningKey,
    });

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    for (const chunk of chunks) res.write(encodeSse(chunk));
    res.write(SSE_DONE_LINE);
    res.end();
    logger.debug('simulated stream done', {
      chunks: chunks.length,
      toolCalls: parsed.toolCalls.length,
    });
  } catch (err) {
    if (err?.upstreamStatus) {
      const sentMedia = mediaCounts.images + mediaCounts.files > 0;
      if (sentMedia && isVisionRejection(err.upstreamStatus, err.upstreamText)) {
        logger.warn('upstream rejected media input', {
          status: err.upstreamStatus,
          images: mediaCounts.images,
          files: mediaCounts.files,
          mode: config.imageMode,
        });
        return sendError(
          res,
          err.upstreamStatus,
          'upstream_vision_unsupported',
          '上游模型可能不支持图片输入。可在 /admin 把 imageMode 改为 placeholder（媒体转占位文本后重试），或换一个支持视觉的上游模型。',
          {
            upstreamStatus: err.upstreamStatus,
            upstream: sanitizeUpstreamSnippet(err.upstreamText),
            imageMode: config.imageMode,
          },
        );
      }
      res.writeHead(err.upstreamStatus, { 'content-type': 'application/json; charset=utf-8' });
      res.end(err.upstreamText ?? '');
      return;
    }
    handleUpstreamFailure(res, err, logger);
  }
}

export function startServer({ config = defaultConfig, logger = defaultLogger, settings } = {}) {
  const store =
    settings ??
    createSettingsStore({
      env: process.env,
      filePath: path.resolve(config.settingsFile || path.join(config.dataDir, 'settings.json')),
      logger,
      version: packageVersion(),
    });
  const server = createServer({ settings: store, config, logger });
  server.listen(config.port, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.port;
    const cfg = store.get();
    const admin = server.adminState();
    logger.info('toolcall-gateway listening', {
      port,
      toolMode: cfg.toolMode,
      upstream: cfg.upstreamBaseUrl || '(未配置)',
      settingsFile: store.filePath,
      adminAccount: admin.configured ? admin.username : '未初始化',
    });
    const hints = [];
    if (!admin.configured) {
      hints.push(`首次初始化：浏览器打开 http://localhost:${port}/admin 创建管理员并填写上游（在此之前，任何能访问该端口的客户端都可以完成初始化）`);
    }
    if (!String(cfg.upstreamBaseUrl ?? '').trim()) {
      hints.push(`上游未配置：/v1 请求会返回 503 upstream_not_configured，配置保存后立即生效`);
    }
    if (hints.length) logger.warn('需要完成初始化', { hints });
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = startServer();
  const shutdown = (signal) => {
    defaultLogger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
