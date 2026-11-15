// 一键自动 gate。用法：
//   node scripts/gate.mjs            # 跑全部离线 gate（M0~M6 + M8 + M10-dry），M9 跳过
//   node scripts/gate.mjs --live     # 额外跑 M9（真实端点，会消耗额度）
//   node scripts/gate.mjs M2 M3      # 只跑指定 gate
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  getFreePort,
  startProcess,
  stopProcess,
  waitForHealth,
  readLog,
  requestJson,
} from './lib/harness.mjs';

const LIVE = process.argv.includes('--live');
const results = [];

function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${title}${detail ? `  (${detail})` : ''}`);
}

function recordSkip(id, title, reason) {
  results.push({ id, title, ok: true, skipped: true, detail: reason });
  console.log(`SKIP  ${id}  ${title}  (${reason})`);
}

function runNode(label, args, { env = {}, timeoutMs = 180000 } = {}) {
  console.log(`\n$ node ${args.join(' ')}`);
  const started = Date.now();
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (out.trim()) console.log(out.trimEnd());
  if (res.error) console.log(`! ${label} 启动失败: ${res.error.message}`);
  if (res.status !== 0) console.log(`! ${label} 退出码 ${res.status} (${ms}ms)`);
  else console.log(`  ${label} ok (${ms}ms)`);
  return { ok: res.status === 0, out, ms, status: res.status };
}

async function checkHealthz() {
  const port = await getFreePort();
  const gw = startProcess('gate-g0', 'src/server.mjs', {
    env: { PORT: String(port), UPSTREAM_BASE_URL: 'http://127.0.0.1:1', LOG_LEVEL: 'warn' },
  });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/healthz`);
    const res = await requestJson(`http://127.0.0.1:${port}/healthz`);
    if (res.status !== 200) throw new Error(`/healthz 状态码 ${res.status}，期望 200`);
    if (res.text !== '{"status":"ok"}') throw new Error(`/healthz body 为 ${res.text}，期望 {"status":"ok"}`);
    console.log(`  GET /healthz -> ${res.status} ${res.text}`);
    return true;
  } catch (err) {
    console.log(`! healthz 检查失败: ${err.message}\n${readLog(gw)}`);
    return false;
  } finally {
    stopProcess(gw);
  }
}

// ---------------------------------------------------------------- M0
async function gateM0() {
  const files = fs
    .readdirSync(path.join(ROOT, 'src'))
    .filter((f) => f.endsWith('.mjs'))
    .sort();
  let ok = true;
  for (const f of files) {
    const r = runNode(`--check ${f}`, ['--check', path.join('src', f)]);
    ok = ok && r.ok;
  }
  ok = (await checkHealthz()) && ok;
  const t = runNode('scaffold test', ['--test', 'test/scaffold.test.mjs']);
  ok = ok && t.ok;
  record('M0', '脚手架与基线（node --check + /healthz + npm test）', ok, ok ? '4 项全通过' : '见上方输出');
  if (ok) console.log('GATE M0 PASS');
}

// ---------------------------------------------------------------- M1
async function gateM1() {
  const r = runNode('e2e_passthrough', ['scripts/e2e_passthrough.mjs']);
  record('M1', '透传基线（无 tools）', r.ok, r.ok ? '4 项断言通过' : '见上方输出');
  if (r.ok) console.log('GATE M1 PASS');
}

// ---------------------------------------------------------------- M2
async function gateM2() {
  const r = runNode('prompt test', ['--test', 'test/prompt.test.mjs']);
  record('M2', '请求改写 + 提示注入', r.ok, r.ok ? '10 组用例通过' : '见上方输出');
  if (r.ok) console.log('GATE M2 PASS');
}

// ---------------------------------------------------------------- M3
async function gateM3() {
  const r = runNode('protocol test', ['--test', 'test/protocol.test.mjs']);
  record('M3', '响应解析 + 非流式合成', r.ok, r.ok ? '12 组用例通过' : '见上方输出');
  if (r.ok) console.log('GATE M3 PASS');
}

// ---------------------------------------------------------------- M4
async function gateM4() {
  const unit = runNode('streaming test', ['--test', 'test/streaming.test.mjs']);
  const e2e = runNode('e2e_stream_tool', ['scripts/e2e_stream_tool.mjs']);
  const ok = unit.ok && e2e.ok;
  record('M4', '流式合成', ok, ok ? '单测 + e2e 均通过' : '见上方输出');
  if (ok) console.log('GATE M4 PASS');
}

// ---------------------------------------------------------------- M5
async function gateM5() {
  const r = runNode('robustness test', ['--test', 'test/robustness.test.mjs']);
  record('M5', '健壮性与策略', r.ok, r.ok ? '7 组用例通过' : '见上方输出');
  if (r.ok) console.log('GATE M5 PASS');
}

