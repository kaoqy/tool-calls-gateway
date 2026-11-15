// 首次初始化 + 账号登录 + 热生效的端到端测试：真实起 mock 上游与网关进程。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getFreePort, startProcess, stopProcess, waitForHealth, requestJson } from '../scripts/lib/harness.mjs';

const tmpDirs = [];
const children = [];

function newDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-admin-'));
  tmpDirs.push(dir);
  return dir;
}

async function startMock(label) {
  const port = await getFreePort();
  const child = startProcess(`mock-${label}`, 'mock/upstream.mjs', { env: { PORT: String(port) } });
  children.push(child);
  await waitForHealth(`http://127.0.0.1:${port}/healthz`);
  return { url: `http://127.0.0.1:${port}`, diag: () => requestJson(`http://127.0.0.1:${port}/__diag`).then((r) => r.json) };
}

/** 默认不给任何上游 env —— 模拟"零配置部署" */
async function startGateway({ dataDir, env = {}, name = 'gw' } = {}) {
  const port = await getFreePort();
  const child = startProcess(name, 'src/server.mjs', {
    env: {
      PORT: String(port),
      TOOL_MODE: 'auto',
      LOG_LEVEL: 'warn',
      DATA_DIR: dataDir ?? newDataDir(),
      // 显式清空：本文件验证"零配置部署"，不能受 shell 里的真实上游环境影响
      UPSTREAM_BASE_URL: '',
      UPSTREAM_API_KEY: '',
      DEFAULT_MODEL: '',
      MODEL_MAP: '',
      MODEL_OVERRIDE: '',
      GATEWAY_API_KEY: '',
      ADMIN_TOKEN: '',
      ...env,
    },
  });
  children.push(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/healthz`);
  return { baseUrl, child };
}

const mockA = await startMock('a');
const mockB = await startMock('b');

after(async () => {
  for (const child of children) stopProcess(child);
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const chatWithTools = (baseUrl, model = 'mock-tool', headers = {}) =>
  requestJson(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
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

async function setup(baseUrl, body = {}) {
  const res = await requestJson(`${baseUrl}/admin/api/setup`, {
    method: 'POST',
    body: {
      username: 'admin',
      password: 'correct-horse',
      upstreamBaseUrl: mockA.url,
      upstreamApiKey: 'sk-ui-upstream-key',
      defaultModel: 'mock-tool',
      ...body,
    },
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  return { ...res, cookie: setCookie.split(';')[0], setCookie };
}

async function login(baseUrl, body = {}) {
  const res = await requestJson(`${baseUrl}/admin/api/login`, {
    method: 'POST',
    body: { username: 'admin', password: 'correct-horse', ...body },
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  return { ...res, cookie: setCookie.split(';')[0], setCookie };
}

const mainDir = newDataDir();
const gw = await startGateway({ dataDir: mainDir, name: 'gw-main' });

test('1. 全新实例：/admin 是初始化向导，/healthz 明确未配置', async () => {
  const page = await requestJson(`${gw.baseUrl}/admin`);
  assert.equal(page.status, 200, page.text);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.ok(page.text.includes('完成初始化'), '应渲染初始化向导');
  assert.ok(page.text.includes('id="username"'), '要有创建账号的输入框');
  assert.ok(page.text.includes('id="upstreamBaseUrl"'));
  assert.equal(/<script[^>]+src=/.test(page.text), false, '不允许外链脚本');
  assert.equal(/<link[^>]+href="http/.test(page.text), false, '不允许外链样式');

  const health = await requestJson(`${gw.baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.json.setupRequired, true);
  assert.equal(health.json.upstreamConfigured, false);

  const session = await requestJson(`${gw.baseUrl}/admin/api/session`);
  assert.equal(session.json.setupRequired, true);
  assert.equal(session.json.authenticated, false);
});

test('2. 未初始化时 /v1 返回 503 且提示去 /admin（而不是打到一个猜的地址）', async () => {
  const res = await chatWithTools(gw.baseUrl);
  assert.equal(res.status, 503, res.text);
  assert.equal(res.json.error.type, 'upstream_not_configured');
  assert.match(res.json.error.message, /\/admin/);

  const models = await requestJson(`${gw.baseUrl}/v1/models`);
  assert.equal(models.status, 503);
});

