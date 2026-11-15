// G1：无 tools 的透传基线。
// 断言：① 非流式响应体 == 直连 mock  ② 流式 chunk 序列 == 直连 mock
//       ③ 上游 429 → 客户端 429 且 body 一致  ④ /v1/models 一致
// 说明：网关不转发 query/自定义头，因此用 model 名（mock-text / mock-error-429）选择 mock 模式。
import { startStack, requestJson, requestSse, fail } from './lib/harness.mjs';

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
const { baseUrl, mockUrl } = stack;

const mkBody = (model, extra = {}) => ({
  model,
  temperature: 0.3,
  max_tokens: 64,
  messages: [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
  ],
  ...extra,
});

try {
  await check('① 非流式响应体逐字节一致', async () => {
    const body = mkBody('mock-text');
    const direct = await requestJson(`${mockUrl}/v1/chat/completions`, { method: 'POST', body });
    const via = await requestJson(`${baseUrl}/v1/chat/completions`, { method: 'POST', body });
    if (via.status !== 200) fail(`网关状态码 ${via.status}`, via.text);
    if (via.text !== direct.text) fail('响应体与直连 mock 不一致', `direct=${direct.text}\nvia=${via.text}`);
    if (via.json?.echo?.has_tools !== false) fail('透传后 mock 看到 has_tools=true，说明请求被改写');
  });

  await check('② 流式 chunk 序列与直连 mock 一致', async () => {
    const body = mkBody('mock-text', { stream: true });
    const direct = await requestSse(`${mockUrl}/v1/chat/completions`, { body });
    const via = await requestSse(`${baseUrl}/v1/chat/completions`, { body });
    if (via.status !== 200) fail(`网关状态码 ${via.status}`);
    const d = direct.events.map((e) => e.data);
    const v = via.events.map((e) => e.data);
    if (d.length === 0) fail('直连 mock 没有收到任何 SSE 事件');
    if (d.join('|') !== v.join('|')) fail('SSE data 序列不一致', `direct=${d.join('|')}\nvia=${v.join('|')}`);
    if (v.at(-1) !== '[DONE]') fail(`最后一个事件应为 [DONE]，实际 ${v.at(-1)}`);
  });

  await check('③ 上游 429 原样透传状态码与 body', async () => {
    const body = mkBody('mock-error-429');
    const direct = await requestJson(`${mockUrl}/v1/chat/completions`, { method: 'POST', body });
    const via = await requestJson(`${baseUrl}/v1/chat/completions`, { method: 'POST', body });
    if (direct.status !== 429) fail(`mock 自身没返回 429，而是 ${direct.status}`);
    if (via.status !== 429) fail(`网关返回 ${via.status}，期望 429`, via.text);
    if (via.text !== direct.text) fail('429 body 不一致', `direct=${direct.text}\nvia=${via.text}`);
  });

  await check('④ /v1/models 透传一致', async () => {
    const direct = await requestJson(`${mockUrl}/v1/models`);
    const via = await requestJson(`${baseUrl}/v1/models`);
    if (via.status !== 200) fail(`网关状态码 ${via.status}`);
    if (via.text !== direct.text) fail('模型列表与上游不一致', `direct=${direct.text}\nvia=${via.text}`);
  });
} finally {
  await stack.close();
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n--- 子进程日志 ---\n${stack.logs()}`);
  console.log(`GATE M1 FAIL: ${failed.length}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`GATE M1 PASS: ${results.length}/${results.length} 项通过`);
