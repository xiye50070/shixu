from __future__ import annotations

import asyncio
import logging
import os
from ipaddress import ip_address
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Literal
from urllib.parse import urlsplit
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
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.responses import JSONResponse, StreamingResponse
from langchain_core.tools import tool
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from pydantic import BaseModel, Field, field_validator

from .deep_agent import build_deep_graph
from .model_settings import (
    ModelConfiguration,
    ModelSettingsInput,
    build_chat_model,
    normalize_base_url,
    resolve_model_settings,
)
from .storage import BusinessStore, text_content
from .workspaces import WorkspaceSnapshot, browse_paths, canonical_path
from .native_picker import NativePickerError, choose_native_path, starting_directory



BASE_DIR = Path(__file__).resolve().parent.parent
logger = logging.getLogger("shixu_work")
# The adapter otherwise logs provider exception bodies. Our stream returns
# sanitized error messages and this application logs exception classes only.
logging.getLogger("ag_ui_langgraph.agent").setLevel(logging.CRITICAL + 1)


@dataclass(frozen=True)
class Settings:
    data_dir: Path = BASE_DIR.parent / "data"
    files_dir: Path = BASE_DIR.parent / "agent-files"
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
            files_dir=Path(os.getenv("WORKSPACE_FILES_DIR") or values.get("WORKSPACE_FILES_DIR") or BASE_DIR.parent / "agent-files").expanduser().resolve(),
            deepseek_api_key=(os.getenv("DEEPSEEK_API_KEY") or values.get("DEEPSEEK_API_KEY") or "").strip(),
            deepseek_base_url=(os.getenv("DEEPSEEK_BASE_URL") or values.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com").strip(),
            max_output_tokens=integer_setting("DEEPSEEK_MAX_TOKENS", 1024),
            max_retries=integer_setting("DEEPSEEK_MAX_RETRIES", 1),
        )

    def model_configuration(self) -> ModelConfiguration:
        # Existing installations keep working until a setting is saved in the UI.
        return ModelConfiguration(
            api_key=self.deepseek_api_key,
            base_url=normalize_base_url(self.deepseek_base_url),
            max_output_tokens=self.max_output_tokens,
            max_retries=self.max_retries,
        )


@tool
def get_current_time() -> str:
    """Get the current date and time in Asia/Shanghai when the user asks for it."""
    return datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S Asia/Shanghai")


def build_graph(
    checkpointer: AsyncSqliteSaver,
    settings: ModelConfiguration | Settings,
    *,
    workspace_dir: Path | None = None,
    workspace: WorkspaceSnapshot | None = None,
):
    config = settings.model_configuration() if isinstance(settings, Settings) else settings
    model = build_chat_model(config)
    return build_deep_graph(
        model=model,
        tools=[get_current_time],
        workspace_dir=workspace_dir or (settings.files_dir if isinstance(settings, Settings) else BASE_DIR.parent / "agent-files"),
        checkpointer=checkpointer,
        workspace=workspace,
    )


