const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, host, svn, eventually, cleanup } = require('./host.cjs');

function revision(f) {
  return Number(/revision="(\d+)"/.exec(svn(f.root, 'info', '--xml', f.url))[1]);
}

// A committed directory with children, ready to be moved or copied.
async function treeFixture(f, name = '待移动目录') {
  const tree = path.join(f.scope, name);
  await fs.mkdir(path.join(tree, '子目录'), { recursive: true });
  await fs.writeFile(path.join(tree, '甲.txt'), '甲\n');
  await fs.writeFile(path.join(tree, '子目录', '丙.txt'), '丙\n');
  svn(f.scope, 'add', `${name}@`);
  svn(f.scope, 'commit', `${name}@`, '-m', '目录基线');
  return tree;
}

test('移动文件以已移动关系呈现，源作为必需依赖一起提交并保留复制历史', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    svn(f.scope, 'mv', '修改 中文.txt', '已移动 中文.txt');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const text = await ui.scmText();
      assert.match(text, /已移动 中文\.txt/);
      assert.match(text, /已删除/);
      assert.doesNotMatch(text, /已添加/);
    });
    await ui.chooseChange('SVN：加入待提交', '已移动 中文.txt');
    await eventually(async () => assert.match(await ui.scmText(), /必需提交依赖/));
    await ui.commitMessage('移动文件');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    const list = svn(f.root, 'list', '--xml', '-R', f.url);
    assert.doesNotMatch(list, /修改 中文\.txt/);
    assert.match(list, /已移动 中文\.txt/);
    assert.match(svn(f.root, 'log', '--xml', '-v', '-l', '1', f.url),
      /copyfrom-path="\/中文 空格 @目录\/修改 中文\.txt"/);
    await eventually(async () => {
      assert.doesNotMatch(await ui.scmText(), /已移动 中文\.txt|已删除/);
      assert.equal((await ui.commitMessageText()).trim(), '');
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('移动目录呈现源目录与受影响子项，提交保留整个移动关系', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await treeFixture(f);
    svn(f.scope, 'mv', '待移动目录', '移动后目录');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const text = await ui.scmText();
      assert.match(text, /移动后目录/);
      assert.match(text, /已移动/);
      assert.match(text, /已删除子项/);
      assert.match(text, /甲\.txt/);
      assert.match(text, /丙\.txt/);
    });
    await ui.chooseChange('SVN：加入待提交', '移动后目录');
    await eventually(async () => assert.match(await ui.scmText(), /必需提交依赖/));
    await ui.commitMessage('移动目录');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    const list = svn(f.root, 'list', '--xml', '-R', f.url);
    assert.doesNotMatch(list, /待移动目录/);
    assert.match(list, /移动后目录\/甲\.txt/);
    assert.match(list, /移动后目录\/子目录\/丙\.txt/);
    assert.match(svn(f.root, 'log', '--xml', '-v', '-l', '1', f.url),
      /copyfrom-path="\/中文 空格 @目录\/待移动目录"/);
    await eventually(async () => assert.doesNotMatch(await ui.scmText(), /移动后目录|已删除子项/));
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('复制文件与目录以已复制呈现，复制子树递归提交但不夹带子项修改', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const tree = await treeFixture(f, '复制源目录');
    svn(f.scope, 'cp', `${path.basename(tree)}/甲.txt@`, '副本.txt');
    svn(f.scope, 'cp', `${path.basename(tree)}@`, '副本目录');
    await fs.appendFile(path.join(f.scope, '副本目录', '甲.txt'), '副本内修改\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const text = await ui.scmText();
      assert.match(text, /已复制/);
      assert.match(text, /副本\.txt/);
      assert.match(text, /副本目录/);
      assert.match(text, /甲\.txt/);
    });
    await ui.openChange('甲.txt');
    await eventually(async () => {
      const sides = await ui.diffSides();
      assert.match(sides.modified, /副本内修改/);
      assert.match(sides.original, /甲/);
      assert.doesNotMatch(sides.original, /副本内修改/);
    });
    await ui.chooseChange('SVN：加入待提交', '副本.txt');
    await ui.commitMessage('提交副本文件');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    // 仓库中出现副本且复制来源关系保留
    assert.match(svn(f.root, 'list', '--xml', `${f.url}/中文 空格 @目录/副本.txt@`), /副本\.txt/);
    assert.match(svn(f.root, 'log', '--xml', '-v', '-l', '1', f.url),
      /copyfrom-path="\/中文 空格 @目录\/复制源目录\/甲\.txt"/);
    await ui.chooseChange('SVN：加入待提交', '副本目录');
    await ui.commitMessage('提交副本目录');
    await ui.command('SVN：提交待提交文件');
    // 递归复制提交整个复制子树，但子项修改不夹带：仓库端保持基线内容
    await eventually(async () => {
      assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/副本目录/甲.txt@`), '甲\n');
    });
    assert.match(svn(f.scope, 'status', '--xml', '副本目录/甲.txt'), /item="modified"/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('资源管理器重命名不推断为移动，缺失与未跟踪按原状态呈现', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.rename(path.join(f.scope, '修改 中文.txt'), path.join(f.scope, '改名.txt'));
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const text = await ui.scmText();
      assert.match(text, /本地缺失/);
      assert.match(text, /改名\.txt/);
      assert.match(text, /未跟踪/);
      assert.doesNotMatch(text, /已移动/);
    });
    await ui.chooseChange('SVN：添加到版本控制', '改名.txt');
    await eventually(async () => assert.ok((await ui.notifications()).includes('改名.txt 已添加到 SVN')));
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /已添加/));
    assert.doesNotMatch(await ui.scmText(), /已移动/);
    assert.match(svn(f.scope, 'status', '--xml', '改名.txt'), /item="added"/);
    assert.doesNotMatch(svn(f.scope, 'status', '--xml', '改名.txt'), /copied="true"/);
    assert.match(svn(f.scope, 'status', '--xml', '修改 中文.txt'), /item="missing"/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('移动源超出管理范围时阻止选择并说明原因', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    svn(f.wc, 'mv', 'sibling/outside.txt', '中文 空格 @目录/移入.txt@');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /移入\.txt/));
    await ui.chooseChange('SVN：加入待提交', '移入.txt');
    await eventually(async () => assert.match(await ui.notifications(), /移动源.*不在当前管理范围/));
    assert.doesNotMatch(await ui.scmText(), /(?:^|\n)待提交(?:\n|$)/);
    assert.equal(revision(f), 1);
    assert.match(svn(f.root, 'list', '--xml', '-R', f.url), /sibling\/outside\.txt/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('移动提交不夹带未选无关变更', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '无关修改.txt'), 'initial\n');
    svn(f.scope, 'add', '无关修改.txt@');
    svn(f.scope, 'commit', '.', '-m', '两个版本文件基线');
    await fs.writeFile(path.join(f.scope, '无关修改.txt'), 'UNRELATED LOCAL\n');
    svn(f.scope, 'mv', '修改 中文.txt', '移动目标.txt');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await ui.chooseChange('SVN：加入待提交', '移动目标.txt');
    await ui.commitMessage('只提交移动');
    await ui.command('SVN：提交待提交文件');
    await eventually(async () => assert.match(await ui.notifications(), /提交成功.*修订/));
    assert.equal(svn(f.root, 'cat', `${f.url}/中文 空格 @目录/无关修改.txt@`), 'initial\n');
    assert.match(svn(f.scope, 'status', '--xml', '无关修改.txt'), /item="modified"/);
    assert.doesNotMatch(svn(f.root, 'list', '--xml', '-R', f.url), /修改 中文\.txt/);
    assert.match(svn(f.root, 'list', '--xml', '-R', f.url), /移动目标\.txt/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});
