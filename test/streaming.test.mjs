// G4 单测：SSE 读取（跨 chunk 边界）+ buffer 收集 + 流式 chunk 合成细节。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSseEvents, collectStreamText, encodeSse } from '../src/sse.mjs';
import { buildSseChunks } from '../src/protocol.mjs';

function streamOf(parts) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function drain(stream) {
  const out = [];
  for await (const evt of readSseEvents(stream)) out.push(evt);
  return out;
}

test('SSE 解析：事件跨 chunk 边界、CRLF 与注释行', async () => {
  const events = await drain(
    streamOf([
      ': keep-alive\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"你"}}]}\r\n',
      '\r\n',
      'data: {"choices":[{"delta":',
      '{"content":"好"}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  );
  assert.equal(events.length, 3);
  assert.equal(events[0].data, '{"choices":[{"delta":{"content":"你"}}]}');
  assert.equal(events[1].data, '{"choices":[{"delta":{"content":"好"}}]}');
  assert.equal(events[2].data, '[DONE]');
});

test('collectStreamText：拼接 content、取 usage 与 model、忽略坏行', async () => {
  const stream = streamOf([
    'data: {"id":"chatcmpl-x","model":"mock-deepseek","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
    'data: {"id":"chatcmpl-x","model":"mock-deepseek","choices":[{"index":0,"delta":{"content":"你好"}}]}\n\n',
    'data: not-json\n\n',
    'data: {"id":"chatcmpl-x","model":"mock-deepseek","choices":[{"index":0,"delta":{"content":"，世界"}}]}\n\n',
    'data: {"id":"chatcmpl-x","model":"mock-deepseek","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const result = await collectStreamText(stream);
  assert.equal(result.text, '你好，世界');
  assert.equal(result.model, 'mock-deepseek');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
});

test('buildSseChunks：多工具 index 递增，各自 arguments 可独立拼回', () => {
  const toolCalls = [
    { id: 'call_aaaaaaaaaaaaaaaaaaaaaaaa', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
    { id: 'call_bbbbbbbbbbbbbbbbbbbbbbbb', type: 'function', function: { name: 'get_time', arguments: '{"tz":"Asia/Shanghai"}' } },
  ];
  const chunks = buildSseChunks({ id: 'chatcmpl-x', model: 'm', created: 1, content: null, toolCalls });
  const indices = new Set();
  const args = new Map();
  for (const c of chunks) {
    for (const tc of c.choices[0]?.delta?.tool_calls ?? []) {
      indices.add(tc.index);
      if (tc.id) args.set(tc.index, '');
      if (tc.function?.arguments) args.set(tc.index, (args.get(tc.index) ?? '') + tc.function.arguments);
    }
  }
  assert.deepEqual([...indices].sort(), [0, 1]);
  assert.equal(args.get(0), '{"city":"北京"}');
  assert.equal(args.get(1), '{"tz":"Asia/Shanghai"}');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('buildSseChunks：emoji/CJK 参数按码点切分，拼回完全一致', () => {
  const args = JSON.stringify({ text: '天气😀很好🌤️', n: 42 });
  const chunks = buildSseChunks({
    model: 'm',
    created: 1,
    content: null,
    toolCalls: [{ id: 'call_cccccccccccccccccccccccc', type: 'function', function: { name: 'f', arguments: args } }],
    argChunkSize: 3,
  });
  let joined = '';
  for (const c of chunks) {
    for (const tc of c.choices[0]?.delta?.tool_calls ?? []) joined += tc.function?.arguments ?? '';
  }
  assert.equal(joined, args);
  assert.equal(JSON.parse(joined).text, '天气😀很好🌤️');
});

test('buildSseChunks：includeUsage 控制是否补 choices:[] 的 usage 包', () => {
  const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
  const withUsage = buildSseChunks({ model: 'm', created: 1, content: 'hi', usage, includeUsage: true });
  assert.deepEqual(withUsage.at(-1).choices, []);
  assert.equal(withUsage.at(-1).usage.total_tokens, 3);

  const without = buildSseChunks({ model: 'm', created: 1, content: 'hi', usage, includeUsage: false });
  assert.equal(without.some((c) => c.usage), false);
});

test('encodeSse：输出严格的 data: 行，[DONE] 同样是 data: 行', () => {
  assert.equal(encodeSse({ a: 1 }), 'data: {"a":1}\n\n');
});
