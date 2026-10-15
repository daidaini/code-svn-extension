# SVN 提交前审查

只审查一次 SVN 提交选择中的变更，默认显示中文报告，支持 JSON。需要 Node.js 22+、SVN 1.14+，以及一个 OpenAI 兼容 Chat Completions 服务。

## 准备

在本项目根目录安装依赖并构建：

```sh
npm ci
npm run build
```

在要审查的管理目录下准备 `.vscode/settings.json`，可直接使用插件现有配置：

```jsonc
{
  "codeSvn.ai.baseUrl": "https://your-provider.example/v1",
  "codeSvn.ai.model": "your-model",
  "codeSvn.ai.timeoutSeconds": 60,
  "codeSvn.svnPath": "svn"
}
```

也可用 `--settings /path/to/settings.json` 指定现有的 VS Code 设置文件，支持注释和尾逗号。指定文件会替代默认文件；CLI 不自动解析 VS Code 用户、工作区、Profile 和 Remote 的配置层级，不读取 `.code-workspace` 的嵌套设置。`baseUrl` 不应带 `/chat/completions` 后缀。

密钥通过 `CODE_SVN_AI_API_KEY` 提供。插件保存的密钥位于 SecretStorage，独立 CLI 无法直接读取。可在 Bash/WSL 中用隐藏输入设置，避免将真实密钥写进命令历史：

```bash
read -r -s -p 'API Key: ' CODE_SVN_AI_API_KEY
export CODE_SVN_AI_API_KEY
echo
```

PowerShell 7.1+ 示例：

```powershell
$env:CODE_SVN_AI_API_KEY = Read-Host 'API Key' -MaskInput
```

## 使用

从本工具所在项目根目录运行，`--scope` 是需要审查的 SVN 目录，后面的文件或目录参数均相对该目录：

```sh
node tools/review.cjs --scope /path/to/svn-project src/service.ts src/model.ts
node tools/review.cjs --scope /path/to/svn-project src/ --intent '修复重复提交'
node tools/review.cjs --scope /path/to/svn-project --all
node tools/review.cjs --scope /path/to/svn-project --settings /path/to/settings.json --all --json
node tools/review.cjs --help
```

`--scope` 默认当前目录。文件按整体变更审查，目录参数和 `--all` 展开已版本管理的变更，不包含未跟踪子项。显式指定未跟踪文件或目录会报错，先手动执行 `svn add`。新增父目录和移动源会作为依赖列出；依赖超出管理范围时停止。目录属性、整体目录删除以及复制/移动均纳入输入。CLI 可审查普通文件删除，不改变插件当前可提交的状态范围。

单次只处理一个工作副本，不跨越范围、externals 或嵌套工作副本。选择在启动时固定，不读取插件面板中的内存选择或编辑器未保存内容；先保存文件，再按相同路径选择运行。

提示词来自 [review_prompt.md](review_prompt.md)。模型最多返回三个 high 置信度问题；上下文不足时最多自动补充一次范围内文本文件的 BASE，不发送其未选择的本地修改。文件路径相对工作副本根。无法解析的符号或路径、二进制等会明确保留为未完成的审查部分。每次请求最多 60,000 字符，超限需缩小选择。

所选文本、属性、复制信息以及允许补充的 BASE 代码会发送给配置的模型服务。二进制不发送内容。工具本身不运行测试或编译，提示词中的检查结果明确为未执行。

## 输出与退出码

| 退出码 | 含义 |
|---|---|
| 0 | 已提供范围内未发现符合提示词要求的问题 |
| 1 | 发现问题 |
| 2 | 配置、SVN、模型服务、结果格式、不支持状态或超限错误 |
| 3 | 审查不完整：仍缺上下文或存在未分析二进制内容 |
| 4 | 审查依据发生变化，结果已过期 |
| 130 | 用户通过 Ctrl+C 取消 |

存在问题且审查不完整时返回 `3`，问题仍保留。空问题列表不代表代码没有缺陷。返回前会核对已审查输入是否变化；这无法检测修改后又恢复原样的情况，之后继续编辑也需要重新审查。

`--json` 将单个结果对象写到 stdout，包括失败结果。`findings` 和 `context_requests` 遵循提示词结构，另外包含 `status`、`requests`、`coverage` 以及可选 `error`。`coverage.selected` 是提交选择，`dependencies` 是必需依赖，`files` 是实际输入项，`binary` 是未分析内容，`context` 是补充的 BASE 文件。重定向时可把报告保存到审查范围外：

```sh
node tools/review.cjs --scope /path/to/svn-project --all --json > /tmp/svn-review.json
```

## 共享接口与验证

[review.ts](../src/review.ts) 提供不依赖 VS Code 的 `resolveReviewSelection`、`reviewSelection` 和 `reviewExitCodes`。后续插件可以直接传入自身已解析的提交选择、有效模型配置和 SecretStorage 密钥，复用审查核心；本轮未增加按钮或自动提交。

```sh
npm run typecheck
npm run build
node --test --test-concurrency=1 test/review-cli.test.cjs
```

测试需要 `svnadmin`，会创建临时本地仓库和本地 HTTP 服务，不调用真实远程模型。[完整设计](review-cli-design.md) 记录输入版本、状态与集成边界。
