// G2：请求改写 + 提示注入（纯函数 buildUpstreamRequest）。
// 覆盖：单工具注入 / assistant.tool_calls / tool 消息 / 连续 tool 合并 / 多 system 合并 /
//       tool_choice 追加句 / 上游 body 无 tools 等字段 / 采样参数透传。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpstreamRequest, normalizeTools, flattenMessages } from '../src/prompt.mjs';

const cfg = {
  upstreamBaseUrl: 'http://upstream.test',
  upstreamApiKey: 'sk-test-key',
  defaultModel: 'deepseek-chat',
  toolMode: 'auto',
};

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询指定城市天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名' } },
      required: ['city'],
    },
  },
};

const timeTool = {
  type: 'function',
  function: {
    name: 'get_time',
    description: '获取当前时间',
    parameters: { type: 'object', properties: { timezone: { type: 'string' } } },
  },
};

const toolsJsonFor = (tool) => JSON.stringify(normalizeTools({ tools: [tool] }), null, 2);

const EXPECTED_SYSTEM_SINGLE = `你是一个可以调用外部工具的智能助手。你可以通过「工具调用」来执行操作或获取信息。

# 可用工具
<tools>
${toolsJsonFor(weatherTool)}
</tools>

# 工具调用格式（必须严格遵守）
当需要调用工具时，只输出如下格式的工具调用块，不要输出多余内容：

<tool_call>
{"name": "工具名", "arguments": {符合该工具 parameters 的 JSON 对象}}
</tool_call>

规则：
1. 一次要调用几个工具，就输出几个 <tool_call> 块（可并列多个）。
2. arguments 必须是合法 JSON 对象，键名与工具 parameters 的 schema 一致。
3. 不要把 <tool_call> 放进 markdown 代码块里，不要在块内写注释或额外文字。
4. 不需要调用工具时，直接用自然语言回答用户，且不要输出 <tool_call>。
5. 只能使用上面列出的工具名，禁止编造工具。
6. 收到「工具结果」后，据此继续任务；若已无需再调用工具，直接给出最终答案（纯文本）。

# 历史约定
历史中 assistant 的 <tool_call> 表示你之前发起的调用；<tool_result> 是工具返回结果。`;

test('1. 单工具注入：system 逐字包含完整模板与工具 JSON', () => {
  const { body, url, simulated } = buildUpstreamRequest(
    { model: 'mock-tool', messages: [{ role: 'user', content: '北京天气？' }], tools: [weatherTool] },
    cfg,
  );
  assert.equal(simulated, true);
  assert.equal(url, 'http://upstream.test/v1/chat/completions');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, EXPECTED_SYSTEM_SINGLE);
  assert.ok(body.messages[0].content.includes('<tools>'));
  assert.ok(body.messages[0].content.includes('"name": "get_weather"'));
  assert.ok(body.messages[0].content.includes('禁止编造工具'));
  assert.deepEqual(body.messages[1], { role: 'user', content: '北京天气？' });
});

test('2. assistant.tool_calls → assistant 文本里的 <tool_call> 块', () => {
  const { body } = buildUpstreamRequest(
    {
      model: 'mock-tool',
      messages: [
        { role: 'user', content: '北京天气？' },
        {
          role: 'assistant',
          content: '让我查一下。',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"北京"}' },
            },
          ],
        },
      ],
      tools: [weatherTool],
    },
    cfg,
  );
  const assistant = body.messages.find((m) => m.role === 'assistant');
  assert.equal(
    assistant.content,
    '让我查一下。\n<tool_call>{"name":"get_weather","arguments":{"city":"北京"}}</tool_call>',
  );
});

test('3. tool 消息 → user 里的 <tool_result tool_call_id=... name=...>', () => {
  const { body } = buildUpstreamRequest(
    {
      model: 'mock-tool',
      messages: [
        { role: 'user', content: '北京天气？' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_bj', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_bj', content: '晴，25°C' },
      ],
      tools: [weatherTool],
    },
    cfg,
  );
  const userMsgs = body.messages.filter((m) => m.role === 'user');
  const last = userMsgs.at(-1);
  assert.equal(
    last.content,
    '<tool_result tool_call_id="call_bj" name="get_weather">\n晴，25°C\n</tool_result>',
  );
});

