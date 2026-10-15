import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AiSettings, requestMessages, textDiff } from './ai';
import { CommitSelection, deletedTreeRoot, pathKey, within } from './commit-selection';
import { Change, ChangeContent, changeLabel, readBaseContent, readChanges, readDifference } from './svn';

export interface ReviewSelection {
  executable: string;
  scope: string;
  root: string;
  explicit: string[];
  targets: string[];
  dependencies: string[];
}

export interface ReviewFinding {
  severity: 'high' | 'medium' | 'low';
  confidence: 'high';
  file: string;
  side: 'new' | 'old';
  line_start: number;
  line_end: number;
  title: string;
  trigger: string;
  evidence: string;
  impact: string;
  suggestion: string;
  verification: string;
}

export interface ContextRequest { file_or_symbol: string; reason: string }
interface ModelReview { findings: ReviewFinding[]; context_requests: ContextRequest[] }
interface ReviewFile { file: string; change: Change; kind: 'file' | 'dir'; content: ChangeContent; diff: string }
interface ContextFile { file: string; version: 'BASE'; content: string }
export interface ReviewResult extends ModelReview {
  status: 'clean' | 'findings' | 'incomplete' | 'stale' | 'error';
  requests: number;
  coverage: {
    root: string; scope: string; selected: string[]; dependencies: string[];
    files: string[]; binary: string[]; context: string[];
  };
  error?: string;
}

export const reviewExitCodes = { clean: 0, findings: 1, error: 2, incomplete: 3, stale: 4 } as const;
const maxInputCharacters = 60_000;
const relative = (root: string, target: string) => path.relative(root, target).split(path.sep).join('/') || '.';
const unique = (values: string[]) => [...new Map(values.map(value => [pathKey(value), value])).values()];
const lineCount = (text: string) => text ? text.replace(/\r\n/g, '\n').split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
const numbered = (text: string) => text.replace(/\r\n/g, '\n').split('\n').slice(0, lineCount(text)).map((line, index) => `${index + 1} | ${line}`).join('\n');

// A lexical scope check alone would allow a symlinked ancestor to escape it.
async function checkPath(scope: string, target: string): Promise<void> {
  if (!within(scope, target)) throw new Error(`${target} 超出指定审查范围。`);
  let current = scope;
  for (const part of ['', ...path.relative(scope, target).split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) break; // Scheduled deletions may no longer exist on disk.
    if (stat.isSymbolicLink()) throw new Error(`${target} 是符号链接或经过符号链接，无法审查。`);
  }
}

async function choose(selection: Pick<ReviewSelection, 'executable' | 'scope' | 'root'>, changes: Change[], paths: string[]): Promise<ReviewSelection> {
  const { root, scope } = selection;
  const selected = new CommitSelection(root);
  selected.reconcile(changes);
  const explicit = unique(paths.map(target => deletedTreeRoot(target, changes)?.path ?? target));
  const deletions: string[] = [];
  for (const target of explicit) {
    await checkPath(scope, target);
    const change = changes.find(item => pathKey(item.path) === pathKey(target));
    if (!change) throw new Error(`${relative(root, target)} 没有可审查的 SVN 变更。`);
    if (change.conflicted) throw new Error(`${relative(root, target)} 存在冲突。`);
    if (change.movedTo) {
      if (!explicit.some(item => pathKey(item) === pathKey(change.movedTo!))) {
        throw new Error(`请通过移动目标 ${relative(root, change.movedTo)} 选择完整移动。`);
      }
      continue; // The destination supplies this source as a dependency.
    }
    if (change.item === 'deleted' && change.kind === 'file') deletions.push(target);
    else await selected.add(change, [scope]);
  }
  const targets = unique([...selected.targets, ...deletions]).sort();
  return {
    ...selection, explicit: explicit.filter(target => !changes.find(change => pathKey(change.path) === pathKey(target))?.movedTo),
    targets, dependencies: targets.filter(target => selected.isDependency(target) && !selected.has(target))
  };
}

