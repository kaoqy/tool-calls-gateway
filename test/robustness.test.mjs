// G5：健壮性与策略。
// 1) tool_choice=required 首次无工具 → 重试一次后拿到 tool_calls
// 2) 两次都没有 → 文本 finish=stop，不报错
// 3) 上游超时 → 504 + {"error":{"type":"upstream_timeout"}}
// 4) 上游 500 → 状态码与 body 透传
// 5) 缺 messages → 400
// 6) body 超 MAX_BODY_BYTES → 413
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, requestJson } from '../scripts/lib/harness.mjs';

const MOCK_TEXT =
  '这是模拟上游的纯文本回复。它用来验证网关在无工具时原样透传，在有工具时按提示词模拟工具调用并合成标准的流式分片。';

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询天气',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

// 主 stack：默认超时/上限
const main = await startStack();
// 严苛 stack：超时 700ms、body 上限 1KB
const strict = await startStack({ gwEnv: { REQUEST_TIMEOUT_MS: '700', MAX_BODY_BYTES: '1024' } });

after(async () => {
  await main.close();
  await strict.close();
});

test('1. tool_choice=required 首次未给工具 → 重试一次，最终返回 tool_calls', async () => {
  const res = await requestJson(`${main.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: {
      model: 'mock-retry_first',
      tool_choice: 'required',
      messages: [{ role: 'user', content: '北京天气？' }],
      tools: [weatherTool],
    },
  });
  assert.equal(res.status, 200, res.text);
  const choice = res.json.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.tool_calls.length, 1);
  assert.equal(choice.message.tool_calls[0].function.name, 'get_weather');
  assert.match(choice.message.tool_calls[0].id, /^call_[0-9a-f]{24}$/);
  assert.equal(choice.message.content, '好的，我来查一下。');
});

test('2. 两次都没有工具 → 按文本返回 finish=stop，不报错', async () => {
  const res = await requestJson(`${main.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: {
      model: 'mock-text',
      tool_choice: 'required',
      messages: [{ role: 'user', content: '北京天气？' }],
      tools: [weatherTool],
    },
  });
  assert.equal(res.status, 200, res.text);
  const choice = res.json.choices[0];
  assert.equal(choice.finish_reason, 'stop');
  assert.equal(choice.message.content, MOCK_TEXT);
  assert.equal('tool_calls' in choice.message, false);
});

test('3. 上游超时 → 504 upstream_timeout（OpenAI 风格错误体）', async () => {
  const res = await requestJson(`${strict.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: {
      model: 'mock-slow',
      messages: [{ role: 'user', content: '慢一点' }],
      tools: [weatherTool],
    },
  });
  assert.equal(res.status, 504, res.text);
  assert.equal(res.json.error.type, 'upstream_timeout');
  assert.equal(typeof res.json.error.message, 'string');
});

test('4. 上游 500 → 状态码与 body 原样透传', async () => {
  const res = await requestJson(`${main.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: {
      model: 'mock-error-500',
      messages: [{ role: 'user', content: '触发上游错误' }],
      tools: [weatherTool],
    },
  });
  assert.equal(res.status, 500, res.text);
  assert.ok(res.json.error, '应保留上游错误体');
  assert.equal(res.json.error.type, 'upstream_internal_error');
  assert.ok(res.json.error.message.includes('mock upstream 故意返回 500'));
});

test('5. 缺 messages → 400', async () => {
  const res = await requestJson(`${main.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'mock-text', tools: [weatherTool] },
  });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error.type, 'invalid_request_error');
  assert.ok(res.json.error.message.includes('messages'));
});

test('6. body 超 MAX_BODY_BYTES → 413', async () => {
  const res = await requestJson(`${strict.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: {
      model: 'mock-text',
      messages: [{ role: 'user', content: 'x'.repeat(4096) }],
    },
  });
  assert.equal(res.status, 413, res.text);
  assert.equal(res.json.error.type, 'payload_too_large');
});

test('7. 非法 JSON → 400', async () => {
  const res = await requestJson(`${main.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: '{not json',
  });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error.type, 'invalid_json');
});
