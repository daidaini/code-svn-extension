const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const { CommitSelection, expand } = require('../dist/commit-selection.js');

function svn(cwd, ...args) {
  return execFileSync(process.env.SVN_EXECUTABLE || 'svn', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-svn-selection-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const repo = path.join(root, 'repo');
  execFileSync(process.env.SVNADMIN_EXECUTABLE || 'svnadmin', ['create', repo]);
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'tree'), { recursive: true });
  await fs.writeFile(path.join(source, 'tree/nested.js'), 'export const nested = 1;\n');
  await fs.writeFile(path.join(source, 'main.js'), 'export function run(value) {\n  return value + 1;\n}\n');
  await fs.writeFile(path.join(source, 'helper.js'), 'export const allowed = true;\n');
  const url = pathToFileURL(repo).href;
  svn(source, 'import', '.', url, '-m', 'fixture');
  const wc = path.join(root, 'wc');
  svn(root, 'checkout', url, wc);
  return { root, wc, url, svn: (...args) => svn(wc, ...args) };
}

test('移动源不在管理范围内时 addMany 拒绝，不产生部分选择', async t => {
  const f = await fixture(t);
  // Source lies outside the managed scope: only the tree subdirectory is opened.
  f.svn('move', '--', `${path.join(f.wc, 'main.js')}@`, 'tree/moved.js');
  const scope = path.join(f.wc, 'tree');
  const { all } = await status(scope);
  const target = all.find(change => change.item === 'added' && change.movedFrom);
  assert.ok(target, 'expected move target visible in scope status');
  assert.equal(target.movedFrom, path.join(f.wc, 'main.js'));
  const selection = new CommitSelection(f.wc);
  selection.reconcile(all);
  await assert.rejects(() => selection.addMany([target], [scope]), /移动源.*不在当前管理范围内/);
  assert.equal(selection.size, 0);
});

async function status(wc) {
  const state = require('../dist/svn.js');
  const { changes, ancestors } = await state.readChanges(process.env.SVN_EXECUTABLE || 'svn', wc);
  return { changes, all: [...ancestors, ...changes] };
}

const rel = (wc, paths) => paths.map(value => path.relative(wc, value).split(path.sep).join('/')).sort();

test('选择目录展开为目录自身与全部后代变更，含未跟踪后代', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.wc, 'tree/added.js'), 'export const added = 1;\n');
  f.svn('add', '--', 'tree/added.js@');
  await fs.writeFile(path.join(f.wc, 'tree/untracked.js'), 'UNTRACKED\n');
  const { changes, all } = await status(f.wc);
  const result = await expand([path.join(f.wc, 'tree')], all);
  // Only changed descendants are operations: tree itself and nested.js have no change.
  assert.deepEqual(rel(f.wc, result.operations.map(change => change.path)),
    ['tree/added.js', 'tree/untracked.js']);
  assert.equal(result.reasons.length, 0);
});

test('直接选择整体目录删除的子项返回 inside-tree-deletion 原因，指向目录', async t => {
  const f = await fixture(t);
  f.svn('delete', '--', 'tree@');
  const { all } = await status(f.wc);
  const result = await expand([path.join(f.wc, 'tree/nested.js')], all);
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.reasons.map(reason => reason.code), ['inside-tree-deletion']);
  assert.equal(result.reasons[0].target, path.join(f.wc, 'tree'));
});

test('选择目录时整体删除的子项被排除，只留下目录操作', async t => {
  const f = await fixture(t);
  f.svn('delete', '--', 'tree@');
  const { changes, all } = await status(f.wc);
  const result = await expand([path.join(f.wc, 'tree')], all);
  assert.deepEqual(rel(f.wc, result.operations.map(change => change.path)), ['tree']);
  const dir = changes.find(change => change.path === path.join(f.wc, 'tree'));
  assert.equal(dir.item, 'deleted');
  assert.equal(result.reasons.length, 0);
});

