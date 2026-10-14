from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from ag_ui.core import (
    EventType,
    MessagesSnapshotEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
)
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent
from dotenv import dotenv_values
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from langchain.agents import create_agent
from langchain_core.tools import tool
from langchain_deepseek import ChatDeepSeek
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from pydantic import BaseModel, Field, field_validator

from .storage import BusinessStore, text_content

BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_NAME = "deepseek-flash"
logger = logging.getLogger("shixu_work")
# The adapter otherwise logs provider exception bodies. Our stream returns
# sanitized error messages and this application logs exception classes only.
logging.getLogger("ag_ui_langgraph.agent").setLevel(logging.CRITICAL + 1)


@dataclass(frozen=True)
class Settings:
    data_dir: Path = BASE_DIR.parent / "data"
    deepseek_api_key: str = field(default="", repr=False)
    deepseek_base_url: str = "https://api.deepseek.com"
    max_output_tokens: int = 1024
    max_retries: int = 1

    def __post_init__(self):
        if not 1 <= self.max_output_tokens <= 16384:
            raise ValueError("DEEPSEEK_MAX_TOKENS 必须是 1 到 16384 的整数")
        if not 0 <= self.max_retries <= 3:
            raise ValueError("DEEPSEEK_MAX_RETRIES 必须是 0 到 3 的整数")

    @classmethod
    def from_env(cls) -> "Settings":
        values = dotenv_values(BASE_DIR / ".env")

        def integer_setting(name: str, default: int) -> int:
            raw = os.getenv(name) or values.get(name)
            if raw is None or not str(raw).strip():
                return default
            try:
                return int(raw)
            except (TypeError, ValueError):
                raise ValueError(f"{name} 必须是整数") from None

        return cls(
            data_dir=Path(os.getenv("WORKSPACE_DATA_DIR") or values.get("WORKSPACE_DATA_DIR") or BASE_DIR.parent / "data"),
            deepseek_api_key=(os.getenv("DEEPSEEK_API_KEY") or values.get("DEEPSEEK_API_KEY") or "").strip(),
            deepseek_base_url=(os.getenv("DEEPSEEK_BASE_URL") or values.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com").strip(),
            max_output_tokens=integer_setting("DEEPSEEK_MAX_TOKENS", 1024),
            max_retries=integer_setting("DEEPSEEK_MAX_RETRIES", 1),
        )


@tool
def get_current_time() -> str:
    """Get the current date and time in Asia/Shanghai when the user asks for it."""
    return datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S Asia/Shanghai")


def build_graph(checkpointer: AsyncSqliteSaver, settings: Settings):
    # The model is intentionally fixed; the client cannot choose another provider/model.
    model = ChatDeepSeek(
        model=MODEL_NAME,
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
        timeout=90,
        max_tokens=settings.max_output_tokens,
        max_retries=settings.max_retries,
        streaming=True,
        stream_usage=True,
        extra_body={"thinking": {"type": "disabled"}},
    )
    return create_agent(
        model=model,
        tools=[get_current_time],
        system_prompt=(
            "你是拾序（Shixu Work）的工作助手。默认使用中文，回答清楚、简洁。"
            "你可以使用当前时间工具。你目前没有读写用户项目文件、执行终端命令或浏览网页的能力，"
            "不要声称完成了这些操作。用户提到的项目用于组织会话。"
        ),
        checkpointer=checkpointer,
        name="assistant",
    )


class NewProject(BaseModel):
    name: str = Field(min_length=1, max_length=100)

    @field_validator("name", mode="before")
    @classmethod
    def strip_name(cls, value):
        return value.strip() if isinstance(value, str) else value


class NewConversation(BaseModel):
    project_id: str | None = None
    title: str = Field(default="新任务", min_length=1, max_length=160)

    @field_validator("title", mode="before")
    @classmethod
    def strip_title(cls, value):
        return value.strip() if isinstance(value, str) else value


class ConversationPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    pinned: bool | None = None
    project_id: str | None = None

    @field_validator("title", mode="before")
    @classmethod
    def valid_title(cls, value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError("会话标题不能为空")
        return value.strip()

    @field_validator("pinned", mode="before")
    @classmethod
    def valid_pinned(cls, value):
        if not isinstance(value, bool):
            raise ValueError("pinned 必须是布尔值")
        return value


def public_model_error(message: str) -> tuple[str, str]:
    """Return a useful error without echoing provider bodies, credentials or URLs."""
    lowered = message.lower()
    if any(part in lowered for part in ("401", "authentication", "invalid api key", "unauthorized")):
        return "DEEPSEEK_AUTH_ERROR", "DeepSeek API Key 无效，请检查 backend/.env 后重启后端。"
    if any(part in lowered for part in ("429", "rate limit", "insufficient", "balance", "402")):
        return "DEEPSEEK_QUOTA_ERROR", "DeepSeek 配额或余额不足，请检查账号后重试。"
    if any(part in lowered for part in ("timeout", "timed out", "connection")):
        return "DEEPSEEK_CONNECTION_ERROR", "连接 DeepSeek 失败或超时，请检查网络后重试。"
    if any(part in lowered for part in ("model", "400", "404")):
        return "DEEPSEEK_REQUEST_ERROR", "DeepSeek 请求未成功，请确认账号支持 deepseek-flash 后重试。"
    return "AGENT_RUN_ERROR", "Agent 执行失败，请稍后重试。"


def create_app(
    settings: Settings | None = None,
    graph_factory: Callable | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        app.state.store = BusinessStore(settings.data_dir / "workspace.db")
        app.state.thread_locks = {}
        async with AsyncSqliteSaver.from_conn_string(str(settings.data_dir / "checkpoints.db")) as saver:
            await saver.setup()
            app.state.saver = saver
            factory = graph_factory or build_graph
            app.state.graph = factory(saver, settings) if settings.deepseek_api_key or graph_factory else None
            app.state.agui = (
                LangGraphAgent(
                    name="assistant", graph=app.state.graph,
                    description="DeepSeek 工作助手", emit_raw_events=False,
                )
                if app.state.graph is not None else None
            )
            yield

    app = FastAPI(title="Shixu Work", version="0.1.0", lifespan=lifespan)

    def require_conversation(conversation_id: str):
        conversation = app.state.store.conversation(conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="会话不存在")
        return conversation

    def validate_project(project_id: str | None):
        if project_id is not None and not app.state.store.project_exists(project_id):
            raise HTTPException(status_code=404, detail="项目不存在")

    async def sync_projection(thread_id: str):
        if app.state.graph is None:
            return
        state = await app.state.graph.aget_state({"configurable": {"thread_id": thread_id}})
        app.state.store.sync_messages(thread_id, state.values.get("messages", []))

    @app.get("/api/health")
    def health():
        return {"status": "ok", "model": MODEL_NAME, "model_configured": bool(settings.deepseek_api_key)}

    @app.get("/api/projects")
    def list_projects():
        return app.state.store.list_projects()

    @app.post("/api/projects", status_code=201)
    def create_project(body: NewProject):
        return app.state.store.create_project(body.name)

    @app.get("/api/conversations")
    def list_conversations():
        return app.state.store.list_conversations()

    @app.post("/api/conversations", status_code=201)
    def create_conversation(body: NewConversation):
        validate_project(body.project_id)
        return app.state.store.create_conversation(body.project_id, body.title)

    @app.get("/api/conversations/{conversation_id}")
    def get_conversation(conversation_id: str):
        return require_conversation(conversation_id)

    @app.patch("/api/conversations/{conversation_id}")
    def update_conversation(conversation_id: str, body: ConversationPatch):
        require_conversation(conversation_id)
        fields = body.model_dump(exclude_unset=True)
        if "project_id" in fields:
            validate_project(fields["project_id"])
        return app.state.store.update_conversation(conversation_id, fields)

    @app.delete("/api/conversations/{conversation_id}", status_code=204)
    async def delete_conversation(conversation_id: str):
        require_conversation(conversation_id)
        lock = app.state.thread_locks.setdefault(conversation_id, asyncio.Lock())
        if lock.locked():
            raise HTTPException(status_code=409, detail="请先停止当前回复，再删除会话")
        await lock.acquire()
        try:
            # Use the checkpointer's public API so only this thread's namespaces are removed.
            await app.state.saver.adelete_thread(conversation_id)
            app.state.store.delete_conversation(conversation_id)
        finally:
            lock.release()
            app.state.thread_locks.pop(conversation_id, None)
        return Response(status_code=204)

    @app.get("/api/conversations/{conversation_id}/messages")
    async def list_messages(conversation_id: str):
        require_conversation(conversation_id)
        # Recover a projection missed by a process exit after checkpoint commit.
        await sync_projection(conversation_id)
        return app.state.store.messages(conversation_id)

    @app.get("/api/search")
    def search(q: str = Query(default="", max_length=200)):
        return app.state.store.search(q)

    @app.post("/agent")
    async def run_agent(input_data: RunAgentInput, request: Request):
        require_conversation(input_data.thread_id)
        encoder = EventEncoder(accept=request.headers.get("accept"))
        thread_id = input_data.thread_id
        lock = app.state.thread_locks.setdefault(thread_id, asyncio.Lock())

        def started():
            return RunStartedEvent(thread_id=thread_id, run_id=input_data.run_id)

        async def error_stream(code: str, message: str):
            yield encoder.encode(started())
            yield encoder.encode(RunErrorEvent(code=code, message=message))

        if lock.locked():
            return StreamingResponse(
                error_stream("THREAD_BUSY", "当前会话正在生成回复，请先停止或等待完成。"),
                media_type=encoder.get_content_type(),
            )

        # Acquire before returning the stream, preventing concurrent runs/deletes.
        await lock.acquire()

        async def event_generator():
            has_started = False
            try:
                # Empty runs are history hydration, never model invocations.
                if not input_data.messages:
                    await sync_projection(thread_id)
                    yield encoder.encode(started())
                    yield encoder.encode(MessagesSnapshotEvent(messages=app.state.store.messages(thread_id)))
                    yield encoder.encode(RunFinishedEvent(thread_id=thread_id, run_id=input_data.run_id))
                    return

                if app.state.agui is None:
                    async for frame in error_stream(
                        "DEEPSEEK_KEY_MISSING",
                        "请先在 backend/.env 配置 DEEPSEEK_API_KEY，并重启后端服务。",
                    ):
                        yield frame
                    return

                # Checkpoint is authoritative. Send only new user messages; existing
                # history and tool messages stay in durable state under the same IDs.
                state = await app.state.graph.aget_state({"configurable": {"thread_id": thread_id}})
                known_ids = {message.id for message in state.values.get("messages", [])}
                new_users = [
                    message for message in input_data.messages
                    if message.role == "user" and message.id not in known_ids and text_content(message.content).strip()
                ]
                if not new_users:
                    await sync_projection(thread_id)
                    yield encoder.encode(started())
                    yield encoder.encode(MessagesSnapshotEvent(messages=app.state.store.messages(thread_id)))
                    yield encoder.encode(RunFinishedEvent(thread_id=thread_id, run_id=input_data.run_id))
                    return

                # This MVP has no frontend tools or shared graph state. Client-owned
                # state/tool definitions must not overwrite the backend's checkpoint.
                run_input = input_data.model_copy(update={
                    "messages": new_users, "state": {}, "tools": [],
                    "context": [], "forwarded_props": {}, "resume": None,
                })
                request_agent = app.state.agui.clone()
                async for event in request_agent.run(run_input):
                    if await request.is_disconnected():
                        break
                    if event.type == EventType.RUN_STARTED:
                        has_started = True
                    if event.type == EventType.RUN_ERROR:
                        code, message = public_model_error(event.message)
                        event = RunErrorEvent(code=code, message=message)
                    if event.type in {EventType.RUN_FINISHED, EventType.RUN_ERROR}:
                        # Persist title/search projection before announcing run completion.
                        await sync_projection(thread_id)
                    yield encoder.encode(event)
            except asyncio.CancelledError:
                # Browser/Runtime stop aborts the HTTP stream and model task.
                raise
            except Exception as exc:
                logger.error("Agent run failed (%s)", type(exc).__name__)
                if not has_started:
                    yield encoder.encode(started())
                code, message = public_model_error(type(exc).__name__)
                yield encoder.encode(RunErrorEvent(code=code, message=message))
            finally:
                try:
                    await asyncio.shield(sync_projection(thread_id))
                except Exception as exc:
                    logger.error("Message projection sync failed (%s)", type(exc).__name__)
                finally:
                    lock.release()

        return StreamingResponse(
            event_generator(), media_type=encoder.get_content_type(),
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app


app = create_app()
