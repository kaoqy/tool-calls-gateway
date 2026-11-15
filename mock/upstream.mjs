// 模拟上游：兼容 OpenAI /v1/chat/completions 的纯聊天接口（也故意支持"原生 tool_calls"，用于兜底测试）。
// 通过 X-Mock-Mode 头、?mode= 或 model 名（mock-<mode>[-<status>]）控制返回内容。
//
// mode:
//   text            纯文本（默认）
//   tool            单个 <tool_call> 块
//   multi           两个并列 <tool_call> 块
//   malformed       坏 JSON 的 <tool_call> 块
//   stream_tool     流式吐 <tool_call> 块（切成多片，跨 token 边界）
//   error           返回错误状态码（?status=429|500，默认 429）
//   slow            延迟 ?delay= 毫秒后返回纯文本
//   retry_first     首次纯文本、再次工具块（喂 tool_choice=required 重试）
//   time            首轮 get_time 调用；历史里已有 <tool_result> 时给最终文本（喂两轮循环）
//   tricky          结构化原生 tool_calls，参数含中文/emoji/引号/反斜杠/超长字符串/深层嵌套
//   native          非流式「原生 tool_calls」（测网关兜底：直接转换不再二次包裹）
//   stream_native   流式「原生 tool_calls」
//   reasoning       非流式：reasoning_content + 工具块（思考里还塞了一个假 <tool_call>）
//   stream_reasoning 流式：先 reasoning_content 分片，再正文工具块
//   weird_sse       故意不规范的 SSE（无空格 data:、事件跨多行、小写 [done]、注释行）
import http from 'node:http';
import crypto from 'node:crypto';

/**
 * 把收到的 messages 里 content 的"形状"记下来（供 /__diag 断言多模态透传）。
 * 只记录结构 + sha256，不记录内容本身——这样既能断言"base64 逐字节未变"，又不会把大块 base64 塞进诊断。
 */
function contentShapes(body) {
  const shapes = [];
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    const c = m?.content;
    if (typeof c === 'string') {
      shapes.push({ role: m?.role ?? null, kind: 'string', textLen: c.length, text: c.length <= 200 ? c : undefined });
      continue;
    }
    if (Array.isArray(c)) {
      shapes.push({
        role: m?.role ?? null,
        kind: 'array',
        parts: c.map((p) => {
          if (typeof p === 'string') return { type: 'string', textLen: p.length };
          if (!p || typeof p !== 'object') return { type: typeof p };
          const t = String(p.type ?? 'unknown');
          if (t === 'image_url' || t === 'input_image' || t === 'file' || t === 'input_audio') {
            const raw =
              typeof p.image_url === 'string'
                ? p.image_url
                : p.image_url?.url ?? p.image_data ?? p.file?.file_data ?? p.input_audio?.data ?? '';
            const s = String(raw ?? '');
            return {
              type: t,
              detail: p.image_url?.detail ?? p.detail ?? null,
              bytes: Buffer.byteLength(s, 'utf8'),
              sha256: crypto.createHash('sha256').update(s).digest('hex'),
              filename: p.file?.filename ?? null,
            };
          }
          if (t === 'text') return { type: 'text', textLen: String(p.text ?? '').length, text: String(p.text ?? '').slice(0, 120) };
          return { type: t };
        }),
      });
      continue;
    }
    shapes.push({ role: m?.role ?? null, kind: c === null ? 'null' : typeof c });
  }
  return shapes;
}

const PORT = Number.parseInt(process.env.PORT ?? '0', 10);
const MODEL = process.env.MOCK_MODEL ?? 'mock-deepseek';
const FIXED_CREATED = 1700000000;

let retryCounter = 0;
/** 诊断用：记录网关实际发到上游的请求（不参与响应体，避免影响逐字节对比） */
let lastRequest = null;

const TOOL_CONTENT =
  '好的，我来查一下。\n<tool_call>{"name":"get_weather","arguments":{"city":"北京"}}</tool_call>';
