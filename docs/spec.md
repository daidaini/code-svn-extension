# SVN VS Code 插件首版：选择提交、路径历史与 AI 提交信息

## Problem Statement

用户使用 SVN 管理在 VS Code 中打开的项目，现有 SVN 插件不能满足其日常工作需求，尤其缺少足够的文件和目录提交历史查询，以及根据本次变更生成提交信息的 AI 入口。用户希望在编辑器内完成变更检查、准确选择提交范围、追查某次修改和撰写提交信息，减少在编辑器与终端之间切换。

项目可能只打开工作副本的一部分，也可能同时打开多个项目。提交操作必须遵守用户打开的管理范围，避免夹带未选变更；AI 草稿必须对应实际提交选择，避免内容变化后仍使用过期结果。Windows 和 WSL 均为首版目标环境。

## Solution

开发独立的 VS Code workspace 扩展，以源代码管理面板为主要入口，在工作区所在环境调用用户安装的 SVN 命令行工具。提供变更与差异、添加到 SVN、待提交选择、提交、更新和撤销；文件和目录右键可查询历史，并通过 VS Code 差异编辑器查看某次提交前后的内容。

AI 按钮只根据本次提交选择中的变更差异生成中文提交信息草稿。用户配置一套 OpenAI 兼容的模型服务，审阅或修改生成结果后手动提交。插件明确处理目录依赖、二进制文件、未保存内容、冲突、超限输入、取消和草稿过期。

交付源码、可安装的 VSIX、中文界面和使用说明，Windows 本地工作区与 VS Code WSL 工作区分别验收。

## User Stories