test('单独选择已删除文件原样保留，交由调用方决定策略', async t => {
  const f = await fixture(t);
  f.svn('delete', '--', 'helper.js@');
  const { all } = await status(f.wc);
  const result = await expand([path.join(f.wc, 'helper.js')], all);
  assert.deepEqual(rel(f.wc, result.operations.map(change => change.path)), ['helper.js']);
  assert.equal(result.reasons.length, 0);
});

test('直接选择移动源返回 moved-to-target 原因，指向移动目标', async t => {
  const f = await fixture(t);
  f.svn('move', '--', 'main.js@', 'moved.js');
  const { all } = await status(f.wc);
  const result = await expand([path.join(f.wc, 'main.js')], all);
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.reasons.map(reason => reason.code), ['moved-to-target']);
  assert.equal(result.reasons[0].target, path.join(f.wc, 'moved.js'));
});

test('移动源与目标同时选择时源被排除，不产生原因；依赖经 addMany 恢复', async t => {
  const f = await fixture(t);
  f.svn('move', '--', 'main.js@', 'moved.js');
  const { all } = await status(f.wc);
  const result = await expand([path.join(f.wc, 'main.js'), path.join(f.wc, 'moved.js')], all);
  assert.deepEqual(rel(f.wc, result.operations.map(change => change.path)), ['moved.js']);
  assert.equal(result.reasons.length, 0);
  const selection = new CommitSelection(f.wc);
  selection.reconcile(all);
  await selection.addMany(result.operations, [f.wc]);
  assert.deepEqual(rel(f.wc, selection.targets), ['main.js', 'moved.js']);
  assert.equal(selection.isDependency(path.join(f.wc, 'main.js')), true);
});

test('目录展开时目录内的移动源被静默排除，目录外的整体删除文件原样保留', async t => {
  const f = await fixture(t);
  f.svn('move', '--', 'tree/nested.js@', 'tree/renamed.js');
  f.svn('delete', '--', 'helper.js@');
  const { all } = await status(f.wc);
  const result = await expand([f.wc], all);
  const paths = rel(f.wc, result.operations.map(change => change.path));
  assert.ok(paths.includes('tree/renamed.js'), '移动目标保留');
  assert.ok(!paths.includes('tree/nested.js'), '移动源被排除');
  assert.ok(paths.includes('helper.js'), '已删除文件原样保留，策略交调用方');
  assert.equal(result.reasons.length, 0);
});

test('目录与其中文件重叠多选时去重，不产生重复操作', async t => {
  const f = await fixture(t);
  f.svn('propset', 'review:flag', 'on', '--', 'tree@');
  const { all } = await status(f.wc);
  const result = await expand([path.join(f.wc, 'tree'), path.join(f.wc, 'tree/nested.js')], all);
  // nested.js has no change of its own; only the directory's property change is an operation.
  assert.deepEqual(rel(f.wc, result.operations.map(change => change.path)), ['tree']);
});

test('展开结果穿过 addMany 后成为完整提交选择（目录属性 + 后代）', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.wc, 'tree/added.js'), 'export const added = 1;\n');
  f.svn('add', '--', 'tree/added.js@');
  f.svn('propset', 'review:flag', 'on', '--', 'tree@');
  const { all } = await status(f.wc);
  const result = await expand([path.join(f.wc, 'tree')], all);
  const selection = new CommitSelection(f.wc);
  selection.reconcile(all);
  await selection.addMany(result.operations, [f.wc]);
  // Only actual changes become targets: nested.js is untouched and absent from status.
  assert.deepEqual(rel(f.wc, selection.targets), ['tree', 'tree/added.js']);
  assert.equal(selection.size, 2);
});

test('展开含未跟踪后代的目录后 addMany 整组拒绝，不留部分选择', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.wc, 'tree/untracked.js'), 'UNTRACKED\n');
  const { all } = await status(f.wc);
  const result = await expand([path.join(f.wc, 'tree')], all);
  const selection = new CommitSelection(f.wc);
  selection.reconcile(all);
  await assert.rejects(() => selection.addMany(result.operations, [f.wc]), /尚未跟踪/);
  assert.equal(selection.size, 0, '原子拒绝不得留下部分提交选择');
});