test('4. 连续多个 tool 消息合并为一条 user', () => {
  const { body } = buildUpstreamRequest(
    {
      model: 'mock-tool',
      messages: [
        { role: 'user', content: '两个都查' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
            { id: 'c2', type: 'function', function: { name: 'get_time', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: '晴' },
        { role: 'tool', tool_call_id: 'c2', content: '12:00' },
      ],
      tools: [weatherTool, timeTool],
    },
    cfg,
  );
  const toolResultMsgs = body.messages.filter((m) => m.role === 'user' && m.content.includes('<tool_result'));
  assert.equal(toolResultMsgs.length, 1, '应当只有一条合并后的 user 消息');
  assert.equal(toolResultMsgs[0].role, 'user');
  assert.equal(
    toolResultMsgs[0].content,
    '<tool_result tool_call_id="c1" name="get_weather">\n晴\n</tool_result>\n' +
      '<tool_result tool_call_id="c2" name="get_time">\n12:00\n</tool_result>',
  );
  // 不允许出现连续两条 user
  for (let i = 1; i < body.messages.length; i += 1) {
    assert.ok(
      !(body.messages[i].role === 'user' && body.messages[i - 1].role === 'user'),
      `第 ${i} 条与前一条都是 user`,
    );
  }
});

test('5. 多段 system（含 developer）合并为一条 system，且排在模板之前', () => {
  const { body } = buildUpstreamRequest(
    {
      model: 'mock-tool',
      messages: [
        { role: 'system', content: '你是一个严谨的助手。' },
        { role: 'developer', content: '你很简洁。' },
        { role: 'user', content: '北京天气？' },
      ],
      tools: [weatherTool],
    },
    cfg,
  );
  const systems = body.messages.filter((m) => m.role === 'system');
  assert.equal(systems.length, 1, '只能有一条 system');
  assert.ok(systems[0].content.startsWith('你是一个严谨的助手。\n\n你很简洁。\n\n你是一个可以调用外部工具的智能助手。'));
  assert.equal(body.messages.filter((m) => m.role === 'user').length, 1);
});

test('6. tool_choice = required / {name:X} / none 追加对应句子，auto 不追加', () => {
  const base = { model: 'mock-tool', messages: [{ role: 'user', content: '查' }], tools: [weatherTool] };
  const sysOf = (tc) => buildUpstreamRequest({ ...base, tool_choice: tc }, cfg).body.messages[0].content;

  const auto = sysOf('auto');
  assert.equal(auto, EXPECTED_SYSTEM_SINGLE, 'auto 不应追加任何后缀');

  const required = sysOf('required');
  assert.ok(required.endsWith('\n\n【强制】本轮你必须至少调用一次工具，请立即输出 <tool_call>。'));

  const any = sysOf('any');
  assert.equal(any, required, 'any 与 required 等价');

  const named = sysOf({ type: 'function', function: { name: 'get_weather' } });
  assert.ok(named.endsWith('\n\n【强制】本轮你必须调用工具 "get_weather"，请立即输出对应的 <tool_call>。'));

  const none = sysOf('none');
  assert.ok(none.endsWith('\n\n【约束】本轮禁止调用工具，请直接用自然语言回答。'));
});

test('7. 上游 body 中不含 tools / tool_choice / functions / function_call / parallel_tool_calls / response_format', () => {
  const { body } = buildUpstreamRequest(
    {
      model: 'mock-tool',
      messages: [{ role: 'user', content: '查询' }],
      tools: [weatherTool],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      functions: [{ name: 'legacy_fn', description: '旧式', parameters: { type: 'object', properties: {} } }],
      function_call: 'auto',
      response_format: { type: 'json_object' },
      unknown_field: 'x',
    },
    cfg,
  );
  for (const key of ['tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls', 'response_format', 'unknown_field']) {
    assert.equal(Object.prototype.hasOwnProperty.call(body, key), false, `body 不应包含 ${key}`);
  }
  // 旧式 functions 会被转换成工具描述写进 system
  assert.ok(body.messages[0].content.includes('legacy_fn'));
});

test('8. model / temperature / max_tokens 等字段透传，stream 保持', () => {
  const { body } = buildUpstreamRequest(
    {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [weatherTool],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 256,
      stop: ['\n\n'],
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      seed: 42,
      stream: true,
      stream_options: { include_usage: true },
      n: 2,
    },
    cfg,
  );
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.temperature, 0.7);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.max_tokens, 256);
  assert.deepEqual(body.stop, ['\n\n']);
  assert.equal(body.presence_penalty, 0.1);
  assert.equal(body.frequency_penalty, 0.2);
  assert.equal(body.seed, 42);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.n, undefined, 'n 不在白名单内');
});

test('9. 无 tools 请求：simulated=false，body 原样透传', () => {
  const input = {
    model: 'mock-text',
    messages: [{ role: 'user', content: '你好' }],
    temperature: 0.5,
    response_format: { type: 'text' },
  };
  const { body, simulated } = buildUpstreamRequest(input, cfg);
  assert.equal(simulated, false);
  assert.deepEqual(body, input);
});

test('10. 历史归一化边界：arguments 非法 JSON 原样嵌入、缺 name 时留空、空 tool_calls 不产生块', () => {
  const [assistant] = flattenMessages([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{not json' } }],
    },
  ]);
  assert.equal(assistant.content, '<tool_call>{"name":"f","arguments":"{not json"}</tool_call>');

  const afterEmpty = flattenMessages([
    { role: 'assistant', content: '纯文本', tool_calls: [] },
    { role: 'tool', content: 'orphan', tool_call_id: 'missing' },
  ]);
  assert.equal(afterEmpty[0].content, '纯文本');
  assert.equal(afterEmpty[1].role, 'user');
  assert.ok(afterEmpty[1].content.startsWith('<tool_result tool_call_id="missing" name="">'));
});
