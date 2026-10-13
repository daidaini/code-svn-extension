const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, host, svn, eventually, cleanup } = require('./host.cjs');

test('删除与本地缺失的目录恢复完整子树，目录属性恢复且未跟踪文件保留', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    for (const name of ['已删除目录', '缺失目录']) {
      await fs.mkdir(path.join(f.scope, name));
      await fs.writeFile(path.join(f.scope, name, '恢复.txt'), 'RESTORE TREE\n');
      svn(f.scope, 'add', name);
    }
    svn(f.scope, 'commit', '-m', 'revert fixture');
    svn(f.scope, 'delete', '已删除目录');
    await fs.rm(path.join(f.scope, '缺失目录'), { recursive: true });
    svn(f.scope, 'propset', 'test-property', 'discard', '.');
    await fs.writeFile(path.join(f.scope, '未跟踪保留.txt'), 'KEEP\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：撤销本地变更', path.basename(f.scope));
    const dialog = ui.page.locator('.monaco-dialog-box');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /已删除目录/);
    assert.match(await dialog.innerText(), /缺失目录/);
    await confirm(ui);
    await eventually(async () => assert.match(await ui.notifications(), /撤销完成/));
    for (const name of ['已删除目录', '缺失目录']) {
      assert.equal(await fs.readFile(path.join(f.scope, name, '恢复.txt'), 'utf8'), 'RESTORE TREE\n');
    }
    assert.equal(await fs.readFile(path.join(f.scope, '未跟踪保留.txt'), 'utf8'), 'KEEP\n');
    assert.doesNotMatch(svn(f.scope, 'proplist', '--xml', '-v', '.'), /test-property/);
    await eventually(async () => assert.doesNotMatch(await ui.scmText(), /已删除|本地缺失|属性已修改/));
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('SVN 撤销失败时提示错误，保留实际仍有变更的提交选择与提交信息', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'KEEP AFTER FAILURE\n');
    const { execFileSync } = require('node:child_process');
    const svnExecutable = process.env.SVN_EXECUTABLE || (process.platform === 'win32'
      ? execFileSync('where.exe', ['svn.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0] : 'svn');
    const delegate = `const {execFileSync}=require('node:child_process');const path=require('node:path');` +
      `process.stdout.write(execFileSync(${JSON.stringify(svnExecutable)},[path.basename(process.argv[1]),...process.argv.slice(2)],{cwd:process.cwd(),encoding:'utf8',windowsHide:true}));`;
    for (const command of ['info', 'status']) await fs.writeFile(path.join(f.scope, command), delegate);
    await fs.writeFile(path.join(f.wc, 'revert'), 'process.stderr.write("svn: E155004: Working copy locked\\n");process.exitCode=1;');
    ui = await host(f.root, f.scope, { 'codeSvn.svnPath': process.execPath });
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('撤销失败保留选择');
    await ui.chooseChange('SVN：撤销本地变更', '修改 中文.txt');
    await confirm(ui);
    await eventually(async () => assert.match(await ui.notifications(), /撤销失败.*E155004/));
    assert.equal(await fs.readFile(path.join(f.scope, '修改 中文.txt'), 'utf8'), 'KEEP AFTER FAILURE\n');
    assert.match(await ui.scmText(), /待提交[\s\S]*修改 中文.txt/);
    assert.match(await ui.commitMessageText(), /撤销失败保留选择/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('撤销遇到未保存编辑时阻止操作，保留磁盘修改和编辑器内容', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const target = path.join(f.scope, '修改 中文.txt');
    await fs.writeFile(target, 'SAVED LOCAL\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.editFile(target, 'UNSAVED CONTENT');
    await ui.chooseChange('SVN：撤销本地变更', '修改 中文.txt');
    await eventually(async () => assert.match(await ui.notifications(), /未保存内容.*未执行撤销/));
    assert.equal(await fs.readFile(target, 'utf8'), 'SAVED LOCAL\n');
    assert.match(await ui.editorText(), /UNSAVED CONTENT/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

async function confirm(ui, action = '撤销这些修改') {
  const dialog = ui.page.locator('.monaco-dialog-box');
  await dialog.waitFor();
  await dialog.locator('.monaco-button').filter({ hasText: action === '取消' ? /^(取消|Cancel)$/ : action }).click();
  await dialog.waitFor({ state: 'hidden' });
}

test('公开撤销入口展示文件范围；取消保留修改，确认恢复内容并移出待提交', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const target = path.join(f.scope, '修改 中文.txt');
    await fs.writeFile(target, 'DISCARD SAVED\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('保留提交信息');
    await ui.chooseChange('SVN：撤销本地变更', '修改 中文.txt');
    const dialog = ui.page.locator('.monaco-dialog-box');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /修改 中文.txt/);
    assert.match(await dialog.innerText(), /丢弃/);
    await confirm(ui, '取消');
    assert.equal(await fs.readFile(target, 'utf8'), 'DISCARD SAVED\n');
    assert.match(await ui.scmText(), /待提交/);
    await ui.chooseChange('SVN：撤销本地变更', '修改 中文.txt');
    await confirm(ui);
    await eventually(async () => assert.match(await ui.notifications(), /撤销完成/));
    assert.equal(await fs.readFile(target, 'utf8'), 'initial\n');
    await eventually(async () => assert.doesNotMatch(await ui.scmText(), /修改 中文.txt|待提交/));
    assert.match(await ui.commitMessageText(), /保留提交信息/);
    assert.doesNotMatch(svn(f.scope, 'status', '--xml', '.'), /item="modified"/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('目录资源行确认包含子项，取消添加保留文件与未跟踪内容，不撤销范围外兄弟项', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const added = path.join(f.scope, '取消添加 @目录');
    await fs.mkdir(path.join(added, '子目录'), { recursive: true });
    await fs.writeFile(path.join(added, '子目录', '新文件.txt'), 'KEEP ADDED\n');
    svn(f.scope, 'add', '取消添加 @目录@');
    await fs.writeFile(path.join(added, '未跟踪.txt'), 'KEEP UNTRACKED\n');
    await fs.writeFile(path.join(f.wc, 'sibling', 'outside.txt'), 'KEEP OUTSIDE\n');
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'KEEP SIBLING\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '新文件.txt');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.chooseChange('SVN：撤销本地变更', '取消添加 @目录');
    const dialog = ui.page.locator('.monaco-dialog-box');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /子项[\s\S]*新文件.txt/);
    await confirm(ui);
    await eventually(async () => assert.match(await ui.notifications(), /撤销完成/));
    assert.equal(await fs.readFile(path.join(added, '子目录', '新文件.txt'), 'utf8'), 'KEEP ADDED\n');
    assert.equal(await fs.readFile(path.join(added, '未跟踪.txt'), 'utf8'), 'KEEP UNTRACKED\n');
    assert.equal(await fs.readFile(path.join(f.scope, '修改 中文.txt'), 'utf8'), 'KEEP SIBLING\n');
    assert.equal(await fs.readFile(path.join(f.wc, 'sibling', 'outside.txt'), 'utf8'), 'KEEP OUTSIDE\n');
    await eventually(async () => {
      const text = await ui.scmText();
      assert.match(text, /待提交\n1\n/);
      assert.doesNotMatch(text, /必需提交依赖/);
      assert.match(text, /未跟踪[\s\S]*取消添加 @目录/);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});
