const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, host, svn, eventually, cleanup } = require('./host.cjs');

const review = 'SVN：审查待提交';
const reviewAndCommit = 'SVN：审查并提交';
const key = 'integration-review-fixture-key';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = { findings: [], context_requests: [] };

async function service(t, handler = () => clean) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', async () => {
      try {
        requests.push({ headers: request.headers, payload: JSON.parse(body) });
        const result = await handler(requests.length, requests.at(-1));
        if (!response.destroyed) response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
      } catch (error) { response.statusCode = 500; response.end(error.message); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, settings: { 'codeSvn.ai.baseUrl': `http://127.0.0.1:${server.address().port}/v1`, 'codeSvn.ai.model': 'review-fixture' } };
}

async function setKey(ui) {
  await ui.command('SVN：配置 AI API Key', false);
  const input = ui.page.locator('.quick-input-widget input[type="password"]').first();
  await input.fill(key);
  await ui.page.keyboard.press('Enter');
  await delay(600);
  await ui.page.keyboard.press('Escape');
  await eventually(async () => assert.match(await ui.notifications(), /API Key 已保存/));
}

async function prepare(t, svc) {
  const f = await fixture();
  let ui;
  t.after(async () => { if (ui) await ui.close(); await cleanup(f.root); });
  await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'review selected content\n');
  ui = await host(f.root, f.scope, svc.settings);
  await ui.command('SVN：刷新变更');
  await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
  await ui.commitMessage('审查后的提交');
  await setKey(ui);
  return { f, ui };
}

test('插件审查命令复用当前提交选择和 SecretStorage，并展示结果而不提交', { timeout: 90000 }, async t => {
  const svc = await service(t);
  const { f, ui } = await prepare(t, svc);
  await ui.command(review);
  await eventually(async () => assert.match(await ui.notifications(), /已提供范围内未发现/));
  assert.equal(svc.requests.length, 1);
  assert.equal(svc.requests[0].headers.authorization, `Bearer ${key}`);
  assert.match(svc.requests[0].payload.messages[1].content, /review selected content/);
  await ui.command('SVN：查看审查结果');
  await eventually(async () => assert.match(await ui.editorText(), /审查后的提交|提交选择/));
  assert.match(svn(f.root, 'info', '--xml', f.url), /revision="1"/);
});

test('审查并提交在最终确认后复用现有 SVN 提交流程', { timeout: 90000 }, async t => {
  const svc = await service(t);
  const { f, ui } = await prepare(t, svc);
  await ui.command(reviewAndCommit);
  const dialog = ui.page.locator('.monaco-dialog-box');
  await eventually(async () => assert.match(await dialog.innerText(), /未发现符合要求的问题[\s\S]*确认提交本次选择/));
  assert.equal(svc.requests.length, 1);
  assert.match(svn(f.root, 'info', '--xml', f.url), /revision="1"/);
  await dialog.locator('.monaco-button').filter({ hasText: '确认提交' }).click();
  await eventually(async () => assert.match(await ui.notifications(), /SVN 提交成功：修订 2/));
  assert.match(svn(f.root, 'info', '--xml', f.url), /revision="2"/);
});

test('有问题的审查要求单独确认，取消不会提交', { timeout: 90000 }, async t => {
  const svc = await service(t, () => ({ findings: [{ severity: 'high', confidence: 'high',
    file: '中文 空格 @目录/修改 中文.txt', side: 'new', line_start: 1, line_end: 1,
    title: '验证问题', trigger: '触发条件', evidence: '代码证据', impact: '后果',
    suggestion: '修改建议', verification: '验证方法' }], context_requests: [] }));
  const { f, ui } = await prepare(t, svc);
  await ui.command(reviewAndCommit);
  const dialog = ui.page.locator('.monaco-dialog-box');
  await eventually(async () => assert.match(await dialog.innerText(), /仍然提交（有审查问题）[\s\S]*发现 1 个问题/));
  assert.match(svn(f.root, 'info', '--xml', f.url), /revision="1"/);
  await dialog.locator('.monaco-button').filter({ hasText: /^(取消|Cancel)$/ }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.match(svn(f.root, 'info', '--xml', f.url), /revision="1"/);
});

test('审查请求期间提交信息变化会取消请求并让结果过期', { timeout: 90000 }, async t => {
  const svc = await service(t, async () => { await delay(1200); return clean; });
  const { f, ui } = await prepare(t, svc);
  await ui.command(review);
  await eventually(async () => assert.equal(svc.requests.length, 1));
  await ui.commitMessage('新的提交意图');
  await eventually(async () => assert.match(await ui.notifications(), /审查依据已变化/));
  await ui.command('SVN：查看审查结果');
  assert.match(await ui.editorText(), /提交信息已变化|结果已过期/);
  assert.match(svn(f.root, 'info', '--xml', f.url), /revision="1"/);
});

test('AI 设置变化立即使已有审查结果过期', { timeout: 90000 }, async t => {
  const svc = await service(t);
  const { f, ui } = await prepare(t, svc);
  await ui.command(review);
  await eventually(async () => assert.match(await ui.notifications(), /已提供范围内未发现/));
  await ui.settings({ 'codeSvn.ai.model': 'review-fixture-updated' });
  await eventually(async () => assert.match(await ui.editorText(), /AI 服务配置已变化|结果已过期/));
  assert.match(svn(f.root, 'info', '--xml', f.url), /revision="1"/);
});
