// 提示词模拟「命中率」压测：同一"该调工具"的 prompt 打 N 次，统计可解析命中率与 P50/P95。
// 默认 dry-run（只打印计划）；--live 才真打，并受 MAX_LIVE_CALLS 限制。
// 阈值：简单工具 ≥90% PASS，复杂工具 ≥70% PASS，低于记 WARN 并打印失败样例。
import { requestJson, sleep } from './lib/harness.mjs';
import {
  parseFlags,
  loadDotEnv,
  createBudget,
  startLiveGateway,
  writeReports,
  maskSecret,
} from './lib/live.mjs';

const flags = parseFlags();
const LIVE = flags.live;
const RUNS = Number.isFinite(flags.runs) && flags.runs > 0 ? flags.runs : 20;
if (LIVE) loadDotEnv();
const MODEL = process.env.LIVE_MODEL || process.env.DEFAULT_MODEL || 'deepseek-web-flash';
const MAX_LIVE_CALLS = Number.parseInt(process.env.MAX_LIVE_CALLS ?? '40', 10);
const LIVE_DELAY_MS = Number.parseInt(process.env.LIVE_DELAY_MS ?? '2000', 10);

const TIERS = [
  {
    id: 'simple',
    name: '简单工具（单参）',
    threshold: 0.9,
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查询指定城市的实时天气',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string', description: '城市名，例如 北京' } },
            required: ['city'],
          },
        },
      },
    ],
    prompt: '帮我看下北京现在的天气，用 get_weather 工具查。',
    expectedTool: 'get_weather',
    validate: (args) => typeof args?.city === 'string' && args.city.length > 0,
    requiredKeys: 'city',
  },
  {
    id: 'complex',
    name: '复杂工具（嵌套 + 枚举）',
    threshold: 0.7,
    tools: [
      {
        type: 'function',
        function: {
          name: 'create_order',
          description: '创建订单',
          parameters: {
            type: 'object',
            properties: {
              customer: {
                type: 'object',
                properties: { name: { type: 'string' }, phone: { type: 'string' } },
                required: ['name', 'phone'],
              },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { sku: { type: 'string' }, qty: { type: 'integer' } },
                  required: ['sku', 'qty'],
                },
              },
              priority: { type: 'string', enum: ['low', 'normal', 'high'] },
            },
            required: ['customer', 'items', 'priority'],
          },
        },
      },
    ],
    prompt: '帮我下单：客户张三，电话 13800000000，商品显示器 2 台，优先级 high。请调用 create_order。',
    expectedTool: 'create_order',
    validate: (args) =>
      typeof args?.customer?.name === 'string' &&
      Array.isArray(args?.items) &&
      args.items.length > 0 &&
      ['low', 'normal', 'high'].includes(args?.priority),
    requiredKeys: 'customer.name / items[] / priority',
  },
];

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(tier, samples) {
  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const hits = samples.filter((s) => s.hit).length;
  const rate = samples.length ? hits / samples.length : 0;
  return {
    tier: tier.id,
    name: tier.name,
    runs: samples.length,
    hits,
    rate,
    threshold: tier.threshold,
    pass: rate >= tier.threshold,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    failureSamples: samples.filter((s) => !s.hit).slice(0, 5),
  };
}

