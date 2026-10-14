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
  const workspaceFile = path.join(root, 'test.code-workspace');
  async function setFolders(folders) {
    await fs.writeFile(workspaceFile, JSON.stringify({ folders: folders.map(folder => ({ path: folder })) }));
  }
  if (Array.isArray(folder)) {
    await setFolders(folder);
    folder = workspaceFile;
  }
  const profile = path.join(root, 'profile');
  await fs.mkdir(path.join(profile, 'User'), { recursive: true });
  await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'workbench.enableExperiments': false,
    'update.mode': 'none',
    'window.dialogStyle': 'custom',
    'git.enabled': false,
    'scm.defaultViewMode': 'list',
    'scm.alwaysShowRepositories': false,
    'diffEditor.renderSideBySide': true,
    'diffEditor.useInlineViewWhenSpaceIsLimited': false,
    ...settings
  }));
  let executable = process.env.VSCODE_EXECUTABLE;
  if (!executable && process.platform === 'win32') {
    const cli = execFileSync('where.exe', ['code.cmd'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    executable = path.resolve(path.dirname(cli), '..', 'Code.exe');
  }
  if (!executable) throw new Error('请设置 VSCODE_EXECUTABLE 为 VS Code 主可执行文件路径');
  // A random free port chosen by Chromium; its file belongs to this isolated profile.
  // SVN_TEST_INSTALLED_EXTENSIONS_DIR runs the installed VSIX from an isolated extensions
  // directory instead of the development build, so the installed package is what gets exercised.
  const installed = process.env.SVN_TEST_INSTALLED_EXTENSIONS_DIR;
  const args = installed
    ? [folder, '--new-window', `--user-data-dir=${profile}`, `--extensions-dir=${installed}`]
    : [folder, '--new-window', '--disable-extensions', `--extensionDevelopmentPath=${path.resolve('.')}`,
      `--user-data-dir=${profile}`, `--extensions-dir=${path.join(root, 'extensions')}`];
  const child = spawn(executable, [...args, '--remote-debugging-port=0',
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
      // A notification button (for example the "Use weaker encryption" notice shown when no
      // keyring is available) steals focus and swallows F1 and sidebar shortcuts, so return
      // focus to the workbench before sending a keybinding.
      focus: () => page.evaluate(() => document.querySelector('.monaco-workbench')?.focus()),
      folders: setFolders,
      async settings(values) {
        const file = path.join(profile, 'User', 'settings.json');
        const current = JSON.parse(await fs.readFile(file, 'utf8'));
        await fs.writeFile(file, JSON.stringify({ ...current, ...values }));
      },
      async command(title, waitForClose = true) {
        await this.focus();
        await page.keyboard.press('F1');
        // Closed input boxes stay in the DOM; only the visible one is the palette or prompt.
        const input = page.locator('.quick-input-widget input:visible').first();
        await input.waitFor();
        await input.fill(`>${title}`);
        await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: title }).first().waitFor();
        await page.keyboard.press('Enter');
        if (waitForClose) await input.waitFor({ state: 'hidden' });
      },
      async chooseChange(title, name) {
        await this.command(title, false);
        await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: name }).first().click();
        await page.locator('.quick-input-widget input:visible').first().waitFor({ state: 'hidden' });
      },
      async commitMessage(message, index = 0) {
        await this.focus();
        await page.keyboard.press('Control+Shift+G');
        const input = page.locator('.scm-view .scm-input .monaco-editor').nth(index);
        await input.click({ position: { x: 30, y: 15 } });
        await page.keyboard.press('Control+A');
        await page.keyboard.insertText(message);
      },
      async commitMessageText(index = 0) {
        return (await page.locator('.scm-view .scm-input').nth(index).locator('.view-lines').allInnerTexts()).join('\n').replace(/\u00a0/g, ' ');
      },
      async editFile(target, text) {
        await this.focus();
        await page.keyboard.press('Control+P');
        const input = page.locator('.quick-input-widget input:visible').first();
        await input.fill(target);
        await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: path.basename(target) }).first().waitFor();
        await page.keyboard.press('Enter');
        await input.waitFor({ state: 'hidden' });
        const editor = page.locator('.editor-group-container.active .monaco-editor').first();
        await editor.click({ position: { x: 70, y: 15 } });
        await page.keyboard.press('Control+A');
        await page.keyboard.insertText(text);
      },
      async scmText() {
        await page.keyboard.press('Control+Shift+G');
        return (await page.locator('.scm-view .monaco-list-row').allInnerTexts()).join('\n');
      },
      async openChange(name) {
        await page.keyboard.press('Control+Shift+G');
        await page.locator('.scm-view .monaco-list-row').filter({ hasText: name }).first().click();
      },
      async diffSides() {
        const side = selector => page.locator(selector).allInnerTexts().then(parts => parts.join('\n').replace(/\u00a0/g, ' '));
        return {
          original: await side('.original-in-monaco-diff-editor .view-lines'),
          modified: await side('.modified-in-monaco-diff-editor .view-lines')
        };
      },
      async diffCount() {
        return page.locator('.monaco-diff-editor').count();
      },
      async editorText() {
        return (await page.locator('.monaco-editor .view-lines').allInnerTexts()).join('\n').replace(/\u00a0/g, ' ');
      },
      async editorTabs() {
        return (await page.locator('.editor-group-container.active .tab').allInnerTexts()).join('\n');
      },
      async notifications() {
        return page.locator('.notifications-toasts').innerText().catch(() => '');
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
