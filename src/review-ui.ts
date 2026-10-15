import * as path from 'node:path';
import * as vscode from 'vscode';
import { ReviewLocation, ReviewResult, ReviewSession } from './review';

const reviewScheme = 'codeSvnReview';
export type ReviewEntryStatus = ReviewResult['status'] | 'running' | 'cancelled' | 'used' | 'replaced';

export interface ReviewEntry {
  id: number;
  key: string;
  root: string;
  status: ReviewEntryStatus;
  session?: ReviewSession;
  result?: ReviewResult;
  model?: string;
  commitMessage: string;
  intent: string;
  configurationFingerprint?: string;
  staleReason?: string;
}

type NodeAction = 'report' | 'finding' | 'review' | 'commit';

interface ReviewNode extends vscode.TreeItem {
  entry: ReviewEntry;
  isRoot?: boolean;
  action: NodeAction;
  index?: number;
  finding?: ReviewResult['findings'][number];
}

export class ReviewResults implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ReviewNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly snapshots = new Map<string, string>();
  private readonly records = new Map<string, ReviewEntry>();
  private readonly tree: vscode.TreeView<ReviewNode>;
  private nextSnapshot = 1;

  constructor(
    private readonly entries: () => Iterable<ReviewEntry>,
    private readonly rerun: (key: string) => void,
    private readonly commit: (key: string, id: number) => void
  ) {
    this.tree = vscode.window.createTreeView('codeSvn.reviewResults', { treeDataProvider: this });
  }

  getTreeItem(node: ReviewNode): vscode.TreeItem { return node; }

  getParent(node: ReviewNode): ReviewNode | undefined {
    return node.isRoot ? undefined : this.rootNode(node.entry);
  }

  getChildren(node?: ReviewNode): ReviewNode[] {
    if (!node) {
      return [...this.entries()].map(entry => this.rootNode(entry));
    }
    if (node.action !== 'report') return [];
    const entry = node.entry;
    const items: ReviewNode[] = [];
    const result = entry.result;
    result?.findings.forEach((finding, index) => items.push(this.node(entry,
      `[${finding.severity}] ${finding.title}  ${finding.file}:${finding.line_start}`, 'finding',
      vscode.TreeItemCollapsibleState.None, index, finding)));
    items.push(this.node(entry, `已审查：${result?.coverage.files.length ?? 0} 项文本变更`, 'report', vscode.TreeItemCollapsibleState.None));
    items.push(this.node(entry, '查看完整审查报告', 'report', vscode.TreeItemCollapsibleState.None));
    if (entry.status === 'clean' || entry.status === 'findings' || entry.status === 'incomplete') {
      items.push(this.node(entry, '重新审查', 'review', vscode.TreeItemCollapsibleState.None));
      items.push(this.node(entry, '提交此审查选择…', 'commit', vscode.TreeItemCollapsibleState.None));
    }
    return items;
  }

  async activate(node: ReviewNode): Promise<void> {
    if (node.action === 'review') { this.rerun(node.entry.key); return; }
    if (node.action === 'commit') { this.commit(node.entry.key, node.entry.id); return; }
    if (node.action === 'finding' && node.finding && node.entry.session) {
      const location = node.entry.session.snapshot(node.finding);
      await this.openSnapshot(node.entry, location);
      return;
    }
    await this.show(node.entry);
  }

  async show(entry?: ReviewEntry): Promise<void> {
    const target = entry ?? [...this.entries()].at(-1);
    if (!target) return;
    const uri = this.reportUri(target);
    this.records.set(target.id.toString(), target);
    await this.openText(uri, 1);
    await this.tree.reveal(this.rootNode(target));
  }

  refresh(entry?: ReviewEntry): void {
    this.changed.fire(undefined);
    if (entry) this.changed.fire(this.node(entry, `${path.basename(entry.root)} · ${this.statusLabel(entry)}`, 'report', vscode.TreeItemCollapsibleState.Expanded));
    if (entry) void this.changedReport(entry);
  }

  private async changedReport(entry: ReviewEntry): Promise<void> {
    this.records.set(entry.id.toString(), entry);
    this.changedDocument.fire(this.reportUri(entry));
  }

  private readonly changedDocument = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changedDocument.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.authority.startsWith('snapshot-')) return this.snapshots.get(uri.toString()) ?? '该审查快照已关闭。';
    const entry = this.records.get(uri.authority);
    if (!entry) return '该审查结果已替换。请重新运行审查。';
    return this.report(entry);
  }

  async openWorkingFile(entry: ReviewEntry, finding: ReviewResult['findings'][number]): Promise<void> {
    const target = path.join(entry.root, ...finding.file.split('/'));
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(target));
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(document, { preview: false, selection: this.range(finding.line_start, finding.line_end) });
    } catch {
      void vscode.window.showInformationMessage('该文件已删除或无法打开；可查看审查时的只读代码快照。');
    }
  }

  private async openSnapshot(entry: ReviewEntry, location: ReviewLocation): Promise<void> {
    const uri = vscode.Uri.from({ scheme: reviewScheme, authority: `snapshot-${entry.id}-${this.nextSnapshot++}`, path: `/${location.file}`, query: location.side });
    this.snapshots.set(uri.toString(), location.text);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false, selection: this.range(location.lineStart, location.lineEnd) });
  }

  private async openText(uri: vscode.Uri, line: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false, selection: this.range(line, line) });
  }

  private range(start: number, end: number): vscode.Range {
    return new vscode.Range(Math.max(0, start - 1), 0, Math.max(0, end - 1), 0);
  }

  private report(entry: ReviewEntry): string {
    const result = entry.result;
    const output = [`SVN 审查结果：${this.statusLabel(entry)}`, `工作副本：${entry.root}`,
      `模型：${entry.model ?? '未配置'}`, `提交信息：${entry.commitMessage || '（空）'}`];
    if (entry.staleReason) output.push(`过期原因：${entry.staleReason}`);
    if (!result) return output.join('\n') + '\n\n审查尚未完成。';
    output.push(`管理范围：${(result.coverage.scopes ?? [result.coverage.scope]).join('、')}`,
      `提交选择：${result.coverage.selected.join('、') || '（空）'}`,
      `已审查文本变更：${result.coverage.files.length} 项`,
      `模型请求：${result.requests} 次`);
    if (result.error) output.push('', `说明：${result.error}`);
    for (const [index, finding] of result.findings.entries()) {
      output.push('', `${index + 1}. [${finding.severity}] ${finding.title}`,
        `位置：${finding.file}:${finding.line_start}-${finding.line_end} (${finding.side})`,
        `触发：${finding.trigger}`, `证据：${finding.evidence}`, `后果：${finding.impact}`,
        `建议：${finding.suggestion}`, `验证：${finding.verification}`);
    }
    return output.join('\n');
  }

  private statusLabel(entry: ReviewEntry): string {
    if (entry.status === 'running') return '审查中';
    if (entry.status === 'cancelled') return '已取消';
    if (entry.status === 'used') return '已提交';
    if (entry.status === 'replaced') return '已替换';
    return ({ clean: '未发现符合要求的问题', findings: `发现 ${entry.result?.findings.length ?? 0} 个问题`,
      incomplete: '审查不完整', stale: '结果已过期', error: '审查失败' } as const)[entry.status];
  }

  private node(entry: ReviewEntry, label: string, action: NodeAction, collapsible: vscode.TreeItemCollapsibleState,
    index?: number, finding?: ReviewResult['findings'][number]): ReviewNode {
    const item = new vscode.TreeItem(label, collapsible) as ReviewNode;
    item.entry = entry; item.action = action; item.index = index; item.finding = finding;
    item.id = `${entry.id}:${action}:${index ?? ''}:${label}`;
    if (action !== 'report') item.command = { command: 'codeSvn.reviewActivate', title: label, arguments: [item] };
    if (action === 'finding') item.iconPath = new vscode.ThemeIcon(finding?.severity === 'high' ? 'error' : finding?.severity === 'medium' ? 'warning' : 'info');
    return item;
  }

  private reportUri(entry: ReviewEntry): vscode.Uri {
    return vscode.Uri.from({ scheme: reviewScheme, authority: entry.id.toString(), path: '/report.txt' });
  }

  private rootNode(entry: ReviewEntry): ReviewNode {
    const node = this.node(entry, `${path.basename(entry.root)} · ${this.statusLabel(entry)}`, 'report', vscode.TreeItemCollapsibleState.Expanded);
    node.isRoot = true;
    return node;
  }

  dispose(): void {
    this.tree.dispose(); this.changed.dispose(); this.changedDocument.dispose(); this.snapshots.clear(); this.records.clear();
  }
}
