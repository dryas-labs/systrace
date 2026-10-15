# DRYAS Systrace

[English](README.md) | **简体中文**

面向 VS Code 和 Cursor 的 SysML v2 编辑扩展，由内置 language engine（语言引擎）提供语言能力。
当前是早期开发版，尚未实现 view 渲染和内置 agent。

0.1.26 使用 language engine 构建 `v0.9.2-dryas.6`。选中补全候选后，详情显示原生声明、引用名称、
实际声明来源、源文件名和完整文档。说明按需加载，与普通悬浮共用引擎的文档提取逻辑。
别名保留原来的插入名称；没有文档的元素只显示声明和来源。
点击详情箭头，或在补全列表已打开时按 Ctrl+Space，可展开编辑器原生的详情面板。
如使用外部引擎覆盖配置，升级时请同时更新两个引擎程序；若显式设置过 `dryas.expectedEngineVersion`，
请改为 `v0.9.2-dryas.6`。

当前引擎选择见 [Language engine](../../docs/language-engine.zh-Hans.md)。

## 开始使用

1. 安装匹配操作系统和架构的 VSIX，其中已包含语言引擎。
2. 如需覆盖内置引擎，在编辑器 **User Settings** 中设置 **DRYAS: Lsp Path** 和 **DRYAS: Api Path**。不要把本机路径写入提交的工作区设置。
3. 打开可信的项目文件夹，把 SysML/KerML 文件放在 `model/` 中，或通过
   **DRYAS: Model Roots** 指定项目源码文件夹。
4. 打开 `.sysml` 文件，即可使用诊断、补全、悬浮提示和定义跳转。

此 VSIX 包含当前平台的引擎及其标准库。模型文件夹中的文件必须是可读取的 UTF-8 文件；
当前版本拒绝符号链接和 junction。本地的 `selection/`、`designs/` 归档必须位于配置的源码文件夹之外。

如果启动时出现 `INVALID_PATH during model-folders`，请检查工作区设置中的
**DRYAS: Model Roots**（多根工作区使用工作区文件夹设置）。默认值 `["model"]`
要求存在 `model/` 目录；其他目录结构需要显式设置相对于所打开工作区文件夹的路径。
例如，打开 `SysML-v2-Release` 后，编辑包相关教程可使用：

```json
{
  "dryas.modelRoots": ["sysml/src/training/01. Packages"]
}
```

请选择属于当前待编辑模型的源码文件夹。修改设置会自动重试连接；如果只是创建了缺失的目录，
没有修改设置，请执行 **DRYAS: Restart Language Server**。

对 `ISQ::voltage` 等标准库名称按 F12，会在只读编辑器中打开内置源码。
可以继续查看悬浮提示并跳转定义。源码由项目当前运行的引擎提供，无须另外下载标准库或复制到项目中。
阅读文档时使用普通悬浮；Ctrl 悬浮仍是编辑器的简短定义源码预览，可能只显示较长 `doc` 的开头。
SysML/KerML 默认设置 `editor.wordBasedSuggestions: "off"`，避免已打开库文件中的单词作为备用候选出现。
原生 LSP 补全保持启用；用户显式设置的语言专项配置优先。

## 命令

- **DRYAS: Restart Language Server**：重新加载引擎设置和源码文件夹。
- **DRYAS: Show Language Service Status**：显示连接状态、启动原因、尝试次数及启动失败代码。
  也可点击状态栏打开此视图。
- **DRYAS: Validate Saved Project**：在未命名文档中打开只读的验证结果。
- **DRYAS: Show MCP Configuration**：打开供外部 agent 使用的本地配置。
  配置包含运行时路径，请勿纳入版本控制。MCP CLI 需要 Node.js 22.13 或更高版本。

编辑器诊断可以包含未保存的缓冲区内容。MCP 和项目验证会读取全部模型根目录中的已保存文件。
MCP 服务提供四个只读工具：`validate`、`find_element`、`describe_element` 和 `library_lookup`。
其中 `library_lookup` 查询引擎内置标准库。

**Connected** 表示 LSP 握手成功。引擎没有索引完成通知，因此扩展显示 `index: unconfirmed`；
跨文件跳转可能仍在初始化。连接状态与模型验证状态相互独立。

设置修改会在停止输入 750 毫秒后生效，只有有效设置改变的项目才会重启。
只修改 API 路径会保留语言服务器连接。连接丢失后最多自动恢复一次，之后需要通过重启命令重试。

**DRYAS** 输出通道记录启动原因，并区分路径格式错误、找不到程序、访问失败、版本不符和超时。
在 Settings 界面填写程序路径时，不要加上两端引号；JSON 设置文件仍需正常的 JSON 引号和转义。

当前零错误的结果仍返回 `incomplete`，因为引擎 API 不提供完整验证覆盖或标准库身份的证明。
没有错误的响应不代表符合全部标准，也不证明任务正确或工程设计正确。

## 许可证

DRYAS 代码采用 Apache-2.0。许可证原文与打包的 JavaScript 依赖声明见
[LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
法律文本和第三方声明保留原文。

## Agent 诊断

在 VS Code Chat 中使用 `#systraceProblems`（`dryas_editor_diagnostics`）读取当前窗口已有的 SysML/KerML 问题，包括未保存修改、关联信息和诊断标签。结果包含所有诊断提供者，并保留各条诊断的来源。按工作区报告连接状态；断连后问题面板可能残留旧诊断。`observation: "editor"` 和 `index: "unconfirmed"` 表示观察结果，不代表完整验证。

外部 agent 使用便携 `sysml-diagnostics` 技能，其入口对已保存文件启动独立语言服务器：

```sh
node <技能目录>/scripts/run-diagnostics.cjs --project <模型目录>
```

适配器也提供 `dryas-lsp-diagnostics --project <模型目录> --lsp <可执行文件>`。`--overlay <已存在的相对文件路径>` 从标准输入读取 UTF-8 替换文本，不写入磁盘；`--path` 仅筛选输出，不缩小加载范围。显式项目在未配置模型目录时默认使用 `["."]`。结果标记为 `observation: "lsp-recompute"`，位置使用从 1 开始的 UTF-16 坐标。初始化成功后，观察超时返回部分结果、`settled: false` 和退出码 0；引擎缺失、初始化失败、协议错误及进程崩溃返回非零退出码。安静期或空结果不证明检查完整。MCP `validate` 继续使用已保存项目 API。

技能内含当前平台的引擎。`--lsp`、`SYSML_LSP_PATH` 和本地配置优先；否则依次查找内置运行时、编辑器用户设置中的 `dryas.lspPath` 和 PATH。`--engine-context` 显示选中的来源；`--configure-lsp <可执行文件>` 保存本机配置；`--vscode-settings <settings.json>` 指定自定义编辑器或 Profile。多个编辑器配置不同路径时需要明确选择。引擎必须能在 agent 环境中访问并执行。
