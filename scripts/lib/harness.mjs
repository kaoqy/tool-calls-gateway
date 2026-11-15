// 测试/脚本共用的小工具：起子进程、等健康检查、发 HTTP 请求、读 SSE。
// 只依赖 node: 内置模块 + 全局 fetch。
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDoneData, parseSseBlock } from '../../src/sse.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function openLog(name) {
  const dir = path.join(ROOT, '.logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${process.pid}-${Date.now()}.log`);
  return { file, fd: fs.openSync(file, 'a') };
}

export function startProcess(name, entry, { env = {}, cwd = ROOT } = {}) {
  const log = openLog(name);
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', log.fd, log.fd],
    windowsHide: true,
  });
  child.__name = name;
  child.__logFile = log.file;
  return child;
}

export function stopProcess(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

export function readLog(child) {
  try {
    return fs.readFileSync(child.__logFile, 'utf8');
  } catch {
    return '';
  }
}

export function waitForHealth(url, { timeoutMs = 20000, intervalMs = 80 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
        await res.text().catch(() => {});
        if (res.status < 500) return;
      } catch (err) {
        lastErr = err;
      }
      await sleep(intervalMs);
    }
    throw new Error(`等待 ${url} 超时${lastErr ? `: ${lastErr.message}` : ''}`);
  })();
}

/**
 * 起一套 mock 上游 + 网关。
 * @param {{mockEnv?:object, gwEnv?:object}} [opts]
 */
export async function startStack(opts = {}) {
  const mockPort = await getFreePort();
  const gwPort = await getFreePort();
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  const baseUrl = `http://127.0.0.1:${gwPort}`;

  const mock = startProcess('mock', path.join(ROOT, 'mock', 'upstream.mjs'), {
    env: { PORT: String(mockPort), ...(opts.mockEnv ?? {}) },
  });
  let gw = null;
  try {
    await waitForHealth(`${mockUrl}/healthz`);
    gw = startProcess('gateway', path.join(ROOT, 'src', 'server.mjs'), {
      env: {
        PORT: String(gwPort),
        UPSTREAM_BASE_URL: mockUrl,
        UPSTREAM_API_KEY: 'sk-test-not-a-real-key',
        LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
        // 显式清空真实上游相关的模型配置，避免 shell 里的 .env 泄漏进 mock 场景
        DEFAULT_MODEL: '',
        MODEL_MAP: '',
        MODEL_OVERRIDE: '',
        GATEWAY_API_KEY: '',
        REASONING_PASSTHROUGH: 'on',
        MAX_LIVE_CALLS: '40',
        ...(opts.gwEnv ?? {}),
      },
    });
    await waitForHealth(`${baseUrl}/healthz`);
  } catch (err) {
    const logs = [readLog(mock), gw && readLog(gw)].filter(Boolean).join('\n--- gateway ---\n');
    stopProcess(gw);
    stopProcess(mock);
    throw new Error(`${err.message}\n--- child logs ---\n${logs}`);
  }

  return {
    mockUrl,
    baseUrl,
    mock,
    gw,
    logs: () => `--- mock ---\n${readLog(mock)}\n--- gateway ---\n${readLog(gw)}`,
    async close() {
      stopProcess(gw);
      stopProcess(mock);
      await sleep(50);
    },
  };
}

/**
 * 发一个 JSON 请求，返回 status / text / json。
 */
export async function requestJson(url, { method = 'GET', body, headers = {}, signal } = {}) {
  const init = { method, headers: { ...headers }, signal };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/**
 * 读完整 SSE 响应体，解析成事件数组。
 */
export async function requestSse(url, { body, headers = {} } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const raw = await res.text();
  const events = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const parsed = parseSseBlock(block.trim());
    if (!parsed) continue;
    let json = null;
    if (parsed.data && !isDoneData(parsed.data)) {
      try {
        json = JSON.parse(parsed.data);
      } catch {
        json = null;
      }
    }
    events.push({ ...parsed, json });
  }
  return { status: res.status, headers: res.headers, raw, text: raw, events };
}

/** 取一段 SSE 事件里所有 delta 的拼接文本 */
export function concatDeltaContent(events) {
  let out = '';
  for (const evt of events) {
    const choice = evt.json?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string') out += delta.content;
  }
  return out;
}

/** 取一段 SSE 事件里所有 tool_call arguments 分片（按 index 归并） */
export function concatToolCallArgs(events) {
  const map = new Map();
  for (const evt of events) {
    const choice = evt.json?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (!Array.isArray(delta.tool_calls)) continue;
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!map.has(idx)) map.set(idx, { id: null, name: null, type: null, arguments: '' });
      const entry = map.get(idx);
      if (tc.id) entry.id = tc.id;
      if (tc.type) entry.type = tc.type;
      if (tc.function?.name) entry.name = tc.function.name;
      if (typeof tc.function?.arguments === 'string') entry.arguments += tc.function.arguments;
    }
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([index, v]) => ({ index, ...v }));
}

export function fail(message, extra) {
  throw new Error(extra ? `${message}\n${extra}` : message);
}

/** 读 mock 的诊断信息：网关实际发到上游的请求签名 */
export async function getDiag(stack) {
  const res = await requestJson(`${stack.mockUrl}/__diag`);
  return res.json ?? {};
}
