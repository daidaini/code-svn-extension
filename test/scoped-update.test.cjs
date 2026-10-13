const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, host, svn, eventually, cleanup } = require('./host.cjs');

async function peer(f) {
  const wc = path.join(f.root, 'peer');
  svn(f.root, 'checkout', f.url, wc);
  return wc;
}

async function interceptedSvn(f, update) {
  const { execFileSync } = require('node:child_process');
  const executable = process.env.SVN_EXECUTABLE || (process.platform === 'win32'
    ? execFileSync('where.exe', ['svn.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0] : 'svn');
  const delegate = `const {execFileSync}=require('node:child_process');const path=require('node:path');` +
    `process.stdout.write(execFileSync(${JSON.stringify(executable)},[path.basename(process.argv[1]),...process.argv.slice(2)],{cwd:process.cwd(),encoding:'utf8',windowsHide:true}));`;
  for (const command of ['info', 'status']) await fs.writeFile(path.join(f.scope, command), delegate);
  await fs.writeFile(path.join(f.wc, 'update'), update.replace('DELEGATE', delegate));
  return { 'codeSvn.svnPath': process.execPath };
}

const updateCommand = 'SVN：更新管理范围';

test('更新产生文本和属性冲突后明确展示已选冲突并阻止提交，外部解决标记后刷新可继续提交', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const remote = path.join(other, path.basename(f.scope));
    const name = '修改 中文.txt';
    svn(remote, 'propset', 'test-property', 'BASE', name);
    svn(other, 'commit', '-m', 'property base');
    svn(f.wc, 'update');
    await fs.writeFile(path.join(f.scope, name), 'LOCAL EDIT\n');
    svn(f.scope, 'propset', 'test-property', 'LOCAL', name);
    await fs.writeFile(path.join(remote, name), 'REMOTE EDIT\n');
    svn(remote, 'propset', 'test-property', 'REMOTE', name);
    svn(other, 'commit', '-m', 'conflicting changes');
    const revision = svn(f.root, 'info', '--show-item', 'revision', f.url).trim();
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', name);
    await ui.commitMessage('解决冲突后手动提交');
    await ui.command(updateCommand);
    await eventually(async () => assert.match(await ui.notifications(), /更新完成.*1 项冲突/));
    assert.match(await ui.scmText(), /待提交（含冲突）/);
    assert.match(await fs.readFile(path.join(f.scope, name), 'utf8'), /<<<<<<<[\s\S]*LOCAL EDIT[\s\S]*REMOTE EDIT/);
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /存在冲突.*先解决/));
    assert.equal(svn(f.root, 'info', '--show-item', 'revision', f.url).trim(), revision);
    assert.match(await ui.commitMessageText(), /解决冲突后手动提交/);
    await fs.writeFile(path.join(f.scope, name), 'RESOLVED CONTENT\n');
    svn(f.scope, 'propset', 'test-property', 'RESOLVED', name);
    svn(f.scope, 'resolve', '--accept', 'working', `${name}@`);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.doesNotMatch(await ui.scmText(), /含冲突|^冲突$/m));
    assert.equal(svn(f.root, 'info', '--show-item', 'revision', f.url).trim(), revision);
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.equal(svn(f.root, 'cat', `${f.url}/${encodeURIComponent(path.basename(f.scope))}/${encodeURIComponent(name)}`), 'RESOLVED CONTENT\n'));
    assert.equal(svn(f.root, 'propget', 'test-property', `${f.url}/${encodeURIComponent(path.basename(f.scope))}/${encodeURIComponent(name)}`).trim(), 'RESOLVED');
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

