const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, host, svn, eventually, cleanup } = require('./host.cjs');

test('公开刷新命令在真实 SCM 列表显示中文子目录变更，排除未打开的兄弟目录', { timeout: 90000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.appendFile(path.join(f.scope, '修改 中文.txt'), 'changed\n');
    await fs.appendFile(path.join(f.wc, 'sibling', 'outside.txt'), 'outside\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /已修改/);
      assert.match(list, /修改 中文\.txt/);
      assert.doesNotMatch(list, /outside\.txt/);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('完整工作副本自动刷新新增、删除、目录和文件属性状态，清理后自动移除变更', { timeout: 90000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    ui = await host(f.root, f.wc);
    await ui.command('SVN：刷新变更');
    await fs.writeFile(path.join(f.scope, '新增.txt'), 'new\n');
    svn(f.scope, 'add', '新增.txt');
    svn(f.scope, 'propset', 'example', 'value', '.');
    svn(f.scope, 'propset', 'example', 'value', '修改 中文.txt');
    svn(path.join(f.wc, 'sibling'), 'delete', 'outside.txt');
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /已添加/);
      assert.match(list, /新增\.txt/);
      assert.match(list, /已删除/);
      assert.match(list, /outside\.txt/);
      assert.match(list, /属性已修改/);
      assert.match(list, /修改 中文\.txt/);
      assert.match(list, /中文 空格 @目录/);
    });
    svn(f.wc, 'revert', '.', '--depth', 'infinity');
    await fs.rm(path.join(f.scope, '新增.txt'));
    await eventually(async () => {
      const list = await ui.scmText();
      assert.doesNotMatch(list, /新增\.txt|outside\.txt|修改 中文\.txt|属性已修改/);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('SVN 路径失效显示查询失败并保留旧列表，配置可执行路径后恢复', { timeout: 90000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.appendFile(path.join(f.scope, '修改 中文.txt'), 'changed\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /修改 中文\.txt/));
    await ui.settings({ 'codeSvn.svnPath': path.join(f.root, 'missing-svn.exe') });
    await eventually(async () => {
      assert.match(await ui.page.locator('.statusbar').innerText(), /SVN：查询失败（列表未更新）/);
      assert.match(await ui.page.locator('.notifications-toasts').innerText(), /配置 SVN 路径/);
      assert.match(await ui.scmText(), /修改 中文\.txt/);
    });
    const { execFileSync } = require('node:child_process');
    const executable = process.env.SVN_EXECUTABLE || (process.platform === 'win32'
      ? execFileSync('where.exe', ['svn.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0] : 'svn');
    await ui.settings({ 'codeSvn.svnPath': executable });
    await eventually(async () => assert.match(await ui.page.locator('.statusbar').innerText(), /SVN：1 项变更/));
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('非 SVN 目录不显示 SVN 管理项', { timeout: 90000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const folder = path.join(f.root, 'plain');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'plain.txt'), 'plain\n');
    ui = await host(f.root, folder);
    await ui.command('SVN：刷新变更');
    assert.doesNotMatch(await ui.scmText(), /SVN|plain\.txt/);
    assert.doesNotMatch(await ui.page.locator('.statusbar').innerText(), /SVN：查询失败/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('SVN 状态命令退出码为零但带查询警告时，明确失败并保留旧列表', { timeout: 90000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.appendFile(path.join(f.scope, '修改 中文.txt'), 'changed\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /修改 中文\.txt/));
    // CLI environment fixture models metadata disappearing between info and
    // status. It preserves the real info response, then emits SVN's zero-exit
    // W155007 response. No extension functions or collaborators are mocked.
    const info = svn(f.scope, 'info', '--xml', '.');
    await fs.writeFile(path.join(f.scope, 'info'), `process.stdout.write(${JSON.stringify(info)});`);
    await fs.writeFile(path.join(f.scope, 'status'),
      'process.stderr.write("svn: warning: W155007: not a working copy\\n");' +
      'process.stdout.write("<?xml version=\\"1.0\\"?><status><target path=\\".\\"></target></status>");');
    // Node runs the cwd's info/status scripts using the unchanged public CLI
    // arguments, so this fixture also works without a shell or .cmd shim.
    await ui.settings({ 'codeSvn.svnPath': process.execPath });
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      assert.match(await ui.page.locator('.statusbar').innerText(), /SVN：查询失败（列表未更新）/);
      assert.match(await ui.scmText(), /修改 中文\.txt/);
    }, 5000);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('SCM 显示属性、未跟踪和冲突，排除目录 externals、文件 externals 与嵌套工作副本', { timeout: 90000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    svn(f.scope, 'propset', 'svn:externals', `${f.url}/sibling external-dir\n${f.url}/sibling/outside.txt external-file.txt`, '.');
    svn(f.scope, 'commit', '.', '-m', 'external fixture');
    svn(f.scope, 'update', '.');
    svn(f.scope, 'checkout', `${f.url}/sibling`, 'nested');
    await fs.appendFile(path.join(f.scope, 'external-dir', 'outside.txt'), 'external change\n');
    await fs.appendFile(path.join(f.scope, 'external-file.txt'), 'external change\n');
    await fs.appendFile(path.join(f.scope, 'nested', 'outside.txt'), 'nested change\n');
    const peer = path.join(f.root, 'peer');
    svn(f.root, 'checkout', f.url, peer, '--ignore-externals');
    const peerScope = path.join(peer, '中文 空格 @目录');
    await fs.writeFile(path.join(peerScope, '修改 中文.txt'), 'remote replacement\n');
    svn(peerScope, 'commit', '.', '-m', 'remote edit');
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'local replacement\n');
    svn(f.scope, 'update', '.', '--ignore-externals', '--accept', 'postpone');
    svn(f.scope, 'propset', 'example', 'directory property', '.');
    await fs.writeFile(path.join(f.scope, '未跟踪.txt'), 'local\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /属性已修改/);
      assert.match(list, /未跟踪/);
      assert.match(list, /未跟踪\.txt/);
      assert.match(list, /冲突/);
      assert.match(list, /修改 中文\.txt/);
      assert.doesNotMatch(list, /external-dir|external-file|nested|outside\.txt/);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});
