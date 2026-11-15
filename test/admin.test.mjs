// 设置页端到端：真实起两个 mock 上游 + 一个网关，验证「网页改配置 → 立即换上游」。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getFreePort,
  startProcess,
  stopProcess,
  waitForHealth,
  requestJson,
  getDiag,
} from '../scripts/lib/harness.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-admin-data-'));
const children = [];

async function startMock(label) {
  const port = await getFreePort();
  const child = startProcess(`mock-${label}`, 'mock/upstream.mjs', { env: { PORT: String(port) } });
  children.push(child);
  await waitForHealth(`http://127.0.0.1:${port}/healthz`);
  return { url: `http://127.0.0.1:${port}`, diag: () => requestJson(`http://127.0.0.1:${port}/__diag`).then((r) => r.json) };
}

async function startGateway(extraEnv = {}) {
  const port = await getFreePort();
  const child = startProcess('gw-admin', 'src/server.mjs', {
    env: {
      PORT: String(port),
      UPSTREAM_BASE_URL: mockA.url,
      UPSTREAM_API_KEY: 'sk-env-upstream-key',
      DEFAULT_MODEL: 'mock-tool',
      TOOL_MODE: 'auto',
      LOG_LEVEL: 'warn',
      DATA_DIR: dataDir,
      ...extraEnv,
    },
  });
  children.push(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/healthz`);
  return { baseUrl, child };
}

const mockA = await startMock('a');
const mockB = await startMock('b');
const gw = await startGateway();

after(async () => {
  for (const child of children) stopProcess(child);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const chatWithTools = (baseUrl, model = 'mock-tool') =>
  requestJson(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: {
      model,
      messages: [{ role: 'user', content: '北京天气？' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '天气',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        },
      ],
    },
  });

test('1. /admin 返回设置页面（含表单与脚本，无外部资源）', async () => {
  const res = await requestJson(`${gw.baseUrl}/admin`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.ok(res.text.includes('id="upstreamBaseUrl"'));
  assert.ok(res.text.includes('id="modelMap"'));
  assert.ok(res.text.includes('保存并应用'));
  assert.equal(/<script[^>]+src=/.test(res.text), false, '不允许外链脚本');
  assert.equal(/<link[^>]+href="http/.test(res.text), false, '不允许外链样式');
});

test('2. GET 设置：密钥脱敏、来源标注 env', async () => {
  const res = await requestJson(`${gw.baseUrl}/admin/api/settings`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.sources.upstreamBaseUrl, 'env');
  assert.equal(res.json.settings.upstreamApiKey.set, true);
  assert.ok(res.json.settings.upstreamApiKey.hint.includes('***'));
  assert.equal(res.text.includes('sk-env-upstream-key'), false, '不得回显上游明文 key');
});

test('3. PUT 改上游 → 下一个请求立刻打到新上游（无需重启）', async () => {
  const before = await chatWithTools(gw.baseUrl);
  assert.equal(before.status, 200, before.text);
  assert.equal(before.json.model, 'mock-tool');
  const diagA1 = await mockA.diag();
  assert.equal(diagA1.lastRequest.model, 'mock-tool', '改动前应打到 mock A');

  const put = await requestJson(`${gw.baseUrl}/admin/api/settings`, {
    method: 'PUT',
    body: { settings: { upstreamBaseUrl: mockB.url, upstreamApiKey: 'sk-ui-switched-key' } },
  });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.sources.upstreamBaseUrl, 'file');
  assert.equal(put.text.includes('sk-ui-switched-key'), false, '保存响应不得回显明文');

  const after = await chatWithTools(gw.baseUrl);
  assert.equal(after.status, 200, after.text);

  const diagB = await mockB.diag();
  assert.equal(diagB.lastRequest.model, 'mock-tool', '改动后应打到 mock B');
  assert.ok(diagB.lastRequest.authPrefix.startsWith('Bearer sk-ui'), `上游应收到 UI 配置的 key，实际 ${diagB.lastRequest.authPrefix}`);

  const diagA2 = await mockA.diag();
  assert.equal(diagA2.lastRequest.model, diagA1.lastRequest.model, 'mock A 不应再收到请求');
});

test('4. 非法配置 → 400 settings_invalid，且不改变生效配置', async () => {
  const res = await requestJson(`${gw.baseUrl}/admin/api/settings`, {
    method: 'PUT',
    body: { settings: { upstreamBaseUrl: 'ftp://nope' } },
  });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error.type, 'settings_invalid');
  assert.equal(res.json.error.errors[0].field, 'upstreamBaseUrl');

  const view = await requestJson(`${gw.baseUrl}/admin/api/settings`);
  assert.equal(view.json.settings.upstreamBaseUrl, mockB.url, '失败后仍应保持上一次的有效配置');
});

test('5. 未知字段 → 400（不静默丢弃）', async () => {
  const res = await requestJson(`${gw.baseUrl}/admin/api/settings`, {
    method: 'PUT',
    body: { settings: { adminToken: 'x' } },
  });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error.errors[0].field, 'adminToken');
});

test('6. 连接测试：/admin/api/test 用候选配置打 /models', async () => {
  const res = await requestJson(`${gw.baseUrl}/admin/api/test`, {
    method: 'POST',
    body: { settings: { upstreamBaseUrl: mockA.url } },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.models.length >= 1);
  assert.equal(typeof res.json.latencyMs, 'number');
});

test('7. 重置 → 回落 env，请求重新打回 mock A', async () => {
  const res = await requestJson(`${gw.baseUrl}/admin/api/settings/reset`, { method: 'POST' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.sources.upstreamBaseUrl, 'env');
  assert.equal(res.json.settings.upstreamApiKey.set, true);

  await chatWithTools(gw.baseUrl);
  const diagA = await mockA.diag();
  assert.equal(diagA.lastRequest.mode, 'tool');
  assert.equal(diagA.lastRequest.model, 'mock-tool');
});

test('8. 设置文件确实落盘，且只含覆盖项', async () => {
  await requestJson(`${gw.baseUrl}/admin/api/settings`, {
    method: 'PUT',
    body: { settings: { defaultModel: 'mock-multi' } },
  });
  const file = path.join(dataDir, 'settings.json');
  assert.equal(fs.existsSync(file), true);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(doc.settings, { defaultModel: 'mock-multi' });
});

test('9. ADMIN_TOKEN：远程/未带 token → 401（页面给登录表单）；带对 token → 200', async () => {
  const a = await startGateway({ ADMIN_TOKEN: 'adm-secret' });
  const noToken = await requestJson(`${a.baseUrl}/admin/api/settings`);
  assert.equal(noToken.status, 401, noToken.text);
  assert.equal(noToken.json.error.type, 'admin_unauthorized');

  const pageNoAuth = await requestJson(`${a.baseUrl}/admin`);
  assert.equal(pageNoAuth.status, 401);
  assert.match(pageNoAuth.headers.get('content-type') ?? '', /text\/html/);
  assert.ok(pageNoAuth.text.includes('id="token"'), '未登录时应返回登录页');

  const wrong = await requestJson(`${a.baseUrl}/admin/api/settings`, { headers: { authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);

  const ok = await requestJson(`${a.baseUrl}/admin/api/settings`, { headers: { authorization: 'Bearer adm-secret' } });
  assert.equal(ok.status, 200);

  const page = await requestJson(`${a.baseUrl}/admin`, { headers: { authorization: 'Bearer adm-secret' } });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('toolcall-gateway 设置'));
});

test('10. 登录：错令牌 401；对令牌下发 HttpOnly Cookie，之后免 Bearer 访问', async () => {
  const a = await startGateway({ ADMIN_TOKEN: 'adm-secret' });

  const bad = await requestJson(`${a.baseUrl}/admin/api/login`, { method: 'POST', body: { token: 'wire-rong' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.type, 'admin_unauthorized');

  const okRes = await fetch(`${a.baseUrl}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'adm-secret' }),
  });
  assert.equal(okRes.status, 200);
  const setCookie = okRes.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /tcg_admin=/);
  assert.match(setCookie, /HttpOnly/i);

  const cookie = setCookie.split(';')[0];
  const withCookie = await requestJson(`${a.baseUrl}/admin/api/settings`, { headers: { cookie } });
  assert.equal(withCookie.status, 200, withCookie.text);
  assert.equal(withCookie.text.includes('adm-secret'), false, 'Cookie 值不应出现在响应里');

  const loggedOut = await requestJson(`${a.baseUrl}/admin/api/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers.get('set-cookie') ?? '', /Max-Age=0/);
});
