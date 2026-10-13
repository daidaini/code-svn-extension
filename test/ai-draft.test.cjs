const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, host, svn, eventually, cleanup } = require('./host.cjs');

const generate = 'SVN：生成提交信息草稿';
const setKey = 'SVN：配置 AI API Key';
const apiKey = 'sk-test-key-1234567890';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Controlled model service: records every request and answers per scenario.
function service(handler) {
  const requests = [];
  const timers = new Set();
  const schedule = (ms, run) => {
    const timer = setTimeout(() => { timers.delete(timer); run(); }, ms);
    timers.add(timer);
  };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, headers: request.headers, body });
      handler(response, requests[requests.length - 1], schedule);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    requests,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections?.();
      return new Promise(done => server.close(done));
    }
  })));
}

function reply(response, draft) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: draft } }] }));
}

function delayed(response, schedule, draft, ms) {
  if (ms <= 0) return reply(response, draft);
  schedule(ms, () => { if (!response.destroyed) reply(response, draft); });
}

function fail(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body);
}

function revision(f) {
  return Number(/revision="(\d+)"/.exec(svn(f.root, 'info', '--xml', f.url))[1]);
}

// Old toasts push new ones out of view; clear them so each assertion sees this step only.
async function clearToasts(ui) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cleared = await ui.page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.notifications-toasts .codicon-notifications-clear')];
      for (const button of buttons) button.click();
      return buttons.length;
    });
    await delay(250);
    if (!cleared) return;
  }
}

async function generateDraft(ui) {
  await clearToasts(ui);
  await ui.command(generate);
}

// Storing the key is async; wait for its confirmation, otherwise the next read may be stale.
async function setApiKey(ui, value = apiKey) {
  await clearToasts(ui);
  await ui.command(setKey, false);
  const input = ui.page.locator('.quick-input-widget input[type="password"]').first();
  await input.waitFor({ state: 'visible' });
  await input.fill(value);
  await ui.page.keyboard.press('Enter');
  await ui.page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
  // Without a system keyring VS Code raises a SecretStorage downgrade notice that grabs
  // focus; dismiss it, or it swallows the following keybindings.
  await delay(600);
  await ui.page.keyboard.press('Escape');
  await eventually(async () => assert.match(await ui.notifications(), /API Key 已保存/), 10000);
}

// Activate the SCM view before reading the input box; a hidden view yields no text.
async function messageText(ui, index = 0) {
  await ui.focus();
  await ui.page.keyboard.press('Control+Shift+G');
  await delay(300);
  return ui.commitMessageText(index);
}

async function appendMessage(ui, text) {
  await ui.focus();
  await ui.page.keyboard.press('Control+Shift+G');
  await ui.page.locator('.scm-view .scm-input .monaco-editor').first().click({ position: { x: 30, y: 15 } });
  await ui.page.keyboard.press('Control+End');
  await ui.page.keyboard.insertText(text);
}

async function cancelProgress(ui) {
  // Cancellation is a text button that appears after the toast expands; click it when ready.
  await eventually(async () => {
    const clicked = await ui.page.evaluate(() => {
      const button = [...document.querySelectorAll('.notifications-toasts .monaco-button')]
        .find(candidate => /^(Cancel|取消)$/.test((candidate.textContent || '').trim()));
      if (!button) return false;
      button.click();
      return true;
    });
    assert.ok(clicked, '生成进度提示应提供取消入口');
  }, 20000);
}

async function confirmDialog(ui, action) {
  const dialog = ui.page.locator('.monaco-dialog-box');
  await dialog.waitFor();
  await dialog.locator('.monaco-button').filter({ hasText: action === '取消' ? /^(取消|Cancel)$/ : action }).click();
  await dialog.waitFor({ state: 'hidden' });
}

