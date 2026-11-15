// 设置页 / 登录页：单文件 HTML（内联 CSS+JS），无构建、无外部 CDN、无第三方依赖。
// 只负责展示与提交，所有校验/持久化在 /admin/api/* 完成。

const COMMON_CSS = `
  :root{
    --bg:#0a0c11; --bg-soft:#0e1118; --panel:#12161f; --panel-2:#171c27; --line:#232a38;
    --line-soft:#1b2130; --text:#e9eef8; --muted:#8b96ab; --faint:#5d6a80;
    --accent:#5b8cff; --accent-soft:rgba(91,140,255,.14); --ok:#3fb950; --ok-soft:rgba(63,185,80,.12);
    --warn:#d29922; --warn-soft:rgba(210,153,34,.12); --err:#f85149; --err-soft:rgba(248,81,73,.12);
    --radius:14px; --radius-sm:9px; --shadow:0 10px 30px rgba(0,0,0,.35);
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  }
  @media (prefers-color-scheme: light){
    :root{
      --bg:#f5f7fb; --bg-soft:#eef1f7; --panel:#ffffff; --panel-2:#f7f9fc; --line:#dfe4ee;
      --line-soft:#e9edf5; --text:#172033; --muted:#5c6880; --faint:#8b96ab;
      --accent-soft:rgba(91,140,255,.12); --shadow:0 8px 24px rgba(23,32,51,.08);
    }
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0; background:
      radial-gradient(1100px 600px at 12% -10%, var(--accent-soft), transparent 60%),
      var(--bg);
    color:var(--text); font:14px/1.6 "Noto Sans SC",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  a{color:var(--accent);text-decoration:none}
  code{font-family:var(--mono);font-size:12px;background:var(--panel-2);border:1px solid var(--line-soft);border-radius:6px;padding:1px 5px}

  .topbar{
    position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;flex-wrap:wrap;
    padding:12px 24px;border-bottom:1px solid var(--line);
    background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(14px);
  }
  .brand{display:flex;align-items:center;gap:10px;margin:0}
  .brand h1{font-size:15px;font-weight:650;letter-spacing:.2px;margin:0}
  .logo{width:22px;height:22px;border-radius:7px;background:linear-gradient(135deg,var(--accent),#8f6bff);box-shadow:0 2px 10px var(--accent-soft)}
  .pill{font-size:11px;line-height:1;padding:4px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted);background:var(--panel)}
  .topmeta{display:flex;align-items:center;gap:10px;margin-left:auto;flex-wrap:wrap}
  .fileline{font:12px/1.4 var(--mono);color:var(--faint);max-width:46ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .link{background:none;border:0;color:var(--muted);cursor:pointer;font:inherit;padding:4px 6px;border-radius:6px}
  .link:hover{color:var(--text);background:var(--panel-2)}

  .shell{display:grid;grid-template-columns:264px minmax(0,1fr);gap:20px;max-width:1180px;margin:0 auto;padding:20px 24px 104px}
  .side{position:sticky;top:68px;align-self:start;display:grid;gap:14px}
  .nav{display:grid;gap:2px;padding:6px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}
  .nav a{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;color:var(--muted);font-size:13px}
  .nav a:hover{background:var(--panel-2);color:var(--text)}
  .nav a.active{background:var(--accent-soft);color:var(--text);font-weight:600}

  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
  .card>header{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid var(--line-soft)}
  .card>header h2{font-size:14px;margin:0;font-weight:650}
  .card>header .sub{color:var(--muted);font-size:12px}
  .card>.body{padding:6px 20px 18px}

  .status{padding:14px 16px;display:grid;gap:10px}
  .eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
  .status dl{margin:0;display:grid;gap:8px}
  .status dl>div{display:flex;justify-content:space-between;gap:10px;font-size:12.5px}
  .status dt{color:var(--muted)}
  .status dd{margin:0;font-family:var(--mono);font-size:12px;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}

  .field{display:grid;grid-template-columns:210px minmax(0,1fr);gap:4px 18px;padding:12px 0;border-top:1px solid var(--line-soft)}
  .field:first-of-type{border-top:0}
  .flabel{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px;padding-top:8px}
  .field .control{display:grid;gap:6px}
  .hint{grid-column:2;margin:0;color:var(--faint);font-size:12px;line-height:1.5}
  .hint code{font-size:11px}

  input[type=text],input[type=password],input[type=number],select,textarea{
    width:100%;background:var(--panel-2);color:var(--text);border:1px solid var(--line);
    border-radius:var(--radius-sm);padding:9px 11px;font:inherit;transition:border-color .15s,box-shadow .15s;
  }
  input::placeholder,textarea::placeholder{color:var(--faint)}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  textarea{min-height:86px;font-family:var(--mono);font-size:12px;line-height:1.55;resize:vertical}
  .secret{position:relative}
  .secret input{padding-right:52px}
  .secret .reveal{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:transparent;color:var(--faint);font-size:11px;cursor:pointer;padding:4px 6px;border-radius:6px}
  .secret .reveal:hover{color:var(--text);background:var(--panel)}

  .chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:1;padding:4px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted);background:var(--panel-2);white-space:nowrap}
  .chip.sm{padding:3px 7px;font-size:10.5px}
  .chip .dot{width:6px;height:6px;border-radius:50%;background:var(--faint)}
  .chip.ok{color:var(--ok);border-color:rgba(63,185,80,.35);background:var(--ok-soft)}
  .chip.ok .dot{background:var(--ok)}
  .chip.warn{color:var(--warn);border-color:rgba(210,153,34,.35);background:var(--warn-soft)}
  .chip.warn .dot{background:var(--warn)}
  .chip.err{color:var(--err);border-color:rgba(248,81,73,.35);background:var(--err-soft)}
  .chip.err .dot{background:var(--err)}
  .chip.file{color:var(--accent);border-color:rgba(91,140,255,.35);background:var(--accent-soft)}
  .chip.file .dot{background:var(--accent)}
  .chip.env{color:#58a6ff;border-color:rgba(88,166,255,.3);background:rgba(88,166,255,.1)}

  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .btn{border:1px solid var(--line);background:var(--panel-2);color:var(--text);padding:8px 14px;border-radius:var(--radius-sm);cursor:pointer;font:inherit;font-size:13px;display:inline-flex;align-items:center;gap:7px;transition:transform .06s,background .15s,border-color .15s}
  .btn:hover{border-color:var(--faint);background:var(--panel)}
  .btn:active{transform:translateY(1px)}
  .btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
  .btn.primary{background:var(--accent);border-color:transparent;color:#fff;font-weight:650}
  .btn.primary:hover{background:#6d97ff}
  .btn.ghost{background:transparent}
  .btn.danger{color:var(--err);border-color:rgba(248,81,73,.3)}
  .btn .spin{width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}

  .savebar{
    position:sticky;bottom:0;z-index:15;display:flex;align-items:center;gap:12px;flex-wrap:wrap;
    padding:12px 24px;border-top:1px solid var(--line);
    background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(14px);
  }
  .savebar .state{font-size:12.5px;color:var(--muted);min-height:1.4em}
  .savebar .spacer{flex:1}

  .toasts{position:fixed;right:18px;bottom:72px;z-index:40;display:grid;gap:8px;max-width:min(420px,90vw)}
  .toast{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;padding:10px 14px;box-shadow:var(--shadow);font-size:13px;animation:slidein .18s ease-out;display:flex;gap:8px;align-items:flex-start}
  .toast.ok{border-left-color:var(--ok)} .toast.warn{border-left-color:var(--warn)} .toast.err{border-left-color:var(--err)}
  .toast .x{margin-left:auto;background:none;border:0;color:var(--faint);cursor:pointer;font-size:14px;line-height:1}
  @keyframes slidein{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

  .models{margin-top:12px;border:1px solid var(--line-soft);border-radius:10px;overflow:hidden}
  .models .head,.models .item{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:8px 12px;font-size:12.5px}
  .models .head{background:var(--panel-2);color:var(--muted);font-size:11.5px;letter-spacing:.04em}
  .models .item{border-top:1px solid var(--line-soft)}
  .models .item .id{font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tag{font-size:10.5px;padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
  .tag.ok{color:var(--ok);border-color:rgba(63,185,80,.35)} .tag.warn{color:var(--warn);border-color:rgba(210,153,34,.35)}
  .muted{color:var(--muted)} .mono{font-family:var(--mono);font-size:12px}
  .kv{display:grid;gap:8px}
  .kv .row2{display:grid;grid-template-columns:130px minmax(0,1fr) auto;gap:10px;align-items:center;font-size:12.5px}
  .kv .row2 .k{color:var(--muted)}
  .kv .row2 .v{font-family:var(--mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pre{background:var(--panel-2);border:1px solid var(--line-soft);border-radius:10px;padding:12px 14px;font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-all;color:var(--muted)}
  .result{margin-top:12px;border:1px solid var(--line-soft);border-radius:10px;padding:12px 14px;display:grid;gap:6px;font-size:12.5px}
  .result .headline{display:flex;gap:8px;align-items:center;font-weight:600}
  .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

  @media (max-width:900px){
    .shell{grid-template-columns:minmax(0,1fr);padding:14px 14px 110px}
    .side{position:static;order:-1}
    .nav{grid-auto-flow:column;overflow:auto}
    .nav a{white-space:nowrap}
    .field{grid-template-columns:1fr;gap:6px}
    .flabel{padding-top:0}
    .hint{grid-column:1}
    .topbar{padding:10px 14px}
    .savebar{padding:10px 14px}
    .fileline{display:none}
  }
`;

