# 拾序接入 Deep Agents 与本地文件系统

> 本文记录第一次文件能力增量。后续已增加默认目录设置、项目目录、会话外部授权及 Runtime context；当前实现请看[三类路径与上下文学习报告](workspace-paths-guide.md)。下文“所有会话共用目录”等说明仅对应第一次增量的历史状态。

本次将拾序的 Agent 创建入口切换为 `create_deep_agent`，复用原来的模型配置、时间工具、AG-UI 聊天通道和 SQLite 检查点。文件能力限定为列目录、读取、写入、编辑和搜索，不开放文件删除或终端执行。

## 怎么使用

后端启用已配置的模型后，会创建项目根目录下的 `agent-files/`。你可以把普通文本或 Markdown 文件放进去，然后在对话中使用 `/workspace/` 路径。

| 你在对话中使用的路径 | 默认的本机位置 |
| --- | --- |
| `/workspace/项目说明.md` | `agent-files/项目说明.md` |
| `/workspace/reports/摘要.md` | `agent-files/reports/摘要.md` |

推荐练习顺序：列目录 → 读取你放入的文件 → 生成一个新文件 → 修改其中一处文字 → 按文件名和正文搜索。

例如：“读取 `/workspace/项目说明.md`，把三点摘要写到 `/workspace/项目摘要.md`。”完成后，在电脑上打开生成的文件确认内容。

可以在后端的环境变量或 `backend/.env` 中设置 `WORKSPACE_FILES_DIR=/绝对路径`，重启后端后更换文件目录。这一轮没有增加新的设置页或目录选择器。所有会话共用此目录；侧栏的项目仍然用于组织会话。

## 一次文件请求经过哪些地方

```text
你在聊天里提出文件任务
  → 模型收到可用工具的说明，返回工具调用
  → LangChain 的 ToolNode 执行工具
  → Deep Agents 文件中间件处理请求
  → CompositeBackend 根据路径选后端
  → /workspace/ 路径交给本机 FilesystemBackend
  → 实际文件结果回到模型
  → 模型形成回复，经既有聊天通道显示在页面上
```

模型负责判断需要调用哪个工具；本机 Python 后端负责打开文件。读出的内容会进入当前模型服务的请求。

## 具体改了哪些代码

### 1. `backend/app/main.py`：换掉 Agent 创建入口

原来 `build_graph` 直接调用 LangChain 的 `create_agent`，只传入时间工具。

现在仍然先用 `build_chat_model(config)` 创建模型，再交给新的 `build_deep_graph`：

```python
model = build_chat_model(config)
return build_deep_graph(
    model=model,
    tools=[get_current_time],
    workspace_dir=workspace_dir,
    checkpointer=checkpointer,
)
```

这让模型连接与 Agent 能力分别管理：模型页继续决定 DeepSeek 或 OpenAI 兼容服务；新工厂决定给这个模型哪些文件工具。`Settings.files_dir` 读取文件目录配置，运行时创建及模型配置保存后的重建都使用同一条路径。

### 2. `backend/app/deep_agent.py`：组装 Deep Agent

新模块集中定义文件工具范围、存储后端和 Agent 提示词。最关键的调用是：

```python
create_deep_agent(
    model=model,
    tools=list(tools),
    backend=backend,
    middleware=[filesystem],
    checkpointer=checkpointer,
    name="assistant",
)
```

这里的 `tools` 是追加的业务工具，例如当前时间。文件工具由 `FilesystemMiddleware` 提供，不能把 `tools=[get_current_time]` 理解为整个 Agent 只会看时间。

显式传入的同名文件中间件替换 Deep Agents 的默认文件配置，主 Agent 和默认通用子 Agent 都使用这份限制。Deep Agents 的子 Agent、上下文管理等其余组装逻辑继续由官方工厂负责。

### 3. 两种后端：业务文件与内部数据分开保存

```python
AgentFilesystemBackend(
    default=StateBackend(),
    routes={
        "/workspace/": WorkspaceFilesystemBackend(
            root_dir=workspace_dir,
            virtual_mode=True,
        ),
    },
)
```

`CompositeBackend` 像路径分流器：以 `/workspace/` 开头的路径进入真实磁盘目录；其它内部路径保存在当前线程的图状态里。这避免 Agent 的大工具结果等内部数据混进你的业务文件目录。

`virtual_mode=True` 会把虚拟路径映射到指定根目录，并检查解析后的路径没有越界。软链接也需要经过路径检查。这是文件路径约束，没有提供进程级沙箱。

还对当前 0.7.25 的错误处理做了一个小适配：原后端的路径检查可能抛出 `ValueError`，部分文件工具没有把它当作可恢复错误处理。`WorkspaceFilesystemBackend` 将这种拒绝转换成统一的 `PermissionError`，让工具返回明确错误，避免整轮对话中断或暴露主机绝对路径。

