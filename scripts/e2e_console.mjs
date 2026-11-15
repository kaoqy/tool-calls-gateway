// M15 控制台端到端：概览指标 + 请求测试台 + 鉴权，全部走真实 HTTP。
//
//   node scripts/e2e_console.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, requestJson } from './lib/harness.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';

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

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-console-'));
  const s = await startStack({ gwEnv: { LOG_LEVEL: 'warn', DEFAULT_MODEL: '', MODEL_MAP: '', DATA_DIR: dataDir } });
  try {
    const setup = await requestJson(`${s.baseUrl}/admin/api/setup`, {
      method: 'POST',
      body: {
        username: 'admin',
        password: 'console-test-password',
        upstreamBaseUrl: s.mockUrl,
        upstreamApiKey: 'sk-mock',
        defaultModel: 'mock-tool',
      },
    });
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0];
    check('初始化成功', setup.status === 201, `status=${setup.status}`);

    // 鉴权：没会话拿不到指标
    const anon = await requestJson(`${s.baseUrl}/admin/api/metrics`);
    check('概览需要登录（401）', anon.status === 401, `status=${anon.status}`);

    // 造三类流量：纯文本 / 带工具 / 带图片
    await requestJson(`${s.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: { model: 'mock-text', messages: [{ role: 'user', content: '北京天气？' }] },
    });
    await requestJson(`${s.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: { model: 'mock-tool', messages: [{ role: 'user', content: '帮我查天气' }], tools },
    });
    await requestJson(`${s.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: {
        model: 'mock-tool',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '描述这张图' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
            ],
          },
        ],
        tools,
      },
    });

    const metrics = await requestJson(`${s.baseUrl}/admin/api/metrics?limit=10`, { headers: { cookie } });
    check('概览接口 200', metrics.status === 200, metrics.text.slice(0, 120));
    const sum = metrics.json?.summary ?? {};
    check('请求数已累计（≥3）', (sum.requests ?? 0) >= 3, `requests=${sum.requests}`);
    check('模拟请求计数正确（≥2）', (sum.simulated ?? 0) >= 2, `simulated=${sum.simulated}`);
    check('工具命中计数（≥2）', (sum.toolHit ?? 0) >= 2, `toolHit=${sum.toolHit}`);
    check('媒体计数（≥1 张图）', (sum.images ?? 0) >= 1, `images=${sum.images}`);
    check('延迟分位可用', typeof sum.p50Ms === 'number' && typeof sum.p95Ms === 'number', `p50=${sum.p50Ms} p95=${sum.p95Ms}`);
    check('运行时长可读', /ms|s|m|h/.test(String(sum.uptime)), String(sum.uptime));

    const recent = metrics.json?.recent ?? [];
    check('最近请求列表非空', recent.length >= 3, `rows=${recent.length}`);
    check('最近一条是最新的（新的在前）', recent[0]?.images >= 1, `images=${recent[0]?.images}`);
    const leaks = ['北京天气', '帮我查天气', '描述这张图', 'base64,', 'sk-mock'];
    const flat = JSON.stringify(metrics.json);
    const leaked = leaks.filter((x) => flat.includes(x));
    check('指标里不含提示词/图片/密钥', leaked.length === 0, leaked.join(','));

    // 测试台：模拟模式
    const pgSim = await requestJson(`${s.baseUrl}/admin/api/playground`, {
      method: 'POST',
      headers: { cookie },
      body: { request: { model: 'mock-tool', messages: [{ role: 'user', content: '北京天气？' }], tools } },
    });
    check('测试台（模拟）200', pgSim.status === 200, pgSim.text.slice(0, 120));
    check('测试台返回 simulated=true', pgSim.json?.simulated === true);
    const tc = pgSim.json?.response?.choices?.[0]?.message?.tool_calls;
    check('测试台拿到标准 tool_calls', Array.isArray(tc) && tc.length >= 1 && tc[0].function?.name === 'get_weather', JSON.stringify(tc?.[0]?.function?.name));

    // 测试台：纯透传
    const pgPlain = await requestJson(`${s.baseUrl}/admin/api/playground`, {
      method: 'POST',
      headers: { cookie },
      body: { request: { model: 'mock-text', messages: [{ role: 'user', content: '你好' }] } },
    });
    check('测试台（透传）200', pgPlain.status === 200, pgPlain.text.slice(0, 120));
    check('测试台透传 simulated=false', pgPlain.json?.simulated === false);
    check(
      '测试台透传返回上游原始结构',
      typeof pgPlain.json?.response?.choices?.[0]?.message?.content === 'string',
      String(pgPlain.json?.response?.choices?.[0]?.message?.content ?? '').slice(0, 40),
    );

    // 测试台：非法 JSON
    const bad = await requestJson(`${s.baseUrl}/admin/api/playground`, {
      method: 'POST',
      headers: { cookie },
      body: { request: { messages: 'not-an-array' } },
    });
    check('测试台拒绝非法请求体（400）', bad.status === 400, `status=${bad.status}`);

    // 清零
    const reset = await requestJson(`${s.baseUrl}/admin/api/metrics/reset`, { method: 'POST', headers: { cookie } });
    check('清零成功', reset.status === 200 && reset.json?.summary?.requests === 0, `requests=${reset.json?.summary?.requests}`);

    // 设置页仍然正常（回归）
    const page = await requestJson(`${s.baseUrl}/admin`, { headers: { cookie } });
    check('设置页 200 且含概览/测试台', page.status === 200 && page.text.includes('id="overview"') && page.text.includes('id="playground"'));
  } finally {
    await s.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  const failed = results.filter((x) => !x.ok);
  if (failed.length) {
    console.error(`\nGATE M15 FAIL: ${results.length - failed.length}/${results.length} 项通过`);
    for (const f of failed) console.error(`  - ${f.name} ${f.detail}`);
    process.exit(1);
  }
  console.log(`\nGATE M15 PASS: ${results.length}/${results.length} 项通过`);
}

main().catch((err) => {
  console.error('e2e_console 运行失败：', err?.message ?? err);
  process.exit(1);
});
