# Issue tracker: GitHub

账号：HD-yubo（daidaini/code-svn-extension 的 Write 协作者）
仓库：daidaini/code-svn-extension

使用 gh CLI。执行前确认当前登录账号为 HD-yubo；
所有仓库操作显式指定目标仓库，不依赖本地 remote。

规格和任务发布为 GitHub Issues。
多行正文使用 UTF-8 临时文件及 --body-file。
发布任务时应用 ready-for-agent 标签。

任务按依赖顺序发布，优先使用原生阻塞关系；
不可用时在正文记录 Blocked by 和实际 issue 编号。
从已有 issue 拆出的任务使用 sub-issue 关系。
仅当前置任务全部完成时开始被阻塞任务。

PRs as a request surface: no.
