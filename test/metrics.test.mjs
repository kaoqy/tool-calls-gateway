// 概览指标 / 测试台 / 可观测性的单元测试（纯内存，不起服务）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics, formatDuration, mediaCountsOf } from '../src/metrics.mjs';

test('1. formatDuration：毫秒 / 秒 / 分 / 小时', () => {
  assert.equal(formatDuration(0), '0ms');
  assert.equal(formatDuration(950), '950ms');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(65_000), '1m5s');
  assert.equal(formatDuration(3_600_000), '1h');
  assert.equal(formatDuration(3_900_000), '1h5m');
});

test('2. 累计：请求数 / 成功 / 4xx / 5xx / 错误率', () => {
  const m = createMetrics();
  m.record({ status: 200, ms: 10, path: '/v1/chat/completions' });
  m.record({ status: 400, ms: 20, path: '/v1/chat/completions', errorType: 'invalid_json' });
  m.record({ status: 502, ms: 30, path: '/v1/chat/completions', errorType: 'upstream_error' });
  const s = m.summary();
  assert.equal(s.requests, 3);
  assert.equal(s.ok, 1);
  assert.equal(s.clientErrors, 1);
  assert.equal(s.serverErrors, 1);
  assert.equal(s.errorRate, 0.6667);
  assert.deepEqual(s.errorsByType, { invalid_json: 1, upstream_error: 1 });
});

test('3. 工具命中率：只按模拟请求算', () => {
  const m = createMetrics();
  m.record({ status: 200, simulated: true, toolCalls: 2 });
  m.record({ status: 200, simulated: true, toolCalls: 0 });
  m.record({ status: 200, simulated: false, toolCalls: 0 });
  const s = m.summary();
  assert.equal(s.simulated, 2);
  assert.equal(s.toolHit, 1);
  assert.equal(s.toolHitRate, 0.5);
  assert.equal(s.toolCalls, 2);
});

test('4. 媒体计数累加', () => {
  const m = createMetrics();
  m.record({ status: 200, images: 2, files: 1, audios: 0, unknownParts: 1 });
  m.record({ status: 200, images: 1 });
  const s = m.summary();
  assert.equal(s.images, 3);
  assert.equal(s.files, 1);
  assert.equal(s.audios, 0);
  assert.equal(s.unknownParts, 1);
});

test('5. 延迟分位：P50 / P95 取最近窗口', () => {
  const m = createMetrics();
  for (let i = 1; i <= 100; i += 1) m.record({ status: 200, ms: i });
  const s = m.summary();
  assert.equal(s.p50Ms, 50);
  assert.equal(s.p95Ms, 95);
});

test('6. 环形缓冲：超过容量只留最近 N 条，list 新在前', () => {
  const m = createMetrics({ capacity: 3 });
  for (let i = 1; i <= 5; i += 1) m.record({ status: 200, ms: i, path: '/v1/chat/completions' });
  const rows = m.list({ limit: 10 });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.ms), [5, 4, 3]);
  assert.equal(m.summary().requests, 5, '总数仍是 5（只是窗口只留 3 条）');
  assert.equal(m.summary().window, 3);
});

test('7. reset：清空累计与窗口', () => {
  const m = createMetrics();
  m.record({ status: 200, ms: 5 });
  m.reset();
  const s = m.summary();
  assert.equal(s.requests, 0);
  assert.equal(s.window, 0);
  assert.deepEqual(m.list(), []);
});

test('8. record 只保留白名单字段（不会把提示词/图片塞进指标）', () => {
  const m = createMetrics();
  m.record({
    status: 200,
    ms: 12,
    path: '/v1/chat/completions',
    model: 'mock-tool',
    messages: [{ role: 'user', content: '机密内容' }],
    apiKey: 'sk-secret',
    image: 'data:image/png;base64,AAAA',
  });
  const row = m.list()[0];
  assert.deepEqual(Object.keys(row).sort(), [
    'audios', 'errorType', 'files', 'finish', 'images', 'method', 'model', 'ms',
    'path', 'simulated', 'status', 'stream', 'toolCalls', 'ts', 'unknownParts',
  ]);
  assert.equal(JSON.stringify(row).includes('机密内容'), false);
  assert.equal(JSON.stringify(row).includes('sk-secret'), false);
  assert.equal(JSON.stringify(row).includes('base64'), false);
});

test('9. 非数字/非法字段被归一化，不炸', () => {
  const m = createMetrics();
  m.record({ status: 'oops', ms: 'x', toolCalls: null, images: undefined });
  const row = m.list()[0];
  assert.equal(row.status, 0);
  assert.equal(row.ms, 0);
  assert.equal(row.toolCalls, 0);
  assert.equal(row.images, 0);
});

test('10. 运行时长用注入的时钟（便于测试与 deterministic）', () => {
  let now = 1000;
  const m = createMetrics({ now: () => now });
  now += 5000;
  assert.equal(m.summary().uptimeMs, 5000);
  assert.equal(m.summary().uptime, '5.0s');
});

test('11. mediaCountsOf：从请求体里数媒体', () => {
  const counts = mediaCountsOf({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
      { role: 'user', content: [{ type: 'file', file: { filename: 'a.pdf' } }] },
    ],
  });
  assert.deepEqual(counts, { images: 1, files: 1, audios: 0, unknownParts: 0 });
});
