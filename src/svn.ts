import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface Change {
  path: string;
  item: string;
  props: string;
  conflicted: boolean;
  copied?: boolean;
  kind?: 'file' | 'dir';
}

export interface PropertyValue {
  value: string;
  encoding: 'text' | 'base64';
}

export interface PropertyChange {
  name: string;
  before?: PropertyValue;
  after?: PropertyValue;
}

export interface WorkingContent {
  text?: string;
  binary: boolean;
  symbolicLink?: boolean;
}

export interface ChangeContent extends WorkingContent {
  base?: string;
  properties: PropertyChange[];
}

class SvnError extends Error {
  constructor(message: string, readonly stderr: string) { super(message); }
}

export class WorkingCopyQueryError extends Error {
  constructor(readonly root: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function exec(executable: string, cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Keep the command first, but never put options after the target terminator.
    const terminator = args.indexOf('--');
    const command = [...args];
    command.splice(terminator === -1 ? command.length : terminator, 0, '--non-interactive');
    execFile(executable, command, {
      cwd, encoding: 'buffer', windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024
    }, (error, stdout, stderr) => {
      // SVN can return exit 0 with warnings and an incomplete/empty status.
      // Such a result cannot establish that the managed scope is clean.
      const detail = stderr.toString('utf8');
      if (error || detail.trim()) {
        reject(new SvnError(`SVN 查询失败：${detail.trim() || error?.message}`, detail));
      } else {
        resolve(stdout);
      }
    });
  });
}

function run(executable: string, cwd: string, args: string[]): Promise<string> {
  return exec(executable, cwd, args).then(stdout => stdout.toString('utf8'));
}

const parser = new XMLParser({
  ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
  trimValues: false, isArray: name => ['entry', 'target', 'changelist', 'property'].includes(name)
});

function parse(xml: string) {
  if (XMLValidator.validate(xml) !== true) throw new Error('SVN 返回了无效的 XML，无法确认变更状态。');
  return parser.parse(xml);
}

