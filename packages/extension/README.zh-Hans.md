# DRYAS Systrace

[English](README.md) | **简体中文**

面向 VS Code 和 Cursor 的 SysML v2 编辑扩展，由外部 OpenSysML 引擎提供语言能力。
当前是早期开发版，view 渲染和内置 agent 属于后续工作。

0.1.5 使用 OpenSysML `v0.9.2-dryas.4`。选中补全候选后，详情显示原生声明、引用名称、
实际声明来源、源文件名和完整文档。说明按需加载，与普通悬浮共用引擎的文档提取逻辑。
别名保留原来的插入名称；没有文档的元素只显示声明和来源。
点击详情箭头，或在补全列表已打开时按 Ctrl+Space，可展开编辑器原生的详情面板。
升级时请同时更新两个外部引擎程序；若显式设置过 `dryas.expectedEngineVersion`，
请改为 `v0.9.2-dryas.4`。

参见[引擎支持政策](../../docs/engine-support.zh-Hans.md)。配置指定的 DRYAS 构建是已测试后端；上游兼容是目标，不代表任意版本均能直接使用。

## 开始使用

1. 按仓库 `config/engine.json` 中记录的版本构建维护中的 OpenSysML。
2. 将 `sysml-lsp` 和 `sysml-grpc` 加入 PATH，或在编辑器的 **User Settings** 中设置
   **DRYAS: Lsp Path** 和 **DRYAS: Api Path**。不要把本机路径写入提交的工作区设置。
3. 打开可信的项目文件夹，把 SysML/KerML 文件放在 `model/` 中，或通过
   **DRYAS: Model Roots** 指定项目源码文件夹。
4. 打开 `.sysml` 文件，即可使用诊断、补全、悬浮提示和定义跳转。

此 VSIX 不包含引擎及其标准库。模型文件夹中的文件必须是可读取的 UTF-8 文件；
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
