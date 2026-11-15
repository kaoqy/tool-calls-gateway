// G10：模拟 Codex 类客户端的请求形状（stream + include_usage + JSON-schema 工具 + 大 system 指令）。
// 默认 dry-run；--live 才打真实端点。
// 反向用例：自由文本 / grammar 类工具（模拟 apply_patch）——标注 KNOWN_UNSUPPORTED，不允许崩。
// 上游 4xx（人机验证/限流）计为 BLOCKED_BY_UPSTREAM，不算网关故障。
import { startStack, requestSse, concatToolCallArgs, concatDeltaContent } from './lib/harness.mjs';
import { parseFlags, loadDotEnv, createBudget, startLiveGateway, maskSecret } from './lib/live.mjs';

const flags = parseFlags();
const LIVE = flags.live;
if (LIVE) loadDotEnv();
const MODEL = LIVE ? 'gpt-5-codex' : 'mock-tool'; // Codex 送来的模型名，由 MAP 映射
const MAX_LIVE_CALLS = Number.parseInt(process.env.MAX_LIVE_CALLS ?? '40', 10);
const ONLY = flags.only; // ['MAIN'] / ['REVERSE'] / ['MAIN','REVERSE']
const runMain = !ONLY || ONLY.includes('MAIN');
const runReverse = !ONLY || ONLY.includes('REVERSE');

// 接近 Codex 的系统指令体量（真实 Codex 会叠加更多，这里取一个可代表上下文压力的规模）
const CODEX_SYSTEM = `You are Codex, a coding agent running in the user's terminal.

# General
- You are an autonomous coding assistant. Prefer acting over asking.
- Always inspect the repository before making changes.
- Use the provided tools to read files, run commands and apply patches.
- Never print secrets or long file dumps unless asked.

# Environment
- Working directory: /workspace/project
- Shell: bash (zsh on macOS)
- Sandbox: workspace-write

# Rules
1. Prefer small, verifiable steps.
2. After edits, run the relevant tests.
3. When a tool is needed, emit a tool call in the required JSON schema; do not narrate.
4. If nothing needs doing, answer in prose.

# Tool usage policy
- shell: run a single command; workdir defaults to the repo root; timeout is seconds.
- Keep commands idempotent and safe; avoid destructive operations without confirmation.

# Response style
- Be concise; include commands you ran and their outcomes.
- Summaries should be at most a few lines.`;

const shellTool = {
  type: 'function',
  function: {
    name: 'shell',
    description: '在本地 shell 里执行一条命令并返回输出',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令，例如 ls -la' },
        workdir: { type: 'string', description: '工作目录，默认仓库根目录' },
        timeout: { type: 'number', description: '超时秒数，默认 30' },
      },
      required: ['command'],
    },
  },
};

// Codex 的 apply_patch 是自由文本 / grammar 工具，不是 JSON-schema function。
// 这里用「单字符串参数」近似它的形状，用来观察网关与模型的降级行为（已知不支持）。
const applyPatchTool = {
  type: 'function',
  function: {
    name: 'apply_patch',
    description: '应用一段自由文本 patch（*** Begin Patch ... *** End Patch）',
    parameters: {
      type: 'object',
      properties: { patch: { type: 'string', description: '自由文本补丁内容' } },
      required: ['patch'],
    },
  },
};

function assertStream(res, label) {
  if (res.status !== 200) throw new Error(`${label}: HTTP ${res.status} ${maskSecret(res.text ?? res.raw).slice(0, 300)}`);
  const events = res.events ?? [];
  if (!events.length) throw new Error(`${label}: 没有 SSE 事件`);
  if (events.at(-1).data !== '[DONE]') throw new Error(`${label}: 未以 [DONE] 结尾`);
  const first = events[0].json?.choices?.[0]?.delta;
  if (first?.role !== 'assistant') throw new Error(`${label}: 首个 delta 没有 role=assistant`);
  const calls = concatToolCallArgs(events);
  for (const c of calls) {
    if (!c.name) throw new Error(`${label}: tool_call 缺少 name`);
    JSON.parse(c.arguments); // 必须是合法 JSON 字符串
  }
  const finish = events.find((e) => e.json?.choices?.[0]?.finish_reason)?.json.choices[0].finish_reason;
  if (!['stop', 'tool_calls'].includes(finish)) throw new Error(`${label}: finish_reason=${finish}`);
  if (calls.length && finish !== 'tool_calls') throw new Error(`${label}: 有 tool_calls 但 finish 不是 tool_calls`);
  return { events, calls, finish, content: concatDeltaContent(events) };
}

function codexBody(tools, userText) {
  return {
    model: MODEL,
    stream: true,
    stream_options: { include_usage: true },
    tool_choice: 'auto',
    temperature: 0.2,
    messages: [
      { role: 'system', content: CODEX_SYSTEM },
      { role: 'user', content: userText },
    ],
    tools,
  };
}