1. As a developer using Windows, I want to manage my SVN project inside VS Code, so that I can work without repeatedly switching tools.
2. As a developer using WSL, I want the same extension to manage my WSL workspace, so that my SVN workflow works in that environment.
3. As an SVN developer, I want the extension to use the SVN executable installed in my workspace environment, so that commands operate on the correct files and configuration.
4. As an SVN developer, I want to configure the SVN executable path, so that I can use an installation that is not discovered automatically.
5. As an SVN developer, I want a useful error when SVN is unavailable, so that I can correct my setup.
6. As an SVN developer, I want to open either a whole working copy or one of its subdirectories, so that I can focus on the part of the project I need.
7. As an SVN developer, I want local operations limited to my managed scope, so that opening a subdirectory does not affect its siblings.
8. As an SVN developer, I want different working copies displayed and committed separately, so that their changes cannot be mixed accidentally.
9. As an SVN developer, I want overlapping opened directories from one working copy merged and deduplicated, so that each change appears once.
10. As a developer using a mixed workspace, I want non-SVN directories excluded from SVN management, so that the source control view remains relevant.
11. As an SVN developer, I want nested working copies and externals excluded from automatic management, so that their ownership remains explicit.
12. As an SVN developer, I want to see file and directory changes, including property changes, so that I can understand all pending SVN changes.
13. As an SVN developer, I want automatic local status refresh and a manual refresh action, so that the change list stays current.
14. As an SVN developer, I want to inspect text and property differences before committing, so that I can review what will change.
15. As an SVN developer, I want unversioned files to require an explicit add-to-SVN action, so that adding and committing remain separate decisions.
16. As an SVN developer, I want newly discovered changes to start unselected, so that they do not enter my commit without my choice.
17. As an SVN developer, I want to add changes to or remove them from the commit selection, so that I can control one commit's scope.
18. As an SVN developer, I want selected changes presented as pending commit changes, so that I understand they do not have Git staging semantics.
19. As an SVN developer, I want each selected file committed as a whole, so that the first version provides a clear file-level workflow.
20. As an SVN developer, I want an empty commit selection to prevent commit and AI generation, so that neither action runs without a defined scope.
21. As an SVN developer, I want required added parent directories shown as commit dependencies, so that selected new files can be committed correctly.
22. As an SVN developer, I want dependencies outside the managed scope to stop the operation with an explanation, so that the extension does not silently expand my scope.
23. As an SVN developer, I want a directory deletion shown as one directory tree deletion with its affected descendants, so that I understand the entire operation.
24. As an SVN developer, I want directory properties committed without unrelated child changes, so that I can make focused commits.
25. As an SVN developer, I want moves, renames, and copies already recorded by SVN displayed correctly, so that I can review changes made through the terminal.
26. As an SVN developer, I want a save prompt for selected unsaved files before commit or AI generation, so that the analysis and SVN operation use saved content.
27. As an SVN developer, I want cancelling the save prompt to stop the action, so that my unsaved work remains under my control.
28. As an SVN developer, I want conflicts displayed and conflicted commit scopes blocked, so that unresolved conflicts are not submitted.
29. As an SVN developer, I want to resolve conflicts using VS Code or external tools and then refresh, so that I can continue with my existing merge workflow.
30. As an SVN developer, I want to update changes within the managed scope, so that I can synchronize the project area I opened.
31. As an SVN developer, I want a clear confirmation before reverting local changes, so that I know which files and directories will lose modifications.
32. As an SVN developer, I want unversioned files preserved during revert and added files retained when their addition is cancelled, so that local files are not deleted as a side effect.
33. As an SVN developer, I want competing write actions disabled for a working copy, so that operations do not overlap unpredictably.
34. As an SVN developer, I want failed operations to retain the commit selection and message, so that I can correct the problem without recreating my work.
35. As an SVN developer, I want committed items cleared and status refreshed only after confirmed commit success, so that the interface reflects the actual result.
36. As an SVN developer, I want commits to avoid automatic retries or forced cancellation, so that an uncertain result does not lead to unintended repeated operations.
37. As an SVN developer, I want the extension to use existing SVN authentication in the current environment, so that I can reuse my configured access.
38. As an SVN developer, I want terminal guidance when authentication or certificate trust is missing, so that I can configure access without the extension bypassing certificate checks.
39. As an SVN developer, I want to open history from a file or directory context menu, so that I can investigate the object I am working on.
40. As an SVN developer, I want history entries to show revision, author, time, and commit message, so that I can identify relevant changes.
41. As an SVN developer, I want directory history to include its descendants, so that I can investigate changes across that project area.
42. As an SVN developer, I want history ordered newest first with batches of 50 and a load-more action, so that I can browse long histories incrementally.
43. As an SVN developer, I want history to include the latest server records even before updating locally, so that I can see recent changes without modifying my working copy.
44. As an SVN developer, I want history to follow SVN-recorded copy and move ancestry, so that I can trace an object under earlier paths.
45. As an SVN developer, I want a selected revision to show the queried object's changed paths, so that unrelated changes in the same revision do not distract me.
46. As an SVN developer, I want historical differences opened in VS Code's diff editor, so that I can see what that commit changed.
47. As an SVN developer, I want to cancel history loading and distinguish failure from an empty history, so that I know the outcome of the query.
48. As an SVN developer, I want to configure one active model service with an API base URL, model name, and API key, so that I can use my selected OpenAI-compatible provider.
49. As an SVN developer, I want the API key stored using VS Code SecretStorage, so that it is not kept as an ordinary settings value.
50. As an SVN developer, I want AI generation and commit to use the same commit selection, so that the generated message describes the intended commit.
51. As an SVN developer, I want AI input to include selected text and property differences, so that relevant SVN changes are represented.
52. As an SVN developer, I want binary files represented only by path and change type with a clear limitation, so that I know their contents were not analyzed.
53. As an SVN developer, I want oversized text input rejected with guidance to reduce my selection, so that the extension does not silently omit part of the changes.
54. As an SVN developer, I want a Chinese message draft with a short title and optional change bullets, so that I have a useful starting point for my commit message.
55. As an SVN developer, I want the complete draft returned from one non-streaming request, so that generation has a straightforward result.
56. As an SVN developer, I want confirmation before an AI draft replaces existing input, so that my written message is preserved unless I choose otherwise.
57. As an SVN developer, I want to review and edit the draft before manually committing, so that I remain responsible for the final message and submission.
58. As an SVN developer, I want AI results discarded when the selection or relevant content changes during generation, so that outdated output is not inserted.
59. As an SVN developer, I want an existing AI draft marked stale when relevant content changes, so that I can regenerate it or explicitly confirm its continued use.
60. As an SVN developer, I want to cancel AI generation or receive a clear timeout or service error without losing existing input, so that I can decide whether to retry.
61. As an SVN developer, I want failures to require a manual retry, so that network requests and submissions are not repeated unexpectedly.
62. As an SVN developer, I want no automatic persistence of my commit selection across window restarts, so that a new session does not silently reuse a previous selection.
63. As an SVN developer, I want Chinese paths and paths containing spaces handled correctly, so that my existing projects can be managed reliably.
64. As an SVN developer, I want a Chinese interface, installation package, and usage instructions, so that I can install and use the extension independently.
65. As an SVN developer, I want Windows and WSL acceptance results recorded separately, so that support claims match actual evidence.
66. As an SVN developer, I want real provider compatibility checked in addition to controlled-service tests, so that AI generation works with the service I configure.

