// SSE 读写工具：把上游 ReadableStream 解析成事件，或把对象序列化成 data: 行。

export const SSE_DONE_LINE = 'data: [DONE]\n\n';

/**
 * 宽松识别 [DONE]：容忍大小写、前后空格、data: 后无空格等写法。
 * @param {string} data
 */
export function isDoneData(data) {
  return String(data ?? '').trim().toLowerCase() === '[done]';
}

/**
 * 把对象编码成一条 SSE data 行。
 * @param {unknown} obj
 */
export function encodeSse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** @param {string} text */
export function encodeSseRaw(text) {
  return `data: ${text}\n\n`;
}

/**
 * 解析一个 SSE 块（不含结尾空行）。
 * @param {string} block
 * @returns {{event:string|null,data:string,id:string|null,retry:number|null}|null}
 */
export function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  let event = null;
  let id = null;
  let retry = null;
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'retry') retry = Number.parseInt(value, 10);
  }
  if (!dataLines.length && !event) return null;
  return { event, data: dataLines.join('\n'), id, retry };
}

/**
 * 逐事件读取一个 SSE 流。
 * @param {ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>} body
 */
export async function* readSseEvents(body) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let first = true;
  const iterator = body[Symbol.asyncIterator]
    ? body
    : (async function* () {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          reader.releaseLock?.();
        }
      })();

  for await (const chunk of iterator) {
    buffer += decoder.decode(chunk, { stream: true });
    if (first) {
      first = false;
      buffer = buffer.replace(/^\uFEFF/, ''); // 容忍上游 BOM
    }
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const evt = parseSseBlock(block);
      if (evt) yield evt;
    }
  }
  buffer += decoder.decode();
  const tail = parseSseBlock(buffer.trim());
  if (tail) yield tail;
}

/**
 * 从上游流里取出全部增量（buffer-then-synthesize 用）：
 * 文本 content、思考 reasoning_content/reasoning、原生 tool_calls、usage、model、finish_reason。
 * @param {ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>} body
 */
export async function collectStreamText(body) {
  let text = '';
  let reasoning = '';
  let reasoningKey = 'reasoning_content';
  let usage = null;
  let model = null;
  let id = null;
  let finishReason = null;
  const byIndex = new Map();

  for await (const evt of readSseEvents(body)) {
    if (!evt.data || isDoneData(evt.data)) continue;
    let parsed;
    try {
      parsed = JSON.parse(evt.data);
    } catch {
      continue;
    }
    if (parsed?.model) model = parsed.model;
    if (parsed?.id) id = parsed.id;
    if (parsed?.usage) usage = parsed.usage;
    const choice = parsed?.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? choice.message ?? {};

    if (typeof delta.content === 'string') text += delta.content;
    // 思考内容单独收集，绝不拼进 text
    if (typeof delta.reasoning_content === 'string') {
      reasoning += delta.reasoning_content;
      reasoningKey = 'reasoning_content';
    } else if (typeof delta.reasoning === 'string') {
      reasoning += delta.reasoning;
      reasoningKey = 'reasoning';
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number.isInteger(tc?.index) ? tc.index : byIndex.size;
        if (!byIndex.has(idx)) byIndex.set(idx, { id: '', name: '', arguments: '' });
        const entry = byIndex.get(idx);
        if (tc?.id) entry.id = String(tc.id);
        if (tc?.function?.name) entry.name = String(tc.function.name);
        if (typeof tc?.function?.arguments === 'string') entry.arguments += tc.function.arguments;
      }
    }
  }

  const toolCalls = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      id: v.id || null,
      type: 'function',
      function: { name: v.name, arguments: v.arguments || '{}' },
    }));

  return {
    text,
    reasoning,
    reasoningKey,
    toolCalls,
    usage,
    model,
    id,
    finishReason,
  };
}
