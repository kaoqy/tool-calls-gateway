// G4 e2e：mock 以 stream_tool 模式分片吐工具调用块 → 网关 buffer-then-synthesize。
// 断言：首个 delta.role / 工具首包带 id+type+name / arguments 分片拼接完整 /
//       finish_reason=tool_calls / 以 data: [DONE] 结尾；纯文本流 content 拼回原文 finish=stop。
import { startStack, requestSse, concatDeltaContent, concatToolCallArgs, fail } from './lib/harness.mjs';

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true });
      console.log(`  PASS  ${name}`);
    })
    .catch((err) => {
      results.push({ name, ok: false, err });
      console.log(`  FAIL  ${name}: ${err.message}`);
    });
}

const stack = await startStack();
const { baseUrl } = stack;

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询城市天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
];

const MOCK_TEXT =
  '这是模拟上游的纯文本回复。它用来验证网关在无工具时原样透传，在有工具时按提示词模拟工具调用并合成标准的流式分片。';

const mkBody = (model, extra = {}) => ({
  model,
  stream: true,
  messages: [{ role: 'user', content: '北京天气怎么样？' }],
  tools,
  ...extra,
});

try {
  await check('① stream_tool：role 首包 + 工具首包(id/type/name) + arguments 拼接 + finish + [DONE]', async () => {
    const { status, events } = await requestSse(`${baseUrl}/v1/chat/completions`, {
      body: mkBody('mock-stream_tool', { stream_options: { include_usage: true } }),
    });
    if (status !== 200) fail(`状态码 ${status}`);
    if (!events.length) fail('没有收到任何 SSE 事件');
    if (events.at(-1).data !== '[DONE]') fail(`应以 data: [DONE] 结尾，实际 ${events.at(-1).data}`);

    const first = events[0].json;
    if (first?.choices?.[0]?.delta?.role !== 'assistant') fail('首个 chunk 的 delta.role 应为 assistant');

    const calls = concatToolCallArgs(events);
    if (calls.length !== 1) fail(`应收到 1 个工具调用，实际 ${calls.length}`);
    const call = calls[0];
    if (!/^call_[0-9a-f]{24}$/.test(call.id ?? '')) fail(`id 不是 call_<24hex>: ${call.id}`);
    if (call.type !== 'function') fail(`type 应为 function，实际 ${call.type}`);
    if (call.name !== 'get_weather') fail(`name 应为 get_weather，实际 ${call.name}`);
    if (call.arguments !== '{"city":"北京"}') fail(`arguments 拼接结果不符: ${call.arguments}`);
    assertJsonEqual(call.arguments);

    const finishChunks = events.filter((e) => e.json?.choices?.[0]?.finish_reason === 'tool_calls');
    if (finishChunks.length !== 1) fail(`应有且仅有 1 个 finish_reason=tool_calls 的 chunk，实际 ${finishChunks.length}`);

    // tool_calls 分片必须真的分多片（否则说明没有按流式合成）
    const argChunks = events.filter((e) => Array.isArray(e.json?.choices?.[0]?.delta?.tool_calls)).length;
    if (argChunks < 2) fail(`tool_calls 只出现在 ${argChunks} 个 chunk 里，分片不明显`);

    // include_usage：应有一个 choices:[] 且带 usage 的 chunk
    const usageChunk = events.find((e) => Array.isArray(e.json?.choices) && e.json.choices.length === 0 && e.json.usage);
    if (!usageChunk) fail('include_usage=true 但没收到 usage chunk');

    // 正文内容（块前文本）也应正确流出
    const content = concatDeltaContent(events);
    if (content !== '好的，我来查一下。') fail(`content 拼接应为「好的，我来查一下。」，实际「${content}」`);
  });

  await check('② 纯文本流：delta.content 拼回原文，finish_reason=stop', async () => {
    const { status, events } = await requestSse(`${baseUrl}/v1/chat/completions`, {
      body: mkBody('mock-text'),
    });
    if (status !== 200) fail(`状态码 ${status}`);
    const content = concatDeltaContent(events);
    if (content !== MOCK_TEXT) fail(`content 拼接不符: ${content}`);
    const finish = events.filter((e) => e.json?.choices?.[0]?.finish_reason === 'stop');
    if (finish.length !== 1) fail(`应有 1 个 finish_reason=stop，实际 ${finish.length}`);
    if (events.at(-1).data !== '[DONE]') fail('应以 [DONE] 结尾');
    if (concatToolCallArgs(events).length !== 0) fail('纯文本场景不应有 tool_calls');
    const contentChunks = events.filter((e) => typeof e.json?.choices?.[0]?.delta?.content === 'string' && e.json.choices[0].delta.content);
    if (contentChunks.length < 2) fail(`文本只切了 ${contentChunks.length} 片，应至少 2 片`);
  });

  await check('③ malformed 块：流式场景回退为文本 stop，不崩溃', async () => {
    const { status, events } = await requestSse(`${baseUrl}/v1/chat/completions`, {
      body: mkBody('mock-malformed'),
    });
    if (status !== 200) fail(`状态码 ${status}`);
    const content = concatDeltaContent(events);
    if (!content.includes('<tool_call>{bad json}</tool_call>')) fail(`原文应保留在 content 中，实际「${content}」`);
    if (concatToolCallArgs(events).length !== 0) fail('坏 JSON 不应产生 tool_calls');
    const finish = events.find((e) => e.json?.choices?.[0]?.finish_reason)?.json.choices[0].finish_reason;
    if (finish !== 'stop') fail(`finish_reason 应为 stop，实际 ${finish}`);
    if (events.at(-1).data !== '[DONE]') fail('应以 [DONE] 结尾');
  });
} finally {
  await stack.close();
}

function assertJsonEqual(text) {
  const parsed = JSON.parse(text);
  if (parsed?.city !== '北京') fail(`arguments 不是合法 JSON 对象: ${text}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n--- 子进程日志 ---\n${stack.logs()}`);
  console.log(`GATE M4 FAIL: ${failed.length}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`GATE M4 PASS: ${results.length}/${results.length} 项通过`);
