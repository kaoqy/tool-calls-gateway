// 多模态内容转发：单元（content.mjs）+ 归一化（prompt.mjs）+ 真 HTTP 端到端（mock 上游）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startStack, requestJson, readLog } from '../scripts/lib/harness.mjs';
import {
  countMedia,
  countMediaInBody,
  contentToText,
  describeMediaPart,
  hasMedia,
  listMedia,
  mediaSizeStats,
  normalizeContent,
} from '../src/content.mjs';
import { buildUpstreamRequest, flattenMessages } from '../src/prompt.mjs';
import { sanitizeUpstreamSnippet, TINY_PNG_BASE64 } from '../src/server.mjs';

const PNG_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function captureLogger() {
  const lines = [];
  const push = (level) => (msg, meta) => lines.push({ level, msg, meta });
  return {
    lines,
    text: () => lines.map((l) => `${l.msg} ${JSON.stringify(l.meta ?? {})}`).join('\n'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
  };
}

// ---------------------------------------------------------------- A. 单元
test('1. image_url 字符串形态 → 归一化成对象形态，base64 逐字节不变', () => {
  const out = normalizeContent([{ type: 'image_url', image_url: PNG_URL }], { logger: null });
  assert.equal(Array.isArray(out), true);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'image_url');
  assert.equal(typeof out[0].image_url, 'object');
  assert.equal(out[0].image_url.url, PNG_URL, 'URL 必须逐字节一致');
  assert.equal(sha256(out[0].image_url.url), sha256(PNG_URL));
});

test('2. 带 detail 的 image_url 原样保留 detail', () => {
  const part = { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'high' } };
  const [out] = normalizeContent([part], { logger: null });
  assert.deepEqual(out, part);
  assert.equal(out.image_url.detail, 'high');
});

test('3. 文本 + 图片混排：顺序不变、text 不被合并、图片不丢', () => {
  const parts = [
    { type: 'text', text: '第一段' },
    { type: 'image_url', image_url: { url: PNG_URL } },
    { type: 'text', text: '第二段' },
    { type: 'text', text: '' },
  ];
  const out = normalizeContent(parts, { logger: null });
  assert.equal(out.length, 4, '不允许合并或丢弃 part');
  assert.deepEqual(
    out.map((p) => p.type),
    ['text', 'image_url', 'text', 'text'],
  );
  assert.equal(out[0].text, '第一段');
  assert.equal(out[2].text, '第二段');
  assert.equal(out[3].text, '', '空文本 part 也保留');
});

test('4. 未识别 part（video）→ 原样透传 + 计数 + warn（只打 type 名）', () => {
  const logger = captureLogger();
  const weird = { type: 'video', video_url: { url: 'data:video/mp4;base64,AAAABBBBCCCC' } };
  const out = normalizeContent([weird, { type: 'text', text: 'hi' }], { logger });
  assert.deepEqual(out[0], weird, '不认识的 part 必须原样保留');
  assert.equal(countMedia([weird]).unknownParts, 1);
  const warned = logger.lines.find((l) => l.level === 'warn' && l.msg.includes('unknown content part'));
  assert.ok(warned, '必须有 warn');
  assert.equal(warned.meta.type, 'video', 'warn 只带 type 名');
  assert.equal(logger.text().includes('AAAABBBBCCCC'), false, 'warn 不得包含内容');
});

test('5. imageMode=placeholder → 媒体替换成占位文本（旧行为回归）', () => {
  const out = normalizeContent(
    [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: PNG_URL } },
      { type: 'file', file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' } },
      { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
    ],
    { imageMode: 'placeholder', logger: null },
  );
  assert.deepEqual(
    out.map((p) => p.text),
    ['看图', '[图片]', '[文件: report.pdf]', '[音频]'],
  );
  assert.equal(countMedia(out).images, 0, '占位后不再有媒体 part');
  assert.equal(contentToText(out).includes('[图片]'), true);
});

