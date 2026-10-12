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
  await fs.writeFile(path.join(f.scope, 'info'), delegate);
  await fs.writeFile(path.join(f.scope, 'status'), delegate);
  await fs.writeFile(path.join(f.wc, 'commit'), script);
  return delegate;
}

test('公开选择与提交命令只提交完整的选中文件，保留未选修改并清理输入', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '未选.txt'), 'initial\n');
    svn(f.scope, 'add', '未选.txt');
    svn(f.scope, 'commit', '.', '-m', '两个文件的基线');
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), '完整文件第一行\n完整文件第二行\n');
    await fs.writeFile(path.join(f.scope, '未选.txt'), 'UNSELECTED\n');
    await fs.writeFile(path.join(f.wc, 'sibling', 'outside.txt'), 'OUTSIDE\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /修改 中文\.txt/));
    assert.doesNotMatch(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/);
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await eventually(async () => assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/));
    await ui.commitMessage('任务04 中文提交信息\n第二行');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/修改 中文.txt@`), '完整文件第一行\n完整文件第二行\n');
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/未选.txt@`), 'initial\n');
    assert.equal(svn(f.root, 'cat', `${f.url}/sibling/outside.txt`), 'initial\n');
    assert.match(svn(f.wc, 'status', '--xml', '.'), /item="modified"/);
    assert.match(svn(f.root, 'log', '--xml', '-l', '1', f.url), /任务04 中文提交信息\r?\n第二行/);
    await eventually(async () => {
      assert.doesNotMatch(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)|修改 中文\.txt/);
      assert.equal((await ui.commitMessageText()).trim(), '');
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('未保存的选中文件可取消提交，确认保存后才提交完整编辑内容', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const target = path.join(f.scope, '修改 中文.txt');
    await fs.writeFile(target, 'SAVED\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('保留输入');
    await ui.editFile(target, 'UNSAVED FIRST\nUNSAVED SECOND\n');
    await ui.command('SVN：提交待提交文件');
    const dialog = ui.page.locator('.monaco-dialog-box');
    await eventually(async () => assert.match(await dialog.innerText(), /未保存/));
    await dialog.locator('.monaco-button').filter({ hasText: /^(取消|Cancel)$/ }).click();
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/修改 中文.txt@`), 'initial\n');
    assert.equal(await fs.readFile(target, 'utf8'), 'SAVED\n');
    assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/);
    assert.match(await ui.commitMessageText(), /保留输入/);
    await ui.command('SVN：提交待提交文件');
    await dialog.locator('.monaco-button').filter({ hasText: '保存并提交' }).click();
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/修改 中文.txt@`).replace(/\r\n/g, '\n'), 'UNSAVED FIRST\nUNSAVED SECOND\n');
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('空选择与移出待提交均不产生修订，新增和目录变更不能加入待提交', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'LOCAL\n');
    await fs.writeFile(path.join(f.scope, '新增.txt'), 'NEW\n');
    svn(f.scope, 'add', '新增.txt');
    svn(f.scope, 'propset', 'owner', 'team', '.');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.commitMessage('EMPTY');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /没有待提交文件/));
    await ui.chooseChange('SVN：加入待提交', '新增.txt');
    await eventually(async () => assert.match(await ui.notifications(), /仅支持普通版本控制文件/));
    await ui.chooseChange('SVN：加入待提交', '中文 空格 @目录');
    await eventually(async () => assert.match(await ui.notifications(), /尚不支持目录提交/));
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.chooseChange('SVN：移出待提交', '修改 中文.txt');
    await eventually(async () => assert.doesNotMatch(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/));
    assert.match(await ui.commitMessageText(), /EMPTY/);
    await ui.command('SVN：提交待提交文件');
    assert.equal(revision(f), 1);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('访问失败与零退出码无修订均保留选择和输入，恢复后由用户手动提交', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'RECOVERED\n');
    const delegate = await commitEnvironment(f, 'process.stderr.write("svn: E170001: Authentication failed\\n");process.exitCode=1;');
    ui = await host(f.root, f.scope, { 'codeSvn.svnPath': process.execPath });
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('失败时保留');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /E170001.*Authentication failed/));
    assert.match(await ui.notifications(), /工作区所在环境的终端/);
    assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/);
    assert.match(await ui.commitMessageText(), /失败时保留/);
    assert.equal(revision(f), 1);
    await fs.writeFile(path.join(f.wc, 'commit'), 'process.stdout.write("Nothing to commit.\\n");');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /未确认产生修订/));
    assert.doesNotMatch(await ui.notifications(), /(?:^|\n)SVN 提交成功：/);
    assert.equal(revision(f), 1);
    assert.match(await ui.commitMessageText(), /失败时保留/);
    await fs.writeFile(path.join(f.wc, 'commit'), delegate);
    await new Promise(resolve => setTimeout(resolve, 5500));
    assert.equal(revision(f), 1, '恢复访问条件后也不能自动重试');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/修改 中文.txt@`), 'RECOVERED\n');
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('此前选中的修改变为删除后阻止提交，保留选择与输入', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'LOCAL\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('不要错误提交删除');
    svn(f.scope, 'delete', '--force', '修改 中文.txt');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /当前状态不支持提交/));
    assert.equal(revision(f), 1);
    assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/);
    assert.match(await ui.commitMessageText(), /不要错误提交删除/);
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/修改 中文.txt@`), 'initial\n');
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('选中文件随后产生真实 SVN 冲突时阻止提交，保留选择和输入', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const peer = path.join(f.root, 'peer');
    svn(f.root, 'checkout', f.url, peer);
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'LOCAL CONFLICT\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('冲突时保留');
    const peerScope = path.join(peer, '中文 空格 @目录');
    await fs.writeFile(path.join(peerScope, '修改 中文.txt'), 'REMOTE CONFLICT\n');
    svn(peerScope, 'commit', '.', '-m', 'remote');
    svn(f.scope, 'update', '.', '--accept', 'postpone');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /存在冲突/));
    assert.equal(revision(f), 2);
    assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/);
    assert.match(await ui.commitMessageText(), /冲突时保留/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('同一工作副本长时间提交期间拒绝重复写操作，不强制超时中断', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  const release = path.join(f.root, 'release');
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'ONE COMMIT\n');
    const delegate = await commitEnvironment(f, '');
    const pending = path.join(f.root, 'pending');
    await fs.writeFile(path.join(f.wc, 'commit'), `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pending)},'pending');` +
      `const wait=()=>{if(!fs.existsSync(${JSON.stringify(release)})){setTimeout(wait,100);return;} ${delegate}};wait();`);
    ui = await host(f.root, f.scope, { 'codeSvn.svnPath': process.execPath });
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('长时间提交');
    await ui.command('SVN：提交待提交文件');
    await eventually(() => fs.access(pending));
    await new Promise(resolve => setTimeout(resolve, 21000));
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /正在执行写操作.*不会重复提交/));
    assert.equal(revision(f), 1);
    assert.match(await ui.commitMessageText(), /长时间提交/);
    await fs.writeFile(release, 'continue');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.equal(revision(f), 2);
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/修改 中文.txt@`), 'ONE COMMIT\n');
  } finally {
    await fs.writeFile(release, 'continue').catch(() => undefined);
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('选择后移除打开目录不会提交管理范围外的旧选择', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'OUT OF SCOPE\n');
    const sibling = path.join(f.wc, 'sibling');
    // Keep the first folder: VS Code restarts the extension host when it is
    // removed, and this ticket deliberately does not persist selection across it.
    ui = await host(f.root, [sibling, f.scope]);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('范围变化时保留');
    await ui.folders([sibling]);
    await eventually(async () => assert.doesNotMatch(await ui.scmText(), /修改 中文\.txt/));
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /管理范围已变化/));
    assert.equal(revision(f), 1);
    assert.match(await ui.commitMessageText(), /范围变化时保留/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('不同工作副本的提交选择与输入独立，明确选择副本后只提交该副本', { timeout: 120000 }, async () => {
  const a = await fixture();
  const b = await fixture();
  let ui;
  try {
    for (const [f, name] of [[a, '甲.txt'], [b, '乙.txt']]) {
      await fs.writeFile(path.join(f.scope, name), 'BASE\n');
      svn(f.scope, 'add', name);
      svn(f.scope, 'commit', '.', '-m', 'baseline');
      await fs.writeFile(path.join(f.scope, name), 'CURRENT\n');
    }
    ui = await host(a.root, [a.scope, b.scope], { 'scm.alwaysShowRepositories': true });
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '甲.txt');
    await ui.chooseChange('SVN：加入待提交', '乙.txt');
    await ui.commitMessage('甲提交', 0);
    await ui.commitMessage('乙保留', 1);
    await ui.chooseChange('SVN：提交待提交文件', a.wc);
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.equal(revision(a), 3);
    assert.equal(revision(b), 2);
    assert.equal(svn(b.root, 'cat', `${b.url}/中文 空格 @目录/乙.txt@`), 'BASE\n');
    assert.match(await ui.commitMessageText(1), /乙保留/);
    assert.equal((await ui.commitMessageText(0)).trim(), '');
    assert.match(await ui.scmText(), /乙\.txt/);
    assert.doesNotMatch(await ui.scmText(), /甲\.txt/);
    await ui.chooseChange('SVN：提交待提交文件', b.wc);
    await eventually(async () => assert.equal(revision(b), 3));
    assert.match(svn(b.root, 'log', '--xml', '-l', '1', b.url), /乙保留/);
  } finally {
    if (ui) await ui.close();
    await cleanup(a.root);
    await cleanup(b.root);
  }
});

test('实际产生修订但刷新失败时保留选择和输入，明确提示勿重复提交', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'COMMITTED\n');
    const marker = path.join(f.root, 'committed');
    const delegate = await commitEnvironment(f, '');
    await fs.writeFile(path.join(f.wc, 'commit'), delegate + `require('node:fs').writeFileSync(${JSON.stringify(marker)},'committed');`);
    await fs.writeFile(path.join(f.scope, 'status'), `if(require('node:fs').existsSync(${JSON.stringify(marker)})){process.stderr.write('status unavailable');process.exitCode=1;}else{${delegate}}`);
    ui = await host(f.root, f.scope, { 'codeSvn.svnPath': process.execPath });
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('刷新失败时保留');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /已产生修订.*刷新失败.*勿重复提交/));
    assert.equal(revision(f), 2);
    assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/);
    assert.match(await ui.commitMessageText(), /刷新失败时保留/);
    assert.doesNotMatch(await ui.notifications(), /(?:^|\n)SVN 提交成功：/);
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/修改 中文.txt@`), 'COMMITTED\n');
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('资源行选择按钮与 SCM 输入框快捷提交正确传递工作副本上下文', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'INLINE\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /修改 中文\.txt/));
    const row = ui.page.locator('.scm-view .monaco-list-row').filter({ hasText: '修改 中文.txt' }).first();
    await row.hover();
    await row.locator('.action-label[aria-label="SVN：加入待提交"]').click();
    await eventually(async () => assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/));
    await ui.commitMessage('快捷提交');
    await ui.page.keyboard.press('Control+Enter');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.equal(revision(f), 2);
    assert.match(svn(f.root, 'log', '--xml', '-l', '1', f.url), /快捷提交/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});