// CLI directory arguments expand into a fixed selection at invocation time.
// A future plugin adapter can instead supply its already resolved selection to reviewSelection().
export async function resolveReviewSelection(executable: string, scope: string, paths: string[], all: boolean): Promise<ReviewSelection> {
  scope = path.resolve(scope);
  if (!(await fs.stat(scope)).isDirectory()) throw new Error('--scope 必须是目录。');
  if (pathKey(await fs.realpath(scope)) !== pathKey(scope)) throw new Error('--scope 不能经过符号链接。');
  const state = await readChanges(executable, scope);
  if (!state) throw new Error('指定范围不是 SVN 工作副本。');
  const candidates: string[] = [];
  if (all) candidates.push(...state.changes.filter(change => change.item !== 'unversioned').map(change => change.path));
  for (const value of paths) {
    const target = path.resolve(scope, value);
    await checkPath(scope, target);
    const stat = await fs.lstat(target).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const directory = stat?.isDirectory() || state.changes.some(change => pathKey(change.path) === pathKey(target) && change.kind === 'dir');
    const matches = state.changes.filter(change => pathKey(change.path) === pathKey(target)
      || (directory && change.item !== 'unversioned' && within(target, change.path)));
    if (!matches.length) throw new Error(`${value} 没有可审查的 SVN 变更，或不属于指定工作副本。`);
    candidates.push(...matches.map(change => change.path));
  }
  if (!candidates.length) throw new Error('没有待审查的 SVN 变更。');
  return choose({ executable, scope, root: state.root }, [...state.ancestors, ...state.changes], candidates);
}

async function collect(selection: ReviewSelection): Promise<ReviewFile[]> {
  const { executable, scope, root } = selection;
  const state = await readChanges(executable, scope);
  if (!state || pathKey(state.root) !== pathKey(root)) throw new Error('工作副本已变化。');
  const current = await choose(selection, [...state.ancestors, ...state.changes], selection.explicit);
  if (JSON.stringify(current.targets) !== JSON.stringify(unique(selection.targets).sort())) throw new Error('必需提交依赖已变化。');
  const expanded: string[] = [];
  for (const target of selection.targets) {
    const change = state.changes.find(item => pathKey(item.path) === pathKey(target));
    if (!change) throw new Error(`${relative(root, target)} 的状态已变化。`);
    // Deleting a directory removes its whole tree. A shallow copied-directory
    // commit copies the repository tree, but excludes unselected local child edits.
    const tree = change.kind === 'dir' && change.item === 'deleted';
    expanded.push(...(tree ? state.changes.filter(item => within(target, item.path)).map(item => item.path) : [target]));
  }
  const targets = unique(expanded).sort();
  const files: ReviewFile[] = [];
  for (const target of targets) {
    await checkPath(scope, target);
    const change = state.changes.find(item => pathKey(item.path) === pathKey(target))!;
    if (change.conflicted || !['normal', 'modified', 'added', 'deleted'].includes(change.item)) {
      throw new Error(`${relative(root, target)}：不支持 ${changeLabel(change)} 状态。`);
    }
    if (change.copied && !change.copiedFrom) throw new Error(`${relative(root, target)}：无法确认复制基线。`);
    const kind = change.kind ?? ((await fs.lstat(target)).isDirectory() ? 'dir' : 'file');
    const content = await readDifference(executable, scope, change);
    if (content.properties.some(prop => prop.name === 'svn:special')) throw new Error(`${relative(root, target)}：不支持特殊文件。`);
    if (kind === 'file' && change.item !== 'deleted' && content.text === undefined) throw new Error(`${relative(root, target)}：本地文件不可读取。`);
    const file = relative(root, target);
    files.push({ file, change, kind, content, diff: content.binary ? '' : textDiff(file, content.base ?? '', content.text ?? '') });
  }
  return files;
}