/** 首次运行：创建管理员 + 填上游，一个页面两步搞定 */
export function renderSetupHtml({ version = '' } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>toolcall-gateway · 初始化</title>
<style>${COMMON_CSS}
  body{display:block;padding:32px 18px 56px}
  .wizard{width:min(760px,100%);margin:0 auto;display:grid;gap:16px}
  .hero{display:grid;gap:10px;margin-bottom:4px}
  .hero .brand{margin:0}
  .hero h1{font-size:22px;margin:6px 0 0;font-weight:680;letter-spacing:-.2px}
  .hero p{margin:0;color:var(--muted);font-size:13.5px;max-width:62ch}
  .steps{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
  .step{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted)}
  .step .n{width:19px;height:19px;border-radius:50%;display:grid;place-items:center;background:var(--panel-2);border:1px solid var(--line);font-size:11px}
  .step.done .n{background:var(--ok-soft);border-color:rgba(63,185,80,.4);color:var(--ok)}
  .card>header .n{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);font-size:11px;font-weight:700;border:1px solid rgba(91,140,255,.35)}
  .card .body{padding-top:14px}
  .form{display:grid;gap:14px}
  .lbl{display:grid;gap:6px;font-size:13px;color:var(--muted)}
  .lbl .tip{font-size:11.5px;color:var(--faint)}
  .err{color:var(--err);font-size:12.5px;min-height:1.2em}
  .foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:4px}
  .foot .spacer{flex:1}
  .notice{border:1px solid rgba(210,153,34,.3);background:var(--warn-soft);color:var(--warn);border-radius:10px;padding:10px 13px;font-size:12.5px;line-height:1.55}
  .ok-notice{border-color:rgba(63,185,80,.3);background:var(--ok-soft);color:var(--ok)}
