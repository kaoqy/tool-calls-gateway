// 设置页 / 登录页的静态校验：内联脚本必须能解析、不能引外部资源、关键元素 id 不能丢。
// （曾经因为模板字符串反斜杠转义把内联 JS 写坏过一次，这里做回归防线。）
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAdminHtml, renderLoginHtml } from '../src/admin-ui.mjs';

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
    'models-box',
    'tool-box',
    'toasts',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `缺少 id=${id}`);
  }
  assert.ok(html.includes('保存并应用'));
  assert.ok(html.includes('/admin/api/settings'));
});

test('登录页：内联 JS 能解析，含令牌输入框与错误位', () => {
  const html = renderLoginHtml({ version: '1.1.1' });
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  assert.ok(html.includes('id="token"'));
  assert.ok(html.includes('id="err"'));
  assert.ok(html.includes('/admin/api/login'));
  assert.equal(/<script[^>]+src=/i.test(html), false);
});
