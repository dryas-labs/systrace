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
本版 VSIX 内置当前平台的 `sysml-lsp`、`sysml-grpc`、标准库、许可证和对应引擎源码。
0.1.26 使用 `v0.9.2-dryas.6`：选中补全候选后，详情显示原生声明、引用名称、实际声明来源、
源文件名和完整的 `doc`。VSIX 内含匹配版本的引擎；如配置了外部引擎，需同时更新两个引擎程序；如果手动填写过
`dryas.expectedEngineVersion`，也要改为 `v0.9.2-dryas.6`。
安装所配置 language engine 需要的构建工具链后，可以运行：

```sh
node scripts/build-engine.mjs
```

脚本在忽略目录中获取并构建已指定的维护版本；已有的 `config.js` 会保留。
安装 VSIX 后，在编辑器的 **User Settings** 设置 `dryas.lspPath` 和 `dryas.apiPath`，
或将对应程序放进 PATH。不要把本机路径写入提交的工作区设置。

## 项目使用

打开一个可信项目文件夹，在 `model/` 中编写 `.sysml` 或 `.kerml`。
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

## Agent 诊断

在 VS Code Chat 中使用 `#systraceProblems`（`dryas_editor_diagnostics`）读取当前窗口已有的 SysML/KerML 问题，包括未保存修改、关联信息和诊断标签。结果包含所有诊断提供者，并保留各条诊断的来源。按工作区报告连接状态；断连后问题面板可能残留旧诊断。`observation: "editor"` 和 `index: "unconfirmed"` 表示观察结果，不代表完整验证。

外部 agent 使用便携 `sysml-diagnostics` 技能，其入口对已保存文件启动独立语言服务器：

```sh
node <技能目录>/scripts/run-diagnostics.cjs --project <模型目录>
```

适配器也提供 `dryas-lsp-diagnostics --project <模型目录> --lsp <可执行文件>`。`--overlay <已存在的相对文件路径>` 从标准输入读取 UTF-8 替换文本，不写入磁盘；`--path` 仅筛选输出，不缩小加载范围。显式项目在未配置模型目录时默认使用 `["."]`。结果标记为 `observation: "lsp-recompute"`，位置使用从 1 开始的 UTF-16 坐标。初始化成功后，观察超时返回部分结果、`settled: false` 和退出码 0；引擎缺失、初始化失败、协议错误及进程崩溃返回非零退出码。安静期或空结果不证明检查完整。MCP `validate` 继续使用已保存项目 API。

技能内含当前平台的引擎。`--lsp`、`SYSML_LSP_PATH` 和本地配置优先；否则依次查找内置运行时、编辑器用户设置中的 `dryas.lspPath` 和 PATH。`--engine-context` 显示选中的来源；`--configure-lsp <可执行文件>` 保存本机配置；`--vscode-settings <settings.json>` 指定自定义编辑器或 Profile。多个编辑器配置不同路径时需要明确选择。引擎必须能在 agent 环境中访问并执行。

打包在 `artifacts/` 生成同版本的 `dryas-systrace-<版本>.vsix` 和 `systrace-diagnostics-skill-<版本>.zip`。执行 `npm run package:vsix -- --engine-source <已构建引擎源码目录>`，或用 `--engine-dir <准备好的分发目录>`；默认使用 `.engine-ci`。打包校验引擎版本、源码提交、许可证和私人路径排除。技能说明与发现入口位于 `skills/sysml-diagnostics`，诊断脚本由 engine-adapter 源码构建。本机 `engine.local.json` 不进入产物。

开发检查支持通过 `DRYAS_LSP_PATH`、`DRYAS_API_PATH` 和 `DRYAS_VSCODE_PATH` 设置本机覆盖路径。`npm run test:host -- --vsix --bundled` 在独立编辑器配置中安装产物，不设置引擎路径，并在未保存编辑期间调用诊断工具。
