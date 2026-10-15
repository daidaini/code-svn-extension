const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, host, svn, eventually, cleanup } = require('./host.cjs');

function revision(f) {
  return Number(/revision="(\d+)"/.exec(svn(f.root, 'info', '--xml', f.url))[1]);
}

async function commitEnvironment(f, script) {
  const { execFileSync } = require('node:child_process');
  const executable = process.env.SVN_EXECUTABLE || (process.platform === 'win32'
    ? execFileSync('where.exe', ['svn.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0] : 'svn');
  // Executable-boundary fixture: info/status still use real SVN; only the
  // commit response is controlled. No extension functions are called or mocked.
  const delegate = `const {execFileSync}=require('node:child_process');const path=require('node:path');` +
    `process.stdout.write(execFileSync(${JSON.stringify(executable)},[path.basename(process.argv[1]),...process.argv.slice(2)],{windowsHide:true}));`;
  // svnPath points at node, so the scope needs info/status delegates like the
  // other executable-boundary tests; only the commit response is controlled.
  for (const command of ['info', 'status']) await fs.writeFile(path.join(f.scope, command), delegate);
  await fs.writeFile(path.join(f.wc, 'commit'), script);
  return delegate;
}

// A committed tree with several affected children, scheduled for deletion.
async function deletedTree(f, name = '待删目录') {
  const tree = path.join(f.scope, name);
  await fs.mkdir(path.join(tree, '子目录'), { recursive: true });
  await fs.writeFile(path.join(tree, '甲.txt'), '甲\n');
  await fs.writeFile(path.join(tree, '乙.txt'), '乙\n');
  await fs.writeFile(path.join(tree, '子目录', '丙.txt'), '丙\n');
  svn(f.scope, 'add', `${name}@`);
  svn(f.scope, 'commit', `${name}@`, '-m', '待删基线');
  svn(f.scope, 'delete', `${name}@`);
  return tree;
}

test('选择目录会把目录属性和后代变更一起加入并提交', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    svn(f.scope, 'propset', 'reviewed', 'yes', '.');
    await fs.appendFile(path.join(f.scope, '修改 中文.txt'), '子文件本地修改\n');
    svn(f.scope, 'propset', 'owner', '子文件团队', '修改 中文.txt');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /中文 空格 @目录/));
    await ui.openChange('中文 空格 @目录');
    await eventually(async () => assert.match(await ui.editorText(), /新增属性 reviewed = yes/));
    await ui.chooseChange('SVN：加入待提交', '中文 空格 @目录');
    await eventually(async () => assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/));
    await eventually(async () => {
      const text = await ui.scmText();
      assert.match(text, /待提交/);
      assert.match(text, /中文 空格 @目录/);
      assert.match(text, /修改 中文\.txt/);
    });
    await ui.chooseChange('SVN：移出待提交', '中文 空格 @目录');
    await eventually(async () => assert.doesNotMatch(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/));
    await ui.chooseChange('SVN：加入待提交', '中文 空格 @目录');
    await ui.commitMessage('提交目录及其子项');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.match(await ui.notifications(), /2 项变更/);
    assert.match(svn(f.root, 'propget', 'reviewed', `${f.url}/中文 空格 @目录@`), /yes/);
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/修改 中文.txt@`), 'initial\n子文件本地修改\n');
    assert.match(svn(f.root, 'propget', 'owner', `${f.url}/中文 空格 @目录/修改 中文.txt@`), /子文件团队/);
    await eventually(async () => {
      assert.doesNotMatch(await ui.scmText(), /属性已修改/);
      assert.doesNotMatch(await ui.scmText(), /修改 中文\.txt/);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('目录选择遇到未跟踪后代时不留下部分提交选择', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'LOCAL\n');
    await fs.writeFile(path.join(f.scope, '未跟踪.txt'), 'UNTRACKED\n');
    svn(f.scope, 'propset', 'reviewed', 'yes', '.');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '中文 空格 @目录');
    await eventually(async () => assert.match(await ui.notifications(), /尚未跟踪.*先执行添加到版本控制/));
    assert.doesNotMatch(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('整体目录删除以一个操作呈现受影响子项，提交删除整个子树', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await deletedTree(f);
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const text = await ui.scmText();
      assert.match(text, /已删除（整个目录）/);
      assert.match(text, /已删除子项/);
      assert.match(text, /甲\.txt/);
      assert.match(text, /乙\.txt/);
      assert.match(text, /丙\.txt/);
    });
    // The main entry must not offer per-child splitting of the tree deletion.
    await ui.command('SVN：加入待提交', false);
    await eventually(async () => {
      const rows = (await ui.page.locator('.quick-input-list .monaco-list-row').allInnerTexts()).join('\n');
      assert.match(rows, /待删目录/);
      assert.doesNotMatch(rows, /甲\.txt|乙\.txt|丙\.txt|子目录/);
    });
    await ui.page.keyboard.press('Escape');
    await eventually(async () => assert.ok(await ui.page.locator('.quick-input-widget input').first().isHidden()));
    await ui.chooseChange('SVN：加入待提交', '待删目录');
    await eventually(async () => assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/));
    await ui.commitMessage('整体删除子树');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    const list = svn(f.root, 'list', '--xml', '-R', f.url);
    assert.doesNotMatch(list, /待删目录|甲\.txt|乙\.txt|丙\.txt/);
    assert.match(svn(f.root, 'log', '--xml', '-l', '1', f.url), /整体删除子树/);
    assert.doesNotMatch(svn(f.scope, 'status', '--xml', '.'), /待删目录/);
    await eventually(async () => {
      assert.doesNotMatch(await ui.scmText(), /待删目录|已删除子项/);
      assert.equal((await ui.commitMessageText()).trim(), '');
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('删除子项不能单独提交，资源行点击引导选择目录本身', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await deletedTree(f);
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /已删除子项/));
    const row = ui.page.locator('.scm-view .monaco-list-row').filter({ hasText: '甲.txt' }).first();
    await row.hover();
    await row.locator('.action-label[aria-label="SVN：加入待提交"]').click();
    await eventually(async () => assert.match(await ui.notifications(), /随整个目录删除.*不能单独提交/));
    assert.doesNotMatch(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/);
    assert.equal(revision(f), 2);
    assert.match(svn(f.root, 'list', '--xml', '-R', f.url), /待删目录/);
    await ui.commitMessage('不要拆分子项');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /没有待提交文件/));
    assert.equal(revision(f), 2);
    assert.match(await ui.commitMessageText(), /不要拆分子项/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('删除目录加入待提交后管理范围收缩时阻止提交，不产生修订', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await deletedTree(f);
    const sibling = path.join(f.wc, 'sibling');
    ui = await host(f.root, [sibling, f.scope]);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '待删目录');
    await eventually(async () => assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/));
    await ui.commitMessage('范围收缩时保留');
    await ui.folders([sibling]);
    await eventually(async () => assert.doesNotMatch(await ui.scmText(), /待删目录/));
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /管理范围已变化/));
    assert.equal(revision(f), 2);
    assert.match(await ui.commitMessageText(), /范围收缩时保留/);
    assert.match(svn(f.root, 'list', '--xml', '-R', f.url), /待删目录/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('整体目录删除提交失败保留选择与输入，无修订不算成功，恢复后手动重试', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await deletedTree(f);
    const delegate = await commitEnvironment(f, 'process.stderr.write("svn: E170001: Authentication failed\\n");process.exitCode=1;');
    ui = await host(f.root, f.scope, { 'codeSvn.svnPath': process.execPath });
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '待删目录');
    await ui.commitMessage('删除失败时保留');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /SVN 提交失败.*E170001/));
    assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/);
    assert.match(await ui.commitMessageText(), /删除失败时保留/);
    assert.equal(revision(f), 2);
    assert.match(svn(f.root, 'list', '--xml', '-R', f.url), /待删目录/);
    await fs.writeFile(path.join(f.wc, 'commit'), 'process.stdout.write("Nothing to commit.\\n");');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /未确认产生修订/));
    assert.doesNotMatch(await ui.notifications(), /(?:^|\n)SVN 提交成功：/);
    assert.equal(revision(f), 2);
    await fs.writeFile(path.join(f.wc, 'commit'), delegate);
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.doesNotMatch(svn(f.root, 'list', '--xml', '-R', f.url), /待删目录/);
    await eventually(async () => {
      assert.doesNotMatch(await ui.scmText(), /待删目录|(?:^|\n)待提交(?:\n|$)/);
      assert.equal((await ui.commitMessageText()).trim(), '');
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});