## Implementation Decisions

- **运行方式**：采用 TypeScript workspace 扩展，在工作区所在环境执行 SVN；Windows 使用 Windows SVN，WSL 使用 Linux SVN。用户负责安装对应 CLI，可以配置可执行文件路径。
- **模块职责**：扩展入口与视图负责公开命令、源代码管理面板、提示和历史入口；SVN 调用模块负责命令执行、解析、差异与结果；工作副本和提交选择模块负责管理范围、去重、依赖和互斥；AI 模块负责配置、请求和草稿生命周期；历史模块负责对象历史、分页及修订内容。
- **管理范围**：同一工作副本的管理范围取当前窗口所有打开目录的并集，合并去重；不同工作副本独立展示和提交。发现更高层工作副本根不会自动扩大操作范围。非 SVN 目录、未接管的嵌套工作副本和 externals 不加入自动管理。
- **提交选择**：新变更默认未选择，未跟踪文件须显式添加后才能加入待提交。提交和 AI 共用同一份提交选择，文件按整体提交，界面不使用 Git 暂存区语义。首版不主动跨窗口重启保存提交选择。
- **目录与依赖**：展示新增、修改、删除和属性变化。新增父目录作为明确展示的必需依赖；整体目录删除包含全部后代，不可伪装成独立子文件删除提交。依赖超出管理范围时阻止操作。
- **提交目标**：使用显式目标及适当深度，防止递归带入未选择子项；不得忽略目录属性。移动、重命名和复制只展示 SVN 已记录的关系，暂不提供专门入口，也不从普通资源管理器重命名自动推断关系。
- **提交前检查**：检查选择、依赖、冲突和未保存内容；选中文件未保存时提示保存这些文件，取消则停止。提交范围内存在冲突时阻止提交，由用户通过现有工具解决并标记后刷新。
- **操作结果**：同一工作副本写操作互斥，自动刷新本地状态且提供手动刷新。失败保留选择与输入；提交必须确认产生修订并刷新状态后才显示成功及清理已提交项，不能仅依赖退出码。提交不提供强制中断或自动重试。
- **撤销**：执行前明确确认范围及丢弃的修改。未跟踪文件不被顺带删除；取消添加时保留本地文件。
- **认证**：使用 SVN 当前运行环境的既有认证配置；缺少认证或证书信任时，引导用户在同一环境终端配置。不另做 SVN 账号管理，不自动忽略证书错误，不自动解决冲突或更新后重试提交。
- **历史契约**：文件或目录右键进入，最新优先，每批 50 条，可加载更多。显式查询服务器最新记录，不依赖本地默认修订范围；沿 SVN 保留的复制或移动关系追溯旧路径。历史查询可沿对象谱系跨旧路径，但修订详情不混入该次提交中与对象无关的变化。
- **历史差异**：记录包含修订号、作者、时间、提交信息和相关变更路径，目录包含子项。差异展示所选提交前后的变化，由 VS Code 差异编辑器呈现。查询可取消，失败不能被解释为空历史。
- **模型契约**：一套有效配置包含 API Base URL、模型与 API Key。API Key 使用 SecretStorage；采用 OpenAI 兼容 Chat Completions 请求和非流式返回，一次请求生成完整草稿，支持超时和取消，失败后用户手动重试。第三方兼容性以实际配置的服务验证。
- **AI 输入边界**：仅提供本次提交选择及明确依赖的变更差异，包含文件和目录属性差异。二进制仅提供路径和变更类型，并说明未分析内容。文本超限则停止并提示缩小选择，不静默截断、不分段多请求总结。
- **草稿契约**：默认中文短标题，必要时附变更要点，固定格式且不强制 Conventional Commits。已有输入替换前确认，生成结果不自动提交。请求过程中选择或相关内容变化，返回结果不填入；生成后相关内容变化，必须提示过期，由用户重新生成或明确确认继续使用。
- **进程与路径**：命令使用参数传递，避免 shell 拼接用户路径。中文路径、空格路径和编码需在实际扩展进程中验证，不能把当前 PowerShell 调用链的结果直接当作 Node.js 进程行为。
- **交付**：源码、VSIX、中文界面与说明齐全；Windows 和 WSL 均需实际操作验收。
- **仍由实现验证的细节**：具体命令参数、超时默认值、输入上限和编码策略依据实际行为确定。任何输入上限均不得被当作对所有模型上下文容量的保证。这些实现细节不改变已经确认的功能边界。
- **既有架构决定**：遵守 AI 以提交选择为输入边界、在工作区所在环境执行 SVN、以打开目录并集作为管理范围这三项已确认的 ADR。

