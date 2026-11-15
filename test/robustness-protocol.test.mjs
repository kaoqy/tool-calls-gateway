// G8：第二轮协议健壮性（reasoning 隔离 / 原生 tool_calls 兜底 / 参数特殊字符 /
// max_tokens 别名 / 异常 SSE / 模型映射 / 网关鉴权与上游 key 覆盖 / 未知字段剥离）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startStack,
  requestJson,
  requestSse,
  concatDeltaContent,
  concatToolCallArgs,
  getDiag,
} from '../scripts/lib/harness.mjs';

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

const main = await startStack();
const mapped = await startStack({
  gwEnv: { MODEL_MAP: '{"gpt-5-codex":"mock-tool"}', DEFAULT_MODEL: 'mock-text' },
});
const overridden = await startStack({ gwEnv: { MODEL_OVERRIDE: 'mock-text' } });
const authed = await startStack({ gwEnv: { GATEWAY_API_KEY: 'gw-secret-key' } });

after(async () => {
  await main.close();
  await mapped.close();
  await overridden.close();
  await authed.close();
});

const post = (baseUrl, body, headers = {}) =>
  requestJson(`${baseUrl}/v1/chat/completions`, { method: 'POST', body, headers });

test('1. reasoning_content 单独透传：不进 content，也不被当成工具块', async () => {
  const res = await post(main.baseUrl, {
    model: 'mock-reasoning',
    messages: [{ role: 'user', content: '北京天气？' }],
    tools: [weatherTool],
  });
  assert.equal(res.status, 200, res.text);
  const msg = res.json.choices[0].message;
  assert.equal(typeof msg.reasoning_content, 'string', '应透传 reasoning_content');
  assert.ok(msg.reasoning_content.includes('fake_tool'), 'reasoning 应原样保留（含其中伪造的工具名）');
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].function.name, 'get_weather', '只能解析 content 里的真工具');
  assert.equal(msg.tool_calls[0].function.name === 'fake_tool', false, 'reasoning 里的假工具不得被解析');
  assert.equal(msg.content, null);
  assert.equal(res.json.choices[0].finish_reason, 'tool_calls');
});

test('2. 流式 reasoning：delta.reasoning_content 与 content/tool_calls 三条通道互不污染', async () => {
  const { status, events } = await requestSse(`${main.baseUrl}/v1/chat/completions`, {
    body: {
      model: 'mock-stream_reasoning',
      stream: true,
      messages: [{ role: 'user', content: '北京天气？' }],
      tools: [weatherTool],
    },
  });
  assert.equal(status, 200);
  let reasoning = '';
  for (const evt of events) {
    const delta = evt.json?.choices?.[0]?.delta ?? {};
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
  }
  assert.ok(reasoning.includes('fake_tool'), '流式 reasoning 应保留原文');
  assert.equal(concatDeltaContent(events), '', 'content 通道不应包含 reasoning 或工具块');
  const calls = concatToolCallArgs(events);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'get_weather');
  assert.equal(calls[0].arguments, '{"city":"北京"}');
  assert.equal(events.at(-1).data, '[DONE]');
});

test('3. 上游原生 tool_calls（非流式）→ 直接转换，不二次包裹', async () => {
  const res = await post(main.baseUrl, {
    model: 'mock-native',
    messages: [{ role: 'user', content: '北京天气？' }],
    tools: [weatherTool],
  });
  assert.equal(res.status, 200, res.text);
  const choice = res.json.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.tool_calls[0].id, 'call_native_001', '原生 id 应保留');
  assert.equal(choice.message.tool_calls[0].type, 'function');
  assert.equal(choice.message.tool_calls[0].function.name, 'get_weather');
  assert.equal(choice.message.tool_calls[0].function.arguments, '{"city":"北京"}');
  assert.equal(choice.message.content, null);
});

