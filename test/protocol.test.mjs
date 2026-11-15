// G3：响应解析 + 非流式合成（协议矩阵，逐条断言精确 JSON）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModelOutput,
  repairJson,
  buildChatCompletion,
  stripCodeFences,
  parseToolCallBlock,
} from '../src/protocol.mjs';

const CALL_ID_RE = /^call_[0-9a-f]{24}$/;

test('1. 纯文本 → 无 tool_calls，finish=stop', () => {
  const out = parseModelOutput('你好');
  assert.equal(out.content, '你好');
  assert.deepEqual(out.toolCalls, []);
  assert.equal(out.finishReason, 'stop');
  const completion = buildChatCompletion({ model: 'm', content: out.content, toolCalls: out.toolCalls, finishReason: out.finishReason });
  assert.equal(completion.choices[0].message.content, '你好');
  assert.equal('tool_calls' in completion.choices[0].message, false);
  assert.equal(completion.choices[0].finish_reason, 'stop');
});

test('2. 单个工具调用块 → content=null，arguments 是字符串，finish=tool_calls', () => {
  const out = parseModelOutput('<tool_call>{"name":"get_weather","arguments":{"city":"北京"}}</tool_call>');
  assert.equal(out.content, null);
  assert.equal(out.finishReason, 'tool_calls');
  assert.equal(out.toolCalls.length, 1);
  const call = out.toolCalls[0];
  assert.match(call.id, CALL_ID_RE);
  assert.equal(call.type, 'function');
  assert.equal(call.function.name, 'get_weather');
  assert.equal(typeof call.function.arguments, 'string');
  assert.equal(call.function.arguments, '{"city":"北京"}');

  const completion = buildChatCompletion({
    id: 'chatcmpl-fixed',
    model: 'mock-tool',
    created: 1700000000,
    content: out.content,
    toolCalls: out.toolCalls,
    finishReason: out.finishReason,
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  assert.deepEqual(completion, {
    id: 'chatcmpl-fixed',
    object: 'chat.completion',
    created: 1700000000,
    model: 'mock-tool',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: completion.choices[0].message.tool_calls[0].id,
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"北京"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
});

test('3. 两个并列块 → 2 个调用，顺序正确', () => {
  const text =
    '<tool_call>{"name":"get_weather","arguments":{"city":"北京"}}</tool_call>\n' +
    '<tool_call>{"name":"get_time","arguments":{"timezone":"Asia/Shanghai"}}</tool_call>';
  const out = parseModelOutput(text);
  assert.equal(out.toolCalls.length, 2);
  assert.deepEqual(
    out.toolCalls.map((c) => c.function.name),
    ['get_weather', 'get_time'],
  );
  assert.deepEqual(
    out.toolCalls.map((c) => c.function.arguments),
    ['{"city":"北京"}', '{"timezone":"Asia/Shanghai"}'],
  );
  assert.notEqual(out.toolCalls[0].id, out.toolCalls[1].id);
  assert.equal(out.content, null);
  assert.equal(out.finishReason, 'tool_calls');
});

test('4. 前后带文本 → content 为 trim 后的剩余文本', () => {
  const out = parseModelOutput(
    '好的，我来查一下。\n<tool_call>{"name":"get_weather","arguments":{"city":"北京"}}</tool_call>\n',
  );
  assert.equal(out.content, '好的，我来查一下。');
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.finishReason, 'tool_calls');
});

test('5. 块内 json 代码围栏 → 正常解析', () => {
  const out = parseModelOutput('<tool_call>```json\n{"name":"get_weather","arguments":{"city":"上海"}}\n```</tool_call>');
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].function.arguments, '{"city":"上海"}');
  assert.equal(stripCodeFences('```json\n{"a":1}\n```').trim(), '{"a":1}');
});

test('6. 尾逗号 → 修复后解析成功', () => {
  assert.equal(repairJson('{"a":1,}'), '{"a":1}');
  const out = parseModelOutput('<tool_call>{"name":"get_weather","arguments":{"city":"北京",},}</tool_call>');
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].function.arguments, '{"city":"北京"}');
});

