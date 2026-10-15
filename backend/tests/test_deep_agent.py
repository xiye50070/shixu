"""Exercise the production Deep Agent against temporary disk and a local model."""

from pathlib import Path
from typing import Any

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import Field

from app.deep_agent import (
    DELETE_DISABLED,
    FILESYSTEM_TOOLS,
    WorkspaceFilesystemBackend,
    build_deep_graph,
    build_filesystem_backend,
)


class ScriptedToolModel(BaseChatModel):
    """Follow a deterministic script while using the real Agent/tool runtime."""

    responses: list[AIMessage]
    bindings: list[set[str]] = Field(default_factory=list)
    requests: list[list[BaseMessage]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "scripted-filesystem-test"

    def bind_tools(self, tools, *, tool_choice=None, **kwargs):
        self.bindings.append({tool.name if hasattr(tool, "name") else tool["name"] for tool in tools})
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.requests.append(list(messages))
        if not self.responses:
            raise AssertionError("Unexpected model call beyond the test script")
        return ChatResult(generations=[ChatGeneration(message=self.responses.pop(0))])


def call(name: str, args: dict[str, Any], call_id: str = "call-1") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


async def run_script(workspace: Path, responses: list[AIMessage]):
    model = ScriptedToolModel(responses=responses)
    graph = build_deep_graph(
        model=model,
        checkpointer=InMemorySaver(),
        workspace_dir=workspace,
    )
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="按指定步骤处理工作区文件。", id="h1")]},
        {"configurable": {"thread_id": "file-test"}},
    )
    return model, result


async def test_real_deep_agent_lists_reads_writes_edits_and_searches(tmp_path):
    workspace = tmp_path / "agent-files"
    workspace.mkdir()
    (workspace / "说明.md").write_text("拾序本地文件练习", encoding="utf-8")
    model, result = await run_script(workspace, [
        call("ls", {"path": "/workspace/"}, "list"),
        call("write_file", {"file_path": "/workspace/reports/摘要.md", "content": "模型配置：第一版\n"}, "write"),
        call("edit_file", {"file_path": "/workspace/reports/摘要.md", "old_string": "第一版", "new_string": "第二版"}, "edit"),
        call("read_file", {"file_path": "/workspace/reports/摘要.md"}, "read"),
        call("glob", {"pattern": "**/*.md", "path": "/workspace/"}, "glob"),
        call("grep", {"pattern": "模型配置", "path": "/workspace/", "output_mode": "content"}, "grep"),
        AIMessage(content="已根据实际工具结果完成练习。"),
    ])
    outputs = {message.tool_call_id: message for message in result["messages"] if isinstance(message, ToolMessage)}
    assert set(outputs) == {"list", "write", "edit", "read", "glob", "grep"}
    assert all(message.status == "success" for message in outputs.values())
    assert "/workspace/说明.md" in outputs["list"].content
    assert (workspace / "reports" / "摘要.md").read_text(encoding="utf-8") == "模型配置：第二版\n"
    assert "第二版" in str(outputs["read"].content)
    assert "/workspace/reports/摘要.md" in outputs["glob"].content
    assert "第二版" in outputs["grep"].content
    assert model.bindings and set(FILESYSTEM_TOOLS) <= model.bindings[0]
    assert "task" in model.bindings[0]
    assert all(not ({"delete", "execute"} & names) for names in model.bindings)


@pytest.mark.parametrize("tool_name,args", [
    ("delete", {"file_path": "/workspace/keep.md"}),
    ("execute", {"command": "rm /workspace/keep.md"}),
])
async def test_unregistered_delete_and_shell_calls_are_rejected(tmp_path, tool_name, args):
    workspace = tmp_path / "agent-files"
    workspace.mkdir()
    kept = workspace / "keep.md"
    kept.write_text("保留", encoding="utf-8")
    model, result = await run_script(workspace, [call(tool_name, args), AIMessage(content="该工具不可用。")])
    error = next(message for message in result["messages"] if isinstance(message, ToolMessage))
    assert error.status == "error"
    assert "not a valid tool" in error.content
    assert kept.read_text(encoding="utf-8") == "保留"
    assert all(not ({"delete", "execute"} & names) for names in model.bindings)


