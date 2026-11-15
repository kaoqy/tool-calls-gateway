// 管理员账号：首次运行在网页里创建，凭据以 scrypt 哈希落盘（DATA_DIR/auth.json, 0600）。
//
// 设计取舍：
// - 不引入第三方库：口令哈希用 node:crypto 的 scrypt（N=16384,r=8,p=1），比对用 timingSafeEqual。
// - 会话只存内存（重启需要重新登录），避免把会话令牌写到磁盘；Cookie 是 HttpOnly + SameSite=Lax。
// - 「首次初始化」窗口：账号不存在时任何人可创建管理员（与 Jellyfin/Grafana 一致），
//   所以一旦创建就永久失效，并在启动日志/接口里明确提示这个窗口。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const USERNAME_RE = /^[\w.@\u4e00-\u9fa5-]{2,32}$/u;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;
export const SESSION_COOKIE = 'tcg_sess';
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(message, { status = 400, type = 'auth_invalid', field = '' } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.type = type;
    this.field = field;
  }
}

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
}

export function validateUsername(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new AuthError('请填写用户名', { field: 'username' });
  if (!USERNAME_RE.test(value)) {
    throw new AuthError('用户名 2~32 位，可用字母/数字/下划线/点/中划线/@/中文', { field: 'username' });
  }
  return value;
}

export function validatePassword(raw) {
  const value = String(raw ?? '');
  if (value.length < MIN_PASSWORD) throw new AuthError(`密码至少 ${MIN_PASSWORD} 位`, { field: 'password' });
  if (value.length > MAX_PASSWORD) throw new AuthError(`密码最多 ${MAX_PASSWORD} 位`, { field: 'password' });
  return value;
}

/**
 * 管理员凭据存储（磁盘 = 唯一真相源，读时带 mtime 缓存）。
 * @param {{filePath:string, logger?:object}} opts
 */
export function createAuthStore({ filePath, logger = console } = {}) {
  if (!filePath) throw new Error('createAuthStore 需要 filePath');
  let cache = null;
  let cacheStamp = null;

  function stamp() {
    try {
      const st = fs.statSync(filePath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return 'missing';
    }
  }

  function readFromDisk() {
    try {
      const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!doc || typeof doc !== 'object' || !doc.username || !doc.salt || !doc.hash) return null;
      return {
        username: String(doc.username),
        salt: String(doc.salt),
        hash: String(doc.hash),
        updatedAt: doc.updatedAt ?? null,
        createdAt: doc.createdAt ?? null,
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn?.('管理员凭据文件读取失败（可删除后重新初始化）', { message: err.message, filePath });
      }
      return null;
    }
  }

  function current() {
    const key = stamp();
    if (key !== cacheStamp) {
      cache = readFromDisk();
      cacheStamp = key;
    }
    return cache;
  }

  function write(record) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* Windows 上可能不支持，忽略 */
    }
    cacheStamp = stamp();
    cache = { username: record.username, salt: record.salt, hash: record.hash, updatedAt: record.updatedAt, createdAt: record.createdAt };
  }

  function makeRecord(username, password, createdAt = null) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = scryptHash(password, salt).toString('hex');
    const now = new Date().toISOString();
    return {
      version: 1,
      username,
      salt,
      hash,
      algo: `scrypt:N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p},keylen=${SCRYPT.keylen}`,
      createdAt: createdAt ?? now,
      updatedAt: now,
    };
  }

  return {
    filePath,
    /** 是否已经初始化过管理员账号 */
    configured() {
      return current() !== null;
    },
    summary() {
      const record = current();
      return {
        configured: Boolean(record),
        username: record?.username ?? '',
        createdAt: record?.createdAt ?? null,
        updatedAt: record?.updatedAt ?? null,
        file: filePath,
      };
    },
    /** 首次初始化：已存在则拒绝（防止被后来者覆盖） */
    create({ username, password }) {
      if (current()) throw new AuthError('管理员账号已存在，请直接登录', { status: 409, type: 'auth_already_setup' });
      const user = validateUsername(username);
      const pass = validatePassword(password);
      write(makeRecord(user, pass));
      logger.info?.('admin account created', { username: user, file: filePath });
      return this.summary();
    },
    /** 用户名 + 口令校验；用户名不匹配也走一次哈希，避免用时间差探测用户名 */
    verify({ username, password }) {
      const record = current();
      if (!record) return false;
      const pass = String(password ?? '');
      const expected = Buffer.from(record.hash, 'hex');
      const actual = scryptHash(pass, record.salt);
      const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
      const sameUser = String(username ?? '').trim() === record.username;
      return ok && sameUser;
    },
    changePassword({ currentPassword, newPassword }) {
      const record = current();
      if (!record) throw new AuthError('尚未初始化管理员账号', { status: 409, type: 'auth_not_setup' });
      if (!this.verify({ username: record.username, password: currentPassword })) {
        throw new AuthError('当前密码不正确', { status: 401, type: 'auth_bad_credentials', field: 'currentPassword' });
      }
      const pass = validatePassword(newPassword);
      write(makeRecord(record.username, pass, record.createdAt));
      logger.info?.('admin password changed', { username: record.username });
      return this.summary();
    },
  };
}

/** 内存会话：Cookie 里放随机 token，服务端只存映射。 */
export function createSessionStore({ ttlMs = DEFAULT_SESSION_TTL_MS, max = 500, now = () => Date.now() } = {}) {
  const sessions = new Map();

  function sweep() {
    const t = now();
    for (const [token, sess] of sessions) {
      if (sess.expiresAt <= t) sessions.delete(token);
    }
    while (sessions.size > max) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }

  return {
    ttlMs,
    issue(username, { ip = '' } = {}) {
      sweep();
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { username, ip, createdAt: now(), expiresAt: now() + ttlMs });
      return token;
    },
    verify(token) {
      const key = String(token ?? '').trim();
      if (!key) return null;
      const sess = sessions.get(key);
      if (!sess) return null;
      if (sess.expiresAt <= now()) {
        sessions.delete(key);
        return null;
      }
      return sess;
    },
    revoke(token) {
      return sessions.delete(String(token ?? '').trim());
    },
    /** 改密码后让其它会话失效 */
    revokeAll() {
      const n = sessions.size;
      sessions.clear();
      return n;
    },
    size() {
      sweep();
      return sessions.size;
    },
  };
}

/** 登录失败节流：同一来源 5 次/5 分钟；成功即清零。 */
export function createLoginLimiter({ max = 5, windowMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  const hits = new Map();
  function entry(key) {
    const rec = hits.get(key);
    if (!rec || rec.resetAt <= now()) {
      const fresh = { count: 0, resetAt: now() + windowMs };
      hits.set(key, fresh);
      return fresh;
    }
    return rec;
  }
  return {
    check(key) {
      const rec = entry(key);
      if (rec.count >= max) {
        return { blocked: true, retryAfterMs: Math.max(0, rec.resetAt - now()), remaining: 0 };
      }
      return { blocked: false, retryAfterMs: 0, remaining: max - rec.count };
    },
    fail(key) {
      const rec = entry(key);
      rec.count += 1;
      return { count: rec.count, retryAfterMs: Math.max(0, rec.resetAt - now()) };
    },
    reset(key) {
      hits.delete(key);
    },
    size() {
      return hits.size;
    },
  };
}

/** 从 Cookie 头取一个键 */
export function readCookie(cookieHeader, name) {
  const raw = String(cookieHeader ?? '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
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

/** 生成 Set-Cookie 值；https 前置代理下加 Secure */
export function sessionCookie(token, { ttlMs = DEFAULT_SESSION_TTL_MS, secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}
