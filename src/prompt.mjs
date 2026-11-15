// 请求改写：把「OpenAI 工具调用」请求翻译成「纯聊天上游」请求。
// 导出纯函数 buildUpstreamRequest(openaiBody, cfg) -> { url, headers, body, simulated }
import { config as defaultConfig, resolveModel } from './config.mjs';
import { upstreamHeaders, upstreamUrl } from './upstream.mjs';

/** 逐字使用（2.3 节）。{{TOOLS_JSON}} 为占位。 */
export const SYSTEM_TEMPLATE = `你是一个可以调用外部工具的智能助手。你可以通过「工具调用」来执行操作或获取信息。

# 可用工具
<tools>
{{TOOLS_JSON}}
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

export const TOOL_CHOICE_SUFFIX = Object.freeze({
  required: '\n\n【强制】本轮你必须至少调用一次工具，请立即输出 <tool_call>。',
  none: '\n\n【约束】本轮禁止调用工具，请直接用自然语言回答。',
});

export function toolChoiceSuffix(toolChoice) {
  if (toolChoice === undefined || toolChoice === null) return '';
  if (typeof toolChoice === 'string') {
    const v = toolChoice.trim();
    if (v === 'required' || v === 'any') return TOOL_CHOICE_SUFFIX.required;
    if (v === 'none') return TOOL_CHOICE_SUFFIX.none;
    return ''; // auto 及其它
  }
  if (typeof toolChoice === 'object') {
    const name = toolChoice.function?.name ?? toolChoice.name;
    if (name) return `\n\n【强制】本轮你必须调用工具 "${name}"，请立即输出对应的 <tool_call>。`;
  }
  return '';
}

export function hasTools(body) {
  return (
    (Array.isArray(body?.tools) && body.tools.length > 0) ||
    (Array.isArray(body?.functions) && body.functions.length > 0)
  );
}

const DEFAULT_PARAMETERS = Object.freeze({ type: 'object', properties: {} });

/** 归一化工具定义：tools[i].function 与旧式 functions[i] 都变成 {name, description, parameters} */
export function normalizeTools(body) {
  const out = [];
  const seen = new Set();
  const add = (fn) => {
    if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) return;
    if (seen.has(fn.name)) return;
    seen.add(fn.name);
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: fn.parameters ?? DEFAULT_PARAMETERS,
    });
  };

  for (const t of Array.isArray(body?.tools) ? body.tools : []) {
    if (!t) continue;
    add(t.type === 'function' || t.function ? t.function : t);
  }
  for (const f of Array.isArray(body?.functions) ? body.functions : []) {
    add(f);
  }
  return out;
}

/** 多模态 content 数组 → 纯文本（只取 text 部分） */
export function contentToText(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part && typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') return content.text ?? JSON.stringify(content);
  return String(content);
}

function argsToObject(args) {
  if (args === null || args === undefined) return {};
  if (typeof args === 'object') return args;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return args; // 解析失败：原样作为字符串嵌入
    }
  }
  return String(args);
}

export function toolCallBlock(name, argsValue) {
  return `<tool_call>${JSON.stringify({ name, arguments: argsValue })}</tool_call>`;
}

export function toolResultBlock(toolCallId, name, content) {
  return `<tool_result tool_call_id="${toolCallId ?? ''}" name="${name ?? ''}">\n${content ?? ''}\n</tool_result>`;
}

function pushMerged(out, message) {
  const last = out[out.length - 1];
  if (last && last.role === message.role) {
    last.content = `${last.content}\n\n${message.content}`.trim();
    return;
  }
  out.push({ ...message });
}

/**
 * 历史归一化：system 单独处理，tool 合并成 user，assistant.tool_calls 变文本块。
 * @param {Array<object>} messages
 */
export function flattenMessages(messages = []) {
  const nameById = new Map();
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.id) nameById.set(tc.id, tc?.function?.name ?? '');
      }
    }
  }

  const out = [];
  let pendingResults = [];
  const flushResults = () => {
    if (!pendingResults.length) return;
    pushMerged(out, { role: 'user', content: pendingResults.join('\n') });
    pendingResults = [];
  };

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role ?? 'user');

    if (role === 'system' || role === 'developer') continue; // 由 buildSystemPrompt 统一处理

    if (role === 'tool' || role === 'function') {
      const id = m.tool_call_id ?? m.name ?? '';
      const name = m.name ?? nameById.get(m.tool_call_id) ?? '';
      pendingResults.push(toolResultBlock(id, name, contentToText(m.content)));
      continue;
    }

    flushResults();

    if (role === 'assistant') {
      let text = contentToText(m.content);
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const blocks = m.tool_calls.map((tc) =>
          toolCallBlock(tc?.function?.name ?? '', argsToObject(tc?.function?.arguments)),
        );
        text = [text, ...blocks].filter((part) => part && part.trim()).join('\n');
      }
      if (!text.trim()) continue;
      pushMerged(out, { role: 'assistant', content: text });
      continue;
    }

    const text = contentToText(m.content);
    if (!text.trim()) continue;
    pushMerged(out, { role: 'user', content: text });
  }
  flushPending();
  return out;

  function flushPending() {
    flushResults();
  }
}

/** 客户端的所有 system / developer 消息按顺序合并 */
export function collectSystems(messages = []) {
  return messages
    .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
    .map((m) => contentToText(m.content))
    .filter((s) => s.trim());
}

export function buildSystemPrompt({ tools = [], toolChoice = 'auto', clientSystems = [] } = {}) {
  const toolsJson = JSON.stringify(tools, null, 2);
  const prompt = SYSTEM_TEMPLATE.replace('{{TOOLS_JSON}}', toolsJson) + toolChoiceSuffix(toolChoice);
  const head = clientSystems.map((s) => s.trim()).filter(Boolean).join('\n\n');
  return head ? `${head}\n\n${prompt}` : prompt;
}

/** 透传字段白名单（2.1 第 4 条）。max_tokens 一族单独归一化，见 pickMaxTokens。 */
export const PASSTHROUGH_KEYS = Object.freeze([
  'temperature',
  'top_p',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'stream_options',
]);

/** 把 max_tokens / max_completion_tokens / max_output_tokens 统一成一个上游可用值 */
export function pickMaxTokens(body) {
  for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    const value = body?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * 组装上游请求。
 * 含 tools/functions → 模拟模式（注入提示词 + 历史归一化 + 剥离工具字段）；
 * 否则返回原始 body 的浅拷贝（纯代理）。
 * @param {object} openaiBody
 * @param {{upstreamBaseUrl:string,upstreamApiKey:string,defaultModel?:string,toolMode?:string}} [cfg]
 * @returns {{url:string, headers:Record<string,string>, body:object, simulated:boolean}}
 */
export function buildUpstreamRequest(openaiBody, cfg = defaultConfig) {
  const url = upstreamUrl(cfg.upstreamBaseUrl, '/v1/chat/completions');
  const headers = upstreamHeaders(cfg.upstreamApiKey);
  const simulated = (cfg.toolMode ?? 'auto') !== 'off' && hasTools(openaiBody);

  if (!simulated) {
    return { url, headers, body: { ...openaiBody }, simulated: false };
  }

  const messages = Array.isArray(openaiBody?.messages) ? openaiBody.messages : [];
  const tools = normalizeTools(openaiBody);
  const system = buildSystemPrompt({
    tools,
    toolChoice: openaiBody?.tool_choice,
    clientSystems: collectSystems(messages),
  });

  const body = {
    model: resolveModel(openaiBody?.model, cfg),
    messages: [{ role: 'system', content: system }, ...flattenMessages(messages)],
  };
  const maxTokens = pickMaxTokens(openaiBody);
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  for (const key of PASSTHROUGH_KEYS) {
    if (openaiBody?.[key] !== undefined) body[key] = openaiBody[key];
  }
  if (openaiBody?.stream === true) body.stream = true;

  return { url, headers, body, simulated: true };
}
