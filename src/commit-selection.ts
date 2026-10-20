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

// Structured reasons for a direct pick that cannot be selected on its own.
// The module knows the rule; each caller renders its own wording.
export type SelectionReason =
  | { code: 'moved-to-target'; target: string }
  | { code: 'inside-tree-deletion'; target: string };

// Expand user-picked paths into the commit operations they name. This is the
// shared rule behind the plugin's live multi-select and the CLI's argument
// resolution: a directory pick covers its descendant changes; descendants of a
// whole-tree deletion and move sources are excluded (they ride along as the
// directory or move-target operation); a direct pick of such an item yields a
// structured reason instead of a silent failure. Deleted files are kept as
// operations: standalone deletion review (CLI) and commit refusal (plugin)
// remain caller policy. With { directories: false } the picks are already
// resolved change paths (the shared review core), so directories are not
// re-expanded; the ride-along and reason rules still apply.
export async function expand(paths: string[], changes: Change[], options: { directories?: boolean } = {}): Promise<{ operations: Change[]; reasons: SelectionReason[] }> {
  const expandDirectories = options.directories ?? true;
  const operations = new Map<string, Change>();
  const reasons: SelectionReason[] = [];
  const pickedKeys = new Set(paths.map(value => pathKey(value)));
  // Direct picks that ride along with another operation in the same batch are
  // excluded without a reason; a pick alone gets a structured reason so callers
  // can guide the user to the operation that owns it.
  const deferred: SelectionReason[] = [];
  for (const picked of paths) {
    const root = deletedTreeRoot(picked, changes);
    if (root) {
      if (!pickedKeys.has(pathKey(root.path))) deferred.push({ code: 'inside-tree-deletion', target: root.path });
      continue;
    }
    const self = changes.find(change => pathKey(change.path) === pathKey(picked));
    if (self?.movedTo) {
      if (!pickedKeys.has(pathKey(self.movedTo))) deferred.push({ code: 'moved-to-target', target: self.movedTo });
      continue;
    }
    // SVN status XML leaves kind unset for ordinary entries; only deleted and
    // copied items learn it from svn info. Deleted directories may be gone from
    // disk, so their kind is authoritative; live paths fall back to lstat.
    const directory = expandDirectories && (self?.kind === 'dir'
      || (self?.item !== 'deleted' && (await fs.lstat(picked).then(stat => stat.isDirectory()).catch(() => false))));
    // A directory operation includes both the directory's own change (e.g. its
    // property edit) and every descendant change, minus excluded ride-alongs.
    const descendants = directory
      ? changes.filter(change => within(picked, change.path)
        && !deletedTreeRoot(change.path, changes)
        && !change.movedTo)
      : [];
    const items = directory ? [...descendants, ...(self ? [self] : [])] : self ? [self] : [];
    if (!items.length) continue; // No change at this path: callers decide whether that is an error.
    for (const item of items) operations.set(pathKey(item.path), item);
  }
  reasons.push(...deferred.filter(reason => !operations.has(pathKey(reason.target))));
  return { operations: [...operations.values()], reasons };
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
  removeTree(target: string): void {
    for (const item of this.files.values()) if (within(target, item)) this.files.delete(pathKey(item));
    this.reconcile([...this.changes.values()]);
  }

  private parents(target: string): string[] {
    const parents: string[] = [];
    for (let parent = path.dirname(target); within(this.root, parent) && pathKey(parent) !== pathKey(this.root); parent = path.dirname(parent)) {
      if (this.changes.get(pathKey(parent))?.item === 'added') parents.unshift(parent);
    }
    return parents;
  }

  // A recorded move is one operation: SVN refuses to commit either side alone,
  // so the scheduled source deletion joins as a required dependency.
  private moveSources(target: string): string[] {
    const change = this.changes.get(pathKey(target));
    if (!change?.movedFrom) return [];
    const source = this.changes.get(pathKey(change.movedFrom));
    return source?.item === 'deleted' ? [source.path] : [];
  }

  // A move whose source is not a known scheduled deletion lies outside the
  // managed scope: both sides could never be committed together there.
  private requireMoveSource(target: string): void {
    const change = this.changes.get(pathKey(target));
    if (!change?.movedFrom) return;
    const source = this.changes.get(pathKey(change.movedFrom));
    if (!source || source.item !== 'deleted') {
      const shown = path.relative(this.root, change.movedFrom) || path.basename(change.movedFrom);
      throw new Error(`${path.basename(target)} 的移动源 ${shown} 不在当前管理范围内，无法一起提交；请将源所在目录加入工作区后重新选择。`);
    }
  }

  reconcile(changes: Change[]): void {
    this.changes = new Map(changes.map(change => [pathKey(change.path), change]));
    this.dependencies.clear();
    for (const target of this.files.values()) {
      for (const parent of this.parents(target)) this.dependencies.set(pathKey(parent), parent);
      for (const source of this.moveSources(target)) this.dependencies.set(pathKey(source), source);
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
      // node deletes the whole subtree as one operation. A recorded move's
      // source commits only together with its selected target.
      if (change.kind === 'dir' && !change.movedTo) return;
      if (change.movedTo) {
        const target = this.changes.get(pathKey(change.movedTo));
        if (target && this.files.has(pathKey(target.path))) return;
      }
      throw new Error(`${path.basename(change.path)} 的当前状态不支持提交。删除操作尚未开放。`);
    }
    if (!['modified', 'normal', 'added'].includes(change.item) || (change.item === 'normal' && change.props !== 'modified')) {
      throw new Error(`${path.basename(change.path)} 的当前状态不支持提交。删除操作尚未开放。`);
    }
    const stat = await fs.lstat(change.path);
    // Copies commit recursively in the repository even at depth empty; plain
    // and copied directories alike commit as the one operation the user chose.
    if (stat.isDirectory() && change.item === 'added') return;
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
    await this.addMany([change], scopes);
  }

  async addMany(changes: Change[], scopes: string[]): Promise<void> {
    const additions = new Map<string, Change>();
    for (const change of changes) additions.set(pathKey(change.path), change);
    for (const change of additions.values()) {
      this.checkScope(change.path, scopes);
      await this.checkFile(change);
      this.requireMoveSource(change.path);
      for (const parent of this.parents(change.path)) {
        this.checkScope(parent, scopes);
        await this.checkFile(this.changes.get(pathKey(parent))!);
      }
    }
    for (const change of additions.values()) this.files.set(pathKey(change.path), change.path);
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
