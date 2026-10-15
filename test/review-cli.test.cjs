const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const execute = promisify(execFile);
const cli = path.resolve('tools/review.cjs');
const apiKey = 'test-review-cli-key';
const clean = { findings: [], context_requests: [] };
const finding = {
  severity: 'medium', confidence: 'high', file: '范围 @目录/main.js', side: 'new', line_start: 2, line_end: 2,
  title: '返回值计算错误', trigger: '传入正整数', evidence: '加一被改成减一',
  impact: '返回错误结果', suggestion: '恢复加一', verification: '输入 1 时应返回 2'
};

function svn(cwd, ...args) {
  return execFileSync(process.env.SVN_EXECUTABLE || 'svn', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function fixture(t, handler = () => clean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-svn-review-'));
  let server;
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const repo = path.join(root, 'repo');
  execFileSync(process.env.SVNADMIN_EXECUTABLE || 'svnadmin', ['create', repo]);
  const source = path.join(root, 'source');
  const name = '范围 @目录';
  await fs.mkdir(path.join(source, name, 'tree'), { recursive: true });
  await fs.mkdir(path.join(source, 'sibling'));
  await fs.writeFile(path.join(source, name, 'main.js'), 'export function run(value) {\n  return value + 1;\n}\n');
  await fs.writeFile(path.join(source, name, 'helper.js'), 'export const allowed = true;\n');
  await fs.writeFile(path.join(source, name, 'obsolete.js'), 'export const legacy = 1;\n');
  await fs.writeFile(path.join(source, name, 'tree', 'nested.js'), 'export const nested = 1;\n');
  await fs.writeFile(path.join(source, 'sibling', 'outside.js'), 'OUTSIDE_SCOPE_CONTENT\n');
  const url = pathToFileURL(repo).href;
  svn(source, 'import', '.', url, '-m', 'fixture');
  const wc = path.join(root, 'wc 中文');
  svn(root, 'checkout', url, wc);
  const scope = path.join(wc, name);
  const requests = [];
  const f = { root, wc, scope, url, requests, svn: (...args) => svn(scope, ...args) };
  server = http.createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk; });
    request.on('end', async () => {
      try {
        const item = { payload: JSON.parse(text), headers: request.headers, url: request.url };
        requests.push(item);
        const value = await handler(f, item, requests.length);
        if (response.destroyed) return;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }));
      } catch (error) { response.statusCode = 500; response.end(error.message); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  f.settings = { 'codeSvn.ai.baseUrl': baseUrl, 'codeSvn.ai.model': 'review-fixture', 'codeSvn.ai.timeoutSeconds': 10 };
  f.run = async (args, options = {}) => {
    const settings = path.join(root, 'settings.json');
    // Exercise real VS Code JSONC, including a URL containing // and trailing commas.
    await fs.writeFile(settings, `// fixture\n${JSON.stringify({ ...f.settings, 'unrelated': 'comma,} quote" // string' }).replace(/}$/, ',\n}')}\n`);
    const argv = [cli, '--scope', scope, ...(options.defaultSettings ? [] : ['--settings', settings]),
      ...(options.terminal ? [] : ['--json']), ...args];
    let stdout, stderr, code;
    try {
      ({ stdout, stderr } = await execute(process.execPath, argv, { env: { ...process.env, CODE_SVN_AI_API_KEY: apiKey, ...options.env }, timeout: 30000 }));
      code = 0;
    } catch (error) { ({ stdout, stderr } = error); code = error.code; }
    return { code, stdout, stderr, result: options.terminal ? undefined : JSON.parse(stdout) };
  };
  f.edit = (file = 'main.js', text = 'export function run(value) {\n  return value - 1;\n}\n') => fs.writeFile(path.join(scope, file), text);
  return f;
}

