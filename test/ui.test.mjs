// 设置页 / 登录页的静态校验：内联脚本必须能解析、不能引外部资源、关键元素 id 不能丢。
// （曾经因为模板字符串反斜杠转义把内联 JS 写坏过一次，这里做回归防线。）
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAdminHtml, renderLoginHtml, renderSetupHtml } from '../src/admin-ui.mjs';

function inlineScripts(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

test('设置页：内联 JS 能解析，且无外部脚本/样式', () => {
  const html = renderAdminHtml({ version: '9.9.9' });
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1, '应只有一段内联脚本');
  assert.doesNotThrow(() => new Function(scripts[0]), '内联脚本存在语法错误');
  assert.equal(/<script[^>]+src=/i.test(html), false);
  assert.equal(/<link[^>]+href=["']https?:/i.test(html), false);
  assert.equal(/@import\s+url\(/i.test(html), false);
  assert.ok(html.includes('v9.9.9'), '版本号应渲染');
});

test('设置页：关键控件 id 齐全（测试与用户脚本都依赖它们）', () => {
  const html = renderAdminHtml({ version: '1.1.1' });
  for (const id of [
    'upstreamBaseUrl',
    'upstreamApiKey',
    'defaultModel',
    'modelMap',
    'modelOverride',
    'gatewayApiKey',
    'toolMode',
    'reasoningPassthrough',
    'requestTimeoutMs',
    'maxBodyBytes',
    'btn-save',
    'btn-reset',
    'btn-test',
    'btn-models',
    'btn-tool',
    'btn-logout',
    'btn-logout-2',
    'btn-passwd',
    'acc-username',
    'acc-current',
    'acc-new',
    'chip-user-text',
    'models-box',
    'tool-box',
    'toasts',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `缺少 id=${id}`);
  }
  assert.ok(html.includes('保存并应用'));
  assert.ok(html.includes('/admin/api/settings'));
});

test('登录页：内联 JS 能解析，含用户名/口令与令牌兜底', () => {
  const html = renderLoginHtml({ version: '1.1.1' });
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  for (const id of ['username', 'password', 'token', 'err', 'err2', 'f', 'ft']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 id=${id}`);
  }
  assert.ok(html.includes('/admin/api/login'));
  assert.ok(html.includes('ADMIN_TOKEN'), '应保留令牌兜底入口');
  assert.equal(/<script[^>]+src=/i.test(html), false);
});

test('初始化向导：内联 JS 能解析，两步字段齐全且无外链', () => {
  const html = renderSetupHtml({ version: '1.1.1' });
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  for (const id of [
    'username',
    'password',
    'password2',
    'upstreamBaseUrl',
    'upstreamApiKey',
    'defaultModel',
    'btn-test',
    'btn-submit',
    'err',
    'models',
    'test-state',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `缺少 id=${id}`);
  }
  assert.ok(html.includes('/admin/api/setup'), '要提交到 setup 接口');
  assert.ok(html.includes('/admin/api/setup/test'), '要有保存前的连接测试');
  assert.ok(html.includes('完成初始化'));
  assert.equal(/<script[^>]+src=/i.test(html), false);
  assert.equal(/<link[^>]+href=["']https?:/i.test(html), false);
});

test('三个页面都不含内联事件处理器（CSP 只放行 false 时也不至于全挂）', () => {
  for (const html of [renderAdminHtml({}), renderLoginHtml({}), renderSetupHtml({})]) {
    assert.equal(/\son(click|submit|change|input)\s*=/i.test(html), false, '应使用 addEventListener 而不是内联事件');
  }
});

test('登录页把用户名回填进输入框（避免每次手打），且做 HTML 转义', () => {
  const html = renderLoginHtml({ username: 'admin' });
  assert.match(html, /id="username"[^>]*value="admin"/);
  const escaped = renderLoginHtml({ username: '"><script>x</script>' });
  assert.equal(escaped.includes('<script>x</script>'), false, '用户名必须转义');
});
