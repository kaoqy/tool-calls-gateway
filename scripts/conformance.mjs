// 工具调用全量矩阵：默认 dry-run（mock 确定性覆盖），--live 才打真实端点。
// 输出 out/conformance-<mode>.json + .md；FAIL 退出码 1，WARN 不影响退出码但会列出。
import {
  startStack,
  requestJson,
  requestSse,
  concatDeltaContent,
  concatToolCallArgs,
  getDiag,
  sleep,
} from './lib/harness.mjs';
import {
  parseFlags,
  loadDotEnv,
  createBudget,
  startLiveGateway,
  writeReports,
  maskSecret,
} from './lib/live.mjs';

const flags = parseFlags();
const MODE = flags.live ? 'live' : 'dry';
const LIVE = flags.live;

// 只有 live 才读 .env，避免真实模型配置污染 mock 场景
if (LIVE) loadDotEnv();
const LIVE_MODEL = process.env.LIVE_MODEL || process.env.DEFAULT_MODEL || 'deepseek-web-flash';
const MAX_LIVE_CALLS = Number.parseInt(process.env.MAX_LIVE_CALLS ?? '40', 10);
// 真实聚合网关在高频连续请求下会退化为"直接回答、不调工具"，用节流降低误判
const LIVE_DELAY_MS = Number.parseInt(process.env.LIVE_DELAY_MS ?? '1500', 10);
const budget = createBudget({ limit: MAX_LIVE_CALLS, label: `conformance-${MODE}` });

const MOCK_TEXT =
  '这是模拟上游的纯文本回复。它用来验证网关在无工具时原样透传，在有工具时按提示词模拟工具调用并合成标准的流式分片。';

const WEATHER = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询指定城市天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } },
      required: ['city'],
    },
  },
};
const TIME_TOOL = {
  type: 'function',
  function: {
    name: 'get_time',
    description: '获取指定 IANA 时区的当前时间',
    parameters: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'] },
  },
};
const ECHO_TOOL = {
  type: 'function',
  function: {
    name: 'echo_args',
    description: '原样回显参数，用于校验参数往返',
    parameters: { type: 'object', properties: { value: {} }, additionalProperties: true },
  },
};

const results = [];

// ---------------------------------------------------------------- 断言工具
function fail(msg) {
  throw new Error(msg);
}

function httpOk(res) {
  if (res.status !== 200) fail(`HTTP ${res.status}: ${maskSecret(res.text ?? '').slice(0, 300)}`);
  return res.json;
}

/** 校验非流式 chat.completion 的结构（两种 finish_reason 都必须自洽） */
function assertCompletionShape(res) {
  const j = httpOk(res);
  if (j.object !== 'chat.completion') fail(`object=${j.object}`);
  const choice = j.choices?.[0];
  if (!choice) fail('缺少 choices[0]');
  if (choice.finish_reason !== 'tool_calls' && choice.finish_reason !== 'stop') {
    fail(`finish_reason=${choice.finish_reason}`);
  }
  const msg = choice.message ?? {};
  if (msg.role !== 'assistant') fail(`message.role=${msg.role}`);
  if (msg.content !== null && typeof msg.content !== 'string') fail('message.content 类型非法');
  const calls = msg.tool_calls ?? [];
  if (choice.finish_reason === 'tool_calls') {
    if (!Array.isArray(calls) || calls.length === 0) fail('finish=tool_calls 但 tool_calls 为空');
    for (const call of calls) {
      if (typeof call.id !== 'string' || !call.id.startsWith('call_')) fail(`tool_call.id 非法: ${call.id}`);
      if (call.type !== 'function') fail(`tool_call.type=${call.type}`);
      if (!call.function?.name) fail('tool_call 缺少 function.name');
      try {
        JSON.parse(call.function.arguments);
      } catch {
        fail(`arguments 不是合法 JSON: ${String(call.function.arguments).slice(0, 120)}`);
      }
    }
    if (msg.content !== null && typeof msg.content === 'string' && msg.content.trim() === '') {
      fail('有 tool_calls 时 content 不应是空字符串（应为 null）');
    }
  } else if (typeof msg.content !== 'string') {
    fail('finish=stop 时 content 必须是字符串');
  }
  return { json: j, choice, message: msg, calls };
}