## Testing Decisions

### 测试边界与原则

用户已确认：以 **VS Code 扩展公开命令及用户可见结果** 为一个主要测试入口，使用隔离 SVN 仓库和可控模型服务验证完整流程，不测试私有函数或内部调用次数。

测试通过用户能够触发的操作观察变更列表、待提交状态、提示、提交输入、历史与差异内容，以及仓库和工作副本的实际结果。一个良好测试能证明用户故事成立，并在出现真实行为回归时失败；不依赖私有模块布局、辅助函数命名或请求实现的内部顺序。

当前没有插件代码或既有自动化测试边界，不新增仅为测试而存在的业务层入口。工作副本识别、提交选择、SVN 操作、历史、AI 和视图均通过该主要入口覆盖。隔离仓库、可控 HTTP 服务和测试宿主为环境夹具，不为各个内部模块再建立一套平行测试入口。

### 环境夹具与覆盖

- **隔离 SVN 仓库**：准备多个工作副本，用于可控更新、冲突及服务器新增历史。包含文本、二进制、属性变化、新增父目录、整体目录删除、未选兄弟变更、复制和移动历史，以及超过 50 条的对象历史。
- **管理范围**：验证完整工作副本、子目录、多根工作区、重叠目录、非 SVN 目录、嵌套工作副本和 externals。提交、更新、撤销均不操作管理范围外的变更；依赖超出范围时明确停止。
- **提交准确性**：提交一个选定文件后检查仓库修订及未选文件仍保留本地修改；单独提交目录属性不夹带子文件。整体目录删除按完整子树展示和执行。验证零退出码但没有产生提交时不显示成功。
- **交互与状态**：未保存文件确认保存或取消；冲突阻止提交；撤销确认或取消；同时写操作被阻止；失败保留输入和选择，成功才清理实际已提交项。
- **历史行为**：验证服务器最新记录、分页不重复不遗漏、复制或移动前记录、对象范围过滤和提交前后内容。取消及失败不显示为成功或无历史。
- **可控模型服务**：捕获请求以证明只有选中差异与依赖进入输入，包含属性变化，二进制仅有路径和状态。使用延迟响应测试请求中选择或内容变化，使用失败、超时与取消测试保留原输入，验证已有输入替换确认、生成后过期确认及不自动提交。
- **输入上限**：完整输入可容纳时全部发送；超限停止且不发出被截断或分段的请求。验证二进制提示明确，不能把无文本 diff 解释为没有变化。
- **实际路径**：在扩展进程中复测中文和空格路径，以及当前 CLI 调用链已发现的中文绝对路径失败现象。验证正确对象被查询和操作，不仅检查进程退出码。
- **认证和证书**：验证缺少访问条件时的提示及同环境终端指引，不能把网络权限错误归为无历史，也不能自动忽略证书错误。
- **真实工作副本**：用户授权的业务文档工作副本用于只读识别、状态、差异和历史验证；添加、提交、更新、撤销等写操作使用隔离测试仓库。
- **真实模型服务**：可控服务测试后，对使用者实际配置的一家厂商验证兼容性和生成结果；API Key 不需要写入规格或聊天。
- **双环境交付**：安装同一 VSIX，在 Windows 和 VS Code WSL 分别执行关键用户流程并记录结果；模拟服务或 Windows 的通过不能代替真实厂商及 WSL 通过。

