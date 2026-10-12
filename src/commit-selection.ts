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

export class CommitSelection {
  private readonly files = new Map<string, string>();

  constructor(readonly root: string) {}

  get size(): number { return this.files.size; }
  get targets(): string[] { return [...this.files.values()]; }
  has(target: string): boolean { return this.files.has(pathKey(target)); }
  remove(target: string): void { this.files.delete(pathKey(target)); }

  private async checkFile(change: Change): Promise<void> {
    if (change.conflicted) throw new Error(`${path.basename(change.path)} 存在冲突，请先解决冲突。`);
    if (!['modified', 'normal'].includes(change.item) || (change.item === 'normal' && change.props !== 'modified')) {
      throw new Error(`${path.basename(change.path)} 的当前状态不支持提交。当前仅支持普通版本控制文件的修改，新增和删除操作尚未开放。`);
    }
    const stat = await fs.lstat(change.path);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('当前尚不支持目录提交。');
  }

  async add(change: Change): Promise<void> {
    if (!within(this.root, change.path)) throw new Error('该文件不属于当前工作副本。');
    await this.checkFile(change);
    this.files.set(pathKey(change.path), change.path);
  }

  async validate(targets: string[], changes: Change[], scopes: string[]): Promise<void> {
    const current = new Map(changes.map(change => [pathKey(change.path), change]));
    for (const target of targets) {
      const change = current.get(pathKey(target));
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