test('3. 初始化校验：缺上游 / 弱密码 / 非法用户名都被挡下', async () => {
  const noUpstream = await setup(gw.baseUrl, { upstreamBaseUrl: '' });
  assert.equal(noUpstream.status, 400, noUpstream.text);
  assert.equal(noUpstream.json.error.type, 'settings_invalid');

  const weak = await setup(gw.baseUrl, { password: '123' });
  assert.equal(weak.status, 400, weak.text);
  assert.match(weak.json.error.message, /8 位/);

  const badUser = await setup(gw.baseUrl, { username: 'a b' });
  assert.equal(badUser.status, 400, badUser.text);
  assert.equal(badUser.json.error.field, 'username');

  const badUrl = await setup(gw.baseUrl, { upstreamBaseUrl: 'ftp://nope' });
  assert.equal(badUrl.status, 400, badUrl.text);

  // 上述失败都不应产生账号
  const health = await requestJson(`${gw.baseUrl}/healthz`);
  assert.equal(health.json.setupRequired, true, '失败不应创建账号');
});

test('4. 初始化成功：201 + HttpOnly Cookie，配置立即生效', async () => {
  const res = await setup(gw.baseUrl);
  assert.equal(res.status, 201, res.text);
  assert.match(res.setCookie, /tcg_sess=/);
  assert.match(res.setCookie, /HttpOnly/i);
  assert.match(res.setCookie, /SameSite=Lax/i);
  assert.equal(res.text.includes('sk-ui-upstream-key'), false, '不得回显上游明文 key');
  assert.equal(res.json.settings.upstreamApiKey.set, true);
  assert.equal(res.json.account.username, 'admin');

  const health = await requestJson(`${gw.baseUrl}/healthz`);
  assert.equal(health.json.setupRequired, false);
  assert.equal(health.json.upstreamConfigured, true);

  const chat = await chatWithTools(gw.baseUrl);
  assert.equal(chat.status, 200, chat.text);
  assert.equal(chat.json.choices[0].message.tool_calls[0].function.name, 'get_weather');
});

test('5. 初始化后 /admin 是控制台；再次 setup → 409', async () => {
  const { cookie } = await login(gw.baseUrl);
  const page = await requestJson(`${gw.baseUrl}/admin`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('id="modelMap"'), '应渲染设置控制台');
  assert.ok(page.text.includes('保存并应用'));
  assert.ok(page.text.includes('id="account"'), '要有账号分区');

  const again = await setup(gw.baseUrl);
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.error.type, 'auth_already_setup');
});

test('6. 设置 API 需要登录：无 Cookie / 伪造 Cookie 一律 401', async () => {
  const anon = await requestJson(`${gw.baseUrl}/admin/api/settings`);
  assert.equal(anon.status, 401, anon.text);
  assert.equal(anon.json.error.type, 'admin_unauthorized');

  const forged = await requestJson(`${gw.baseUrl}/admin/api/settings`, { headers: { cookie: 'tcg_sess=forged' } });
  assert.equal(forged.status, 401);

  const page = await requestJson(`${gw.baseUrl}/admin`, { headers: { cookie: 'tcg_sess=forged' } });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('id="password"'), '未登录应给登录页');
  assert.ok(page.text.includes('登录'), '登录页要有登录按钮');
});

test('7. 登录：错密码 401（带剩余次数），对密码 200 并下发 Cookie', async () => {
  const bad = await login(gw.baseUrl, { password: 'wrong-password' });
  assert.equal(bad.status, 401, bad.text);
  assert.equal(bad.json.error.type, 'auth_bad_credentials');
  assert.equal(typeof bad.json.error.remainingAttempts, 'number');
  assert.equal((bad.headers.get('set-cookie') ?? '').includes('tcg_sess='), false, '失败不应发会话');

  const ok = await login(gw.baseUrl);
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.setCookie, /tcg_sess=/);

  const view = await requestJson(`${gw.baseUrl}/admin/api/settings`, { headers: { cookie: ok.cookie } });
  assert.equal(view.status, 200, view.text);
  assert.equal(view.json.account.username, 'admin');
});