test('CLI 复用 JSONC 设置，只发送所选 SVN 变更并提供终端报告', async t => {
  const f = await fixture(t);
  await f.edit();
  await f.edit('helper.js', 'UNSELECTED_LOCAL_CONTENT\n');
  const run = await f.run(['--intent', '修正运算', 'main.js']);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(run.result.status, 'clean');
  assert.deepEqual(run.result.coverage.selected, ['范围 @目录/main.js']);
  const request = f.requests[0];
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(request.payload.model, 'review-fixture');
  assert.equal(request.payload.stream, false);
  assert.match(request.payload.messages[1].content, /return value - 1/);
  assert.match(request.payload.messages[1].content, /修正运算/);
  assert.doesNotMatch(request.payload.messages[1].content, /UNSELECTED_LOCAL_CONTENT|OUTSIDE_SCOPE_CONTENT|\{\{/);
  const terminal = await f.run(['main.js'], { terminal: true });
  assert.equal(terminal.code, 0);
  assert.match(terminal.stdout, /已提供范围内未发现/);
});

test('默认设置文件、--all 与目录参数均只选择管理范围内的变更', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.scope, '.vscode'));
  await fs.writeFile(path.join(f.scope, '.vscode/settings.json'), JSON.stringify(f.settings));
  await f.edit();
  await f.edit('helper.js', 'export const allowed = false;\n');
  await f.edit('untracked.js', 'UNTRACKED_CONTENT\n');
  await fs.writeFile(path.join(f.wc, 'sibling/outside.js'), 'OUTSIDE_MODIFIED\n');
  const all = await f.run(['--all'], { defaultSettings: true });
  assert.equal(all.code, 0, all.stdout);
  assert.equal(all.result.coverage.files.length, 2);
  assert.doesNotMatch(f.requests[0].payload.messages[1].content, /UNTRACKED_CONTENT|OUTSIDE_MODIFIED/);
  f.svn('add', '--', 'untracked.js@');
  const directory = await f.run(['.']);
  assert.equal(directory.code, 0, directory.stdout);
  assert.equal(directory.result.coverage.files.length, 3);
});

test('删除文件使用 BASE 旧行号，不读取 --keep-local 遗留内容', async t => {
  const f = await fixture(t, () => ({ findings: [{ ...finding, file: '范围 @目录/obsolete.js', side: 'old', line_start: 1, line_end: 1 }], context_requests: [] }));
  f.svn('delete', '--keep-local', '--', 'obsolete.js@');
  await f.edit('obsolete.js', 'KEEP_LOCAL_MUST_NOT_BE_SENT\n');
  const run = await f.run(['obsolete.js']);
  assert.equal(run.code, 1, run.stdout);
  assert.match(f.requests[0].payload.messages[1].content, /legacy = 1/);
  assert.doesNotMatch(f.requests[0].payload.messages[1].content, /KEEP_LOCAL_MUST_NOT_BE_SENT/);
});

test('整体目录删除覆盖子文件，目录属性也进入输入', async t => {
  const f = await fixture(t);
  f.svn('delete', '--', 'tree@');
  f.svn('propset', 'review:flag', 'enabled', '--', '.@');
  const run = await f.run(['--all']);
  assert.equal(run.code, 0, run.stdout);
  assert.ok(run.result.coverage.files.includes('范围 @目录/tree/nested.js'));
  assert.match(f.requests[0].payload.messages[1].content, /nested = 1/);
  assert.match(f.requests[0].payload.messages[1].content, /review:flag/);
});

test('新增父目录和移动源被列为必需依赖，复制比较复制来源基线', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.scope, 'newdir'));
  await f.edit('newdir/new.js', 'export const fresh = 1;\n');
  f.svn('add', '--', 'newdir@');
  const added = await f.run(['newdir/new.js']);
  assert.equal(added.code, 0, added.stdout);
  assert.deepEqual(added.result.coverage.dependencies, ['范围 @目录/newdir']);
  f.svn('move', '--', 'main.js@', 'moved.js');
  const moved = await f.run(['moved.js']);
  assert.equal(moved.code, 0, moved.stdout);
  assert.ok(moved.result.coverage.dependencies.includes('范围 @目录/main.js'));
  f.svn('copy', '--', 'helper.js@', 'copied.js');
  await f.edit('copied.js', 'export const allowed = false;\n');
  const copied = await f.run(['copied.js']);
  assert.equal(copied.code, 0, copied.stdout);
  assert.match(f.requests.at(-1).payload.messages[1].content, /-export const allowed = true/);
});

test('只补充一次未选文件 BASE，忽略其本地修改并校验审查问题', async t => {
  const f = await fixture(t, (_f, _request, count) => count === 1
    ? { findings: [], context_requests: [{ file_or_symbol: '范围 @目录/helper.js', reason: '确认调用约束' }] }
    : { findings: [finding], context_requests: [] });
  await f.edit();
  await f.edit('helper.js', 'UNSELECTED_LOCAL_CONTENT\n');
  const run = await f.run(['main.js']);
  assert.equal(run.code, 1, run.stdout);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(run.result.coverage.context, ['范围 @目录/helper.js']);
  assert.match(f.requests[1].payload.messages[1].content, /allowed = true/);
  assert.doesNotMatch(f.requests[1].payload.messages[1].content, /UNSELECTED_LOCAL_CONTENT/);
});