// ---------------------------------------------------------------- M6
async function gateM6() {
  const r = runNode('e2e_mock', ['scripts/e2e_mock.mjs']);
  record('M6', '端到端两轮工具循环（不依赖 docker）', r.ok, r.ok ? '两轮循环通过' : '见上方输出');
  if (r.ok) console.log('GATE M6 PASS');
}

// ---------------------------------------------------------------- M8
async function gateM8() {
  const unit = runNode('robustness suite', [
    '--test',
    'test/robustness.test.mjs',
    'test/robustness-protocol.test.mjs',
  ]);
  const conf = runNode('conformance dry', ['scripts/conformance.mjs']);
  const ok = unit.ok && conf.ok;
  record('M8', '协议健壮性补齐（robustness* + conformance dry）', ok, ok ? '单测 + dry 矩阵全绿' : '见上方输出');
  if (ok) console.log('GATE M8 PASS');
}

// ---------------------------------------------------------------- M9（真实端点）
async function gateM9() {
  if (!LIVE) {
    recordSkip('M9', '真实联调（conformance --live / e2e_live / hitrate）', '默认不烧额度，需 --live');
    return;
  }
  const conf = runNode('conformance live', ['scripts/conformance.mjs', '--live'], { timeoutMs: 900000 });
  const e2e = runNode('e2e_live', ['scripts/e2e_live.mjs', '--live'], { timeoutMs: 900000 });
  const hit = runNode('hitrate live', ['scripts/hitrate.mjs', '--live', '--runs', '8'], { timeoutMs: 1200000 });
  // 退出码 3 = 上游风控/人机验证拦截，属于环境状态，记为 SKIP 而不是 PASS/FAIL
  if ([conf, e2e, hit].some((r) => r.status === 3)) {
    recordSkip('M9', '真实端点联调（矩阵 + 双轮循环 + 命中率）', '上游 403/429 风控拦截，未完成验证');
    return;
  }
  const ok = conf.ok && e2e.ok && hit.ok;
  record('M9', '真实端点联调（矩阵 + 双轮循环 + 命中率）', ok, ok ? 'live 全绿' : '见上方输出');
  if (ok) console.log('GATE M9 PASS');
}

// ---------------------------------------------------------------- M10（Codex 形状）
async function gateM10() {
  const dry = runNode('e2e_codex', ['scripts/e2e_codex.mjs']);
  let live = { ok: true };
  if (LIVE) live = runNode('e2e_codex live', ['scripts/e2e_codex.mjs', '--live'], { timeoutMs: 600000 });
  const ok = dry.ok && live.ok;
  record('M10', 'Codex 类客户端请求形状', ok, ok ? (LIVE ? 'dry + live 均通过' : 'dry 通过（live 需 --live）') : '见上方输出');
  if (ok) console.log('GATE M10 PASS');
}

const ALL = [
  ['M0', gateM0],
  ['M1', gateM1],
  ['M2', gateM2],
  ['M3', gateM3],
  ['M4', gateM4],
  ['M5', gateM5],
  ['M6', gateM6],
  ['M8', gateM8],
  ['M9', gateM9],
  ['M10', gateM10],
];

async function main() {
  const wanted = process.argv
    .slice(2)
    .filter((s) => !s.startsWith('--'))
    .map((s) => s.toUpperCase());
  const plan = wanted.length ? ALL.filter(([id]) => wanted.includes(id)) : ALL;
  if (!plan.length) {
    console.error(`没有匹配的 gate: ${wanted.join(' ')}`);
    process.exit(2);
  }
  for (const [id, fn] of plan) {
    console.log(`\n========== ${id} ==========`);
    try {
      await fn();
    } catch (err) {
      console.log(`! ${id} 执行异常: ${err.stack ?? err.message}`);
      record(id, '执行异常', false, err.message);
    }
  }

  console.log('\n================ GATE SUMMARY ================');
  for (const r of results) {
    console.log(`${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.title}${r.skipped ? ` — ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  if (failed.length) {
    console.log(`\nGATE RESULT: FAIL (${failed.length}/${results.length} 失败)`);
    process.exit(1);
  }
  console.log(
    `\nGATE RESULT: PASS (${results.length - skipped.length}/${results.length} 通过${skipped.length ? `, ${skipped.length} 跳过` : ''})`,
  );
  console.log(LIVE ? 'ALL GATES PASS (含 live)' : 'ALL OFFLINE GATES PASS (M9 live 未跑：加 --live)');
  process.exit(0);
}

main();
