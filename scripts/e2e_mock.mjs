// G6：端到端两轮工具循环（不依赖 docker）。
// 第 1 轮：客户端带 tools → 网关返回 tool_calls(get_time) → 脚本本地执行工具
// 第 2 轮：把 assistant.tool_calls + role:tool 结果回传 → 网关返回纯文本最终答案
import { startStack, requestJson, fail } from './lib/harness.mjs';

const MOCK_TEXT_HINT = '模拟时间';

const stack = await startStack();
const { baseUrl } = stack;

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: '获取指定时区的当前时间',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string', description: 'IANA 时区名' } },
        required: ['timezone'],
      },
    },
  },
];

/** 本地「执行」工具：真实场景里换成你的实现 */
function runGetTime(args) {
  const tz = args?.timezone ?? 'Asia/Shanghai';
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  return JSON.stringify({ timezone: tz, now });
}

const messages = [{ role: 'user', content: '现在几点了？' }];
const log = [];

try {
  // ---------- 第 1 轮 ----------
  const r1 = await requestJson(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'mock-time', messages, tools, temperature: 0.2 },
  });
  if (r1.status !== 200) fail(`第 1 轮状态码 ${r1.status}`, r1.text);
  const c1 = r1.json.choices[0];
  if (c1.finish_reason !== 'tool_calls') fail(`第 1 轮 finish_reason 应为 tool_calls，实际 ${c1.finish_reason}`, r1.text);
  const call = c1.message.tool_calls?.[0];
  if (!call) fail('第 1 轮没有返回 tool_calls', r1.text);
  if (call.type !== 'function') fail(`tool_calls[0].type 应为 function，实际 ${call.type}`);
  if (call.function.name !== 'get_time') fail(`工具名应为 get_time，实际 ${call.function.name}`);
  if (!/^call_[0-9a-f]{24}$/.test(call.id)) fail(`tool_call id 非法: ${call.id}`);
  const args = JSON.parse(call.function.arguments);
  log.push(`第 1 轮: finish=${c1.finish_reason} tool=${call.function.name} args=${call.function.arguments} id=${call.id}`);

  // ---------- 客户端本地执行工具 ----------
  const toolResult = runGetTime(args);
  log.push(`本地执行工具 get_time → ${toolResult}`);

  messages.push({
    role: 'assistant',
    content: c1.message.content,
    tool_calls: c1.message.tool_calls,
  });
  messages.push({
    role: 'tool',
    tool_call_id: call.id,
    name: call.function.name,
    content: toolResult,
  });

  // ---------- 第 2 轮 ----------
  const r2 = await requestJson(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'mock-time', messages, tools, temperature: 0.2 },
  });
  if (r2.status !== 200) fail(`第 2 轮状态码 ${r2.status}`, r2.text);
  const c2 = r2.json.choices[0];
  if (c2.finish_reason !== 'stop') fail(`第 2 轮 finish_reason 应为 stop，实际 ${c2.finish_reason}`, r2.text);
  if ('tool_calls' in c2.message) fail('第 2 轮不应再有 tool_calls', r2.text);
  if (typeof c2.message.content !== 'string' || !c2.message.content.includes(MOCK_TEXT_HINT)) {
    fail(`第 2 轮最终答案不符: ${c2.message.content}`, r2.text);
  }
  if (!r2.json.usage || typeof r2.json.usage.total_tokens !== 'number') {
    fail('第 2 轮缺少 usage 字段', r2.text);
  }
  log.push(`第 2 轮: finish=${c2.finish_reason} content=${c2.message.content}`);
  log.push(`第 2 轮 usage=${JSON.stringify(r2.json.usage)}`);

  // 结构校验：与 OpenAI SDK 期望的形状一致
  if (r2.json.object !== 'chat.completion') fail(`object 应为 chat.completion，实际 ${r2.json.object}`);
  if (r1.json.object !== 'chat.completion') fail(`第 1 轮 object 应为 chat.completion，实际 ${r1.json.object}`);
} catch (err) {
  console.log(`\n--- 子进程日志 ---\n${stack.logs()}`);
  console.log(`E2E MOCK: FAIL — ${err.message}`);
  await stack.close();
  process.exit(1);
} finally {
  await stack.close();
}

for (const line of log) console.log(`  ${line}`);
console.log('E2E MOCK: PASS');
