// M14 图片转发端到端：真起 mock 上游 + 网关，发带图请求，断言上游确实收到了图片。
//
//   node scripts/e2e_media.mjs
//
// 断言（全部走真实 HTTP）：
//   ① 上游收到的用户消息 content 是**数组**（不是被文本化）
//   ② image_url part 完整保留（data URL 前缀 + detail）
//   ③ base64 逐字节未改写（sha256 比对）
//   ④ 响应本身仍然正常：finish_reason=tool_calls
// 额外：placeholder / reject 两种 imageMode 的行为，以及 20MB 的 413。
import crypto from 'node:crypto';
import { startStack, requestJson } from './lib/harness.mjs';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
const PNG_URL = `data:image/png;base64,${TINY_PNG}`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
];

const imageRequest = (model) => ({
  model,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图里有什么？' },
        { type: 'image_url', image_url: { url: PNG_URL, detail: 'high' } },
      ],
    },
  ],
  tools,
});

async function main() {
  // ---------- 默认 pass ----------
  const s = await startStack({ gwEnv: { LOG_LEVEL: 'warn', DEFAULT_MODEL: '', MODEL_MAP: '' } });
  try {
    const res = await requestJson(`${s.baseUrl}/v1/chat/completions`, { method: 'POST', body: imageRequest('mock-tool') });
    check('响应 200', res.status === 200, res.text.slice(0, 160));
    check(
      'finish_reason=tool_calls',
      res.json?.choices?.[0]?.finish_reason === 'tool_calls',
      String(res.json?.choices?.[0]?.finish_reason),
    );

    const diag = (await requestJson(`${s.mockUrl}/__diag`)).json;
    const user = (diag.lastRequest?.contentShapes ?? []).find((x) => x.role === 'user');
    check('① 上游收到的 content 是数组', user?.kind === 'array', `kind=${user?.kind}`);
    const parts = user?.parts ?? [];
    check(
      '① 保序：text + image_url',
      parts.length === 2 && parts[0].type === 'text' && parts[1].type === 'image_url',
      parts.map((p) => p.type).join(','),
    );
    check('② image_url 完整（detail 保留）', parts[1]?.type === 'image_url' && parts[1]?.detail === 'high');
    check(
      '③ base64 逐字节未改写',
      parts[1]?.sha256 === sha256(PNG_URL) && parts[1]?.bytes === Buffer.byteLength(PNG_URL),
      `${parts[1]?.bytes} bytes`,
    );
    check('system 仍是纯文本', diag.lastRequest?.contentShapes?.[0]?.kind === 'string');
  } finally {
    await s.close();
  }

  // ---------- placeholder ----------
  const p = await startStack({ gwEnv: { LOG_LEVEL: 'warn', DEFAULT_MODEL: '', MODEL_MAP: '', IMAGE_MODE: 'placeholder' } });
  try {
    const res = await requestJson(`${p.baseUrl}/v1/chat/completions`, { method: 'POST', body: imageRequest('mock-tool') });
    const diag = (await requestJson(`${p.mockUrl}/__diag`)).json;
    const flat = JSON.stringify(diag.lastRequest?.contentShapes ?? []);
    check('placeholder：仍 200', res.status === 200, res.text.slice(0, 120));
    check('placeholder：上游收不到图片', flat.includes('image_url') === false);
    check('placeholder：收到 [图片] 占位', flat.includes('[图片]'));
  } finally {
    await p.close();
  }

  // ---------- reject ----------
  const r = await startStack({ gwEnv: { LOG_LEVEL: 'warn', DEFAULT_MODEL: '', MODEL_MAP: '', IMAGE_MODE: 'reject' } });
  try {
    const res = await requestJson(`${r.baseUrl}/v1/chat/completions`, { method: 'POST', body: imageRequest('mock-tool') });
    check('reject：400 vision_unsupported', res.status === 400 && res.json?.error?.type === 'vision_unsupported', res.text.slice(0, 120));
    const diag = (await requestJson(`${r.mockUrl}/__diag`)).json;
    check('reject：不打上游', diag.lastRequest === null);
  } finally {
    await r.close();
  }

  // ---------- 体积 ----------
  const b = await startStack({ gwEnv: { LOG_LEVEL: 'warn', DEFAULT_MODEL: '', MODEL_MAP: '' } });
  try {
    const small = await requestJson(`${b.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: {
        model: 'mock-tool',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` } }] }],
        tools,
      },
    });
    check('3MB 图片请求未 413', small.status === 200, `status=${small.status}`);

    let hugeStatus = null;
    try {
      const huge = await requestJson(`${b.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        body: { model: 'mock-tool', messages: [{ role: 'user', content: 'A'.repeat(20 * 1024 * 1024) }], tools },
      });
      hugeStatus = huge.status;
      check('20MB 请求 → 413', huge.status === 413 && huge.json?.error?.type === 'payload_too_large', huge.text.slice(0, 120));
      check('20MB 不是 invalid_json', huge.json?.error?.type !== 'invalid_json');
    } catch (err) {
      check('20MB 请求被拒（连接中断）', /fetch failed|socket|ECONNRESET/i.test(String(err.message)), String(err.message));
    }
  } finally {
    await b.close();
  }

  const failed = results.filter((x) => !x.ok);
  if (failed.length) {
    console.error(`\nGATE M14 FAIL: ${results.length - failed.length}/${results.length} 项通过`);
    for (const f of failed) console.error(`  - ${f.name} ${f.detail}`);
    process.exit(1);
  }
  console.log(`\nGATE M14 PASS: ${results.length}/${results.length} 项通过`);
}

main().catch((err) => {
  console.error('e2e_media 运行失败：', err?.message ?? err);
  process.exit(1);
});