const MULTI_CONTENT =
  '我并行查两个。\n' +
  '<tool_call>{"name":"get_weather","arguments":{"city":"北京","unit":"celsius"}}</tool_call>\n' +
  '<tool_call>{"name":"get_time","arguments":{"timezone":"Asia/Shanghai"}}</tool_call>';
const TEXT_CONTENT =
  '这是模拟上游的纯文本回复。它用来验证网关在无工具时原样透传，在有工具时按提示词模拟工具调用并合成标准的流式分片。';
const MOCK_USAGE = { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 };
const MALFORMED_CONTENT = '<tool_call>{bad json}</tool_call>';
const TIME_TOOL_CALL = '<tool_call>{"name":"get_time","arguments":{"timezone":"Asia/Shanghai"}}</tool_call>';
const TIME_FINAL_TEXT = '现在是 2026-11-14 22:50（Asia/Shanghai，模拟时间）。';
const REASONING_TEXT =
  '思考：用户想知道北京天气。<tool_call>{"name":"fake_tool","arguments":{"x":1}}</tool_call> 这里应该调用真工具 get_weather。';
const FENCED_CONTENT =
  '<tool_call>```json\n{"name":"get_weather","arguments":{"city":"上海"}}\n```</tool_call>';
const VARIANT_CONTENT = '<TOOL_CALL>   {"name": "get_weather", "arguments": {"city": "广州"}}   </TOOL_CALL>';
const SPECIAL_NAME_CONTENT = '<tool_call>{"name":"ns.weather.v2","arguments":{"city":"深圳"}}</tool_call>';
const EMPTY_ARGS_CONTENT = '<tool_call>{"name":"now"}</tool_call>';

/** 数历史里有几个 <tool_result>（用于多轮循环模拟） */
function countToolResults(body) {
  return (body?.messages ?? []).reduce((n, m) => {
    if (typeof m?.content !== 'string') return n;
    return n + (m.content.match(/<tool_result\s+tool_call_id=/g)?.length ?? 0);
  }, 0);
}

const TRICKY_ARGS = {
  city: '北京🌤',
  note: '他说："你好"，反斜杠 \\ 与制表\t都要保留',
  long: 'x'.repeat(2500),
  nested: { a: [1, 2, { b: [3, 4, { c: '深' }] }], d: { e: { f: ['中文键值', true, null] } } },
};

/** 非 system 的历史里出现完整的 <tool_result tool_call_id=...> 才说明客户端已回传工具结果
 *（注入的 system 提示词模板里也提到 <tool_result>，不能只按子串判断） */
function hasToolResult(body) {
  return (body?.messages ?? []).some(
    (m) =>
      m?.role !== 'system' &&
      typeof m?.content === 'string' &&
      /<tool_result\s+tool_call_id=/.test(m.content),
  );
}

function pickMode(req, url, body) {
  const explicit = req.headers['x-mock-mode'] ?? url.searchParams.get('mode');
  let mode = explicit ? String(explicit) : 'text';
  let status = Number.parseInt(url.searchParams.get('status') ?? '', 10);
  // 网关不转发 query/自定义头，因此也支持用 model 名选择模式：mock-<mode>[-<status>]
  if (!explicit) {
    const m = /^mock-([a-z_]+?)(?:-(\d+))?$/.exec(String(body?.model ?? ''));
    if (m) {
      mode = m[1];
      if (m[2]) status = Number.parseInt(m[2], 10);
    }
  }
  if (!Number.isFinite(status)) status = 429;
  return { mode, status };
}

/**
 * 构造一次回复。
 * @returns {{content:string|null, reasoning?:string, toolCalls?:object[], finishReason:'stop'|'tool_calls'}}
 */