function buildMessages(prompt: string, root: string, files: ReviewFile[], contexts: ContextFile[], intent: string): { system: string; user: string } {
  const marker = '# User Prompt 模板';
  const index = prompt.indexOf(marker);
  if (!prompt.startsWith('# System Prompt') || index < 0) throw new Error('审查提示词缺少 System Prompt 或 User Prompt 模板。');
  const values: Record<string, string> = {
    project_summary: 'SVN 提交选择。项目业务说明未提供。',
    languages_frameworks_versions_runtime: '未提供；不要假设依赖版本或运行环境。',
    change_intent_or_unknown: intent || '未提供。',
    relevant_project_rules: '未提供额外项目约定。',
    lint_typecheck_tests_results_or_not_run: '未执行；本工具不运行 lint、类型检查、测试或编译。',
    selected_diff_with_old_and_new_line_numbers: files.map(item => JSON.stringify({
      file: item.file, kind: item.kind, status: changeLabel(item.change),
      moved_from: item.change.movedFrom ? relative(root, item.change.movedFrom) : undefined,
      moved_to: item.change.movedTo ? relative(root, item.change.movedTo) : undefined,
      copy_source: item.change.copiedFrom ? { path: item.change.copiedFrom.repoPath, revision: item.change.copiedFrom.rev } : undefined,
      diff: item.diff, properties: item.content.properties,
      binary: item.content.binary, note: item.content.binary ? '二进制内容未分析。' : undefined
    })).join('\n'),
    relevant_selected_files_functions_types_callers_tests: files.filter(item => !item.content.binary && item.kind === 'file').map(item => JSON.stringify({
      file: item.file, side: item.change.item === 'deleted' ? 'old' : 'new',
      version: item.change.item === 'deleted' ? '基线版本' : '本次提交选择的工作副本版本',
      content: numbered(item.change.item === 'deleted' ? item.content.base ?? '' : item.content.text ?? '')
    })).join('\n')
  };
  const system = prompt.slice('# System Prompt'.length, index).trim();
  let user = prompt.slice(index + marker.length).replace(/\{\{([^}]+)\}\}/g, (_match, key) => {
    if (!(key in values)) throw new Error(`审查提示词包含未知占位符：${key}`);
    return values[key];
  }).trim();
  if (contexts.length) user += `\n\n## 补充上下文（未选择文件的 BASE，不包含其本地修改）\n${contexts.map(item => JSON.stringify({ ...item, content: numbered(item.content) })).join('\n')}`;
  return { system, user };
}

function parseReview(text: string, files: ReviewFile[], contexts: ContextFile[]): ModelReview {
  let result: any;
  try { result = JSON.parse(text); } catch { throw new Error('审查结果不是合法 JSON。'); }
  const fail = () => { throw new Error('审查结果不符合约定结构、文件范围或行号。'); };
  if (!result || !Array.isArray(result.findings) || !Array.isArray(result.context_requests)
    || result.findings.length > 3 || result.context_requests.length > 3) fail();
  const findings = result.findings.map((item: any): ReviewFinding => {
    if (!item || typeof item !== 'object') return fail();
    const fields = ['file', 'title', 'trigger', 'evidence', 'impact', 'suggestion', 'verification'] as const;
    if (fields.some(field => typeof item[field] !== 'string' || !item[field].trim())) fail();
    const file = files.find(file => file.file === item.file && file.kind === 'file' && !file.content.binary);
    const context = contexts.find(file => file.file === item.file);
    if ((!file && !context) || !['high', 'medium', 'low'].includes(item.severity) || item.confidence !== 'high'
      || !['new', 'old'].includes(item.side) || !Number.isInteger(item.line_start) || !Number.isInteger(item.line_end)
      || item.line_start < 1 || item.line_end < item.line_start) fail();
    if (context && item.side !== 'old') fail();
    const count = lineCount(context?.content ?? (item.side === 'new' ? file!.content.text ?? '' : file!.content.base ?? ''));
    if (item.line_end > count) fail();
    // Old text of a modified file is provided through its diff, not as a full file.
    if (item.side === 'old' && file && file.change.item !== 'deleted') {
      const ranges = [...file.diff.matchAll(/^@@ -(\d+),(\d+) \+\d+,\d+ @@$/gm)];
      if (!ranges.some(range => item.line_start >= +range[1] && item.line_end < +range[1] + +range[2])) fail();
    }
    return {
      severity: item.severity, confidence: 'high', file: item.file, side: item.side,
      line_start: item.line_start, line_end: item.line_end, title: item.title, trigger: item.trigger,
      evidence: item.evidence, impact: item.impact, suggestion: item.suggestion, verification: item.verification
    };
  });
  const context_requests = result.context_requests.map((item: any): ContextRequest => {
    if (!item || typeof item.file_or_symbol !== 'string' || !item.file_or_symbol.trim()
      || typeof item.reason !== 'string' || !item.reason.trim()) return fail();
    return { file_or_symbol: item.file_or_symbol, reason: item.reason };
  });
  return { findings, context_requests };
}