/** 校验流式响应结构 */
function assertStreamShape(res) {
  if (res.status !== 200) fail(`HTTP ${res.status}: ${maskSecret(res.text ?? '').slice(0, 300)}`);
  const events = res.events ?? [];
  if (!events.length) fail('没有收到任何 SSE 事件');
  if (events.at(-1).data !== '[DONE]') fail(`未以 data: [DONE] 结尾，实际 ${events.at(-1).data}`);
  const firstDelta = events[0].json?.choices?.[0]?.delta;
  if (firstDelta?.role !== 'assistant') fail('首个 delta 缺少 role=assistant');
  const calls = concatToolCallArgs(events);
  for (const call of calls) {
    if (!call.name) fail(`tool_call 分片缺少 name（index=${call.index}）`);
    try {
      JSON.parse(call.arguments);
    } catch {
      fail(`index=${call.index} 的 arguments 拼接后不是合法 JSON: ${String(call.arguments).slice(0, 120)}`);
    }
  }
  const finish = events.find((e) => e.json?.choices?.[0]?.finish_reason)?.json.choices[0].finish_reason;
  if (finish !== 'stop' && finish !== 'tool_calls') fail(`finish_reason=${finish}`);
  if (calls.length > 0 && finish !== 'tool_calls') fail('有 tool_calls 但 finish_reason 不是 tool_calls');
  return { events, calls, finish, content: concatDeltaContent(events) };
}

const chat = (model, extra = {}) => ({
  model,
  messages: [{ role: 'user', content: '北京今天天气怎么样？' }],
  tools: [WEATHER],
  ...extra,
});

