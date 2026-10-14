const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, host, eventually, cleanup } = require('./host.cjs');

// Opt-in check against a real OpenAI-compatible service. It is skipped unless the
// key is set in the environment, so the key never lives in the repository.
//   SVN_AI_TEST_KEY       API key (required to run)
//   SVN_AI_TEST_BASE_URL  e.g. https://maas-api.antdigital.com/v1
//   SVN_AI_TEST_MODEL     e.g. lingdt-3.0-flash
const apiKey = process.env.SVN_AI_TEST_KEY ?? '';
const baseUrl = process.env.SVN_AI_TEST_BASE_URL ?? '';
const model = process.env.SVN_AI_TEST_MODEL ?? '';
const generate = 'SVN：生成提交信息草稿';
const setKey = 'SVN：配置 AI API Key';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// Storing the key is asynchronous; wait for the confirmation before the next read.
async function setApiKey(ui) {
  await ui.command(setKey, false);
  const input = ui.page.locator('.quick-input-widget input[type="password"]').first();
  await input.waitFor({ state: 'visible' });
  await input.fill(apiKey);
  await ui.page.keyboard.press('Enter');
  await ui.page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
  await delay(600);
  await ui.page.keyboard.press('Escape');
  await eventually(async () => assert.match(await ui.notifications(), /API Key 已保存/), 10000);
}

async function messageText(ui) {
  await ui.focus();
  await ui.page.keyboard.press('Control+Shift+G');
  await delay(300);
  return ui.commitMessageText(0);
}

test('真实模型服务：选中文本变更生成非空草稿，密钥不出现在草稿中', { skip: !apiKey, timeout: 240000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), '第一行改为安装步骤\n第二行保持不变\n');
    ui = await host(f.root, f.scope, {
      'codeSvn.ai.baseUrl': baseUrl,
      'codeSvn.ai.model': model,
      'codeSvn.ai.timeoutSeconds': 120
    });
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /修改 中文\.txt/));
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await setApiKey(ui);

    await clearToasts(ui);
    await ui.command(generate);
    await eventually(async () => assert.match(await ui.notifications(), /草稿已填入/), 150000);

    const draft = await messageText(ui);
    assert.ok(draft.trim().length > 0, '真实服务应返回非空草稿');
    assert.doesNotMatch(draft, new RegExp(apiKey.slice(0, 12)), '草稿中不得出现密钥');
    assert.equal(await fs.readFile(path.join(f.scope, '修改 中文.txt'), 'utf8'), '第一行改为安装步骤\n第二行保持不变\n', '生成不得改动文件');
    console.log('真实服务草稿：\n' + draft);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});
