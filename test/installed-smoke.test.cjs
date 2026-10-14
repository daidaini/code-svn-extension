const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, host, svn, eventually, cleanup } = require('./host.cjs');

// Smoke test for the installed VSIX (opt-in). Run after `code --install-extension <vsix>`
// into an isolated extensions directory and set SVN_TEST_INSTALLED_EXTENSIONS_DIR to it.
const installed = process.env.SVN_TEST_INSTALLED_EXTENSIONS_DIR;

function revision(f) {
  return Number(/revision="(\d+)"/.exec(svn(f.root, 'info', '--xml', f.url))[1]);
}

test('已安装 VSIX 在当前环境中激活：显示变更、选择文件并提交', { skip: !installed, timeout: 180000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '安装 验证.txt'), 'before\n');
    svn(f.scope, 'add', '安装 验证.txt');
    svn(f.scope, 'commit', '.', '-m', '安装验证基线');
    await fs.writeFile(path.join(f.scope, '安装 验证.txt'), 'after install\n');
    const baseline = revision(f);

    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /安装 验证\.txt/), 60000);
    await ui.chooseChange('SVN：加入待提交', '安装 验证.txt');
    await ui.commitMessage('安装包冒烟提交');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.equal(revision(f), baseline + 1);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});
