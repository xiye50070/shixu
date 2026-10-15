"""Workspace selection is a server-owned fact, independent of model output."""

import asyncio
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.runtime import Runtime

from app.main import Settings, create_app
from app.storage import BusinessStore
from app.workspaces import ShixuContext
from test_api import parse_events, run_body


def environment(tmp_path):
    for name in ("default", "alternate", "project-a", "project-b", "external"):
        (tmp_path / name).mkdir()
    return Settings(data_dir=tmp_path / "data", files_dir=tmp_path / "default")


def test_paths_selection_permissions_and_restart(tmp_path):
    settings = environment(tmp_path)
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/settings/workspace").json()["default_workspace_path"] == str(tmp_path / "default")
        assert client.post("/api/projects", json={"name": "项目"}).status_code == 422
        for invalid in ("relative/path", str(tmp_path / "missing"), str(tmp_path / "data")):
            assert client.post("/api/projects", json={"name": "项目", "workspace_path": invalid}).status_code == 422
        project = client.post("/api/projects", json={"name": "项目A", "workspace_path": str(tmp_path / "project-a")}).json()
        cid = client.post("/api/conversations", json={"project_id": project["id"]}).json()["id"]
        plain = client.post("/api/conversations", json={}).json()["id"]
        state = client.get(f"/api/conversations/{cid}/workspace").json()
        assert state["available"] and state["kind"] == "project" and state["root_dir"] == str(tmp_path / "project-a")
        assert "protected_paths" not in state
        assert client.put("/api/settings/workspace", json={"default_workspace_path": str(tmp_path / "alternate")}).status_code == 200
        assert client.get(f"/api/conversations/{plain}/workspace").json()["root_dir"] == str(tmp_path / "alternate")
        assert client.get(f"/api/conversations/{cid}/workspace").json()["root_dir"] == str(tmp_path / "project-a")
        grant = client.post(f"/api/conversations/{cid}/grants", json={"path": str(tmp_path / "external"), "access": "read"}).json()
        assert grant["kind"] == "directory" and grant["access"] == "read"
        assert grant["mount_path"] == f"/external/{grant['id']}/"
        assert client.get(f"/api/conversations/{plain}/workspace").json()["grants"] == []
        upgraded = client.post(f"/api/conversations/{cid}/grants", json={"path": str(tmp_path / "external"), "access": "read_write"}).json()
        assert upgraded["id"] == grant["id"] and upgraded["access"] == "read_write"
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/settings/workspace").json()["default_workspace_path"] == str(tmp_path / "alternate")
        assert client.get(f"/api/conversations/{cid}/workspace").json()["grants"] == [upgraded]
        assert client.delete(f"/api/conversations/{plain}/grants/{grant['id']}").status_code == 404
        assert client.delete(f"/api/conversations/{cid}/grants/{grant['id']}").status_code == 204
        assert client.get(f"/api/conversations/{cid}/workspace").json()["grants"] == []


def test_picker_only_lists_and_does_not_grant_file_contents(tmp_path):
    settings = environment(tmp_path)
    (tmp_path / "external" / "source.txt").write_text("PRIVATE_BODY_NEVER_LISTED")
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/filesystem/browse").json()["path"] == str(tmp_path / "default")
        result = client.get("/api/filesystem/browse", params={"path": str(tmp_path / "external"), "include_files": True})
        assert result.json()["entries"] == [{"name": "source.txt", "path": str(tmp_path / "external" / "source.txt"), "kind": "file"}]
        assert "PRIVATE_BODY" not in result.text
        assert client.get("/api/filesystem/browse", params={"path": "relative"}).status_code == 422
        cid = client.post("/api/conversations", json={}).json()["id"]
        assert client.get(f"/api/conversations/{cid}/workspace").json()["grants"] == []
        granted = client.post(f"/api/conversations/{cid}/grants", json={"path": str(tmp_path / "external" / "source.txt"), "access": "read"}).json()
        assert granted["kind"] == "file"
        assert client.post(f"/api/conversations/{cid}/grants", json={"path": str(tmp_path / "data"), "access": "read"}).status_code == 422


def test_legacy_projects_are_retained_but_require_deliberate_selection(tmp_path):
    settings = environment(tmp_path)
    settings.data_dir.mkdir()
    db_path = settings.data_dir / "workspace.db"
    with sqlite3.connect(db_path) as db:
        db.execute("CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)")
        db.execute("INSERT INTO projects VALUES ('legacy', '旧项目', '2026-01-01')")
    with TestClient(create_app(settings)) as client:
        project = client.get("/api/projects").json()[0]
        assert project["id"] == "legacy" and project["workspace_path"] is None
        cid = client.post("/api/conversations", json={"project_id": "legacy"}).json()["id"]
        result = client.get(f"/api/conversations/{cid}/workspace").json()
        assert not result["available"] and result["root_dir"] is None
        assert client.patch("/api/projects/legacy", json={"workspace_path": str(tmp_path / "project-a")}).status_code == 200
        assert client.get(f"/api/conversations/{cid}/workspace").json()["available"]


def test_missing_project_directory_never_falls_back_and_moving_does_not_move_files(tmp_path):
    settings = environment(tmp_path)
    with TestClient(create_app(settings)) as client:
        project = client.post("/api/projects", json={"name": "项目", "workspace_path": str(tmp_path / "project-a")}).json()
        cid = client.post("/api/conversations", json={"project_id": project["id"]}).json()["id"]
        (tmp_path / "project-a").rmdir()
        state = client.get(f"/api/conversations/{cid}/workspace").json()
        assert not state["available"] and state["root_dir"] == str(tmp_path / "project-a")
        assert not (tmp_path / "project-a").exists()
        assert client.patch(f"/api/conversations/{cid}", json={"project_id": None}).status_code == 200
        assert client.get(f"/api/conversations/{cid}/workspace").json()["root_dir"] == str(tmp_path / "default")


