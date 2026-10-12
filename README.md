# Code SVN

VS Code SVN 扩展。目前完成任务 01：查看一个打开目录内的 SVN 本地状态。
提交、差异、历史和 AI 功能将在后续任务实现；当前只展示多根工作区的第一个目录。

## 开发与运行

1. 安装 Node.js 22 或更新版本、VS Code 1.100 或更新版本，以及 SVN 1.14 CLI。
2. 执行 `npm ci`，再执行 `npm run build`。
3. 在 VS Code 中打开本项目，按 F5 启动「调试 Code SVN」。
4. 在新开的扩展开发窗口中打开 SVN 工作副本或其中一个子目录。
5. 打开源代码管理面板查看中文状态分组。命令面板执行「SVN：刷新变更」，或点击 SVN 面板刷新按钮。

默认调用工作区环境 PATH 中的 `svn`。如果安装在其他位置，在设置中配置
`codeSvn.svnPath` 为可执行文件完整路径，不添加命令参数或引号。例如：

```json
{ "codeSvn.svnPath": "C:\\Program Files\\SlikSvn\\bin\\svn.exe" }
```

扩展采用 workspace 运行方式。VS Code WSL 工作区需要在 WSL 内安装 Linux SVN，
路径也使用该环境路径；目前 WSL 实际运行尚未验收。

## 当前行为

- 只查询打开目录内的状态，不扩大到工作副本根或兄弟目录。
- 展示新增、修改、删除、缺失、未跟踪、属性修改及冲突。
- 不接管嵌套工作副本、目录 externals 或文件 externals；非 SVN 目录不显示 SVN 管理项。
- 文件变化触发刷新，同时每 5 秒检查状态，覆盖外部 SVN 操作。
- 查询失败时显示错误提示和状态栏警告，保留上次成功列表。通过「SVN：查看查询日志」查看原因；不能将失败后的旧列表视为最新状态。
- 查询超时为 20 秒；手动刷新和自动刷新串行执行。

## 验证

`npm run typecheck` 检查 TypeScript；`npm test` 构建并运行集成测试。
测试需要本机安装 SVN、svnadmin 和 VS Code，启动独立的真实 VS Code 窗口，
通过公开命令和 SCM 可见列表断言结果，不调用私有函数。
测试仓库、用户配置和扩展目录全部隔离于 `.test-artifacts/`，结束后清理。

Windows 自动从 PATH 中的 `code.cmd` 找到 VS Code 主程序；其他位置或 Linux
需设置 `VSCODE_EXECUTABLE`。也可设置 `SVN_EXECUTABLE`、`SVNADMIN_EXECUTABLE`。
VS Code 窗口需要可用的桌面会话。测试使用随机端口的本机 Chromium 调试连接。

已通过与未验证的结果见 [任务 01 验证记录](docs/task-01-validation.md)。
安装包及 Windows/WSL 的完整首版验收属于任务 15。