test('6. input_image / file / input_audio 原样保留（含 data URL 前缀）', () => {
  const parts = [
    { type: 'input_image', image_url: PNG_URL },
    { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjQK' } },
    { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
  ];
  const out = normalizeContent(parts, { logger: null });
  assert.deepEqual(out, parts);
  assert.deepEqual(countMedia(out), { images: 1, files: 1, audios: 1, unknownParts: 0 });
});

test('7. 纯文本 / null / 普通对象不被包装成数组', () => {
  assert.equal(normalizeContent('纯文本'), '纯文本');
  assert.equal(normalizeContent(null), null);
  const obj = { text: 'x' };
  assert.equal(normalizeContent(obj), obj);
});

test('8. contentToText 只取文本，与旧语义一致', () => {
  assert.equal(contentToText('abc'), 'abc');
  assert.equal(contentToText(null), '');
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'x' } }]), 'a');
  assert.equal(contentToText([{ text: 'a' }, { text: 'b' }]), 'a\nb');
  assert.equal(contentToText({ text: 'obj' }), 'obj');
});

test('9. countMedia / hasMedia / listMedia 不泄露内容', () => {
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: PNG_URL } }] },
      { role: 'assistant', content: 'ok' },
    ],
  };
  assert.equal(hasMedia(body), true);
  assert.deepEqual(countMediaInBody(body), { images: 1, files: 0, audios: 0, unknownParts: 0 });
  const listed = listMedia(body);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].mime, 'image/png');
  assert.equal(listed[0].urlKind, 'data');
  assert.ok(listed[0].bytes > 0);
  assert.equal(JSON.stringify(listed).includes('iVBORw0KGgo'), false, '描述里不得出现 base64');

  const http = describeMediaPart({ type: 'image_url', image_url: { url: 'https://cdn.example.com/x.png' } });
  assert.equal(http.urlKind, 'http');
  assert.equal(http.host, 'cdn.example.com');

  assert.equal(hasMedia({ messages: [{ role: 'user', content: 'no media' }] }), false);
});

test('10. mediaSizeStats：能给出单 part 最大体积（OOM 防护依据）', () => {
  const payload = 'A'.repeat(1024 * 1024);
  const big = `data:image/png;base64,${payload}`;
  const stats = mediaSizeStats({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: big } }] }] });
  assert.equal(stats.maxPart.type, 'image_url');
  assert.equal(stats.maxPartBytes, Math.floor((payload.length * 3) / 4), '按 base64 解码后的字节数计');
  assert.ok(stats.totalBytes >= stats.maxPartBytes);
});

test('11. sanitizeUpstreamSnippet：去掉 data URL / key / 长 base64', () => {
  const dirty = `bad image: ${PNG_URL} key=sk-abcdef1234567890 payload ${'B'.repeat(300)}`;
  const clean = sanitizeUpstreamSnippet(dirty);
  assert.equal(clean.includes('iVBORw0KGgo'), false);
  assert.equal(clean.includes('sk-abcdef1234567890'), false);
  assert.equal(clean.includes('B'.repeat(300)), false);
  assert.ok(clean.includes('bad image'));
});

// ---------------------------------------------------------------- B. 归一化
test('12. 同角色多模态消息合并后仍是数组，且不含 [object Object]', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '第一张' }, { type: 'image_url', image_url: { url: PNG_URL } }] },
    { role: 'user', content: [{ type: 'text', text: '第二张' }, { type: 'image_url', image_url: { url: PNG_URL } }] },
  ];
  const out = flattenMessages(messages, { imageMode: 'pass' });
  assert.equal(out.length, 1, '同角色应合并');
  assert.equal(Array.isArray(out[0].content), true, '合并后 content 必须仍是数组');
  assert.equal(JSON.stringify(out[0]).includes('[object Object]'), false);
  assert.equal(out[0].content.filter((p) => p.type === 'image_url').length, 2, '两张图都在');
  assert.equal(out[0].content.filter((p) => p.type === 'text').length, 2, '两段文本都在');
});

test('13. 同角色纯文本消息仍然按空行拼接（不回归）', () => {
  const out = flattenMessages([
    { role: 'user', content: 'A' },
    { role: 'user', content: 'B' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'A\n\nB');
});

test('14. tool 结果里的图片：保留 <tool_result> 文本块 + 媒体 part', () => {
  const out = flattenMessages(
    [
      {
        role: 'assistant',
        content: '查一下',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shot', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: [
          { type: 'text', text: '截图如下' },
          { type: 'image_url', image_url: { url: PNG_URL } },
        ],
      },
    ],
    { imageMode: 'pass' },
  );
  const last = out[out.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(Array.isArray(last.content), true);
  const textPart = last.content.find((p) => p.type === 'text');
  assert.ok(textPart.text.includes('<tool_result'), '仍带 tool_result 文本包裹');
  const image = last.content.find((p) => p.type === 'image_url');
  assert.equal(image.image_url.url, PNG_URL, '图片必须留在内容里');
});

test('15. buildUpstreamRequest：system 是字符串，用户消息 content 保持数组', () => {
  const built = buildUpstreamRequest(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: PNG_URL }] }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }],
    },
    { upstreamBaseUrl: 'http://127.0.0.1:1', upstreamApiKey: 'k', imageMode: 'pass' },
  );
  assert.equal(built.simulated, true);
  assert.equal(typeof built.body.messages[0].content, 'string', 'system 仍是纯文本');
  const user = built.body.messages[1];
  assert.equal(Array.isArray(user.content), true);
  assert.equal(user.content[1].image_url.url, PNG_URL, 'base64 未被改写');
});

