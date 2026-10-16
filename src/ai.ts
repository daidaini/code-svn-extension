import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathKey, within } from './commit-selection';
import { Change, ChangeContent, changeLabel, PropertyChange, PropertyValue, readDifference, readTextDifference } from './svn';

// Every selected change is described: text differences, property changes, added,
// deleted and directory items. Binary content is never sent, only its path and type.
// Conflicted, symlink and other special states are refused explicitly instead of
// sending a partial selection.

export interface AiSettings {
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
}

export interface DraftItem {
  heading: string;
  body: string;
}

export interface DraftInput {
  items: DraftItem[];
  // Paths whose binary content was left out; the user must be told about them.
  binary: string[];
  unsupported: string[];
}

export class AiCancelled extends Error {
  constructor() { super('生成已取消。'); }
}

export class AiTimeout extends Error {
  constructor(seconds: number) { super(`模型服务在 ${seconds} 秒内没有返回，请求已超时。`); }
}

const contextLines = 3;
// Cap on the LCS table; a larger middle degrades to one replace hunk, which still
// states the changed range, only less precisely.
const maxDiffCells = 1_000_000;

export const apiKeySecret = 'codeSvn.aiApiKey';

// Actionable configuration problems; an empty list means the service can be called.
export function configurationProblems(settings: AiSettings, apiKey: string | undefined): string[] {
  const problems: string[] = [];
  const baseUrl = settings.baseUrl.trim();
  if (!baseUrl) problems.push('未配置 API Base URL（codeSvn.ai.baseUrl）');
  else if (!/^https?:\/\//i.test(baseUrl)) problems.push('API Base URL 必须是 http(s) 地址');
  if (!settings.model.trim()) problems.push('未配置模型名称（codeSvn.ai.model）');
  if (!apiKey) problems.push('未保存 API Key（执行「SVN：配置 AI API Key」，密钥保存在 SecretStorage）');
  return problems;
}

// Change states that can be described. Conflicts, symbolic links and anything else
// are refused as a whole, because a partial description would misstate the commit.
const describedStates = ['modified', 'normal', 'added', 'deleted'];

function kindLabel(kind: 'file' | 'dir' | undefined): string {
  return kind === 'dir' ? '目录' : kind === 'file' ? '文件' : '路径';
}

function displayPath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/') || path.basename(target);
}

// Where a move or copy came from or went to, so the model reads both sides together.
function changeNote(root: string, change: Change): string {
  if (change.movedTo) return `（移动到 ${displayPath(root, change.movedTo)}）`;
  if (change.movedFrom) return `（移动自 ${displayPath(root, change.movedFrom)}）`;
  if (change.copiedFrom) return `（复制自 ${change.copiedFrom.repoPath}@r${change.copiedFrom.rev}）`;
  return '';
}

function propertyValueText(value: PropertyValue): string {
  if (value.encoding === 'text') return value.value;
  const bytes = Buffer.from(value.value, 'base64');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return `（非 UTF-8 的属性值，${bytes.length} 字节）`;
  }
}

function describeProperty(change: PropertyChange): string {
  const { before, after } = change;
  if (before && after) return `${change.name}：由 ${JSON.stringify(propertyValueText(before))} 改为 ${JSON.stringify(propertyValueText(after))}`;
  if (after) return `${change.name}：新增为 ${JSON.stringify(propertyValueText(after))}`;
  if (before) return `${change.name}：已删除（原为 ${JSON.stringify(propertyValueText(before))}）`;
  return change.name;
}