for (const detail of [
  'svn: E170001: Authentication failed',
  'svn: E230001: Server SSL certificate verification failed',
  'svn: E170013: Unable to connect to a repository: Connection refused'
]) {
  test(`更新失败准确提示 ${detail}，不绕过检查、不重试，保留选择与输入并释放写锁`, { timeout: 120000 }, async () => {
    const f = await fixture();
    let ui;
    try {
      const settings = await interceptedSvn(f,
        `const fs=require('node:fs');fs.appendFileSync('update-attempts', JSON.stringify(process.argv.slice(2))+'\\n');` +
        `process.stderr.write(${JSON.stringify(detail)});process.exitCode=1;`);
      await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'KEEP LOCAL\n');
      ui = await host(f.root, f.scope, settings);
      await ui.command('SVN：刷新变更');
      await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
      await ui.commitMessage('更新失败保留输入');
      await ui.command(updateCommand);
      await eventually(async () => assert.ok((await ui.notifications()).includes(detail)));
      const attempts = (await fs.readFile(path.join(f.wc, 'update-attempts'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(attempts.length, 1);
      assert.ok(attempts[0].includes('--non-interactive'));
      assert.doesNotMatch(attempts[0].join(' '), /--trust-server-cert|--force|--accept (?:working|mine|theirs)/);
      assert.equal(await fs.readFile(path.join(f.scope, '修改 中文.txt'), 'utf8'), 'KEEP LOCAL\n');
      assert.match(await ui.scmText(), /待提交[\s\S]*修改 中文.txt/);
      assert.match(await ui.commitMessageText(), /更新失败保留输入/);
      await ui.command(updateCommand);
      await eventually(async () => assert.equal((await fs.readFile(path.join(f.wc, 'update-attempts'), 'utf8')).trim().split('\n').length, 2));
    } finally {
      if (ui) await ui.close();
      await cleanup(f.root);
    }
  });
}

test('更新部分应用后失败仍刷新冲突，保留提交信息且不产生修订', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const name = '修改 中文.txt';
    await fs.writeFile(path.join(other, path.basename(f.scope), name), 'REMOTE PARTIAL\n');
    svn(other, 'commit', '-m', 'partial update fixture');
    await fs.writeFile(path.join(f.scope, name), 'LOCAL PARTIAL\n');
    const revision = svn(f.root, 'info', '--show-item', 'revision', f.url).trim();
    const settings = await interceptedSvn(f, `DELEGATE;process.stderr.write('svn: E170013: Connection lost after applying changes');process.exitCode=1;`);
    ui = await host(f.root, f.scope, settings);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', name);
    await ui.commitMessage('部分更新后保留');
    await ui.command(updateCommand);
    await eventually(async () => assert.match(await ui.notifications(), /更新失败.*E170013/s));
    assert.match(await ui.scmText(), /待提交（含冲突）/);
    assert.match(await fs.readFile(path.join(f.scope, name), 'utf8'), /REMOTE PARTIAL/);
    assert.match(await ui.commitMessageText(), /部分更新后保留/);
    assert.equal(svn(f.root, 'info', '--show-item', 'revision', f.url).trim(), revision);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('更新后查询失败明确说明列表未能确认，恢复查询后展示实际冲突', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const name = '修改 中文.txt';
    await fs.writeFile(path.join(other, path.basename(f.scope), name), 'REMOTE REFRESH FAILURE\n');
    svn(other, 'commit', '-m', 'refresh failure fixture');
    await fs.writeFile(path.join(f.scope, name), 'LOCAL REFRESH FAILURE\n');
    const brokenStatus = `process.stderr.write('svn: E155004: Working copy locked');process.exitCode=1;`;
    const settings = await interceptedSvn(f,
      `DELEGATE;require('node:fs').writeFileSync(${JSON.stringify(path.join(f.scope, 'status'))},${JSON.stringify(brokenStatus)});`);
    ui = await host(f.root, f.scope, settings);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', name);
    await ui.commitMessage('查询恢复后审阅');
    await ui.command(updateCommand);
    await eventually(async () => assert.match(await ui.notifications(), /刷新未能确认完整状态/));
    assert.doesNotMatch(await ui.notifications(), /SVN 更新完成/);
    assert.match(await ui.commitMessageText(), /查询恢复后审阅/);
    await interceptedSvn(f, 'DELEGATE');
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /待提交（含冲突）/));
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('更新期间阻止重复更新、提交、添加和撤销，完成后释放写锁', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const settings = await interceptedSvn(f,
      `const fs=require('node:fs');fs.appendFileSync('update-started','started\\n');` +
      `const timer=setInterval(()=>{if(!fs.existsSync('update-release'))return;clearInterval(timer);DELEGATE},20);`);
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'KEEP DURING UPDATE\n');
    await fs.writeFile(path.join(f.scope, '未跟踪.txt'), 'KEEP UNTRACKED\n');
    ui = await host(f.root, f.scope, settings);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('更新期间不提交');
    await ui.command(updateCommand);
    await eventually(async () => assert.match(await fs.readFile(path.join(f.wc, 'update-started'), 'utf8'), /started/));
    await ui.command(updateCommand);
    await eventually(async () => assert.match(await ui.notifications(), /正在执行写操作/));
    await ui.command('Notifications: Clear All Notifications');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /不会重复提交/));
    await ui.command('Notifications: Clear All Notifications');
    await ui.chooseChange('SVN：添加到版本控制', '未跟踪.txt');
    await eventually(async () => assert.match(await ui.notifications(), /添加失败.*正在执行写操作/));
    await ui.command('Notifications: Clear All Notifications');
    await ui.chooseChange('SVN：撤销本地变更', '修改 中文.txt');
    await ui.command('SVN：查看查询日志');
    await eventually(async () => assert.match(await ui.editorText(), /撤销失败[\s\S]*正在执行写操作/));
    assert.equal((await fs.readFile(path.join(f.wc, 'update-started'), 'utf8')).trim(), 'started');
    assert.equal(await fs.readFile(path.join(f.scope, '修改 中文.txt'), 'utf8'), 'KEEP DURING UPDATE\n');
    assert.equal(svn(f.root, 'info', '--show-item', 'revision', f.url).trim(), '1');
    await fs.writeFile(path.join(f.wc, 'update-release'), 'release');
    await eventually(async () => assert.match(await ui.notifications(), /SVN 更新完成/));
    await ui.command(updateCommand);
    await eventually(async () => assert.equal((await fs.readFile(path.join(f.wc, 'update-started'), 'utf8')).trim().split('\n').length, 2));
  } finally {
    // Also release an intercepted child on assertion failure before host cleanup.
    await fs.writeFile(path.join(f.wc, 'update-release'), 'release');
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('更新遇到未保存内容时停止，不改变磁盘或编辑器内容', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const target = path.join(f.scope, '修改 中文.txt');
    await fs.writeFile(path.join(other, path.basename(f.scope), '修改 中文.txt'), 'REMOTE UNSAVED\n');
    svn(other, 'commit', '-m', 'unsaved fixture');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.editFile(target, 'UNSAVED EDITOR');
    await ui.command(updateCommand);
    await eventually(async () => assert.match(await ui.notifications(), /未保存内容.*未执行更新/));
    assert.equal(await fs.readFile(target, 'utf8'), 'initial\n');
    assert.match(await ui.editorText(), /UNSAVED EDITOR/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('更新呈现树冲突且不能把冲突路径加入待提交', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    svn(path.join(other, path.basename(f.scope)), 'delete', '修改 中文.txt');
    svn(other, 'commit', '-m', 'incoming delete');
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'LOCAL KEEP\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.command(updateCommand);
    await eventually(async () => assert.match(await ui.notifications(), /1 项冲突/));
    assert.match(await ui.scmText(), /^冲突$/m);
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await eventually(async () => assert.match(await ui.notifications(), /存在冲突.*先解决/));
    assert.equal(await fs.readFile(path.join(f.scope, '修改 中文.txt'), 'utf8'), 'LOCAL KEEP\n');
    assert.doesNotMatch(await ui.scmText(), /^待提交(?:（含冲突）)?$/m);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('更新将选定变更合并成干净状态后清理陈旧选择，保留提交信息', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const name = '修改 中文.txt';
    await fs.writeFile(path.join(other, path.basename(f.scope), name), 'IDENTICAL CHANGE\n');
    svn(other, 'commit', '-m', 'already applied change');
    await fs.writeFile(path.join(f.scope, name), 'IDENTICAL CHANGE\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', name);
    await ui.commitMessage('保留信息待下一次提交');
    await ui.command(updateCommand);
    await eventually(async () => assert.match(await ui.notifications(), /SVN 更新完成/));
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /没有待提交文件/));
    assert.doesNotMatch(await ui.scmText(), /^待提交$/m);
    assert.match(await ui.commitMessageText(), /保留信息待下一次提交/);
    assert.equal(svn(f.root, 'info', '--show-item', 'revision', f.url).trim(), '2');
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('多个工作副本更新时明确选择一个，取消不更新，其他副本保持原修订', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const remote = path.join(f.root, 'remote');
    svn(f.root, 'checkout', f.url, remote);
    await fs.writeFile(path.join(remote, path.basename(f.scope), '修改 中文.txt'), 'CHOSEN COPY ONLY\n');
    svn(remote, 'commit', '-m', 'choose working copy');
    const otherScope = path.join(other, path.basename(f.scope));
    ui = await host(f.root, [f.scope, otherScope]);
    await ui.command('SVN：刷新变更');
    await ui.command(updateCommand, false);
    await ui.page.locator('.quick-input-list .monaco-list-row').filter({ hasText: f.wc }).waitFor();
    await ui.page.keyboard.press('Escape');
    assert.equal(await fs.readFile(path.join(f.scope, '修改 中文.txt'), 'utf8'), 'initial\n');
    assert.equal(await fs.readFile(path.join(otherScope, '修改 中文.txt'), 'utf8'), 'initial\n');
    await ui.chooseChange(updateCommand, f.wc);
    await eventually(async () => assert.match(await ui.notifications(), /SVN 更新完成/));
    assert.equal(await fs.readFile(path.join(f.scope, '修改 中文.txt'), 'utf8'), 'CHOSEN COPY ONLY\n');
    assert.equal(await fs.readFile(path.join(otherScope, '修改 中文.txt'), 'utf8'), 'initial\n');
    assert.equal(svn(otherScope, 'cat', '-r', 'BASE', '修改 中文.txt'), 'initial\n');
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('更新同一工作副本的打开目录并集，不更新未打开区域，并忽略 externals', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const other = await peer(f);
    const remoteScope = path.join(other, path.basename(f.scope));
    await fs.mkdir(path.join(remoteScope, '子目录'));
    await fs.writeFile(path.join(remoteScope, '子目录', '新文件.txt'), 'NEW REMOTE\n');
    svn(remoteScope, 'add', '子目录');
    await fs.mkdir(path.join(other, 'second'));
    await fs.writeFile(path.join(other, 'second', 'second.txt'), 'SECOND INITIAL\n');
    svn(other, 'add', 'second');
    svn(other, 'commit', '-m', 'prepare scopes');
    svn(other, 'update');
    svn(f.wc, 'update');
    svn(f.root, 'checkout', `${f.url}/sibling`, path.join(f.scope, 'nested'));
    const outside = path.join(f.wc, 'sibling', 'outside.txt');
    await fs.writeFile(outside, 'UNOPENED LOCAL\n');
    await fs.writeFile(path.join(remoteScope, '修改 中文.txt'), 'REMOTE UPDATE\n');
    await fs.writeFile(path.join(remoteScope, '子目录', '新文件.txt'), 'NESTED REMOTE\n');
    await fs.writeFile(path.join(other, 'second', 'second.txt'), 'SECOND REMOTE\n');
    await fs.writeFile(path.join(other, 'sibling', 'outside.txt'), 'UNOPENED REMOTE\n');
    await fs.writeFile(path.join(remoteScope, '远端新增.txt'), 'ADDED REMOTE\n');
    svn(remoteScope, 'add', '远端新增.txt');
    svn(remoteScope, 'propset', 'svn:externals', '^/sibling external', '.');
    svn(other, 'commit', '-m', 'remote changes');
    ui = await host(f.root, [f.scope, path.join(f.scope, '子目录'), path.join(f.wc, 'second')]);
    await ui.command('SVN：刷新变更');
    await ui.command(updateCommand);
    await eventually(async () => assert.match(await ui.notifications(), /SVN 更新完成/));
    assert.equal(await fs.readFile(path.join(f.scope, '修改 中文.txt'), 'utf8'), 'REMOTE UPDATE\n');
    assert.equal(await fs.readFile(path.join(f.scope, '子目录', '新文件.txt'), 'utf8'), 'NESTED REMOTE\n');
    assert.equal(await fs.readFile(path.join(f.wc, 'second', 'second.txt'), 'utf8'), 'SECOND REMOTE\n');
    assert.equal(await fs.readFile(path.join(f.scope, '远端新增.txt'), 'utf8'), 'ADDED REMOTE\n');
    assert.equal(await fs.readFile(outside, 'utf8'), 'UNOPENED LOCAL\n');
    assert.equal(svn(path.dirname(outside), 'cat', '-r', 'BASE', 'outside.txt'), 'initial\n');
    await assert.rejects(fs.stat(path.join(f.scope, 'external')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.scope, 'nested', 'outside.txt'), 'utf8'), 'initial\n');
    assert.doesNotMatch(await ui.scmText(), /冲突|outside.txt/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});
