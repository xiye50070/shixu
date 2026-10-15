"""Protocol/persistence tests use a deterministic graph, never a real provider."""

import asyncio
import json
import sqlite3
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langgraph.graph import END, START, MessagesState, StateGraph

from app.main import Settings, create_app, public_model_error


def parse_events(response):
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def run_body(thread_id, messages):
    return {"threadId": thread_id, "runId": str(uuid4()), "messages": messages, "state": {}, "tools": [], "context": [], "forwardedProps": {}}


def test_management_without_model_key(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        assert client.get("/api/health").json() == {"status": "ok", "provider": "deepseek", "model": "deepseek-flash", "model_configured": False}
        assert client.post("/api/projects", json={"name": "  "}).status_code == 422
        project = client.post("/api/projects", json={"name": "  研发项目  ", "workspace_path": str(tmp_path.parent)}).json()
        assert project["name"] == "研发项目"
        assert client.post("/api/conversations", json={"project_id": "not-a-project"}).status_code == 404
        conversation = client.post("/api/conversations", json={"project_id": project["id"]}).json()
        cid = conversation["id"]
        assert conversation["title"] == "新任务"
        changed = client.patch(f"/api/conversations/{cid}", json={"title": "业务设计", "pinned": True}).json()
        assert changed["pinned"] is True
        assert changed["title"] == "业务设计"
        assert client.get(f"/api/conversations/{cid}").json() == changed
        assert client.get("/api/search", params={"q": "业务"}).json()[0]["id"] == cid
        assert client.patch(f"/api/conversations/{cid}", json={"title": None}).status_code == 422
        assert client.patch(f"/api/conversations/{cid}", json={"pinned": None}).status_code == 422
        assert client.patch(f"/api/conversations/{cid}", json={"project_id": None}).json()["project_id"] is None
        assert client.delete(f"/api/conversations/{cid}").status_code == 204
        assert client.get(f"/api/conversations/{cid}").status_code == 404


def test_empty_hydration_never_calls_model_and_missing_key_reports_chinese(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        events = parse_events(client.post("/agent", json=run_body(cid, [])))
        assert [event["type"] for event in events] == ["RUN_STARTED", "MESSAGES_SNAPSHOT", "RUN_FINISHED"]
        assert events[1]["messages"] == []
        events = parse_events(client.post("/agent", json=run_body(cid, [{"id": "h1", "role": "user", "content": "你好"}])))
        assert [event["type"] for event in events] == ["RUN_STARTED", "RUN_ERROR"]
        assert events[-1]["code"] == "MODEL_KEY_MISSING"
        assert "模型配置" in events[-1]["message"]
        assert client.post("/agent", json=run_body("missing", [])).status_code == 404
        assert client.get(f"/api/conversations/{cid}/messages").json() == []


def test_active_run_rejects_concurrent_run_and_delete(tmp_path):
    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        lock = asyncio.Lock()
        app.state.thread_locks[cid] = lock
        client.portal.call(lock.acquire)
        try:
            events = parse_events(client.post("/agent", json=run_body(cid, [])))
            assert events[-1]["code"] == "THREAD_BUSY"
            assert client.delete(f"/api/conversations/{cid}").status_code == 409
            assert client.get(f"/api/conversations/{cid}").status_code == 200
        finally:
            client.portal.call(lock.release)
        assert client.delete(f"/api/conversations/{cid}").status_code == 204


def deterministic_graph_factory(counter):
    def factory(saver, _settings):
        async def answer(state: MessagesState):
            counter["calls"] += 1
            humans = [message.content for message in state["messages"] if message.type == "human"]
            return {"messages": [AIMessage(content="测试图回复：" + " / ".join(humans))]}

        graph = StateGraph(MessagesState)
        graph.add_node("answer", answer)
        graph.add_edge(START, "answer")
        graph.add_edge("answer", END)
        return graph.compile(checkpointer=saver)
    return factory


def test_durable_checkpoint_multiturn_isolation_search_and_scoped_delete(tmp_path):
    counter = {"calls": 0}
    factory = deterministic_graph_factory(counter)
    settings = Settings(data_dir=tmp_path)
    with TestClient(create_app(settings, graph_factory=factory)) as client:
        a = client.post("/api/conversations", json={}).json()["id"]
        b = client.post("/api/conversations", json={}).json()["id"]
        h1 = {"id": "a-h1", "role": "user", "content": "我的项目叫星河"}
        body = run_body(a, [h1])
        events = parse_events(client.post("/agent", json=body))
        assert events[-1]["type"] == "RUN_FINISHED"
        assert events[-1]["runId"] == body["runId"]
        initial = client.get(f"/api/conversations/{a}/messages").json()
        assert len(initial) == 2
        second = run_body(a, initial + [{"id": "a-h2", "role": "user", "content": "我刚才说的名字是什么？"}])
        events = parse_events(client.post("/agent", json=second))
        assert events[-1]["type"] == "RUN_FINISHED"
        messages_a = client.get(f"/api/conversations/{a}/messages").json()
        assert len(messages_a) == 4
        assert "我的项目叫星河 / 我刚才说的名字是什么？" in messages_a[-1]["content"]
        parse_events(client.post("/agent", json=run_body(b, [{"id": "b-h1", "role": "user", "content": "另一个会话"}])))
        messages_b = client.get(f"/api/conversations/{b}/messages").json()
        assert len(messages_b) == 2
        assert "星河" not in messages_b[-1]["content"]
        assert {hit["id"] for hit in client.get("/api/search", params={"q": "星河"}).json()} == {a}
        assert counter["calls"] == 3
        # Replaying an identical history is hydration, not a duplicate model call.
        parse_events(client.post("/agent", json=run_body(a, messages_a)))
        assert counter["calls"] == 3

    with TestClient(create_app(settings, graph_factory=factory)) as reopened:
        assert reopened.get(f"/api/conversations/{a}/messages").json() == messages_a
        parse_events(reopened.post("/agent", json=run_body(a, [{"id": "a-h3", "role": "user", "content": "继续"}])))
        persisted = reopened.get(f"/api/conversations/{a}/messages").json()
        assert len(persisted) == 6
        assert "我的项目叫星河" in persisted[-1]["content"]
        assert reopened.delete(f"/api/conversations/{a}").status_code == 204
        assert reopened.get(f"/api/conversations/{b}/messages").json() == messages_b
        assert reopened.get("/api/search", params={"q": "星河"}).json() == []
        assert reopened.get(f"/api/conversations/{a}/messages").status_code == 404
        with sqlite3.connect(tmp_path / "checkpoints.db") as db:
            assert db.execute("SELECT COUNT(*) FROM checkpoints WHERE thread_id = ?", (a,)).fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM writes WHERE thread_id = ?", (a,)).fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM checkpoints WHERE thread_id = ?", (b,)).fetchone()[0] > 0


@pytest.mark.parametrize("message,expected", [
    ("401 secret-provider-message", "MODEL_AUTH_ERROR"),
    ("429 rate limit", "MODEL_QUOTA_ERROR"),
    ("connection timeout", "MODEL_CONNECTION_ERROR"),
    ("400 invalid model", "MODEL_REQUEST_ERROR"),
    ("unknown secret-provider-message", "MODEL_RUN_ERROR"),
])
def test_provider_errors_are_sanitized(message, expected):
    code, public = public_model_error(message)
    assert code == expected
    assert "secret-provider-message" not in public