test('共享核心按精确选择处理复制目录，CLI 目录选择才展开本地子项修改', async t => {
  const f = await fixture(t);
  f.svn('copy', '--', 'tree@', 'copytree');
  await f.edit('copytree/nested.js', 'UNSELECTED_COPY_EDIT\n');
  const { reviewSelection } = require('../dist/review.js');
  const target = path.join(f.scope, 'copytree');
  const result = await reviewSelection({
    executable: process.env.SVN_EXECUTABLE || 'svn', root: f.wc, scope: f.scope,
    explicit: [target], targets: [target], dependencies: []
  }, { baseUrl: f.settings['codeSvn.ai.baseUrl'], model: 'review-fixture', timeoutSeconds: 10 }, apiKey,
  await fs.readFile(path.resolve('tools/review_prompt.md'), 'utf8'));
  assert.equal(result.status, 'clean', JSON.stringify(result));
  assert.doesNotMatch(f.requests[0].payload.messages[1].content, /UNSELECTED_COPY_EDIT/);
  const directory = await f.run(['copytree']);
  assert.equal(directory.code, 0, directory.stdout);
  assert.match(f.requests[1].payload.messages[1].content, /UNSELECTED_COPY_EDIT/);
});

test('必要位置可定位已补充 BASE 的 old 行，不能虚构工作副本行', async t => {
  let side = 'old';
  const f = await fixture(t, (_f, _request, count) => count % 2 === 1
    ? { findings: [], context_requests: [{ file_or_symbol: '范围 @目录/helper.js', reason: '定位相关约束' }] }
    : { findings: [{ ...finding, file: '范围 @目录/helper.js', side, line_start: 1, line_end: 1 }], context_requests: [] });
  await f.edit();
  const old = await f.run(['main.js']);
  assert.equal(old.code, 1, old.stdout);
  side = 'new';
  const invented = await f.run(['main.js']);
  assert.equal(invented.code, 2, invented.stdout);
});

test('文件 external 不得成为补充上下文', async t => {
  const f = await fixture(t, () => ({ findings: [], context_requests: [{ file_or_symbol: '范围 @目录/external.js', reason: '确认调用约束' }] }));
  f.svn('propset', 'svn:externals', '^/sibling/outside.js external.js', '--', '.@');
  f.svn('update');
  await f.edit();
  const run = await f.run(['main.js']);
  assert.equal(run.code, 3, run.stdout);
  assert.equal(run.result.requests, 1);
  assert.doesNotMatch(f.requests[0].payload.messages[1].content, /OUTSIDE_SCOPE_CONTENT/);
});

test('范围外、符号、嵌套工作副本与二次上下文请求均保持不完整', async t => {
  let requested = 'sibling/outside.js';
  const f = await fixture(t, () => ({ findings: [], context_requests: [{ file_or_symbol: requested, reason: '确认具体约束' }] }));
  await f.edit();
  for (const value of ['sibling/outside.js', '../outside.js', '/etc/passwd', 'UnknownSymbol']) {
    requested = value;
    const run = await f.run(['main.js']);
    assert.equal(run.code, 3, run.stdout);
    assert.equal(run.result.requests, 1);
    assert.doesNotMatch(f.requests.at(-1).payload.messages[1].content, /OUTSIDE_SCOPE_CONTENT/);
  }
  svn(f.scope, 'checkout', f.url, 'nested');
  requested = '范围 @目录/nested/范围 @目录/helper.js';
  const nested = await f.run(['main.js']);
  assert.equal(nested.code, 3);
  assert.equal(nested.result.requests, 1);
  requested = '范围 @目录/helper.js';
  const repeated = await f.run(['main.js']);
  assert.equal(repeated.code, 3, repeated.stdout);
  assert.equal(repeated.result.requests, 2);
});

test('选定代码或已补充 BASE 变化时结果过期', async t => {
  const f = await fixture(t, async (f, _request, count) => {
    if (count === 1) await f.edit('main.js', 'CHANGED_DURING_REVIEW\n');
    return clean;
  });
  await f.edit();
  const run = await f.run(['main.js']);
  assert.equal(run.code, 4, run.stdout);
  assert.equal(run.result.status, 'stale');

  const g = await fixture(t, async (g, _request, count) => {
    if (count === 1) return { findings: [], context_requests: [{ file_or_symbol: '范围 @目录/helper.js', reason: '确认约束' }] };
    await g.edit('helper.js', 'export const allowed = false;\n');
    g.svn('commit', '-m', 'change context base', '--', 'helper.js@');
    return clean;
  });
  await g.edit();
  const context = await g.run(['main.js']);
  assert.equal(context.code, 4, context.stdout);
});