class NewProject(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    workspace_path: str = Field(min_length=1, max_length=4096)

    @field_validator("name", mode="before")
    @classmethod
    def strip_name(cls, value):
        return value.strip() if isinstance(value, str) else value


class ProjectWorkspaceInput(BaseModel):
    workspace_path: str = Field(min_length=1, max_length=4096)


class WorkspaceSettingsInput(BaseModel):
    default_workspace_path: str = Field(min_length=1, max_length=4096)


class FilesystemGrantInput(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    access: Literal["read", "read_write"]


class NativePickerInput(BaseModel):
    initial_path: str | None = Field(default=None, max_length=4096)
    include_files: bool = False
    title: str = Field(default="选择工作目录", min_length=1, max_length=100)


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
        return "MODEL_AUTH_ERROR", "模型 API Key 无效，请在设置 → 模型配置中检查。"
    if any(part in lowered for part in ("429", "rate limit", "insufficient", "balance", "402")):
        return "MODEL_QUOTA_ERROR", "模型配额或余额不足，请检查账号后重试。"
    if any(part in lowered for part in ("timeout", "timed out", "connection")):
        return "MODEL_CONNECTION_ERROR", "连接模型失败或超时，请检查网络及设置 → 模型配置。"
    if any(part in lowered for part in ("model", "400", "404")):
        return "MODEL_REQUEST_ERROR", "模型请求未成功，请在设置 → 模型配置中检查模型名称和 Base URL。"
    return "MODEL_RUN_ERROR", "模型执行失败，请检查设置 → 模型配置后重试。"


def create_app(
    settings: Settings | None = None,
    graph_factory: Callable | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        app.state.store = BusinessStore(settings.data_dir / "workspace.db")
        # Only bootstrap paths are created automatically; missing configured
        # directories never silently fall back to another workspace.
        settings.files_dir.expanduser().resolve().mkdir(parents=True, exist_ok=True)
        app.state.protected_paths = [
            str(settings.data_dir.resolve()), str(BASE_DIR / ".env"),
            str(BASE_DIR / ".venv"), str(BASE_DIR.parent / ".git"),
        ]
        app.state.thread_locks = {}
        app.state.native_picker_lock = asyncio.Lock()
        app.state.active_model_runs = 0
        saved_model = app.state.store.model_settings()
        app.state.model_config = (
            ModelConfiguration.from_saved(saved_model)
            if saved_model is not None else settings.model_configuration()
        )
        async with AsyncSqliteSaver.from_conn_string(str(settings.data_dir / "checkpoints.db")) as saver:
            await saver.setup()
            app.state.saver = saver
            app.state.graph, app.state.agui = build_runtime(app.state.model_config)
            yield

    app = FastAPI(title="Shixu Work", version="0.1.0", lifespan=lifespan)

    def build_runtime(config: ModelConfiguration, workspace: WorkspaceSnapshot | None = None):
        if graph_factory is not None:
            graph = graph_factory(app.state.saver, config)
        elif config.api_key:
            graph = build_graph(
                app.state.saver, config,
                workspace_dir=Path(workspace["root_dir"]) if workspace else settings.files_dir,
                workspace=workspace,
            )
        else:
            graph = None
        agent = LangGraphAgent(
            name="assistant", graph=graph,
            description="拾序工作助手", emit_raw_events=False,
        ) if graph is not None else None
        return graph, agent

    @app.exception_handler(RequestValidationError)
    async def safe_validation_errors(request: Request, exc: RequestValidationError):
        if request.url.path.startswith("/api/settings/model"):
            # Pydantic errors include raw input values (even SecretStr fields),
            # so omit the entire error list on credential-bearing endpoints.
            return JSONResponse(status_code=422, content={"detail": "模型配置格式不正确，请检查供应商、模型名称、Base URL、API Key 和输出长度。"})
        return await request_validation_exception_handler(request, exc)

    def require_conversation(conversation_id: str):
        conversation = app.state.store.conversation(conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="会话不存在")
        return conversation

    def validate_project(project_id: str | None):
        if project_id is not None and not app.state.store.project_exists(project_id):
            raise HTTPException(status_code=404, detail="项目不存在")

    def validated_path(value: str, *, directory: bool = False, writable: bool = False) -> Path:
        try:
            path = canonical_path(value, directory=directory, writable=writable)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        if any(path == Path(protected) or Path(protected) in path.parents for protected in app.state.protected_paths):
            raise HTTPException(status_code=422, detail="应用数据、密钥和运行环境目录不能作为 Agent 工作目录或授权路径。")
        return path

    def default_workspace_path() -> str:
        return app.state.store.default_workspace_path() or str(settings.files_dir.expanduser().resolve())

    def resolve_workspace_context(thread_id: str) -> WorkspaceSnapshot:
        conversation = require_conversation(thread_id)
        project = app.state.store.project(conversation["project_id"]) if conversation["project_id"] else None
        if project is not None and not project["workspace_path"]:
            raise ValueError("这个项目尚未设置工作目录，请打开目录与授权并选择项目目录。")
        selected = project["workspace_path"] if project else default_workspace_path()
        root = canonical_path(selected, directory=True, writable=True)
        if root != Path(selected):
            raise ValueError("工作目录的实际位置已变化，请重新选择并确认目录。")
        return {
            "kind": "project" if project else "default", "root_dir": str(root),
            "project_id": project["id"] if project else None,
            "project_name": project["name"] if project else None,
            "grants": app.state.store.grants(thread_id),
            "protected_paths": list(app.state.protected_paths),
        }

    def require_idle(thread_id: str | None = None):
        busy = app.state.active_model_runs if thread_id is None else (
            thread_id in app.state.thread_locks and app.state.thread_locks[thread_id].locked()
        )
        if busy:
            raise HTTPException(status_code=409, detail="请先停止或等待当前任务完成，再更改目录或授权。")

    async def sync_projection(thread_id: str):
        if app.state.graph is None:
            return
        state = await app.state.graph.aget_state({"configurable": {"thread_id": thread_id}})
        app.state.store.sync_messages(thread_id, state.values.get("messages", []))

    @app.get("/api/health")
    def health():
        config = app.state.model_config
        return {"status": "ok", "provider": config.provider, "model": config.model, "model_configured": bool(config.api_key)}

    @app.get("/api/settings/model")
    async def get_model_settings():
        return app.state.model_config.public()

    def candidate_model_config(body: ModelSettingsInput):
        try:
            return resolve_model_settings(body, app.state.model_config)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None

    @app.put("/api/settings/model")
    async def save_model_settings(body: ModelSettingsInput):
        # No awaits between this check and runtime replacement: an agent run
        # cannot begin on a half-updated configuration in this ASGI process.
        if app.state.active_model_runs:
            raise HTTPException(status_code=409, detail="请先停止或等待当前回复完成，再保存模型配置。")
        config = candidate_model_config(body)
        try:
            graph, agent = build_runtime(config)
            app.state.store.save_model_settings(config.stored())
        except Exception as exc:
            logger.error("Model configuration save failed (%s)", type(exc).__name__)
            raise HTTPException(status_code=500, detail="模型配置保存失败，请检查本地存储和配置后重试。") from None
        app.state.model_config = config
        app.state.graph, app.state.agui = graph, agent
        return config.public()

    @app.post("/api/settings/model/test")
    async def test_model_settings(body: ModelSettingsInput):
        config = candidate_model_config(body)
        try:
            model = build_chat_model(config, for_test=True)
            await asyncio.wait_for(model.ainvoke("请仅回复 OK。"), timeout=25)
        except Exception as exc:
            logger.error("Model connection test failed (%s)", type(exc).__name__)
            _, message = public_model_error(str(exc))
            status = 504 if isinstance(exc, (TimeoutError, asyncio.TimeoutError)) else 502
            raise HTTPException(status_code=status, detail=message) from None
        return {"ok": True, "message": "连接成功，模型已响应。"}

    @app.get("/api/projects")
    def list_projects():
        return app.state.store.list_projects()

    @app.post("/api/projects", status_code=201)
    def create_project(body: NewProject):
        path = validated_path(body.workspace_path, directory=True, writable=True)
        return app.state.store.create_project(body.name, str(path))

    @app.patch("/api/projects/{project_id}")
    async def set_project_workspace(project_id: str, body: ProjectWorkspaceInput):
        validate_project(project_id)
        require_idle()
        path = validated_path(body.workspace_path, directory=True, writable=True)
        return app.state.store.set_project_workspace(project_id, str(path))

    @app.delete("/api/projects/{project_id}", status_code=204)
    async def delete_project(project_id: str):
        validate_project(project_id)
        # No awaits between the per-project busy check and the atomic database
        # mutation: a new local Agent run cannot begin on a half-deleted project.
        members = app.state.store.project_conversation_ids(project_id)
        if any(
            thread_id in app.state.thread_locks and app.state.thread_locks[thread_id].locked()
            for thread_id in members
        ):
            raise HTTPException(status_code=409, detail="这个项目中有任务正在运行，请先停止或等待完成，再删除项目。")
        if not app.state.store.delete_project(project_id):
            raise HTTPException(status_code=404, detail="项目不存在")
        return Response(status_code=204)

    @app.get("/api/settings/workspace")
    def get_workspace_settings():
        return {"default_workspace_path": default_workspace_path()}

    @app.put("/api/settings/workspace")
    async def save_workspace_settings(body: WorkspaceSettingsInput):
        require_idle()
        path = validated_path(body.default_workspace_path, directory=True, writable=True)
        app.state.store.save_default_workspace_path(str(path))
        return {"default_workspace_path": str(path)}

    @app.get("/api/filesystem/browse")
    def browse_filesystem(path: str | None = Query(default=None, max_length=4096), include_files: bool = False):
        try:
            return browse_paths(path, initial=Path(default_workspace_path()), include_files=include_files)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None

    @app.post("/api/filesystem/pick")
    async def pick_filesystem_path(body: NativePickerInput, request: Request):
        # Only the local browser's UI bridge can open host windows. This is not
        # an Agent tool, and selecting a path does not grant or save anything.
        try:
            local_client = bool(request.client and ip_address(request.client.host).is_loopback)
        except ValueError:
            local_client = False
        if not local_client:
            raise HTTPException(status_code=403, detail="系统选择窗口只允许在运行拾序的本机调用。")
        origin = request.headers.get("origin")
        try:
            same_origin = not origin or urlsplit(origin).netloc == request.headers.get("host")
        except ValueError:
            same_origin = False
        if not same_origin:
            raise HTTPException(status_code=403, detail="此操作只允许从当前拾序页面发起。")
        lock = app.state.native_picker_lock
        if lock.locked():
            raise HTTPException(status_code=409, detail="已有系统选择窗口打开，请先完成或取消选择。")
        async with lock:
            task = asyncio.create_task(choose_native_path(
                initial_path=starting_directory(body.initial_path, Path(default_workspace_path())),
                include_files=body.include_files, title=body.title,
            ))
            try:
                while not task.done():
                    if await request.is_disconnected():
                        raise asyncio.CancelledError
                    await asyncio.wait({task}, timeout=0.2)
                result = task.result()
                if not result["cancelled"]:
                    result["path"] = str(validated_path(result["path"], directory=not body.include_files))
                return result
            except NativePickerError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from None
            finally:
                if not task.done():
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass

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

    @app.get("/api/conversations/{conversation_id}/workspace")
    def get_conversation_workspace(conversation_id: str):
        conversation = require_conversation(conversation_id)
        try:
            snapshot = resolve_workspace_context(conversation_id)
            return {key: value for key, value in {**snapshot, "available": True}.items() if key != "protected_paths"}
        except ValueError as exc:
            project = app.state.store.project(conversation["project_id"]) if conversation["project_id"] else None
            return {
                "kind": "project" if project else "default", "root_dir": project["workspace_path"] if project else default_workspace_path(),
                "project_id": project["id"] if project else None, "project_name": project["name"] if project else None,
                "grants": app.state.store.grants(conversation_id), "available": False, "error": str(exc),
            }

    @app.post("/api/conversations/{conversation_id}/grants", status_code=201)
    async def grant_filesystem_path(conversation_id: str, body: FilesystemGrantInput):
        require_conversation(conversation_id)
        require_idle(conversation_id)
        path = validated_path(body.path, writable=body.access == "read_write")
        # An external grant belongs only to this conversation; a project name,
        # model-generated path or client context cannot create one implicitly.
        return app.state.store.save_grant(conversation_id, str(path), "directory" if path.is_dir() else "file", body.access)

    @app.delete("/api/conversations/{conversation_id}/grants/{grant_id}", status_code=204)
    async def revoke_filesystem_path(conversation_id: str, grant_id: str):
        require_conversation(conversation_id)
        require_idle(conversation_id)
        if not app.state.store.revoke_grant(conversation_id, grant_id):
            raise HTTPException(status_code=404, detail="授权不存在或已经撤销。")
        return Response(status_code=204)

    @app.patch("/api/conversations/{conversation_id}")
    async def update_conversation(conversation_id: str, body: ConversationPatch):
        require_conversation(conversation_id)
        fields = body.model_dump(exclude_unset=True)
        if "project_id" in fields:
            require_idle(conversation_id)
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
        model_run = bool(input_data.messages)
        if model_run:
            app.state.active_model_runs += 1

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
                        "MODEL_KEY_MISSING",
                        "请先打开设置 → 模型配置，填写 API Key 并保存。",
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
                try:
                    workspace = resolve_workspace_context(thread_id)
                except ValueError as exc:
                    async for frame in error_stream("WORKSPACE_UNAVAILABLE", str(exc)):
                        yield frame
                    return
                # Each run owns its backend and frozen workspace selection.
                # Never switch a shared FilesystemBackend.root_dir in place.
                if graph_factory is None:
                    try:
                        _, selected_agent = build_runtime(app.state.model_config, workspace)
                    except (ValueError, OSError):
                        async for frame in error_stream(
                            "WORKSPACE_UNAVAILABLE", "工作目录或外部授权路径已变化，请打开目录与授权检查并重新选择。",
                        ):
                            yield frame
                        return
                else:
                    selected_agent = app.state.agui
                request_agent = selected_agent.clone()
                request_agent.config = {
                    **request_agent.config,
                    "configurable": {
                        **request_agent.config.get("configurable", {}), "workspace": workspace,
                    },
                }
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
                    if model_run:
                        app.state.active_model_runs -= 1

        return StreamingResponse(
            event_generator(), media_type=encoder.get_content_type(),
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app


app = create_app()
