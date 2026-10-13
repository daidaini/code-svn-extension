import * as vscode from 'vscode';
import * as path from 'node:path';
import { CommitSelection, WorkingCopyWrites, deletedTreeRoot, pathKey, within } from './commit-selection';
import {
  Change, PropertyChange, PropertyValue, addPath, commitFiles, readChanges, readDifference, readWorkingContent, revertChanges, WorkingCopyQueryError
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
  if (change.item === 'deleted' && change.kind === 'dir') return '已删除（整个目录）';
  if (change.item === 'added' && change.copied) return change.movedFrom ? '已移动' : '已复制';
  const text = labels[change.item] ?? `SVN 状态：${change.item}`;
  return change.props === 'modified' ? `${text}（含属性）` : text;
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
  ancestors: Change[];
  lastError: string;
  selected: CommitSelection;
}

interface WorkingCopyResult {
  root: string;
  folders: vscode.WorkspaceFolder[];
  changes: Map<string, Change>;
  ancestors: Map<string, Change>;
  errors: string[];
}

function showChanges(view: WorkingCopyView, changes: Change[]): void {
  view.selected.reconcile([...view.ancestors, ...changes]);
  const byLabel = new Map<string, vscode.SourceControlResourceState[]>();
  for (const change of changes) {
    // Children of a scheduled-deletion directory are affected items of that one
    // operation, shown for review even when the directory itself is selected.
    const root = change.item === 'deleted' ? deletedTreeRoot(change.path, changes) : undefined;
    const base = root ? '已删除子项' : label(change);
    const text = view.selected.has(change.path) ? '待提交' : view.selected.isDependency(change.path) ? '必需提交依赖' : base;
    const notes: string[] = [];
    if (view.selected.isDependency(change.path)) notes.push('必需提交依赖（随选定子项一起提交）');
    if (root) notes.push(`随整个目录删除（${path.relative(view.scm.rootUri!.fsPath, root.path) || path.basename(root.path)}）一起提交`);
    if (!root && change.item === 'deleted' && change.kind === 'dir') {
      const count = changes.filter(other => other !== change && other.item === 'deleted' && within(change.path, other.path)).length;
      notes.push(count > 0 ? `含 ${count} 个受影响子项` : '整个子树没有其他受影响子项');
    }
    if (change.item === 'added' && change.copied) {
      if (change.movedFrom) notes.push(`自 ${path.relative(view.scm.rootUri!.fsPath, change.movedFrom) || path.basename(change.movedFrom)}`);
      else if (change.copiedFrom) notes.push(`自 ^${change.copiedFrom.repoPath}`);
      if (change.kind === 'dir') notes.push('整个复制子树随目录一起提交');
    }
    if (change.item === 'deleted' && change.movedTo) {
      notes.push(`已移动到 ${path.relative(view.scm.rootUri!.fsPath, change.movedTo) || path.basename(change.movedTo)}（随目标一起提交）`);
    }
    const states = byLabel.get(text) ?? [];
    states.push({
      resourceUri: vscode.Uri.file(change.path),
      decorations: { tooltip: [base, ...notes].join(' · '), strikeThrough: ['deleted', 'missing'].includes(change.item) },
      command: { command: 'codeSvn.viewChange', title: '查看差异', arguments: [change] }
    });
    byLabel.set(text, states);
  }
  for (const [name, states] of byLabel) {
    if (!view.groups.has(name)) {
      const group = view.scm.createResourceGroup(name === '待提交' ? 'selected' : name === '必需提交依赖' ? 'dependencies' : name, name);
      group.hideWhenEmpty = true;
      view.groups.set(name, group);
    }
    view.groups.get(name)!.resourceStates = states;
  }
  for (const [name, group] of view.groups) if (!byLabel.has(name)) group.resourceStates = [];
  view.changes = changes;
  view.scm.count = changes.length;
  view.scm.inputBox.placeholder = `提交信息（${view.selected.size} 项待提交，含必需依赖，按完整文件提交）`;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Code SVN');
  const views = new Map<string, WorkingCopyView>();
  const watchers = new Map<string, vscode.FileSystemWatcher>();
  const documents = new Map<string, string>();
  const documentChanges = new vscode.EventEmitter<vscode.Uri>();
  const writes = new WorkingCopyWrites();
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

  async function chooseChange(remove: boolean, resource?: vscode.SourceControlResourceState): Promise<void> {
    try {
      await refresh();
      const choices = [...views.values()].flatMap(view => {
        const paths = remove ? view.selected.explicitTargets : view.changes
          // Never offer the misleading per-child splitting of a whole-tree
          // deletion, or the source side of a recorded move.
          .filter(change => !view.selected.has(change.path)
            && !(change.item === 'deleted' && (deletedTreeRoot(change.path, view.changes) || change.movedTo)))
          .map(change => change.path);
        return paths.map(target => ({ label: path.basename(target), description: `${view.scm.rootUri!.fsPath} · ${path.relative(view.scm.rootUri!.fsPath, target)}`, view, target }));
      });
      const choice = resource?.resourceUri
        ? choices.find(item => pathKey(item.target) === pathKey(resource.resourceUri.fsPath))
        : await vscode.window.showQuickPick(choices, { placeHolder: remove ? '选择要移出待提交的文件' : '选择要加入待提交的完整文件' });
      if (!choice) {
        // Excluded items are not choices: a resource-row click on one must
        // guide to the operation that owns it instead of failing silently or
        // pretending it is a separate commit.
        if (!remove && resource?.resourceUri) {
          for (const view of views.values()) {
            const change = view.changes.find(item => pathKey(item.path) === pathKey(resource.resourceUri.fsPath));
            if (!change || change.item !== 'deleted') continue;
            const dir = deletedTreeRoot(change.path, view.changes) ?? (change.kind === 'dir' ? change : undefined);
            const movedTo = dir?.movedTo ?? change.movedTo;
            if (movedTo) {
              const target = view.changes.find(item => pathKey(item.path) === pathKey(movedTo));
              const shown = target
                ? path.relative(view.scm.rootUri!.fsPath, target.path) || path.basename(target.path)
                : path.relative(view.scm.rootUri!.fsPath, movedTo) || path.basename(movedTo);
              throw new Error(`${path.basename(change.path)} 已记录移动到 ${shown}，请选择移动后的目标提交这次移动；源会作为必需提交依赖一起提交。`);
            }
            if (dir) {
              throw new Error(`${path.basename(change.path)} 随整个目录删除，不能单独提交受影响子项；请选择目录 ${path.relative(view.scm.rootUri!.fsPath, dir.path) || path.basename(dir.path)} 本身，以整个子树为一次操作提交。`);
            }
          }
        }
        return;
      }
      const key = pathKey(choice.view.scm.rootUri!.fsPath);
      if (views.get(key) !== choice.view) throw new Error('工作副本或管理范围已变化，请重新选择。');
      if (writes.isBusy(key)) throw new Error('该工作副本正在执行写操作，请等待完成。');
      if (remove) choice.view.selected.remove(choice.target);
      else {
        const change = choice.view.changes.find(change => pathKey(change.path) === pathKey(choice.target));
        if (!change) throw new Error('变更状态或管理范围已变化，请刷新后重新选择。');
        await choice.view.selected.add(change, openedFolders().map(folder => folder.uri.fsPath));
      }
      showChanges(choice.view, choice.view.changes);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function add(resource?: vscode.SourceControlResourceState): Promise<void> {
    let release: (() => void) | undefined;
    try {
      await refresh();
      const choices = [...views.entries()].flatMap(([key, view]) => view.changes
        .filter(change => change.item === 'unversioned')
        .map(change => ({ label: path.basename(change.path), description: change.path, key, view, change })));
      const choice = resource?.resourceUri
        ? choices.find(item => pathKey(item.change.path) === pathKey(resource.resourceUri.fsPath))
        : await vscode.window.showQuickPick(choices, { placeHolder: '选择要添加到 SVN 的文件或目录（目录仅添加自身）' });
      if (!choice) return;
      release = writes.tryAcquire(choice.key);
      if (!release) throw new Error('该工作副本正在执行写操作，请等待完成。');
      await refresh();
      const folder = openedFolders().find(folder => within(folder.uri.fsPath, choice.change.path));
      if (!folder || views.get(choice.key) !== choice.view || choice.view.lastError
        || !choice.view.changes.some(change => pathKey(change.path) === pathKey(choice.change.path) && change.item === 'unversioned')) {
        throw new Error('变更状态或管理范围已变化，请刷新后重新添加。');
      }
      await choice.view.selected.validateAddition(choice.change, openedFolders().map(folder => folder.uri.fsPath));
      await addPath(svnExecutable(folder), choice.view.scm.rootUri!.fsPath, choice.change.path);
      await refresh();
      if (views.get(choice.key) !== choice.view || choice.view.lastError) throw new Error('SVN 添加已执行，但刷新失败，请核对状态后继续。');
      void vscode.window.showInformationMessage(`${path.basename(choice.change.path)} 已添加到 SVN，尚未加入待提交；请审阅后明确选择。`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      output.appendLine(`${new Date().toISOString()} 添加失败\n${detail}`);
      void vscode.window.showErrorMessage(`添加失败：${detail} 选择与提交信息已保留。`);
    } finally { release?.(); }
  }

  async function revert(resource?: vscode.SourceControlResourceState): Promise<void> {
    let release: (() => void) | undefined;
    let changedView: WorkingCopyView | undefined;
    let attempted: Change[] = [];
    try {
      await refresh();
      const choices = [...views.entries()].flatMap(([key, view]) => view.changes
        .filter(change => change.item !== 'unversioned' && !deletedTreeRoot(change.path, view.changes))
        .map(change => ({ label: path.basename(change.path), description: change.path, key, view, change })));
      const choice = resource?.resourceUri
        ? choices.find(item => pathKey(item.change.path) === pathKey(resource.resourceUri.fsPath))
        : await vscode.window.showQuickPick(choices, { placeHolder: '选择要撤销本地变更的文件或目录' });
      if (!choice) return;
      release = writes.tryAcquire(choice.key);
      if (!release) throw new Error('该工作副本正在执行写操作，请等待完成。');
      const plan = async () => {
        await refresh();
        const scopes = openedFolders().map(folder => folder.uri.fsPath);
        if (views.get(choice.key) !== choice.view || choice.view.lastError
          || !scopes.some(scope => within(scope, choice.change.path))) {
          throw new Error('工作副本状态或管理范围已变化，请刷新后重新选择。');
        }
        const changes = choice.view.changes.filter(change => within(choice.change.path, change.path) && change.item !== 'unversioned');
        if (!changes.some(change => pathKey(change.path) === pathKey(choice.change.path))) {
          throw new Error('变更状态已变化，请刷新后重新选择。');
        }
        for (const change of changes) {
          if (change.conflicted || !['modified', 'normal', 'none', 'added', 'deleted', 'missing', 'replaced'].includes(change.item)) {
            throw new Error(`${change.path} 的当前状态不支持安全撤销，请先处理冲突或路径阻塞。`);
          }
          if ([change.movedFrom, change.movedTo].some(target => target && !changes.some(item => pathKey(item.path) === pathKey(target)))) {
            throw new Error('撤销范围不包含移动的两端，请选择包含源和目标的目录；不会操作范围外对象。');
          }
        }
        return changes;
      };
      const changes = await plan();
      const dirty = () => vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file'
        && document.isDirty && within(choice.change.path, document.uri.fsPath));
      if (dirty()) throw new Error('撤销范围内有未保存内容，请先保存或自行处理；未执行撤销。');
      const action = await vscode.window.showWarningMessage('撤销将丢弃以下本地修改，无法恢复。', {
        modal: true,
        detail: `${choice.change.path}\n目录操作包含下列子项（仅撤销列出的变更）：\n${changes.map(change => `${label(change)}：${change.path}`).join('\n')}\n未跟踪文件不会删除，取消添加保留本地文件。`
      }, '撤销这些修改');
      if (action !== '撤销这些修改') return;
      const current = await plan();
      if (JSON.stringify(current) !== JSON.stringify(changes)) throw new Error('撤销范围或状态已变化，请重新审阅并确认。');
      if (dirty()) throw new Error('撤销范围内有未保存内容，请先保存或自行处理；未执行撤销。');
      const folder = openedFolders().find(folder => within(folder.uri.fsPath, choice.change.path))!;
      changedView = choice.view;
      attempted = current;
      await revertChanges(svnExecutable(folder), choice.view.scm.rootUri!.fsPath, current);
      await refresh();
      if (views.get(choice.key) !== choice.view || choice.view.lastError) throw new Error('SVN 撤销已执行，但刷新失败，请核对实际状态，勿盲目重试。');
      choice.view.selected.complete(current.map(change => change.path));
      showChanges(choice.view, choice.view.changes);
      void vscode.window.showInformationMessage(`撤销完成：${current.length} 项变更。取消添加的本地文件已保留。`);
    } catch (error) {
      // SVN may have reverted only some targets before failing. Reconcile only
      // confirmed clean/untracked targets, keeping failed selections and input.
      if (changedView) {
        await refresh();
        if (!changedView.lastError) {
          changedView.selected.complete(attempted.filter(change => {
            const current = changedView!.changes.find(item => pathKey(item.path) === pathKey(change.path));
            return !current || current.item === 'unversioned';
          }).map(change => change.path));
          showChanges(changedView, changedView.changes);
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      output.appendLine(`${new Date().toISOString()} 撤销失败\n${detail}`);
      void vscode.window.showErrorMessage(`撤销失败：${detail} 请核对实际状态；提交信息已保留。`);
    } finally { release?.(); }
  }

  async function commit(sourceControl?: vscode.SourceControl): Promise<void> {
    const candidates = [...views.entries()];
    const candidate = sourceControl ? candidates.find(([, view]) => view.scm === sourceControl)
      : candidates.length === 1 ? candidates[0]
        : (await vscode.window.showQuickPick(candidates.map(([key, view]) => ({
          label: view.scm.rootUri!.fsPath, description: `${view.selected.size} 项待提交`, key, view
        })), { placeHolder: '选择要提交的工作副本' }));
    if (!candidate) return;
    const [key, view] = Array.isArray(candidate) ? candidate : [candidate.key, candidate.view];
    if (writes.isBusy(key)) {
      void vscode.window.showWarningMessage('该工作副本正在执行写操作，请等待完成；不会重复提交。');
      return;
    }
    const targets = view.selected.targets;
    if (targets.length === 0) { void vscode.window.showWarningMessage('没有待提交文件，请先加入待提交。'); return; }
    const message = view.scm.inputBox.value;
    if (!message.trim()) { void vscode.window.showWarningMessage('请输入提交信息。'); return; }
    const release = writes.tryAcquire(key);
    if (!release) return;
    try {
      const validate = async () => {
        await refresh();
        if (views.get(key) !== view || view.lastError) throw new Error('无法确认工作副本当前状态，请刷新并检查查询日志。');
        await view.selected.validate(targets, [...view.ancestors, ...view.changes], openedFolders().map(folder => folder.uri.fsPath));
      };
      await validate();
      const dirty = () => vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file'
        && document.isDirty && targets.some(target => pathKey(target) === pathKey(document.uri.fsPath)));
      if (dirty().length > 0) {
        const action = await vscode.window.showWarningMessage('选中文件有未保存内容。保存后再提交？', { modal: true }, '保存并提交');
        if (action !== '保存并提交') return;
        for (const document of dirty()) if (!await document.save()) throw new Error(`无法保存 ${document.uri.fsPath}，提交已停止。`);
        await validate();
        if (dirty().length > 0) throw new Error('选中文件仍有未保存内容，提交已停止。');
      }
      const folder = openedFolders().find(folder => within(folder.uri.fsPath, targets[0]))!;
      const revision = await commitFiles(svnExecutable(folder), view.scm.rootUri!.fsPath, targets, message);
      await refresh();
      if (views.get(key) !== view || view.lastError) throw new Error(`SVN 已产生修订 ${revision}，但刷新失败。请核对仓库结果，勿重复提交。`);
      view.selected.complete(targets);
      if (view.scm.inputBox.value === message) view.scm.inputBox.value = '';
      showChanges(view, view.changes);
      void vscode.window.showInformationMessage(`SVN 提交成功：修订 ${revision}，${targets.length} 项变更（含必需提交依赖）。`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      output.appendLine(`${new Date().toISOString()} 提交失败\n${detail}`);
      const guidance = detail.startsWith('SVN 提交失败') ? '请在工作区所在环境的终端配置 SVN 路径、认证或证书信任，再手动操作。' : '';
      void vscode.window.showErrorMessage(`${detail} 选择与提交信息已保留。${guidance}`, '查看日志')
        .then(action => { if (action === '查看日志') output.show(); });
    } finally { release(); }
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
      // A scheduled-deletion directory has no text or property comparison to
      // show; its subtree scope is presented by the change list.
      if (change.item === 'deleted' && change.kind === 'dir') {
        void vscode.window.showInformationMessage(`${name}：整个目录删除。受影响子项以「已删除子项」展示，随目录一起提交。`);
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
      if (!copies.has(key)) copies.set(key, { root, folders: [], changes: new Map(), ancestors: new Map(), errors: [] });
      const copy = copies.get(key)!;
      copy.folders.push(folder);
      if (result.status === 'fulfilled') {
        for (const change of result.value!.changes) copy.changes.set(pathKey(change.path), change);
        for (const ancestor of result.value!.ancestors) copy.ancestors.set(pathKey(ancestor.path), ancestor);
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
        scm.inputBox.visible = true;
        scm.acceptInputCommand = { command: 'codeSvn.commit', title: '提交待提交文件', arguments: [scm] };
        views.set(key, { scm, groups: new Map(), changes: [], ancestors: [], lastError: '', selected: new CommitSelection(copy.root) });
      }
      const view = views.get(key)!;
      if (copy.errors.length === 0) {
        view.lastError = '';
        view.ancestors = [...copy.ancestors.values()];
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
    vscode.commands.registerCommand('codeSvn.select', (resource?: vscode.SourceControlResourceState) => chooseChange(false, resource)),
    vscode.commands.registerCommand('codeSvn.unselect', (resource?: vscode.SourceControlResourceState) => chooseChange(true, resource)),
    vscode.commands.registerCommand('codeSvn.add', add),
    vscode.commands.registerCommand('codeSvn.revert', revert),
    vscode.commands.registerCommand('codeSvn.commit', commit),
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
