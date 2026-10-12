const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, host, svn, eventually, cleanup } = require('./host.cjs');

test('不同工作副本在混合工作区独立展示，不接管普通目录', { timeout: 90000 }, async () => {
  const a = await fixture();
  let ui;
  try {
    const second = path.join(a.root, '另一工作副本');
    svn(a.root, 'checkout', a.url, second);
    const secondScope = path.join(second, '中文 空格 @目录');
    await fs.writeFile(path.join(a.scope, '副本甲.txt'), 'a\n');
    await fs.writeFile(path.join(secondScope, '副本乙.txt'), 'b\n');
    const plain = path.join(a.root, 'plain');
    await fs.mkdir(plain);
    await fs.writeFile(path.join(plain, '不应管理.txt'), 'plain\n');
    ui = await host(a.root, [plain, a.scope, secondScope], { 'scm.alwaysShowRepositories': true });
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /副本甲\.txt/);
      assert.match(list, /副本乙\.txt/);
      assert.doesNotMatch(list, /不应管理\.txt/);
      const repositories = await ui.page.locator('.scm-view .scm-provider').count();
      assert.equal(repositories, 2, list);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(a.root);
  }
});

test('首次状态查询失败仍将已识别的同一工作副本归为一个管理项', { timeout: 90000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const sibling = path.join(f.wc, 'sibling');
    await fs.appendFile(path.join(sibling, 'outside.txt'), 'local\n');
    const infoScope = svn(f.scope, 'info', '--xml', '.');
    const infoSibling = svn(sibling, 'info', '--xml', '.');
    const statusSibling = svn(sibling, 'status', '--xml', '--verbose', '--ignore-externals', '.');
    await fs.writeFile(path.join(f.scope, 'info'), `process.stdout.write(${JSON.stringify(infoScope)});`);
    await fs.writeFile(path.join(f.scope, 'status'), 'process.stderr.write("svn: warning: W155007: status unavailable\\n");');
    await fs.writeFile(path.join(sibling, 'info'), `process.stdout.write(${JSON.stringify(infoSibling)});`);
    await fs.writeFile(path.join(sibling, 'status'), `process.stdout.write(${JSON.stringify(statusSibling)});`);
    ui = await host(f.root, [f.scope, sibling], {
      'scm.alwaysShowRepositories': true, 'codeSvn.svnPath': process.execPath
    });
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /SVN：查询失败/);
      assert.equal(await ui.page.locator('.scm-view .scm-provider').count(), 1, list);
    }, 5000);
    await ui.settings({ 'codeSvn.svnPath': 'svn' });
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /outside\.txt/);
      assert.doesNotMatch(list, /SVN：查询失败/);
      assert.equal(await ui.page.locator('.scm-view .scm-provider').count(), 1, list);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('同一工作副本部分目录查询失败时，移除目录仍收缩旧列表范围', { timeout: 90000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const sibling = path.join(f.wc, 'sibling');
    await fs.writeFile(path.join(f.scope, '保留范围.txt'), 'scope\n');
    await fs.appendFile(path.join(sibling, 'outside.txt'), 'sibling\n');
    ui = await host(f.root, [f.scope, sibling], { 'scm.alwaysShowRepositories': true });
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /保留范围\.txt/); assert.match(list, /outside\.txt/);
      assert.equal(await ui.page.locator('.scm-view .scm-provider').count(), 1);
    });
    await fs.mkdir(path.join(f.scope, '.vscode'));
    await fs.writeFile(path.join(f.scope, '.vscode', 'settings.json'), JSON.stringify({
      'codeSvn.svnPath': path.join(f.root, 'missing-svn.exe')
    }));
    await eventually(async () => assert.match(await ui.scmText(), /SVN：查询失败/));
    await ui.folders([f.scope]);
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /SVN：查询失败/); assert.match(list, /保留范围\.txt/);
      assert.doesNotMatch(list, /outside\.txt/);
      assert.equal(await ui.page.locator('.scm-view .scm-provider').count(), 1);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('一个工作副本查询失败不影响另一个刷新，移除工作副本后清除其列表和错误', { timeout: 90000 }, async () => {
  const a = await fixture();
  const b = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(a.scope, '甲原有.txt'), 'a\n');
    await fs.writeFile(path.join(b.scope, '乙原有.txt'), 'b\n');
    ui = await host(a.root, [a.scope, b.scope], { 'scm.alwaysShowRepositories': true });
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /甲原有\.txt/); assert.match(list, /乙原有\.txt/);
    });
    await fs.mkdir(path.join(b.scope, '.vscode'));
    await fs.writeFile(path.join(b.scope, '.vscode', 'settings.json'), JSON.stringify({
      'codeSvn.svnPath': path.join(b.root, 'missing-svn.exe')
    }));
    await eventually(async () => assert.match(await ui.scmText(), /SVN：查询失败/));
    await fs.writeFile(path.join(a.scope, '甲后续.txt'), 'new a\n');
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /甲后续\.txt/); assert.match(list, /乙原有\.txt/);
      assert.match(list, /SVN：2 项变更/); assert.match(list, /SVN：查询失败/);
    });
    await ui.folders([a.scope]);
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /甲原有\.txt/); assert.match(list, /甲后续\.txt/);
      assert.doesNotMatch(list, /乙原有\.txt|SVN：查询失败/);
      assert.equal(await ui.page.locator('.scm-view .scm-provider').count(), 1);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(a.root); await cleanup(b.root);
  }
});

test('同一工作副本合并重叠及不相交目录，增删打开目录自动更新管理范围', { timeout: 90000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    svn(f.scope, 'mkdir', 'child');
    svn(f.wc, 'mkdir', 'closed');
    await fs.writeFile(path.join(f.wc, 'closed', '不应展示.txt'), 'initial\n');
    svn(f.wc, 'add', 'closed/不应展示.txt');
    svn(f.wc, 'commit', '.', '-m', 'scope fixture');
    const child = path.join(f.scope, 'child');
    const sibling = path.join(f.wc, 'sibling');
    await fs.writeFile(path.join(child, '去重.txt'), 'local\n');
    await fs.appendFile(path.join(sibling, 'outside.txt'), 'local\n');
    await fs.appendFile(path.join(f.wc, 'closed', '不应展示.txt'), 'local\n');
    ui = await host(f.root, [f.scope, child], { 'scm.alwaysShowRepositories': true });
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const list = await ui.scmText();
      assert.equal((list.match(/去重\.txt/g) || []).length, 1, list);
      assert.doesNotMatch(list, /outside\.txt|不应展示\.txt/);
      assert.equal(await ui.page.locator('.scm-view .scm-provider').count(), 1);
    });
    await ui.folders([f.scope, sibling]);
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /去重\.txt/);
      assert.match(list, /outside\.txt/);
      assert.doesNotMatch(list, /不应展示\.txt/);
      assert.equal(await ui.page.locator('.scm-view .scm-provider').count(), 1);
    });
    await ui.folders([sibling]);
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /outside\.txt/);
      assert.doesNotMatch(list, /去重\.txt|不应展示\.txt/);
    });
    await ui.folders([]);
    await eventually(async () => {
      assert.doesNotMatch(await ui.scmText(), /outside\.txt|SVN/);
      assert.equal(await ui.page.locator('.scm-view .scm-provider').count(), 0);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});
