import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface Change {
  path: string;
  item: string;
  props: string;
  conflicted: boolean;
}

class SvnError extends Error {
  constructor(message: string, readonly stderr: string) { super(message); }
}

export class WorkingCopyQueryError extends Error {
  constructor(readonly root: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function run(executable: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args, '--non-interactive'], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024
    }, (error, stdout, stderr) => {
      // SVN can return exit 0 with warnings and an incomplete/empty status.
      // Such a result cannot establish that the managed scope is clean.
      if (error || stderr.trim()) {
        reject(new SvnError(`SVN 查询失败：${stderr.trim() || error?.message}`, stderr));
      } else {
        resolve(stdout);
      }
    });
  });
}

const parser = new XMLParser({
  ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
  trimValues: false, isArray: name => ['entry', 'target', 'changelist'].includes(name)
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
// become shell text or SVN peg revisions. No parent/sibling status query.
export async function readChanges(executable: string, folder: string): Promise<{ root: string; changes: Change[] } | undefined> {
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
    return { root, changes: await readStatus(executable, folder) };
  } catch (error) {
    throw new WorkingCopyQueryError(root, error);
  }
}

async function readStatus(executable: string, folder: string): Promise<Change[]> {
  const status = parse(await run(executable, folder, ['status', '--xml', '--verbose', '--ignore-externals', '.']));
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
    return [{ path: target, item, props, conflicted }];
  });
  return changes;
}