// ---------------------------------------------------------------- 矩阵定义
// observeStrict=true：两种模式都跑，失败算 FAIL；false：仅 live 跑，失败降级 WARN
const CASES = [
  // ---------------- A 非流式
  {
    id: 'A1',
    group: 'A 非流式',
    name: '单工具 get_weather',
    mockModel: 'mock-tool',
    body: (m) => chat(m),
    check: (res) => {
      const s = assertCompletionShape(res);
      return s;
    },
    observe: (res) => res.json.choices[0].finish_reason === 'tool_calls' && res.json.choices[0].message.tool_calls[0].function.name === 'get_weather',
    warnText: '模型未返回 tool_calls（提示词模拟未命中）',
  },
  {
    id: 'A2',
    group: 'A 非流式',
    name: '并行两个工具',
    mockModel: 'mock-multi',
    body: (m) => chat(m, { tools: [WEATHER, TIME_TOOL], messages: [{ role: 'user', content: '同时告诉我北京天气和上海时间' }] }),
    check: (res) => assertCompletionShape(res),
    observe: (res) => (res.json.choices[0].message.tool_calls ?? []).length >= 2,
    warnText: '模型只给了 1 个工具调用（并行未命中）',
  },
  {
    id: 'A3',
    group: 'A 非流式',
    name: '正文 + 工具混合',
    mockModel: 'mock-tool',
    body: (m) => chat(m),
    check: (res) => assertCompletionShape(res),
    observe: (res) => typeof res.json.choices[0].message.content === 'string' && res.json.choices[0].message.content.length > 0,
    warnText: '模型没有输出块前正文（content=null）',
  },
  {
    id: 'A4',
    group: 'A 非流式',
    name: '纯文本（无 tools，走透传）',
    mockModel: 'mock-text',
    body: (m) => ({ model: m, messages: [{ role: 'user', content: '用一句话介绍你自己' }] }),
    check: (res) => {
      const s = assertCompletionShape(res);
      if (s.choice.finish_reason !== 'stop') fail('无 tools 的请求应 finish=stop');
      if ((s.message.tool_calls ?? []).length) fail('无 tools 的请求不应有 tool_calls');
      if (!s.message.content?.trim()) fail('content 为空');
      return s;
    },
  },
  {
    id: 'A5',
    group: 'A 非流式',
    name: 'tool_choice=auto',
    mockModel: 'mock-tool',
    body: (m) => chat(m, { tool_choice: 'auto' }),
    check: (res) => assertCompletionShape(res),
    observe: (res) => res.json.choices[0].finish_reason === 'tool_calls',
    warnText: 'auto 下模型选择直接回答（允许）',
  },
  {
    id: 'A6',
    group: 'A 非流式',
    name: 'tool_choice=required',
    mockModel: 'mock-tool',
    body: (m) => chat(m, { tool_choice: 'required' }),
    check: (res) => assertCompletionShape(res),
    observe: (res) => res.json.choices[0].finish_reason === 'tool_calls',
    warnText: 'required 下仍未调用工具（已重试一次）',
    strictInDry: true,
  },
  {
    id: 'A7',
    group: 'A 非流式',
    name: 'tool_choice=none',
    mockModel: 'mock-text',
    body: (m) => chat(m, { tool_choice: 'none' }),
    check: (res) => assertCompletionShape(res),
    strictInDry: true,
    observe: (res) => {
      const c = res.json.choices[0];
      return c.finish_reason === 'stop' && (c.message.tool_calls ?? []).length === 0;
    },
    warnText: 'none 下模型仍然调用了工具',
  },
  {
    id: 'A8',
    group: 'A 非流式',
    name: 'tool_choice={name:get_weather}',
    mockModel: 'mock-tool',
    body: (m) => chat(m, { tool_choice: { type: 'function', function: { name: 'get_weather' } } }),
    check: (res) => assertCompletionShape(res),
    observe: (res) => {
      const calls = res.json.choices[0].message.tool_calls ?? [];
      return calls.length > 0 && calls[0].function.name === 'get_weather';
    },
    warnText: '指定工具未被命中',
  },
  {
    id: 'A9',
    group: 'A 非流式',
    name: '参数为空（arguments 缺省 → "{}"）',
    mockModel: 'mock-emptyargs',
    body: (m) => chat(m, { tools: [{ type: 'function', function: { name: 'now', description: '当前时间', parameters: { type: 'object', properties: {} } } }] }),
    check: (res) => {
      const s = assertCompletionShape(res);
      const calls = s.message.tool_calls ?? [];
      if (calls.length === 0) return s; // live 下模型可能不调，交给 observe
      for (const c of calls) {
        const parsed = JSON.parse(c.function.arguments);
        if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
          fail('arguments 应序列化为 JSON 对象');
        }
      }
      return s;
    },
  },
  {
    id: 'A10',
    group: 'A 非流式',
    name: '嵌套对象 + 数组参数',
    mockModel: 'mock-tricky',
    mockOnly: true,
    body: (m) => chat(m, { tools: [ECHO_TOOL] }),
    check: (res) => {
      const s = assertCompletionShape(res);
      const args = JSON.parse(s.message.tool_calls[0].function.arguments);
      if (args.nested.a[2].b[2].c !== '深') fail('深层嵌套丢失');
      if (!Array.isArray(args.nested.d.e.f)) fail('数组丢失');
      return s;
    },
  },
  {
    id: 'A11',
    group: 'A 非流式',
    name: '中文 + emoji 参数',
    mockModel: 'mock-tricky',
    mockOnly: true,
    body: (m) => chat(m, { tools: [ECHO_TOOL] }),
    check: (res) => {
      const s = assertCompletionShape(res);
      const args = JSON.parse(s.message.tool_calls[0].function.arguments);
      if (args.city !== '北京🌤') fail(`emoji/中文丢失: ${args.city}`);
      return s;
    },
  },
  {
    id: 'A12',
    group: 'A 非流式',
    name: '超长参数（>2KB）',
    mockModel: 'mock-tricky',
    mockOnly: true,
    body: (m) => chat(m, { tools: [ECHO_TOOL] }),
    check: (res) => {
      const s = assertCompletionShape(res);
      const args = JSON.parse(s.message.tool_calls[0].function.arguments);
      if (args.long.length !== 2500) fail(`超长字符串长度=${args.long.length}`);
      return s;
    },
  },
  {
    id: 'A13',
    group: 'A 非流式',
    name: '块内 ```json 围栏',
    mockModel: 'mock-fenced',
    mockOnly: true,
    body: (m) => chat(m),
    check: (res) => {
      const s = assertCompletionShape(res);
      if (s.choice.finish_reason !== 'tool_calls') fail('围栏块未被解析为工具调用');
      const args = JSON.parse(s.message.tool_calls[0].function.arguments);
      if (args.city !== '上海') fail(`arguments=${s.message.tool_calls[0].function.arguments}`);
      return s;
    },
  },
  {
    id: 'A14',
    group: 'A 非流式',
    name: '大小写与空格变体 <TOOL_CALL>',
    mockModel: 'mock-variant',
    mockOnly: true,
    body: (m) => chat(m),
    check: (res) => {
      const s = assertCompletionShape(res);
      if (s.choice.finish_reason !== 'tool_calls') fail('大写标签/空格变体未被解析');
      const args = JSON.parse(s.message.tool_calls[0].function.arguments);
      if (args.city !== '广州') fail('参数解析异常');
      return s;
    },
  },
  {
    id: 'A15',
    group: 'A 非流式',
    name: '特殊字符工具名 ns.weather.v2',
    mockModel: 'mock-special_name',
    mockOnly: true,
    body: (m) => chat(m, { tools: [{ type: 'function', function: { name: 'ns.weather.v2', description: 'x', parameters: { type: 'object', properties: {} } } }] }),
    check: (res) => {
      const s = assertCompletionShape(res);
      if (s.message.tool_calls[0].function.name !== 'ns.weather.v2') fail('工具名被改写');
      return s;
    },
  },

  // ---------------- B 流式
  {
    id: 'B1',
    group: 'B 流式',
    name: '纯文本流',
    mockModel: 'mock-text',
    stream: true,
    body: (m) => chat(m, { stream: true, messages: [{ role: 'user', content: '用一句话介绍你自己，这次不要调用工具。' }] }),
    check: (res) => {
      const s = assertStreamShape(res);
      if (s.finish !== 'stop') fail(`finish=${s.finish}`);
      if (s.calls.length) fail('纯文本流不应有 tool_calls');
      if (LIVE ? false : s.content !== MOCK_TEXT) fail(`content 拼接不符: ${s.content.slice(0, 80)}`);
      return s;
    },
    observe: (res) => concatDeltaContent(res.events).length > 0,
    warnText: '流式正文为空',
  },
  {
    id: 'B2',
    group: 'B 流式',
    name: '单工具流',
    mockModel: 'mock-stream_tool',
    stream: true,
    body: (m) => chat(m, { stream: true }),
    check: (res) => assertStreamShape(res),
    observe: (res) => {
      const s = assertStreamShape(res);
      return s.finish === 'tool_calls' && s.calls.length === 1;
    },
    warnText: '流式未拿到工具调用',
  },
  {
    id: 'B3',
    group: 'B 流式',
    name: '并行工具流（index 递增）',
    mockModel: 'mock-multi',
    stream: true,
    body: (m) => chat(m, { stream: true, tools: [WEATHER, TIME_TOOL], messages: [{ role: 'user', content: '同时告诉我北京天气和上海时间' }] }),
    check: (res) => {
      const s = assertStreamShape(res);
      const idx = s.calls.map((c) => c.index);
      const expected = idx.map((_, i) => i);
      if (JSON.stringify(idx) !== JSON.stringify(expected)) fail(`index 不是 0..n-1 递增: ${JSON.stringify(idx)}`);
      return s;
    },
    observe: (res) => concatToolCallArgs(res.events).length >= 2,
    warnText: '只拿到 1 个流式工具调用',
  },
  {
    id: 'B4',
    group: 'B 流式',
    name: 'stream_options.include_usage',
    mockModel: 'mock-stream_tool',
    stream: true,
    body: (m) => chat(m, { stream: true, stream_options: { include_usage: true } }),
    check: (res) => assertStreamShape(res),
    strictInDry: true,
    observe: (res) => {
      const usage = res.events.find((e) => e.json?.usage);
      if (!usage) return false;
      return Array.isArray(usage.json.choices) && usage.json.choices.length === 0;
    },
    warnText: '上游未在流里提供 usage（网关按规范省略 usage chunk）',
  },
  {
    id: 'B5',
    group: 'B 流式',
    name: '以 data: [DONE] 结尾 + 无多余数据',
    mockModel: 'mock-stream_tool',
    stream: true,
    body: (m) => chat(m, { stream: true }),
    check: (res) => {
      const s = assertStreamShape(res);
      const doneCount = res.events.filter((e) => e.data === '[DONE]').length;
      if (doneCount !== 1) fail(`[DONE] 出现 ${doneCount} 次`);
      if (res.events.at(-1).json !== null) fail('[DONE] 之后不应再有数据');
      return s;
    },
  },

  // ---------------- D 错误
  {
    id: 'D1',
    group: 'D 错误',
    name: '非法 model → 上游 4xx 原样透传',
    kind: 'custom',
    run: async (ctx) => runInvalidModel(ctx),
  },
  {
    id: 'D2',
    group: 'D 错误',
    name: '上游 5xx 原样透传',
    mockModel: 'mock-error-500',
    mockOnly: true,
    body: (m) => chat(m),
    check: (res) => {
      if (res.status !== 500) fail(`状态码 ${res.status}，期望 500`);
      if (!res.json?.error) fail('缺少 OpenAI 风格 error');
    },
  },
  {
    id: 'D3',
    group: 'D 错误',
    name: '上游不可达/超时 → 504 upstream_timeout',
    kind: 'custom',
    run: async (ctx) => runTimeout(ctx),
  },
  {
    id: 'D4',
    group: 'D 错误',
    name: '缺 messages → 400',
    kind: 'custom',
    run: async (ctx) => {
      const r = await requestJson(`${ctx.tiny.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        body: { model: ctx.model, tools: [WEATHER] },
        headers: ctx.headers,
      });
      if (r.status !== 400) fail(`状态码 ${r.status}`);
      if (r.json?.error?.type !== 'invalid_request_error') fail(`error.type=${r.json?.error?.type}`);
    },
  },
  {
    id: 'D5',
    group: 'D 错误',
    name: 'body 超 MAX_BODY_BYTES → 413',
    kind: 'custom',
    run: async (ctx) => {
      const r = await requestJson(`${ctx.tiny.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        body: { model: ctx.model, messages: [{ role: 'user', content: 'x'.repeat(4096) }] },
        headers: ctx.headers,
      });
      if (r.status !== 413) fail(`状态码 ${r.status}`);
      if (r.json?.error?.type !== 'payload_too_large') fail(`error.type=${r.json?.error?.type}`);
    },
  },

  // ---------------- E 兼容
  {
    id: 'E1',
    group: 'E 兼容',
    name: 'reasoning_content 存在但不出现在 content',
    mockModel: 'mock-reasoning',
    body: (m) => chat(m, { messages: [{ role: 'user', content: '先在心里推理，再给答案：37 × 89 = ?' }] }),
    check: (res) => {
      const s = assertCompletionShape(res);
      const msg = s.message;
      if (msg.reasoning_content !== undefined) {
        if (typeof msg.content === 'string' && msg.content.includes(msg.reasoning_content.slice(0, 10))) {
          fail('reasoning 混进了 content');
        }
      }
      return s;
    },
    observe: (res) => typeof res.json.choices[0].message.reasoning_content === 'string',
    warnText: '上游未返回 reasoning_content（该模型可能不返回思考内容）',
  },
  {
    id: 'E2',
    group: 'E 兼容',
    name: 'usage 透传',
    mockModel: 'mock-tool',
    body: (m) => chat(m),
    check: (res) => {
      const s = assertCompletionShape(res);
      const usage = s.json.usage;
      if (!usage || typeof usage !== 'object') fail('缺少 usage');
      return s;
    },
    observe: (res) => typeof res.json.usage?.total_tokens === 'number',
    warnText: 'usage.total_tokens 不是数字',
  },
  {
    id: 'E3',
    group: 'E 兼容',
    name: '未知字段被忽略（不导致 4xx）',
    mockModel: 'mock-tool',
    body: (m) => chat(m, { logprobs: true, custom_field: 'x', response_format: { type: 'json_object' } }),
    check: (res) => assertCompletionShape(res),
  },
  {
    id: 'E4',
    group: 'E 兼容',
    name: 'MODEL_MAP 生效（gpt-5-codex → 上游真实模型）',
    kind: 'custom',
    run: async (ctx) => runModelMap(ctx),
  },

  // ---------------- F 鉴权
  {
    id: 'F1',
    group: 'F 鉴权',
    name: 'GATEWAY_API_KEY：无 key → 401',
    kind: 'custom',
    run: async (ctx) => {
      const r = await requestJson(`${ctx.auth.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        body: { model: ctx.model, messages: [{ role: 'user', content: 'x' }] },
      });
      if (r.status !== 401) fail(`状态码 ${r.status}`);
      if (r.json?.error?.type !== 'invalid_api_key') fail(`error.type=${r.json?.error?.type}`);
    },
  },
  {
    id: 'F2',
    group: 'F 鉴权',
    name: 'GATEWAY_API_KEY：正确 key → 放行（/v1/models，零模型调用）',
    kind: 'custom',
    run: async (ctx) => {
      const r = await requestJson(`${ctx.auth.baseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${ctx.authKey}` },
      });
      if (r.status !== 200) fail(`状态码 ${r.status}: ${maskSecret(r.text).slice(0, 200)}`);
    },
  },
  {
    id: 'F3',
    group: 'F 鉴权',
    name: '客户端 key 被上游 key 覆盖、不泄露',
    kind: 'custom',
    mockOnly: true,
    run: async (ctx) => {
      const r = await requestJson(`${ctx.main.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        body: chat('mock-tool'),
        headers: { authorization: 'Bearer sk-client-side-secret-should-not-leak' },
      });
      if (r.status !== 200) fail(`状态码 ${r.status}`);
      const diag = await getDiag(ctx.main);
      const prefix = diag?.lastRequest?.authPrefix ?? '';
      if (!prefix.startsWith('Bearer ')) fail('上游没收到 Authorization');
      if (prefix.includes('client-side')) fail('客户端 key 被转发到上游');
    },
  },
];

