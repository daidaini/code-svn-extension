#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const usage = `用法：node tools/review.cjs [选项] <文件或目录>...
      node tools/review.cjs [选项] --all

只审查 SVN 变更。路径参数相对 --scope；目录参数展开其下已版本管理的变更。
  --scope <目录>     管理范围，默认当前目录；单次只处理一个工作副本
  --all              选择范围内所有已版本管理的变更，不包含未跟踪文件
  --settings <文件>  设置 JSON/JSONC，默认 <scope>/.vscode/settings.json
  --intent <说明>    本次修改意图（可选）
  --json             输出机器可读 JSON，默认中文终端报告
  --help             显示用法
  --                 后续参数均按路径处理

模型设置：codeSvn.ai.baseUrl / codeSvn.ai.model / codeSvn.ai.timeoutSeconds
SVN 设置：codeSvn.svnPath（默认 svn）
密钥环境变量：CODE_SVN_AI_API_KEY（不读取 VS Code SecretStorage）
退出码：0 未发现问题；1 发现问题；2 失败；3 不完整；4 结果过期；130 取消。
`;

function argumentsFor(args) {
  const options = { scope: process.cwd(), paths: [], all: false, json: false, help: false };
  let literal = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (literal) { options.paths.push(arg); continue; }
    if (arg === '--') { literal = true; continue; }
    if (arg === '--all') options.all = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (['--scope', '--settings', '--intent'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数。`);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith('-')) throw new Error(`未知选项：${arg}；使用 --help 查看用法。`);
    else options.paths.push(arg);
  }
  options.scope = path.resolve(options.scope);
  return options;
}

// JSONC comments/trailing commas, preserving strings (URLs and escaped quotes).
function parseSettings(text) {
  const strings = '"(?:\\\\.|[^"\\\\])*"';
  const comments = new RegExp(`${strings}|/\\*[\\s\\S]*?\\*/|//[^\\r\\n]*`, 'g');
  text = text.replace(/^\uFEFF/, '').replace(comments, token => token.startsWith('/') ? ' ' : token);
  text = text.replace(new RegExp(`(${strings})|,(\\s*[}\\]])`, 'g'), (token, string, closing) => string ?? closing);
  const settings = JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('设置文件必须是 JSON 对象。');
  return settings;
}

async function configuration(options) {
  const file = options.settings ? path.resolve(options.settings) : path.join(options.scope, '.vscode', 'settings.json');
  let values = {};
  try { values = parseSettings(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (options.settings || error.code !== 'ENOENT') throw new Error(`无法读取设置 ${file}：${error.message}`);
  }
  const baseUrl = values['codeSvn.ai.baseUrl'];
  const model = values['codeSvn.ai.model'];
  const timeoutSeconds = values['codeSvn.ai.timeoutSeconds'] ?? 60;
  const executable = values['codeSvn.svnPath'] ?? 'svn';
  if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl.trim()) || typeof model !== 'string' || !model.trim()) {
    throw new Error(`请在 ${file} 配置 codeSvn.ai.baseUrl（http(s) 地址）和 codeSvn.ai.model，或用 --settings 指定现有设置文件。`);
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new Error('codeSvn.ai.timeoutSeconds 必须在 1 到 600 秒之间。');
  if (typeof executable !== 'string' || !executable.trim()) throw new Error('codeSvn.svnPath 必须是非空的 SVN 可执行文件路径。');
  const apiKey = process.env.CODE_SVN_AI_API_KEY?.trim();
  if (!apiKey) throw new Error('请设置环境变量 CODE_SVN_AI_API_KEY；独立 CLI 无法读取 VS Code SecretStorage。');
  return { settings: { baseUrl: baseUrl.trim(), model: model.trim(), timeoutSeconds }, executable, apiKey };
}

function report(result) {
  const labels = {
    clean: '已提供范围内未发现符合提示词要求的问题。', findings: '发现审查问题。',
    incomplete: '审查不完整，请检查本次审查范围。', stale: '审查结果已过期，请重新审查。', error: '审查失败。'
  };
  const lines = [labels[result.status]];
  if (result.error) lines.push(result.error);
  if (result.coverage) {
    lines.push(`管理范围：${result.coverage.scope}`, `提交选择：${result.coverage.selected.join('、')}`);
    lines.push(`已审查 ${result.coverage.files.length} 项文本变更；模型请求 ${result.requests} 次。`);
  }
  for (const finding of result.findings) {
    lines.push('', `[${finding.severity}] ${finding.file}:${finding.line_start}-${finding.line_end} (${finding.side}) ${finding.title}`,
      `触发：${finding.trigger}`, `证据：${finding.evidence}`, `后果：${finding.impact}`,
      `修复：${finding.suggestion}`, `验证：${finding.verification}`);
  }
  return lines.join('\n');
}

async function main() {
  let json = process.argv.slice(2).includes('--json');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  let result;
  try {
    const options = argumentsFor(process.argv.slice(2));
    json = options.json;
    if (options.help || (!options.all && !options.paths.length)) {
      if (!options.help && json) throw new Error('没有提交选择，请指定文件、目录或 --all；使用 --help 查看用法。');
      process.stdout.write(usage);
      process.exitCode = options.help ? 0 : 2;
      return;
    }
    if (options.all && options.paths.length) throw new Error('--all 与显式路径不能同时使用。');
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('此工具需要 Node.js 22 或更新版本。');
    const config = await configuration(options);
    let core;
    try { core = require('../dist/review.js'); }
    catch { throw new Error('无法加载审查核心，请先在项目根目录执行 npm ci 和 npm run build。'); }
    const prompt = await fs.readFile(path.join(__dirname, 'review_prompt.md'), 'utf8');
    const selection = await core.resolveReviewSelection(config.executable, options.scope, options.paths, options.all);
    result = await core.reviewSelection(selection, config.settings, config.apiKey, prompt, options.intent, controller.signal);
    process.exitCode = core.reviewExitCodes[result.status];
  } catch (error) {
    result = { status: 'error', findings: [], requests: 0, error: error.message };
    process.exitCode = 2;
  } finally { process.removeListener('SIGINT', cancel); }
  if (controller.signal.aborted) process.exitCode = 130;
  const key = process.env.CODE_SVN_AI_API_KEY?.trim();
  if (key) result = JSON.parse(JSON.stringify(result), (_field, value) => typeof value === 'string' ? value.split(key).join('[已隐藏]') : value);
  const output = `${json ? JSON.stringify(result, null, 2) : report(result)}\n`;
  (json || !['error'].includes(result.status) ? process.stdout : process.stderr).write(output);
}

main().catch(() => { process.stderr.write('审查工具运行失败。\n'); process.exitCode = 2; });
