const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, host, svn, eventually, cleanup } = require('./host.cjs');

test('点击变更列表中的中文文本文件，差异编辑器呈现修改前后内容，不夹带未打开目录', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'initial\n第二行 ORIGINAL\n第三行\n');
    svn(f.scope, 'commit', '.', '-m', '差异基线');
    await fs.writeFile(path.join(f.scope, '修改 中文.txt'), 'initial\n第二行 CHANGED\n第三行\n新增行 ADDED\n');
    await fs.appendFile(path.join(f.wc, 'sibling', 'outside.txt'), 'OUTSIDE-CONTENT\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /修改 中文\.txt/);
    });
    await ui.openChange('修改 中文.txt');
    await eventually(async () => {
      const sides = await ui.diffSides();
      assert.match(sides.original, /第二行 ORIGINAL/);
      assert.match(sides.modified, /第二行 CHANGED/);
      assert.match(sides.modified, /新增行 ADDED/);
    });
    assert.equal(await ui.diffCount(), 1);
    assert.match(await ui.editorTabs(), /修改 中文\.txt/);
    const combined = `${(await ui.diffSides()).original}\n${(await ui.diffSides()).modified}`;
    assert.doesNotMatch(combined, /OUTSIDE-CONTENT|outside\.txt/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('文件和目录的 SVN 属性变化可以在编辑器中查看', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    svn(f.scope, 'propset', 'reviewed', 'yes', '.');
    svn(f.scope, 'propset', 'owner', 'team', '修改 中文.txt');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => {
      const list = await ui.scmText();
      assert.match(list, /中文 空格 @目录/);
      assert.match(list, /修改 中文\.txt/);
    });
    await ui.openChange('中文 空格 @目录');
    await eventually(async () => {
      const text = await ui.editorText();
      assert.match(text, /SVN 属性差异/);
      assert.match(text, /新增属性 reviewed = yes/);
    });
    assert.equal(await ui.diffCount(), 0, '目录没有可比较的文本内容，不应打开差异编辑器');
    await ui.openChange('修改 中文.txt');
    await eventually(async () => {
      const text = await ui.editorText();
      assert.match(text, /SVN 属性差异/);
      assert.match(text, /新增属性 owner = team/);
    });
    assert.equal(await ui.diffCount(), 0);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('新增文本文件在差异编辑器中按实际状态呈现为全部新增', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '新增.txt'), '第一行 NEW\n第二行 NEW\n');
    svn(f.scope, 'add', '新增.txt');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /新增\.txt/));
    await ui.openChange('新增.txt');
    await eventually(async () => {
      const sides = await ui.diffSides();
      assert.match(sides.modified, /第一行 NEW/);
      assert.match(sides.modified, /第二行 NEW/);
      assert.doesNotMatch(sides.original, /NEW/);
    });
    assert.equal(await ui.diffCount(), 1);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('删除文本文件在差异编辑器中按实际状态呈现为全部删除', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const removed = path.join(f.scope, '待删.txt');
    await fs.writeFile(removed, '第一行 REMOVED\n第二行 REMOVED\n');
    svn(f.scope, 'add', '待删.txt');
    svn(f.scope, 'commit', '待删.txt', '-m', '待删基线');
    svn(f.scope, 'delete', '待删.txt');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /待删\.txt/));
    await ui.openChange('待删.txt');
    await eventually(async () => {
      const sides = await ui.diffSides();
      assert.match(sides.original, /第一行 REMOVED/);
      assert.match(sides.original, /第二行 REMOVED/);
      assert.doesNotMatch(sides.modified, /REMOVED/);
    });
    assert.equal(await ui.diffCount(), 1);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('保留本地内容的 SVN 删除仍呈现为全部删除', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const removed = path.join(f.scope, '待删.txt');
    await fs.writeFile(removed, '第一行 REMOVED\n第二行 REMOVED\n');
    svn(f.scope, 'add', '待删.txt');
    svn(f.scope, 'commit', '待删.txt', '-m', '待删基线');
    svn(f.scope, 'delete', '--keep-local', '待删.txt');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /待删\.txt/));
    await ui.openChange('待删.txt');
    await eventually(async () => {
      const sides = await ui.diffSides();
      assert.match(sides.original, /第一行 REMOVED/);
      assert.match(sides.original, /第二行 REMOVED/);
      assert.doesNotMatch(sides.modified, /REMOVED/);
    });
    assert.equal(await ui.diffCount(), 1);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('二进制文件明确说明内容不可分析，不显示为没有变更', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const binary = path.join(f.scope, '二进制.bin');
    await fs.writeFile(binary, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02, 0x03, 0x00, 0x04]));
    svn(f.scope, 'add', '二进制.bin');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /二进制\.bin/));
    await ui.openChange('二进制.bin');
    await eventually(async () => {
      const notice = await ui.notifications();
      assert.match(notice, /二进制\.bin/);
      assert.match(notice, /二进制/);
      assert.match(notice, /不可分析/);
      assert.doesNotMatch(notice, /没有变更/);
    });
    assert.equal(await ui.diffCount(), 0, '二进制内容不应进入文本差异编辑器');
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('未跟踪文件不伪装成 SVN 差异，直接查看本地文件内容', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.writeFile(path.join(f.scope, '未跟踪.txt'), 'untracked content 未跟踪内容\n');
    await fs.appendFile(path.join(f.scope, '修改 中文.txt'), 'changed\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /未跟踪\.txt/));
    await ui.openChange('未跟踪.txt');
    await eventually(async () => {
      const notice = await ui.notifications();
      assert.match(notice, /未跟踪文件尚未加入 SVN/);
      assert.match(notice, /没有 SVN 差异/);
    });
    assert.equal(await ui.diffCount(), 0, '未跟踪文件不应打开 SVN 差异编辑器');
    assert.match(await ui.editorTabs(), /未跟踪\.txt/);
    assert.match(await ui.editorText(), /untracked content 未跟踪内容/);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('文本文件同时有内容和属性变化时，差异编辑器与属性变化都可查看', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.appendFile(path.join(f.scope, '修改 中文.txt'), '第四行 ADDED\n');
    svn(f.scope, 'propset', 'owner', 'team', '修改 中文.txt');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /修改 中文\.txt/));
    await ui.openChange('修改 中文.txt');
    await eventually(async () => {
      const sides = await ui.diffSides();
      assert.match(sides.modified, /第四行 ADDED/);
    });
    assert.equal(await ui.diffCount(), 1);
    await ui.page.locator('.editor-group-container.active .tab')
      .filter({ hasText: '修改 中文.txt' }).filter({ hasNotText: '本地差异' }).first().click();
    await eventually(async () => {
      const text = await ui.editorText();
      assert.match(text, /SVN 属性差异/);
      assert.match(text, /新增属性 owner = team/);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('SVN 不可用时查看差异显示可操作原因', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.appendFile(path.join(f.scope, '修改 中文.txt'), 'changed\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /修改 中文\.txt/));
    await ui.settings({ 'codeSvn.svnPath': path.join(f.root, 'missing-svn.exe') });
    await eventually(async () => assert.match(await ui.notifications(), /SVN：查询失败|配置 SVN 路径/));
    await ui.openChange('修改 中文.txt');
    await eventually(async () => {
      const notice = await ui.notifications();
      assert.match(notice, /查看 修改 中文\.txt 的差异失败/);
      assert.match(notice, /codeSvn\.svnPath/);
    });
    assert.equal(await ui.diffCount(), 0);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('整体目录删除后仍能查看子文件的全部删除差异', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    await fs.mkdir(path.join(f.scope, '待删目录'));
    const removed = path.join(f.scope, '待删目录', '待删.txt');
    await fs.writeFile(removed, '第一行 REMOVED\n第二行 REMOVED\n');
    svn(f.scope, 'add', '待删目录');
    svn(f.scope, 'commit', '待删目录', '-m', '待删基线');
    svn(f.scope, 'delete', '待删目录');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /待删\.txt/));
    await ui.openChange('待删.txt');
    await eventually(async () => {
      const sides = await ui.diffSides();
      assert.match(sides.original, /第一行 REMOVED/);
      assert.match(sides.original, /第二行 REMOVED/);
      assert.doesNotMatch(sides.modified, /REMOVED/);
    });
    assert.equal(await ui.diffCount(), 1);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});


test('SVN MIME 类型标记为二进制时不把 UTF-8 字节当作文本差异', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const binary = path.join(f.scope, '二进制.bin');
    await fs.writeFile(binary, 'old binary-looking text\n');
    svn(f.scope, 'add', '二进制.bin');
    svn(f.scope, 'propset', 'svn:mime-type', 'application/octet-stream', '二进制.bin');
    svn(f.scope, 'commit', '二进制.bin', '-m', '二进制基线');
    await fs.writeFile(binary, 'new binary-looking text\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /二进制\.bin/));
    await ui.openChange('二进制.bin');
    await eventually(async () => {
      const notice = await ui.notifications();
      assert.match(notice, /二进制\.bin/);
      assert.match(notice, /二进制/);
      assert.match(notice, /不可分析/);
      assert.doesNotMatch(notice, /没有变更/);
    });
    assert.equal(await ui.diffCount(), 0, '二进制内容不应进入文本差异编辑器');
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('不可直接显示的属性值明确标注 Base64 编码', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const valueFile = path.join(f.root, 'property-value.bin');
    await fs.writeFile(valueFile, Buffer.from([65, 0, 66]));
    svn(f.scope, 'propset', 'opaque', '--file', valueFile, '修改 中文.txt');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /修改 中文\.txt/));
    await ui.openChange('修改 中文.txt');
    await eventually(async () => assert.match(await ui.editorText(), /opaque.*Base64.*QQBC/));
    assert.equal(await ui.diffCount(), 0);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('再次点击已打开的差异时更新文本、属性与提交后的 BASE', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const target = path.join(f.scope, '修改 中文.txt');
    await fs.writeFile(target, 'FIRST\n');
    svn(f.scope, 'propset', 'owner', 'first-team', '修改 中文.txt');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /修改 中文\.txt/));
    await ui.openChange('修改 中文.txt');
    await eventually(async () => assert.match((await ui.diffSides()).modified, /FIRST/));
    await fs.writeFile(target, 'SECOND\n');
    svn(f.scope, 'propset', 'owner', 'second-team', '修改 中文.txt');
    await ui.command('SVN：刷新变更');
    await ui.openChange('修改 中文.txt');
    await eventually(async () => {
      const sides = await ui.diffSides();
      assert.match(sides.modified, /SECOND/);
      assert.doesNotMatch(sides.modified, /FIRST/);
    });
    await ui.page.locator('.editor-group-container.active .tab')
      .filter({ hasText: '修改 中文.txt' }).filter({ hasNotText: '本地差异' }).first().click();
    await eventually(async () => {
      const text = await ui.editorText();
      assert.match(text, /owner = second-team/);
      assert.doesNotMatch(text, /first-team/);
    });
    svn(f.scope, 'commit', '修改 中文.txt', '-m', '新的基线');
    await fs.writeFile(target, 'THIRD\n');
    await ui.command('SVN：刷新变更');
    await ui.openChange('修改 中文.txt');
    await eventually(async () => {
      const sides = await ui.diffSides();
      assert.match(sides.original, /SECOND/);
      assert.match(sides.modified, /THIRD/);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('含中文、空格和 @ 的文件名可以查看文本差异', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const name = '中文 空格 @文件.txt';
    const target = path.join(f.scope, name);
    await fs.writeFile(target, 'ORIGINAL\n');
    svn(f.scope, 'add', `${name}@`);
    svn(f.scope, 'commit', `${name}@`, '-m', '特殊路径基线');
    await fs.writeFile(target, 'CHANGED\n');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /中文 空格 @文件\.txt/));
    await ui.openChange(name);
    await eventually(async () => {
      const sides = await ui.diffSides();
      assert.match(sides.original, /ORIGINAL/);
      assert.match(sides.modified, /CHANGED/);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('修改和删除属性均展示原值，保留多行属性内容', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    svn(f.scope, 'propset', 'owner', 'old-team', '修改 中文.txt');
    svn(f.scope, 'propset', 'removed', 'old-value', '修改 中文.txt');
    svn(f.scope, 'commit', '修改 中文.txt', '-m', '属性基线');
    svn(f.scope, 'propset', 'owner', 'new-team', '修改 中文.txt');
    svn(f.scope, 'propdel', 'removed', '修改 中文.txt');
    const valueFile = path.join(f.root, 'property-value.txt');
    await fs.writeFile(valueFile, '第一行\n第二行');
    svn(f.scope, 'propset', 'multiline', '--file', valueFile, '修改 中文.txt');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /修改 中文\.txt/));
    await ui.openChange('修改 中文.txt');
    await eventually(async () => {
      const text = await ui.editorText();
      assert.match(text, /修改属性 owner：old-team → new-team/);
      assert.match(text, /删除属性 removed（原值：old-value）/);
      assert.match(text, /multiline = 第一行\n第二行/);
    });
    assert.equal(await ui.diffCount(), 0);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('SVN 符号链接差异展示链接目标，不读取管理范围外的正文', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const link = path.join(f.scope, '链接.txt');
    const secret = path.join(f.wc, 'sibling', 'secret.txt');
    await fs.writeFile(secret, 'OUTSIDE_SCOPE_SECRET\n');
    await fs.symlink(path.join(f.wc, 'sibling', 'outside.txt'), link, 'file');
    svn(f.scope, 'add', '链接.txt');
    svn(f.scope, 'commit', '链接.txt', '-m', '链接基线');
    await fs.unlink(link);
    await fs.symlink(secret, link, 'file');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /链接\.txt/));
    await ui.openChange('链接.txt');
    await eventually(async () => {
      const sides = await ui.diffSides();
      assert.match(sides.original, /link .*outside\.txt/);
      assert.match(sides.modified, /link .*secret\.txt/);
      assert.doesNotMatch(`${sides.original}\n${sides.modified}`, /OUTSIDE_SCOPE_SECRET/);
    });
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});

test('未跟踪符号链接只查看链接目标，不打开范围外文件正文', { timeout: 120000 }, async () => {
  const f = await fixture();
  let ui;
  try {
    const secret = path.join(f.wc, 'sibling', 'secret.txt');
    await fs.writeFile(secret, 'OUTSIDE_SCOPE_SECRET\n');
    await fs.symlink(secret, path.join(f.scope, '未跟踪链接.txt'), 'file');
    ui = await host(f.root, f.scope);
    await ui.command('SVN：刷新变更');
    await eventually(async () => assert.match(await ui.scmText(), /未跟踪链接\.txt/));
    await ui.openChange('未跟踪链接.txt');
    await eventually(async () => {
      const text = await ui.editorText();
      assert.match(text, /link .*secret\.txt/);
      assert.doesNotMatch(text, /OUTSIDE_SCOPE_SECRET/);
      assert.match(await ui.notifications(), /未跟踪.*没有 SVN 差异/);
    });
    assert.equal(await ui.diffCount(), 0);
  } finally {
    if (ui) await ui.close();
    await cleanup(f.root);
  }
});
