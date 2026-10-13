# DRYAS Systrace

[English](README.md) | **简体中文**

DRYAS Systrace 面向系统工程建模与工程数字主线。当前产品以 VS Code 扩展形式提供，
同时适配 Cursor，通过 language engine（语言引擎）提供 SysML v2 编辑能力，并通过 MCP 服务连接外部 agent。

当前开发版提供 LSP 接入和四个只读 MCP 工具：`validate`, `find_element`, `describe_element`, `library_lookup`。验证与项目查询使用已保存文件。目前未实现 view 渲染和内置 agent。这些工具不证明工程设计正确性或完整标准一致性。

## 开始开发

需要 Node.js 22.13 或更高版本（推荐 24 LTS）及 npm。

```sh
npm ci
npm run config:init
```

编辑新生成的 **`config.js`**，填写本机的 language engine 程序位置。它已被 `.gitignore` 排除，
不要提交。仓库只跟踪 [config.example.js](config.example.js)，里面是通用默认值和字段说明。
`config.js` 是本仓库开发脚本使用的可信本地 JavaScript 配置，不会从打开的模型项目中自动执行。

```sh
npm run check
npm run package:vsix
```

VSIX 输出在 `artifacts/`。在 VS Code 或 Cursor 中执行 **Extensions: Install from VSIX...** 安装。当前仓库不包含编辑器启动配置和示例项目。

当前引擎选择见 [Language engine](docs/language-engine.zh-Hans.md)。

## Language engine

[config/engine.json](config/engine.json) 记录开发引擎的版本和源码提交。
本版 VSIX 使用外部的 `sysml-lsp` 与 `sysml-grpc`，不包含引擎二进制或标准库。
0.1.10 使用 `v0.9.2-dryas.5`：选中补全候选后，详情显示原生声明、引用名称、实际声明来源、
源文件名和完整的 `doc`。升级时需要同时更新 VSIX 和两个外部引擎程序；如果手动填写过
`dryas.expectedEngineVersion`，也要改为 `v0.9.2-dryas.5`。
安装所配置 language engine 需要的构建工具链后，可以运行：

```sh
node scripts/build-engine.mjs
```

脚本在忽略目录中获取并构建已指定的维护版本；已有的 `config.js` 会保留。
安装 VSIX 后，在编辑器的 **User Settings** 设置 `dryas.lspPath` 和 `dryas.apiPath`，
或将对应程序放进 PATH。不要把本机路径写入提交的工作区设置。

## 项目使用

打开一个可信项目文件夹，在项目目录中编写 `.sysml` 或 `.kerml`。
可用 `dryas.modelRoots` 指定其他源码文件夹。插件提供补全、悬停、跨文件定义跳转和实时诊断。
对 `ISQ::voltage`、`ScalarValues::Integer` 等标准库名称按 F12，会打开引擎内置的只读源码；
可以继续在标准库中查看悬浮提示和跳转定义，无需另行下载标准库或复制到项目中。
阅读说明使用普通悬浮；Ctrl 悬浮仍是编辑器原生的短源码预览，不保证显示整个 `doc`。
SysML/KerML 默认关闭编辑器的单词猜测补全，避免已打开标准库中的普通词语混入候选；
LSP 的模型符号补全保持启用，用户自己的语言专项设置优先。

选中补全候选后，可点候选旁的详情箭头，或在补全列表已打开时再按 Ctrl+Space 展开说明。
列表中的名称与简短类型保持不变，完整说明按需加载。例如 `ISQ::voltage` 的引用名称
和实际声明 `ISQElectromagnetism::voltage` 会分别显示。别名和短名称仍按所选名称插入；
没有 `doc` 的元素只显示声明和来源。说明与普通悬浮共用引擎的文档提取逻辑，不生成推测内容。
连续输入同一个标识符可以复用候选；修改模型其他位置或重启引擎后，需要重新触发补全。

- `DRYAS: Restart Language Server`：重新加载引擎与项目配置。
- `DRYAS: Show Language Service Status`：查看连接状态、启动原因、启动次数和失败类型。
- `DRYAS: Validate Saved Project`：展示整个保存项目的诊断结果。
- `DRYAS: Show MCP Configuration`：生成供外部 agent 使用的本地配置，保存在版本控制之外。

LSP 可处理未保存内容；MCP 验证的是磁盘上的保存快照。诊断分页不会改变项目错误总数。
当前引擎 API 未提供完整性证明，因此零错误的结果仍为 `incomplete`。

状态栏的 **DRYAS: Connected** 只表示 LSP 已连接。当前维护版引擎没有索引完成通知，
插件会明确显示 `index: unconfirmed`，不会把连接成功说成索引就绪或模型校验通过。
刚连接时，跨文件跳转可能尚未可用。

连续修改引擎设置会在输入停顿 750 毫秒后合并处理，只重启生效配置改变的项目。
只改 API 路径会更新保存校验服务，保留 LSP 连接。手动重启立即处理。
输出面板的 **DRYAS** 会记录启动原因和失败阶段，并区分路径格式错误、找不到程序、
权限问题、版本不匹配和超时；这些状态消息不包含配置路径或原始进程异常。
图形设置中的程序路径不要带两端引号；JSON 设置文件中的引号和转义由 JSON 语法要求。