async def test_default_subagent_inherits_allowlist_and_can_write(tmp_path):
    model, result = await run_script(tmp_path / "agent-files", [
        call("task", {"description": "在 /workspace/ 中写一份摘要。", "subagent_type": "general-purpose"}, "delegate"),
        call("write_file", {"file_path": "/workspace/委派结果.md", "content": "子 Agent 写入成功"}, "sub-write"),
        call("delete", {"file_path": "/workspace/委派结果.md"}, "sub-delete"),
        call("execute", {"command": "rm /workspace/委派结果.md"}, "sub-execute"),
        AIMessage(content="已保存摘要，删除和终端工具不可用。"),
        AIMessage(content="子任务已完成。"),
    ])
    assert (tmp_path / "agent-files" / "委派结果.md").read_text(encoding="utf-8") == "子 Agent 写入成功"
    assert len(model.bindings) >= 5
    assert all(set(FILESYSTEM_TOOLS) <= names for names in model.bindings)
    assert all(not ({"delete", "execute"} & names) for names in model.bindings)
    child_errors = [
        message
        for request in model.requests
        for message in request
        if isinstance(message, ToolMessage) and message.tool_call_id in {"sub-delete", "sub-execute"}
    ]
    assert {message.tool_call_id for message in child_errors} == {"sub-delete", "sub-execute"}
    assert all(message.status == "error" for message in child_errors)
    assert result["messages"][-1].content == "子任务已完成。"


async def test_delete_is_also_disabled_at_backend_layer(tmp_path):
    backend = build_filesystem_backend(tmp_path / "agent-files")
    assert (await backend.awrite("/workspace/keep.md", "保留")).error is None
    for path in ("/workspace/keep.md", "/workspace/", "/internal.md"):
        assert backend.delete(path).error == DELETE_DISABLED
        assert (await backend.adelete(path)).error == DELETE_DISABLED
    disk = backend.routes["/workspace/"]
    assert isinstance(disk, WorkspaceFilesystemBackend)
    assert disk.delete("/keep.md").error == DELETE_DISABLED
    assert (await disk.adelete("/keep.md")).error == DELETE_DISABLED
    assert (tmp_path / "agent-files" / "keep.md").read_text(encoding="utf-8") == "保留"


@pytest.mark.parametrize("tool_name,args", [
    ("read_file", {"file_path": "/workspace/../outside.md"}),
    ("write_file", {"file_path": "/workspace/../outside.md", "content": "不应写入"}),
    ("read_file", {"file_path": "/workspace/escape/outside.md"}),
    ("write_file", {"file_path": "/workspace/escape/outside.md", "content": "不应写入"}),
    ("edit_file", {"file_path": "/workspace/escape/outside.md", "old_string": "外部秘密", "new_string": "不应写入"}),
    ("ls", {"path": "/workspace/escape/"}),
    ("grep", {"pattern": "外部秘密", "path": "/workspace/escape/"}),
    ("glob", {"pattern": "**/*.md", "path": "/workspace/escape/"}),
])
async def test_traversal_and_symlink_escape_do_not_read_or_modify_outside_files(tmp_path, tool_name, args):
    workspace = tmp_path / "agent-files"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    outside_file = outside / "outside.md"
    outside_file.write_text("外部秘密", encoding="utf-8")
    (workspace / "escape").symlink_to(outside, target_is_directory=True)
    _, result = await run_script(workspace, [call(tool_name, args), AIMessage(content="操作被拒绝。")])
    tool_message = next(message for message in result["messages"] if isinstance(message, ToolMessage))
    assert tool_message.status == "error"
    assert "外部秘密" not in str(tool_message.content)
    assert outside_file.read_text(encoding="utf-8") == "外部秘密"
    assert not (tmp_path / "outside.md").exists()


async def test_nonworkspace_paths_use_checkpoint_state_instead_of_host_disk(tmp_path):
    workspace = tmp_path / "agent-files"
    _, result = await run_script(workspace, [
        call("write_file", {"file_path": "/large_tool_results/internal.md", "content": "内部临时内容"}, "internal-write"),
        call("read_file", {"file_path": "/large_tool_results/internal.md"}, "internal-read"),
        AIMessage(content="内部内容已写入状态。"),
    ])
    assert not (workspace / "large_tool_results").exists()
    outputs = [message for message in result["messages"] if isinstance(message, ToolMessage)]
    assert all(message.status == "success" for message in outputs)
    assert "内部临时内容" in str(outputs[-1].content)
    assert "/large_tool_results/internal.md" in result["files"]