test('4. 上游原生 tool_calls（流式）→ 合成流里仍是标准分片', async () => {
  const { status, events } = await requestSse(`${main.baseUrl}/v1/chat/completions`, {
    body: {
      model: 'mock-stream_native',
      stream: true,
      messages: [{ role: 'user', content: '北京天气？' }],
      tools: [weatherTool],
    },
  });
  assert.equal(status, 200);
  const calls = concatToolCallArgs(events);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'call_native_001');
  assert.equal(calls[0].arguments, '{"city":"北京"}');
  const finish = events.find((e) => e.json?.choices?.[0]?.finish_reason);
  assert.equal(finish.json.choices[0].finish_reason, 'tool_calls');
  assert.equal(events.at(-1).data, '[DONE]');
});

test('5. 参数特殊字符：中文/emoji/引号/反斜杠/超长(>2KB)/深层嵌套 全部原样往返', async () => {
  const res = await post(main.baseUrl, {
    model: 'mock-tricky',
    messages: [{ role: 'user', content: '回显这些参数' }],
    tools: [weatherTool],
  });
  assert.equal(res.status, 200, res.text);
  const raw = res.json.choices[0].message.tool_calls[0].function.arguments;
  assert.equal(typeof raw, 'string');
  const args = JSON.parse(raw);
  assert.equal(args.city, '北京🌤');
  assert.ok(args.note.includes('"你好"'), '双引号应保留');
  assert.ok(args.note.includes('\\'), '反斜杠应保留');
  assert.equal(args.long.length, 2500, '超长字符串应完整');
  assert.equal(args.nested.a[2].b[2].c, '深');
  assert.deepEqual(args.nested.d.e.f, ['中文键值', true, null]);
});

test('6. max_tokens / max_completion_tokens / max_output_tokens 归一化到上游 max_tokens', async () => {
  const cases = [
    { field: 'max_completion_tokens', value: 321 },
    { field: 'max_output_tokens', value: 654 },
    { field: 'max_tokens', value: 12 },
  ];
  for (const { field, value } of cases) {
    const res = await post(main.baseUrl, {
      model: 'mock-tool',
      messages: [{ role: 'user', content: 'x' }],
      tools: [weatherTool],
      [field]: value,
    });
    assert.equal(res.status, 200, res.text);
    const diag = await getDiag(main);
    assert.equal(diag.lastRequest.max_tokens, value, `${field} 应被映射为 max_tokens=${value}`);
    if (field !== 'max_tokens') {
      assert.ok(!diag.lastRequest.keys.includes(field), `上游 body 不应保留 ${field}`);
    }
  }
});

test('7. 异常 SSE 框架（无空格 data:/跨行事件/注释/小写 [done]）仍能正确解析', async () => {
  const { status, events, raw } = await requestSse(`${main.baseUrl}/v1/chat/completions`, {
    body: {
      model: 'mock-weird_sse',
      stream: true,
      messages: [{ role: 'user', content: 'x' }],
      tools: [weatherTool],
    },
  });
  assert.equal(status, 200, raw.slice(0, 300));
  assert.equal(concatDeltaContent(events), MOCK_TEXT);
  assert.equal(events.at(-1).data, '[DONE]', '网关合成的流必须以标准 [DONE] 结尾');
});

test('8. MODEL_MAP 生效；未命中回落 DEFAULT_MODEL，响应 model 为实际上游模型', async () => {
  const hit = await post(mapped.baseUrl, {
    model: 'gpt-5-codex',
    messages: [{ role: 'user', content: '北京天气？' }],
    tools: [weatherTool],
  });
  assert.equal(hit.status, 200, hit.text);
  assert.equal(hit.json.model, 'mock-tool', '响应里的 model 应是映射后的上游模型');
  assert.equal(hit.json.choices[0].finish_reason, 'tool_calls');
  assert.equal((await getDiag(mapped)).lastRequest.model, 'mock-tool');

  const miss = await post(mapped.baseUrl, {
    model: 'some-unknown-model',
    messages: [{ role: 'user', content: '你好' }],
    tools: [weatherTool],
  });
  assert.equal(miss.status, 200, miss.text);
  assert.equal((await getDiag(mapped)).lastRequest.model, 'mock-text', '未命中应回落 DEFAULT_MODEL');
  assert.equal(miss.json.model, 'mock-text');
});

