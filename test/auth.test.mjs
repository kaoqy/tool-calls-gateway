// 管理员账号 / 会话 / 登录节流的单元测试（纯内存 + 临时文件，不起 HTTP）。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AuthError,
  clearCookie,
  createAuthStore,
  createLoginLimiter,
  createSessionStore,
  isSecureRequest,
  readCookie,
  sessionCookie,
  validatePassword,
  validateUsername,
  SESSION_COOKIE,
} from '../src/auth.mjs';

const silent = { info() {}, warn() {}, error() {} };

function tmpAuthFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-auth-'));
  return { dir, file: path.join(dir, 'auth.json') };
}

test('1. 未初始化 → configured() false；create 后 true 且返回用户名', () => {
  const { file } = tmpAuthFile();
  const store = createAuthStore({ filePath: file, logger: silent });
  assert.equal(store.configured(), false);
  assert.equal(store.summary().configured, false);
  const summary = store.create({ username: 'admin', password: 'correct-horse' });
  assert.equal(summary.username, 'admin');
  assert.equal(store.configured(), true);
});

test('2. 密码不落明文，只有 salt + scrypt hash（0600）', () => {
  const { file } = tmpAuthFile();
  const store = createAuthStore({ filePath: file, logger: silent });
  store.create({ username: 'admin', password: 'correct-horse' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('correct-horse'), false, '不得出现明文口令');
  const doc = JSON.parse(raw);
  assert.ok(doc.salt.length >= 32);
  assert.equal(doc.hash.length, 128, 'scrypt 64 字节 → 128 hex');
  assert.match(doc.algo, /scrypt/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('3. 同一口令两次初始化 → 不同 salt/hash（加盐生效）', () => {
  const a = tmpAuthFile();
  const b = tmpAuthFile();
  const s1 = createAuthStore({ filePath: a.file, logger: silent });
  const s2 = createAuthStore({ filePath: b.file, logger: silent });
  s1.create({ username: 'admin', password: 'same-password' });
  s2.create({ username: 'admin', password: 'same-password' });
  const d1 = JSON.parse(fs.readFileSync(a.file, 'utf8'));
  const d2 = JSON.parse(fs.readFileSync(b.file, 'utf8'));
  assert.notEqual(d1.salt, d2.salt);
  assert.notEqual(d1.hash, d2.hash);
});

test('4. 校验：对的口令通过，错口令/错用户名都不通过', () => {
  const { file } = tmpAuthFile();
  const store = createAuthStore({ filePath: file, logger: silent });
  store.create({ username: 'admin', password: 'correct-horse' });
  assert.equal(store.verify({ username: 'admin', password: 'correct-horse' }), true);
  assert.equal(store.verify({ username: 'admin', password: 'wrong' }), false);
  assert.equal(store.verify({ username: 'root', password: 'correct-horse' }), false);
  assert.equal(store.verify({ username: '', password: '' }), false);
});

test('5. 重复初始化被拒（409），不会覆盖已有账号', () => {
  const { file } = tmpAuthFile();
  const store = createAuthStore({ filePath: file, logger: silent });
  store.create({ username: 'admin', password: 'correct-horse' });
  assert.throws(
    () => store.create({ username: 'hacker', password: 'whatever-123' }),
    (err) => err instanceof AuthError && err.status === 409,
  );
  assert.equal(store.verify({ username: 'admin', password: 'correct-horse' }), true);
  assert.equal(store.verify({ username: 'hacker', password: 'whatever-123' }), false);
});

test('6. 用户名/口令规则：太短、非法字符都给可读错误', () => {
  assert.equal(validateUsername('  admin  '), 'admin');
  assert.equal(validateUsername('管理员'), '管理员');
  assert.throws(() => validateUsername(''), /用户名/);
  assert.throws(() => validateUsername('a'), /2~32/);
  assert.throws(() => validateUsername('bad name'), /2~32/);
  assert.throws(() => validatePassword('short'), /至少 8 位/);
  assert.throws(() => validatePassword('x'.repeat(201)), /最多 200/);
  assert.equal(validatePassword('x'.repeat(8)).length, 8);
});

test('7. 改密码：旧口令失效、新口令生效；错旧口令 401', () => {
  const { file } = tmpAuthFile();
  const store = createAuthStore({ filePath: file, logger: silent });
  store.create({ username: 'admin', password: 'old-password' });
  assert.throws(
    () => store.changePassword({ currentPassword: 'nope', newPassword: 'brand-new-password' }),
    (err) => err instanceof AuthError && err.status === 401,
  );
  store.changePassword({ currentPassword: 'old-password', newPassword: 'brand-new-password' });
  assert.equal(store.verify({ username: 'admin', password: 'old-password' }), false);
  assert.equal(store.verify({ username: 'admin', password: 'brand-new-password' }), true);
});

test('8. 文件被外部删除 → configured() 立刻变 false（可重新初始化）', () => {
  const { file } = tmpAuthFile();
  const store = createAuthStore({ filePath: file, logger: silent });
  store.create({ username: 'admin', password: 'correct-horse' });
  assert.equal(store.configured(), true);
  fs.rmSync(file);
  assert.equal(store.configured(), false);
});

test('9. 会话：签发/校验/撤销/TTL 过期', () => {
  let now = 1000;
  const sessions = createSessionStore({ ttlMs: 5000, now: () => now });
  const token = sessions.issue('admin', { ip: '127.0.0.1' });
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 40);
  assert.equal(sessions.verify(token).username, 'admin');
  now += 4999;
  assert.ok(sessions.verify(token), '未到 TTL 仍然有效');
  now += 2;
  assert.equal(sessions.verify(token), null, '超过 TTL 失效');
  const t2 = sessions.issue('admin');
  assert.equal(sessions.revoke(t2), true);
  assert.equal(sessions.verify(t2), null);
  assert.equal(sessions.verify('forged-token'), null);
  assert.equal(sessions.verify(''), null);
});

test('10. 会话：revokeAll 让所有旧会话失效（改密码场景）', () => {
  const sessions = createSessionStore({});
  const a = sessions.issue('admin');
  const b = sessions.issue('admin');
  assert.equal(sessions.size(), 2);
  assert.equal(sessions.revokeAll(), 2);
  assert.equal(sessions.verify(a), null);
  assert.equal(sessions.verify(b), null);
});

test('11. 会话令牌不可预测（随机 32 字节）', () => {
  const sessions = createSessionStore({});
  const tokens = new Set();
  for (let i = 0; i < 200; i += 1) tokens.add(sessions.issue('admin'));
  assert.equal(tokens.size, 200);
  for (const t of tokens) assert.ok(Buffer.from(t, 'base64url').length >= 32);
});

test('12. 登录节流：5 次失败后阻塞，窗口过后恢复，成功清零', () => {
  let now = 0;
  const limiter = createLoginLimiter({ max: 5, windowMs: 1000, now: () => now });
  assert.equal(limiter.check('1.1.1.1').blocked, false);
  for (let i = 0; i < 5; i += 1) limiter.fail('1.1.1.1');
  assert.equal(limiter.check('1.1.1.1').blocked, true);
  assert.equal(limiter.check('2.2.2.2').blocked, false, '按来源隔离');
  now += 1001;
  assert.equal(limiter.check('1.1.1.1').blocked, false, '窗口过后自动恢复');
  limiter.fail('1.1.1.1');
  limiter.reset('1.1.1.1');
  assert.equal(limiter.check('1.1.1.1').remaining, 5);
});

test('13. Cookie：HttpOnly + SameSite + Path；https 下带 Secure；清除为 Max-Age=0', () => {
  const c = sessionCookie('tok123', { ttlMs: 3600_000 });
  assert.match(c, new RegExp(`^${SESSION_COOKIE}=tok123`));
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=3600/);
  assert.equal(/Secure/.test(c), false, '明文 http 下不加 Secure');
  assert.match(sessionCookie('t', { secure: true }), /Secure/);
  assert.match(clearCookie(), /Max-Age=0/);
});

test('14. readCookie：多 cookie 混杂、URL 编码、缺失都正确', () => {
  assert.equal(readCookie('a=1; tcg_sess=abc; b=2', 'tcg_sess'), 'abc');
  assert.equal(readCookie('tcg_sess=abc', 'tcg_sess'), 'abc');
  assert.equal(readCookie('tcg_sess=a%2Bb', 'tcg_sess'), 'a+b');
  assert.equal(readCookie('', 'tcg_sess'), '');
  assert.equal(readCookie(undefined, 'tcg_sess'), '');
  assert.equal(readCookie('other=1', 'tcg_sess'), '');
});

test('15. isSecureRequest：X-Forwarded-Proto 判定', () => {
  assert.equal(isSecureRequest({ headers: {} }), false);
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'HTTPS, http' } }), true);
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'http' } }), false);
});

test('16. 哈希耗时合理（scrypt 不是明文比较，也不至于卡住登录）', () => {
  const { file } = tmpAuthFile();
  const store = createAuthStore({ filePath: file, logger: silent });
  const started = Date.now();
  store.create({ username: 'admin', password: 'correct-horse' });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `scrypt 初始化耗时 ${elapsed}ms，应远小于 1s`);
  assert.ok(elapsed > 0);
});

test('17. 损坏的 auth.json 不崩溃（视为未初始化）', () => {
  const { file } = tmpAuthFile();
  fs.writeFileSync(file, '{ this is not json');
  const store = createAuthStore({ filePath: file, logger: silent });
  assert.equal(store.configured(), false);
  store.create({ username: 'admin', password: 'correct-horse' });
  assert.equal(store.configured(), true);
});

test('18. token 签发用 crypto 随机源（与 Math.random 无关）', () => {
  const sessions = createSessionStore({});
  const spy = crypto.randomBytes;
  let calls = 0;
  crypto.randomBytes = (...args) => {
    calls += 1;
    return spy(...args);
  };
  try {
    sessions.issue('admin');
  } finally {
    crypto.randomBytes = spy;
  }
  assert.equal(calls, 1);
});
