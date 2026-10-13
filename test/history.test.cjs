const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { fixture, host, svn, eventually, cleanup } = require('./host.cjs');

const historyCommand = 'SVN：查看历史';
const moreRow = '加载更早的 50 条';

async function peer(f) {
  const wc = path.join(f.root, 'peer');
  svn(f.root, 'checkout', f.url, wc);
  return wc;
}

// Commits through a separate working copy so the opened one stays behind the server.
function commit(wc, relative, text, message) {
  if (text !== undefined) fsSync.writeFileSync(path.join(wc, relative), text);
  return Number(/Committed revision (\d+)/.exec(svn(wc, 'commit', '-m', message, '--', `${relative}@`))[1]);
}

async function interceptSvn(f, logScript) {
  const executable = process.env.SVN_EXECUTABLE || 'svn';
  const delegate = `const {execFileSync}=require('node:child_process');const path=require('node:path');` +
    `process.stdout.write(execFileSync(${JSON.stringify(executable)},[path.basename(process.argv[1]),...process.argv.slice(2)],{cwd:process.cwd(),encoding:'utf8',windowsHide:true}));`;
  for (const command of ['info', 'status']) await fs.writeFile(path.join(f.scope, command), delegate);
  await fs.writeFile(path.join(f.scope, 'log'), logScript);
  return { 'codeSvn.svnPath': process.execPath };
}

async function openHistory(ui, name) {
  const page = ui.page;
  await page.keyboard.press('Control+Shift+E');
  const row = page.locator('.explorer-viewlet .monaco-list-row').filter({ hasText: name }).first();
  const item = page.locator('.monaco-menu-container .action-label').filter({ hasText: historyCommand }).first();
  // Explorer context keys apply only once the row is selected and the explorer
  // has focus, so retry the select-and-right-click sequence until the item shows.
  await eventually(async () => {
    await page.keyboard.press('Escape');
    await row.waitFor();
    await row.click();
    await row.click({ button: 'right' });
    await item.waitFor({ timeout: 2000 });
  });
  // Let the menu finish opening; clicking during its animation can dismiss it.
  await page.waitForTimeout(500);
  await item.click();
  await picker(ui).waitFor();
}

function picker(ui) {
  return ui.page.locator('.quick-input-widget input').first();
}

async function placeholder(ui) {
  return picker(ui).getAttribute('placeholder');
}

async function rowTexts(ui) {
  return (await ui.page.locator('.quick-input-list .monaco-list-row').allInnerTexts()).map(text => text.trim());
}

function revisionOf(row) {
  const match = /^r(\d+)/.exec(row);
  return match ? Number(match[1]) : undefined;
}

// The quick-input list virtualizes rows, so checks use fuzzy filters that narrow
// to one revision and assert presence or absence against the loaded set.
async function filterFor(ui, text) {
  await picker(ui).fill(text);
  await ui.page.waitForTimeout(400);
  return (await rowTexts(ui)).map(revisionOf).filter(Boolean);
}

async function expectRevision(ui, revision, present) {
  await eventually(async () => {
    const revisions = await filterFor(ui, `r${revision}`);
    if (present) assert.ok(revisions.includes(revision), `r${revision} should be listed`);
    else assert.deepEqual(revisions, [], `r${revision} should not be listed yet`);
  });
}

async function loadMore(ui, before) {
  await picker(ui).fill('加载更早');
  await eventually(async () => assert.ok((await rowTexts(ui)).some(row => row.includes(moreRow))));
  await ui.page.keyboard.press('Enter');
  await eventually(async () => assert.notEqual(await placeholder(ui), before));
  await picker(ui).fill('');
}

