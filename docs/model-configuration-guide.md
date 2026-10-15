# 模型配置：使用方法与改动讲解

这次给拾序增加了一个真正接入聊天的模型配置页。当前只有“模型配置”一个设置类别，支持 DeepSeek 和使用标准 OpenAI Chat Completions 协议的服务。整个应用共用一份当前配置，切换会影响所有会话后续的请求。

## 先学会使用

1. 在工作区左下角打开“设置”，进入“模型配置”。
2. 选择 DeepSeek 或 OpenAI 兼容接口。
3. 填写模型名称、API 地址、API Key 和回复 Token 上限。
4. 可以先点“测试连接”，再点“保存配置”。测试成功不会自动保存。
5. 返回工作区，继续已有会话或新建任务。保存后不用重启，后续回复使用新配置。

DeepSeek 的初始地址是 `https://api.deepseek.com`，初始模型保留项目原来的 `deepseek-flash`。模型名称需要与你的服务账号实际支持的名称一致。

使用 OpenAI 兼容服务时，填写服务商提供的完整基础地址，例如 `https://你的服务地址/v1`。这里填写基础地址，不要把 `/chat/completions` 加在末尾。模型名称同样由服务商决定；“支持 OpenAI 协议”并不意味着模型名称也必须是 OpenAI 的名称。

API Key 保存后不会从服务端读回页面。编辑同一供应商、同一地址时，Key 留空表示继续使用原来的 Key；更换供应商或地址，需要重新填写 Key，避免把旧密钥误发给另一个服务。

正在生成回复时，保存配置会被拒绝。先停止生成或等回复完成，再保存即可。

## 原来为什么不能在页面切换模型

原来的后端启动时，会直接创建一个 `ChatDeepSeek`，模型名称写死在代码里，密钥从环境变量或 `backend/.env` 读取。可以把它理解成：程序开机时就接好一台固定的发动机，网页只能踩油门，不能换发动机。

这次把“用哪台发动机”和“怎么开车”拆开了：

```text
配置页填写参数
  → Next.js 接口转发
  → FastAPI 校验并保存
  → 按供应商创建 LangChain 模型
  → 重建使用同一份历史存储的 Agent
  → 后续聊天调用新模型
```

浏览器负责填写配置，FastAPI 负责保管配置和调用模型。聊天仍使用已有的 CopilotKit 和 AG-UI 流式通道。

## 前端改了什么

新增配置页有两层导航：左边只有“模型配置”，右边先选服务类型，再填写参数。参考图片提供了分栏关系；颜色、尺寸和留白沿用 OpenWork EE 的 SaaS 规范。

表单中的四个主要参数可以这样理解：

| 参数 | 通俗解释 |
| --- | --- |
| 模型名称 | 让服务商知道要调用哪一个模型，类似商品型号 |
| API 地址 | 模型服务的入口地址，类似寄件地址 |
| API Key | 访问服务的凭证，类似门禁卡 |
| 回复 Token 上限 | 单次回复的长度预算，不等于中文字数，也不等于上下文长度 |

“测试连接”使用当前表单做一次简短请求；“保存配置”才会更新应用实际使用的模型。保存成功只能说明配置已保存并已接入运行环境，不能替代真实连通性测试。

页面还处理了加载、失败重试、未保存修改、测试和保存反馈，以及窄屏布局。密钥输入不进入浏览器本地存储。

## LangChain 改了什么

LangChain 的模型对象，是我们自己的程序与模型接口之间的“翻译员”。不同接口可能看起来类似，但不能盲目使用相同的扩展参数。

本次增加统一的模型创建入口，根据供应商分两条路：

```python
# 说明用的简化代码，实际实现还包括校验、超时等设置。
if config.provider == "deepseek":
    model = ChatDeepSeek(
        model=config.model,
        api_key=config.api_key,
        base_url=config.base_url,
    )
else:
    model = ChatOpenAI(
        model=config.model,
        api_key=config.api_key,
        base_url=config.base_url,
        use_responses_api=False,
        stream_usage=False,
    )
```

DeepSeek 使用官方的 `langchain-deepseek` 适配类；标准 OpenAI 协议使用 `langchain-openai`。DeepSeek 专有的思考模式参数只走 DeepSeek 分支，不会发给其他兼容服务。OpenAI 兼容分支明确使用 Chat Completions，避免自动进入另一种 Responses 协议。

创建好模型之后，仍然交给原来的 `create_agent`，继续使用原来的系统提示词和时间工具。这意味着本次替换的是 Agent 的模型入口，Agent 的职责和工具范围没有扩大。

这也解释了为什么“能连通”与“完整支持 Agent”是两件事：有些兼容服务能正常聊天，却不支持标准工具调用；选择的模型和服务还需要支持 streaming 与 tool calling，才能覆盖当前 Agent 的完整行为。供应商自定义的推理字段没有纳入本次标准协议支持范围。

