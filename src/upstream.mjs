// 调上游：只依赖全局 fetch。负责超时、错误分类、头部构造。
import { config as defaultConfig } from './config.mjs';

export class UpstreamTimeoutError extends Error {
  constructor(message = '上游请求超时') {
    super(message);
    this.name = 'UpstreamTimeoutError';
    this.code = 'UPSTREAM_TIMEOUT';
  }
}

export class UpstreamNetworkError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'UpstreamNetworkError';
    this.code = 'UPSTREAM_NETWORK_ERROR';
    this.cause = cause;
  }
}

/** base 可能带 /v1 后缀，避免拼出 /v1/v1 */
export function upstreamUrl(baseUrl, pathname) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (base.endsWith('/v1') && p.startsWith('/v1/')) return base + p.slice(3);
  return base + p;
}

export function upstreamHeaders(apiKey, extra = {}) {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  };
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  const state = { timedOut: false };
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
  }
  return {
    signal: controller.signal,
    state,
    abort: () => controller.abort(),
    clear: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

function toBody(body) {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body; // Buffer，原样字节透传
  return JSON.stringify(body);
}

/**
 * 非流式调用上游，读取完整响应体。
 * @returns {Promise<{status:number, headers:Headers, text:string, json:any}>}
 */
export async function callUpstreamJson({ url, headers, body, timeoutMs = defaultConfig.requestTimeoutMs }) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: toBody(body),
      signal: t.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  } catch (err) {
    if (t.state.timedOut) throw new UpstreamTimeoutError(`上游 ${timeoutMs}ms 内未完成响应`);
    if (err?.name === 'AbortError') throw new UpstreamNetworkError('上游请求被中断', err);
    throw new UpstreamNetworkError(`无法连接上游: ${err?.message ?? err}`, err);
  } finally {
    t.clear();
  }
}

/**
 * 打开上游流式响应（返回原始 Response，调用方负责读 body）。
 * 超时覆盖整个 body 生命周期，读完必须调用 finish()。
 */
export async function openUpstreamStream({ url, headers, body, timeoutMs = defaultConfig.requestTimeoutMs }) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: toBody(body),
      signal: t.signal,
    });
    return {
      response: res,
      finish: () => t.clear(),
      abort: () => t.abort(),
      timedOut: () => t.state.timedOut,
    };
  } catch (err) {
    t.clear();
    if (t.state.timedOut) throw new UpstreamTimeoutError(`上游 ${timeoutMs}ms 内未完成响应`);
    throw new UpstreamNetworkError(`无法连接上游: ${err?.message ?? err}`, err);
  }
}

/** GET 透传（/v1/models 之类） */
export async function callUpstreamGet({ url, apiKey, timeoutMs = defaultConfig.requestTimeoutMs }) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: t.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  } catch (err) {
    if (t.state.timedOut) throw new UpstreamTimeoutError(`上游 ${timeoutMs}ms 内未完成响应`);
    throw new UpstreamNetworkError(`无法连接上游: ${err?.message ?? err}`, err);
  } finally {
    t.clear();
  }
}