function buildReply(mode, body) {
  switch (mode) {
    case 'tool':
    case 'stream_tool':
      return { content: TOOL_CONTENT, finishReason: 'stop' };
    case 'multi':
      return { content: MULTI_CONTENT, finishReason: 'stop' };
    case 'malformed':
      return { content: MALFORMED_CONTENT, finishReason: 'stop' };
    case 'retry_first':
      return retryCounter === 1
        ? { content: TEXT_CONTENT, finishReason: 'stop' }
        : { content: TOOL_CONTENT, finishReason: 'stop' };
    case 'time':
      return hasToolResult(body)
        ? { content: TIME_FINAL_TEXT, finishReason: 'stop' }
        : { content: TIME_TOOL_CALL, finishReason: 'stop' };
    case 'tricky':
      return {
        content: null,
        toolCalls: [
          {
            id: 'call_tricky_000',
            type: 'function',
            function: { name: 'echo_args', arguments: JSON.stringify(TRICKY_ARGS) },
          },
        ],
        finishReason: 'tool_calls',
      };
    case 'native':
    case 'stream_native':
      return {
        content: null,
        toolCalls: [
          {
            id: 'call_native_001',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"北京"}' },
          },
        ],
        finishReason: 'tool_calls',
      };
    case 'reasoning':
    case 'stream_reasoning':
      return {
        content: '<tool_call>{"name":"get_weather","arguments":{"city":"北京"}}</tool_call>',
        reasoning: REASONING_TEXT,
        finishReason: 'stop',
      };
    case 'fenced':
      return { content: FENCED_CONTENT, finishReason: 'stop' };
    case 'variant':
      return { content: VARIANT_CONTENT, finishReason: 'stop' };
    case 'special_name':
      return { content: SPECIAL_NAME_CONTENT, finishReason: 'stop' };
    case 'emptyargs':
      return { content: EMPTY_ARGS_CONTENT, finishReason: 'stop' };
    case 'loop':
      // 连续 3 轮工具后给终答
      return countToolResults(body) < 3
        ? { content: TIME_TOOL_CALL, finishReason: 'stop' }
        : { content: TIME_FINAL_TEXT, finishReason: 'stop' };
    case 'multi_loop':
      // 并行两工具 → 两条 tool 结果 → 终答
      return countToolResults(body) < 2
        ? { content: MULTI_CONTENT, finishReason: 'stop' }
        : { content: TIME_FINAL_TEXT, finishReason: 'stop' };
    default:
      return { content: TEXT_CONTENT, finishReason: 'stop' };
  }
}

function splitIntoChunks(text, size = 7) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function echoOf(bodyJson) {
  return {
    model: bodyJson?.model ?? null,
    temperature: bodyJson?.temperature ?? null,
    max_tokens: bodyJson?.max_tokens ?? null,
    max_completion_tokens: bodyJson?.max_completion_tokens ?? null,
    stream: bodyJson?.stream === true,
    messages_count: Array.isArray(bodyJson?.messages) ? bodyJson.messages.length : 0,
    has_tools: Array.isArray(bodyJson?.tools) && bodyJson.tools.length > 0,
    has_functions: Array.isArray(bodyJson?.functions) && bodyJson.functions.length > 0,
    tool_choice: bodyJson?.tool_choice ?? null,
    has_response_format: bodyJson?.response_format !== undefined,
  };
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(buf.length) });
  res.end(buf);
}

function openSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function writeChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function baseChunk(extra) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: FIXED_CREATED,
    model: MODEL,
    ...extra,
  };
}