// ---------------------------------------------------------------- 自定义用例实现
async function runInvalidModel(ctx) {
  const body = { model: 'definitely-not-a-real-model-xyz', messages: [{ role: 'user', content: 'hi' }] };
  ctx.spend?.();
  const r = await requestJson(`${ctx.noMap.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body,
    headers: ctx.headers,
  });
  if (r.status < 400) fail(`期望上游 4xx，实际 ${r.status}: ${maskSecret(r.text).slice(0, 200)}`);
  if (!r.json?.error) fail('上游 4xx 的 body 被改写（应原样透传）');
  return { detail: `status=${r.status} type=${r.json.error.type ?? 'n/a'}` };
}

async function runTimeout(ctx) {
  // 本地 mock 故意延迟 3s，网关超时 300ms → 走真实的 fetch abort → 504（不消耗真实额度）
  const r = await requestJson(`${ctx.slow.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'mock-slow', messages: [{ role: 'user', content: 'hi' }], tools: [WEATHER] },
  });
  if (r.status !== 504) fail(`状态码 ${r.status}`);
  if (r.json?.error?.type !== 'upstream_timeout') fail(`error.type=${r.json?.error?.type}`);
  return { detail: '504 upstream_timeout' };
}

async function runModelMap(ctx) {
  ctx.spend?.();
  const r = await requestJson(`${ctx.mapStack.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: {
      model: 'gpt-5-codex',
      messages: [{ role: 'user', content: '北京天气？' }],
      tools: [WEATHER],
    },
    headers: ctx.headers,
  });
  const s = assertCompletionShape(r);
  const expected = ctx.expectedModel;
  if (s.json.model !== expected) fail(`响应 model=${s.json.model}，期望 ${expected}`);
  return { detail: `model=${s.json.model}` };
}

// ---------------------------------------------------------------- 多轮用例
function toolResultMessages(calls, outputs) {
  const assistant = {
    role: 'assistant',
    content: null,
    tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
  };
  const tools = calls.map((c, i) => ({
    role: 'tool',
    tool_call_id: c.id,
    name: c.name,
    content: outputs[i] ?? '{"ok":true}',
  }));
  return [assistant, ...tools];
}

async function oneRound(ctx, model, messages, tools) {
  ctx.spend?.();
  const r = await requestJson(`${ctx.main.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: { model, messages, tools },
    headers: ctx.headers,
  });
  if (r.status >= 400) {
    const err = new Error(`HTTP ${r.status}: ${maskSecret(r.text).slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return { res: r, parsed: assertCompletionShape(r) };
}

async function runMultiRound(ctx, { rounds, model, tools, prompt }) {
  const messages = [{ role: 'user', content: prompt }];
  const trace = [];
  let callsMade = 0;

  for (let round = 1; round <= rounds; round += 1) {
    const { parsed } = await oneRound(ctx, model, messages, tools);
    const calls = (parsed.message.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: c.function.arguments,
    }));
    if (calls.length === 0) {
      return {
        ok: false,
        warnOnly: LIVE,
        detail: `第 ${round} 轮直接给终答（未调用工具）`,
        trace,
        calls: callsMade,
      };
    }
    callsMade += calls.length;
    const outputs = calls.map((c) => {
      if (c.name === 'get_time') {
        return JSON.stringify({ timezone: 'Asia/Shanghai', now: '2026-11-15 09:00' });
      }
      return JSON.stringify({ city: '北京', temp: '25C', text: '晴' });
    });
    messages.push(...toolResultMessages(calls, outputs));
    trace.push(`round${round}: ${calls.map((c) => c.name).join(',')}`);
    if (LIVE) await sleep(300);

    if (round === rounds) {
      // 最后一轮应给终答
      const last = await oneRound(ctx, model, messages, tools);
      const lastCalls = last.parsed.message.tool_calls ?? [];
      if (lastCalls.length > 0) {
        return { ok: false, detail: `第 ${rounds + 1} 轮仍在调用工具，未收敛`, trace, calls: callsMade };
      }
      if (typeof last.parsed.message.content !== 'string' || !last.parsed.message.content.trim()) {
        return { ok: false, detail: '终答 content 为空', trace, calls: callsMade };
      }
      trace.push('final: stop');
      return { ok: true, detail: `共 ${callsMade} 次工具调用后收敛`, trace, calls: callsMade };
    }
  }
  return { ok: false, detail: '未完成', trace, calls: callsMade };
}

// ---------------------------------------------------------------- 运行器
function snippet(res) {
  if (!res) return '';
  const text = res.raw ?? res.text ?? '';
  return maskSecret(String(text)).slice(0, 500);
}

async function main() {
  const ctx = { mode: MODE, model: LIVE_MODEL, budget, spend: null, headers: {} };
  const stacks = [];
  let upstreamBlocked = false;

  if (LIVE) {
    const mainGw = await startLiveGateway();
    stacks.push(mainGw);
    const noMap = await startLiveGateway({ extraEnv: { DEFAULT_MODEL: '', MODEL_MAP: '', MODEL_OVERRIDE: '' } });
    stacks.push(noMap);
    const tiny = await startLiveGateway({ extraEnv: { MAX_BODY_BYTES: '1024' } });
    stacks.push(tiny);
    const authKey = 'gw-conformance-key';
    const auth = await startLiveGateway({ extraEnv: { GATEWAY_API_KEY: authKey } });
    stacks.push(auth);
    const slow = await startStack({ gwEnv: { REQUEST_TIMEOUT_MS: '300' } });
    stacks.push(slow);
    Object.assign(ctx, {
      main: mainGw,
      noMap,
      tiny,
      auth,
      slow,
      authKey,
      mapStack: mainGw,
      expectedModel: LIVE_MODEL,
      spend: () => budget.spend('conformance-live'),
    });
  } else {
    const main = await startStack();
    stacks.push(main);
    const mapped = await startStack({ gwEnv: { MODEL_MAP: '{"gpt-5-codex":"mock-tool"}', DEFAULT_MODEL: 'mock-text' } });
    stacks.push(mapped);
    const tiny = await startStack({ gwEnv: { MAX_BODY_BYTES: '1024' } });
    stacks.push(tiny);
    const auth = await startStack({ gwEnv: { GATEWAY_API_KEY: 'gw-conformance-key' } });
    stacks.push(auth);
    const slow = await startStack({ gwEnv: { REQUEST_TIMEOUT_MS: '300' } });
    stacks.push(slow);
    Object.assign(ctx, {
      main,
      noMap: mapped,
      tiny,
      auth,
      slow,
      authKey: 'gw-conformance-key',
      mapStack: mapped,
      expectedModel: 'mock-tool',
      mapped,
    });
  }

  try {
    for (const c of CASES) {
      if (LIVE && c.mockOnly) {
        results.push({ id: c.id, group: c.group, name: c.name, mode: MODE, status: 'SKIP', ms: 0, detail: '仅 mock 可确定性覆盖（live 跳过）' });
        continue;
      }
      if (flags.only && !flags.only.includes(c.id)) continue;

      const started = Date.now();
      let status = 'PASS';
      let detail = '';
      let res = null;
      try {
        if (c.kind === 'custom') {
          const out = LIVE
            ? await c.run(ctx)
            : await (c.id === 'D1' ? dryInvalidModel(ctx) : c.run(ctx));
          detail = out?.detail ?? '';
        } else {
          const model = LIVE ? ctx.model : (c.mockModel ?? ctx.model);
          const body = c.body(model);
          if (LIVE) ctx.spend?.(); // 每次真实请求都计入额度
          res = c.stream
            ? await requestSse(`${ctx.main.baseUrl}/v1/chat/completions`, { body, headers: ctx.headers })
            : await requestJson(`${ctx.main.baseUrl}/v1/chat/completions`, { method: 'POST', body, headers: ctx.headers });
          const parsed = c.check(res, ctx);
          detail = parsed?.detail ?? '';
          if (c.observe && (LIVE || c.strictInDry || c.observeStrict)) {
            let ok = false;
            try {
              ok = c.observe(res, ctx);
            } catch {
              ok = false;
            }
            if (!ok) {
              const strict = c.observeStrict || (!LIVE && c.strictInDry === true);
              status = strict ? 'FAIL' : 'WARN';
              detail = c.warnText ?? '观测未达预期';
            }
          }
        }
      } catch (err) {
        const st = res?.status;
        if (st === 403 || st === 429) {
          status = 'SKIP';
          detail = `上游拒绝 HTTP ${st}（人机验证/限流）：${snippet(res)}`;
          upstreamBlocked = true;
        } else {
          status = 'FAIL';
          detail = `${err.message}${res ? ` | response=${snippet(res)}` : ''}`;
        }
      }
      results.push({
        id: c.id,
        group: c.group,
        name: c.name,
        mode: MODE,
        status,
        ms: Date.now() - started,
        detail: status === 'PASS' ? detail : maskSecret(detail),
      });
      logLine(results.at(-1));
      if (LIVE && upstreamBlocked) {
        console.log('\n! 上游开始拒绝请求（人机验证/限流），提前结束 live 矩阵，剩余用例不再消耗额度。');
        break;
      }
      if (LIVE) await sleep(LIVE_DELAY_MS); // 温和限速，避免触发上游风控/限流
    }

    // 多轮（M9 也跑；dry 用 mock 的 loop 模式）
    for (const m of MULTI_CASES) {
      if (LIVE && upstreamBlocked) {
        results.push({ id: m.id, group: m.group, name: m.name, mode: MODE, status: 'SKIP', ms: 0, detail: '上游风控中断本次 live 运行' });
        logLine(results.at(-1));
        continue;
      }
      const started = Date.now();
      let status = 'PASS';
      let detail = '';
      try {
        const model = LIVE ? ctx.model : m.mockModel;
        const out = await runMultiRound(ctx, { ...m, model });
        detail = out.detail ?? '';
        if (!out.ok) {
          status = out.warnOnly ? 'WARN' : 'FAIL';
        }
      } catch (err) {
        if ((err.status === 403 || err.status === 429) && LIVE) {
          status = 'SKIP';
          detail = `上游拒绝 HTTP ${err.status}（人机验证/限流）`;
          upstreamBlocked = true;
        } else {
          status = 'FAIL';
          detail = maskSecret(err.message);
        }
      }
      results.push({ id: m.id, group: m.group, name: m.name, mode: MODE, status, ms: Date.now() - started, detail });
      logLine(results.at(-1));
    }
  } finally {
    for (const s of stacks) await s.close();
  }

  await finish();
}

function dryInvalidModel(ctx) {
  // dry：用 mock 的 400 错误模式验证"状态码 + body 原样透传"（main 栈没有 DEFAULT_MODEL，不会被改写）
  return requestJson(`${ctx.main.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'mock-error-400', messages: [{ role: 'user', content: 'hi' }] },
  }).then((r) => {
    if (r.status !== 400) fail(`状态码 ${r.status}`);
    if (!r.json?.error?.type) fail('缺少 error.type');
    return { detail: `status=${r.status}` };
  });
}