def snapshot(root, *, name=None, grants=(), protected=()):
    return {
        "kind": "project" if name else "default", "root_dir": str(root.resolve()),
        "project_id": "p1" if name else None, "project_name": name,
        "grants": list(grants), "protected_paths": [str(path.resolve()) for path in protected],
    }


async def run_workspace(root, workspace, responses, *, context=None):
    model = ScriptedToolModel(responses=responses)
    graph = build_deep_graph(model=model, checkpointer=InMemorySaver(), workspace_dir=root, workspace=workspace)
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="处理当前项目文件。", id="h1")]},
        {"configurable": {"thread_id": "workspace-test"}},
        context=context or {"workspace": workspace},
    )
    return model, result


async def test_runtime_context_and_relative_paths_are_identical_in_main_and_child(tmp_path):
    root = tmp_path / "project-a"
    root.mkdir()
    external = tmp_path / "materials"
    external.mkdir()
    grant = {"id": "g1", "path": str(external), "kind": "directory", "access": "read", "mount_path": "/external/g1/"}
    workspace = snapshot(root, name="项目 A", grants=[grant])
    model, result = await run_workspace(root, workspace, [
        call("write_file", {"file_path": "主报告.md", "content": "主 Agent"}, "main-write"),
        call("task", {"description": "在当前项目中写子报告。", "subagent_type": "general-purpose"}, "delegate"),
        call("write_file", {"file_path": "子报告.md", "content": "子 Agent"}, "child-write"),
        call("write_file", {"file_path": str(external / "denied.md"), "content": "不能写"}, "child-readonly"),
        AIMessage(content="子报告写入成功，外部只读文件写入被拒绝。"),
        AIMessage(content="报告已完成。"),
    ])
    assert (root / "主报告.md").read_text() == "主 Agent"
    assert (root / "子报告.md").read_text() == "子 Agent"
    assert not (external / "denied.md").exists()
    assert result["messages"][-1].content == "报告已完成。"
    # A child with missing Runtime context fails the strict dynamic middleware,
    # so reaching every model call proves context propagation, not prompt fallback.
    for request in model.requests:
        system = "\n".join(str(message.content) for message in request if message.type == "system")
        assert "你是拾序" in system
        assert "当前项目：项目 A" in system
        assert f"实际工作目录：{root}" in system
        assert f"/external/g1/ → {external}（只读）" in system
        assert "删除操作：禁止" in system
        assert system.count("当前文件环境") == 1


async def test_different_workspace_runs_never_switch_each_others_root(tmp_path):
    import asyncio

    roots = [tmp_path / "project-a", tmp_path / "project-b"]
    for root in roots:
        root.mkdir()
    await asyncio.gather(*[
        run_workspace(root, snapshot(root, name=root.name), [
            call("write_file", {"file_path": "report.md", "content": root.name}),
            AIMessage(content="完成"),
        ])
        for root in roots
    ])
    assert [(root / "report.md").read_text() for root in roots] == ["project-a", "project-b"]


async def test_context_cannot_advertise_a_different_workspace(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    workspace = snapshot(root, name="项目 A")
    other = {**workspace, "project_name": "伪造项目"}
    with pytest.raises(ValueError, match="文件环境与本次运行不一致"):
        await run_workspace(root, workspace, [AIMessage(content="不应到达")], context={"workspace": other})


async def test_unknown_absolute_path_is_an_error_instead_of_checkpoint_file(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    outside = tmp_path / "outside.md"
    _, result = await run_workspace(root, snapshot(root), [
        call("write_file", {"file_path": str(outside), "content": "不应保存"}, "denied"),
        AIMessage(content="请先授权该外部路径。"),
    ])
    output = next(message for message in result["messages"] if isinstance(message, ToolMessage))
    assert output.status == "error"
    assert "授权" in str(output.content)
    assert not outside.exists()
    assert not result.get("files")
