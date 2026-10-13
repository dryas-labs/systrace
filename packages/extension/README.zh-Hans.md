# DRYAS Systrace

[English](README.md) | **简体中文**

面向 VS Code 和 Cursor 的 SysML v2 编辑扩展，由外部 language engine（语言引擎）提供语言能力。
当前是早期开发版，尚未实现 view 渲染和内置 agent。

0.1.8 使用 language engine 构建 `v0.9.2-dryas.5`。选中补全候选后，详情显示原生声明、引用名称、
实际声明来源、源文件名和完整文档。说明按需加载，与普通悬浮共用引擎的文档提取逻辑。
别名保留原来的插入名称；没有文档的元素只显示声明和来源。
点击详情箭头，或在补全列表已打开时按 Ctrl+Space，可展开编辑器原生的详情面板。
升级时请同时更新两个外部引擎程序；若显式设置过 `dryas.expectedEngineVersion`，
请改为 `v0.9.2-dryas.5`。

当前引擎选择见 [Language engine](../../docs/language-engine.zh-Hans.md)。

## 开始使用

1. 按仓库 `config/engine.json` 中记录的版本构建 language engine。
2. 将 `sysml-lsp` 和 `sysml-grpc` 加入 PATH，或在编辑器的 **User Settings** 中设置
   **DRYAS: Lsp Path** 和 **DRYAS: Api Path**。不要把本机路径写入提交的工作区设置。
3. 打开可信的项目文件夹，在项目根目录或子目录中放置 SysML/KerML 文件，或通过
   **DRYAS: Model Roots** 指定项目源码文件夹。
4. 打开 `.sysml` 文件，即可使用诊断、补全、悬浮提示和定义跳转。

此 VSIX 不包含引擎及其标准库。模型文件夹中的文件必须是可读取的 UTF-8 文件；
当前版本拒绝符号链接和 junction。隐藏目录和 `node_modules` 不参与扫描，可配置更窄的源码范围。

如果启动时出现 `INVALID_PATH during model-folders`，请检查工作区设置中的
**DRYAS: Model Roots**（多根工作区使用工作区文件夹设置）。默认值 `["."]`
从项目根目录发现模型；显式指定的源码文件夹路径相对于项目根目录。
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
展开项目，可以看到配置的 **Sources** 和只读的 **Standard Library**。
源码按目录和 `.sysml` / `.kerml` 文件组织；继续展开文件可浏览语言引擎返回的声明层级，
点击元素定位源码。元素层级随未保存的编辑刷新，文件增删会更新目录；顶部可手动刷新。

标准库目录按需从引擎取得，只列出当前项目上下文中引擎可见的库命名空间。
展开库节点可浏览声明并打开只读源码。命名覆盖可能影响可见目录；导入和重新导出的成员不会
作为声明重复展开。模型类型标签只显示引擎提供的信息，不根据源码文本猜测类型。
浏览其他项目或标准库不会重新绑定已有的 Agent 会话。
