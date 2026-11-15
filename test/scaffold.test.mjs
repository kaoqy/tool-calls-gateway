// M0 占位 + 长期脚手架自检：配置读取、日志脱敏、SSE 编码/解析。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { encodeSse, parseSseBlock, encodeSseRaw } from '../src/sse.mjs';

test('M0: 脚手架可加载，配置有默认值', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.toolMode, 'auto');
  assert.equal(cfg.requestTimeoutMs, 60000);
  assert.equal(cfg.maxBodyBytes, 2 * 1024 * 1024);
  assert.equal(cfg.logLevel, 'info');
});

test('M0: 环境变量覆盖生效', () => {
  const cfg = loadConfig({
    PORT: '9999',
    UPSTREAM_BASE_URL: 'http://127.0.0.1:1234/',
    DEFAULT_MODEL: 'deepseek-chat',
    TOOL_MODE: 'off',
    LOG_LEVEL: 'debug',
    REQUEST_TIMEOUT_MS: '1500',
    MAX_BODY_BYTES: '1024',
  });
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.upstreamBaseUrl, 'http://127.0.0.1:1234');
  assert.equal(cfg.defaultModel, 'deepseek-chat');
  assert.equal(cfg.toolMode, 'off');
  assert.equal(cfg.logLevel, 'debug');
  assert.equal(cfg.requestTimeoutMs, 1500);
  assert.equal(cfg.maxBodyBytes, 1024);
});

test('M0: 日志不会打印 API key', () => {
  const lines = [];
  const log = createLogger({ level: 'debug', sink: { write: (s) => lines.push(s) } });
  log.info('upstream call', {
    headers: { authorization: 'Bearer sk-super-secret', 'x-other': 'ok' },
    apiKey: 'sk-raw',
  });
  const out = lines.join('');
  assert.ok(out.includes('[REDACTED]'), '应出现脱敏标记');
  assert.ok(!out.includes('sk-super-secret'), '不得出现密钥');
  assert.ok(!out.includes('sk-raw'), '不得出现密钥');
});

test('M0: SSE 编码与解析往返', () => {
  assert.equal(encodeSse({ a: 1 }), 'data: {"a":1}\n\n');
  assert.equal(encodeSseRaw('[DONE]'), 'data: [DONE]\n\n');
  assert.deepEqual(parseSseBlock('data: {"x":2}'), {
    event: null,
    data: '{"x":2}',
    id: null,
    retry: null,
  });
  assert.deepEqual(parseSseBlock('event: ping\ndata: hi'), {
    event: 'ping',
    data: 'hi',
    id: null,
    retry: null,
  });
  assert.equal(parseSseBlock(': keep-alive'), null);
});
