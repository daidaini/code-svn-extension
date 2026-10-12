import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Change } from './svn';

export function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function within(folder: string, target: string): boolean {
  const relative = path.relative(pathKey(folder), pathKey(target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// A scheduled-for-deletion directory is one whole-subtree operation: its
// deleted descendants are affected children shown for review, never separate
// selectable commits. Returns the topmost deleted directory above the target.
export function deletedTreeRoot(target: string, changes: Change[]): Change | undefined {
  let root: Change | undefined;
  for (const change of changes) {
    if (change.item !== 'deleted' || change.kind !== 'dir') continue;
    if (pathKey(change.path) === pathKey(target) || !within(change.path, target)) continue;
    if (!root || within(change.path, root.path)) root = change;
  }
  return root;
}

export class CommitSelection {
  private readonly files = new Map<string, string>();
  private readonly dependencies = new Map<string, string>();
  private changes = new Map<string, Change>();

  constructor(readonly root: string) {}

  get size(): number { return this.targets.length; }
  get explicitTargets(): string[] { return [...this.files.values()]; }
  get targets(): string[] { return [...new Map([...this.dependencies, ...this.files]).values()]; }
  has(target: string): boolean { return this.files.has(pathKey(target)); }
  isDependency(target: string): boolean { return this.dependencies.has(pathKey(target)); }
  remove(target: string): void { this.files.delete(pathKey(target)); this.reconcile([...this.changes.values()]); }

  private parents(target: string): string[] {
    const parents: string[] = [];
    for (let parent = path.dirname(target); within(this.root, parent) && pathKey(parent) !== pathKey(this.root); parent = path.dirname(parent)) {
      if (this.changes.get(pathKey(parent))?.item === 'added') parents.unshift(parent);
    }
    return parents;
  }

  reconcile(changes: Change[]): void {
    this.changes = new Map(changes.map(change => [pathKey(change.path), change]));
    this.dependencies.clear();
    for (const target of this.files.values()) {
      for (const parent of this.parents(target)) this.dependencies.set(pathKey(parent), parent);
    }
  }

  private checkScope(target: string, scopes: string[]): void {
    if (!within(this.root, target) || !scopes.some(scope => within(scope, target))) {
      throw new Error(`${target} 是必需提交依赖或选定路径，但超出管理范围。请将所需父目录加入工作区后重新操作。`);
    }
  }

  private async checkFile(change: Change): Promise<void> {
    if (change.conflicted) throw new Error(`${path.basename(change.path)} 存在冲突，请先解决冲突。`);
    if (change.item === 'unversioned') throw new Error(`${path.basename(change.path)} 尚未跟踪，请先执行添加到版本控制，再加入待提交。`);
    if (change.item === 'deleted') {
      // The scheduled directory may already be gone from disk; committing its
      // node deletes the whole subtree as one operation.
      if (change.kind === 'dir') return;
      throw new Error(`${path.basename(change.path)} 的当前状态不支持提交。删除操作尚未开放。`);
    }
    if (!['modified', 'normal', 'added'].includes(change.item) || (change.item === 'normal' && change.props !== 'modified')) {
      throw new Error(`${path.basename(change.path)} 的当前状态不支持提交。删除操作尚未开放。`);
    }
    const stat = await fs.lstat(change.path);
    if (stat.isDirectory() && change.item === 'added' && !change.copied) return;
    // Directory property commits carry --depth empty: only the directory's own
    // properties are sent, never the children's changes.
    if (stat.isDirectory() && change.props === 'modified' && ['modified', 'normal'].includes(change.item)) return;
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('当前尚不支持该目录提交；仅允许普通新增目录、目录属性变更或整体目录删除。');
  }

  async validateAddition(change: Change, scopes: string[]): Promise<void> {
    this.checkScope(change.path, scopes);
    if (change.item !== 'unversioned') throw new Error('该路径不再是未跟踪状态，请刷新后重新添加。');
    for (const parent of this.parents(change.path)) {
      this.checkScope(parent, scopes);
      await this.checkFile(this.changes.get(pathKey(parent))!);
    }
  }

  async add(change: Change, scopes: string[]): Promise<void> {
    this.checkScope(change.path, scopes);
    await this.checkFile(change);
    for (const parent of this.parents(change.path)) {
      this.checkScope(parent, scopes);
      await this.checkFile(this.changes.get(pathKey(parent))!);
    }
    this.files.set(pathKey(change.path), change.path);
    this.reconcile([...this.changes.values()]);
  }

  async validate(targets: string[], changes: Change[], scopes: string[]): Promise<void> {
    this.reconcile(changes);
    for (const target of this.files.values()) {
      if (!this.changes.has(pathKey(target)) || !scopes.some(scope => within(scope, target))) {
        throw new Error(`${path.basename(target)} 的状态或管理范围已变化，请移出待提交后重新选择。`);
      }
    }
    for (const target of this.targets) this.checkScope(target, scopes);
    if (targets.length !== this.targets.length || targets.some(target => !this.targets.some(current => pathKey(current) === pathKey(target)))) {
      throw new Error('必需提交依赖已变化，请审阅当前待提交选择及依赖后重新提交。');
    }
    for (const target of targets) {
      const change = this.changes.get(pathKey(target));
      if (!change || !within(this.root, target) || !scopes.some(scope => within(scope, target))) {
        throw new Error(`${path.basename(target)} 的状态或管理范围已变化，请移出待提交后重新选择。`);
      }
      await this.checkFile(change);
    }
  }

  complete(targets: string[]): void { for (const target of targets) this.remove(target); }
}

export class WorkingCopyWrites {
  private readonly active = new Set<string>();

  isBusy(root: string): boolean { return this.active.has(pathKey(root)); }

  tryAcquire(root: string): (() => void) | undefined {
    const key = pathKey(root);
    if (this.active.has(key)) return undefined;
    this.active.add(key);
    return () => { this.active.delete(key); };
  }
}