/** 按 OpenAI 规范吐一段流（也模拟"原生 tool_calls"分片） */
function streamReply(res, reply, { includeUsage = false } = {}) {
  openSse(res);
  writeChunk(res, baseChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
  if (reply.reasoning) {
    for (const piece of splitIntoChunks(reply.reasoning, 9)) {
      writeChunk(res, baseChunk({ choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }] }));
    }
  }
  if (reply.content) {
    for (const piece of splitIntoChunks(reply.content)) {
      writeChunk(res, baseChunk({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
    }
  }
  (reply.toolCalls ?? []).forEach((call, index) => {
    writeChunk(
      res,
      baseChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    for (const piece of splitIntoChunks(call.function.arguments, 11)) {
      writeChunk(
        res,
        baseChunk({
          choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: piece } }] }, finish_reason: null }],
        }),
      );
    }
  });
  writeChunk(res, baseChunk({ choices: [{ index: 0, delta: {}, finish_reason: reply.finishReason ?? 'stop' }] }));
  if (includeUsage) writeChunk(res, baseChunk({ choices: [], usage: MOCK_USAGE }));
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 故意不规范的 SSE：无空格 data:、事件跨多行、注释行、小写 [done] */
function streamWeird(res, text) {
  openSse(res);
  res.write(': keep-alive\n\n');
  res.write('event: message\n');
  res.write(
    `data:{"id":"chatcmpl-mock","object":"chat.completion.chunk","created":${FIXED_CREATED},"model":"${MODEL}",\n`,
  );
  res.write('data: "choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n');
  for (const piece of splitIntoChunks(text, 6)) {
    res.write(
      `data:{"id":"chatcmpl-mock","object":"chat.completion.chunk","created":${FIXED_CREATED},"model":"${MODEL}","choices":[{"index":0,"delta":{"content":${JSON.stringify(piece)}},"finish_reason":null}]}\n\n`,
    );
  }
  res.write(
    `data:{"id":"chatcmpl-mock","object":"chat.completion.chunk","created":${FIXED_CREATED},"model":"${MODEL}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
  );
  res.write('data: [done]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });

  if (url.pathname === '/__reset') {
    retryCounter = 0;
    lastRequest = null;
    return sendJson(res, 200, { reset: true });
  }

  if (url.pathname === '/__diag' && req.method === 'GET') {
    return sendJson(res, 200, { lastRequest, retryCounter });
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    return sendJson(res, 200, {
      object: 'list',
      data: [{ id: MODEL, object: 'model', created: FIXED_CREATED, owned_by: 'mock', supports_tool_call: false }],
    });
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const raw = await readBody(req);
    let body = null;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'mock: 请求体不是合法 JSON' } });
    }

    const { mode, status } = pickMode(req, url, body);
    lastRequest = {
      keys: Object.keys(body ?? {}).sort(),
      model: body?.model ?? null,
      max_tokens: body?.max_tokens ?? null,
      max_completion_tokens: body?.max_completion_tokens ?? null,
      stream: body?.stream === true,
      messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
      systemPreview: String(body?.messages?.[0]?.content ?? '').slice(0, 160),
      authPrefix: String(req.headers.authorization ?? '').slice(0, 16),
      contentShapes: contentShapes(body),
      mode,
    };
    if (mode === 'error') {
      return sendJson(res, status, {
        error: {
          type: status === 429 ? 'rate_limit_exceeded' : 'upstream_internal_error',
          message: `mock upstream 故意返回 ${status}`,
        },
      });
    }

    if (mode === 'vision_unsupported') {
      // 模拟"模型不接受图片"的上游：400 + 含 image 关键字，用于验证网关的错误归一化
      return sendJson(res, 400, {
        error: {
          type: 'invalid_request_error',
          message: 'This model does not support image input; content type image_url is not allowed.',
        },
      });
    }

    if (mode === 'slow') {
      const delay = Number.parseInt(url.searchParams.get('delay') ?? '3000', 10);
      await new Promise((r) => setTimeout(r, delay));
    }

    if (mode === 'retry_first') retryCounter += 1;

    const reply = buildReply(mode, body);
    const echo = echoOf(body);
    const includeUsage = body?.stream_options?.include_usage === true;

    if (body?.stream === true) {
      if (mode === 'weird_sse') return streamWeird(res, String(reply.content ?? ''));
      return streamReply(res, reply, { includeUsage });
    }

    const message = { role: 'assistant', content: reply.content };
    if (reply.reasoning) message.reasoning_content = reply.reasoning;
    if (reply.toolCalls) message.tool_calls = reply.toolCalls;

    return sendJson(res, 200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: FIXED_CREATED,
      model: body?.model ?? MODEL,
      choices: [{ index: 0, message, finish_reason: reply.finishReason ?? 'stop' }],
      usage: MOCK_USAGE,
      echo,
    });
  }

  return sendJson(res, 404, { error: { type: 'not_found', message: `mock: 未知路由 ${req.method} ${url.pathname}` } });
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  console.log(`[mock] listening on http://127.0.0.1:${addr.port}`);
});
