const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { fixture, host, svn, eventually, cleanup } = require('./host.cjs');

const historyCommand = 'SVN：查看历史';
const name = '修改 中文.txt';

async function peer(f) {
  const wc = path.join(f.root, 'peer');
  svn(f.root, 'checkout', f.url, wc);
  return wc;
}

// Writes files in a working copy, adding new ones, then commits the given paths as one revision.
function commitPaths(wc, message, files) {
  for (const [relative, text, isNew] of files) {
    fsSync.mkdirSync(path.dirname(path.join(wc, relative)), { recursive: true });
    fsSync.writeFileSync(path.join(wc, relative), text);
    if (isNew) svn(wc, 'add', '--parents', '--', `${relative}@`);
  }
  return commitRevision(wc, message, files.map(([relative]) => relative));
}

function commitRevision(wc, message, targets) {
  return Number(/Committed revision (\d+)/.exec(svn(wc, 'commit', '-m', message, '--', ...targets.map(target => `${target}@`)))[1]);
}

async function interceptSvn(f, logScript) {
  const executable = process.env.SVN_EXECUTABLE || 'svn';
  const delegate = `const {execFileSync}=require('node:child_process');const path=require('node:path');` +
    `process.stdout.write(execFileSync(${JSON.stringify(executable)},[path.basename(process.argv[1]),...process.argv.slice(2)],{cwd:process.cwd(),encoding:'utf8',windowsHide:true}));`;
  for (const command of ['info', 'status']) await fs.writeFile(path.join(f.scope, command), delegate);
  await fs.writeFile(path.join(f.scope, 'log'), logScript.replace('DELEGATE_LOG', delegate));
  return { 'codeSvn.svnPath': process.execPath };
}

async function openHistory(ui, label) {
  const page = ui.page;
  await page.keyboard.press('Control+Shift+E');
  const row = page.locator('.explorer-viewlet .monaco-list-row').filter({ hasText: label }).first();
  const item = page.locator('.monaco-menu-container .action-label').filter({ hasText: historyCommand }).first();
  await eventually(async () => {
    await page.keyboard.press('Escape');
    await row.waitFor();
    await row.click();
    await row.click({ button: 'right' });
    await item.waitFor({ timeout: 2000 });
  });
  await page.waitForTimeout(500);
  await item.click();
  await picker(ui).waitFor();
  await eventually(async () => assert.ok((await rowTexts(ui)).length > 0));
}

async function placeholder(ui) {
  return picker(ui).getAttribute('placeholder');
}

function picker(ui) {
  return ui.page.locator('.quick-input-widget input').first();
}

async function rowTexts(ui) {
  return (await ui.page.locator('.quick-input-list .monaco-list-row').allInnerTexts()).map(text => text.trim());
}

// Accepting a revision row hides the history list and opens its changed paths.
async function openRevision(ui, revision) {
  await picker(ui).fill(`r${revision}`);
  await eventually(async () => assert.match((await rowTexts(ui))[0] ?? '', new RegExp(`^r${revision}(?!\\d)`)));
  await ui.page.keyboard.press('Enter');
  await eventually(async () => assert.match(await ui.page.locator('.quick-input-title').first().innerText(), new RegExp(`r${revision}`)));
  // The changed paths load after the picker opens, so wait for rows as well.
  await eventually(async () => assert.ok((await rowTexts(ui)).length > 0));
}

async function chooseRevisionPath(ui, text) {
  await picker(ui).fill(text);
  await eventually(async () => assert.equal((await rowTexts(ui)).length, 1));
  await ui.page.keyboard.press('Enter');
}

async function openedDiff(ui) {
  await eventually(async () => assert.ok(await ui.diffCount() > 0, `no diff; notifications: ${await ui.notifications()}`));
  return ui.diffSides();
}

