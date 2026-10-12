import * as vscode from 'vscode';
import { Change, readChanges } from './svn';

const labels: Record<string, string> = {
  modified: '已修改', added: '已添加', deleted: '已删除', missing: '本地缺失',
  unversioned: '未跟踪', replaced: '已替换', obstructed: '路径阻塞', incomplete: '不完整'
};

function label(change: Change): string {
  if (change.conflicted) return '冲突';
  if (['normal', 'none'].includes(change.item)) return '属性已修改';
  const text = labels[change.item] ?? `SVN 状态：${change.item}`;
  return change.props === 'modified' ? `${text}（含属性）` : text;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Code SVN');
  let sourceControl: vscode.SourceControl | undefined;
  let folder: vscode.WorkspaceFolder | undefined;
  let watcher: vscode.FileSystemWatcher | undefined;
  const groups = new Map<string, vscode.SourceControlResourceGroup>();
  let disposed = false;
  let pending = false;
  let running: Promise<void> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let lastError = '';

  function ensureSourceControl(): vscode.SourceControl {
    if (!sourceControl) {
      sourceControl = vscode.scm.createSourceControl('codeSvn', 'SVN', folder!.uri);
      sourceControl.inputBox.visible = false;
    }
    return sourceControl;
  }

  async function refreshOnce(): Promise<void> {
    // Task 02 adds merging of overlapping folders and independent working copies.
    const nextFolder = vscode.workspace.workspaceFolders?.[0];
    if (nextFolder?.uri.toString() !== folder?.uri.toString()) {
      sourceControl?.dispose(); sourceControl = undefined;
      groups.clear(); watcher?.dispose(); watcher = undefined;
      folder = nextFolder;
      lastError = '';
      if (folder) {
        watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
        watcher.onDidCreate(schedule); watcher.onDidChange(schedule); watcher.onDidDelete(schedule);
      }
    }
    if (!folder || folder.uri.scheme !== 'file') return;
    const queriedFolder = folder;
    const executable = vscode.workspace.getConfiguration('codeSvn', folder.uri).get<string>('svnPath', 'svn');
    try {
      const changes = await readChanges(executable, folder.uri.fsPath);
      if (disposed) return;
      lastError = '';
      if (changes === undefined) {
        sourceControl?.dispose(); sourceControl = undefined; groups.clear();
        return;
      }
      const scm = ensureSourceControl();
      const byLabel = new Map<string, vscode.SourceControlResourceState[]>();
      for (const change of changes) {
        const name = label(change);
        const states = byLabel.get(name) ?? [];
        const resourceUri = vscode.Uri.file(change.path);
        states.push({
          resourceUri,
          decorations: { tooltip: name, strikeThrough: ['deleted', 'missing'].includes(change.item) }
        });
        byLabel.set(name, states);
      }
      for (const [name, states] of byLabel) {
        if (!groups.has(name)) {
          const group = scm.createResourceGroup(name, name);
          group.hideWhenEmpty = true;
          groups.set(name, group);
        }
        groups.get(name)!.resourceStates = states;
      }
      for (const [name, group] of groups) if (!byLabel.has(name)) group.resourceStates = [];
      scm.count = changes.length;
      scm.statusBarCommands = [{
        command: 'codeSvn.refresh', title: `$(source-control) SVN：${changes.length} 项变更`,
        tooltip: '刷新当前打开目录的 SVN 变更'
      }];
    } catch (error) {
      if (disposed) return;
      const detail = error instanceof Error ? error.message : String(error);
      const scm = ensureSourceControl();
      // Keep the last successful list, but make its stale status explicit.
      scm.statusBarCommands = [{ command: 'codeSvn.showOutput', title: '$(error) SVN：查询失败（列表未更新）', tooltip: detail }];
      output.appendLine(`${new Date().toISOString()} ${queriedFolder.uri.fsPath}\n${detail}`);
      if (lastError !== detail) {
        lastError = detail;
        void vscode.window.showErrorMessage(
          'SVN 查询失败，不能确认当前变更。请检查工作区环境的 SVN 安装与 codeSvn.svnPath 设置。',
          '配置 SVN 路径', '查看日志'
        ).then(action => {
          if (action === '配置 SVN 路径') void vscode.commands.executeCommand('workbench.action.openSettings', 'codeSvn.svnPath');
          if (action === '查看日志') output.show();
        });
      }
    }
  }

  function refresh(): Promise<void> {
    pending = true;
    if (!running) {
      running = (async () => {
        while (pending && !disposed) { pending = false; await refreshOnce(); }
      })().finally(() => { running = undefined; });
    }
    return running;
  }

  function schedule(): void {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { void refresh(); }, 300);
  }

  // Poll as a fallback for external CLI operations and ignored .svn metadata.
  const poll = setInterval(() => { void refresh(); }, 5000);
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('codeSvn.refresh', refresh),
    vscode.commands.registerCommand('codeSvn.showOutput', () => output.show()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('codeSvn.svnPath')) void refresh();
    }),
    { dispose() {
      disposed = true; clearInterval(poll); if (debounce) clearTimeout(debounce);
      watcher?.dispose(); sourceControl?.dispose();
    } }
  );
  void refresh();
}