test('9. MODEL_OVERRIDE 硬覆盖一切模型名', async () => {
  const res = await post(overridden.baseUrl, {
    model: 'gpt-5-codex',
    messages: [{ role: 'user', content: '北京天气？' }],
    tools: [weatherTool],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal((await getDiag(overridden)).lastRequest.model, 'mock-text');
  assert.equal(res.json.choices[0].finish_reason, 'stop');
});

test('10. GATEWAY_API_KEY 鉴权：无 key/错 key → 401，正确 key → 放行', async () => {
  const body = { model: 'mock-tool', messages: [{ role: 'user', content: 'x' }], tools: [weatherTool] };

  const none = await post(authed.baseUrl, body);
  assert.equal(none.status, 401, none.text);
  assert.equal(none.json.error.type, 'invalid_api_key');

  const wrong = await post(authed.baseUrl, body, { authorization: 'Bearer nope' });
  assert.equal(wrong.status, 401);

  const ok = await post(authed.baseUrl, body, { authorization: 'Bearer gw-secret-key' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.choices[0].finish_reason, 'tool_calls');

  // /v1/models 同样受保护
  const models = await requestJson(`${authed.baseUrl}/v1/models`);
  assert.equal(models.status, 401);
  const modelsOk = await requestJson(`${authed.baseUrl}/v1/models`, {
    headers: { authorization: 'Bearer gw-secret-key' },
  });
  assert.equal(modelsOk.status, 200);
});

test('11. 客户端自带 key 会被上游 key 覆盖；上游看不到客户端 key', async () => {
  const res = await post(
    main.baseUrl,
    { model: 'mock-tool', messages: [{ role: 'user', content: 'x' }], tools: [weatherTool] },
    { authorization: 'Bearer sk-client-side-secret-123' },
  );
  assert.equal(res.status, 200, res.text);
  const diag = await getDiag(main);
  assert.ok(diag.lastRequest.authPrefix.startsWith('Bearer sk-te'), `上游应收到网关的 key，实际 ${diag.lastRequest.authPrefix}`);
  assert.equal(diag.lastRequest.authPrefix.includes('client-side'), false, '不得把客户端 key 转给上游');
});

test('12. 未知字段/工具字段不进上游 body；usage 与 finish_reason 正确', async () => {
  const res = await requestSse(`${main.baseUrl}/v1/chat/completions`, {
    body: {
      model: 'mock-stream_tool',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: '北京天气？' }],
      tools: [weatherTool],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      response_format: { type: 'json_object' },
      logprobs: true,
      custom_field: 'x',
    },
  });
  assert.equal(res.status, 200, res.text);

  const diag = await getDiag(main);
  for (const key of [
    'tools',
    'tool_choice',
    'functions',
    'function_call',
    'parallel_tool_calls',
    'response_format',
    'logprobs',
    'custom_field',
  ]) {
    assert.equal(diag.lastRequest.keys.includes(key), false, `上游 body 不应包含 ${key}`);
  }
  assert.deepEqual(diag.lastRequest.keys, ['messages', 'model', 'stream', 'stream_options'].sort());

  const usageChunk = res.events.find((e) => e.json?.usage && Array.isArray(e.json.choices) && e.json.choices.length === 0);
  assert.ok(usageChunk, 'include_usage 时应补 usage chunk');
  assert.equal(usageChunk.json.usage.total_tokens, 18);
  const finish = res.events.find((e) => e.json?.choices?.[0]?.finish_reason);
  assert.equal(finish.json.choices[0].finish_reason, 'tool_calls');
});
