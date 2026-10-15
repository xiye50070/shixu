"""Settings and runtime tests use deterministic graphs and mocked model clients."""

import sqlite3
import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Event

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langgraph.graph import END, START, MessagesState, StateGraph

from app.main import Settings, create_app
from app.model_settings import ModelConfiguration, build_chat_model, normalize_base_url
from test_api import deterministic_graph_factory, parse_events, run_body


def model_body(**changes):
    return {
        "provider": "deepseek", "model": "deepseek-flash",
        "base_url": "https://api.deepseek.com", "max_output_tokens": 1024,
        **changes,
    }


def test_environment_bootstrap_saved_settings_restart_and_key_readback(tmp_path):
    settings = Settings(data_dir=tmp_path, deepseek_api_key="environment-secret")
    counter = {"calls": 0}
    graph_factory = deterministic_graph_factory(counter)
    app = create_app(settings, graph_factory=graph_factory)
    with TestClient(app) as client:
        initial = client.get("/api/settings/model")
        assert initial.json() == {**model_body(), "api_key_configured": True, "source": "environment"}
        assert "environment-secret" not in initial.text
        saved = client.put("/api/settings/model", json=model_body(model="deepseek-chat", api_key="saved-secret"))
        assert saved.status_code == 200
        assert saved.json()["source"] == "saved"
        assert "saved-secret" not in saved.text
        assert app.state.model_config.api_key == "saved-secret"
        assert client.get("/api/health").json()["model"] == "deepseek-chat"
    with TestClient(create_app(replace(settings, deepseek_api_key="changed-env"), graph_factory=graph_factory)) as client:
        result = client.get("/api/settings/model")
        assert result.json()["model"] == "deepseek-chat"
        assert result.json()["source"] == "saved"
        assert "saved-secret" not in result.text
        assert client.put("/api/settings/model", json=model_body(model="deepseek-chat", api_key="")).status_code == 200
    with sqlite3.connect(tmp_path / "workspace.db") as db:
        assert db.execute("SELECT COUNT(*) FROM model_settings").fetchone()[0] == 1
    assert (tmp_path / "workspace.db").stat().st_mode & 0o777 == 0o600


def test_model_switch_retains_checkpoints_and_changes_runtime(tmp_path):
    configs = []
    counter = {"calls": 0}
    delegate = deterministic_graph_factory(counter)

    def factory(saver, config):
        configs.append(config)
        return delegate(saver, config)

    app = create_app(Settings(data_dir=tmp_path), graph_factory=factory)
    with TestClient(app) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        parse_events(client.post("/agent", json=run_body(cid, [{"id": "h1", "role": "user", "content": "我叫小序"}])))
        before = client.get(f"/api/conversations/{cid}/messages").json()
        result = client.put("/api/settings/model", json=model_body(
            provider="openai", model="compatible-model", base_url="http://localhost:9000/v1", api_key="new-secret",
        ))
        assert result.status_code == 200
        assert configs[-1].provider == "openai"
        assert configs[-1].api_key == "new-secret"
        assert client.get("/api/health").json() == {
            "status": "ok", "provider": "openai", "model": "compatible-model", "model_configured": True,
        }
        assert client.get(f"/api/conversations/{cid}/messages").json() == before
        events = parse_events(client.post("/agent", json=run_body(cid, [{"id": "h2", "role": "user", "content": "继续"}])))
        assert events[-1]["type"] == "RUN_FINISHED"
        after = client.get(f"/api/conversations/{cid}/messages").json()
        assert "我叫小序 / 继续" in after[-1]["content"]
    with TestClient(create_app(Settings(data_dir=tmp_path), graph_factory=factory)) as reopened:
        assert reopened.get("/api/settings/model").json()["provider"] == "openai"
        assert reopened.get(f"/api/conversations/{cid}/messages").json() == after
        events = parse_events(reopened.post("/agent", json=run_body(cid, [{"id": "h3", "role": "user", "content": "重启后继续"}])))
        assert events[-1]["type"] == "RUN_FINISHED"
        assert "我叫小序 / 继续 / 重启后继续" in reopened.get(f"/api/conversations/{cid}/messages").json()[-1]["content"]


@pytest.mark.parametrize("changes", [
    {"provider": "openai"},
    {"base_url": "https://another.example/v1"},
    {"base_url": "https://api.deepseek.com/v1"},
])
def test_different_provider_or_endpoint_cannot_reuse_existing_key(tmp_path, changes):
    app = create_app(Settings(data_dir=tmp_path, deepseek_api_key="old-secret"), graph_factory=deterministic_graph_factory({"calls": 0}))
    with TestClient(app) as client:
        response = client.put("/api/settings/model", json=model_body(**changes))
        assert response.status_code == 422
        assert "重新填写" in response.json()["detail"]
        assert app.state.model_config.api_key == "old-secret"
        assert app.state.store.model_settings() is None


def test_normalized_same_endpoint_keeps_key(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, deepseek_api_key="old-secret"), graph_factory=deterministic_graph_factory({"calls": 0}))
    with TestClient(app) as client:
        response = client.put("/api/settings/model", json=model_body(base_url="HTTPS://API.DEEPSEEK.COM:443/", api_key="  "))
        assert response.status_code == 200
        assert response.json()["base_url"] == "https://api.deepseek.com"
        assert app.state.model_config.api_key == "old-secret"


