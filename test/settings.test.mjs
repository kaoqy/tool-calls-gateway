// 设置存储单测：优先级（file > env > default）、校验、脱敏、原子落盘、重置、坏文件容错。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsStore, maskSecret, normalizePatch, SettingsValidationError } from '../src/settings.mjs';

function tmpFile(name = 'settings.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-settings-'));
  return path.join(dir, name);
}

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

test('1. 无文件时全部用 env 默认值，来源标记为 env/default', () => {
  const store = createSettingsStore({
    env: { UPSTREAM_BASE_URL: 'https://up.example/v1', UPSTREAM_API_KEY: 'sk-env-key-123456', DEFAULT_MODEL: 'm1' },
    filePath: tmpFile(),
    logger: quietLogger,
  });
  const cfg = store.get();
  assert.equal(cfg.upstreamBaseUrl, 'https://up.example/v1');
  assert.equal(cfg.defaultModel, 'm1');
  const view = store.publicView();
  assert.equal(view.sources.upstreamBaseUrl, 'env');
  assert.equal(view.sources.upstreamApiKey, 'env');
  assert.equal(view.sources.toolMode, 'default');
  assert.equal(view.meta.exists, false);
});

test('2. 密钥永远不回显明文，只给 hint', () => {
  const store = createSettingsStore({ env: { UPSTREAM_API_KEY: 'sk-abcdefghijklmnop' }, filePath: tmpFile(), logger: quietLogger });
  const view = store.publicView();
  assert.equal(view.settings.upstreamApiKey.set, true);
  assert.equal(view.settings.upstreamApiKey.hint, 'sk-***mnop');
  assert.equal(JSON.stringify(view).includes('sk-abcdefghijklmnop'), false, '公开视图不得包含明文 key');
  assert.equal(maskSecret('short'), '***');
});

test('3. update 覆盖 env 并原子落盘（0600），重置后回落 env', () => {
  const file = tmpFile();
  const store = createSettingsStore({ env: { UPSTREAM_BASE_URL: 'https://env.example' }, filePath: file, logger: quietLogger });
  store.update({ upstreamBaseUrl: 'https://ui.example', upstreamApiKey: 'sk-ui-key-99999999' });

  assert.equal(store.get().upstreamBaseUrl, 'https://ui.example');
  assert.equal(store.get().upstreamApiKey, 'sk-ui-key-99999999');
  const view = store.publicView();
  assert.equal(view.sources.upstreamBaseUrl, 'file');
  assert.equal(view.meta.exists, true);

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.settings.upstreamBaseUrl, 'https://ui.example');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `设置文件应为 0600，实际 ${mode.toString(8)}`);
  }

  // 新实例能读回
  const again = createSettingsStore({ env: { UPSTREAM_BASE_URL: 'https://env.example' }, filePath: file, logger: quietLogger });
  assert.equal(again.get().upstreamBaseUrl, 'https://ui.example');

  again.reset();
  assert.equal(again.get().upstreamBaseUrl, 'https://env.example');
  assert.equal(fs.existsSync(file), false);
});

test('4. 空字符串/null 表示取消覆盖（回落 env）', () => {
  const store = createSettingsStore({ env: { DEFAULT_MODEL: 'env-model' }, filePath: tmpFile(), logger: quietLogger });
  store.update({ defaultModel: 'ui-model' });
  assert.equal(store.get().defaultModel, 'ui-model');
  store.update({ defaultModel: '' });
  assert.equal(store.get().defaultModel, 'env-model');
  assert.equal(store.publicView().sources.defaultModel, 'env');
});

test('5. modelMap 支持 JSON 与 from:to 两种写法', () => {
  const store = createSettingsStore({ env: {}, filePath: tmpFile(), logger: quietLogger });
  store.update({ modelMap: '{"gpt-5-codex":"deepseek-chat"}' });
  assert.deepEqual(store.get().modelMap, { 'gpt-5-codex': 'deepseek-chat' });
  store.update({ modelMap: 'a:b,c:d' });
  assert.deepEqual(store.get().modelMap, { a: 'b', c: 'd' });
  store.update({ modelMap: '' });
  assert.deepEqual(store.get().modelMap, {});
});

test('6. 非法输入抛 SETTINGS_INVALID，且不写入文件', () => {
  const file = tmpFile();
  const store = createSettingsStore({ env: {}, filePath: file, logger: quietLogger });
  assert.throws(() => store.update({ upstreamBaseUrl: 'ftp://x' }), SettingsValidationError);
  assert.throws(() => store.update({ toolMode: 'yes' }), SettingsValidationError);
  assert.throws(() => store.update({ requestTimeoutMs: 10 }), SettingsValidationError);
  assert.throws(() => store.update({ nope: 1 }), SettingsValidationError);
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.get().toolMode, 'auto');

  const err = (() => {
    try {
      store.update({ requestTimeoutMs: 10 });
    } catch (e) {
      return e;
    }
    return null;
  })();
  assert.equal(err.code, 'SETTINGS_INVALID');
  assert.equal(err.errors[0].field, 'requestTimeoutMs');
});

test('7. 坏 JSON 文件不崩溃，忽略覆盖项并继续用 env', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const store = createSettingsStore({ env: { DEFAULT_MODEL: 'env-model' }, filePath: file, logger: quietLogger });
  assert.equal(store.get().defaultModel, 'env-model');
  assert.deepEqual(store.publicView().meta.activeOverrides, []);
});

test('8. normalizePatch 只接受白名单字段，并做类型归一化', () => {
  const clean = normalizePatch({
    toolMode: 'off',
    reasoningPassthrough: 'off',
    requestTimeoutMs: '5000',
    maxBodyBytes: '1048576',
  });
  assert.deepEqual(clean, {
    toolMode: 'off',
    reasoningPassthrough: false,
    requestTimeoutMs: 5000,
    maxBodyBytes: 1048576,
  });
  assert.throws(() => normalizePatch({ adminToken: 'x' }), SettingsValidationError);
});