</style>
</head>
<body>
<form class="wizard" id="f" autocomplete="off">
  <div class="hero">
    <div class="brand"><span class="logo" aria-hidden="true"></span><span class="pill">首次初始化</span><span class="pill">v${version}</span></div>
    <h1>两步就能用起来</h1>
    <p>这里创建的管理员账号用来登录本设置页；上游是真正提供聊天的 OpenAI 兼容接口。保存后立即生效，无需重启。</p>
    <div class="steps">
      <span class="step" id="s1"><span class="n">1</span>管理员账号</span>
      <span class="step" id="s2"><span class="n">2</span>上游接口</span>
    </div>
  </div>

  <section class="card">
    <header><span class="n">1</span><h2>管理员账号</h2><span class="sub">只用于登录这个设置页</span></header>
    <div class="body">
      <div class="form">
        <label class="lbl">用户名
          <input id="username" type="text" spellcheck="false" placeholder="admin" autocomplete="username" autofocus>
          <span class="tip">2~32 位，字母/数字/下划线/点/中划线/@/中文</span>
        </label>
        <label class="lbl">密码
          <span class="secret">
            <input id="password" type="password" placeholder="至少 8 位" autocomplete="new-password">
            <button type="button" class="reveal" data-for="password">显示</button>
          </span>
        </label>
        <label class="lbl">确认密码
          <input id="password2" type="password" placeholder="再输一次" autocomplete="new-password">
        </label>
      </div>
    </div>
  </section>

  <section class="card">
    <header><span class="n">2</span><h2>上游接口</h2><span class="sub">兼容 OpenAI /v1/chat/completions 的纯聊天接口</span></header>
    <div class="body">
      <div class="form">
        <label class="lbl">Base URL
          <input id="upstreamBaseUrl" type="text" spellcheck="false" placeholder="https://api.deepseek.com 或 https://host/v1">
          <span class="tip">可以带 <code>/v1</code> 后缀，网关不会拼成 <code>/v1/v1</code></span>
        </label>
        <label class="lbl">API Key
          <span class="secret">
            <input id="upstreamApiKey" type="password" placeholder="sk-..." autocomplete="off">
            <button type="button" class="reveal" data-for="upstreamApiKey">显示</button>
          </span>
          <span class="tip">只存在本机 <code>data/settings.json</code>，不写日志、不回显</span>
        </label>
        <label class="lbl">默认模型
          <input id="defaultModel" type="text" spellcheck="false" placeholder="deepseek-chat">
          <span class="tip">客户端送什么模型名都会映射到它；也可以稍后在设置页配映射</span>
        </label>
        <div class="row">
          <button class="btn" type="button" id="btn-test">测试连接</button>
          <span class="muted" style="font-size:12px" id="test-state">先填好上面三项，再点这里探一次 <code>/v1/models</code></span>
        </div>
        <div id="models" class="models" style="display:none"></div>
      </div>
    </div>
  </section>

  <div class="err" id="err" role="alert"></div>
  <div class="foot">
    <button class="btn primary" type="submit" id="btn-submit">完成初始化</button>
    <span class="muted" style="font-size:12px">完成后会在本机写入 <code>data/auth.json</code> 与 <code>data/settings.json</code></span>
    <span class="spacer"></span>
    <span class="muted" style="font-size:11.5px">Cookie · HttpOnly · SameSite=Lax</span>
  </div>
  <div class="notice" id="claim">首次初始化的窗口：在你完成之前，任何能访问该端口的客户端都能创建这个账号。完成后窗口即关闭；如需彻底锁死，请先给容器设置 <code>ADMIN_TOKEN</code> 并只在本机打开。</div>
</form>
<script>
const $ = (id) => document.getElementById(id);
const testState = (text, ok) => { const el = $('test-state'); el.textContent = text; el.style.color = ok ? 'var(--ok)' : 'var(--muted)'; };
document.querySelectorAll('.reveal').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.for);
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? '显示' : '隐藏';
  });
});
async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.payload = data;
    throw err;
  }
  return data;
}
function upstreamPatch() {
  return {
    upstreamBaseUrl: $('upstreamBaseUrl').value.trim(),
    upstreamApiKey: $('upstreamApiKey').value.trim(),
    defaultModel: $('defaultModel').value.trim(),
  };
}
$('btn-test').addEventListener('click', async () => {
  const patch = upstreamPatch();
  if (!patch.upstreamBaseUrl) { testState('请先填 Base URL', false); return; }
  const btn = $('btn-test');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>探测中';
  testState('正在请求 /v1/models …', false);
  try {
    const data = await postJson('/admin/api/setup/test', { settings: patch });
    testState('连接正常 · HTTP ' + data.status + ' · ' + data.latencyMs + 'ms · ' + data.models.length + ' 个模型', true);
    const box = $('models');
    box.style.display = '';
    if (!data.models.length) { box.innerHTML = '<div class="item muted">接口没返回模型列表，可手动填写默认模型</div>'; return; }
    box.innerHTML = '<div class="head"><span>模型</span><span>工具调用</span><span></span></div>' + data.models.slice(0, 50).map((m) => {
      const native = m.supports_tool_call === true;
      const tag = native ? '<span class="tag ok">原生支持</span>' : '<span class="tag warn">需提示词模拟</span>';
      return '<div class="item"><span class="id">' + m.id + '</span>' + tag + '<button type="button" class="btn ghost" style="padding:4px 9px;font-size:12px" data-model="' + m.id + '">用这个</button></div>';
    }).join('');
  } catch (ex) {
    testState('失败：' + ex.message, false);
  } finally {
    btn.disabled = false; btn.textContent = '测试连接';
  }
});
$('models').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-model]');
  if (!btn) return;
  $('defaultModel').value = btn.dataset.model;
  testState('已选默认模型：' + btn.dataset.model, true);
});
$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('err');
  err.textContent = '';
  const username = $('username').value.trim();
  const password = $('password').value;
  const password2 = $('password2').value;
  if (!username) { err.textContent = '请填写用户名'; return; }
  if (password.length < 8) { err.textContent = '密码至少 8 位'; return; }
  if (password !== password2) { err.textContent = '两次输入的密码不一致'; return; }
  const patch = upstreamPatch();
  if (!patch.upstreamBaseUrl) { err.textContent = '请填写上游 Base URL'; return; }
  if (!patch.defaultModel) { err.textContent = '请填写默认模型（可先点测试连接挑一个）'; return; }
  const btn = $('btn-submit');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>创建中';
  try {
    await postJson('/admin/api/setup', { username, password, ...patch });
    $('s1').classList.add('done'); $('s2').classList.add('done');
    location.href = '/admin';
  } catch (ex) {
    err.textContent = ex.message;
    btn.disabled = false; btn.textContent = '完成初始化';
  }
});
</script>
</body>
</html>`;
}

export function renderLoginHtml({ version = '', username = '' } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>toolcall-gateway · 登录</title>
<style>${COMMON_CSS}
  body{display:grid;place-items:center;min-height:100dvh;padding:24px}
  .login{width:min(410px,100%);background:var(--panel);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);padding:28px}
  .login .brand{margin-bottom:6px}
  .login h1{font-size:18px;margin:14px 0 6px}
  .login p{margin:0 0 18px;color:var(--muted);font-size:13px}
  .login form{display:grid;gap:12px}
  .login label{display:grid;gap:6px;font-size:12.5px;color:var(--muted)}
  .login .foot{display:flex;justify-content:space-between;align-items:center;margin-top:16px;color:var(--faint);font-size:11.5px}
  .err{color:var(--err);font-size:12.5px;min-height:1.3em}
  details summary{cursor:pointer;color:var(--faint);font-size:12px;margin-top:4px}
  details form{display:grid;gap:8px;margin-top:10px}
</style>
</head>
<body>
  <div class="login">
    <div class="brand"><span class="logo"></span><span class="pill">管理设置</span></div>
    <h1>登录 toolcall-gateway 设置</h1>
    <p>使用首次初始化时创建的管理员账号。<span id="who"></span></p>
    <form id="f" autocomplete="on">
      <label>用户名
        <input id="username" type="text" autocomplete="username" spellcheck="false" value="${escapeAttr(username)}">
      </label>
      <label>密码
        <span class="secret">
          <input id="password" type="password" autocomplete="current-password" autofocus>
          <button type="button" class="reveal" data-for="password">显示</button>
        </span>
      </label>
      <div class="err" id="err" role="alert"></div>
      <button class="btn primary" type="submit" style="justify-content:center">登录</button>
    </form>
    <details>
      <summary>用 ADMIN_TOKEN 登录（自动化 / 找回）</summary>
      <form id="ft">
        <input id="token" type="password" placeholder="ADMIN_TOKEN" autocomplete="off" aria-label="ADMIN_TOKEN">
        <div class="err" id="err2" role="alert"></div>
        <button class="btn" type="submit" style="justify-content:center">用令牌登录</button>
      </form>
    </details>
    <div class="foot"><span>忘记密码：删除 data/auth.json 后重启即可重新初始化</span><span>v${version}</span></div>
  </div>
<script>
const $ = (id) => document.getElementById(id);
if ($('username').value) $('who').textContent = '';
document.querySelectorAll('.reveal').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.for);
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? '显示' : '隐藏';
  });
});
async function post(url, body, errEl) {
  errEl.textContent = '';
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      errEl.textContent = (j && j.error && j.error.message) || ('登录失败：HTTP ' + res.status);
      return false;
    }
    location.reload();
    return true;
  } catch (ex) {
    errEl.textContent = '网络错误：' + ex.message;
    return false;
  }
}
$('f').addEventListener('submit', (e) => {
  e.preventDefault();
  post('/admin/api/login', { username: $('username').value.trim(), password: $('password').value }, $('err'));
});
$('ft').addEventListener('submit', (e) => {
  e.preventDefault();
  post('/admin/api/login', { token: $('token').value.trim() }, $('err2'));
});
</script>
</body>
</html>`;
}

