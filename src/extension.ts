import * as vscode from 'vscode';
import * as path from 'node:path';
import { Change, readChanges, WorkingCopyQueryError } from './svn';

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

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function within(folder: string, target: string): boolean {
  const relative = path.relative(pathKey(folder), pathKey(target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

interface WorkingCopyView {
  scm: vscode.SourceControl;
  groups: Map<string, vscode.SourceControlResourceGroup>;
  changes: Change[];
  lastError: string;
}

interface WorkingCopyResult {
  root: string;
  folders: vscode.WorkspaceFolder[];
  changes: Map<string, Change>;
  errors: string[];
}

function showChanges(view: WorkingCopyView, changes: Change[]): void {
  const byLabel = new Map<string, vscode.SourceControlResourceState[]>();
  for (const change of changes) {
    const name = label(change);
    const states = byLabel.get(name) ?? [];
    states.push({
      resourceUri: vscode.Uri.file(change.path),
      decorations: { tooltip: name, strikeThrough: ['deleted', 'missing'].includes(change.item) }
    });
    byLabel.set(name, states);
  }
  for (const [name, states] of byLabel) {
    if (!view.groups.has(name)) {
      const group = view.scm.createResourceGroup(name, name);
      group.hideWhenEmpty = true;
      view.groups.set(name, group);
    }
    view.groups.get(name)!.resourceStates = states;
  }
  for (const [name, group] of view.groups) if (!byLabel.has(name)) group.resourceStates = [];
  view.changes = changes;
  view.scm.count = changes.length;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Code SVN');
  const views = new Map<string, WorkingCopyView>();
  const watchers = new Map<string, vscode.FileSystemWatcher>();
  let knownRoots = new Map<string, string>();
  let disposed = false;
  let pending = false;
  let running: Promise<void> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  function openedFolders(): vscode.WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
  }

  async function refreshOnce(): Promise<void> {
    const folders = openedFolders();
    const folderIds = folders.map(folder => folder.uri.toString());
    for (const [id, watcher] of watchers) {
      if (!folderIds.includes(id)) { watcher.dispose(); watchers.delete(id); }
    }
    for (const folder of folders) {
      const id = folder.uri.toString();
      if (!watchers.has(id)) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
        watcher.onDidCreate(schedule); watcher.onDidChange(schedule); watcher.onDidDelete(schedule);
        watchers.set(id, watcher);
      }
    }
    const results = await Promise.allSettled(folders.map(folder => {
      const executable = vscode.workspace.getConfiguration('codeSvn', folder.uri).get<string>('svnPath', 'svn');
      return readChanges(executable, folder.uri.fsPath);
    }));
    if (disposed) return;
    // Never publish a result for a folder removed while SVN was querying it.
    if (JSON.stringify(folderIds) !== JSON.stringify(openedFolders().map(folder => folder.uri.toString()))) {
      pending = true;
      return;
    }
    const copies = new Map<string, WorkingCopyResult>();
    const nextRoots = new Map<string, string>();
    results.forEach((result, index) => {
      const folder = folders[index];
      if (result.status === 'fulfilled' && result.value === undefined) return;
      const root = result.status === 'fulfilled' ? result.value!.root
        : result.reason instanceof WorkingCopyQueryError ? result.reason.root
          : knownRoots.get(folder.uri.toString()) ?? folder.uri.fsPath;
      const key = pathKey(root);
      nextRoots.set(folder.uri.toString(), root);
      if (!copies.has(key)) copies.set(key, { root, folders: [], changes: new Map(), errors: [] });
      const copy = copies.get(key)!;
      copy.folders.push(folder);
      if (result.status === 'fulfilled') {
        for (const change of result.value!.changes) copy.changes.set(pathKey(change.path), change);
      } else {
        const detail = result.reason instanceof Error ? result.reason.message : String(result.reason);
        copy.errors.push(`${folder.uri.fsPath}\n${detail}`);
      }
    });
    knownRoots = nextRoots;
    for (const [key, view] of views) {
      if (!copies.has(key)) { view.scm.dispose(); views.delete(key); }
    }
    for (const [key, copy] of copies) {
      if (!views.has(key)) {
        const scm = vscode.scm.createSourceControl('codeSvn', 'SVN', vscode.Uri.file(copy.root));
        scm.inputBox.visible = false;
        views.set(key, { scm, groups: new Map(), changes: [], lastError: '' });
      }
      const view = views.get(key)!;
      if (copy.errors.length === 0) {
        view.lastError = '';
        showChanges(view, [...copy.changes.values()]);
        view.scm.statusBarCommands = [{
          command: 'codeSvn.refresh', title: `$(source-control) SVN：${view.changes.length} 项变更`,
          tooltip: `刷新 ${copy.root} 的打开目录范围内变更`
        }];
      } else {
        // A failed scope cannot yield a complete working-copy list. Preserve
        // prior items only while they remain inside the current opened scope.
        showChanges(view, view.changes.filter(change => copy.folders.some(folder => within(folder.uri.fsPath, change.path))));
        const detail = copy.errors.join('\n');
        view.scm.statusBarCommands = [{ command: 'codeSvn.showOutput', title: '$(error) SVN：查询失败（列表未更新）', tooltip: detail }];
        if (view.lastError !== detail) {
          view.lastError = detail;
          output.appendLine(`${new Date().toISOString()} ${detail}`);
          void vscode.window.showErrorMessage(
            `SVN 查询失败（${path.basename(copy.root)}），不能确认当前变更。请检查工作区环境的 SVN 安装与 codeSvn.svnPath 设置。`,
            '配置 SVN 路径', '查看日志'
          ).then(action => {
            if (action === '配置 SVN 路径') void vscode.commands.executeCommand('workbench.action.openSettings', 'codeSvn.svnPath');
            if (action === '查看日志') output.show();
          });
        }
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
      for (const watcher of watchers.values()) watcher.dispose();
      for (const view of views.values()) view.scm.dispose();
    } }
  );
  void refresh();
}