async function main() {
  const budget = createBudget({ limit: MAX_LIVE_CALLS, label: `hitrate-${LIVE ? 'live' : 'dry'}` });
  const plan = TIERS.reduce((n, t) => n + RUNS, 0);

  if (!LIVE) {
    console.log(`HITRATE DRY-RUN（不会调用真实上游）`);
    console.log(`  模型: ${MODEL}`);
    console.log(`  计划: ${TIERS.length} 档 × ${RUNS} 次 = ${plan} 次真实调用`);
    console.log(`  上限: MAX_LIVE_CALLS=${MAX_LIVE_CALLS}`);
    for (const t of TIERS) {
      console.log(`  - ${t.id}: ${t.name}，阈值 ${(t.threshold * 100).toFixed(0)}%，工具=${t.expectedTool}`);
    }
    console.log('  用 --live 才真正发请求（例如：node scripts/hitrate.mjs --live --runs 8）');
    return 0;
  }

  let gw = null;
  const reports = [];
  try {
    gw = await startLiveGateway();
    console.log(`HITRATE LIVE: model=${MODEL} runs=${RUNS}/tier budget=${MAX_LIVE_CALLS}\n`);

    for (const tier of TIERS) {
      const samples = [];
      let blocked = null;
      for (let i = 0; i < RUNS; i += 1) {
        budget.spend(`${tier.id}#${i + 1}`);
        await sleep(LIVE_DELAY_MS); // 节流：上游高频请求会退化为"直接回答"
        const started = Date.now();
        let res;
        try {
          res = await requestJson(`${gw.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            body: {
              model: MODEL,
              temperature: 0.7,
              messages: [{ role: 'user', content: tier.prompt }],
              tools: tier.tools,
              tool_choice: 'auto',
            },
          });
        } catch (err) {
          samples.push({ i, hit: false, ms: Date.now() - started, reason: `请求异常: ${err.message}` });
          continue;
        }
        const ms = Date.now() - started;
        if (res.status === 403 || res.status === 429) {
          blocked = res.status;
          break;
        }
        const choice = res.json?.choices?.[0];
        const calls = choice?.message?.tool_calls ?? [];
        const call = calls.find((c) => c.function?.name === tier.expectedTool);
        let hit = false;
        let reason = '';
        if (res.status !== 200) reason = `HTTP ${res.status}`;
        else if (choice?.finish_reason !== 'tool_calls') reason = `finish=${choice?.finish_reason}`;
        else if (!call) reason = `未调用 ${tier.expectedTool}`;
        else {
          try {
            const args = JSON.parse(call.function.arguments);
            hit = tier.validate(args);
            if (!hit) reason = `参数不完整（期望 ${tier.requiredKeys}）: ${String(call.function.arguments).slice(0, 160)}`;
          } catch {
            reason = `arguments 非法 JSON: ${String(call.function.arguments).slice(0, 160)}`;
          }
        }
        samples.push({ i, hit, ms, reason: reason ? maskSecret(reason) : '' });
        process.stdout.write(hit ? '.' : 'x');
      }
      process.stdout.write('\n');
      if (blocked) {
        console.log(`  BLOCKED ${tier.id}: 上游返回 HTTP ${blocked}（人机验证/限流），本档未完成统计`);
        console.log(`\nHITRATE BLOCKED · liveCalls=${budget.used}/${budget.limit}`);
        return 3;
      }
      const summary = summarize(tier, samples);
      reports.push(summary);
      console.log(
        `  ${summary.pass ? 'PASS' : 'WARN'} ${tier.id}: ${summary.hits}/${summary.runs} = ${(summary.rate * 100).toFixed(1)}% (阈值 ${(tier.threshold * 100).toFixed(0)}%) P50=${summary.p50}ms P95=${summary.p95}ms`,
      );
      for (const f of summary.failureSamples) {
        console.log(`    失败样例 #${f.i + 1} (${f.ms}ms): ${f.reason}`);
      }
    }

    const payload = {
      mode: 'live',
      generatedAt: new Date().toISOString(),
      model: MODEL,
      runsPerTier: RUNS,
      budget: budget.summary(),
      tierResults: reports,
    };
    const md = renderMd(payload);
    const { jsonPath, mdPath } = writeReports('hitrate-live', payload, md);
    const allPass = reports.every((r) => r.pass);
    console.log(`\nHITRATE ${allPass ? 'PASS' : 'WARN'} · liveCalls=${budget.used}/${budget.limit}`);
    console.log(`报告: ${jsonPath}\n      ${mdPath}`);
    return allPass ? 0 : 1;
  } finally {
    if (gw) await gw.close();
  }
}

function renderMd(p) {
  const lines = [
    '# 提示词模拟命中率',
    '',
    `- 时间: ${p.generatedAt}`,
    `- 模型: \`${p.model}\``,
    `- 每档次数: ${p.runsPerTier}`,
    `- 真实调用: ${p.budget.used} / ${p.budget.limit}`,
    '',
    '| 档位 | 次数 | 命中 | 命中率 | 阈值 | 结论 | P50 | P95 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of p.tierResults) {
    lines.push(
      `| ${r.name} | ${r.runs} | ${r.hits} | ${(r.rate * 100).toFixed(1)}% | ${(r.threshold * 100).toFixed(0)}% | ${r.pass ? 'PASS' : 'WARN'} | ${r.p50}ms | ${r.p95}ms |`,
    );
  }
  const fails = p.tierResults.flatMap((r) => r.failureSamples.map((f) => ({ tier: r.name, ...f })));
  if (fails.length) {
    lines.push('', '## 失败样例（脱敏）');
    for (const f of fails) lines.push(`- [${f.tier}] #${f.i + 1} (${f.ms}ms): ${f.reason}`);
  }
  lines.push('', '> 说明：命中 = finish_reason=tool_calls 且工具名、参数结构符合 schema；延迟为单次 HTTP 往返（含 buffer-then-synthesize 与网关开销）。');
  return lines.join('\n');
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    if (err?.code === 'NO_CREDENTIALS') {
      console.error(`HITRATE: SKIP — ${err.message}`);
      process.exit(2);
    }
    console.error(`HITRATE: ERROR — ${maskSecret(err.stack ?? err.message)}`);
    process.exit(1);
  });