function escapeAttr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderAdminHtml({ version = '', username = '' } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>toolcall-gateway · 设置</title>
<style>${COMMON_CSS}</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="logo" aria-hidden="true"></span>
    <h1>toolcall-gateway 设置</h1>
    <span class="pill" id="ver">v${version}</span>
  </div>
  <div class="topmeta">
    <span class="chip" id="chip-admin"><span class="dot"></span><span id="chip-admin-text">…</span></span>
    <span class="chip" id="chip-user"><span class="dot"></span><span id="chip-user-text">${escapeAttr(username)}</span></span>
    <span class="fileline" id="file" title=""></span>
    <button class="link" id="btn-logout">退出登录</button>
  </div>
</header>

<div class="shell">
  <aside class="side">
    <div class="card status">
      <div class="eyebrow">当前生效</div>
      <dl>
        <div><dt>上游</dt><dd id="st-upstream">—</dd></div>
        <div><dt>默认模型</dt><dd id="st-model">—</dd></div>
        <div><dt>工具模拟</dt><dd id="st-tool">—</dd></div>
        <div><dt>UI 覆盖</dt><dd id="st-overrides">—</dd></div>
      </dl>
    </div>
    <nav class="nav" aria-label="分区">
      <a href="#upstream" class="active">上游</a>
      <a href="#gateway">网关</a>
      <a href="#selftest">自检</a>
      <a href="#about">接入</a>
      <a href="#account">账号</a>
    </nav>
  </aside>

  <main class="main" style="display:grid;gap:18px">
    <section class="card" id="upstream">
      <header>
        <h2>上游</h2>
        <span class="chip sm" id="b-upstreamBaseUrl"></span>
        <span class="sub">所有请求最终发到这里</span>
      </header>
      <div class="body">
        <div class="field">
          <div class="flabel"><label for="upstreamBaseUrl">Base URL</label></div>
          <div class="control"><input id="upstreamBaseUrl" type="text" spellcheck="false" placeholder="https://api.deepseek.com 或 https://host/v1"></div>
          <p class="hint">可以带 <code>/v1</code> 后缀，网关会避免拼成 <code>/v1/v1</code>。</p>
        </div>

        <div class="field">
          <div class="flabel"><label for="upstreamApiKey">API Key</label><span class="chip sm" id="b-upstreamApiKey"></span></div>
          <div class="control">
            <div class="secret">
              <input id="upstreamApiKey" type="password" autocomplete="new-password" placeholder="留空 = 不修改">
              <button class="reveal" type="button" data-for="upstreamApiKey">显示</button>
            </div>
          </div>
          <p class="hint" id="hint-upstreamApiKey"></p>
        </div>

        <div class="field">
          <div class="flabel"><label for="defaultModel">默认模型</label><span class="chip sm" id="b-defaultModel"></span></div>
          <div class="control"><input id="defaultModel" type="text" spellcheck="false" placeholder="deepseek-chat"></div>
          <p class="hint">请求没带 <code>model</code> 时使用；也是「工具模拟自检」用的模型。</p>
        </div>

        <div class="field">
          <div class="flabel"><label for="modelMap">模型映射</label><span class="chip sm" id="b-modelMap"></span></div>
          <div class="control"><textarea id="modelMap" spellcheck="false" placeholder='{"gpt-5-codex":"deepseek-chat"}'></textarea></div>
          <p class="hint">JSON，或简写 <code>from:to,from2:to2</code>。客户端送来的模型名会先经过这张表。</p>
        </div>

        <div class="field">
          <div class="flabel"><label for="modelOverride">强制覆盖模型</label><span class="chip sm" id="b-modelOverride"></span></div>
          <div class="control"><input id="modelOverride" type="text" spellcheck="false" placeholder="留空 = 不强制"></div>
          <p class="hint">设置后所有请求都用这个上游模型，优先级高于映射表。</p>
        </div>

        <div class="row" style="margin-top:14px">
          <button class="btn" id="btn-test"><span>测试连接</span><span class="muted mono" style="font-size:11px">GET /models</span></button>
          <button class="btn" id="btn-models">列出模型</button>
        </div>
        <div id="models-box"></div>
      </div>
    </section>

    <section class="card" id="gateway">
      <header>
        <h2>网关</h2>
        <span class="chip sm" id="b-gatewayApiKey"></span>
        <span class="sub">对下游暴露的行为</span>
      </header>
      <div class="body">
        <div class="field">
          <div class="flabel"><label for="gatewayApiKey">下游鉴权 Key</label></div>
          <div class="control">
            <div class="secret">
              <input id="gatewayApiKey" type="password" autocomplete="new-password" placeholder="留空 = 允许任意下游 key">
              <button class="reveal" type="button" data-for="gatewayApiKey">显示</button>
            </div>
          </div>
          <p class="hint" id="hint-gatewayApiKey"></p>
        </div>

        <div class="field">
          <div class="flabel"><label for="toolMode">工具模拟模式</label><span class="chip sm" id="b-toolMode"></span></div>
          <div class="control">
            <select id="toolMode">
              <option value="auto">auto — 含 tools 时用提示词模拟</option>
              <option value="off">off — 完全透传（不模拟）</option>
            </select>
          </div>
          <p class="hint">上游原生支持 function calling 时可以设成 <code>off</code>。</p>
        </div>

        <div class="field">
          <div class="flabel"><label for="imageMode">图片处理模式</label><span class="chip sm" id="b-imageMode"></span></div>
          <div class="control">
            <select id="imageMode">
              <option value="pass">pass — 图片/文件/音频原样转发给上游（推荐）</option>
              <option value="placeholder">placeholder — 媒体换成 [图片] 等占位文本</option>
              <option value="reject">reject — 含媒体的请求直接 400</option>
            </select>
          </div>
          <p class="hint">
            <code>pass</code>：把客户端发来的 <code>image_url</code> / <code>input_image</code> / <code>file</code> / <code>input_audio</code> 原样转给上游，图片内容不被改写。<br>
            <code>placeholder</code>：老行为，媒体替换成 <code>[图片]</code> / <code>[文件: name]</code> 文本——上游明确不支持视觉时用，至少不报错。<br>
            <code>reject</code>：模拟模式下遇到媒体直接返回 <code>400 vision_unsupported</code>，用来尽早暴露问题。
          </p>
          <p class="hint">只影响「带 tools 的模拟模式」。不带 tools 的纯聊天请求一直是字节级透传，图片本来就能过。</p>
        </div>

        <div class="field">
          <div class="flabel"><label for="reasoningPassthrough">透传 reasoning</label><span class="chip sm" id="b-reasoningPassthrough"></span></div>
          <div class="control">
            <select id="reasoningPassthrough">
              <option value="on">on — 原样挂在 message.reasoning_content</option>
              <option value="off">off — 丢弃思考内容</option>
            </select>
          </div>
          <p class="hint">思考内容不会并入 <code>content</code>，也不会参与工具解析。</p>
        </div>

        <div class="field">
          <div class="flabel"><label for="requestTimeoutMs">上游超时</label><span class="chip sm" id="b-requestTimeoutMs"></span></div>
          <div class="control"><input id="requestTimeoutMs" type="number" min="1000" max="600000" step="1000"></div>
          <p class="hint">毫秒。含工具时是「整段流读完」的总预算；含媒体的请求会自动放宽到至少 120000ms。</p>
        </div>

        <div class="field">
          <div class="flabel"><label for="maxBodyBytes">请求体上限</label><span class="chip sm" id="b-maxBodyBytes"></span></div>
          <div class="control"><input id="maxBodyBytes" type="number" min="1024" max="67108864" step="1024"></div>
          <p class="hint">字节，默认 16MB。多模态图片按 base64 体积算，一张 1024×1024 PNG 约 1~3MB；超出返回 <code>413 payload_too_large</code>。</p>
        </div>
      </div>
    </section>

    <section class="card" id="selftest">
      <header><h2>自检</h2><span class="sub">用当前保存的配置真打一次</span></header>
      <div class="body">
        <div class="row">
          <button class="btn" id="btn-tool">跑一次工具模拟自检</button>
          <span class="chip warn"><span class="dot"></span>会消耗 1 次上游调用</span>
        </div>
        <p class="hint" style="margin-top:10px">发送一条带 <code>get_time</code> 工具的请求，看模型是否会按提示词输出 <code>&lt;tool_call&gt;</code>。上游 <code>supports_tool_call:false</code> 时，命中就说明提示词模拟有效。</p>
        <div id="tool-box"></div>

        <div class="row" style="margin-top:18px">
          <button class="btn" id="btn-vision">跑一次视觉自检</button>
          <span class="chip warn"><span class="dot"></span>会消耗 1 次上游调用</span>
        </div>
        <p class="hint" style="margin-top:10px">发一张内嵌的 1×1 PNG（69 字节，不读文件）+ <code>tools</code>，确认上游到底吃不吃图片。若报 <code>upstream_vision_unsupported</code>，把 <b>图片处理模式</b> 改成 <code>placeholder</code> 或换支持视觉的模型。</p>
        <div id="vision-box"></div>
      </div>
    </section>

    <section class="card" id="about">
      <header><h2>接入</h2><span class="sub">下游客户端指向这里</span></header>
      <div class="body">
        <div class="kv">
          <div class="row2"><span class="k">Base URL</span><span class="v" id="ep-base">—</span><button class="btn ghost" data-copy="ep-base">复制</button></div>
          <div class="row2"><span class="k">Chat Completions</span><span class="v" id="ep-chat">—</span><button class="btn ghost" data-copy="ep-chat">复制</button></div>
          <div class="row2"><span class="k">健康检查</span><span class="v" id="ep-health">—</span><button class="btn ghost" data-copy="ep-health">复制</button></div>
        </div>
        <p class="hint" style="margin-top:12px">curl 示例（带 tools，网关会把 <code>&lt;tool_call&gt;</code> 翻译成标准 tool_calls）：</p>
        <div class="pre" id="curl-example"></div>
        <div class="row" style="margin-top:10px"><button class="btn ghost" data-copy="curl-example">复制 curl</button></div>
        <p class="hint" style="margin-top:14px">Python / Node SDK 的 <code>base_url</code> 填上面的 Base URL，<code>api_key</code> 填「下游鉴权 Key」（未设置时随便填一个非空值）。</p>
      </div>
    </section>

    <section class="card" id="account">
      <header><h2>账号</h2><span class="chip sm" id="acc-mode"></span><span class="sub">设置页的登录凭据</span></header>
      <div class="body">
        <div class="field">
          <div class="flabel"><span>当前账号</span></div>
          <div class="control"><input id="acc-username" type="text" readonly></div>
        </div>
        <div class="field">
          <div class="flabel"><span>改密码</span></div>
          <div class="control row" style="gap:8px;flex-wrap:wrap">
            <input id="acc-current" type="password" placeholder="当前密码" autocomplete="current-password" style="max-width:220px">
            <input id="acc-new" type="password" placeholder="新密码（≥8 位）" autocomplete="new-password" style="max-width:220px">
            <button class="btn" id="btn-passwd" type="button">更新密码</button>
          </div>
          <p class="hint">改完密码后，其它浏览器上的登录会话会全部失效。忘记密码可在服务器上删除 <code>data/auth.json</code> 后重启，重新走初始化。</p>
        </div>
        <div class="field">
          <div class="flabel"><span>退出</span></div>
          <div class="control"><button class="btn ghost danger" type="button" id="btn-logout-2">退出登录</button></div>
        </div>
      </div>
    </section>
  </main>
</div>

<footer class="savebar">
  <div class="state" id="dirty" role="status" aria-live="polite">正在加载…</div>
  <div class="spacer"></div>
  <button class="btn ghost danger" id="btn-reset">恢复环境变量默认值</button>
  <button class="btn primary" id="btn-save" disabled>保存并应用</button>
</footer>

<div class="toasts" id="toasts" aria-live="polite" aria-atomic="false"></div>

<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var FIELDS = ['upstreamBaseUrl','defaultModel','modelOverride','requestTimeoutMs','maxBodyBytes','toolMode','reasoningPassthrough','imageMode'];
  var SECRETS = ['upstreamApiKey','gatewayApiKey'];
  var snapshot = '';
  var loaded = null;

  function toast(message, kind) {
    var box = $('toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.setAttribute('role', 'status');
    var span = document.createElement('span');
    span.textContent = message;
    var x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.setAttribute('aria-label', '关闭');
    x.textContent = '×';
    x.onclick = function () { el.remove(); };
    el.appendChild(span);
    el.appendChild(x);
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, kind === 'err' ? 7000 : 4200);
  }

  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'content-type': 'application/json' }, opts.headers || {}),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    var text = await res.text();
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!res.ok) {
      if (res.status === 401) {
        toast('登录已过期，正在跳转登录页…', 'warn');
        setTimeout(function () { location.reload(); }, 900);
      }
      var detail = '';
      if (json && json.error) {
        if (json.error.errors && json.error.errors.length) {
          detail = json.error.errors.map(function (e) { return e.field + '：' + e.message; }).join('；');
        } else {
          detail = json.error.message || '';
        }
      }
      throw new Error(detail || ('HTTP ' + res.status + ' ' + text.slice(0, 160)));
    }
    return json;
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function sourceChip(el, source) {
    if (!el) return;
    var label = source === 'file' ? 'UI 已覆盖' : source === 'env' ? '来自 env' : '默认值';
    el.className = 'chip sm ' + (source === 'file' ? 'file' : source === 'env' ? 'env' : '');
    el.innerHTML = '<span class="dot"></span>' + label;
  }

  function renderModels(models, latencyMs, status) {
    var box = $('models-box');
    if (!Array.isArray(models) || models.length === 0) {
      box.innerHTML = '<div class="models"><div class="item"><span class="muted">上游没有返回模型列表</span></div></div>';
      return;
    }
    var head = '<div class="head"><span>模型</span><span>原生工具</span><span>操作</span></div>';
    var items = models.map(function (m) {
      var native = m.supports_tool_call;
      var tag = native === true ? '<span class="tag ok">✓ 支持</span>' : native === false ? '<span class="tag warn">✗ 不支持</span>' : '<span class="tag">未知</span>';
      return '<div class="item"><span class="id" title="' + String(m.id).replace(/"/g, '&quot;') + '">' + m.id + '</span><span>' + tag + '</span>' +
             '<button class="btn ghost" style="padding:4px 9px;font-size:12px" data-model="' + String(m.id).replace(/"/g, '&quot;') + '">设为默认</button></div>';
    }).join('');
    box.innerHTML = '<div class="models">' + head + items + '</div>' +
      '<p class="hint" style="margin-top:8px">HTTP ' + status + ' · ' + latencyMs + 'ms · 共 ' + models.length + ' 个模型</p>';
    box.querySelectorAll('[data-model]').forEach(function (btn) {
      btn.onclick = function () {
        $('defaultModel').value = btn.getAttribute('data-model');
        markDirty();
        toast('已填入默认模型，记得保存', 'ok');
      };
    });
  }

  function renderToolResult(data) {
    var ok = data.finishReason === 'tool_calls' && data.toolCalls > 0;
    var box = $('tool-box');
    var cls = ok ? 'ok' : 'warn';
    var headline = ok ? '提示词模拟命中' : '未命中（模型没有输出可解析的工具块）';
    box.innerHTML =
      '<div class="result">' +
        '<div class="headline"><span class="chip ' + cls + '"><span class="dot"></span>' + headline + '</span>' +
        '<span class="muted">' + data.latencyMs + 'ms</span></div>' +
        '<div class="mono">finish_reason = ' + data.finishReason + ' · tool_calls = ' + data.toolCalls + '</div>' +
        (data.sample ? '<div class="mono">arguments = ' + String(data.sample).replace(/</g, '&lt;') + '</div>' : '') +
        '<div class="muted">model = ' + (data.model || '—') + '</div>' +
      '</div>';
  }

  function renderVisionResult(data) {
    var box = $('vision-box');
    var ok = data.ok === true;
    var rejected = data.visionAccepted === false;
    var cls = ok ? 'ok' : rejected ? 'warn' : 'err';
    var headline = ok ? '上游接受了图片' : rejected ? '上游不接受图片（vision_unsupported）' : '自检失败';
    var esc = function (s) { return String(s == null ? '' : s).replace(/</g, '&lt;'); };
    var lines = [];
    lines.push('<div class="mono">status = ' + (data.status == null ? '—' : data.status) + ' · ' + (data.latencyMs || 0) + 'ms</div>');
    if (ok) {
      lines.push('<div class="mono">finish_reason = ' + esc(data.finishReason) + ' · tool_calls = ' + (data.toolCalls || 0) + '</div>');
      if (data.text) lines.push('<div class="muted">回答片段：' + esc(String(data.text).slice(0, 160)) + '</div>');
      if (data.mediaSent && data.mediaSent.length) {
        lines.push('<div class="muted">发送：' + data.mediaSent.map(function (m) { return m.type + ' ' + (m.mime || '') + ' ' + m.bytes + 'B'; }).join('、') + '</div>');
      }
    } else {
      if (data.message) lines.push('<div class="mono">' + esc(data.message) + '</div>');
      if (data.upstream) lines.push('<div class="mono">上游原文：' + esc(data.upstream) + '</div>');
    }
    if (data.fileSupport) lines.push('<div class="muted" style="margin-top:6px">' + esc(data.fileSupport) + '</div>');
    box.innerHTML =
      '<div class="result">' +
        '<div class="headline"><span class="chip ' + cls + '"><span class="dot"></span>' + headline + '</span></div>' +
        lines.join('') +
        '<div class="muted">' + esc(data.note || '') + '</div>' +
      '</div>';
  }

  function applyView(data) {
    loaded = data;
    var s = data.settings;
    FIELDS.forEach(function (f) {
      var el = $(f);
      if (!el) return;
      el.value = s[f] === null || s[f] === undefined ? '' : String(s[f]);
    });
    $('reasoningPassthrough').value = s.reasoningPassthrough ? 'on' : 'off';
    $('imageMode').value = s.imageMode || 'pass';
    $('modelMap').value = Object.keys(s.modelMap || {}).length ? JSON.stringify(s.modelMap, null, 2) : '';
    $('upstreamApiKey').value = '';
    $('gatewayApiKey').value = '';

    Object.keys(data.sources || {}).forEach(function (field) {
      sourceChip($('b-' + field), data.sources[field]);
    });

    var up = s.upstreamApiKey, gw = s.gatewayApiKey;
    $('hint-upstreamApiKey').innerHTML = up.set
      ? '当前已设置 <code>' + up.hint + '</code>，留空保存 = 不修改'
      : '尚未设置上游密钥';
    $('hint-gatewayApiKey').innerHTML = gw.set
      ? '当前已设置 <code>' + gw.hint + '</code>，留空保存 = 不修改'
      : '未设置：下游可用任意 key 访问';

    var meta = data.meta || {};
    $('file').textContent = meta.file ? (meta.file + (meta.exists ? '' : '（尚未创建）')) : '';
    $('file').title = meta.file || '';
    $('ver').textContent = meta.version ? 'v' + meta.version : '';
    var mode = meta.adminMode || 'account';
    $('chip-admin-text').textContent = mode === 'token-or-account' ? '账号登录 · 令牌可用' : '账号登录';
    $('chip-admin').className = 'chip ' + (mode === 'token-or-account' ? 'file' : 'ok');
    var acct = (data.account || {});
    $('chip-user-text').textContent = acct.username || '已登录';
    $('acc-username').value = acct.username || '';
    $('acc-mode').textContent = meta.tokenEnabled ? 'ADMIN_TOKEN 也有效' : '仅账号密码';

    var host = '';
    try { host = new URL(s.upstreamBaseUrl).host; } catch (e) { host = s.upstreamBaseUrl || '—'; }
    setText('st-upstream', host || '—');
    setText('st-model', s.defaultModel || '未设置');
    setText('st-tool', s.toolMode === 'off' ? 'off（透传）' : 'auto（提示词模拟）');
    var n = (meta.activeOverrides || []).length;
    setText('st-overrides', n ? n + ' 项' : '无');

    var origin = location.origin;
    setText('ep-base', origin + '/v1');
    setText('ep-chat', origin + '/v1/chat/completions');
    setText('ep-health', origin + '/healthz');
    var model = s.defaultModel || 'deepseek-chat';
    var NL = String.fromCharCode(10);
    var BS = String.fromCharCode(92); // 反斜杠
    var SQ = String.fromCharCode(39); // 单引号
    var payload = {
      model: model,
      messages: [{ role: 'user', content: '北京天气？' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查天气',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      }],
    };
    $('curl-example').textContent = [
      'curl -s ' + origin + '/v1/chat/completions ' + BS,
      '  -H "content-type: application/json" ' + BS,
      '  -H "authorization: Bearer ' + (gw.set ? '你的网关 Key' : 'any') + '" ' + BS,
      '  -d ' + SQ + JSON.stringify(payload) + SQ,
    ].join(NL);

    snapshot = JSON.stringify(collect());
    $('dirty').textContent = '已加载 ' + (n ? n + ' 项覆盖' : '（当前完全来自 env/默认值）');
    $('dirty').className = 'state';
    $('btn-save').disabled = true;
  }

  function collect() {
    var patch = {
      upstreamBaseUrl: $('upstreamBaseUrl').value.trim(),
      defaultModel: $('defaultModel').value.trim(),
      modelOverride: $('modelOverride').value.trim(),
      modelMap: $('modelMap').value.trim(),
      toolMode: $('toolMode').value,
      reasoningPassthrough: $('reasoningPassthrough').value,
      imageMode: $('imageMode').value,
      requestTimeoutMs: Number($('requestTimeoutMs').value || 0),
      maxBodyBytes: Number($('maxBodyBytes').value || 0),
    };
    SECRETS.forEach(function (f) {
      var v = $(f).value.trim();
      if (v) patch[f] = v;
    });
    return patch;
  }

  function markDirty() {
    var dirty = JSON.stringify(collect()) !== snapshot;
    $('btn-save').disabled = !dirty;
    $('dirty').textContent = dirty ? '有未保存的修改' : '已保存';
    $('dirty').className = 'state' + (dirty ? ' warn' : '');
  }

  function withBusy(btn, fn) {
    return async function () {
      var html = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span>处理中…';
      try { await fn(); }
      finally { btn.disabled = false; btn.innerHTML = html; }
    };
  }

  async function testUpstream(showTable) {
    var candidate = collect();
    delete candidate.requestTimeoutMs;
    delete candidate.maxBodyBytes;
    var data = await api('/admin/api/test', { method: 'POST', body: { settings: candidate } });
    if (showTable) renderModels(data.models, data.latencyMs, data.status);
    toast('连接成功 · HTTP ' + data.status + ' · ' + (data.models || []).length + ' 个模型 · ' + data.latencyMs + 'ms', 'ok');
  }

  $('btn-test').onclick = withBusy($('btn-test'), function () { return testUpstream(false); });
  $('btn-models').onclick = withBusy($('btn-models'), function () { return testUpstream(true); });

  $('btn-tool').onclick = withBusy($('btn-tool'), async function () {
    if (!confirm('会真实调用一次上游模型（可能计费），继续？')) return;
    var data = await api('/admin/api/test-tool', { method: 'POST', body: {} });
    renderToolResult(data);
    toast(data.finishReason === 'tool_calls' ? '自检命中工具调用' : '自检完成：未命中工具调用', data.finishReason === 'tool_calls' ? 'ok' : 'warn');
  });

  $('btn-vision').onclick = withBusy($('btn-vision'), async function () {
    if (!confirm('会真实调用一次上游模型（可能计费），继续？')) return;
    var data = await api('/admin/api/test-vision', { method: 'POST', body: {} });
    renderVisionResult(data);
    if (data.ok) toast('视觉自检通过：上游接受了图片', 'ok');
    else if (data.visionAccepted === false) toast('上游似乎不支持图片输入', 'warn');
    else toast('视觉自检失败：' + (data.message || data.errorType || ''), 'err');
  });

  $('btn-save').onclick = withBusy($('btn-save'), async function () {
    var data = await api('/admin/api/settings', { method: 'PUT', body: { settings: collect() } });
    applyView(data);
    toast('已保存并热生效（无需重启）', 'ok');
  });

  $('btn-reset').onclick = async function () {
    if (!confirm('清除所有 UI 覆盖项，全部回落到环境变量/默认值？')) return;
    var data = await api('/admin/api/settings/reset', { method: 'POST', body: {} });
    applyView(data);
    toast('已恢复环境变量默认值', 'ok');
  };

  $('btn-logout').onclick = async function () {
    try { await api('/admin/api/logout', { method: 'POST', body: {} }); } catch (e) {}
    location.reload();
  };
  $('btn-logout-2').onclick = $('btn-logout').onclick;

  $('btn-passwd').onclick = withBusy($('btn-passwd'), async function () {
    var current = $('acc-current').value;
    var next = $('acc-new').value;
    if (!current) { toast('请输入当前密码', 'err'); return; }
    if (next.length < 8) { toast('新密码至少 8 位', 'err'); return; }
    var data = await api('/admin/api/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
    $('acc-current').value = '';
    $('acc-new').value = '';
    applyView(data);
    toast('密码已更新，其它设备的登录已失效', 'ok');
  });

  document.querySelectorAll('.reveal').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = $(btn.getAttribute('data-for'));
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.textContent = input.type === 'password' ? '显示' : '隐藏';
    });
  });

  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var target = $(btn.getAttribute('data-copy'));
      var text = target.value !== undefined && target.tagName !== 'DIV' ? target.value : target.textContent;
      try {
        await navigator.clipboard.writeText(text);
        toast('已复制', 'ok');
      } catch (e) {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('已复制', 'ok'); } catch (e2) { toast('复制失败，请手动选择', 'err'); }
        ta.remove();
      }
    });
  });

  document.querySelectorAll('input, textarea, select').forEach(function (el) {
    el.addEventListener('input', markDirty);
    el.addEventListener('change', markDirty);
  });

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!$('btn-save').disabled) $('btn-save').click();
    }
  });

  var sections = Array.prototype.slice.call(document.querySelectorAll('main section[id]'));
  var links = Array.prototype.slice.call(document.querySelectorAll('.nav a'));
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) { a.classList.toggle('active', a.getAttribute('href') === '#' + entry.target.id); });
      });
    }, { rootMargin: '-20% 0px -70% 0px' });
    sections.forEach(function (s) { io.observe(s); });
  }

  api('/admin/api/settings')
    .then(applyView)
    .catch(function (e) {
      $('dirty').textContent = '加载失败：' + e.message;
      $('dirty').className = 'state err';
      toast('加载失败：' + e.message, 'err');
    });
})();
</script>
</body>
</html>`;
}
