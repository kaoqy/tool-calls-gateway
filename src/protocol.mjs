// 响应解析与合成：模型输出 → OpenAI tool_calls / chat.completion / SSE chunks。
import { randomBytes } from 'node:crypto';

export const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

export function newCallId() {
  return `call_${randomBytes(12).toString('hex')}`;
}

export function newCompletionId() {
  return `chatcmpl-${randomBytes(12).toString('hex')}`;
}

export function stripCodeFences(text) {
  return String(text)
    .replace(/```[A-Za-z0-9_+-]*\s*\n?/g, '')
    .replace(/```/g, '');
}

/** 去掉 // 行注释与 /* *​/ 块注释（跳过字符串内部） */
export function stripComments(s) {
  let out = '';
  let i = 0;
  let inStr = null;
  let esc = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 保守地把单引号字符串转成双引号（内部含双引号或未闭合时放弃该处转换） */
export function requoteSingleQuotes(s) {
  let out = '';
  let i = 0;
  let inDouble = false;
  let esc = false;
  while (i < s.length) {
    const c = s[i];
    if (inDouble) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let buf = '';
      let ok = true;
      let e = false;
      while (j < s.length) {
        const d = s[j];
        if (e) {
          buf += d;
          e = false;
          j += 1;
          continue;
        }
        if (d === '\\') {
          buf += d;
          e = true;
          j += 1;
          continue;
        }
        if (d === '"') {
          ok = false;
          break;
        }
        if (d === "'") break;
        buf += d;
        j += 1;
      }
      if (ok && j < s.length && s[j] === "'") {
        out += `"${buf}"`;
        i = j + 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

function firstJsonStart(s) {
  const a = s.indexOf('{');
  const b = s.indexOf('[');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

/** 截取到括号平衡处，并补全未闭合的 } / ] */
export function balanceBrackets(s) {
  const stack = [];
  let inStr = null;
  let esc = false;
  let end = -1;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      const open = stack.pop();
      if (!open) {
        end = i;
        break;
      }
      if ((open === '{' && c !== '}') || (open === '[' && c !== ']')) {
        end = i;
        break;
      }
      if (stack.length === 0) {
        end = i + 1;
        break;
      }
    }
  }
  let out = end >= 0 ? s.slice(0, end) : s;

  // 补全未闭合括号
  const need = [];
  inStr = null;
  esc = false;
  for (let i = 0; i < out.length; i += 1) {
    const c = out[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === '{' || c === '[') need.push(c);
    else if (c === '}' || c === ']') need.pop();
  }
  while (need.length) {
    out += need.pop() === '{' ? '}' : ']';
  }
  return out;
}

/**
 * JSON 修复：去围栏/注释/尾逗号 → 单引号转双引号 → 截取首个 { 或 [ → 补全括号。
 * @param {string} input
 * @returns {string|null} 修复后的字符串；无法处理时返回 null
 */
export function repairJson(input) {
  if (typeof input !== 'string') {
    if (input && typeof input === 'object') {
      try {
        return JSON.stringify(input);
      } catch {
        return null;
      }
    }
    return null;
  }
  let s = stripCodeFences(input).trim();
  if (!s) return null;
  s = stripComments(s);
  s = requoteSingleQuotes(s);
  s = s.replace(/,(\s*[}\]])/g, '$1');
  const start = firstJsonStart(s);
  if (start === -1) return null;
  s = s.slice(start).trim();
  s = balanceBrackets(s);
  s = s.replace(/,(\s*[}\]])/g, '$1');
  return s.trim() || null;
}

function serializeArguments(value) {
  if (value === undefined || value === null) return '{}';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return JSON.stringify(value);
}

/**
 * 归一化上游「原生」tool_calls（结构化 function calling）。
 * 缺 id 补一个；arguments 是对象就字符串化；无名调用丢弃。
 */
export function normalizeNativeToolCalls(rawCalls) {
  return (Array.isArray(rawCalls) ? rawCalls : [])
    .map((tc) => ({
      id: typeof tc?.id === 'string' && tc.id ? tc.id : newCallId(),
      type: 'function',
      function: {
        name: typeof tc?.function?.name === 'string' ? tc.function.name : (typeof tc?.name === 'string' ? tc.name : ''),
        arguments: serializeArguments(tc?.function?.arguments ?? tc?.arguments),
      },
    }))
    .filter((call) => call.function.name);
}

/** 从上游非流式响应里取原生 tool_calls */
export function extractNativeToolCalls(json) {
  return normalizeNativeToolCalls(json?.choices?.[0]?.message?.tool_calls);
}

/**
 * 解析单个块内容为 {name, arguments}
 * @returns {{name:string, arguments:string}|null}
 */