function within(folder: string, target: string): boolean {
  const relative = path.relative(folder, target);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

// Use cwd plus "." so spaces, Unicode and @ in opened directory names never
// become shell text or SVN peg revisions. Ancestors are queried shallowly only
// for dependency metadata, never to discover sibling changes.
export async function readChanges(executable: string, folder: string): Promise<{ root: string; changes: Change[]; ancestors: Change[] } | undefined> {
  let info;
  try {
    info = parse(await run(executable, folder, ['info', '--xml', '.']));
  } catch (error) {
    if (error instanceof SvnError && /(?:E|W)155007/.test(error.stderr)) return undefined;
    throw error;
  }
  if (!info.info?.entry?.[0]?.['wc-info']?.['wcroot-abspath']) {
    throw new Error('SVN 未返回工作副本信息，无法确认管理范围。');
  }
  const root = path.normalize(info.info.entry[0]['wc-info']['wcroot-abspath']);
  try {
    const parents: string[] = [];
    for (let parent = path.dirname(folder); within(root, parent) && path.relative(root, parent) !== ''; parent = path.dirname(parent)) {
      parents.push(`${path.relative(root, parent)}@`);
    }
    const [changes, ancestors] = await Promise.all([
      readStatus(executable, folder),
      parents.length > 0 ? readStatus(executable, root, parents, 'empty') : Promise.resolve([])
    ]);
    return { root, changes, ancestors };
  } catch (error) {
    throw new WorkingCopyQueryError(root, error);
  }
}

async function readStatus(executable: string, folder: string, targets = ['.'], depth = 'infinity'): Promise<Change[]> {
  const status = parse(await run(executable, folder, ['status', '--xml', '--verbose', '--ignore-externals', '--depth', depth, '--', ...targets]));
  if (!status.status) throw new Error('SVN 未返回状态信息，无法确认变更。');
  const entries = [
    ...(status.status.target ?? []).flatMap((target: any) => [
      ...(target.entry ?? []), ...(target.changelist ?? []).flatMap((list: any) => list.entry ?? [])
    ]),
    ...(status.status.changelist ?? []).flatMap((list: any) => list.entry ?? [])
  ];
  const excluded: string[] = [];
  for (const entry of entries) {
    const target = path.resolve(folder, entry['@_path']);
    if (!within(folder, target)) throw new Error('SVN 返回了管理范围之外的路径，查询已停止。');
    const wcStatus = entry['wc-status'];
    if (wcStatus?.['@_item'] === 'external' || wcStatus?.['@_file-external'] === 'true') {
      excluded.push(target);
    } else if (target !== folder) {
      try {
        if ((await fs.stat(path.join(target, '.svn'))).isDirectory()) excluded.push(target);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
  }
  const changes = entries.flatMap((entry: any): Change[] => {
    const target = path.resolve(folder, entry['@_path']);
    const wcStatus = entry['wc-status'];
    if (!wcStatus) throw new Error('SVN 返回了缺少工作状态的条目。');
    const item = wcStatus['@_item'];
    const props = wcStatus['@_props'];
    const conflicted = item === 'conflicted' || props === 'conflicted' || wcStatus['@_tree-conflicted'] === 'true';
    if (excluded.some(excludedPath => within(excludedPath, target))) return [];
    if (!conflicted && ['normal', 'none', 'ignored'].includes(item) && ['none', 'normal'].includes(props)) return [];
    return [{ path: target, item, props, conflicted, copied: wcStatus['@_copied'] === 'true' }];
  });
  await attachKinds(executable, folder, changes);
  return changes;
}

// Status never marks file versus directory. Scheduled deletions vanish from
// disk, so only svn info can tell a whole-tree deletion from a deleted file.
// Unknown kinds keep deleted items closed; never guess a whole-tree scope.
async function attachKinds(executable: string, folder: string, changes: Change[]): Promise<void> {
  const deleted = changes.filter(change => change.item === 'deleted');
  if (deleted.length === 0) return;
  const kinds = new Map<string, string>();
  try {
    const info = parse(await run(executable, folder, ['info', '--xml', '--',
      ...deleted.map(change => `${path.relative(folder, change.path) || '.'}@`)]));
    for (const entry of toArray(info.info?.entry)) kinds.set(path.resolve(folder, entry['@_path']), entry['@_kind']);
  } catch {
    return;
  }
  for (const change of deleted) {
    const kind = kinds.get(change.path);
    if (kind === 'dir' || kind === 'file') change.kind = kind;
  }
}

function toArray(value: unknown): any[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

// SVN answers "no pristine version" for added items and "refers to a directory"
// for directories. Neither means the working copy could not be read.
const noContentTarget = /(?:E|W)(?:195007|200009)/;
// A deleted or unversioned target has no working property list at all.
const noPropertyTarget = /(?:W)200005|(?:E)200009/;

function isBinary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch (error) {
    return true;
  }
}

function asText(bytes: Buffer | undefined): string | undefined {
  return bytes === undefined ? undefined : new TextDecoder('utf-8').decode(bytes);
}

async function readLocal(target: string): Promise<{ bytes?: Buffer; symbolicLink?: boolean }> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) return {};
    // SVN versions the link target, never the pointed-to file's contents.
    if (stat.isSymbolicLink()) return { bytes: Buffer.from(`link ${await fs.readlink(target)}`, 'utf8'), symbolicLink: true };
    return { bytes: await fs.readFile(target) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function catBase(executable: string, dir: string, name: string): Promise<Buffer | undefined> {
  try {
    return await exec(executable, dir, ['cat', '-r', 'BASE', '--', `${name}@`]);
  } catch (error) {
    if (error instanceof SvnError && noContentTarget.test(error.stderr)) return undefined;
    throw error;
  }
}

export async function readWorkingContent(target: string): Promise<WorkingContent> {
  const local = await readLocal(target);
  return { text: asText(local.bytes), binary: local.bytes !== undefined && isBinary(local.bytes), symbolicLink: local.symbolicLink };
}

async function readContent(executable: string, folder: string, change: Change): Promise<WorkingContent & { base?: string }> {
  const base = await catBase(executable, folder, path.relative(folder, change.path) || '.');
  const bytes = change.item === 'deleted' ? undefined : (await readLocal(change.path)).bytes;
  return {
    base: asText(base),
    text: asText(bytes),
    binary: [base, bytes].some(content => content !== undefined && isBinary(content))
  };
}

async function propertyMap(executable: string, dir: string, args: string[]): Promise<Map<string, PropertyValue>> {
  let xml;
  try {
    xml = await run(executable, dir, args);
  } catch (error) {
    if (error instanceof SvnError && noPropertyTarget.test(error.stderr)) return new Map();
    throw error;
  }
  const properties = new Map<string, PropertyValue>();
  for (const target of toArray(parse(xml).properties?.target)) {
    for (const property of toArray(target?.property)) {
      const encoding = property['@_encoding'] === 'base64' ? 'base64' : 'text';
      const value = typeof property['#text'] === 'string' ? property['#text'] : '';
      properties.set(property['@_name'], { value: encoding === 'base64' ? Buffer.from(value, 'base64').toString('base64') : value, encoding });
    }
  }
  return properties;
}

// Properties are read as UTF-8 XML; SVN's own unified diff output uses the
// console encoding, so it cannot carry Chinese paths into the editor intact.
export async function readDifference(executable: string, folder: string, change: Change): Promise<ChangeContent> {
  const name = path.relative(folder, change.path) || '.';
  const [before, after] = await Promise.all([
    propertyMap(executable, folder, ['proplist', '--xml', '-v', '--depth', 'empty', '-r', 'BASE', '--', `${name}@`]),
    propertyMap(executable, folder, ['proplist', '--xml', '-v', '--depth', 'empty', '--', `${name}@`])
  ]);
  const changes: PropertyChange[] = [];
  for (const [property, value] of before) {
    if (!after.has(property)) changes.push({ name: property, before: value });
    else if (after.get(property)!.value !== value.value || after.get(property)!.encoding !== value.encoding) {
      changes.push({ name: property, before: value, after: after.get(property) });
    }
  }
  for (const [property, value] of after) if (!before.has(property)) changes.push({ name: property, after: value });
  const content = await readContent(executable, folder, change);
  // SVN treats these two image formats as text alongside text/* MIME types.
  const binaryMime = [before, after].some(properties => {
    const mime = properties.get('svn:mime-type')?.value;
    return mime !== undefined && !mime.startsWith('text/') && !['image/x-xbitmap', 'image/x-xpixmap'].includes(mime);
  });
  return { ...content, binary: content.binary || binaryMime, properties: changes };
}

export async function addPath(executable: string, root: string, target: string): Promise<void> {
  await run(executable, root, ['add', '--depth', 'empty', '--', `${path.relative(root, target)}@`]);
}

export async function commitFiles(executable: string, root: string, targets: string[], message: string): Promise<number> {
  if (targets.length === 0) throw new Error('没有待提交文件。');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'code-svn-commit-'));
  const messageFile = path.join(directory, 'message.txt');
  try {
    await fs.writeFile(messageFile, message, 'utf8');
    // Translate messages without changing the caller's effective character
    // encoding, which Unix SVN uses to interpret filenames.
    const environment = { ...process.env };
    if (environment.LC_ALL) environment.LC_CTYPE = environment.LC_ALL;
    delete environment.LC_ALL;
    environment.LC_MESSAGES = 'C';
    return await new Promise<number>((resolve, reject) => {
      // A commit must not be timed out, cancelled or retried: its remote result
      // could already exist. spawn also avoids execFile's maxBuffer kill limit.
      const child = spawn(executable, ['commit', '--non-interactive', '--depth', 'empty',
        '--encoding', 'UTF-8', '--file', messageFile, '--',
        ...targets.map(target => `${path.relative(root, target)}@`)], {
        cwd: root, windowsHide: true, env: environment
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      child.on('error', error => reject(new Error(`SVN 提交失败：${error.message}`)));
      child.on('close', code => {
        const revision = /(?:^|\r?\n)Committed revision (\d+)\./.exec(stdout);
        if (code !== 0) reject(new Error(`SVN 提交失败：${stderr.trim() || `退出码 ${code}`}`));
        else if (!revision) reject(new Error('SVN 未确认产生修订，不能视为提交成功。请刷新并检查仓库结果后再决定是否提交。'));
        else resolve(Number(revision[1]));
      });
    });
  } finally {
    await fs.unlink(messageFile).catch(() => undefined);
    await fs.rmdir(directory).catch(() => undefined);
  }
}