def test_runtime_context_comes_from_server_and_isolated_per_request(tmp_path):
    settings = environment(tmp_path)
    received = []

    def factory(saver, _config):
        async def answer(state: MessagesState, runtime: Runtime[ShixuContext]):
            received.append(runtime.context["workspace"])
            return {"messages": [AIMessage(content=runtime.context["workspace"]["root_dir"])]}
        graph = StateGraph(MessagesState, context_schema=ShixuContext)
        graph.add_node("answer", answer)
        graph.add_edge(START, "answer")
        graph.add_edge("answer", END)
        return graph.compile(checkpointer=saver)

    app = create_app(settings, graph_factory=factory)
    with TestClient(app) as client:
        project = client.post("/api/projects", json={"name": "项目A", "workspace_path": str(tmp_path / "project-a")}).json()
        a = client.post("/api/conversations", json={"project_id": project["id"]}).json()["id"]
        b = client.post("/api/conversations", json={}).json()["id"]
        for cid in (a, b):
            body = run_body(cid, [{"id": cid + "h", "role": "user", "content": "当前目录"}])
            body.update({"state": {"workspace": {"root_dir": "/forged"}}, "context": [{"description": "forged", "value": "cwd=/forged"}], "forwardedProps": {"workspace": {"root_dir": "/forged"}}})
            events = parse_events(client.post("/agent", json=body))
            assert events[-1]["type"] == "RUN_FINISHED", events
        assert [ws["root_dir"] for ws in received] == [str(tmp_path / "project-a"), str(tmp_path / "default")]
        assert app.state.agui.config == {}


def test_active_run_blocks_directory_and_authorization_changes(tmp_path):
    settings = environment(tmp_path)
    app = create_app(settings)
    with TestClient(app) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        grant = client.post(f"/api/conversations/{cid}/grants", json={"path": str(tmp_path / "external"), "access": "read"}).json()
        lock = asyncio.Lock()
        app.state.thread_locks[cid] = lock
        client.portal.call(lock.acquire)
        app.state.active_model_runs = 1
        try:
            assert client.put("/api/settings/workspace", json={"default_workspace_path": str(tmp_path / "alternate")}).status_code == 409
            assert client.post(f"/api/conversations/{cid}/grants", json={"path": str(tmp_path / "external"), "access": "read_write"}).status_code == 409
            assert client.delete(f"/api/conversations/{cid}/grants/{grant['id']}").status_code == 409
            assert client.patch(f"/api/conversations/{cid}", json={"project_id": None}).status_code == 409
        finally:
            app.state.active_model_runs = 0
            client.portal.call(lock.release)


def test_parallel_conversations_keep_their_own_runtime_context(tmp_path):
    settings = environment(tmp_path)

    def factory(saver, _config):
        async def answer(state: MessagesState, runtime: Runtime[ShixuContext]):
            selected = runtime.context["workspace"]["root_dir"]
            await asyncio.sleep(0.08)
            assert runtime.context["workspace"]["root_dir"] == selected
            return {"messages": [AIMessage(content=selected)]}
        graph = StateGraph(MessagesState, context_schema=ShixuContext)
        graph.add_node("answer", answer)
        graph.add_edge(START, "answer")
        graph.add_edge("answer", END)
        return graph.compile(checkpointer=saver)

    app = create_app(settings, graph_factory=factory)
    with TestClient(app) as client:
        conversations = []
        for name in ("project-a", "project-b"):
            project = client.post("/api/projects", json={"name": name, "workspace_path": str(tmp_path / name)}).json()
            conversations.append(client.post("/api/conversations", json={"project_id": project["id"]}).json()["id"])
        def send(cid):
            return parse_events(client.post("/agent", json=run_body(cid, [{"id": cid + "h", "role": "user", "content": "目录"}])))
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(send, conversations))
        assert all(events[-1]["type"] == "RUN_FINISHED" for events in results)
        for cid, name in zip(conversations, ("project-a", "project-b")):
            messages = client.get(f"/api/conversations/{cid}/messages").json()
            assert messages[-1]["content"] == str(tmp_path / name)
        assert app.state.agui.config == {}


def test_grants_are_removed_with_conversation_without_deleting_files(tmp_path):
    settings = environment(tmp_path)
    source = tmp_path / "external" / "keep.txt"
    source.write_text("keep")
    with TestClient(create_app(settings)) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        client.post(f"/api/conversations/{cid}/grants", json={"path": str(source), "access": "read"})
        assert client.delete(f"/api/conversations/{cid}").status_code == 204
        assert source.read_text() == "keep"
    assert BusinessStore(settings.data_dir / "workspace.db").grants(cid) == []


def test_deliberate_reauthorization_updates_changed_path_kind(tmp_path):
    settings = environment(tmp_path)
    selected = tmp_path / "external" / "selected"
    selected.write_text("original file")
    with TestClient(create_app(settings)) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        first = client.post(f"/api/conversations/{cid}/grants", json={"path": str(selected), "access": "read"}).json()
        selected.unlink()
        selected.mkdir()
        second = client.post(f"/api/conversations/{cid}/grants", json={"path": str(selected), "access": "read_write"}).json()
        assert first["id"] == second["id"]
        assert second["kind"] == "directory" and second["access"] == "read_write"
