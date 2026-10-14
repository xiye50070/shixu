from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.storage import BusinessStore


def test_restart_and_idempotent_projection(tmp_path):
    path = tmp_path / "business.db"
    store = BusinessStore(path)
    project = store.create_project("研发")
    conversation = store.create_conversation(project["id"], "新任务")
    messages = [HumanMessage(id="h1", content="SQLite 如何持久化？"), AIMessage(id="a1", content="写入磁盘。")]
    store.sync_messages(conversation["id"], messages)
    store.sync_messages(conversation["id"], messages)
    reopened = BusinessStore(path)
    assert reopened.conversation(conversation["id"])["title"] == "SQLite 如何持久化？"
    assert len(reopened.messages(conversation["id"])) == 2
    assert reopened.list_projects() == [project]


def test_chinese_body_search_isolation_and_literal_wildcards(tmp_path):
    store = BusinessStore(tmp_path / "business.db")
    a = store.create_conversation(None, "第一个会话")
    b = store.create_conversation(None, "第二个会话")
    store.sync_messages(a["id"], [HumanMessage(id="h1", content="部署 PostgreSQL，进度 100%")])
    store.sync_messages(b["id"], [HumanMessage(id="h1", content="今天的天气")])
    assert [hit["id"] for hit in store.search("部署")] == [a["id"]]
    assert [hit["id"] for hit in store.search("100%")] == [a["id"]]
    assert store.search("_") == []
    assert store.search(" ") == []
    store.delete_conversation(a["id"])
    assert store.messages(a["id"]) == []
    assert len(store.messages(b["id"])) == 1


def test_tool_projection_and_reasoning_not_indexed(tmp_path):
    store = BusinessStore(tmp_path / "business.db")
    c = store.create_conversation(None, "工具会话")
    store.sync_messages(c["id"], [
        AIMessage(id="a1", content="", tool_calls=[{"id": "t1", "name": "get_current_time", "args": {}}]),
        ToolMessage(id="t1result", tool_call_id="t1", content="2026-10-14 12:00"),
        AIMessage(id="a2", content=[{"type": "reasoning", "reasoning": "内部内容"}, {"type": "text", "text": "现在是中午。"}]),
    ])
    messages = store.messages(c["id"])
    assert messages[0]["toolCalls"][0]["function"]["name"] == "get_current_time"
    assert messages[1]["toolCallId"] == "t1"
    assert messages[2]["content"] == "现在是中午。"
    assert store.search("内部内容") == []
    assert len(store.search("中午")) == 1