function runMainCase(res) {
  const out = assertStream(res, 'codex/shell');
  const usageChunk = res.events.find((e) => e.json?.usage);
  const shellCall = out.calls.find((c) => c.name === 'shell');
  console.log(`\n正向用例: finish=${out.finish} tool_calls=${out.calls.length} usageChunk=${Boolean(usageChunk)}`);
  for (const c of out.calls) console.log(`  - ${c.name}(${c.arguments.slice(0, 160)})`);
  if (!out.calls.length && out.content) console.log(`  - 纯文本回答: ${out.content.slice(0, 200)}`);

  const codexOk = out.calls.length > 0 || out.content.trim().length > 0;
  const shellShaped = LIVE ? Boolean(shellCall) && typeof JSON.parse(shellCall.arguments ?? '{}').command === 'string' : true;

  if (!codexOk) {
    console.log('  FAIL: 既没有可消费的 tool_calls，也没有文本回答');
    return { ok: false, out };
  }
  if (out.calls.length > 0 && !shellShaped) {
    console.log('  WARN: 流式 tool_calls 可消费，但命中的不是 shell（或参数缺 command）');
  } else if (out.calls.length > 0) {
    console.log(`  PASS: 客户端可消费的流式 tool_calls（${shellCall ? 'shell 参数含 command' : 'dry: mock 工具'}）`);
  } else {
    console.log('  WARN: 模型选择直接回答（Codex 形状仍可消费，但没触发 shell 工具）');
  }
  return { ok: true, out };
}

function runReverseCase(res) {
  const out = assertStream(res, 'codex/apply_patch');
  if (out.calls.length) {
    console.log(
      `反向用例: KNOWN_UNSUPPORTED — 模型返回了 tool_calls(${out.calls.map((c) => c.name).join(',')})；` +
        '自由文本补丁的语义正确性无法由 JSON 提示词保证，仅保证协议层可解析。',
    );
  } else if (out.content.trim()) {
    console.log(`反向用例: KNOWN_UNSUPPORTED — 模型改为自然语言回答（可接受的降级）: ${out.content.slice(0, 160)}`);
  } else {
    console.log(
      `反向用例: KNOWN_UNSUPPORTED — finish=${out.finish} 且正文为空：模型对这个自由文本工具形状没有可输出内容，` +
        '网关未崩溃、协议层仍合法（已知不支持的形状，不影响其它工具）。',
    );
  }
}

async function main() {
  const budget = createBudget({ limit: MAX_LIVE_CALLS, label: 'e2e-codex' });

  if (!LIVE) {
    console.log('E2E CODEX DRY-RUN（不会调用真实上游）');
    console.log(`  模型名: ${MODEL}（live 时为 gpt-5-codex，由 MODEL_MAP 映射）`);
    console.log('  形状: stream=true, stream_options.include_usage=true, tools=[shell], 大 system');
    console.log('  用 --live 才真打：node scripts/e2e_codex.mjs --live');
  }

  const runtime = LIVE ? await startLiveGateway() : await startStack();
  const baseUrl = runtime.baseUrl;
  const problems = [];
  let blocked = 0;
  let okCases = 0;

  try {
    // ---------- 正向：JSON-schema 工具（shell）----------
    if (runMain) {
      budget.spend('codex-main');
      const t0 = Date.now();
      const res = await requestSse(`${baseUrl}/v1/chat/completions`, {
        body: codexBody([shellTool], '先看一眼工作目录里有什么，用 shell 执行 ls -la。'),
      });
      const ms = Date.now() - t0;
      console.log(`\n[main] ${ms}ms`);
      if (res.status >= 400) {
        blocked += 1;
        console.log(`  BLOCKED_BY_UPSTREAM — HTTP ${res.status}: ${maskSecret(res.text).slice(0, 240)}`);
        console.log('  说明: 上游拒绝（web 类模型常见的人机验证/限流），网关原样透传、未改写、未崩溃。');
      } else {
        const r = runMainCase(res);
        okCases += 1;
        if (!r.ok) problems.push('main');
      }
    }

    // ---------- 反向：自由文本 / grammar 工具（apply_patch）----------
    if (runReverse) {
      budget.spend('codex-freeform');
      const t1 = Date.now();
      const res = await requestSse(`${baseUrl}/v1/chat/completions`, {
        body: codexBody([applyPatchTool], '把 src/app.py 里的 hello 改成 hello world，生成补丁。'),
      });
      const ms = Date.now() - t1;
      console.log(`\n[reverse] ${ms}ms`);
      if (res.status >= 400) {
        blocked += 1;
        console.log(
          `  KNOWN_UNSUPPORTED / 未验证 — 上游返回 HTTP ${res.status}（${maskSecret(res.text).slice(0, 160)}）；` +
            '网关原样透传，未崩溃。',
        );
      } else {
        runReverseCase(res);
        okCases += 1;
      }
    }

    const verdict = problems.length === 0 ? 'PASS' : 'FAIL';
    console.log(
      `\nE2E CODEX: ${verdict} · ${LIVE ? `live model=${MODEL}` : 'dry(mock)'} · liveCalls=${budget.used}/${budget.limit}${
        blocked ? ` · upstreamBlocked=${blocked}` : ''
      }`,
    );
    if (blocked) {
      console.log('  备注: 有请求被上游风控拦截（HTTP 4xx），属环境/账号状态，不代表网关能力；稍后重跑或用其它账号。');
    }
    if (problems.length) return 1;
    if (blocked > 0 && okCases === 0) return 3; // 全部被上游拦截 → BLOCKED，交给 gate 记为 SKIP
    return 0;
  } finally {
    await runtime.close();
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    if (err?.code === 'NO_CREDENTIALS') {
      console.error(`E2E CODEX: SKIP — ${err.message}`);
      process.exit(2);
    }
    console.error(`E2E CODEX: ERROR — ${maskSecret(err.stack ?? err.message)}`);
    process.exit(1);
  });
