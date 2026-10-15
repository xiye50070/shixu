# 拾序 · Shixu Work

一个单用户 Web Demo：React / Next.js + CopilotKit v2 + FastAPI + Deep Agents / LangChain + SQLite。一个任务对应一个会话，项目绑定独立工作目录。

## 功能

- 新建项目、新建任务，按项目查看会话记录。
- 搜索会话标题和消息内容，打开搜索结果继续会话。
- 右侧使用 CopilotKit 组件展示流式回复和工具调用，支持停止生成。
- 保存项目、会话历史和 Agent 检查点；切换、刷新和重启后继续会话。
- 在“设置 → 模型配置”中连接 DeepSeek 或标准 OpenAI 兼容服务，测试连接、保存后直接用于后续回复。
- Agent 使用 `create_deep_agent`，支持默认目录、项目目录和按会话授予的外部文件／目录访问；主子 Agent 通过 Runtime context 和动态提示使用同一环境，不开放文件删除或终端执行工具。

界面采用 OpenWork EE 的 SaaS / standard 规范：白色侧栏、灰白画布、深墨主操作和本地 Inter 字体。组件映射、原图依据及尺寸差异见 [样式接入记录](docs/openwork-ee-adoption.md)。

## 安装与启动

需要 Node.js 20.9 或更新版本、npm、uv。后端使用 Python 3.12，依赖由 `uv.lock` 固定。

```bash
git clone https://github.com/xiye50070/shixu.git
cd shixu
make setup
```

启动后可在页面左下角的“设置 → 模型配置”填写服务类型、模型名称、API 地址和 API Key。保存后立即生效，无需重启；当前只有一份应用级配置，供所有会话后续回复使用。

尚未通过页面保存配置时，后端仍兼容环境变量 `DEEPSEEK_API_KEY`。如果已在 `~/.zshrc` 中导出密钥，在该终端启动即可。也可以编辑 `backend/.env`：

```dotenv
DEEPSEEK_API_KEY=
```

DeepSeek 初始模型为 `deepseek-flash`，可在页面修改为账号支持的模型。OpenAI 兼容服务填写自己的模型名称和基础地址（通常以 `/v1` 结尾）。保存后的密钥不会读回浏览器，编辑同一服务与地址时留空保留原密钥。安装脚本只在配置文件不存在时复制模板，保留已有配置。

