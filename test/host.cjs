const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const artifacts = path.resolve('.test-artifacts');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function svn(cwd, ...args) {
  return execFileSync(process.env.SVN_EXECUTABLE || 'svn', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function fixture() {
  await fs.mkdir(artifacts, { recursive: true });
  const root = await fs.mkdtemp(path.join(artifacts, 'host-'));
  const repo = path.join(root, 'repo');
  execFileSync(process.env.SVNADMIN_EXECUTABLE || 'svnadmin', ['create', repo], { windowsHide: true });
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, '中文 空格 @目录'), { recursive: true });
  await fs.mkdir(path.join(source, 'sibling'));
  await fs.writeFile(path.join(source, '中文 空格 @目录', '修改 中文.txt'), 'initial\n');
  await fs.writeFile(path.join(source, 'sibling', 'outside.txt'), 'initial\n');
  const url = pathToFileURL(repo).href;
  svn(source, 'import', '.', url, '-m', 'fixture');
  const wc = path.join(root, 'wc 中文 空格');
  svn(root, 'checkout', url, wc);
  return { root, wc, scope: path.join(wc, '中文 空格 @目录'), url };
}

async function host(root, folder, settings = {}) {
  const profile = path.join(root, 'profile');
  await fs.mkdir(path.join(profile, 'User'), { recursive: true });
  await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'workbench.enableExperiments': false,
    'update.mode': 'none',
    'git.enabled': false,
    'scm.defaultViewMode': 'list',
    'scm.alwaysShowRepositories': false,
    ...settings
  }));
  let executable = process.env.VSCODE_EXECUTABLE;
  if (!executable && process.platform === 'win32') {
    const cli = execFileSync('where.exe', ['code.cmd'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    executable = path.resolve(path.dirname(cli), '..', 'Code.exe');
  }
  if (!executable) throw new Error('请设置 VSCODE_EXECUTABLE 为 VS Code 主可执行文件路径');
  // A random free port chosen by Chromium; its file belongs to this isolated profile.
  const child = spawn(executable, [folder, '--new-window', '--disable-extensions',
    `--extensionDevelopmentPath=${path.resolve('.')}`, `--user-data-dir=${profile}`,
    `--extensions-dir=${path.join(root, 'extensions')}`, '--remote-debugging-port=0',
    '--skip-welcome', '--skip-release-notes'], { windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    let port;
    await eventually(async () => {
      port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      assert.ok(port > 0);
    });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    let page;
    await eventually(async () => {
      page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('workbench'));
      assert.ok(page);
      assert.ok(await page.locator('.monaco-workbench').count());
    });
    return {
      page,
      async settings(values) {
        const file = path.join(profile, 'User', 'settings.json');
        const current = JSON.parse(await fs.readFile(file, 'utf8'));
        await fs.writeFile(file, JSON.stringify({ ...current, ...values }));
      },
      async command(title) {
        await page.keyboard.press('F1');
        const input = page.locator('.quick-input-widget input').first();
        await input.fill(`>${title}`);
        await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: title }).first().waitFor();
        await page.keyboard.press('Enter');
        await input.waitFor({ state: 'hidden' });
      },
      async scmText() {
        await page.keyboard.press('Control+Shift+G');
        return (await page.locator('.scm-view .monaco-list-row').allInnerTexts()).join('\n');
      },
      async close() {
        await page.close();
        await browser.close();
        child.kill();
      }
    };
  } catch (error) {
    if (browser) await browser.close();
    child.kill();
    throw error;
  }
}

async function eventually(check, timeout = 30000) {
  const start = Date.now();
  let error;
  do {
    try { await check(); return; } catch (caught) { error = caught; }
    await delay(200);
  } while (Date.now() - start < timeout);
  throw error;
}

async function cleanup(root) {
  const relative = path.relative(artifacts, root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('拒绝清理测试目录之外的路径');
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

module.exports = { fixture, host, svn, eventually, cleanup };