// Read each selected target's difference. Required parent directories and move sources
// are targets too, so they are described rather than left out. Anything outside the
// described states joins `unsupported`, and the caller refuses the whole request.
export async function collectDraftInput(
  executable: string, folders: string[], root: string, changes: Change[], targets: string[]
): Promise<DraftInput> {
  const items: DraftItem[] = [];
  const binary: string[] = [];
  const unsupported: string[] = [];
  for (const target of targets) {
    const display = displayPath(root, target);
    const change = changes.find(candidate => pathKey(candidate.path) === pathKey(target));
    const folder = folders.find(candidate => within(candidate, target));
    if (!change || !folder) { unsupported.push(`${display}：状态或管理范围已变化`); continue; }
    if (change.conflicted) { unsupported.push(`${display}：存在冲突`); continue; }
    if (!describedStates.includes(change.item)) { unsupported.push(`${display}：${changeLabel(change)}`); continue; }
    const label = `${changeLabel(change)}${changeNote(root, change)}`;
    if (change.item === 'deleted') {
      // A deleted item has no local content to read; its type and removal are the whole description.
      items.push({ heading: `${kindLabel(change.kind)}：${display}`, body: `变更类型：${label}` });
      continue;
    }
    const stat = await fs.lstat(target).catch(() => undefined);
    if (!stat) { unsupported.push(`${display}：本地文件不可读取`); continue; }
    if (stat.isSymbolicLink()) { unsupported.push(`${display}：符号链接`); continue; }
    if (!stat.isFile() && !stat.isDirectory()) { unsupported.push(`${display}：不是普通文件或目录`); continue; }
    const isDirectory = stat.isDirectory();
    const heading = `${kindLabel(isDirectory ? 'dir' : 'file')}：${display}`;
    let content: ChangeContent;
    try {
      content = await readDifference(executable, folder, change);
    } catch (error) {
      unsupported.push(`${display}：读取差异失败（${error instanceof Error ? error.message : String(error)}）`);
      continue;
    }
    if (!isDirectory && content.binary) {
      // Binary content is never sent; the path and change type are all the model gets.
      binary.push(display);
      items.push({ heading, body: `变更类型：${label}（二进制内容，未提供内容）` });
      continue;
    }
    const properties = content.properties.map(describeProperty);
    let diff = '';
    if (!isDirectory) {
      // An added file compares against nothing; a copy compares against its copy source.
      const before = content.base ?? (change.item === 'added' ? '' : undefined);
      if (content.text === undefined || before === undefined) { unsupported.push(`${display}：没有可比对的文本内容`); continue; }
      try {
        diff = isDiffTooLargeForLcs(before, content.text)
          ? await readTextDifference(executable, folder, target, display)
          : textDiff(display, before, content.text);
      } catch (error) {
        unsupported.push(`${display}：读取 SVN 文本差异失败（${error instanceof Error ? error.message : String(error)}）`);
        continue;
      }
    }
    if (change.item === 'modified' && !diff && properties.length === 0) {
      unsupported.push(`${display}：没有文本内容差异`);
      continue;
    }
    const parts = [`变更类型：${label}`];
    if (properties.length > 0) parts.push('属性变化：', ...properties.map(line => `- ${line}`));
    if (diff) parts.push('文本差异：', diff);
    items.push({ heading, body: parts.join('\n') });
  }
  return { items, binary, unsupported };
}

// Hard cap on one request. Oversized input is refused whole: never truncated, never
// split into several requests, since a partial summary would misstate the commit.
const maxInputCharacters = 60_000;

export function assertInputWithinLimit(items: DraftItem[]): void {
  const messages = buildMessages(items);
  const characters = messages.system.length + messages.user.length;
  if (characters > maxInputCharacters) {
    throw new Error(`本次待提交的变更内容约 ${characters} 字符，超过上限 ${maxInputCharacters} 字符，未发送请求。请缩小待提交选择后重新生成。`);
  }
}

// What a draft was generated from. Undefined when the input cannot be described at all.
export function draftBasis(input: DraftInput | undefined): string | undefined {
  if (!input || input.unsupported.length > 0) return undefined;
  return JSON.stringify(input.items);
}