test('空选择与缺少 API Key 不发送请求；有效配置只把选中差异交服务并填入可修改的草稿', { timeout: 180000 }, async () => {
  const f = await fixture();
  const svc = await service((response, _request, schedule) => delayed(response, schedule, '完善中文说明文档\n- 调整安装步骤的措辞', 300));
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), '第一行改为安装步骤\n第二行保持不变\n');
    await fs.writeFile(path.join(f.scope, '未选.txt'), '未选文件内容 OUTSIDE-OF-SCOPE\n');
    ui = await host(f.root, f.scope, { 'codeSvn.ai.baseUrl': svc.url, 'codeSvn.ai.model': 'test-model' });
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /修改 中文\.txt/));

    await generateDraft(ui);
    await eventually(async () => assert.match(await ui.notifications(), /没有待提交文件/));
    assert.equal(svc.requests.length, 0, '空选择不能请求');

    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await eventually(async () => assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/));
    await generateDraft(ui);
    await eventually(async () => assert.match(await ui.notifications(), /未保存 API Key/));
    assert.match(await ui.notifications(), /未发送请求/);
    assert.equal(svc.requests.length, 0);

    await setApiKey(ui);
    await generateDraft(ui);
    await eventually(async () => assert.match(await ui.notifications(), /草稿已填入/));
    assert.equal(svc.requests.length, 1, '一次请求生成完整草稿');

    const request = svc.requests[0];
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
    const payload = JSON.parse(request.body);
    assert.equal(payload.model, 'test-model');
    assert.equal(payload.stream, false);
    assert.equal(payload.messages.length, 2);
    assert.match(payload.messages[0].content, /中文/);
    const input = payload.messages[1].content;
    assert.match(input, /### 文件：中文 空格 @目录\/修改 中文\.txt/);
    assert.match(input, /\+第一行改为安装步骤/);
    assert.match(input, /-initial/);
    assert.doesNotMatch(input, /OUTSIDE-OF-SCOPE/, '未选文件内容不得进入请求');
    assert.doesNotMatch(input, /未选\.txt/, '未选文件不得进入请求');

    assert.match(await messageText(ui), /完善中文说明文档/);
    assert.match(await messageText(ui), /调整安装步骤的措辞/);
    assert.equal(revision(f), 1, '生成不得自动提交');
    await ui.focus();
    await ui.page.keyboard.press('Control+Shift+G');
    assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/, '生成不改变提交选择');

    await appendMessage(ui, '\n- 人工补充要点');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.equal(revision(f), 2);
    assert.match(svn(f.root, 'log', '--xml', '-l', '1', f.url), /完善中文说明文档[\s\S]*人工补充要点/);
  } finally {
    await svc.close();
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('选中文件有未保存内容时先提示；取消不请求，保存并生成后请求使用保存后的内容', { timeout: 180000 }, async () => {
  const f = await fixture();
  const svc = await service((response, _request, schedule) => delayed(response, schedule, '保存后生成的草稿', 0));
  let ui;
  try {
    const target = path.join(f.scope, '修改 中文.txt');
    await fs.writeFile(target, 'SAVED\n');
    ui = await host(f.root, f.scope, { 'codeSvn.ai.baseUrl': svc.url, 'codeSvn.ai.model': 'test-model' });
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.editFile(target, '编辑器里的未保存内容\n');
    await setApiKey(ui);

    await generateDraft(ui);
    const dialog = ui.page.locator('.monaco-dialog-box');
    await eventually(async () => assert.match(await dialog.innerText(), /未保存内容/), 15000);
    await confirmDialog(ui, '取消');
    assert.equal(svc.requests.length, 0, '取消保存提示时不得请求模型服务');
    assert.equal(await fs.readFile(target, 'utf8'), 'SAVED\n');
    assert.match(await ui.editorText(), /编辑器里的未保存内容/);

    await generateDraft(ui);
    await dialog.waitFor();
    await dialog.locator('.monaco-button').filter({ hasText: '保存并生成' }).click();
    await eventually(async () => assert.match(await ui.notifications(), /草稿已填入/));
    assert.equal(svc.requests.length, 1);
    assert.match(await fs.readFile(target, 'utf8'), /编辑器里的未保存内容/, '确认后应保存选中文件');
    assert.match(svc.requests[0].body, /编辑器里的未保存内容/);
    assert.doesNotMatch(svc.requests[0].body, /SAVED/, '请求应使用保存后的编辑内容');
    assert.match(await messageText(ui), /保存后生成的草稿/);
  } finally {
    await svc.close();
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('提交输入框已有内容时先确认；取消不请求也不覆盖，确认后才用草稿替换', { timeout: 180000 }, async () => {
  const f = await fixture();
  const svc = await service((response, _request, schedule) => delayed(response, schedule, '模型生成的草稿', 0));
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), '本地内容改动\n');
    ui = await host(f.root, f.scope, { 'codeSvn.ai.baseUrl': svc.url, 'codeSvn.ai.model': 'test-model' });
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('我自己写的提交信息');
    await setApiKey(ui);

    await generateDraft(ui);
    const dialog = ui.page.locator('.monaco-dialog-box');
    await eventually(async () => assert.match(await dialog.innerText(), /替换当前提交信息/), 15000);
    assert.match(await dialog.innerText(), /我自己写的提交信息/);
    await confirmDialog(ui, '取消');
    assert.equal(svc.requests.length, 0, '取消替换时不得请求模型服务');
    assert.match(await messageText(ui), /我自己写的提交信息/);

    await generateDraft(ui);
    await dialog.waitFor();
    await dialog.locator('.monaco-button').filter({ hasText: '继续生成' }).click();
    await eventually(async () => assert.match(await ui.notifications(), /草稿已填入/));
    assert.equal(svc.requests.length, 1);
    const draft = await messageText(ui);
    assert.match(draft, /模型生成的草稿/);
    assert.doesNotMatch(draft, /我自己写的提交信息/);
    assert.equal(revision(f), 1, '替换草稿后仍需用户手动提交');
  } finally {
    await svc.close();
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('属性、二进制与新增输入明确拒绝且不发送请求，普通文本修改仍可生成', { timeout: 180000 }, async () => {
  const f = await fixture();
  const svc = await service((response, _request, schedule) => delayed(response, schedule, '不该被调用的草稿', 0));
  let ui;
  try {
    svn(f.scope, 'propset', 'owner', 'team', '修改 中文.txt');
    await fs.writeFile(path.join(f.scope, 'data.bin'), Buffer.from([1, 2, 3, 4]));
    svn(f.scope, 'add', 'data.bin');
    svn(f.scope, 'commit', 'data.bin', '-m', '二进制基线');
    await fs.writeFile(path.join(f.scope, 'data.bin'), Buffer.from([9, 8, 7, 6, 0]));
    await fs.writeFile(path.join(f.scope, '新增.txt'), 'NEW\n');
    svn(f.scope, 'add', '新增.txt');
    ui = await host(f.root, f.scope, { 'codeSvn.ai.baseUrl': svc.url, 'codeSvn.ai.model': 'test-model' });
    await ui.command('SVN：刷新变更');
    await setApiKey(ui);
    for (const name of ['修改 中文.txt', 'data.bin', '新增.txt']) {
      await ui.chooseChange('SVN：加入待提交', name);
    }
    await generateDraft(ui);
    await eventually(async () => assert.match(await ui.notifications(), /尚不支持的输入/), 15000);
    const message = await ui.notifications();
    assert.match(message, /修改 中文\.txt：属性变化/);
    assert.match(message, /data\.bin：二进制内容/);
    assert.match(message, /新增\.txt：已添加/);
    assert.match(message, /未发送请求/);
    assert.equal(svc.requests.length, 0);

    // Commit the added file, then make it a plain text change: refusal only covered that input.
    await clearToasts(ui);
    svn(f.scope, 'commit', '新增.txt', '-m', '新增基线');
    await fs.writeFile(path.join(f.scope, '新增.txt'), '现在的文本内容\n');
    for (const name of ['修改 中文.txt', 'data.bin', '新增.txt']) {
      await ui.chooseChange('SVN：移出待提交', name);
    }
    await eventually(async () => assert.match(await ui.scmText(), /新增\.txt/));
    await ui.chooseChange('SVN：加入待提交', '新增.txt');
    await generateDraft(ui);
    await eventually(async () => assert.match(await ui.notifications(), /草稿已填入/));
    assert.equal(svc.requests.length, 1);
    assert.match(svc.requests[0].body, /### 文件：中文 空格 @目录\/新增\.txt/);
    assert.match(svc.requests[0].body, /\+现在的文本内容/);
  } finally {
    await svc.close();
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('取消、超时与服务错误都保留原提交信息，由用户手动重试', { timeout: 240000 }, async () => {
  const f = await fixture();
  const mode = { delay: 0, status: 0, draft: '重试后的草稿' };
  const svc = await service((response, _request, schedule) => {
    if (mode.status) return fail(response, mode.status, JSON.stringify({ error: { message: '服务繁忙，请稍后重试' } }));
    delayed(response, schedule, mode.draft, mode.delay);
  });
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), '一次普通修改\n');
    ui = await host(f.root, f.scope, { 'codeSvn.ai.baseUrl': svc.url, 'codeSvn.ai.model': 'test-model' });
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('原有的提交信息');
    await setApiKey(ui);

    mode.delay = 60000;
    await generateDraft(ui);
    await confirmDialog(ui, '继续生成');
    // Clicking again while a generation runs must not send a second request.
    await ui.command(generate);
    await eventually(async () => assert.match(await ui.notifications(), /正在生成提交信息草稿[\s\S]*不会重复请求/));
    await cancelProgress(ui);
    await eventually(async () => assert.match(await ui.notifications(), /生成已取消/));
    await delay(1500);
    const afterCancel = svc.requests.length;
    assert.ok(afterCancel <= 1, '取消后不再发出新请求');
    assert.match(await messageText(ui), /原有的提交信息/);
    assert.equal(revision(f), 1);

    mode.delay = 0;
    mode.status = 500;
    await generateDraft(ui);
    await confirmDialog(ui, '继续生成');
    await eventually(async () => assert.match(await ui.notifications(), /HTTP 500[\s\S]*服务繁忙/), 15000);
    await delay(1500);
    assert.equal(svc.requests.length, afterCancel + 1, '服务错误只请求一次，不自动重试');
    assert.match(await messageText(ui), /原有的提交信息/);
    mode.status = 0;

    await ui.settings({ 'codeSvn.ai.timeoutSeconds': 1 });
    mode.delay = 8000;
    await generateDraft(ui);
    await confirmDialog(ui, '继续生成');
    await eventually(async () => assert.match(await ui.notifications(), /超时/), 15000);
    await delay(1500);
    assert.equal(svc.requests.length, afterCancel + 2, '超时只请求一次，不自动重试');
    assert.match(await messageText(ui), /原有的提交信息/);

    await ui.settings({ 'codeSvn.ai.timeoutSeconds': 60 });
    await generateDraft(ui);
    await confirmDialog(ui, '继续生成');
    await eventually(async () => assert.match(await messageText(ui), /重试后的草稿/), 20000);
    assert.equal(svc.requests.length, afterCancel + 3);
  } finally {
    await svc.close();
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('请求期间提交选择变化时丢弃结果，不填入过期草稿', { timeout: 180000 }, async () => {
  const f = await fixture();
  const mode = { delay: 4000, draft: '过期草稿' };
  const svc = await service((response, _request, schedule) => delayed(response, schedule, mode.draft, mode.delay));
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), '生成期间的内容变化\n');
    ui = await host(f.root, f.scope, { 'codeSvn.ai.baseUrl': svc.url, 'codeSvn.ai.model': 'test-model' });
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await setApiKey(ui);
    await generateDraft(ui);
    await ui.chooseChange('SVN：移出待提交', '修改 中文.txt');
    await eventually(async () => assert.match(await ui.notifications(), /生成期间已变化[\s\S]*草稿未填入/), 20000);
    assert.equal(await messageText(ui), '');
    assert.equal(svc.requests.length, 1);
    assert.equal(revision(f), 1);

    mode.delay = 0;
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await generateDraft(ui);
    await eventually(async () => assert.match(await ui.notifications(), /草稿已填入/));
    assert.match(await messageText(ui), /过期草稿/);
  } finally {
    await svc.close();
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});
