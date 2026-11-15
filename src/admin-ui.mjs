// 设置页（单文件 HTML，无构建、无外部 CDN、无第三方依赖）。
// 只做数据展示与表单提交，所有校验/持久化都在 /admin/api/* 里完成。

export function renderAdminHtml({ version = '' } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>toolcall-gateway · 设置</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --card:#171a21; --line:#2a2f3a; --text:#e7ecf3; --muted:#8b94a7; --accent:#4c8dff; --ok:#2ea043; --warn:#d29922; --err:#f85149; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --card:#fff; --line:#e3e6ea; --text:#1b1f24; --muted:#5b6472; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif; }
  header { padding:20px 24px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  header h1 { font-size:18px; margin:0; }
  header .meta { color:var(--muted); font-size:12px; }
  main { max-width:900px; margin:0 auto; padding:20px 24px 80px; display:grid; gap:16px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px 18px 6px; }
  section h2 { font-size:14px; margin:0 0 14px; display:flex; align-items:center; gap:8px; }
  .badge { font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid var(--line); color:var(--muted); font-weight:500; }
  .badge.file { color:#7ee787; border-color:#2ea04355; }
  .badge.env { color:#79c0ff; border-color:#1f6feb55; }
  .field { display:grid; grid-template-columns:220px 1fr; gap:10px 16px; align-items:center; padding:8px 0; border-top:1px dashed var(--line); }
  .field:first-of-type { border-top:0; }
  .field label { color:var(--muted); font-size:13px; }
  .field .hint { grid-column:2; color:var(--muted); font-size:12px; margin-top:-6px; }
  input[type=text], input[type=password], input[type=number], select, textarea {
    width:100%; background:transparent; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:inherit;
  }
  textarea { min-height:76px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; }
  input:focus, select:focus, textarea:focus { outline:2px solid var(--accent); outline-offset:1px; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  button { border:1px solid var(--line); background:transparent; color:var(--text); padding:8px 14px; border-radius:8px; cursor:pointer; font:inherit; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  button:disabled { opacity:.55; cursor:not-allowed; }
  .actions { position:sticky; bottom:0; background:linear-gradient(transparent,var(--bg) 30%); padding:14px 0 0; display:flex; gap:10px; align-items:center; }
  #log { white-space:pre-wrap; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; color:var(--muted); min-height:1.4em; flex:1; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .err { color:var(--err); }
  .kv { color:var(--muted); font-size:12px; word-break:break-all; }
  table.models { width:100%; border-collapse:collapse; font-size:12px; }
  table.models td, table.models th { border-top:1px solid var(--line); padding:4px 6px; text-align:left; }
  .tag { font-size:11px; border:1px solid var(--line); border-radius:6px; padding:0 6px; }
</style>
</head>
<body>
<header>
  <h1>toolcall-gateway 设置</h1>
  <span class="meta" id="ver">v${version}</span>
  <span class="meta" id="file"></span>
</header>
<main>
  <section>
    <h2>上游 <span class="badge" id="b-upstreamBaseUrl"></span></h2>
    <div class="field">
      <label for="upstreamBaseUrl">Base URL</label>
      <input id="upstreamBaseUrl" type="text" placeholder="https://api.deepseek.com 或 https://host/v1" spellcheck="false">
    </div>
    <div class="field">
      <label for="upstreamApiKey">API Key</label>
      <input id="upstreamApiKey" type="password" placeholder="留空 = 不修改；填入新值 = 覆盖" autocomplete="new-password">
      <div class="hint" id="hint-upstreamApiKey"></div>
    </div>
    <div class="field">
      <label for="defaultModel">默认模型</label>
      <input id="defaultModel" type="text" placeholder="deepseek-chat" spellcheck="false">
    </div>
    <div class="field">
      <label for="modelMap">模型映射</label>
      <textarea id="modelMap" placeholder='{"gpt-5-codex":"deepseek-chat"}' spellcheck="false"></textarea>
      <div class="hint">JSON 或 <code>from:to,from2:to2</code>。客户端送来的模型名会映射成这里的值。</div>
    </div>
    <div class="field">
      <label for="modelOverride">强制覆盖模型</label>
      <input id="modelOverride" type="text" placeholder="留空 = 不强制" spellcheck="false">
      <div class="hint">设置后所有请求都用这个上游模型（优先级高于映射）。</div>
    </div>
    <div class="row" style="margin:12px 0 16px">
      <button id="btn-test">测试连接（GET /models）</button>
      <button id="btn-models">列出模型</button>
    </div>
    <div id="models-box"></div>
  </section>

  <section>
    <h2>网关 <span class="badge" id="b-gatewayApiKey"></span></h2>
    <div class="field">
      <label for="gatewayApiKey">下游鉴权 Key</label>
      <input id="gatewayApiKey" type="password" placeholder="留空 = 允许任意下游 key" autocomplete="new-password">
      <div class="hint" id="hint-gatewayApiKey"></div>
    </div>
    <div class="field">
      <label for="toolMode">工具模拟模式</label>
      <select id="toolMode"><option value="auto">auto（含 tools 时模拟）</option><option value="off">off（完全透传）</option></select>
    </div>
    <div class="field">
      <label for="reasoningPassthrough">透传 reasoning</label>
      <select id="reasoningPassthrough"><option value="on">on</option><option value="off">off</option></select>
    </div>
    <div class="field">
      <label for="requestTimeoutMs">上游超时（毫秒）</label>
      <input id="requestTimeoutMs" type="number" min="1000" max="600000" step="1000">
    </div>
    <div class="field">
      <label for="maxBodyBytes">请求体上限（字节）</label>
      <input id="maxBodyBytes" type="number" min="1024" max="67108864" step="1024">
    </div>
  </section>

  <section>
    <h2>自检</h2>
    <div class="row">
      <button id="btn-tool">跑一次工具模拟自检（会消耗 1 次上游调用）</button>
    </div>
    <div class="kv" style="margin:10px 0 16px">用当前保存的配置发一次带 <code>tools</code> 的请求，验证上游是否按提示词输出 <code>&lt;tool_call&gt;</code>。</div>
  </section>

  <div class="actions">
    <button class="primary" id="btn-save">保存并应用</button>
    <button id="btn-reset">恢复环境变量默认值</button>
    <div id="log"></div>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const TEXT_FIELDS = ['upstreamBaseUrl','defaultModel','modelOverride','requestTimeoutMs','maxBodyBytes','toolMode','reasoningPassthrough'];
const log = (msg, cls) => { const el = $('log'); el.className = cls || ''; el.textContent = msg; };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = json?.error?.message || json?.error?.errors?.map(e => e.field + ' ' + e.message).join('；') || res.status + ' ' + text.slice(0, 200);
    throw new Error(msg);
  }
  return json;
}

function setBadges(data) {
  for (const [field, source] of Object.entries(data.sources)) {
    const el = $('b-' + field);
    if (!el) continue;
    el.textContent = source === 'file' ? 'UI 已覆盖' : source === 'env' ? '来自 env' : '默认值';
    el.className = 'badge ' + (source === 'file' ? 'file' : source === 'env' ? 'env' : '');
  }
  const meta = data.meta;
  $('file').textContent = meta.file + (meta.exists ? '（已存在）' : '（尚未创建）');
  $('ver').textContent = meta.version ? 'v' + meta.version : '';
  for (const field of ['upstreamApiKey','gatewayApiKey']) {
    const v = data.settings[field];
    const hint = $('hint-' + field);
    if (hint) hint.textContent = v.set ? ('当前已设置：' + v.hint + '（留空保存 = 不修改）') : '当前未设置';
  }
}

function fill(data) {
  const s = data.settings;
  for (const f of TEXT_FIELDS) {
    const el = $(f);
    if (el) el.value = s[f] === null || s[f] === undefined ? '' : String(s[f]);
  }
  $('reasoningPassthrough').value = s.reasoningPassthrough ? 'on' : 'off';
  $('modelMap').value = Object.keys(s.modelMap || {}).length ? JSON.stringify(s.modelMap, null, 2) : '';
  $('upstreamApiKey').value = '';
  $('gatewayApiKey').value = '';
  setBadges(data);
}

function collect() {
  const patch = {
    upstreamBaseUrl: $('upstreamBaseUrl').value.trim(),
    defaultModel: $('defaultModel').value.trim(),
    modelOverride: $('modelOverride').value.trim(),
    modelMap: $('modelMap').value.trim(),
    toolMode: $('toolMode').value,
    reasoningPassthrough: $('reasoningPassthrough').value,
    requestTimeoutMs: Number($('requestTimeoutMs').value || 0),
    maxBodyBytes: Number($('maxBodyBytes').value || 0),
  };
  // 密钥：留空 = 不修改（不放进 patch）
  const up = $('upstreamApiKey').value.trim();
  if (up) patch.upstreamApiKey = up;
  const gw = $('gatewayApiKey').value.trim();
  if (gw) patch.gatewayApiKey = gw;
  return patch;
}

async function load() {
  try { fill(await api('/admin/api/settings')); log('已加载当前配置', 'ok'); }
  catch (e) { log('加载失败：' + e.message, 'err'); }
}

$('btn-save').onclick = async () => {
  $('btn-save').disabled = true;
  try {
    const data = await api('/admin/api/settings', { method: 'PUT', body: JSON.stringify({ settings: collect() }) });
    fill(data);
    log('已保存并热生效（无需重启）', 'ok');
  } catch (e) { log('保存失败：' + e.message, 'err'); }
  finally { $('btn-save').disabled = false; }
};

$('btn-reset').onclick = async () => {
  if (!confirm('清除 UI 覆盖项，全部回落到环境变量/默认值？')) return;
  try { fill(await api('/admin/api/settings/reset', { method: 'POST' })); log('已恢复 env 默认值', 'ok'); }
  catch (e) { log('重置失败：' + e.message, 'err'); }
};

async function testUpstream(showTable) {
  const btn = showTable ? $('btn-models') : $('btn-test');
  btn.disabled = true;
  log('正在连接上游…');
  try {
    const data = await api('/admin/api/test', {
      method: 'POST',
      body: JSON.stringify({ settings: (function(){ const p = collect(); delete p.requestTimeoutMs; delete p.maxBodyBytes; return p; })() }),
    });
    const rows = (data.models || []).map(m =>
      '<tr><td>' + m.id + '</td><td>' + (m.supports_tool_call === undefined ? '-' : (m.supports_tool_call ? '原生工具 ✓' : '原生工具 ✗')) + '</td></tr>').join('');
    if (showTable) {
      $('models-box').innerHTML = '<table class="models"><tr><th>模型</th><th>能力</th></tr>' + rows + '</table>';
    }
    log('连接成功：HTTP ' + data.status + '，' + (data.models || []).length + ' 个模型，' + data.latencyMs + 'ms', 'ok');
  } catch (e) { log('连接失败：' + e.message, 'err'); if (showTable) $('models-box').innerHTML = ''; }
  finally { btn.disabled = false; }
}
$('btn-test').onclick = () => testUpstream(false);
$('btn-models').onclick = () => testUpstream(true);

$('btn-tool').onclick = async () => {
  if (!confirm('会真实调用一次上游模型（可能计费），继续？')) return;
  $('btn-tool').disabled = true;
  log('正在跑工具模拟自检…');
  try {
    const data = await api('/admin/api/test-tool', { method: 'POST', body: '{}' });
    log('自检完成：finish=' + data.finishReason + '，tool_calls=' + (data.toolCalls || []).length +
        (data.sample ? '，参数=' + data.sample : '') + '，' + data.latencyMs + 'ms',
        data.finishReason === 'tool_calls' ? 'ok' : 'warn');
  } catch (e) { log('自检失败：' + e.message, 'err'); }
  finally { $('btn-tool').disabled = false; }
};

load();
</script>
</body>
</html>`;
}