@pytest.mark.parametrize("changes", [
    {"base_url": "ftp://host/path"},
    {"base_url": "https://key-secret@host/v1"},
    {"base_url": "https://host/v1?key=key-secret"},
    {"base_url": "https://host/v1#key-secret"},
    {"base_url": "https://host:bad/v1"},
    {"base_url": "https://host /v1"},
    {"base_url": "https://host\\@other-host"},
    {"provider": "unsupported-provider-key-secret"},
    {"model": ""},
    {"model": "bad model"},
    {"max_output_tokens": 0},
    {"max_output_tokens": 16385},
    {"max_output_tokens": True},
    {"max_output_tokens": "1024"},
    {"api_key": {"nested": "key-secret"}},
    {"extra-key-secret": "key-secret"},
])
def test_invalid_settings_never_echo_secrets(tmp_path, changes):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        for path in ("/api/settings/model", "/api/settings/model/test"):
            response = client.request("PUT" if path.endswith("model") else "POST", path, json=model_body(**{"api_key": "key-secret", **changes}))
            assert response.status_code == 422
            assert "key-secret" not in response.text
            assert "input" not in response.text
        malformed = client.put("/api/settings/model", content='{"api_key":"key-secret",')
        assert malformed.status_code == 422
        assert "key-secret" not in malformed.text


def test_missing_key_save_and_test_do_not_create_settings(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        assert client.put("/api/settings/model", json=model_body()).status_code == 422
        assert client.post("/api/settings/model/test", json=model_body()).status_code == 422
        assert client.get("/api/settings/model").json()["api_key_configured"] is False


def test_busy_save_and_failed_runtime_build_leave_current_settings_unchanged(tmp_path, monkeypatch):
    app = create_app(Settings(data_dir=tmp_path), graph_factory=deterministic_graph_factory({"calls": 0}))
    with TestClient(app) as client:
        app.state.active_model_runs = 1
        assert client.put("/api/settings/model", json=model_body(api_key="secret")).status_code == 409
        app.state.active_model_runs = 0

        def broken_factory(*_):
            raise ValueError("provider-body secret-value")

        monkeypatch.setattr("app.main.LangGraphAgent", broken_factory)
        response = client.put("/api/settings/model", json=model_body(api_key="secret-value"))
        assert response.status_code == 500
        assert "secret-value" not in response.text
        assert app.state.store.model_settings() is None
        assert app.state.model_config.source == "environment"


def test_real_active_stream_blocks_save_until_its_run_finishes(tmp_path):
    entered = Event()
    release = None

    def factory(saver, _config):
        nonlocal release
        release = asyncio.Event()

        async def answer(_state: MessagesState):
            entered.set()
            await release.wait()
            return {"messages": [AIMessage(content="完成") ]}

        graph = StateGraph(MessagesState)
        graph.add_node("answer", answer)
        graph.add_edge(START, "answer")
        graph.add_edge("answer", END)
        return graph.compile(checkpointer=saver)

    app = create_app(Settings(data_dir=tmp_path), graph_factory=factory)
    with TestClient(app) as client, ThreadPoolExecutor(max_workers=1) as pool:
        cid = client.post("/api/conversations", json={}).json()["id"]
        pending = pool.submit(client.post, "/agent", json=run_body(cid, [{"id": "h1", "role": "user", "content": "运行"}]))
        assert entered.wait(5)
        try:
            result = client.put("/api/settings/model", json=model_body(api_key="new-secret"))
            assert result.status_code == 409
            assert app.state.store.model_settings() is None
        finally:
            client.portal.call(release.set)
        assert parse_events(pending.result(timeout=5))[-1]["type"] == "RUN_FINISHED"
        assert client.put("/api/settings/model", json=model_body(api_key="new-secret")).status_code == 200


@pytest.mark.parametrize("failure,expected", [
    (None, 200),
    (ValueError("401 invalid api key key-secret https://secret.example"), 502),
    (TimeoutError("key-secret timeout"), 504),
])
def test_connection_test_does_not_save_and_sanitizes_provider_errors(tmp_path, monkeypatch, failure, expected):
    received = []

    class TestModel:
        async def ainvoke(self, prompt):
            assert "OK" in prompt
            if failure:
                raise failure
            return object()

    def factory(config, *, for_test):
        received.append((config, for_test))
        return TestModel()

    monkeypatch.setattr("app.main.build_chat_model", factory)
    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app) as client:
        response = client.post("/api/settings/model/test", json=model_body(api_key="key-secret"))
        assert response.status_code == expected
        assert "key-secret" not in response.text
        assert "secret.example" not in response.text
        assert received[0][1] is True
        assert app.state.store.model_settings() is None
        assert app.state.model_config.api_key == ""
        assert client.get("/api/health").json()["model_configured"] is False


def test_factory_provider_options_are_isolated_and_test_is_short(monkeypatch):
    calls = []
    monkeypatch.setattr("app.model_settings.ChatDeepSeek", lambda **options: calls.append(("deepseek", options)))
    monkeypatch.setattr("app.model_settings.ChatOpenAI", lambda **options: calls.append(("openai", options)))
    config = ModelConfiguration(api_key="secret", max_output_tokens=2048)
    build_chat_model(config)
    deepseek = calls[-1][1]
    assert deepseek["extra_body"] == {"thinking": {"type": "disabled"}}
    assert deepseek["stream_usage"] is True
    build_chat_model(replace(config, provider="openai"))
    openai = calls[-1][1]
    assert "extra_body" not in openai
    assert openai["stream_usage"] is False
    assert openai["use_responses_api"] is False
    assert openai["max_tokens"] == 2048
    build_chat_model(replace(config, provider="openai"), for_test=True)
    probe = calls[-1][1]
    assert probe["max_tokens"] == 16
    assert probe["max_retries"] == 0
    assert probe["timeout"] == 20
    assert probe["streaming"] is False


def test_url_normalization_keeps_case_sensitive_endpoint_paths():
    assert normalize_base_url("http://LOCALHOST:80/V1/") == "http://localhost/V1"
    assert normalize_base_url("http://[::1]:1234/v1") == "http://[::1]:1234/v1"
