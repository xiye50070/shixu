# 拾序 · Shixu Work

一个单用户 Web Demo：React / Next.js + CopilotKit v2 + FastAPI + LangChain Agent + SQLite。一个任务对应一个会话，项目用于组织会话。

## 功能

- 新建项目、新建任务，按项目查看会话记录。
- 搜索会话标题和消息内容，打开搜索结果继续会话。
- 右侧使用 CopilotKit 组件展示流式回复和工具调用，支持停止生成。
- 保存项目、会话历史和 Agent 检查点；切换、刷新和重启后继续会话。

界面采用 OpenWork EE 的 SaaS / standard 规范：白色侧栏、灰白画布、深墨主操作和本地 Inter 字体。组件映射、原图依据及尺寸差异见 [样式接入记录](docs/openwork-ee-adoption.md)。

## 安装与启动

需要 Node.js 20.9 或更新版本、npm、uv。后端使用 Python 3.12，依赖由 `uv.lock` 固定。

```bash
git clone https://github.com/xiye50070/shixu.git
cd shixu
make setup
```

后端优先读取环境变量 `DEEPSEEK_API_KEY`。如果已在 `~/.zshrc` 中导出密钥，在该终端启动即可。也可以编辑 `backend/.env`：

```dotenv
DEEPSEEK_API_KEY=
```

模型固定为 `deepseek-flash`。密钥仅由后端读取，不发送到浏览器。安装脚本只在配置文件不存在时复制模板，保留已有配置。

默认关闭思考模式，并把每次回复上限设为 1024 Token；可用 `DEEPSEEK_MAX_TOKENS` 环境变量或 `.env` 配置调整输出上限。思考开关使用 [DeepSeek 官方接口参数](https://api-docs.deepseek.com/guides/thinking_mode/)。

```bash
make dev
```

打开 [http://127.0.0.1:3210](http://127.0.0.1:3210)。FastAPI 在 `127.0.0.1:8765` 启动。脚本会预检查两个端口；按 Ctrl+C 仅停止本次启动的服务。也可从任意目录运行 `bash "/完整路径/scripts/dev.sh"`。

尚未配置密钥时，项目、会话和搜索功能仍可使用，聊天输入框会提示配置密钥。修改密钥后重启后端。

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

- 2026-10-14：后端 20 项测试及 TypeScript 检查通过，Next.js 构建通过。
- 本地模型协议 fixture：4 条浏览器验收通过，覆盖项目创建、流式回复、多轮/隔离、刷新、正文搜索、置顶/重命名/移动/删除、手机布局、停止生成、运行中删除保护和异常后继续对话。
- OpenWork EE 样式调整：最终 TypeScript 与生产构建通过；隔离浏览器回归共 9 项通过，新增菜单键盘、弹窗焦点、搜索输入法 / 快捷键、旧结果隔离及移动导航检查。实测桌面、390px 手机与 720px 窄屏布局，本轮没有调用真实模型。
- 真实 DeepSeek：仅调用 1 次，模型 `deepseek-flash`，输出上限 16、零重试，返回「连接成功」。接口报告输入 318、输出 2，共 320 Token。
- 同一真实会话：浏览器刷新、前后端完整停止并重新启动后，历史可恢复且无重复消息。恢复检查未发送模型请求。
- 真实多轮与真实工具调用未额外调用 API；这部分使用本地 fixture / 测试图验证，以节省用户 Token。
- 已保存会话恢复与进行中的模型请求恢复是不同能力；服务重启不会自动继续此前仍在生成的请求。

截图：[`docs/demo-desktop.png`](docs/demo-desktop.png)、[`docs/demo-mobile.png`](docs/demo-mobile.png)。