test('非法模型 JSON、置信度和行号均拒绝，错误输出不泄露 Key', async t => {
  let output = 'not JSON';
  const f = await fixture(t, () => output);
  await f.edit();
  for (const value of ['not JSON', { findings: [{ ...finding, confidence: 'low' }], context_requests: [] },
    { findings: [{ ...finding, line_end: 999 }], context_requests: [] },
    { findings: [{ ...finding, file: 'sibling/outside.js' }], context_requests: [] },
    { findings: [], context_requests: [{ file_or_symbol: apiKey }] }]) {
    output = value;
    const run = await f.run(['main.js']);
    assert.equal(run.code, 2, run.stdout);
    assert.equal(run.result.requests, 1);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(apiKey));
  }
});

test('二进制内容不发送，输入超限、未跟踪与符号链接不发送请求', async t => {
  const f = await fixture(t);
  await f.edit('main.js', Buffer.from([0, 1, 2, 3]));
  const binary = await f.run(['main.js']);
  assert.equal(binary.code, 3, binary.stdout);
  assert.deepEqual(binary.result.coverage.binary, ['范围 @目录/main.js']);
  await f.edit('main.js', 'x'.repeat(70000));
  const count = f.requests.length;
  const large = await f.run(['main.js']);
  assert.equal(large.code, 2);
  assert.equal(f.requests.length, count);
  await f.edit('untracked.js', 'not added\n');
  assert.equal((await f.run(['untracked.js'])).code, 2);
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(f.wc, 'sibling'), path.join(f.scope, 'linked'));
    assert.equal((await f.run(['linked/outside.js'])).code, 2);
  }
  assert.equal(f.requests.length, count);
});

test('配置错误及超时明确失败，共享传输仍支持提交信息草稿', async t => {
  const f = await fixture(t, async () => {
    await new Promise(resolve => setTimeout(resolve, 1100));
    return '草稿内容';
  });
  await f.edit();
  assert.equal((await f.run(['main.js'], { env: { CODE_SVN_AI_API_KEY: '' } })).code, 2);
  assert.equal(f.requests.length, 0);
  f.settings['codeSvn.ai.timeoutSeconds'] = 1;
  const timeout = await f.run(['main.js']);
  assert.equal(timeout.code, 2, timeout.stdout);
  assert.match(timeout.result.error, /超时/);
  const { requestDraft } = require('../dist/ai.js');
  const draft = await requestDraft({ baseUrl: f.settings['codeSvn.ai.baseUrl'], model: 'review-fixture', timeoutSeconds: 5 }, apiKey,
    [{ heading: '文件：main.js', body: '修改说明' }]);
  assert.equal(draft, '草稿内容');
  assert.match(f.requests.at(-1).payload.messages[0].content, /提交信息草稿/);
});

test('审查会话支持同一工作副本的多个打开目录，返回后重验并保留问题快照', async t => {
  const f = await fixture(t, () => ({ findings: [finding], context_requests: [] }));
  await f.edit();
  const other = path.join(f.wc, 'sibling');
  await fs.writeFile(path.join(other, 'outside.js'), 'SECOND_SELECTED_CHANGE\n');
  const selection = {
    executable: process.env.SVN_EXECUTABLE || 'svn', root: f.wc, scopes: [f.scope, other],
    explicit: [path.join(f.scope, 'main.js'), path.join(other, 'outside.js')],
    targets: [path.join(other, 'outside.js'), path.join(f.scope, 'main.js')], dependencies: []
  };
  const { runReview } = require('../dist/review.js');
  const session = await runReview({ selection,
    settings: { baseUrl: f.settings['codeSvn.ai.baseUrl'], model: 'review-fixture', timeoutSeconds: 10 }, apiKey,
    prompt: await fs.readFile(path.resolve('tools/review_prompt.md'), 'utf8') });
  assert.equal(session.result.status, 'findings', JSON.stringify(session.result));
  assert.match(f.requests[0].payload.messages[1].content, /SECOND_SELECTED_CHANGE/);
  assert.equal(await session.isCurrent(selection), true);
  assert.equal(await session.isCurrent({ ...selection, scopes: [f.wc] }), false);
  const snapshot = session.snapshot(session.result.findings[0]);
  assert.equal(snapshot.lineStart, 2);
  assert.match(snapshot.text, /return value - 1/);
  await f.edit('helper.js', 'UNSELECTED_LOCAL_CHANGE\n');
  assert.equal(await session.isCurrent(selection), true);
  await f.edit('main.js', 'AFTER_REVIEW\n');
  assert.equal(await session.isCurrent(selection), false);
  assert.match(session.snapshot(session.result.findings[0]).text, /return value - 1/);
});