test('16. imageMode=placeholder 时 buildUpstreamRequest 不产生图片 part', () => {
  const built = buildUpstreamRequest(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: PNG_URL }] }],
      tools: [{ type: 'function', function: { name: 'f' } }],
    },
    { upstreamBaseUrl: 'http://127.0.0.1:1', upstreamApiKey: 'k', imageMode: 'placeholder' },
  );
  const flat = JSON.stringify(built.body.messages);
  assert.equal(flat.includes('iVBORw0KGgo'), false, '占位模式下不应出现 base64');
  assert.ok(flat.includes('[图片]'));
});

// ---------------------------------------------------------------- C. 端到端
const stacks = [];
after(async () => {
  for (const s of stacks) await s.close();
});

async function stack(gwEnv = {}) {
  const s = await startStack({
    gwEnv: {
      LOG_LEVEL: 'info',
      DEFAULT_MODEL: '',
      MODEL_MAP: '',
      MODEL_OVERRIDE: '',
      IMAGE_MODE: '',
      ...gwEnv,
    },
  });
  stacks.push(s);
  return s;
}

const imageBody = (model, extra = {}) => ({
  model,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '描述这张图' },
        { type: 'image_url', image_url: { url: PNG_URL } },
      ],
    },
  ],
  tools: [
    { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } },
  ],
  ...extra,
});

test('17. 端到端：模拟模式把图片原样交给上游（数组形态 + sha256 一致 + 工具调用正常）', async () => {
  const s = await stack();
  const res = await requestJson(`${s.baseUrl}/v1/chat/completions`, { method: 'POST', body: imageBody('mock-tool') });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].finish_reason, 'tool_calls');
  assert.equal(res.json.choices[0].message.tool_calls[0].function.name, 'get_weather');

  const diag = (await requestJson(`${s.mockUrl}/__diag`)).json;
  const shapes = diag.lastRequest.contentShapes;
  const userShape = shapes.find((x) => x.role === 'user');
  assert.equal(userShape.kind, 'array', '上游收到的 content 必须是数组');
  assert.deepEqual(
    userShape.parts.map((p) => p.type),
    ['text', 'image_url'],
  );
  assert.equal(userShape.parts[1].sha256, sha256(PNG_URL), 'base64 逐字节未变');
  assert.equal(userShape.parts[1].bytes, Buffer.byteLength(PNG_URL));
  assert.equal(typeof shapes[0].kind, 'string', 'system 仍是字符串 content');
});

test('18. 4MB base64 请求体不再被 413（上限已提到 16MB）', async () => {
  const s = await stack();
  const big = `data:image/png;base64,${'A'.repeat(4 * 1024 * 1024)}`;
  const res = await requestJson(`${s.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: {
      model: 'mock-tool',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: big } }] }],
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].finish_reason, 'tool_calls');
});

test('19. 20MB 请求体 → 413 payload_too_large（不是 invalid_json）', async () => {
  const s = await stack();
  const huge = 'A'.repeat(20 * 1024 * 1024);
  let status;
  let text;
  try {
    const res = await requestJson(`${s.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: { model: 'mock-tool', messages: [{ role: 'user', content: huge }], tools: [{ type: 'function', function: { name: 'f' } }] },
    });
    status = res.status;
    text = res.text;
  } catch (err) {
    // 极端情况下连接可能在响应后立刻关闭，这时也要能确认不是 500/JSON 解析错误
    assert.match(String(err.message), /fetch failed|socket|ECONNRESET/i);
    return;
  }
  assert.equal(status, 413, text);
  const json = JSON.parse(text);
  assert.equal(json.error.type, 'payload_too_large');
  assert.match(json.error.message, /maxBodyBytes/);
  assert.ok(json.error.size > json.error.limit, '应报告实际大小与上限');
  assert.equal(text.includes('invalid_json'), false);
});