test('8. 热生效：网页改上游 → 下一个请求立即打到新上游', async () => {
  const first = await login(gw.baseUrl);
  const cookie = first.cookie;

  const before = await chatWithTools(gw.baseUrl);
  assert.equal(before.status, 200, before.text);
  const diagA1 = await mockA.diag();

  const put = await requestJson(`${gw.baseUrl}/admin/api/settings`, {
    method: 'PUT',
    headers: { cookie },
    body: { settings: { upstreamBaseUrl: mockB.url, upstreamApiKey: 'sk-switched-key' } },
  });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.sources.upstreamBaseUrl, 'file');
  assert.equal(put.text.includes('sk-switched-key'), false, '保存响应不得回显明文');

  const after = await chatWithTools(gw.baseUrl);
  assert.equal(after.status, 200, after.text);
  const diagB = await mockB.diag();
  assert.equal(diagB.lastRequest.model, 'mock-tool');
  assert.ok(diagB.lastRequest.authPrefix.startsWith('Bearer sk-'), '上游应收到新 key');

  const diagA2 = await mockA.diag();
  assert.equal(diagA2.lastRequest.model, diagA1.lastRequest.model, 'mock A 不应再收到请求');

  // 还原到 A，避免影响后续用例
  await requestJson(`${gw.baseUrl}/admin/api/settings`, {
    method: 'PUT',
    headers: { cookie },
    body: { settings: { upstreamBaseUrl: mockA.url } },
  });
});

test('9. 非法配置 / 未知字段 → 400，且不改变生效配置', async () => {
  const { cookie } = await login(gw.baseUrl);
  const bad = await requestJson(`${gw.baseUrl}/admin/api/settings`, {
    method: 'PUT',
    headers: { cookie },
    body: { settings: { upstreamBaseUrl: 'ftp://nope' } },
  });
  assert.equal(bad.status, 400, bad.text);
  assert.equal(bad.json.error.errors[0].field, 'upstreamBaseUrl');

  const unknown = await requestJson(`${gw.baseUrl}/admin/api/settings`, {
    method: 'PUT',
    headers: { cookie },
    body: { settings: { adminToken: 'x' } },
  });
  assert.equal(unknown.status, 400, unknown.text);
  assert.equal(unknown.json.error.errors[0].field, 'adminToken');

  const view = await requestJson(`${gw.baseUrl}/admin/api/settings`, { headers: { cookie } });
  assert.equal(view.json.settings.upstreamBaseUrl, mockA.url);
});

test('10. 连接测试 / 工具自检都能用', async () => {
  const { cookie } = await login(gw.baseUrl);
  const conn = await requestJson(`${gw.baseUrl}/admin/api/test`, {
    method: 'POST',
    headers: { cookie },
    body: { settings: { upstreamBaseUrl: mockA.url } },
  });
  assert.equal(conn.status, 200, conn.text);
  assert.equal(conn.json.ok, true);
  assert.ok(conn.json.models.length >= 1);

  const tool = await requestJson(`${gw.baseUrl}/admin/api/test-tool`, { method: 'POST', headers: { cookie } });
  assert.equal(tool.status, 200, tool.text);
  assert.equal(tool.json.finishReason, 'tool_calls');
  assert.equal(tool.json.toolCalls, 1);
});

