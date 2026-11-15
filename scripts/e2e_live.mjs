// G9：真实上游联调（真实模型 + 本地真实工具执行）。
// 默认 dry-run（只打印计划，不花钱）；--live 才真打。
//
//   node scripts/e2e_live.mjs --live            # 默认 3 轮预算
//   node scripts/e2e_live.mjs --live --model deepseek-web-flash
//   LOG_LEVEL=debug node scripts/e2e_live.mjs --live   # 打印注入后的完整上游 prompt
//
// 真实工具：get_time（取系统时间）+ read_file（读本地 package.json，不联网）
import fs from 'node:fs';
import path from 'node:path';
import { requestJson, sleep, readLog, ROOT } from './lib/harness.mjs';
import { parseFlags, loadDotEnv, createBudget, startLiveGateway, maskSecret } from './lib/live.mjs';

const flags = parseFlags();
const LIVE = flags.live;
const ROUNDS = Number.isFinite(flags.runs) ? flags.runs : 3; // --rounds 与 --runs 等价
const argv = process.argv.slice(2);
const roundsIdx = argv.indexOf('--rounds');
const MAX_ROUNDS = roundsIdx >= 0 ? Number.parseInt(argv[roundsIdx + 1], 10) : ROUNDS;
const MAX_LIVE_CALLS = Number.parseInt(process.env.MAX_LIVE_CALLS ?? '40', 10);

if (LIVE) loadDotEnv();
const MODEL = process.env.MODEL || process.env.LIVE_MODEL || 'deepseek-web-flash';

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: '获取指定 IANA 时区的当前时间',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string', description: 'IANA 时区名，如 Asia/Shanghai' } },
        required: ['timezone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作目录下的文本文件（只读，路径必须在工作目录内）',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对路径，例如 package.json' } },
        required: ['path'],
      },
    },
  },
];

/** 真实执行工具（脚本本地，不经网络） */
function runTool(name, args) {
  if (name === 'get_time') {
    const tz = args?.timezone || 'Asia/Shanghai';
    return JSON.stringify({ timezone: tz, now: new Date().toLocaleString('zh-CN', { timeZone: tz }) });
  }
  if (name === 'read_file') {
    const rel = String(args?.path ?? '');
    const abs = path.resolve(ROOT, rel);
    if (!abs.startsWith(ROOT)) return JSON.stringify({ error: '路径越界，已拒绝' });
    if (!fs.existsSync(abs)) return JSON.stringify({ error: `文件不存在: ${rel}` });
    const text = fs.readFileSync(abs, 'utf8');
    return text.slice(0, 2000);
  }
  return JSON.stringify({ error: `未知工具: ${name}` });
}

function printInjectedPrompt(child) {
  if ((process.env.LOG_LEVEL ?? '') !== 'debug') return;
  const log = readLog(child);
  const lines = log.split('\n').filter((l) => l.includes('upstream prompt'));
  if (!lines.length) {
    console.log('  [debug] 网关日志里没有找到 upstream prompt（LOG_LEVEL 是否传给了网关？）');
    return;
  }
  const last = lines.at(-1);
  console.log('\n  [debug] 注入后的上游 prompt（截断 3000 字符，已脱敏）:');
  console.log(`  ${maskSecret(last).slice(0, 3000)}\n`);
}

async function main() {
  const budget = createBudget({ limit: MAX_LIVE_CALLS, label: 'e2e-live' });

  if (!LIVE) {
    console.log('E2E LIVE DRY-RUN（不会调用真实上游）');
    console.log(`  模型: ${MODEL}`);
    console.log(`  工具: ${tools.map((t) => t.function.name).join(', ')}`);
    console.log(`  轮次上限: ${MAX_ROUNDS}（每轮 1 次真实调用）`);
    console.log('  用 --live 才真打：node scripts/e2e_live.mjs --live');
    return 0;
  }

  const gw = await startLiveGateway({ logLevel: process.env.LOG_LEVEL ?? 'info' });
  const started = Date.now();
  const messages = [
    {
      role: 'user',
      content: '请先调用 get_time 查询上海时间，再调用 read_file 读取 package.json，然后用一句话总结这两件事。',
    },
  ];
  const trace = [];
  let toolCalls = 0;
  let final = null;
  let blocked = null;

  try {
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      budget.spend(`round#${round}`);
      const t0 = Date.now();
      const res = await requestJson(`${gw.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        body: { model: MODEL, messages, tools, temperature: 0.2 },
      });
      const ms = Date.now() - t0;
      if (res.status >= 400) {
        blocked = res.status;
        console.log(`第 ${round} 轮: 上游拒绝 HTTP ${res.status}: ${maskSecret(res.text).slice(0, 200)}`);
        break;
      }
      if (round === 1) printInjectedPrompt(gw.child);

      const choice = res.json.choices?.[0];
      const calls = (choice?.message?.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      }));
      console.log(
        `第 ${round} 轮 (${ms}ms): finish=${choice?.finish_reason} tool_calls=${calls.length}${
          calls.length ? ` [${calls.map((c) => c.name).join(', ')}]` : ''
        }`,
      );

      if (!calls.length) {
        final = choice?.message?.content ?? '';
        trace.push(`round${round}: final`);
        break;
      }

      toolCalls += calls.length;
      messages.push({
        role: 'assistant',
        content: choice?.message?.content ?? null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      });
      for (const c of calls) {
        let output;
        let args = {};
        try {
          args = JSON.parse(c.arguments || '{}');
        } catch {
          output = JSON.stringify({ error: 'arguments 不是合法 JSON' });
        }
        if (output === undefined) output = runTool(c.name, args);
        console.log(`    → ${c.name}(${c.arguments.slice(0, 120)}) = ${String(output).slice(0, 160)}`);
        messages.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: output });
      }
      trace.push(`round${round}: ${calls.map((c) => c.name).join(',')}`);
    }

    if (blocked) {
      console.log(`\nE2E LIVE: BLOCKED — 上游返回 HTTP ${blocked}（人机验证/限流），本轮未完成验证；网关透传正常。`);
      return 3;
    }
    if (!final) throw new Error(`跑满 ${MAX_ROUNDS} 轮仍未给出最终答案（工具调用 ${toolCalls} 次）`);
    if (!String(final).trim()) throw new Error('最终答案为空');
    if (toolCalls === 0) throw new Error('整个循环里没有发生任何工具调用（提示词模拟未命中）');

    const total = Date.now() - started;
    console.log(`\n最终答案: ${String(final).slice(0, 400)}`);
    console.log(`E2E LIVE: PASS model=${MODEL} 工具调用=${toolCalls} 轮次=${trace.length} 总耗时=${total}ms liveCalls=${budget.used}/${budget.limit}`);
    return 0;
  } catch (err) {
    console.log(`\nE2E LIVE: FAIL — ${err.message}`);
    return 1;
  } finally {
    await gw.close();
    await sleep(30);
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    if (err?.code === 'NO_CREDENTIALS') {
      console.error(`E2E LIVE: SKIP — ${err.message}`);
      process.exit(2);
    }
    console.error(`E2E LIVE: ERROR — ${maskSecret(err.stack ?? err.message)}`);
    process.exit(1);
  });
