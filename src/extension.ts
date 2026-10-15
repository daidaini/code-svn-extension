import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { CommitSelection, WorkingCopyWrites, deletedTreeRoot, pathKey, within } from './commit-selection';
import {
  AiCancelled, DraftInput, AiSettings, apiKeySecret, assertInputWithinLimit, collectDraftInput, draftBasis, configurationProblems, requestDraft
} from './ai';
import {
  Change, ChangeContent, changeLabel as label, HistoryEntry, ObjectLocation, PropertyChange, PropertyValue, QueryCancelled, RevisionPath, addPath, commitFiles, historyBatchSize,
  readChanges, readDifference, readFileRevisionDifference, readHistoryBatch, readObjectLocation, readRevisionDifference, readRevisionPaths, readWorkingContent,
  revertChanges, updateScopes, WorkingCopyQueryError
} from './svn';
import { ReviewSelection, runReview } from './review';
import { ReviewEntry, ReviewResults } from './review-ui';

// Local and base content reach the diff editor through this scheme so a deleted
// side, a directory and an added item all have something honest to show.
const contentScheme = 'codeSvn';
// Historical sides are read-only documents keyed by revision, outside any working copy.
const revisionScheme = 'codeSvnRevision';

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

interface HistoryItem extends vscode.QuickPickItem {
  loadMore?: boolean;
  revision?: number;
}

interface RevisionItem extends vscode.QuickPickItem {
  change: RevisionPath;
}

const revisionActions: Record<string, string> = { A: '已添加', D: '已删除', M: '已修改', R: '已替换' };

function revisionLabel(change: RevisionPath): string {
  const text = revisionActions[change.action] ?? `SVN 变更：${change.action}`;
  return `${text}${change.kind === 'dir' ? '（目录）' : ''}${change.propertyModified ? '（含属性）' : ''}`;
}

// Each failure names its own remedy. None of them may read as an empty history.
function historyFailure(detail: string): string {
  if (/E170001|E215004|authentication/i.test(detail)) return '认证失败：请在工作区所在环境的终端完成 SVN 登录后重试。';
  if (/E230001|certificate/i.test(detail)) return '证书校验失败：请在同一环境的终端确认并信任服务器证书后重试；插件不会忽略证书错误。';
  if (/E170013|E175002|Unable to connect|Connection refused/i.test(detail)) return '无法连接服务器：请检查网络、代理及仓库地址后重试。';
  if (/W155010|E155007|E155010|E200009/.test(detail)) return '该对象不在 SVN 版本控制中，没有可查询的历史。';
  if (/E160013/.test(detail)) return '服务器 HEAD 上找不到该路径：可能尚未提交，或本地工作副本落后且路径已被移动或删除，请更新后重试。';
  return '请检查 codeSvn.svnPath 设置及查询日志。';
}