async function contextFile(selection: ReviewSelection, value: string): Promise<ContextFile> {
  if (path.isAbsolute(value) || /^[A-Za-z]:|\\/.test(value)) throw new Error('上下文必须是工作副本相对路径。');
  const target = path.resolve(selection.root, value);
  await checkPath(selection.scope, target);
  const content = await readBaseContent(selection.executable, selection.scope, selection.root, target);
  if (content.binary || content.symbolicLink || content.text === undefined) throw new Error('上下文不是普通文本文件。');
  return { file: relative(selection.root, target), version: 'BASE', content: content.text };
}

// No VS Code state or terminal output here: the host supplies a resolved
// selection, effective settings, key, prompt and cancellation signal.
export async function reviewSelection(
  selection: ReviewSelection, settings: AiSettings, apiKey: string, prompt: string, intent = '', signal?: AbortSignal
): Promise<ReviewResult> {
  const result: ReviewResult = {
    status: 'error', findings: [], context_requests: [], requests: 0,
    coverage: {
      root: selection.root, scope: selection.scope,
      selected: selection.explicit.map(target => relative(selection.root, target)),
      dependencies: selection.dependencies.map(target => relative(selection.root, target)),
      files: [], binary: [], context: []
    }
  };
  try {
    const files = await collect(selection);
    result.coverage.files = files.map(item => item.file);
    result.coverage.binary = files.filter(item => item.content.binary).map(item => item.file);
    const basis = JSON.stringify(files);
    const contexts: ContextFile[] = [];
    const unchanged = async () => {
      try {
        if (JSON.stringify(await collect(selection)) !== basis) return false;
        for (const item of contexts) {
          if (JSON.stringify(await contextFile(selection, item.file)) !== JSON.stringify(item)) return false;
        }
        return true;
      } catch { return false; }
    };
    const stale = () => { result.status = 'stale'; result.error = '审查依据已变化，请重新审查。'; return result; };
    const request = async () => {
      const messages = buildMessages(prompt, selection.root, files, contexts, intent);
      if (messages.system.length + messages.user.length > maxInputCharacters) throw new Error('审查输入超过 60,000 字符，请缩小提交选择。');
      if (signal?.aborted) throw new Error('审查已取消。');
      result.requests++;
      return parseReview(await requestMessages(settings, apiKey, messages, signal), files, contexts);
    };
    if (!await unchanged()) return stale();
    let review = await request();
    if (!await unchanged()) return stale();
    const unresolved: ContextRequest[] = [];
    for (const item of review.context_requests) {
      try {
        const target = path.resolve(selection.root, item.file_or_symbol);
        // Selected files already have their complete submitted text in the input.
        if (files.some(file => pathKey(file.change.path) === pathKey(target))) throw new Error('已提供所选文件内容，无法进一步解析符号。');
        const content = await contextFile(selection, item.file_or_symbol);
        if (!contexts.some(file => file.file === content.file)) contexts.push(content);
      } catch {
        unresolved.push(item);
      }
    }
    if (contexts.length) {
      result.coverage.context = contexts.map(item => item.file);
      if (!await unchanged()) return stale();
      review = await request();
      if (!await unchanged()) return stale();
    }
    result.findings = review.findings;
    result.context_requests = [...unresolved, ...review.context_requests]
      .filter((item, index, all) => all.findIndex(other => other.file_or_symbol === item.file_or_symbol) === index).slice(0, 3);
    result.coverage.context = contexts.map(item => item.file);
    result.status = result.context_requests.length || result.coverage.binary.length ? 'incomplete' : result.findings.length ? 'findings' : 'clean';
    return result;
  } catch (error) {
    result.status = 'error';
    const message = error instanceof Error ? error.message : String(error);
    result.error = apiKey ? message.split(apiKey).join('[已隐藏]') : message;
    return result;
  }
}