## 开发检查

| 命令                            | 内容                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `npm run check`                 | 本机信息检查、格式、lint、类型、构建和适配层单元测试   |
| `npm run test:engine`           | 真实 language engine 多文件验证及 MCP stdio 客户端测试 |
| `npm run test:host`             | 隔离的 VS Code 扩展宿主测试                            |
| `npm run test:host -- --cursor` | 使用 `config.js` 中指定的 Cursor，运行相同宿主测试     |
| `npm run watch`                 | 持续构建开发代码                                       |
| `npm run package:vsix`          | 构建并生成开发版 VSIX                                  |

宿主测试加 `--vsix` 时，会先把已打包的 VSIX 安装到隔离配置，再测试包内代码。
例如 `npm run test:host -- --cursor --vsix`。

测试日志、编辑器配置和构建产物保留在被忽略的本地目录，不进入源码提交。
GitHub Actions 会在 PR 和推送到 `main` 时，在 Windows 与 Linux 上执行代码检查、单元测试、真实引擎/MCP 测试及已打包扩展的 VS Code 宿主测试。成功的任务提供 VSIX 下载，保留 14 天。Cursor 宿主测试仍在本地运行。

## 代码组织

- `packages/extension`：编辑器插件和 LSP 客户端。
- `packages/engine-adapter`：引擎进程、保存快照和验证结果。
- `packages/mcp-server`：外部 agent 的只读工具入口。
- [产品架构](docs/architecture.zh-Hans.md)：当前架构和边界。

文档默认使用英文，每份使用指南顶部均提供英文和简体中文切换链接。
法律文本与自动生成的第三方声明保留原文。

## 许可证

DRYAS 自有代码采用 [Apache License 2.0](LICENSE)。源码中的
`SPDX-License-Identifier: Apache-2.0` 标记该文件的许可证。
构建根据实际打包的 JavaScript 依赖生成 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，
并将许可证与声明放入 VSIX。外部 language engine 及其标准库的许可证与发布清单另行管理。

## 项目管理

左侧独立的 **Systrace** 入口中的 **Projects** 列出工作区的本地项目文件夹。
通过 **New Systrace Project** 指定名称和父目录来新建项目，或用 **Open Systrace Project**
加入已有文件夹。每个文件夹就是项目 root。点击项目会将它设为保存校验和 MCP 配置的默认目标；
切换编辑器标签不会改变这个选择。其他项目仍可编辑。关闭项目只移除工作区条目并停止插件的相关服务，
不删除文件，也不改变外部 Agent 已有的 MCP 连接。保存 VS Code 工作区后可以重新打开项目列表。

模型可放在项目根目录或子目录中，`dryas.modelRoots` 默认是 `["."]`。
已经显式设置的 `["model"]` 等配置仍然生效；旧工作区需要使用新默认范围时，应修改或清除原设置。
可以通过文件夹级设置缩小源码范围。隐藏目录和 `node_modules` 与语言服务一样被排除；
`designs` 等普通目录可以包含模型。生成的模型文件应放在所配置的源码目录之外。
本版不提供自定义 glob 排除规则。

项目根目录必须互不嵌套，避免两个语言服务同时处理同一份源码。已有工作区包含重叠根目录时会明确报错，
不会把它们悄悄合并成一个模型。多个项目不会自动相互导入。

右键项目并选择 **Show MCP Configuration**，生成的连接绑定该项目 root 和源码目录。
之后切换当前项目不会改变已经交给 Agent 的配置。外部 Agent 的对话由其宿主管理，
插件不会创建或重新绑定这些对话。四个已有的只读 MCP 工具保持不变。
含本机路径的生成配置应保存在 Git 之外。

可用 `npm run test:host -- --projects --vsix` 运行隔离的双项目检查；
再加 `--cursor` 可在已配置的 Cursor 安装中执行相同检查。

## 项目树

点击左侧活动栏的 **Systrace** 图标，进入独立的项目侧栏。它与原生资源管理器分开。
默认源码范围下，文件和子目录直接显示在项目名称下面；单独配置的源码目录显示实际相对路径。
只读的 **Standard Library** 保持独立节点。
源码按目录和 `.sysml` / `.kerml` 文件组织；继续展开文件可浏览语言引擎返回的声明层级，
点击元素定位源码。元素层级随未保存的编辑刷新，文件增删会更新目录；顶部可手动刷新。

标准库目录按需从引擎取得，只列出当前项目上下文中引擎可见的库命名空间。
展开库节点可浏览声明并打开只读源码。命名覆盖可能影响可见目录；导入和重新导出的成员不会
作为声明重复展开。模型类型标签只显示引擎提供的信息，不根据源码文本猜测类型。
浏览其他项目或标准库不会重新绑定已有的 Agent 会话。

右键项目或源码目录，选择 **New Namespace…**，或使用项目视图顶部的同名操作。
输入名称后创建并打开同名 `.sysml` 文件，内容为对应的具名 `package`。项目配置多个源码目录时，
先选择创建位置。生成的 SysML 使用带引号的名称，支持空格和关键字。已有文件不会被覆盖。
文件名和包名后续可以分别修改。从其他项目的右键菜单创建时，不会改变当前项目或已有 MCP 绑定。
