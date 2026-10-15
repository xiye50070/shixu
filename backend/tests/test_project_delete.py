"""Project removal only detaches grouping; disk, history and grants survive."""

import asyncio
import json
import sqlite3
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.runtime import Runtime

from app.main import Settings, create_app
from app.storage import BusinessStore
from app.workspaces import ShixuContext


def test_store_delete_empty_and_unknown_project(tmp_path):
    store = BusinessStore(tmp_path / "business.db")
    project = store.create_project("empty", str(tmp_path))
    assert store.delete_project(project["id"]) is True
    assert store.project(project["id"]) is None
    assert store.delete_project(project["id"]) is False
    assert store.list_conversations() == []


def test_store_delete_detaches_all_members_and_preserves_data(tmp_path):
    path = tmp_path / "business.db"
    store = BusinessStore(path)
    removed, retained = store.create_project("removed"), store.create_project("retained")
    members = [store.create_conversation(removed["id"], f"task {index}") for index in range(2)]
    other = store.create_conversation(retained["id"], "other")
    store.update_conversation(members[0]["id"], {"pinned": True})
    for member in members:
        store.sync_messages(member["id"], [HumanMessage(id="h1", content="保留历史"), AIMessage(id="a1", content="保留回复")])
        store.save_grant(member["id"], str(tmp_path / f"external-{member['id']}"), "directory", "read")
    conversations = {member["id"]: store.conversation(member["id"]) for member in members}
    messages = {member["id"]: store.messages(member["id"]) for member in members}
    grants = {member["id"]: store.grants(member["id"]) for member in members}
    assert set(store.project_conversation_ids(removed["id"])) == {member["id"] for member in members}
    assert store.delete_project(removed["id"]) is True
    reopened = BusinessStore(path)
    for member in members:
        cid = member["id"]
        assert reopened.conversation(cid) == {**conversations[cid], "project_id": None}
        assert reopened.messages(cid) == messages[cid]
        assert reopened.grants(cid) == grants[cid]
    assert reopened.conversation(other["id"]) == other
    assert reopened.project(retained["id"]) == retained