const MULTI_CASES = [
  {
    id: 'C1',
    group: 'C 多轮',
    name: '一轮工具 → 回传 → 终答',
    rounds: 1,
    tools: [TIME_TOOL],
    prompt: '现在几点了？请调用 get_time。',
    mockModel: 'mock-time',
  },
  {
    id: 'C2',
    group: 'C 多轮',
    name: '并行两工具 → 两条 role:tool → 终答',
    rounds: 1,
    tools: [WEATHER, TIME_TOOL],
    prompt: '同时告诉我北京天气和上海时间。',
    mockModel: 'mock-multi_loop',
  },
  {
    id: 'C3',
    group: 'C 多轮',
    name: '连续 3 轮工具后终答',
    rounds: 3,
    tools: [TIME_TOOL],
    prompt: '请连续查询三次时间，然后总结。',
    mockModel: 'mock-loop',
  },
];

function logLine(r) {
  const tag = r.status.padEnd(4);
  console.log(`  ${tag} ${r.id.padEnd(3)} ${r.name}${r.detail ? ` — ${String(r.detail).slice(0, 160)}` : ''}`);
}

async function finish() {
  const byStatus = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const fails = results.filter((r) => r.status === 'FAIL');
  const warns = results.filter((r) => r.status === 'WARN');
  const report = {
    mode: MODE,
    generatedAt: new Date().toISOString(),
    model: LIVE_MODEL,
    budget: budget.summary(),
    summary: { total: results.length, ...byStatus },
    results,
  };
  const md = renderMarkdown(report);
  const { jsonPath, mdPath } = writeReports(`conformance-${MODE}`, report, md);
  // live 额外留一份带时间戳的副本，避免后续运行覆盖证据
  if (LIVE) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeReports(`conformance-${MODE}-${stamp}`, report, md);
  }
  console.log(
    `\nCONFORMANCE ${MODE.toUpperCase()}: total=${results.length} PASS=${byStatus.PASS ?? 0} FAIL=${byStatus.FAIL ?? 0} WARN=${byStatus.WARN ?? 0} SKIP=${byStatus.SKIP ?? 0} liveCalls=${budget.used}/${budget.limit}`,
  );
  console.log(`报告: ${jsonPath}\n      ${mdPath}`);
  if (warns.length) {
    console.log('\n允许的可解释 WARN：');
    for (const w of warns) console.log(`  - ${w.id} ${w.name}: ${w.detail}`);
  }
  if (fails.length) {
    console.log('\nFAIL 详情（已脱敏）：');
    for (const f of fails) console.log(`  - ${f.id} ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# 工具调用全量矩阵 · ${report.mode.toUpperCase()}`);
  lines.push('');
  lines.push(`- 时间: ${report.generatedAt}`);
  lines.push(`- 模型: \`${report.model}\``);
  lines.push(`- 真实上游调用: ${report.budget.used} / ${report.budget.limit}`);
  lines.push(
    `- 汇总: 共 ${report.summary.total} 项 · PASS ${report.summary.PASS ?? 0} · FAIL ${report.summary.FAIL ?? 0} · WARN ${report.summary.WARN ?? 0} · SKIP ${report.summary.SKIP ?? 0}`,
  );
  lines.push('');
  lines.push('| ID | 组 | 用例 | 状态 | 耗时(ms) | 说明 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of report.results) {
    lines.push(`| ${r.id} | ${r.group} | ${r.name} | ${r.status} | ${r.ms} | ${(r.detail ?? '').replace(/\|/g, '\\|').slice(0, 160)} |`);
  }
  const warns = report.results.filter((r) => r.status === 'WARN');
  if (warns.length) {
    lines.push('');
    lines.push('## 允许的可解释 WARN');
    for (const w of warns) lines.push(`- **${w.id}** ${w.name}: ${w.detail}`);
  }
  const fails = report.results.filter((r) => r.status === 'FAIL');
  if (fails.length) {
    lines.push('');
    lines.push('## 失败项');
    for (const f of fails) lines.push(`- **${f.id}** ${f.name}: ${f.detail}`);
  }
  lines.push('');
  lines.push('> 说明：dry 模式全部由 mock 确定性覆盖（解析/合成/形状）；live 模式只验证真实模型端到端可用性，行为类断言降级为 WARN。');
  return lines.join('\n');
}

main().catch(async (err) => {
  if (err?.code === 'NO_CREDENTIALS') {
    console.error(`CONFORMANCE ${MODE.toUpperCase()}: SKIP — ${err.message}`);
    process.exit(2);
  }
  console.error(`CONFORMANCE ${MODE.toUpperCase()}: ERROR — ${maskSecret(err.stack ?? err.message)}`);
  process.exit(1);
});
