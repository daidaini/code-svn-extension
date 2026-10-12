const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, host, svn, eventually, cleanup } = require('./host.cjs');

async function writeEnvironment(f) {
  const { execFileSync } = require('node:child_process');
  const executable = process.env.SVN_EXECUTABLE || (process.platform === 'win32'
    ? execFileSync('where.exe', ['svn.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0] : 'svn');
  const delegate = `const {execFileSync}=require('node:child_process');const path=require('node:path');` +
    `process.stdout.write(execFileSync(${JSON.stringify(executable)},[path.basename(process.argv[1]),...process.argv.slice(2)],{windowsHide:true}));`;
  for (const command of ['info', 'status']) await fs.writeFile(path.join(f.scope, command), delegate);
  for (const command of ['add', 'commit']) await fs.writeFile(path.join(f.wc, command), delegate);
  return delegate;
}

async function add(ui, name) {
  await ui.chooseChange('SVN：添加到版本控制', name);
  await eventually(async () => assert.ok((await ui.notifications()).includes(`${name} 已添加到 SVN`)));
}

test('共享依赖只展示一次，移出子项仍保留其他选择所需依赖；显式目录提交不夹带子文件', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const parent = path.join(f.scope, '共享父目录');
    await fs.mkdir(parent);
    await fs.writeFile(path.join(parent, '甲新增.txt'), 'A\n');
    await fs.writeFile(path.join(parent, '乙新增.txt'), 'B\n');
    svn(f.scope, 'add', '共享父目录');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '甲新增.txt');
    await ui.chooseChange('SVN：加入待提交', '乙新增.txt');
    await eventually(async () => assert.match(await ui.scmText(), /必需提交依赖\n1\n/));
    await ui.chooseChange('SVN：移出待提交', '甲新增.txt');
    await eventually(async () => assert.match(await ui.scmText(), /必需提交依赖\n1\n/));
    await ui.chooseChange('SVN：加入待提交', '共享父目录');
    await ui.chooseChange('SVN：移出待提交', '乙新增.txt');
    await eventually(async () => assert.doesNotMatch(await ui.scmText(), /必需提交依赖/));
    await ui.commitMessage('仅提交显式目录节点');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    const list = svn(f.root, 'list', '--xml', '-R', f.url);
    assert.match(list, /共享父目录/);
    assert.doesNotMatch(list, /甲新增.txt|乙新增.txt/);
    assert.match(svn(f.scope, 'status', '--xml', '.'), /甲新增.txt[\s\S]*item="added"/);
    assert.match(svn(f.scope, 'status', '--xml', '.'), /乙新增.txt[\s\S]*item="added"/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('选择后父目录移出管理范围阻止提交，重新打开依赖范围后可提交', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const parent = path.join(f.scope, '范围变化父目录');
    const child = path.join(parent, '子目录');
    await fs.mkdir(child, { recursive: true });
    await fs.writeFile(path.join(child, '已选择新增.txt'), 'IN SCOPE AGAIN\n');
    svn(f.scope, 'add', '范围变化父目录');
    const sibling = path.join(f.wc, 'sibling');
    ui = await host(f.root, [sibling, f.scope]);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '已选择新增.txt');
    await ui.commitMessage('依赖范围变化时保留');
    await eventually(async () => assert.match(await ui.scmText(), /必需提交依赖/));
    await ui.folders([sibling, child]);
    await eventually(async () => assert.match(await ui.scmText(), /必需提交依赖\n1\n/));
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /必需提交依赖.*超出管理范围/));
    assert.match(await ui.commitMessageText(), /依赖范围变化时保留/);
    assert.doesNotMatch(svn(f.root, 'list', '--xml', '-R', f.url), /范围变化父目录/);
    await ui.folders([sibling, f.scope]);
    await eventually(async () => assert.match(await ui.scmText(), /必需提交依赖\n2\n/));
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/范围变化父目录/子目录/已选择新增.txt@`), 'IN SCOPE AGAIN\n');
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('新增项提交失败保留选择、必需依赖和输入，手动重试后才清理', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.mkdir(path.join(f.scope, '失败父目录'));
    await fs.writeFile(path.join(f.scope, '失败父目录', '选定新增.txt'), 'RETRY NEW\n');
    svn(f.scope, 'add', '失败父目录');
    const delegate = await writeEnvironment(f);
    await fs.writeFile(path.join(f.wc, 'commit'), 'process.stderr.write("svn: E170001: Authentication failed\\n");process.exitCode=1;');
    ui = await host(f.root, f.scope, { 'codeSvn.svnPath': process.execPath });
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '选定新增.txt');
    await ui.commitMessage('新增失败重试');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /SVN 提交失败.*E170001/));
    assert.match(await ui.scmText(), /必需提交依赖/);
    assert.match(await ui.scmText(), /选定新增.txt/);
    assert.match(await ui.commitMessageText(), /新增失败重试/);
    await fs.writeFile(path.join(f.wc, 'commit'), delegate);
    await ui.command('SVN：刷新变更');
    assert.doesNotMatch(svn(f.root, 'list', '--xml', '-R', f.url), /失败父目录/);
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/失败父目录/选定新增.txt@`), 'RETRY NEW\n');
    await eventually(async () => {
      assert.doesNotMatch(await ui.scmText(), /必需提交依赖|选定新增.txt/);
      assert.equal((await ui.commitMessageText()).trim(), '');
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('添加与提交在同一工作副本互斥，忙碌时不添加未选文件', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  const addRelease = path.join(f.root, 'add-release');
  const commitRelease = path.join(f.root, 'commit-release');
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'ONLY MODIFIED\n');
    await fs.writeFile(path.join(f.scope, '正在添加.txt'), 'NEW\n');
    await fs.writeFile(path.join(f.scope, '忙碌时添加.txt'), 'DO NOT ADD\n');
    const delegate = await writeEnvironment(f);
    const pendingAdd = path.join(f.root, 'add-pending');
    const pendingCommit = path.join(f.root, 'commit-pending');
    const delayed = (pending, release) => `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pending)},'pending');` +
      `const wait=()=>{if(!fs.existsSync(${JSON.stringify(release)})){setTimeout(wait,100);return;} ${delegate}};wait();`;
    await fs.writeFile(path.join(f.wc, 'add'), delayed(pendingAdd, addRelease));
    await fs.writeFile(path.join(f.wc, 'commit'), delayed(pendingCommit, commitRelease));
    ui = await host(f.root, f.scope, { 'codeSvn.svnPath': process.execPath });
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('互斥提交');
    await ui.chooseChange('SVN：添加到版本控制', '正在添加.txt');
    await eventually(() => fs.access(pendingAdd));
    await ui.chooseChange('SVN：添加到版本控制', '忙碌时添加.txt');
    await eventually(async () => assert.match(await ui.notifications(), /添加失败.*正在执行写操作/));
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /正在执行写操作.*不会重复提交/));
    assert.match(svn(f.scope, 'status', '--xml', '忙碌时添加.txt'), /item="unversioned"/);
    await fs.writeFile(addRelease, 'continue');
    await eventually(async () => assert.ok((await ui.notifications()).includes('正在添加.txt 已添加到 SVN')));
    await ui.command('SVN：提交待提交文件');
    await eventually(() => fs.access(pendingCommit));
    await ui.chooseChange('SVN：添加到版本控制', '忙碌时添加.txt');
    await eventually(async () => assert.match(await ui.notifications(), /添加失败.*正在执行写操作/));
    assert.match(await ui.commitMessageText(), /互斥提交/);
    await fs.writeFile(commitRelease, 'continue');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/修改 中文.txt@`), 'ONLY MODIFIED\n');
    assert.doesNotMatch(svn(f.root, 'list', '--xml', '-R', f.url), /正在添加.txt|忙碌时添加.txt/);
    assert.match(svn(f.scope, 'status', '--xml', '忙碌时添加.txt'), /item="unversioned"/);
    assert.match(svn(f.scope, 'status', '--xml', '正在添加.txt'), /item="added"/);
  } finally {
    await fs.writeFile(addRelease, 'continue').catch(() => undefined);
    await fs.writeFile(commitRelease, 'continue').catch(() => undefined);
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('添加失败保留已有选择和输入，恢复后不自动重试；资源行可显式添加', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const target = path.join(f.scope, '添加失败.txt');
    await fs.writeFile(target, 'NEW AFTER RETRY\n');
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'KEEP SELECTION\n');
    const delegate = await writeEnvironment(f);
    await fs.writeFile(path.join(f.wc, 'add'), 'process.stderr.write("svn: E155004: Working copy locked\\n");process.exitCode=1;');
    ui = await host(f.root, f.scope, { 'codeSvn.svnPath': process.execPath });
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '修改 中文.txt');
    await ui.commitMessage('添加失败时保留');
    await ui.chooseChange('SVN：添加到版本控制', '添加失败.txt');
    await eventually(async () => assert.match(await ui.notifications(), /添加失败.*E155004/));
    assert.match(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/);
    assert.match(await ui.commitMessageText(), /添加失败时保留/);
    await fs.writeFile(path.join(f.wc, 'add'), delegate);
    await ui.command('SVN：刷新变更');
    assert.match(svn(f.scope, 'status', '--xml', '添加失败.txt'), /item="unversioned"/);
    const row = ui.page.locator('.scm-view .monaco-list-row').filter({ hasText: '添加失败.txt' }).first();
    await row.hover();
    await row.locator('.action-label[aria-label="SVN：添加到版本控制"]').click();
    await eventually(async () => assert.ok((await ui.notifications()).includes('添加失败.txt 已添加到 SVN')));
    assert.match(svn(f.scope, 'status', '--xml', '添加失败.txt'), /item="added"/);
    assert.match(await ui.commitMessageText(), /添加失败时保留/);
    assert.doesNotMatch(svn(f.root, 'list', '--xml', '-R', f.url), /添加失败.txt/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('新增父目录超出打开范围时阻止添加和选择，不偷偷扩大管理范围', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const opened = path.join(f.scope, '范围外父目录', '打开的子目录');
    await fs.mkdir(opened, { recursive: true });
    svn(f.scope, 'add', '--parents', '--depth', 'empty', '范围外父目录/打开的子目录@');
    await fs.writeFile(path.join(opened, '尚未添加.txt'), 'UNTRACKED\n');
    await fs.writeFile(path.join(opened, '已添加.txt'), 'ADDED\n');
    svn(opened, 'add', '已添加.txt');
    ui = await host(f.root, opened);
    await ui.command('SVN：刷新变更');
    await ui.commitMessage('不要扩大范围');
    await ui.chooseChange('SVN：添加到版本控制', '尚未添加.txt');
    await eventually(async () => assert.match(await ui.notifications(), /必需提交依赖.*超出管理范围/));
    assert.match(svn(opened, 'status', '--xml', '尚未添加.txt'), /item="unversioned"/);
    await ui.chooseChange('SVN：加入待提交', '已添加.txt');
    await eventually(async () => assert.match(await ui.notifications(), /必需提交依赖.*超出管理范围/));
    assert.doesNotMatch(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)|必需提交依赖/);
    assert.match(await ui.commitMessageText(), /不要扩大范围/);
    assert.doesNotMatch(svn(f.root, 'list', '--xml', '-R', f.url), /范围外父目录/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('未跟踪文件必须显式添加，添加后默认未选择，可审阅新增文本并精确提交', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '新文件 @中文.txt'), 'NEW FIRST\nNEW SECOND\n');
    await fs.writeFile(path.join(f.scope, '未选.txt'), 'UNSELECTED\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '新文件 @中文.txt');
    await eventually(async () => assert.match(await ui.notifications(), /先.*添加/));
    await add(ui, '新文件 @中文.txt');
    await eventually(async () => {
      assert.match(await ui.scmText(), /已添加/);
      assert.doesNotMatch(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/);
    });
    await ui.openChange('新文件 @中文.txt');
    await eventually(async () => {
      const sides = await ui.diffSides();
      assert.equal(sides.original.trim(), '');
      assert.match(sides.modified, /NEW FIRST\nNEW SECOND/);
    });
    await ui.chooseChange('SVN：加入待提交', '新文件 @中文.txt');
    await ui.commitMessage('任务05 新增文件');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/新文件 @中文.txt@`), 'NEW FIRST\nNEW SECOND\n');
    assert.match(svn(f.scope, 'status', '--xml', '.'), /item="unversioned"/);
    assert.equal((await ui.commitMessageText()).trim(), '');
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('多层新增父目录作为必需依赖展示，提交不递归夹带已添加的未选兄弟项', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const parent = path.join(f.scope, '新父目录');
    const nested = path.join(parent, '第二层 @目录');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, '选中文件.txt'), 'SELECTED NEW\n');
    await fs.writeFile(path.join(nested, '兄弟文件.txt'), 'UNSELECTED NEW\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    // Adding a directory is shallow, so it never enrolls unseen siblings.
    await add(ui, '新父目录');
    await eventually(async () => assert.match(await ui.scmText(), /第二层 @目录/));
    await add(ui, '第二层 @目录');
    await eventually(async () => assert.match(await ui.scmText(), /选中文件.txt/));
    await add(ui, '选中文件.txt');
    await add(ui, '兄弟文件.txt');
    await ui.chooseChange('SVN：加入待提交', '选中文件.txt');
    await eventually(async () => {
      const text = await ui.scmText();
      assert.match(text, /必需提交依赖/);
      const dependencies = text.slice(text.indexOf('必需提交依赖'));
      assert.match(dependencies, /新父目录/);
      assert.match(dependencies, /第二层 @目录/);
    });
    await ui.chooseChange('SVN：移出待提交', '选中文件.txt');
    await eventually(async () => assert.doesNotMatch(await ui.scmText(), /必需提交依赖/));
    await ui.chooseChange('SVN：加入待提交', '选中文件.txt');
    await ui.commitMessage('仅提交新增文件和父目录');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    const list = svn(f.root, 'list', '--xml', '-R', f.url);
    assert.match(list, /新父目录\/第二层 @目录\/选中文件.txt/);
    assert.doesNotMatch(list, /兄弟文件.txt/);
    const status = svn(f.scope, 'status', '--xml', '.');
    assert.match(status, /兄弟文件.txt[\s\S]*item="added"/);
    await eventually(async () => assert.doesNotMatch(await ui.scmText(), /必需提交依赖|(?:^|\n)待提交(?:\n|$)/));
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});
