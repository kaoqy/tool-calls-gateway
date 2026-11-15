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
import { renderAdminHtml, renderLoginHtml } from './admin-ui.mjs';
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

/** 读取请求体，超出上限抛 code=BODY_TOO_LARGE */
export async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error(`请求体超过 ${maxBytes} 字节上限`);
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

export function createServer({ settings, config = defaultConfig, logger = defaultLogger } = {}) {
  // 有 settings 时每个请求都取最新配置（UI 保存后立即热生效，无需重启）
  const getConfig = typeof settings?.get === 'function' ? () => settings.get() : () => config;
  const server = http.createServer((req, res) => {
    handleRequest(req, res, { getConfig, settings, logger }).catch((err) => {
      logger.error('unhandled request error', { message: err?.message ?? String(err) });
      sendError(res, 500, 'internal_error', '网关内部错误');
    });
  });
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

function readCookie(req, name) {
  const raw = String(req.headers.cookie ?? '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      const value = part.slice(idx + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return '';
}

/** 设置页鉴权：ADMIN_TOKEN（Bearer 或登录 Cookie）> 本机回环。 */
function adminAuthorized(req, config) {
  if (config.adminToken) {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (bearer && bearer === config.adminToken) return true;
    return readCookie(req, 'tcg_admin') === config.adminToken;
  }
  const ip = req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

async function handleAdminLogin(req, res, config) {
  const parsed = await readJsonBody(req, 8 * 1024);
  if (parsed.error) return sendError(res, parsed.error.status, parsed.error.type, parsed.error.message);
  if (!config.adminToken) return sendJson(res, 200, { ok: true, mode: 'loopback' });
  const token = String(parsed.json?.token ?? '').trim();
  if (!token || token !== config.adminToken) {
    return sendError(res, 401, 'admin_unauthorized', '令牌不正确');
  }
  res.setHeader('set-cookie', `tcg_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  return sendJson(res, 200, { ok: true, mode: 'token' });
}

function rejectAdmin(req, res, config) {
  if (adminAuthorized(req, config)) return false;
  sendError(
    res,
    401,
    'admin_unauthorized',
    config.adminToken
      ? '设置页需要 Authorization: Bearer <ADMIN_TOKEN>'
      : '设置页默认只允许本机访问；远程访问请设置 ADMIN_TOKEN 并携带 Bearer 令牌',
  );
  return true;
}

async function handleRequest(req, res, ctx) {
  const { getConfig, settings, logger } = ctx;
  const config = getConfig();
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  logger.debug('request', { method: req.method, path: url.pathname });

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return sendJson(res, 200, { status: 'ok' });
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/login') {
    return handleAdminLogin(req, res, config);
  }

  if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    };
    if (!adminAuthorized(req, config)) {
      res.writeHead(401, headers);
      res.end(renderLoginHtml({ version: packageVersion() }));
      return;
    }
    res.writeHead(200, headers);
    res.end(renderAdminHtml({ version: packageVersion() }));
    return;
  }

  if (url.pathname.startsWith('/admin/api/')) {
    if (rejectAdmin(req, res, config)) return;
    return handleAdminApi(req, res, url, { config, settings, logger });
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    if (rejectUnauthorized(req, res, config)) return;
    return handleModels(res, config, logger);
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    if (rejectUnauthorized(req, res, config)) return;
    return handleChatCompletions(req, res, config, logger);
  }

  return sendError(res, 404, 'not_found', `未知路由: ${req.method} ${url.pathname}`);
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

/** 设置页视图：附带"当前鉴权模式"，让页面能显示 令牌保护 / 本机访问 */
function adminView(settings, config) {
  const view = settings.publicView();
  return { ...view, meta: { ...view.meta, adminMode: config.adminToken ? 'token' : 'loopback' } };
}

async function handleAdminApi(req, res, url, { config, settings, logger }) {
  if (!settings) return sendError(res, 503, 'settings_unavailable', '本实例没有启用设置存储');
  const pathname = url.pathname.replace(/\/+$/, '');

  if (pathname === '/admin/api/logout' && req.method === 'POST') {
    res.setHeader('set-cookie', 'tcg_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/admin/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, adminView(settings, config));
  }

  if (pathname === '/admin/api/settings' && (req.method === 'PUT' || req.method === 'POST')) {
    const parsed = await readJsonBody(req, 256 * 1024);
    if (parsed.error) return sendError(res, parsed.error.status, parsed.error.type, parsed.error.message);
    const patch = parsed.json?.settings ?? parsed.json ?? {};
    try {
      settings.update(patch);
      const view = adminView(settings, config);
      logger.info('settings applied', { overrides: view.meta.activeOverrides });
      return sendJson(res, 200, view);
    } catch (err) {
      return sendSettingsError(res, err);
    }
  }

  if (pathname === '/admin/api/settings/reset' && req.method === 'POST') {
    settings.reset();
    return sendJson(res, 200, adminView(settings, config));
  }

  if (pathname === '/admin/api/test' && req.method === 'POST') {
    const parsed = await readJsonBody(req, 64 * 1024);
    if (parsed.error) return sendError(res, parsed.error.status, parsed.error.type, parsed.error.message);
    let candidate;
    try {
      candidate = withCandidate(config, parsed.json?.settings ?? {});
    } catch (err) {
      return sendSettingsError(res, err);
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

  return sendError(res, 404, 'not_found', `未知设置接口: ${req.method} ${pathname}`);
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
      sendError(res, 413, 'payload_too_large', `请求体超过 ${config.maxBodyBytes} 字节上限`);
      req.resume(); // 丢弃剩余数据，但不粗暴断开连接
      return;
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

  const simulate = config.toolMode !== 'off' && hasTools(body);
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

async function handleSimulated(req, res, config, logger, body) {
  const built = buildUpstreamRequest(body, config);
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
      let result = await runUpstreamOnce({ config, upstreamBody });
      let parsed = resolveToolCalls(result);

      // tool_choice 要求调用但模型没给 → 带强化指令重试一次
      if (parsed.toolCalls.length === 0 && toolChoiceRequiresTools(body?.tool_choice)) {
        logger.warn('tool_choice requires a tool call but model returned text, retrying once', {
          finishReason: parsed.finishReason,
        });
        result = await runUpstreamOnce({ config, upstreamBody: withRetryHint(upstreamBody) });
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
    let result = await runUpstreamOnce({ config, upstreamBody });
    let parsed = resolveToolCalls(result);
    if (parsed.toolCalls.length === 0 && toolChoiceRequiresTools(body?.tool_choice)) {
      logger.warn('stream: tool_choice requires a tool call but model returned text, retrying once', {
        finishReason: parsed.finishReason,
      });
      result = await runUpstreamOnce({ config, upstreamBody: withRetryHint(upstreamBody) });
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
    logger.info('toolcall-gateway listening', {
      port,
      toolMode: config.toolMode,
      upstream: config.upstreamBaseUrl,
      settingsFile: store.filePath,
      admin: config.adminToken ? 'token-required' : 'loopback-only',
    });
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