test('文件历史显示服务器最新记录，每批 50 条加载更早记录且不重复或遗漏', { timeout: 300000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const name = '修改 中文.txt';
    const relative = path.join(path.basename(f.scope), name);
    for (let index = 1; index <= 120; index++) commit(other, relative, `REVISION ${index}\n`, `history ${index}`);
    // r1 is the import that created the file; r2..r121 each changed it.
    ui = await host(f.root, f.scope);
    await openHistory(ui, name);
    await eventually(async () => assert.equal(await placeholder(ui), '已显示 50 条，最新优先'));
    const first = (await rowTexts(ui))[0];
    assert.match(first, /^r121/);
    assert.match(first, /history 120/);
    await expectRevision(ui, 121, true);
    await expectRevision(ui, 72, true);
    await expectRevision(ui, 71, false);

    await loadMore(ui, '已显示 50 条，最新优先');
    await eventually(async () => assert.equal(await placeholder(ui), '已显示 100 条，最新优先'));
    await expectRevision(ui, 71, true);
    await expectRevision(ui, 22, true);
    await expectRevision(ui, 21, false);

    await loadMore(ui, '已显示 100 条，最新优先');
    await eventually(async () => assert.equal(await placeholder(ui), '已显示全部 121 条，最新优先'));
    await expectRevision(ui, 21, true);
    await expectRevision(ui, 1, true);
    await picker(ui).fill('加载更早');
    await ui.page.waitForTimeout(400);
    assert.deepEqual(await rowTexts(ui), []);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('目录历史包含子项新增与修改，不混入只改动目录外兄弟文件的修订', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const dir = path.basename(f.scope);
    const edited = commit(other, path.join(dir, '修改 中文.txt'), 'child edit\n', 'edit child');
    const sibling = commit(other, path.join('sibling', 'outside.txt'), 'outside edit\n', 'sibling only');
    await fs.writeFile(path.join(other, dir, 'new child.txt'), 'added\n');
    svn(other, 'add', '--', `${path.join(dir, 'new child.txt')}@`);
    const added = commit(other, path.join(dir, 'new child.txt'), undefined, 'add child');
    assert.ok(sibling > edited && added > sibling);
    // f.wc is still at r1, so these records come from the server only.
    ui = await host(f.root, f.wc);
    await openHistory(ui, dir);
    await eventually(async () => assert.equal(await placeholder(ui), '已显示全部 3 条，最新优先'));
    assert.deepEqual((await rowTexts(ui)).map(revisionOf).filter(Boolean), [added, edited, 1]);
    assert.ok(!(await rowTexts(ui)).some(row => revisionOf(row) === sibling));
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('历史复制或移动前的旧路径记录可追溯', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const dir = path.basename(f.scope);
    const oldName = '修改 中文.txt';
    const newName = '移动后 中文.txt';
    const edited = commit(other, path.join(dir, oldName), 'before move\n', 'edit before move');
    svn(other, 'move', '--', `${path.join(dir, oldName)}@`, `${path.join(dir, newName)}@`);
    const moved = Number(/Committed revision (\d+)/.exec(svn(other, 'commit', '-m', 'move file', '--', `${dir}@`))[1]);
    svn(f.wc, 'update');
    ui = await host(f.root, f.scope);
    await openHistory(ui, newName);
    await eventually(async () => assert.equal(await placeholder(ui), '已显示全部 3 条，最新优先'));
    assert.deepEqual((await rowTexts(ui)).map(revisionOf).filter(Boolean), [moved, edited, 1]);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('取消历史查询后停止 SVN 进程，不显示错误或空历史', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const settings = await interceptSvn(f,
      `const fs=require('node:fs');fs.writeFileSync('log-started','');` +
      `setTimeout(()=>fs.writeFileSync('log-finished',''),8000);`);
    ui = await host(f.root, f.scope, settings);
    await openHistory(ui, '修改 中文.txt');
    await eventually(async () => assert.ok(await fs.stat(path.join(f.scope, 'log-started'))));
    await ui.page.keyboard.press('Escape');
    await picker(ui).waitFor({ state: 'hidden' });
    await new Promise(resolve => setTimeout(resolve, 10000));
    await assert.rejects(fs.stat(path.join(f.scope, 'log-finished')), { code: 'ENOENT' });
    assert.doesNotMatch(await ui.notifications(), /查询历史失败|没有历史记录/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

for (const [detail, guidance] of [
  ['svn: E170001: Authentication failed', '认证失败'],
  ['svn: E230001: Server SSL certificate verification failed', '证书校验失败'],
  ['svn: E170013: Unable to connect to a repository: Connection refused', '无法连接服务器']
]) {
  test(`历史查询失败提示 ${detail}，不显示为空历史且不重试`, { timeout: 120000 }, async () => {
    const f = await fixture();
    let ui;
    try {
      const settings = await interceptSvn(f,
        `const fs=require('node:fs');fs.appendFileSync('log-attempts','x\\n');` +
        `process.stderr.write(${JSON.stringify(detail)});process.exitCode=1;`);
      ui = await host(f.root, f.scope, settings);
      await openHistory(ui, '修改 中文.txt');
      await eventually(async () => assert.ok((await ui.notifications()).includes(detail)));
      assert.match(await ui.notifications(), new RegExp(guidance));
      await picker(ui).waitFor({ state: 'hidden' });
      assert.equal((await fs.readFile(path.join(f.scope, 'log-attempts'), 'utf8')).trim().split('\n').length, 1);
      assert.doesNotMatch(await ui.notifications(), /没有历史记录/);
    } finally {
      if (ui) await ui.close();
      await cleanup(f.root);
    }
  });
}