test('20. 单次请求图片过多（>8）→ 413', async () => {
  const s = await stack();
  const parts = [{ type: 'text', text: '看这几张' }];
  for (let i = 0; i < 9; i += 1) parts.push({ type: 'image_url', image_url: { url: PNG_URL } });
  const res = await requestJson(`${s.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'mock-tool', messages: [{ role: 'user', content: parts }], tools: [{ type: 'function', function: { name: 'f' } }] },
  });
  assert.equal(res.status, 413, res.text);
  assert.equal(res.json.error.type, 'payload_too_large');
  assert.match(res.json.error.message, /单次请求图片过多或过大/);
});

test('21. imageMode=placeholder：上游收到的是文本占位，不含图片', async () => {
  const s = await stack({ IMAGE_MODE: 'placeholder' });
  const res = await requestJson(`${s.baseUrl}/v1/chat/completions`, { method: 'POST', body: imageBody('mock-tool') });
  assert.equal(res.status, 200, res.text);
  const diag = (await requestJson(`${s.mockUrl}/__diag`)).json;
  const userShape = diag.lastRequest.contentShapes.find((x) => x.role === 'user');
  const flat = JSON.stringify(userShape);
  assert.equal(flat.includes('image_url'), false, '占位模式下不应有 image_url part');
  assert.ok(flat.includes('[图片]'), '应包含占位文本');
});

test('22. imageMode=reject：含媒体 + tools → 400 vision_unsupported，且不打上游', async () => {
  const s = await stack({ IMAGE_MODE: 'reject' });
  const res = await requestJson(`${s.baseUrl}/v1/chat/completions`, { method: 'POST', body: imageBody('mock-tool') });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error.type, 'vision_unsupported');
  const diag = (await requestJson(`${s.mockUrl}/__diag`)).json;
  assert.equal(diag.lastRequest, null, 'reject 时不应请求上游');
});

test('23. 上游 400 且提到 image → 归一化为 upstream_vision_unsupported（并脱敏原文）', async () => {
  const s = await stack();
  const res = await requestJson(`${s.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: imageBody('mock-vision_unsupported'),
  });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error.type, 'upstream_vision_unsupported');
  assert.match(res.json.error.message, /placeholder/);
  assert.equal(res.json.error.upstreamStatus, 400);
  assert.ok(res.json.error.upstream.includes('image'), '保留上游原文便于排查');
  assert.equal(res.json.error.upstream.includes('base64'), false, '原文需脱敏');
});

test('24. 日志：只说"转发了几张图"，绝不打印 base64 内容', async () => {
  const s = await stack();
  await requestJson(`${s.baseUrl}/v1/chat/completions`, { method: 'POST', body: imageBody('mock-tool') });
  const logs = readLog(s.gw);
  assert.ok(logs.includes('media forwarded'), '应有 media forwarded 日志');
  assert.match(logs, /images=1\b/, '日志应带图片计数');
  assert.equal(logs.includes('iVBORw0KGgo'), false, '日志不得包含 base64 内容');
  assert.equal(logs.includes('base64,'), false, '日志不得出现 data URL 正文');
});

test('25. /healthz 暴露 imageMode，方便确认配置已生效', async () => {
  const s = await stack({ IMAGE_MODE: 'placeholder' });
  const health = await requestJson(`${s.baseUrl}/healthz`);
  assert.equal(health.json.imageMode, 'placeholder');
  const s2 = await stack();
  const health2 = await requestJson(`${s2.baseUrl}/healthz`);
  assert.equal(health2.json.imageMode, 'pass', '默认必须是 pass');
});

test('26. 未知 part 类型经网关也透传给上游（fail-open）', async () => {
  const s = await stack();
  const res = await requestJson(`${s.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body: {
      model: 'mock-tool',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这是什么' },
            { type: 'video', video_url: { url: 'https://cdn.example.com/v.mp4' } },
          ],
        },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    },
  });
  assert.equal(res.status, 200, res.text);
  const diag = (await requestJson(`${s.mockUrl}/__diag`)).json;
  const userShape = diag.lastRequest.contentShapes.find((x) => x.role === 'user');
  assert.deepEqual(
    userShape.parts.map((p) => p.type),
    ['text', 'video'],
    '不认识的 part 必须原样出现在上游请求里',
  );
});