test('7. 坏 JSON → 无有效调用，原文保留在 content，不崩溃', () => {
  const text = '<tool_call>{bad}</tool_call>';
  const out = parseModelOutput(text);
  assert.deepEqual(out.toolCalls, []);
  assert.equal(out.finishReason, 'stop');
  assert.ok(out.content.includes('<tool_call>{bad}</tool_call>'), `content=${out.content}`);
  assert.equal(out.failed, 1);
  assert.equal(parseToolCallBlock('{bad}'), null);
  assert.equal(repairJson('{bad}'), '{bad}');
});

test('8. arguments 缺失 → "{}"', () => {
  const out = parseModelOutput('<tool_call>{"name":"ping"}</tool_call>');
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].function.arguments, '{}');
});

test('9. 中文 / 嵌套对象参数原样保留', () => {
  const args = { city: '北京', options: { unit: '摄氏', nested: { deep: [1, 2, 3] } }, 备注: '保留中文键' };
  const out = parseModelOutput(`<tool_call>${JSON.stringify({ name: 'get_weather', arguments: args })}</tool_call>`);
  assert.equal(out.toolCalls.length, 1);
  assert.deepEqual(JSON.parse(out.toolCalls[0].function.arguments), args);
});

test('10. 空块 → 忽略，不产生调用', () => {
  const out = parseModelOutput('<tool_call></tool_call>');
  assert.deepEqual(out.toolCalls, []);
  assert.equal(out.finishReason, 'stop');
  assert.equal(out.matched, 1);
  assert.equal(out.failed, 1);
});

test('11. 流式 chunk 合成：tool_calls 首包带 id/type/name，arguments 分片可拼回', async () => {
  const { buildSseChunks } = await import('../src/protocol.mjs');
  const out = parseModelOutput('<tool_call>{"name":"get_weather","arguments":{"city":"北京","unit":"celsius"}}</tool_call>');
  const chunks = buildSseChunks({
    id: 'chatcmpl-fixed',
    model: 'mock-tool',
    created: 1700000000,
    content: out.content,
    toolCalls: out.toolCalls,
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    includeUsage: true,
  });
  const first = chunks[0];
  assert.equal(first.choices[0].delta.role, 'assistant');
  assert.equal(first.choices[0].finish_reason, null);

  const head = chunks.find((c) => c.choices[0]?.delta?.tool_calls?.[0]?.id);
  assert.ok(head, '应有一个带 id 的工具调用首包');
  assert.match(head.choices[0].delta.tool_calls[0].id, CALL_ID_RE);
  assert.equal(head.choices[0].delta.tool_calls[0].type, 'function');
  assert.equal(head.choices[0].delta.tool_calls[0].function.name, 'get_weather');
  assert.equal(head.choices[0].delta.tool_calls[0].index, 0);

  let args = '';
  for (const c of chunks) {
    const tc = c.choices[0]?.delta?.tool_calls?.[0];
    if (tc?.function?.arguments) args += tc.function.arguments;
  }
  assert.equal(args, '{"city":"北京","unit":"celsius"}');

  const last = chunks.at(-2);
  assert.equal(last.choices[0].finish_reason, 'tool_calls');
  const usageChunk = chunks.at(-1);
  assert.deepEqual(usageChunk.choices, []);
  assert.equal(usageChunk.usage.total_tokens, 3);
});

test('12. 流式 chunk 合成：纯文本分片拼回原文，finish=stop', async () => {
  const { buildSseChunks } = await import('../src/protocol.mjs');
  const text = '这是模拟上游的纯文本回复。';
  const chunks = buildSseChunks({ id: 'x', model: 'm', created: 1, content: text, toolCalls: [] });
  const joined = chunks
    .map((c) => c.choices[0]?.delta?.content ?? '')
    .join('');
  assert.equal(joined, text);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.ok(chunks.length > 2, '应切成多个分片');
});