test('11. 退出登录：Cookie 立即失效', async () => {
  const { cookie } = await login(gw.baseUrl);
  const out = await requestJson(`${gw.baseUrl}/admin/api/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);

  const afterLogout = await requestJson(`${gw.baseUrl}/admin/api/settings`, { headers: { cookie } });
  assert.equal(afterLogout.status, 401, afterLogout.text);
});

test('12. 改密码：旧密码 401；成功后旧会话失效、新会话可用', async () => {
  const { cookie: oldCookie } = await login(gw.baseUrl);

  const wrong = await requestJson(`${gw.baseUrl}/admin/api/password`, {
    method: 'POST',
    headers: { cookie: oldCookie },
    body: { currentPassword: 'nope', newPassword: 'brand-new-password' },
  });
  assert.equal(wrong.status, 401, wrong.text);
  assert.equal(wrong.json.error.type, 'auth_bad_credentials');

  const ok = await requestJson(`${gw.baseUrl}/admin/api/password`, {
    method: 'POST',
    headers: { cookie: oldCookie },
    body: { currentPassword: 'correct-horse', newPassword: 'brand-new-password' },
  });
  assert.equal(ok.status, 200, ok.text);
  const newCookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(newCookie, /tcg_sess=/);

  const stale = await requestJson(`${gw.baseUrl}/admin/api/settings`, { headers: { cookie: oldCookie } });
  assert.equal(stale.status, 401, '改密码应让旧会话失效');

  const fresh = await requestJson(`${gw.baseUrl}/admin/api/settings`, { headers: { cookie: newCookie } });
  assert.equal(fresh.status, 200);

  const oldPass = await login(gw.baseUrl, { password: 'correct-horse' });
  assert.equal(oldPass.status, 401, '旧密码应失效');
  const newPass = await login(gw.baseUrl, { password: 'brand-new-password' });
  assert.equal(newPass.status, 200, newPass.text);

  // 改回去，后面的用例仍用初始口令
  await requestJson(`${gw.baseUrl}/admin/api/password`, {
    method: 'POST',
    headers: { cookie: newPass.cookie },
    body: { currentPassword: 'brand-new-password', newPassword: 'correct-horse' },
  });
});

test('13. 连错 5 次 → 429 + Retry-After（按来源节流）', async () => {
  const dir = newDataDir();
  const inst = await startGateway({ dataDir: dir, name: 'gw-limit' });
  const created = await setup(inst.baseUrl);
  assert.equal(created.status, 201, created.text);
  const { cookie } = await login(inst.baseUrl);
  await requestJson(`${inst.baseUrl}/admin/api/logout`, { method: 'POST', headers: { cookie } });

  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await login(inst.baseUrl, { password: 'wrong-password' });
    assert.equal(last.status, 401);
  }
  const blocked = await login(inst.baseUrl, { password: 'correct-horse' });
  assert.equal(blocked.status, 429, blocked.text);
  assert.equal(blocked.json.error.type, 'too_many_attempts');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, '应给出 Retry-After');
});

test('14. ADMIN_TOKEN 兜底：Bearer 直接可用，无需会话', async () => {
  const dir = newDataDir();
  const inst = await startGateway({ dataDir: dir, name: 'gw-token', env: { ADMIN_TOKEN: 'adm-secret' } });
  assert.equal((await setup(inst.baseUrl)).status, 201);

  const anon = await requestJson(`${inst.baseUrl}/admin/api/settings`);
  assert.equal(anon.status, 401, '没有会话也没有令牌 → 401');

  const bearer = await requestJson(`${inst.baseUrl}/admin/api/settings`, {
    headers: { authorization: 'Bearer adm-secret' },
  });
  assert.equal(bearer.status, 200, bearer.text);
  assert.equal(bearer.text.includes('adm-secret'), false);

  const page = await requestJson(`${inst.baseUrl}/admin`, { headers: { authorization: 'Bearer adm-secret' } });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('id="modelMap"'));

  const viaLogin = await requestJson(`${inst.baseUrl}/admin/api/login`, {
    method: 'POST',
    body: { token: 'adm-secret' },
  });
  assert.equal(viaLogin.status, 200, viaLogin.text);
  assert.match(viaLogin.headers.get('set-cookie') ?? '', /tcg_sess=/);
});

test('15. 落盘审计：auth.json 无明文口令，settings.json 只含覆盖项', async () => {
  const authFile = path.join(mainDir, 'auth.json');
  const raw = fs.readFileSync(authFile, 'utf8');
  assert.equal(raw.includes('correct-horse'), false, 'auth.json 不得含明文口令');
  const doc = JSON.parse(raw);
  assert.equal(doc.username, 'admin');
  assert.equal(doc.hash.length, 128);
  if (process.platform !== 'win32') assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);

  const settingsFile = path.join(mainDir, 'settings.json');
  const settingsDoc = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settingsDoc.settings.upstreamBaseUrl, mockA.url);
  assert.equal(settingsDoc.settings.defaultModel, 'mock-tool');
  assert.ok(!('maxBodyBytes' in settingsDoc.settings), '只存覆盖项，不存默认值');
});

test('16. 换进程重启：账号与配置保留，但旧会话失效（需重新登录）', async () => {
  const { cookie: oldCookie } = await login(gw.baseUrl);
  const restarted = await startGateway({ dataDir: mainDir, name: 'gw-restart' });

  const health = await requestJson(`${restarted.baseUrl}/healthz`);
  assert.equal(health.json.setupRequired, false, '账号应持久化');
  assert.equal(health.json.upstreamConfigured, true, '上游配置应持久化');

  const stale = await requestJson(`${restarted.baseUrl}/admin/api/settings`, { headers: { cookie: oldCookie } });
  assert.equal(stale.status, 401, '会话只存内存，重启后必须重新登录');

  const page = await requestJson(`${restarted.baseUrl}/admin`);
  assert.ok(page.text.includes('id="password"'), '重启后应给登录页而不是初始化向导');

  const again = await setup(restarted.baseUrl);
  assert.equal(again.status, 409, '重启后不允许再初始化');

  const relogin = await login(restarted.baseUrl);
  assert.equal(relogin.status, 200, relogin.text);
});