function lines(text: string): string[] {
  const parts = text.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function isDiffTooLargeForLcs(before: string, after: string): boolean {
  const oldLines = lines(before);
  const newLines = lines(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endBefore = oldLines.length;
  let endAfter = newLines.length;
  while (endBefore > start && endAfter > start && oldLines[endBefore - 1] === newLines[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return (endBefore - start) * (endAfter - start) > maxDiffCells;
}

type Op = { kind: '-' | '+' | ' '; text: string };

function op(kind: '-' | '+' | ' ', text: string): Op {
  return { kind, text };
}

// Trim the common head and tail, then diff the middle; an oversized middle degrades.
function lineOps(before: string[], after: string[]): Op[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  const head = before.slice(0, start).map(line => op(' ', line));
  const tail = before.slice(endBefore).map(line => op(' ', line));
  const middleBefore = before.slice(start, endBefore);
  const middleAfter = after.slice(start, endAfter);
  const middle = middleBefore.length * middleAfter.length <= maxDiffCells
    ? lcsOps(middleBefore, middleAfter)
    : [...middleBefore.map(line => op('-', line)), ...middleAfter.map(line => op('+', line))];
  return [...head, ...middle, ...tail];
}

function lcsOps(before: string[], after: string[]): Op[] {
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * width + j] = before[i] === after[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) { ops.push(op(' ', before[i])); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { ops.push(op('-', before[i++])); }
    else ops.push(op('+', after[j++]));
  }
  while (i < before.length) ops.push(op('-', before[i++]));
  while (j < after.length) ops.push(op('+', after[j++]));
  return ops;
}

// Unified diff for the model to read, addressed relative to the working copy root.
export function textDiff(display: string, before: string, after: string): string {
  const ops = lineOps(lines(before), lines(after));
  const changed = ops.some(op => op.kind !== ' ');
  if (!changed) return '';
  const oldPosition: number[] = [];
  const newPosition: number[] = [];
  let old = 1;
  let updated = 1;
  for (const item of ops) {
    oldPosition.push(old);
    newPosition.push(updated);
    if (item.kind !== '+') old++;
    if (item.kind !== '-') updated++;
  }
  const groups: [number, number][] = [];
  for (let index = 0; index < ops.length; index++) {
    if (ops[index].kind === ' ') continue;
    const last = groups[groups.length - 1];
    if (last && index - last[1] - 1 <= 2 * contextLines) last[1] = index;
    else groups.push([index, index]);
  }
  const output = [`--- a/${display}`, `+++ b/${display}`];
  for (const [from, to] of groups) {
    const start = Math.max(0, from - contextLines);
    const end = Math.min(ops.length - 1, to + contextLines);
    let removed = 0;
    let added = 0;
    for (let index = start; index <= end; index++) {
      if (ops[index].kind !== '+') removed++;
      if (ops[index].kind !== '-') added++;
    }
    output.push(`@@ -${oldPosition[start]},${removed} +${newPosition[start]},${added} @@`);
    for (let index = start; index <= end; index++) output.push(`${ops[index].kind}${ops[index].text}`);
  }
  return output.join('\n');
}

export function buildMessages(items: DraftItem[]): { system: string; user: string } {
  const system = '你是版本管理助手。根据用户提供的一次 SVN 提交的变更说明（含文本差异与属性变化），用中文撰写提交信息草稿：'
    + '优先只输出一行简短标题，标题不超过 50 字，并以以下纯文本类型标记之一开头：[修复]、[需求]、[重构]、[优化]；无法判断时使用[变更]。'
    + '只有一行无法说明清楚时，才另起数行补充变更要点，每行以「- 」开头。'
    + '只输出提交信息本身，不要解释，不要 Markdown 格式或代码块。';
  const blocks = items.map(item => `### ${item.heading}\n${item.body}`);
  const user = `本次提交选择共 ${items.length} 项变更，逐项列出相对工作副本根的路径、变更类型，以及属性变化与文本差异。二进制文件只列出路径与变更类型，其内容未提供，不得推测。\n\n${blocks.join('\n\n')}`;
  return { system, user };
}

function chatEndpoint(baseUrl: string): URL {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  try {
    return new URL(`${trimmed}/chat/completions`);
  } catch (error) {
    throw new Error(`API Base URL 不是有效地址：${error instanceof Error ? error.message : String(error)}`);
  }
}

// An error body may echo the request, so it is truncated; the key is never logged.
function serviceDetail(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
  } catch {
    // A non-JSON error body is shown as is, truncated.
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 300) || '（空响应）';
}

function describeNetwork(error: unknown): string {
  const cause = (error as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? '';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return `无法解析模型服务地址（${code}）：请检查 codeSvn.ai.baseUrl 与本机网络。`;
  if (/CERT|UNABLE_TO_VERIFY|SELF_SIGNED|HOSTNAME/.test(code)) return '证书校验失败：插件不会忽略证书错误，请先在本机信任该服务证书。';
  if (code) return `${code}：请检查 codeSvn.ai.baseUrl、网络或代理设置。`;
  return error instanceof Error ? error.message : String(error);
}

// One non-streaming Chat Completions request; neither cancel nor timeout resends.
export async function requestDraft(
  settings: AiSettings, apiKey: string, items: DraftItem[], signal?: AbortSignal
): Promise<string> {
  return requestMessages(settings, apiKey, buildMessages(items), signal, '草稿');
}

// Shared transport; callers own their prompt and response validation.
export async function requestMessages(
  settings: AiSettings, apiKey: string, messages: { system: string; user: string },
  signal?: AbortSignal, responseName = '文本'
): Promise<string> {
  const endpoint = chatEndpoint(settings.baseUrl);
  const controller = new AbortController();
  let cancelled = false;
  let timedOut = false;
  const abort = () => { cancelled = true; controller.abort(); };
  signal?.addEventListener('abort', abort);
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, settings.timeoutSeconds) * 1000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: 'system', content: messages.system }, { role: 'user', content: messages.user }],
        stream: false
      }),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) {
      const guidance = [401, 403].includes(response.status) ? ' 请检查 API Key 与模型名称。' : '';
      throw new Error(`模型服务返回 HTTP ${response.status}：${serviceDetail(body)}${guidance}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('模型服务返回了无法解析的内容（不是 JSON）。');
    }
    const content = (parsed as any)?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error(`模型服务没有返回${responseName}内容。`);
    return content.trim().replace(/\r\n/g, '\n');
  } catch (error) {
    if (cancelled) throw new AiCancelled();
    if (timedOut) throw new AiTimeout(settings.timeoutSeconds);
    if (error instanceof Error && error.message.startsWith('模型服务')) throw error;
    throw new Error(`请求模型服务失败：${describeNetwork(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