### 4. 两层删除限制

第一层是文件工具白名单：

```python
FILESYSTEM_TOOLS = (
    "ls", "read_file", "write_file", "edit_file", "glob", "grep",
)
```

没有注册 `delete` 或 `execute`。即使模型返回这两个名称，工具分发也会拒绝。默认通用子 Agent 同样受限。

第二层是后端保护：`WorkspaceFilesystemBackend` 与组合后端的删除方法直接返回拒绝结果，避免代码直接触达后端时绕过工具层。这里禁止的是文件删除；允许的写入和编辑仍会改变文件内容。

### 5. 配置与测试启动脚本

- `backend/.env.example` 增加文件目录的可选配置说明。
- `.gitignore` 忽略 `agent-files/`，避免正常 Git 提交带上用户文件。
- `scripts/test-e2e.sh` 将 `WORKSPACE_FILES_DIR` 指向本次测试创建的临时目录。
- 本地模型 fixture 增加分片工具调用，让浏览器测试通过真实 HTTP、LangChain、文件中间件去操作临时文件。测试回复根据工具返回结果生成，再独立检查磁盘内容。

Git 忽略规则只影响提交，不限制 Agent 访问。密钥和 `data/workspace.db` 等凭证应留在文件工作区之外。

## 旧会话为什么可以继续

仍使用原来的 `data/checkpoints.db`，没有清空、复制或迁移用户数据库。

这次做了实际的兼容性实验：先用旧 `create_agent` 写入会话，再由新的 Deep Agent 读取和续聊，最后关闭 SQLite 连接、重新创建 Agent 再继续一轮。消息 ID、顺序、内容以及其它会话的独立性均纳入回归测试。

原因是当前安装的 LangGraph `DeltaChannel.from_checkpoint` 支持读取旧普通消息列表。这个结论针对本次锁定的依赖组合与已完成会话，不代表旧图运行到一半时的节点恢复也已经验证。

## 验证与边界

2026-10-14 完成以下验证：

| 检查 | 结果 |
| --- | --- |
| `make test` | 后端 65 项通过，前端 TypeScript 检查通过 |
| Deep Agent 专项 | 14 项通过，覆盖真实临时文件读写、编辑、搜索、默认子 Agent 写入、删除／终端工具拒绝、后端删除拒绝、路径穿越和越界软链接 |
| 旧检查点兼容 | 1 项通过，旧会话读取、续聊、SQLite 重新打开后恢复，以及其它会话独立性均通过 |
| 隔离浏览器 | 13 项通过，包括新增的完整文件链路及强行调用删除／终端工具的拒绝；保留原模型配置、会话操作、停止生成和移动布局回归 |
| 本机服务 | 已重启加载新入口，健康接口返回正常，默认 `agent-files/` 目录已创建 |

浏览器验收通过真正的 HTTP、模型适配器、Deep Agent 和文件后端操作临时磁盘；测试还从 Agent 外部修改文件，再要求 Agent 读取，以排除仅复述之前内容的假成功。文件操作后的对话刷新和历史保留也通过。

本轮使用确定性的假模型和本地协议 fixture，未调用真实模型服务，也没有用真实 Key 测试文件操作。上述结果验证接入链路与文件边界，不代表已验收真实模型自主选择工具的质量。旧图运行中断点的恢复、多人或公网部署未纳入本轮。

浏览器检查使用 `WATCHPACK_POLLING=1000 make test-e2e`，在允许浏览器启动的环境中运行。后端仍有 8 条已有 AG-UI 依赖弃用提示，不影响测试结果。开发启动脚本的端口预检查补充 `SO_REUSEADDR`，允许服务停止后及时重启，同时继续拒绝实际占用的端口。

[部分会话截图](deep-agent-filesystem-chat.png)来自隔离 fixture，非真实模型服务。

文件系统接入不等于自动解析所有 Word、Excel、PDF 文件；当前先用文本和 Markdown 验证。未增加写入审批、目录选择 UI 或按项目隔离目录。这是本机单用户 Demo 的能力增量。

## 官方依据

- [Deep Agents 自定义入口](https://docs.langchain.com/oss/python/deepagents/customization)：模型对象、业务工具、文件后端与中间件覆盖方式。
- [文件系统与组合后端](https://docs.langchain.com/oss/python/deepagents/backends)：真实磁盘路径、虚拟路径和按前缀分流。
- [0.7.25 Agent 工厂源码](https://github.com/langchain-ai/deepagents/blob/c6c340d47d2013a2e7b7230698f73977b7de6756/libs/deepagents/deepagents/graph.py)：实际的中间件和默认子 Agent 组装。

项目已安装并固定 `deepagents==0.7.25`。该版本默认栈没有旧教程中的 `write_todos` 工具；本报告以实际源码和测试结果为准。