DeepSeek 默认关闭思考模式，初始回复上限为 1024 Token；可在页面调整。`DEEPSEEK_MAX_TOKENS` 作为首次配置前的初始值。DeepSeek 专用参数不会发送给 OpenAI 兼容服务。思考开关使用 [DeepSeek 官方接口参数](https://api-docs.deepseek.com/guides/thinking_mode/)。

```bash
make dev
```

打开 [http://127.0.0.1:3210](http://127.0.0.1:3210)。FastAPI 在 `127.0.0.1:8765` 启动。脚本会预检查两个端口；按 Ctrl+C 仅停止本次启动的服务。也可从任意目录运行 `bash "/完整路径/scripts/dev.sh"`。

尚未配置密钥时，项目、会话和搜索功能仍可使用，聊天输入框会提示打开模型配置。

配置保存在本机 `data/workspace.db`，优先于环境配置；其中包含未加密的 API Key，请妥善保管数据目录。具体使用步骤、实现讲解和验证边界见 [模型配置学习报告](docs/model-configuration-guide.md)。

## 本地文件工作区

后端初次启动时自动创建项目根目录下的 `agent-files/`。在“设置 → 工作目录”中可选择默认目录；创建项目时必须选择项目目录，项目内会话使用该目录。旧项目需先设置目录，缺失目录不会自动回退。

创建项目后会自动创建并进入该项目的首个会话，可以直接输入任务。如果项目已创建但会话创建失败，页面会保留项目并提示通过“新建任务”重试。

项目行右侧的“⋯ → 删除项目”会先显示确认弹窗。确认后仅移除项目分组，原会话移到“未分组”，聊天历史、置顶和会话外部授权保留；后续任务使用默认工作目录。磁盘目录和文件保持原样。项目内有任务运行或排队时，需先停止或等待完成。

在本机 macOS 上点击“浏览”，会通过本地后端调用系统目录选择窗口，使用系统侧栏、搜索和“新建文件夹”等功能。外部授权可选择文件或目录。选择结果只回填输入框，仍需点击保存／创建／授权；取消保留原路径。后端需要运行在当前已登录的 macOS 桌面中；其他系统或远程部署可手动填写后端机器上的绝对路径。

`/workspace/` 始终代表当前会话的工作目录，相对路径由代码自动解析。可以尝试：“列出当前目录的文件”“读取项目说明.md”“把摘要保存为摘要.md”“搜索工作区中包含预算的内容”。先用普通文本或 Markdown 文件练习；接入文件系统不等于支持解析所有 Office / PDF 格式。

会话顶部的“目录与授权”显示真实目录，可为当前会话添加外部文件或目录的只读、读写授权及撤销。授权保存在本地，直到撤销或删除会话；撤销不删除文件。读取外部资料不会改变新产物的默认目录。`WORKSPACE_FILES_DIR` 只作为首次保存默认目录前的初始值。

真实文件通过 `FilesystemBackend` 保存；Agent 内部临时文件通过 `StateBackend` 保存在图状态里。文件工具限制为 `ls`、`read_file`、`write_file`、`edit_file`、`glob`、`grep`，主 Agent 与默认子 Agent 均不提供 `delete`、`execute`，文件后端也拒绝删除。允许的写入和编辑会改变文件内容。

`agent-files/` 已加入 Git 忽略规则。不要把模型密钥、数据库等凭证放进文件工作区；文件内容会随工具结果进入当前模型服务的请求。这里沿用本机单用户 Demo 的使用范围，路径约束不等于系统沙箱。

当前目录方案、代码讲解与验收见 [三类路径与上下文学习报告](docs/workspace-paths-guide.md)；首次文件接入过程见 [Deep Agent 文件系统学习报告](docs/deep-agent-filesystem-guide.md)。

## 数据与检查

默认数据保存在项目根目录的 `data/`，分为三层：`workspace.db` 保存项目、会话和搜索数据；`runtime.db` 保存 CopilotKit 聊天事件；`checkpoints.db` 保存 LangGraph Agent 检查点。三层以同一个会话 ID 关联。保留 `data/` 即可保留历史。

```bash
make test       # 后端测试和前端类型检查
make build      # 前端构建
make test-e2e   # 使用本地模型 fixture 的浏览器检查
```

后端和前端环境配置模板分别为 `backend/.env.example`、`frontend/.env.example`。

`make test-e2e` 会启动隔离的本地模型 fixture（18965）、测试后端（18966）和测试 Web（3211），使用临时 SQLite 数据目录及独立的 `.next-test` 构建目录。它强制使用测试占位密钥和本地模型地址，不会调用真实 DeepSeek API 或消耗真实模型 Token。测试结束后仅清理本次启动的进程和临时数据目录；截图与失败追踪保存在 `frontend/test-results/`。浏览器默认使用本机 Google Chrome，也可以设置 `CHROME_PATH` 指定浏览器可执行文件。

## 验证记录

- 2026-10-14 项目删除增量：后端 107 项、类型检查、25 项隔离浏览器与 9 项运行协调单元检查通过；覆盖确认／取消、会话和检查点保留、默认目录切换、文件不变、失败重试、运行／排队保护、并发入队协调与手机键盘操作。本机服务已重启，仅预览并取消确认，没有删除已有项目。[确认界面](docs/project-delete-preview.jpg)。
- 2026-10-14 项目创建流程修正：创建项目后自动在该项目下创建并打开首个会话；类型检查与 22 项隔离浏览器检查通过，覆盖项目／目录归属、唯一会话、直接聊天、刷新恢复、会话创建失败后的项目保留与重试。另修复目录选择结束时的还焦时序。[隔离测试截图](docs/project-created-conversation.png)。
- 2026-10-14 目录选择交互修正：移除网页等待／错误弹窗，只调用系统选择窗口，错误回原表单；类型检查和 21 项隔离浏览器检查通过，本机页面确认不叠加选择弹窗。[实际页面截图](docs/workspace-native-only.jpg)。
- 2026-10-14 系统目录选择增量：本机 macOS 的“浏览”改用 `NSOpenPanel`；后端 102 项、TypeScript、生产构建和隔离浏览器 20 项通过。浏览器测试模拟系统窗口返回值，实际系统窗口外观与窗口内选择操作待本机人工确认，详见 [实现与验证说明](docs/workspace-paths-guide.md)。
- 2026-10-14 三类工作区增量：后端 86 项、TypeScript 检查、生产构建与隔离浏览器 18 项通过；默认目录、项目目录、会话外部只读／读写及撤销、Runtime context 与动态提示、主子一致、并发隔离和禁止删除均有验证。服务已重启，已有数据保留，本轮没有调用真实模型。见 [代码与使用讲解](docs/workspace-paths-guide.md)。
- 2026-10-14 Deep Agents 文件能力增量：后端 65 项、TypeScript 检查和隔离浏览器 13 项通过；覆盖临时磁盘真实读写编辑搜索、主／子 Agent 删除和终端工具拒绝、路径边界，以及旧普通 Agent 的已完成会话续聊和重启恢复。本轮未调用真实模型。见 [文件系统学习报告](docs/deep-agent-filesystem-guide.md)。
- 2026-10-14 模型配置增量：后端 50 项、TypeScript 检查、Next.js 构建和隔离浏览器 11 项全部通过；覆盖配置保存、切换协议后的流式回复与历史保留、390px / 720px 布局及键盘操作。本轮未调用真实模型。见 [学习报告与截图](docs/model-configuration-guide.md)。
- 2026-10-14 初始版本：后端 20 项测试及 TypeScript 检查通过，Next.js 构建通过。
- 本地模型协议 fixture：4 条浏览器验收通过，覆盖项目创建、流式回复、多轮/隔离、刷新、正文搜索、置顶/重命名/移动/删除、手机布局、停止生成、运行中删除保护和异常后继续对话。
- OpenWork EE 样式调整：最终 TypeScript 与生产构建通过；隔离浏览器回归共 9 项通过，新增菜单键盘、弹窗焦点、搜索输入法 / 快捷键、旧结果隔离及移动导航检查。实测桌面、390px 手机与 720px 窄屏布局，本轮没有调用真实模型。
- 真实 DeepSeek：仅调用 1 次，模型 `deepseek-flash`，输出上限 16、零重试，返回「连接成功」。接口报告输入 318、输出 2，共 320 Token。
- 同一真实会话：浏览器刷新、前后端完整停止并重新启动后，历史可恢复且无重复消息。恢复检查未发送模型请求。
- 真实多轮与真实工具调用未额外调用 API；这部分使用本地 fixture / 测试图验证，以节省用户 Token。
- 已保存会话恢复与进行中的模型请求恢复是不同能力；服务重启不会自动继续此前仍在生成的请求。

截图：[`docs/demo-desktop.png`](docs/demo-desktop.png)、[`docs/demo-mobile.png`](docs/demo-mobile.png)。