### 既有证据与完成标准

当前没有可复用的插件测试先例。已有的只读 CLI 验证和隔离仓库探针是测试场景依据：它们确认了新增父目录依赖、目录整体删除、目录属性差异、无修订的成功退出情况，以及未跟踪和二进制文件的差异限制。业务文档工作副本确认了状态、属性差异、目录和文件历史、历史差异摘要，并暴露中文路径调用问题。

上述 CLI 证据不等于扩展测试通过。完成标准是源码和可安装 VSIX 交付，既定用户故事得到对应行为验证，Windows 与 WSL 有实际验收结果，一家真实模型服务有兼容性结果；最终记录明确区分通过、失败和未验证。缺少测试条件时保留未验证状态，不宣称全部完成。

## Out of Scope

- 首版目标为 Windows 和 VS Code WSL；其他运行环境不在本次验收范围。
- 按代码块或行提交，以及 Git 暂存区语义。
- 自动接管嵌套工作副本和 externals；自动扩大到未打开的工作副本范围。
- 移动、重命名和复制的专用 UI，或自动把普通资源管理器重命名转换成 SVN 移动。
- 独立冲突合并界面、自动解决冲突、自动更新后重试提交。
- SVN 账号管理界面、自动忽略证书错误。
- 复杂历史筛选、跨无关对象混合展示提交差异。
- 多套同时有效的模型服务配置、AI 自动提交、流式返回、分段多请求总结、静默截断输入、分析二进制内容。
- 首版自定义提交信息格式或强制 Conventional Commits。
- 提交自动重试、强制中断提交和主动跨窗口重启保存提交选择。
- 对真实业务工作副本执行本轮验证所不需要的写操作。

## Further Notes

- 本规格综合 Q1–Q23 已确认选择、领域术语、三项 ADR 和后续真实工作副本验证，不发起新的功能访谈。
- 测试入口已由用户明确确认。当前仅有设计文档和 CLI 验证证据，没有插件源码、安装包或已通过的扩展验收。
- 当前开发机器有 Windows SVN 和 VS Code；WSL 命令存在，但发行版枚举受权限限制，尚不能确认实际 WSL 验收环境。
- 真实工作副本存在待新增、已修改、未跟踪及属性变更，主要是二进制内容。它适合只读验证，但不能替代隔离仓库中的文本和写操作场景。
- 中文绝对路径在当前 PowerShell 到 SVN 的调用链中失败，切换工作目录并使用相对目标可成功；路径存在且字符一致，精确原因仍待定位。真实扩展进程需要独立验证。
- 文件和目录服务器历史已验证可以超过工作副本本地修订号，支持显式查询最新记录的决定。
- Issue tracker 已配置为 GitHub 仓库 `daidaini/code-svn-extension`，使用 `HD-yubo` 账号（Write 协作者身份）；默认 triage 标签已配置。
- 本规格发布时应用 `ready-for-agent`，不需要额外 triage。任务草稿的拆分确认与逐票发布单独进行。
