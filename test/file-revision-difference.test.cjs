const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, svn, cleanup } = require('./host.cjs');
const { readObjectLocation, readFileRevisionDifference } = require('../dist/svn');

const executable = process.env.SVN_EXECUTABLE || 'svn';
const name = '修改 中文.txt';

test('文件版本比较读取指定快照及属性，忽略本地修改并按时间排序', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.scope, name);
    svn(f.scope, 'propset', 'state', 'BEFORE', '--', name);
    svn(f.scope, 'commit', '-m', 'property before');
    await fs.writeFile(target, 'AFTER\n');
    svn(f.scope, 'propset', 'state', 'AFTER', '--', name);
    svn(f.scope, 'commit', '-m', 'property after');
    await fs.writeFile(target, 'UNCOMMITTED\n');
    const location = await readObjectLocation(executable, f.scope, target);
    const content = await readFileRevisionDifference(executable, f.scope, location, 3, 2);
    assert.equal(content.beforeRevision, 2);
    assert.equal(content.afterRevision, 3);
    assert.equal(content.base, 'initial\n');
    assert.equal(content.text, 'AFTER\n');
    assert.deepEqual(content.properties, [{ name: 'state', before: { value: 'BEFORE', encoding: 'text' }, after: { value: 'AFTER', encoding: 'text' } }]);
  } finally { await cleanup(f.root); }
});

test('指定修订早于文件新增时以空内容比较，不把服务器错误吞成空内容', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.scope, 'new @中文.txt');
    await fs.writeFile(target, 'ADDED\n');
    svn(f.scope, 'add', '--', 'new @中文.txt@');
    svn(f.scope, 'commit', '-m', 'add file');
    const location = await readObjectLocation(executable, f.scope, target);
    const content = await readFileRevisionDifference(executable, f.scope, location, 1, 'HEAD');
    assert.equal(content.base, undefined);
    assert.equal(content.text, 'ADDED\n');
    assert.equal(content.afterRevision, 2);
    await assert.rejects(readFileRevisionDifference(executable, f.scope, location, 999999, 'HEAD'));
  } finally { await cleanup(f.root); }
});

test('文件版本比较识别 MIME 声明的二进制文件', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.scope, name);
    svn(f.scope, 'propset', 'svn:mime-type', 'application/octet-stream', '--', name);
    await fs.writeFile(target, 'BINARY DECLARED\n');
    svn(f.scope, 'commit', '-m', 'binary');
    const location = await readObjectLocation(executable, f.scope, target);
    const content = await readFileRevisionDifference(executable, f.scope, location, 1, 'HEAD');
    assert.equal(content.binary, true);
  } finally { await cleanup(f.root); }
});