官方参考：[LangChain 的 DeepSeek 集成](https://docs.langchain.com/oss/python/integrations/chat/deepseek)、[LangChain 的 OpenAI 集成](https://docs.langchain.com/oss/python/integrations/chat/openai)。

## 保存配置后，为什么历史还在

模型配置回答的是“下一次请求发给谁”，会话历史回答的是“之前聊过什么”。两者是不同的数据。

原有三层存储继续使用相同的会话 ID：

- `workspace.db`：项目、会话、搜索数据，以及新增的模型配置。
- `runtime.db`：CopilotKit 的聊天事件。
- `checkpoints.db`：LangGraph 的会话检查点，也就是 Agent 的历史状态。

保存模型配置会创建新的模型和 Agent，但仍连接同一份检查点。因此切换模型不会删除聊天记录。后续模型会接收到该会话已有的上下文；如果改用不同服务商，继续对话也会把这些上下文发给新服务商。

网页已保存的配置优先于环境文件。还没有在网页保存过配置时，原来的 `DEEPSEEK_API_KEY` 等环境设置仍然可用。

## 密钥保存到哪里

密钥随配置保存在本机 `data/workspace.db`，当前 Demo 没有实现数据库字段加密，也没有接入系统钥匙串。服务端只返回“已配置”状态，不返回密钥原文；验证错误和模型错误也不会把凭证或供应商返回的原始内容直接显示出来。

因此备份 `data/` 时要把它当作含凭证的数据保管。这个实现延续单用户本地 Demo 的使用范围，没有增加多人权限或租户配置。

## 代码阅读顺序

建议先从页面看“表单发出了什么”，再到后端看“参数怎样变成模型对象”：

1. `frontend/components/model-settings.tsx`：配置页、表单状态和接口调用。
2. `frontend/components/workspace.tsx`：打开设置、返回工作区、刷新聊天可用状态。
3. `frontend/app/api/backend/[...path]/route.ts`：把网页请求转发给 FastAPI。
4. `backend/app/model_settings.py`：配置结构、校验、存储和模型创建。
5. `backend/app/main.py`：配置 API、Agent 重建和聊天执行。
6. `backend/tests/`、`frontend/tests/model-settings.spec.ts`：验证保存、切换、历史和错误处理。

阅读时可以一直追问一句：“这个参数现在在哪里，下一个函数把它交给了谁？”这样比同时理解整个 Agent 框架更容易。

## 本次验证

2026-10-14 完成以下验证：

| 层次 | 结果与边界 |
| --- | --- |
| 后端测试 | 50 项通过，覆盖配置校验、密钥脱敏、地址切换、保存失败、运行中保存冲突、重启恢复，以及切换模型后原会话继续使用检查点 |
| 前端静态检查 | TypeScript 类型检查与 Next.js 生产构建通过 |
| 本地协议与浏览器 | 11 项通过，包含已有工作区回归，以及配置读取、测试不保存、保存生效、切换协议后实际流式回复、刷新恢复和历史保留 |
| 视觉和键盘 | 实际截图检查；桌面控件 40px、侧栏 260px、顶栏 56px、卡片圆角 30px；390px 与 720×480 无整页横向溢出，保存按钮可滚动到达，帮助弹窗与返回操作的焦点正常 |
| 真实模型服务 | 本轮未调用；没有使用真实 API Key 或真实模型额度。真实服务的连通性、模型名称权限和工具调用兼容性仍以用户实际配置为准 |

浏览器测试使用临时数据目录与本机模型 fixture。它通过真的 HTTP 请求、LangChain 适配器和聊天流验证配置链路，但模拟回复不代表真实模型的回答质量。连接测试本身只验证一次短回复，不验证流式或工具调用；完整流式链路另由浏览器测试覆盖。720×480 是窄视口检查，不代表浏览器原生 200% 缩放验收。

本机浏览器在沙箱中启动失败，因此最终完整验收在沙箱外运行隔离测试，并用 `WATCHPACK_POLLING=1000 make test-e2e` 避开系统文件监听资源限制。测试端口预检查补充了 `SO_REUSEADDR`，允许上一轮连接结束后及时重跑；仍会拒绝正在被占用的监听端口。后端现有 AG-UI 依赖产生 8 条弃用提示，测试全部通过。

页面截图：[桌面配置页](model-settings-desktop.png)、[手机配置页（滚动到操作区）](model-settings-mobile.png)、[窄视口操作区](model-settings-short.png)。桌面实测尺寸见 [model-settings-metrics.json](model-settings-metrics.json)。

后续界面调整：移除左侧模型的两条说明，改用 DeepSeek 官网鲸鱼和 ChatGPT 官方结形图标，右侧标题同步；图标作为本地 SVG 加载。此轮 TypeScript 检查通过，并在当前浏览器确认三处图标正常加载、说明已移除，未调用模型接口。[最新页面效果](model-settings-updated.jpg)。SVG 文件内附官方来源地址。

保留了本次工作开始前已有的 `backend/app/main.py` 空行及两份员工记忆方案文档。本次没有提交 Git commit，也没有修改真实模型配置或发送真实聊天消息。