function formatDate(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString('zh-CN', { hour12: false });
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
  const conflictGroups = new Set<string>();
  for (const change of changes) {
    // Children of a scheduled-deletion directory are affected items of that one
    // operation, shown for review even when the directory itself is selected.
    const root = change.item === 'deleted' ? deletedTreeRoot(change.path, changes) : undefined;
    const base = root ? '已删除子项' : label(change);
    const text = view.selected.has(change.path) ? '待提交' : view.selected.isDependency(change.path) ? '必需提交依赖' : base;
    if (change.conflicted) conflictGroups.add(text);
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
      decorations: {
        tooltip: [base, ...notes].join(' · '), strikeThrough: ['deleted', 'missing'].includes(change.item),
        iconPath: change.conflicted ? new vscode.ThemeIcon('warning') : undefined
      },
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
    const group = view.groups.get(name)!;
    group.label = conflictGroups.has(name) && ['待提交', '必需提交依赖'].includes(name) ? `${name}（含冲突）` : name;
    group.resourceStates = states;
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
  const drafts = new Map<string, AbortController>();
  const reviewEntries = new Map<string, ReviewEntry>();
  const reviewRuns = new Map<string, { controller: AbortController; done: Promise<void>; finish: () => void; invalidReason?: string }>();
  let nextReviewId = 1;
  // The input a filled draft was generated from, per working copy. `stale` makes the warning
  // fire only on the transition; `queue` serialises checks.
  interface DraftRecord { basis: string; stale: boolean; queue: Promise<unknown> }
  const filledDrafts = new Map<string, DraftRecord>();
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

  function aiSettings(): AiSettings {
    const config = vscode.workspace.getConfiguration('codeSvn');
    return {
      baseUrl: config.get<string>('ai.baseUrl', ''),
      model: config.get<string>('ai.model', ''),
      timeoutSeconds: config.get<number>('ai.timeoutSeconds', 60)
    };
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
      const reviewRun = reviewRuns.get(key);
      if (reviewRun) {
        reviewRun.invalidReason = '提交选择已变化。';
        reviewRun.controller.abort();
        await reviewRun.done;
      }
      if (writes.isBusy(key)) throw new Error('该工作副本正在执行写操作，请等待完成。');
      if (remove) choice.view.selected.remove(choice.target);
      else {
        const change = choice.view.changes.find(change => pathKey(change.path) === pathKey(choice.target));
        if (!change) throw new Error('变更状态或管理范围已变化，请刷新后重新选择。');
        await choice.view.selected.add(change, openedFolders().map(folder => folder.uri.fsPath));
      }
      showChanges(choice.view, choice.view.changes);
      reassessDrafts();
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

  async function update(sourceControl?: vscode.SourceControl): Promise<void> {
    let release: (() => void) | undefined;
    try {
      await refresh();
      const candidates = [...views.entries()];
      const candidate = sourceControl ? candidates.find(([, view]) => view.scm === sourceControl)
        : candidates.length === 1 ? candidates[0]
          : await vscode.window.showQuickPick(candidates.map(([key, view]) => ({
            label: view.scm.rootUri!.fsPath, description: '更新该工作副本的打开目录范围', key, view
          })), { placeHolder: '选择要更新的工作副本（仅更新打开目录）' });
      if (!candidate) return;
      const [key, view] = Array.isArray(candidate) ? candidate : [candidate.key, candidate.view];
      release = writes.tryAcquire(key);
      if (!release) throw new Error('该工作副本正在执行写操作，请等待完成。');
      await refresh();
      if (views.get(key) !== view || view.lastError) throw new Error('无法确认工作副本当前状态，请刷新并检查查询日志。');
      const folders = [...new Map(openedFolders()
        .filter(folder => pathKey(knownRoots.get(folder.uri.toString()) ?? '') === key)
        .map(folder => [pathKey(folder.uri.fsPath), folder])).values()];
      const scopes = folders.filter(folder => !folders.some(other => other !== folder && within(other.uri.fsPath, folder.uri.fsPath)));
      if (scopes.length === 0) throw new Error('管理范围已变化，请重新选择。');
      if (vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' && document.isDirty
        && scopes.some(folder => within(folder.uri.fsPath, document.uri.fsPath)))) {
        throw new Error('更新范围内有未保存内容，请先保存或自行处理；未执行更新。');
      }
      try {
        const result = await updateScopes(svnExecutable(scopes[0]), view.scm.rootUri!.fsPath, scopes.map(folder => folder.uri.fsPath));
        output.appendLine(`${new Date().toISOString()} 更新 ${view.scm.rootUri!.fsPath}\n${result}`);
      } finally {
        // A failed update may already have applied some incoming changes.
        await refresh();
        if (views.get(key) === view && !view.lastError) {
          const currentScopes = openedFolders().filter(folder => pathKey(knownRoots.get(folder.uri.toString()) ?? '') === key);
          const clean = view.selected.explicitTargets.filter(target => currentScopes.some(folder => within(folder.uri.fsPath, target))
            && !view.changes.some(change => pathKey(change.path) === pathKey(target)));
          view.selected.complete(clean);
          showChanges(view, view.changes);
        }
      }
      if (views.get(key) !== view || view.lastError) throw new Error('SVN 更新已执行，但刷新未能确认完整状态，请核对实际结果，勿盲目重试。');
      const conflicts = view.changes.filter(change => change.conflicted).length;
      if (conflicts > 0) {
        void vscode.window.showWarningMessage(`SVN 更新完成：管理范围内有 ${conflicts} 项冲突。请使用现有工具解决并标记后刷新；不会自动解决冲突或重试提交。`);
      } else {
        void vscode.window.showInformationMessage(`SVN 更新完成：已同步 ${scopes.length} 个打开目录范围，未更新未打开区域。`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      output.appendLine(`${new Date().toISOString()} 更新失败\n${detail}`);
      void vscode.window.showErrorMessage(`更新失败：${detail} 提交信息已保留；请核对实际状态。认证、证书或网络问题请在工作区环境中处理后手动操作。`, '查看日志')
        .then(action => { if (action === '查看日志') output.show(); });
    } finally { release?.(); }
  }

  // A draft is stale when the commit it describes no longer matches what the model saw:
  // selection, file content, properties, or unsaved edits to a selected file. A check that
  // fails cannot confirm the basis, so it counts as stale too.
  function unsavedTargets(targets: string[]): boolean {
    return vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file'
      && document.isDirty && targets.some(target => pathKey(target) === pathKey(document.uri.fsPath)));
  }

  async function checkDraft(key: string, record: DraftRecord): Promise<boolean> {
    const view = views.get(key);
    if (!view) { filledDrafts.delete(key); return false; }
    const targets = view.selected.targets;
    let stale = unsavedTargets(targets) || targets.length === 0 || view.lastError !== '';
    if (!stale) {
      const folder = openedFolders().find(candidate => within(candidate.uri.fsPath, targets[0]));
      const collected = folder
        ? await collectDraftInput(svnExecutable(folder), openedFolders().map(item => item.uri.fsPath), view.scm.rootUri!.fsPath, [...view.ancestors, ...view.changes], targets).catch(() => undefined)
        : undefined;
      stale = draftBasis(collected) !== record.basis;
    }
    if (filledDrafts.get(key) !== record) return false;
    // The first transition warns once; a return to the generated input clears the mark silently.
    if (stale && !record.stale) {
      record.stale = true;
      void vscode.window.showWarningMessage('AI 草稿已过期：提交选择或相关内容已变化，或无法确认。请重新生成草稿；若仍要使用，提交时需要明确确认。', '重新生成')
        .then(action => { if (action === '重新生成') void generate(view.scm); });
    } else if (!stale) {
      record.stale = false;
    }
    return stale;
  }

  // Checks for one draft run one after another, so an older verdict cannot overwrite a newer one.
  function assessDraft(key: string): Promise<boolean> {
    const record = filledDrafts.get(key);
    if (!record) return Promise.resolve(false);
    const verdict = record.queue.then(() => checkDraft(key, record));
    record.queue = verdict.catch(() => false);
    return verdict;
  }

  function reassessDrafts(): void {
    for (const key of filledDrafts.keys()) void assessDraft(key);
  }

  function isSelectedFile(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && [...views.values()].some(view => view.selected.targets.some(target => pathKey(target) === pathKey(uri.fsPath)));
  }

  // Typing in a selected file fires on every keystroke; one check after a pause is enough.
  let draftDebounce: ReturnType<typeof setTimeout> | undefined;
  function scheduleDraftCheck(): void {
    if (draftDebounce) clearTimeout(draftDebounce);
    draftDebounce = setTimeout(reassessDrafts, 300);
  }

  async function reviewSelectionFor(key: string, view: WorkingCopyView): Promise<ReviewSelection> {
    const scopes = openedFolders().filter(folder => pathKey(knownRoots.get(folder.uri.toString()) ?? '') === key)
      .map(folder => folder.uri.fsPath);
    if (!scopes.length) throw new Error('工作副本已不在当前打开的管理范围内。');
    const folders = openedFolders().filter(folder => scopes.some(scope => pathKey(scope) === pathKey(folder.uri.fsPath)));
    const executables = [...new Set(folders.map(svnExecutable))];
    if (executables.length !== 1) throw new Error('同一工作副本的打开目录配置了不同 SVN 可执行文件，请统一 codeSvn.svnPath 后重试。');
    const targets = view.selected.targets;
    return {
      executable: executables[0], scopes, root: view.scm.rootUri!.fsPath,
      explicit: view.selected.explicitTargets,
      targets,
      dependencies: targets.filter(target => view.selected.isDependency(target))
    };
  }

  function reviewFingerprint(settings: AiSettings, apiKey: string, prompt: string): string {
    return createHash('sha256').update(JSON.stringify({ settings, apiKey, prompt })).digest('hex');
  }

  async function reviewConfigurationMatches(entry: ReviewEntry): Promise<boolean> {
    if (!entry.configurationFingerprint) return false;
    try {
      const prompt = await fs.readFile(path.join(context.extensionPath, 'tools', 'review_prompt.md'), 'utf8');
      const apiKey = (await context.secrets.get(apiKeySecret))?.trim() ?? '';
      return reviewFingerprint(aiSettings(), apiKey, prompt) === entry.configurationFingerprint;
    } catch { return false; }
  }

  async function review(sourceControl?: vscode.SourceControl, commitAfter = false): Promise<void> {
    const candidates = [...views.entries()];
    const candidate = sourceControl ? candidates.find(([, view]) => view.scm === sourceControl)
      : candidates.length === 1 ? candidates[0]
        : await vscode.window.showQuickPick(candidates.map(([key, view]) => ({
          label: view.scm.rootUri!.fsPath, description: `${view.selected.size} 项待审查`, key, view
        })), { placeHolder: '选择要审查的工作副本' });
    if (!candidate) return;
    const [key, view] = Array.isArray(candidate) ? candidate : [candidate.key, candidate.view];
    const activeReview = reviewRuns.get(key);
    if (activeReview) {
      const action = await vscode.window.showWarningMessage('该工作副本正在审查；可等待完成，或取消当前审查。', '取消当前审查');
      if (action === '取消当前审查') activeReview.controller.abort();
      return;
    }
    if (drafts.has(key)) {
      void vscode.window.showWarningMessage('该工作副本正在生成 AI 草稿，请等待或取消草稿后重试；不会重复请求。');
      return;
    }
    const targets = view.selected.targets;
    if (!targets.length) { void vscode.window.showWarningMessage('没有待提交文件，请先加入待提交。'); return; }
    const commitMessage = view.scm.inputBox.value;
    const intent = commitMessage.trim();
    let selection: ReviewSelection;
    try {
      await refresh();
      if (views.get(key) !== view || view.lastError) throw new Error('无法确认工作副本当前状态，请刷新并检查查询日志。');
      selection = await reviewSelectionFor(key, view);
      await view.selected.validate(targets, [...view.ancestors, ...view.changes], selection.scopes);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); return;
    }
    const dirty = () => vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file'
      && document.isDirty && targets.some(target => pathKey(target) === pathKey(document.uri.fsPath)));
    try {
      if (dirty().length) {
        const action = await vscode.window.showWarningMessage('选中文件有未保存内容。保存后再审查？', { modal: true }, '保存并审查');
        if (action !== '保存并审查') return;
        for (const document of dirty()) if (!await document.save()) throw new Error(`无法保存 ${document.uri.fsPath}，审查已停止。`);
        await refresh();
        if (views.get(key) !== view || view.lastError) throw new Error('保存后无法确认工作副本状态，审查已停止。');
        selection = await reviewSelectionFor(key, view);
        await view.selected.validate(targets, [...view.ancestors, ...view.changes], selection.scopes);
        if (dirty().length) throw new Error('选中文件仍有未保存内容，审查已停止。');
      }
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); return;
    }
    const settings = aiSettings();
    const apiKey = (await context.secrets.get(apiKeySecret))?.trim() ?? '';
    const problems = configurationProblems(settings, apiKey);
    if (problems.length) { void vscode.window.showErrorMessage(`AI 配置不完整：${problems.join('；')}；未发送请求。`); return; }
    const promptPath = path.join(context.extensionPath, 'tools', 'review_prompt.md');
    let prompt: string;
    try { prompt = await fs.readFile(promptPath, 'utf8'); }
    catch { void vscode.window.showErrorMessage('找不到扩展内的 tools/review_prompt.md；未发送请求。'); return; }
    const promptHash = createHash('sha256').update(prompt).digest('hex');
    const fingerprint = reviewFingerprint(settings, apiKey, prompt);
    if (writes.isBusy(key)) { void vscode.window.showWarningMessage('该工作副本正在执行写操作，请等待完成。'); return; }
    const release = writes.tryAcquire(key);
    if (!release) return;
    try {
      await refresh();
      if (views.get(key) !== view || view.lastError) throw new Error('无法确认工作副本当前状态，请刷新并检查查询日志。');
      const current = await reviewSelectionFor(key, view);
      await view.selected.validate(targets, [...view.ancestors, ...view.changes], current.scopes);
      const currentPrompt = await fs.readFile(promptPath, 'utf8');
      const currentApiKey = (await context.secrets.get(apiKeySecret))?.trim() ?? '';
      if (JSON.stringify(current) !== JSON.stringify(selection) || dirty().length
        || view.scm.inputBox.value !== commitMessage
        || reviewFingerprint(aiSettings(), currentApiKey, currentPrompt) !== fingerprint) {
        throw new Error('审查准备期间提交选择、管理范围或选定文件内容已变化，请重新开始审查。');
      }
    } catch (error) {
      release();
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); return;
    }
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    reviewRuns.set(key, { controller, done, finish });
    for (const old of reviewEntries.values()) if (old.key === key) old.status = 'replaced';
    const entry: ReviewEntry = {
      id: nextReviewId++, key, root: view.scm.rootUri!.fsPath, status: 'running',
      model: settings.model, commitMessage, intent, configurationFingerprint: fingerprint
    };
    reviewEntries.set(key, entry); reviewUI.refresh(entry);
    try {
      const session = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: '正在审查 SVN 待提交内容…', cancellable: true
      }, (_progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        return runReview({ selection, settings, apiKey, prompt, intent }, controller.signal);
      });
      entry.session = session; entry.result = session.result; entry.status = session.result.status;
      const currentSelection = await reviewSelectionFor(key, view).catch(() => undefined);
      if (controller.signal.aborted) {
        const reason = reviewRuns.get(key)?.invalidReason;
        entry.status = reason ? 'stale' : 'cancelled';
        if (reason) entry.staleReason = reason;
      }
      else if (['clean', 'findings', 'incomplete'].includes(entry.status)
        && (views.get(key) !== view || view.lastError || view.scm.inputBox.value !== commitMessage
        || unsavedTargets(targets) || !currentSelection || !await session.isCurrent(currentSelection)
        || reviewFingerprint(aiSettings(), (await context.secrets.get(apiKeySecret))?.trim() ?? '', prompt) !== fingerprint
        || createHash('sha256').update(await fs.readFile(promptPath, 'utf8').catch(() => '')).digest('hex') !== promptHash)) {
        entry.status = 'stale'; entry.staleReason = '提交选择、内容、提交信息、管理范围或审查提示词已变化。';
      }
    } catch (error) {
      const reason = reviewRuns.get(key)?.invalidReason;
      entry.status = reason ? 'stale' : controller.signal.aborted ? 'cancelled' : 'error';
      if (reason) entry.staleReason = reason;
      entry.result = { status: 'error', findings: [], requests: 0,
        coverage: { root: entry.root, scope: selection.scopes[0], scopes: selection.scopes, selected: [], files: [] },
        error: error instanceof Error ? error.message : String(error) };
    } finally {
      reviewRuns.delete(key); release(); finish();
    }
    if (disposed) return;
    reviewUI.refresh(entry);
    await reviewUI.show(entry);
    if (disposed) return;
    if (entry.status === 'cancelled') { void vscode.window.showInformationMessage('审查已取消；没有执行提交。'); return; }
    if (entry.status === 'clean') void vscode.window.showInformationMessage('已提供范围内未发现符合要求的问题。');
    else if (entry.status === 'findings') void vscode.window.showWarningMessage(`审查发现 ${entry.result?.findings.length ?? 0} 个问题，请查看审查结果。`);
    else if (entry.status === 'incomplete') void vscode.window.showWarningMessage('审查不完整，请查看审查结果。');
    else if (entry.status === 'stale') void vscode.window.showWarningMessage('审查依据已变化，结果已过期；请重新审查。');
    else if (entry.status === 'error') void vscode.window.showErrorMessage(`审查失败：${entry.result?.error ?? '未知错误'}`);
    if (!commitAfter) return;
    if (entry.status !== 'clean' && entry.status !== 'findings' && entry.status !== 'incomplete') {
      void vscode.window.showWarningMessage('审查未产生可确认的有效结果，请查看审查报告并重新审查。'); return;
    }
    await confirmReviewCommit(key, entry.id);
  }

  const reviewUI = new ReviewResults(
    () => reviewEntries.values(),
    key => { const view = views.get(key); if (view) void review(view.scm); },
    (key, id) => { const entry = reviewEntries.get(key); if (entry?.id === id) void confirmReviewCommit(key, id); }
  );

  async function confirmReviewCommit(key: string, id: number): Promise<void> {
    const entry = reviewEntries.get(key);
    const view = views.get(key);
    if (!entry || entry.id !== id || !view || !entry.session
      || !['clean', 'findings', 'incomplete'].includes(entry.status)) return;
    const action = entry.status === 'clean'
      ? await vscode.window.showWarningMessage('审查未发现符合要求的问题。确认提交本次选择？', { modal: true }, '确认提交')
      : await vscode.window.showWarningMessage(entry.status === 'findings'
        ? `审查发现 ${entry.result?.findings.length ?? 0} 个问题。仍要提交吗？`
        : `审查不完整${entry.result?.findings.length ? `，并发现 ${entry.result.findings.length} 个问题` : ''}。仍要提交吗？`,
      { modal: true }, entry.status === 'findings' ? '仍然提交（有审查问题）' : '仍然提交（审查未完成）');
    if ((entry.status === 'clean' && action === '确认提交')
      || (entry.status === 'findings' && action === '仍然提交（有审查问题）')
      || (entry.status === 'incomplete' && action === '仍然提交（审查未完成）')) {
      let message: string | undefined;
      if (!view.scm.inputBox.value.trim()) {
        message = await vscode.window.showInputBox({
          title: 'SVN 提交信息', prompt: '审查不要求提交信息；提交前请输入提交信息。', ignoreFocusOut: true
        });
        if (!message?.trim()) return;
      }
      await commit(view.scm, entry, message);
    }
  }

  function invalidateCompletedReviews(reason: string): void {
    for (const run of reviewRuns.values()) { run.invalidReason = reason; run.controller.abort(); }
    for (const entry of reviewEntries.values()) {
      if (entry.status === 'running') { entry.staleReason = reason; continue; }
      if (!['clean', 'findings', 'incomplete'].includes(entry.status)) continue;
      entry.status = 'stale'; entry.staleReason = reason;
      reviewUI.refresh(entry);
    }
  }

  async function commit(sourceControl?: vscode.SourceControl, reviewed?: ReviewEntry, messageOverride?: string): Promise<void> {
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
    const message = messageOverride ?? view.scm.inputBox.value;
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
      if (reviewed) {
        const current = reviewEntries.get(key);
        if (current !== reviewed || !['clean', 'findings', 'incomplete'].includes(reviewed.status) || !reviewed.session
          || view.scm.inputBox.value !== reviewed.commitMessage
          || !await reviewConfigurationMatches(reviewed)) {
          reviewed.status = 'stale'; reviewed.staleReason = '审查结果、提交选择或提交信息已变化。';
          reviewUI.refresh(reviewed);
          throw new Error('审查依据已变化，请重新审查后再提交。');
        }
      }
      const dirty = () => vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file'
        && document.isDirty && targets.some(target => pathKey(target) === pathKey(document.uri.fsPath)));
      if (dirty().length > 0) {
        const action = await vscode.window.showWarningMessage('选中文件有未保存内容。保存后再提交？', { modal: true }, '保存并提交');
        if (action !== '保存并提交') return;
        for (const document of dirty()) if (!await document.save()) throw new Error(`无法保存 ${document.uri.fsPath}，提交已停止。`);
        await validate();
        if (dirty().length > 0) throw new Error('选中文件仍有未保存内容，提交已停止。');
      }
      if (await assessDraft(key)) {
        const action = await vscode.window.showWarningMessage('AI 草稿已过期：生成它所依据的提交选择或内容已变化。请先重新生成；如仍要提交这份过期草稿，请确认。',
          { modal: true }, '仍然提交过期草稿');
        if (action !== '仍然提交过期草稿') return;
      }
      if (reviewed) {
        await validate();
        const selection = await reviewSelectionFor(key, view);
        if (!['clean', 'findings', 'incomplete'].includes(reviewed.status)
          || view.scm.inputBox.value !== reviewed.commitMessage
          || unsavedTargets(targets) || reviewEntries.get(key) !== reviewed
          || !reviewed.session || !await reviewed.session.isCurrent(selection)
          || !await reviewConfigurationMatches(reviewed)) {
          reviewed.status = 'stale'; reviewed.staleReason = '最终确认时提交选择、内容或管理范围已变化。';
          reviewUI.refresh(reviewed);
          throw new Error('审查依据已变化，请重新审查后再提交。');
        }
      }
      const folder = openedFolders().find(folder => within(folder.uri.fsPath, targets[0]))!;
      const revision = await commitFiles(svnExecutable(folder), view.scm.rootUri!.fsPath, targets, message);
      await refresh();
      if (views.get(key) !== view || view.lastError) throw new Error(`SVN 已产生修订 ${revision}，但刷新失败。请核对仓库结果，勿重复提交。`);
      view.selected.complete(targets);
      filledDrafts.delete(key);
      if (view.scm.inputBox.value === message) view.scm.inputBox.value = '';
      if (reviewed) { reviewed.status = 'used'; reviewed.staleReason = undefined; reviewUI.refresh(reviewed); }
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

  async function configureApiKey(): Promise<void> {
    const saved = await context.secrets.get(apiKeySecret);
    const value = await vscode.window.showInputBox({
      title: '配置模型服务的 API Key',
      prompt: '密钥保存在 VS Code SecretStorage，不写入设置文件或日志。留空并回车可清除已保存的密钥。',
      password: true, ignoreFocusOut: true,
      placeHolder: saved ? '已保存密钥；输入新值替换，留空则清除' : '输入 API Key'
    });
    if (value === undefined) return;
    if (!value.trim()) {
      await context.secrets.delete(apiKeySecret);
      invalidateCompletedReviews('AI API Key 已变化。');
      void vscode.window.showInformationMessage('已清除保存的 API Key。');
      return;
    }
    await context.secrets.store(apiKeySecret, value.trim());
    invalidateCompletedReviews('AI API Key 已变化。');
    void vscode.window.showInformationMessage('API Key 已保存到 VS Code SecretStorage。');
  }

  // Generation and commit share one commit selection. Inputs that cannot be described
  // faithfully (conflicts, symbolic links, special states) or that exceed the size cap are
  // refused before the request is sent.
  async function generate(sourceControl?: vscode.SourceControl): Promise<void> {
    const candidates = [...views.entries()];
    const candidate = sourceControl ? candidates.find(([, view]) => view.scm === sourceControl)
      : candidates.length === 1 ? candidates[0]
        : (await vscode.window.showQuickPick(candidates.map(([key, view]) => ({
          label: view.scm.rootUri!.fsPath, description: `${view.selected.size} 项待提交`, key, view
        })), { placeHolder: '选择要为哪个工作副本生成提交信息草稿' }));
    if (!candidate) return;
    const [key, view] = Array.isArray(candidate) ? candidate : [candidate.key, candidate.view];
    if (drafts.has(key) || reviewRuns.has(key) || writes.isBusy(key)) {
      void vscode.window.showWarningMessage('该工作副本正在执行审查、草稿生成或写操作，请等待完成或取消后重试。');
      return;
    }
    const targets = view.selected.targets;
    if (targets.length === 0) {
      void vscode.window.showWarningMessage('没有待提交文件，请先加入待提交；生成与提交使用同一份提交选择。');
      return;
    }
    const settings = aiSettings();
    const apiKey = (await context.secrets.get(apiKeySecret))?.trim() ?? '';
    const problems = configurationProblems(settings, apiKey);
    if (problems.length > 0) {
      void vscode.window.showErrorMessage(`AI 配置不完整：${problems.join('；')}；未发送请求。`, '配置 AI 服务', '设置 API Key')
        .then(action => {
          if (action === '配置 AI 服务') void vscode.commands.executeCommand('workbench.action.openSettings', 'codeSvn.ai');
          if (action === '设置 API Key') void vscode.commands.executeCommand('codeSvn.setApiKey');
        });
      return;
    }
    const scopes = openedFolders().map(folder => folder.uri.fsPath);
    const folder = openedFolders().find(choice => within(choice.uri.fsPath, targets[0]));
    if (!folder) { void vscode.window.showWarningMessage('管理范围已变化，请刷新后重新选择待提交文件。'); return; }
    const executable = svnExecutable(folder);
    const root = view.scm.rootUri!.fsPath;
    const changed = () => [...view.ancestors, ...view.changes];
    const validate = async (current: string[]): Promise<void> => {
      await refresh();
      if (views.get(key) !== view || view.lastError) throw new Error('无法确认工作副本当前状态，请刷新并检查查询日志。');
      await view.selected.validate(current, changed(), scopes);
    };
    const collect = (): Promise<DraftInput> => collectDraftInput(executable, scopes, root, changed(), targets);
    if (drafts.has(key) || reviewRuns.has(key) || writes.isBusy(key)) {
      void vscode.window.showWarningMessage('该工作副本正在执行审查、草稿生成或写操作，请等待完成或取消后重试。');
      return;
    }
    const release = writes.tryAcquire(key);
    if (!release) return;
    const controller = new AbortController();
    drafts.set(key, controller);
    try {
      await validate(targets);
      const dirty = () => vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file'
        && document.isDirty && targets.some(target => pathKey(target) === pathKey(document.uri.fsPath)));
      if (dirty().length > 0) {
        const action = await vscode.window.showWarningMessage('选中文件有未保存内容。保存后再生成草稿？', { modal: true }, '保存并生成');
        if (action !== '保存并生成') return;
        for (const document of dirty()) if (!await document.save()) throw new Error(`无法保存 ${document.uri.fsPath}，生成已停止。`);
        await validate(targets);
        if (dirty().length > 0) throw new Error('选中文件仍有未保存内容，生成已停止。');
      }
      const collected = await collect();
      if (collected.unsupported.length > 0) {
        throw new Error(`本次待提交包含尚不支持的输入：${collected.unsupported.join('；')}。这些输入当前无法安全描述，未发送请求。`);
      }
      assertInputWithinLimit(collected.items);
      const original = view.scm.inputBox.value;
      if (original.trim()) {
        const action = await vscode.window.showWarningMessage('生成结果将替换当前提交信息，是否继续？',
          { modal: true, detail: `${original.slice(0, 400)}${original.length > 400 ? '…' : ''}` }, '继续生成');
        if (action !== '继续生成') return;
      }
      const draft = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: '正在生成提交信息草稿…', cancellable: true
      }, (_progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        return requestDraft(settings, apiKey, collected.items, controller.signal);
      });
      // Any selection or content change during the request shows up in the re-collected
      // differences, so a mismatch discards the result instead of filling a stale draft.
      const current = view.selected.targets;
      const sameSelection = current.length === targets.length
        && targets.every(target => current.some(item => pathKey(item) === pathKey(target)))
        && !unsavedTargets(current);
      await refresh();
      if (views.get(key) !== view || view.lastError) {
        void vscode.window.showErrorMessage('生成完成但无法确认工作副本当前状态，草稿未填入；请刷新后重试。');
        return;
      }
      let verified: DraftInput | undefined;
      if (sameSelection) {
        try {
          await validate(current);
          verified = await collectDraftInput(executable, scopes, root, changed(), current);
        } catch { verified = undefined; }
      }
      if (draftBasis(verified) !== draftBasis(collected)) {
        void vscode.window.showInformationMessage('提交选择或相关内容在生成期间已变化，草稿未填入；请重新生成。');
        return;
      }
      if (view.scm.inputBox.value !== original) {
        void vscode.window.showInformationMessage('提交信息在生成期间已被修改，草稿未填入；需要时请重新生成。');
        return;
      }
      filledDrafts.set(key, { basis: JSON.stringify(collected.items), stale: false, queue: Promise.resolve() });
      view.scm.inputBox.value = draft;
      const binaryNote = collected.binary.length > 0
        ? ` 以下二进制文件内容未分析，草稿未包含其内容：${collected.binary.join('、')}。` : '';
      void vscode.window.showInformationMessage(`草稿已填入提交信息输入框，请审阅或修改后手动提交；插件不会自动提交。${binaryNote}`);
    } catch (error) {
      if (error instanceof AiCancelled) {
        void vscode.window.showInformationMessage('生成已取消；原提交信息保持不变。');
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      output.appendLine(`${new Date().toISOString()} 生成提交信息草稿失败\n${detail}`);
      void vscode.window.showErrorMessage(`${detail} 原提交信息保持不变，需要时请手动重试。`, '查看日志')
        .then(action => { if (action === '查看日志') output.show(); });
    } finally {
      drafts.delete(key);
      release();
    }
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

  // Read-only, so it needs no write lock. Closing the picker cancels the query.
  async function history(resource?: vscode.Uri | vscode.SourceControlResourceState): Promise<void> {
    const target = !resource ? vscode.window.activeTextEditor?.document.uri
      : 'resourceUri' in resource ? resource.resourceUri : resource;
    if (!target || target.scheme !== 'file') {
      void vscode.window.showWarningMessage('请选择本地文件或目录后查看 SVN 历史。');
      return;
    }
    const scope = target.fsPath;
    const name = path.basename(scope);
    const folder = openedFolders().find(candidate => within(candidate.uri.fsPath, scope));
    if (!folder) {
      void vscode.window.showErrorMessage(`无法查看 ${name} 的历史：该路径不在当前打开的 SVN 管理范围内。`);
      return;
    }
    const executable = svnExecutable(folder);
    const folderPath = folder.uri.fsPath;
    const controller = new AbortController();
    const picker = vscode.window.createQuickPick<HistoryItem>();
    const entries: HistoryEntry[] = [];
    let location: ObjectLocation | undefined;
    let hasMore = true;
    let closed = false;
    let compareFrom: number | undefined;
    const compareOther = { iconPath: new vscode.ThemeIcon('diff'), tooltip: '与另一修订比较' };
    const compareHead = { iconPath: new vscode.ThemeIcon('arrow-up'), tooltip: '与最新版本（HEAD）比较' };
    picker.title = `SVN 历史：${name}`;
    picker.onDidHide(() => { closed = true; controller.abort(); picker.dispose(); });
    picker.onDidAccept(() => {
      const item = picker.selectedItems[0];
      if (item?.loadMore && !picker.busy) void load();
      else if (item?.revision !== undefined && location && !picker.busy) {
        if (compareFrom !== undefined) {
          if (compareFrom === item.revision) return;
          picker.hide();
          void showFileComparison(compareFrom, item.revision, location);
        } else void showRevision(item.revision, location);
      }
    });
    picker.onDidTriggerItemButton(event => {
      if (picker.busy || !location || event.item.revision === undefined) return;
      if (event.button === compareHead) {
        picker.hide();
        void showFileComparison(event.item.revision, 'HEAD', location);
      } else if (event.button === compareOther) {
        compareFrom = event.item.revision;
        picker.title = `SVN 版本对比：${name} · 已选 r${compareFrom}`;
        picker.value = '';
        render();
      }
    });
    const render = () => {
      picker.items = [
        ...entries.map((entry): HistoryItem => ({
          label: `r${entry.revision}`,
          revision: entry.revision,
          buttons: location?.kind === 'file' && compareFrom === undefined ? [compareOther, compareHead] : undefined,
          description: `${entry.author || '（无作者）'} · ${formatDate(entry.date)}`,
          detail: entry.message.replace(/\s+/g, ' ').trim() || '（无提交信息）'
        })),
        ...(hasMore ? [{ label: `$(arrow-down) 加载更早的 ${historyBatchSize} 条`, alwaysShow: true, loadMore: true }] : [])
      ];
      picker.placeholder = compareFrom !== undefined ? `请选择与 r${compareFrom} 不同的另一修订，可加载更早记录；Esc 取消`
        : hasMore ? `已显示 ${entries.length} 条，最新优先` : `已显示全部 ${entries.length} 条，最新优先`;
    };
    const load = async (): Promise<void> => {
      picker.busy = true;
      try {
        location ??= await readObjectLocation(executable, folder.uri.fsPath, scope, controller.signal);
        const last = entries[entries.length - 1];
        const batch = await readHistoryBatch(executable, folder.uri.fsPath, location.url, last ? last.revision - 1 : undefined, controller.signal);
        entries.push(...batch.entries);
        hasMore = batch.hasMore;
        if (entries.length === 0) {
          picker.hide();
          void vscode.window.showInformationMessage(`${name} 在服务器上没有历史记录。`);
          return;
        }
        render();
      } catch (error) {
        if (closed || error instanceof QueryCancelled) return;
        const detail = error instanceof Error ? error.message : String(error);
        output.appendLine(`${new Date().toISOString()} 查询历史失败 ${scope}\n${detail}`);
        // A failed first batch must not look like an empty history. A failed
        // later batch keeps the loaded records and leaves load-more for retry.
        if (entries.length === 0) picker.hide();
        void vscode.window.showErrorMessage(`查询历史失败：${detail} ${historyFailure(detail)}`, '查看日志')
          .then(action => { if (action === '查看日志') output.show(); });
      } finally {
        if (!closed) picker.busy = false;
      }
    };
    async function showRevision(revision: number, target: ObjectLocation): Promise<void> {
      picker.hide();
      const detailController = new AbortController();
      const changes = vscode.window.createQuickPick<RevisionItem>();
      let closed = false;
      changes.title = `r${revision} · ${name}`;
      changes.onDidHide(() => { closed = true; detailController.abort(); changes.dispose(); });
      changes.onDidAccept(() => {
        const item = changes.selectedItems[0];
        if (!item) return;
        changes.hide();
        void showRevisionDifference(revision, target, item.change);
      });
      changes.busy = true;
      changes.placeholder = '正在查询该修订中影响此对象的变化…';
      changes.show();
      try {
        const paths = await readRevisionPaths(executable, folderPath, target, revision, detailController.signal);
        if (paths.length === 0) {
          changes.hide();
          void vscode.window.showInformationMessage(`r${revision} 没有影响 ${name} 的路径变化。`);
          return;
        }
        changes.items = paths.map((change): RevisionItem => ({
          label: `${revisionLabel(change)}  ${change.path}`,
          description: change.copyFrom ? `来源 ^${change.copyFrom.path}@${change.copyFrom.revision}` : undefined,
          change
        }));
        changes.placeholder = `${paths.length} 项影响此对象的变化，选择后查看提交前后内容`;
      } catch (error) {
        if (closed || error instanceof QueryCancelled) return;
        const detail = error instanceof Error ? error.message : String(error);
        output.appendLine(`${new Date().toISOString()} 查询修订变化失败 r${revision} ${scope}\n${detail}`);
        changes.hide();
        void vscode.window.showErrorMessage(`查询 r${revision} 的变化失败：${detail} ${historyFailure(detail)}`, '查看日志')
          .then(action => { if (action === '查看日志') output.show(); });
      } finally {
        if (!closed) changes.busy = false;
      }
    }

    async function showFileComparison(first: number, second: number | 'HEAD', target: ObjectLocation): Promise<void> {
      try {
        const content = await readFileRevisionDifference(executable, folderPath, target, first, second);
        const range = `r${content.beforeRevision} → r${content.afterRevision}${second === 'HEAD' ? '（HEAD）' : ''}`;
        await openHistoricalDifference(content, { path: scope, kind: 'file' }, range, `${target.url}&${range}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        output.appendLine(`${new Date().toISOString()} 比较版本失败 r${first} → ${second} ${scope}\n${detail}`);
        void vscode.window.showErrorMessage(`比较 ${name} 的版本失败：${detail} ${historyFailure(detail)}`, '查看日志')
          .then(action => { if (action === '查看日志') output.show(); });
      }
    }

    async function showRevisionDifference(revision: number, target: ObjectLocation, change: RevisionPath): Promise<void> {
      const label = path.basename(change.path);
      try {
        const content = await readRevisionDifference(executable, folderPath, target, revision, change);
        await openHistoricalDifference(content, change, `r${revision} · ${revisionLabel(change)}`, `${target.url}&r=${revision}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        output.appendLine(`${new Date().toISOString()} 查看历史差异失败 r${revision} ${change.path}\n${detail}`);
        void vscode.window.showErrorMessage(`查看 ${label} 的历史差异失败：${detail} ${historyFailure(detail)}`, '查看日志')
          .then(action => { if (action === '查看日志') output.show(); });
      }
    }

    async function openHistoricalDifference(content: ChangeContent, change: Pick<RevisionPath, 'path' | 'kind'>, description: string, key: string): Promise<void> {
      const label = path.basename(change.path);
      const properties = content.properties;
      const uri = (side: 'base' | 'after' | 'properties') => vscode.Uri.from({
        scheme: revisionScheme, path: change.path, query: `${encodeURIComponent(key)}&side=${side}`
      });
      for (const [side, text] of [
        ['base', content.base ?? ''], ['after', content.text ?? ''],
        ['properties', propertyText(properties, change.path)]
      ] as const) {
        documents.set(uri(side).toString(), text);
        documentChanges.fire(uri(side));
      }
      if (properties.length > 0) await vscode.window.showTextDocument(uri('properties'), { preview: false });
      if (content.binary) {
        void vscode.window.showWarningMessage(`${label}：${description}，但 SVN 没有提供文本差异，二进制内容不可分析，本次没有分析文件内容。`);
        return;
      }
      if (change.kind === 'dir' && properties.length === 0) {
        void vscode.window.showInformationMessage(`${label}：目录条目没有文本或属性差异，其子项变化已单独列出。`);
        return;
      }
      if (content.base === content.text) {
        if (properties.length === 0) void vscode.window.showInformationMessage(`${label}：${description} 没有文本内容差异。`);
        return;
      }
      await vscode.commands.executeCommand('vscode.diff', uri('base'), uri('after'),
        `${label}（${description} · SVN 历史差异）`);
    }

    picker.show();
    await load();
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
      if (!copies.has(key)) {
        const active = reviewRuns.get(key);
        if (active) { active.invalidReason = '工作副本已关闭。'; active.controller.abort(); }
        view.scm.dispose(); views.delete(key);
      }
    }
    for (const [key, copy] of copies) {
      if (!views.has(key)) {
        const scm = vscode.scm.createSourceControl('codeSvn', 'SVN', vscode.Uri.file(copy.root));
        scm.inputBox.visible = true;
        scm.acceptInputCommand = { command: 'codeSvn.commit', title: '提交待提交文件', arguments: [scm] };
        const view: WorkingCopyView = { scm, groups: new Map(), changes: [], ancestors: [], lastError: '', selected: new CommitSelection(copy.root) };
        views.set(key, view);
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
        reassessDrafts();
      })().finally(() => { running = undefined; });
    }
    return running;
  }

  function schedule(): void {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { void refresh(); }, 300);
  }

  async function showReviewResults(sourceControl?: vscode.SourceControl): Promise<void> {
    const entries = [...reviewEntries.values()];
    const entry = sourceControl
      ? entries.find(item => views.get(item.key)?.scm === sourceControl)
      : entries.length === 1 ? entries[0]
        : await vscode.window.showQuickPick(entries.map(item => ({ label: item.root, description: item.status, entry: item })),
          { placeHolder: '选择要查看的审查结果' }).then(choice => choice?.entry);
    if (entry) await reviewUI.show(entry);
    else void vscode.window.showInformationMessage('当前没有审查结果。');
  }

  // Poll as a fallback for external CLI operations and ignored .svn metadata.
  const poll = setInterval(() => { void refresh(); }, 5000);
  const reviewMessagePoll = setInterval(() => {
    for (const entry of reviewEntries.values()) {
      const view = views.get(entry.key);
      if (!view || view.scm.inputBox.value === entry.commitMessage) continue;
      const active = reviewRuns.get(entry.key);
      if (active) { active.invalidReason = '提交信息已变化。'; active.controller.abort(); }
      if (['clean', 'findings', 'incomplete'].includes(entry.status)) {
        entry.status = 'stale'; entry.staleReason = '提交信息已变化。'; reviewUI.refresh(entry);
      }
    }
  }, 250);
  let promptWatcher: ReturnType<typeof watch> | undefined;
  try {
    promptWatcher = watch(path.join(context.extensionPath, 'tools'), (_event, filename) => {
      if (!filename || filename.toString() === 'review_prompt.md') invalidateCompletedReviews('审查提示词已变化。');
    });
  } catch { /* Some remote extension filesystems do not support watching the installation directory. */ }
  context.subscriptions.push(
    output,
    reviewUI,
    vscode.workspace.registerTextDocumentContentProvider('codeSvnReview', reviewUI),
    documentChanges,
    vscode.commands.registerCommand('codeSvn.refresh', refresh),
    vscode.commands.registerCommand('codeSvn.showOutput', () => output.show()),
    vscode.commands.registerCommand('codeSvn.select', (resource?: vscode.SourceControlResourceState) => chooseChange(false, resource)),
    vscode.commands.registerCommand('codeSvn.unselect', (resource?: vscode.SourceControlResourceState) => chooseChange(true, resource)),
    vscode.commands.registerCommand('codeSvn.add', add),
    vscode.commands.registerCommand('codeSvn.revert', revert),
    vscode.commands.registerCommand('codeSvn.update', update),
    vscode.commands.registerCommand('codeSvn.commit', commit),
    vscode.commands.registerCommand('codeSvn.generateDraft', (sourceControl?: vscode.SourceControl) => generate(sourceControl)),
    vscode.commands.registerCommand('codeSvn.review', (sourceControl?: vscode.SourceControl) => review(sourceControl)),
    vscode.commands.registerCommand('codeSvn.reviewAndCommit', (sourceControl?: vscode.SourceControl) => review(sourceControl, true)),
    vscode.commands.registerCommand('codeSvn.showReviewResults', (sourceControl?: vscode.SourceControl) => showReviewResults(sourceControl)),
    vscode.commands.registerCommand('codeSvn.reviewActivate', (node: Parameters<ReviewResults['activate']>[0]) => reviewUI.activate(node)),
    vscode.commands.registerCommand('codeSvn.setApiKey', configureApiKey),
    vscode.commands.registerCommand('codeSvn.viewChange', (change: Change) => viewChange(change)),
    vscode.commands.registerCommand('codeSvn.history', (resource?: vscode.Uri | vscode.SourceControlResourceState) => history(resource)),
    vscode.workspace.registerTextDocumentContentProvider(contentScheme, {
      onDidChange: documentChanges.event,
      provideTextDocumentContent: content
    }),
    vscode.workspace.registerTextDocumentContentProvider(revisionScheme, {
      onDidChange: documentChanges.event,
      provideTextDocumentContent: uri => {
        const text = documents.get(uri.toString());
        if (text === undefined) throw new Error('历史差异内容已关闭，请重新从历史列表打开。');
        return text;
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => { documents.delete(document.uri.toString()); }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (!isSelectedFile(event.document.uri)) return;
      if (filledDrafts.size > 0) scheduleDraftCheck();
      for (const [key, view] of views) {
        if (!view.selected.targets.some(target => pathKey(target) === pathKey(event.document.uri.fsPath))) continue;
        const active = reviewRuns.get(key);
        if (active) { active.invalidReason = '选中文件的编辑器内容已变化。'; active.controller.abort(); }
        const entry = reviewEntries.get(key);
        if (entry && ['clean', 'findings', 'incomplete'].includes(entry.status)) {
          entry.status = 'stale'; entry.staleReason = '选中文件的编辑器内容已变化。'; reviewUI.refresh(entry);
        }
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      invalidateCompletedReviews('工作区管理范围已变化。');
      void refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('codeSvn.svnPath')) {
        invalidateCompletedReviews('SVN 可执行配置已变化。');
        void refresh();
      }
      if (event.affectsConfiguration('codeSvn.ai')) invalidateCompletedReviews('AI 服务配置已变化。');
    }),
    { dispose() {
      disposed = true; clearInterval(poll); clearInterval(reviewMessagePoll); if (debounce) clearTimeout(debounce); if (draftDebounce) clearTimeout(draftDebounce);
      promptWatcher?.close();
      for (const run of reviewRuns.values()) run.controller.abort();
      for (const watcher of watchers.values()) watcher.dispose();
      for (const view of views.values()) view.scm.dispose();
    } }
  );
  void refresh();
}
