import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  Change, PropertyChange, PropertyValue, readChanges, readDifference, readWorkingContent, WorkingCopyQueryError
} from './svn';

// Local and base content reach the diff editor through this scheme so a deleted
// side, a directory and an added item all have something honest to show.
const contentScheme = 'codeSvn';

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

function sideUri(target: string, side: 'base' | 'working' | 'properties'): vscode.Uri {
  return vscode.Uri.file(target).with({ scheme: contentScheme, query: side });
}

function propertyText(changes: PropertyChange[], target: string): string {
  const lines = [`SVN 属性差异：${target}`, ''];
  const value = (property: PropertyValue | undefined) => property === undefined ? ''
    : property.encoding === 'base64' ? `（Base64 编码属性：${property.value}）` : property.value;
  for (const change of changes) {
    if (change.before === undefined) lines.push(`新增属性 ${change.name} = ${value(change.after)}`);
    else if (change.after === undefined) lines.push(`删除属性 ${change.name}（原值：${value(change.before)}）`);
    else lines.push(`修改属性 ${change.name}：${value(change.before)} → ${value(change.after)}`);
  }
  if (changes.length === 0) lines.push('（没有属性变化）');
  return lines.join('\n');
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
      decorations: { tooltip: name, strikeThrough: ['deleted', 'missing'].includes(change.item) },
      command: { command: 'codeSvn.viewChange', title: '查看差异', arguments: [change] }
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
  const documents = new Map<string, string>();
  const documentChanges = new vscode.EventEmitter<vscode.Uri>();
  let knownRoots = new Map<string, string>();
  let disposed = false;
  let pending = false;
  let running: Promise<void> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  function openedFolders(): vscode.WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
  }

  function svnExecutable(folder: vscode.WorkspaceFolder): string {
    return vscode.workspace.getConfiguration('codeSvn', folder.uri).get<string>('svnPath', 'svn');
  }

  async function viewChange(change: Change): Promise<void> {
    const name = path.basename(change.path);
    const folder = openedFolders().find(candidate => within(candidate.uri.fsPath, change.path));
    if (!folder) {
      void vscode.window.showErrorMessage(`无法查看 ${name}：该路径不在当前打开的 SVN 管理范围内，请把所在目录加入工作区后重试。`);
      return;
    }
    const executable = svnExecutable(folder);
    try {
      // An unversioned file has no SVN text to compare. Showing its content as a
      // diff would claim a comparison SVN never made.
      if (change.item === 'unversioned') {
        const working = await readWorkingContent(change.path);
        if (working.binary) {
          void vscode.window.showWarningMessage(`${name}：未跟踪文件是二进制内容，没有可分析的文本。`);
          return;
        }
        if (working.symbolicLink) {
          const uri = sideUri(change.path, 'working');
          documents.set(uri.toString(), working.text ?? '');
          documentChanges.fire(uri);
          await vscode.window.showTextDocument(uri);
        } else {
          await vscode.window.showTextDocument(vscode.Uri.file(change.path));
        }
        void vscode.window.showInformationMessage(`${name}：未跟踪文件尚未加入 SVN，没有 SVN 差异可比较；已打开${working.symbolicLink ? '链接目标' : '本地文件内容'}。`);
        return;
      }
      const content = await readDifference(executable, folder.uri.fsPath, change);
      const properties = content.properties;
      for (const [side, text] of [
        ['base', content.base ?? ''], ['working', content.text ?? ''],
        ['properties', propertyText(properties, change.path)]
      ] as const) {
        const uri = sideUri(change.path, side);
        documents.set(uri.toString(), text);
        documentChanges.fire(uri);
      }
      if (properties.length > 0) await vscode.window.showTextDocument(sideUri(change.path, 'properties'), { preview: false });
      if (content.binary) {
        void vscode.window.showWarningMessage(`${name}：${label(change)}，但 SVN 没有提供文本差异，二进制内容不可分析，本次没有分析文件内容。`);
        return;
      }
      if (content.base === undefined && content.text === undefined) {
        void vscode.window.showInformationMessage(`${name}：该 SVN 条目没有文本内容差异可展示，请查看其 SVN 属性变化。`);
        return;
      }
      if (content.base === content.text) {
        if (properties.length === 0) {
          void vscode.window.showInformationMessage(`${name}：${label(change)}，没有可展示的文本内容差异。`);
        }
        return;
      }
      await vscode.commands.executeCommand('vscode.diff', sideUri(change.path, 'base'),
        sideUri(change.path, 'working'), `${name}（${label(change)} · SVN 本地差异）`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      output.appendLine(`${new Date().toISOString()} 查看差异失败 ${change.path}\n${detail}`);
      void vscode.window.showErrorMessage(
        `查看 ${name} 的差异失败：${detail}请检查工作区环境的 SVN 安装与 codeSvn.svnPath 设置。`, '查看日志'
      ).then(action => { if (action === '查看日志') output.show(); });
    }
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

  function content(uri: vscode.Uri): string {
    const target = uri.fsPath;
    const folder = openedFolders().find(candidate => within(candidate.uri.fsPath, target));
    if (!folder) throw new Error(`${target} 不在当前打开的 SVN 管理范围内，无法读取内容。`);
    const text = documents.get(uri.toString());
    if (text === undefined) throw new Error('差异内容已关闭，请从 SVN 变更列表重新打开。');
    return text;
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
    documentChanges,
    vscode.commands.registerCommand('codeSvn.refresh', refresh),
    vscode.commands.registerCommand('codeSvn.showOutput', () => output.show()),
    vscode.commands.registerCommand('codeSvn.viewChange', (change: Change) => viewChange(change)),
    vscode.workspace.registerTextDocumentContentProvider(contentScheme, {
      onDidChange: documentChanges.event,
      provideTextDocumentContent: content
    }),
    vscode.workspace.onDidCloseTextDocument(document => { documents.delete(document.uri.toString()); }),
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