test('点击修订只列出所查询文件的变化，差异使用提交前后的历史内容而非本地草稿', { timeout: 180000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const dir = path.basename(f.scope);
    commitPaths(other, 'first edit', [[path.join(dir, name), 'FIRST\n']]);
    const revision = commitPaths(other, 'mixed change', [
      [path.join(dir, name), 'SECOND\n'],
      [path.join(dir, 'other 中文.txt'), 'unrelated new file\n', true],
      [path.join('sibling', 'outside.txt'), 'outside edit\n']
    ]);
    await fs.writeFile(path.join(f.scope, name), 'LOCAL DRAFT\n');
    ui = await host(f.root, f.scope);
    await openHistory(ui, name);
    await openRevision(ui, revision);
    assert.deepEqual(await rowTexts(ui).then(rows => rows.length), 1);
    assert.match((await rowTexts(ui))[0], new RegExp(`${name}`));
    await ui.page.keyboard.press('Enter');
    const sides = await openedDiff(ui);
    assert.match(sides.original, /FIRST/);
    assert.match(sides.modified, /SECOND/);
    assert.doesNotMatch(sides.modified, /LOCAL DRAFT/);
    assert.doesNotMatch(sides.original + sides.modified, /unrelated|outside/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('目录修订只列出目录子项变化，不混入同一修订中目录外的兄弟文件', { timeout: 180000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const dir = path.basename(f.scope);
    const revision = commitPaths(other, 'dir and sibling', [
      [path.join(dir, 'child 中文.txt'), 'child\n', true],
      [path.join('sibling', 'outside.txt'), 'outside edit\n']
    ]);
    ui = await host(f.root, f.wc);
    await openHistory(ui, dir);
    await openRevision(ui, revision);
    const rows = await rowTexts(ui);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /child 中文\.txt/);
    assert.doesNotMatch(rows.join('\n'), /outside/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('移动后的修订列出旧路径删除与新路径复制，差异对应复制来源与修订前后内容', { timeout: 180000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const dir = path.basename(f.scope);
    const newName = '移动后 中文.txt';
    commitPaths(other, 'before move', [[path.join(dir, name), 'BEFORE MOVE\n']]);
    // Run inside the directory: a peg suffix on the destination would become part of the name.
    svn(path.join(other, dir), 'move', '--', name, newName);
    fsSync.writeFileSync(path.join(other, dir, newName), 'AFTER MOVE\n');
    const moved = commitRevision(other, 'move and edit', [dir]);
    svn(f.wc, 'update');
    ui = await host(f.root, f.scope);
    await openHistory(ui, newName);
    await openRevision(ui, moved);
    const rows = (await rowTexts(ui)).join('\n');
    assert.match(rows, /已删除[\s\S]*修改 中文\.txt/);
    assert.match(rows, /已添加[\s\S]*移动后 中文\.txt/);
    await chooseRevisionPath(ui, '移动后');
    const sides = await openedDiff(ui);
    assert.match(sides.original, /BEFORE MOVE/);
    assert.match(sides.modified, /AFTER MOVE/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('加载更早记录后打开后续批次的修订，差异仍对应该修订前后内容', { timeout: 240000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const relative = path.join(path.basename(f.scope), name);
    // Revision R holds "REVISION R-1", so r5 changes REVISION 3 into REVISION 4.
    for (let index = 1; index <= 60; index++) commitPaths(other, `history ${index}`, [[relative, `REVISION ${index}\n`]]);
    ui = await host(f.root, f.scope);
    await openHistory(ui, name);
    await eventually(async () => assert.equal(await placeholder(ui), '已显示 50 条，最新优先'));
    await picker(ui).fill('加载更早');
    await eventually(async () => assert.ok((await rowTexts(ui)).some(row => row.includes('加载更早的 50 条'))));
    await ui.page.keyboard.press('Enter');
    await eventually(async () => assert.equal(await placeholder(ui), '已显示全部 61 条，最新优先'));
    await openRevision(ui, 5);
    await chooseRevisionPath(ui, '修改 中文');
    const sides = await openedDiff(ui);
    assert.match(sides.original, /REVISION 3\b/);
    assert.match(sides.modified, /REVISION 4\b/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('修订中的属性变化在属性差异中展示提交前后的值', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const relative = path.join(path.basename(f.scope), name);
    commitPaths(other, 'text base', [[relative, 'SAME\n']]);
    svn(path.join(other, path.basename(f.scope)), 'propset', 'review-state', 'BEFORE', name);
    const revision = commitRevision(other, 'property change', [path.join(path.basename(f.scope), name)]);
    ui = await host(f.root, f.scope);
    await openHistory(ui, name);
    await openRevision(ui, revision);
    await chooseRevisionPath(ui, name);
    await eventually(async () => assert.match(await ui.editorText(), /新增属性 review-state = BEFORE/));
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('修订中的二进制内容只提示无法分析，不展示文本差异', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const dir = path.basename(f.scope);
    commitPaths(other, 'binary base', [[path.join(dir, 'image.bin'), Buffer.from([0, 1, 2]), true]]);
    const revision = commitPaths(other, 'binary change', [[path.join(dir, 'image.bin'), Buffer.from([0, 9, 8, 7])]]);
    svn(f.wc, 'update');
    ui = await host(f.root, f.scope);
    await openHistory(ui, 'image.bin');
    await openRevision(ui, revision);
    await chooseRevisionPath(ui, 'image.bin');
    await eventually(async () => assert.match(await ui.notifications(), /二进制内容不可分析/));
    assert.equal(await ui.diffCount(), 0);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('修订变化查询失败时明确提示，不显示为空变化列表', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const dir = path.basename(f.scope);
    const revision = commitPaths(other, 'failing detail', [[path.join(dir, name), 'SOMETHING\n']]);
    const detail = 'svn: E170001: Authentication failed';
    const settings = await interceptSvn(f,
      `const fs=require('node:fs');const args=process.argv.slice(2);` +
      `if(args.includes('-v')){fs.appendFileSync('detail-attempts','x\\n');process.stderr.write(${JSON.stringify(detail)});process.exitCode=1;}` +
      `else{DELEGATE_LOG}`);
    ui = await host(f.root, f.scope, settings);
    await openHistory(ui, name);
    await picker(ui).fill(`r${revision}`);
    await ui.page.keyboard.press('Enter');
    await eventually(async () => assert.ok((await ui.notifications()).includes(detail)));
    assert.match(await ui.notifications(), /认证失败/);
    assert.equal((await fs.readFile(path.join(f.scope, 'detail-attempts'), 'utf8')).trim().split('\n').length, 1);
    assert.equal(await ui.diffCount(), 0);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});