def test_store_delete_rolls_back_detachment_when_project_delete_fails(tmp_path):
    store = BusinessStore(tmp_path / "business.db")
    project = store.create_project("kept")
    member = store.create_conversation(project["id"], "kept task")
    with store.connect() as db:
        db.execute("CREATE TRIGGER refuse_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    with pytest.raises(sqlite3.IntegrityError, match="blocked"):
        store.delete_project(project["id"])
    assert store.project(project["id"]) == project
    assert store.conversation(member["id"]) == member


def create_context_graph(captured):
    def factory(saver, _config):
        async def answer(state: MessagesState, runtime: Runtime[ShixuContext]):
            captured.append(runtime.context["workspace"])
            return {"messages": [AIMessage(content="上下文已接收，保留历史。") ]}
        graph = StateGraph(MessagesState, context_schema=ShixuContext)
        graph.add_node("answer", answer)
        graph.add_edge(START, "answer")
        graph.add_edge("answer", END)
        return graph.compile(checkpointer=saver)
    return factory


def run_turn(client, cid, text):
    result = client.post("/agent", json={
        "threadId": cid, "runId": str(uuid4()),
        "messages": [{"id": str(uuid4()), "role": "user", "content": text}],
        "state": {}, "tools": [], "context": [], "forwardedProps": {},
    })
    assert result.status_code == 200
    events = [json.loads(line[6:]) for line in result.text.splitlines() if line.startswith("data: ")]
    assert events[-1]["type"] == "RUN_FINISHED", events


def checkpoint_rows(path):
    with sqlite3.connect(path) as db:
        return {
            table: db.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
            for table in ("checkpoints", "writes", "checkpoint_blobs")
            if db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
        }


def test_api_delete_preserves_checkpoints_grants_files_and_switches_to_default(tmp_path):
    project_path, default_path, external = tmp_path / "project", tmp_path / "default", tmp_path / "external"
    for path in (project_path, default_path, external):
        path.mkdir()
    existing = project_path / "keep.md"
    existing.write_text("项目文件保持原样", encoding="utf-8")
    captured = []
    settings = Settings(data_dir=tmp_path / "data", files_dir=tmp_path / "bootstrap-files")
    with TestClient(create_app(settings, graph_factory=create_context_graph(captured))) as client:
        assert client.put("/api/settings/workspace", json={"default_workspace_path": str(default_path)}).status_code == 200
        project = client.post("/api/projects", json={"name": "项目 A", "workspace_path": str(project_path)}).json()
        a, b = [client.post("/api/conversations", json={"project_id": project["id"]}).json()["id"] for _ in range(2)]
        client.patch(f"/api/conversations/{a}", json={"pinned": True})
        grant = client.post(f"/api/conversations/{a}/grants", json={"path": str(external), "access": "read"}).json()
        run_turn(client, a, "第一轮历史")
        run_turn(client, b, "另一会话历史")
        assert captured[-1]["root_dir"] == str(project_path)
        messages = {cid: client.get(f"/api/conversations/{cid}/messages").json() for cid in (a, b)}
        conversations = {cid: client.get(f"/api/conversations/{cid}").json() for cid in (a, b)}
        before = checkpoint_rows(settings.data_dir / "checkpoints.db")
        assert before["checkpoints"]
        result = client.delete(f"/api/projects/{project['id']}")
        assert result.status_code == 204 and result.content == b""
        assert client.get("/api/projects").json() == []
        assert checkpoint_rows(settings.data_dir / "checkpoints.db") == before
        for cid in (a, b):
            assert client.get(f"/api/conversations/{cid}").json() == {**conversations[cid], "project_id": None}
            assert client.get(f"/api/conversations/{cid}/messages").json() == messages[cid]
            workspace = client.get(f"/api/conversations/{cid}/workspace").json()
            assert workspace["kind"] == "default" and workspace["root_dir"] == str(default_path)
        assert client.get(f"/api/conversations/{a}/workspace").json()["grants"] == [grant]
        assert project_path.is_dir() and existing.read_text(encoding="utf-8") == "项目文件保持原样"
        run_turn(client, a, "删除项目后继续")
        assert captured[-1]["root_dir"] == str(default_path)
        assert captured[-1]["project_id"] is None and captured[-1]["grants"] == [grant]
        assert len(client.get(f"/api/conversations/{a}/messages").json()) == 4
        assert client.delete(f"/api/projects/{project['id']}").status_code == 404


def test_api_delete_unknown_and_busy_project_but_not_other_active_project(tmp_path):
    app = create_app(Settings(data_dir=tmp_path / "data", files_dir=tmp_path / "files"))
    with TestClient(app) as client:
        assert client.delete("/api/projects/missing").status_code == 404
        a, b = [client.post("/api/projects", json={"name": name, "workspace_path": str(tmp_path)}).json() for name in ("A", "B")]
        cid = client.post("/api/conversations", json={"project_id": a["id"]}).json()["id"]
        lock = asyncio.Lock()
        app.state.thread_locks[cid] = lock
        client.portal.call(lock.acquire)
        app.state.active_model_runs = 1
        try:
            result = client.delete(f"/api/projects/{a['id']}")
            assert result.status_code == 409 and "正在运行" in result.json()["detail"]
            assert client.get(f"/api/conversations/{cid}").json()["project_id"] == a["id"]
            assert client.delete(f"/api/projects/{b['id']}").status_code == 204
        finally:
            client.portal.call(lock.release)
            app.state.active_model_runs = 0
        assert client.delete(f"/api/projects/{a['id']}").status_code == 204
        assert client.get(f"/api/conversations/{cid}").json()["project_id"] is None