export function parseToolCallBlock(raw) {
  const cleaned = stripCodeFences(raw ?? '').trim();
  if (!cleaned) return null;
  const candidates = [cleaned];
  const repaired = repairJson(cleaned);
  if (repaired && repaired !== cleaned) candidates.push(repaired);

  for (const candidate of candidates) {
    let obj;
    try {
      obj = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) continue;
    return { name, arguments: serializeArguments(obj.arguments) };
  }
  return null;
}

/**
 * 解析模型输出文本。
 * @param {string} text
 * @returns {{content:string|null, toolCalls:Array<{id:string,type:'function',function:{name:string,arguments:string}}>, finishReason:'stop'|'tool_calls', matched:number, failed:number}}
 */
export function parseModelOutput(text) {
  const source = typeof text === 'string' ? text : '';
  const toolCalls = [];
  let matched = 0;
  let failed = 0;
  TOOL_CALL_RE.lastIndex = 0;
  let m;
  while ((m = TOOL_CALL_RE.exec(source))) {
    matched += 1;
    const parsed = parseToolCallBlock(m[1]);
    if (!parsed) {
      failed += 1;
      continue;
    }
    toolCalls.push({
      id: newCallId(),
      type: 'function',
      function: { name: parsed.name, arguments: parsed.arguments },
    });
  }

  const stripped = source.replace(TOOL_CALL_RE, '').replace(/\n{3,}/g, '\n\n').trim();

  if (toolCalls.length === 0) {
    return {
      content: source,
      toolCalls: [],
      finishReason: 'stop',
      matched,
      failed,
    };
  }

  return {
    content: stripped.length ? stripped : null,
    toolCalls,
    finishReason: 'tool_calls',
    matched,
    failed,
  };
}

/**
 * 构造非流式 OpenAI chat.completion。
 * reasoning 为上游的思考内容（reasoning_content / reasoning），只挂在 message 上，
 * 绝不并入 content，也不参与工具解析。
 */
export function buildChatCompletion({
  id = newCompletionId(),
  model = 'unknown',
  created = Math.floor(Date.now() / 1000),
  content = null,
  toolCalls = [],
  finishReason,
  usage = null,
  reasoning = null,
  reasoningKey = 'reasoning_content',
} = {}) {
  const hasCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  const message = {
    role: 'assistant',
    content: hasCalls ? (typeof content === 'string' && content.trim() ? content : null) : (content ?? ''),
  };
  if (typeof reasoning === 'string' && reasoning.length > 0) message[reasoningKey] = reasoning;
  if (hasCalls) message.tool_calls = toolCalls;
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason ?? (hasCalls ? 'tool_calls' : 'stop'),
      },
    ],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function splitByCodePoints(text, size) {
  const chars = [...String(text)];
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out.length ? out : [''];
}

/**
 * 合成 OpenAI 流式 chunk 序列（不含 [DONE]）。
 * 每个 chunk 都是一个可直接 JSON 序列化的对象。
 */
export function buildSseChunks({
  id = newCompletionId(),
  model = 'unknown',
  created = Math.floor(Date.now() / 1000),
  content = null,
  toolCalls = [],
  usage = null,
  includeUsage = false,
  reasoning = null,
  reasoningKey = 'reasoning_content',
  textChunkSize = 48,
  argChunkSize = 16,
  reasoningChunkSize = 64,
} = {}) {
  const chunk = (choices) => ({ id, object: 'chat.completion.chunk', created, model, choices });
  const chunks = [chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])];
  const hasCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

  // 思考内容单独成 delta.reasoning_content，绝不混进 content
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    for (const piece of splitByCodePoints(reasoning, reasoningChunkSize)) {
      if (!piece) continue;
      chunks.push(chunk([{ index: 0, delta: { [reasoningKey]: piece }, finish_reason: null }]));
    }
  }

  if (typeof content === 'string' && content.length > 0) {
    for (const piece of splitByCodePoints(content, textChunkSize)) {
      if (!piece) continue;
      chunks.push(chunk([{ index: 0, delta: { content: piece }, finish_reason: null }]));
    }
  }

  if (hasCalls) {
    toolCalls.forEach((call, index) => {
      chunks.push(
        chunk([
          {
            index: 0,
            delta: {
              tool_calls: [
                { index, id: call.id, type: 'function', function: { name: call.function?.name ?? '', arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ]),
      );
      const pieces = splitByCodePoints(call.function?.arguments ?? '', argChunkSize);
      for (const piece of pieces) {
        if (!piece) continue;
        chunks.push(
          chunk([
            { index: 0, delta: { tool_calls: [{ index, function: { arguments: piece } }] }, finish_reason: null },
          ]),
        );
      }
    });
  }

  chunks.push(
    chunk([{ index: 0, delta: {}, finish_reason: hasCalls ? 'tool_calls' : 'stop' }]),
  );
  if (includeUsage && usage) {
    chunks.push({ id, object: 'chat.completion.chunk', created, model, choices: [], usage });
  }
  return chunks;
}
