"""Upgrade a real legacy SQLite checkpoint without calling a model provider."""

from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from app.deep_agent import build_deep_graph


class HistoryEchoModel(BaseChatModel):
    """Expose the human context actually supplied to the model by the graph."""

    @property
    def _llm_type(self):
        return "checkpoint-history-echo"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        humans = [message.content for message in messages if isinstance(message, HumanMessage)]
        return ChatResult(generations=[
            ChatGeneration(message=AIMessage(content=" / ".join(humans)))
        ])


def message_snapshot(messages):
    return [(message.id, message.type, message.content) for message in messages]


async def test_legacy_create_agent_checkpoint_survives_deep_agent_upgrade_and_restart(tmp_path):
    path = str(tmp_path / "checkpoints.db")
    thread = {"configurable": {"thread_id": "legacy-conversation"}}
    other_thread = {"configurable": {"thread_id": "another-conversation"}}

    # Match the previous application's create_agent + AsyncSqliteSaver graph.
    async with AsyncSqliteSaver.from_conn_string(path) as saver:
        await saver.setup()
        legacy = create_agent(HistoryEchoModel(), checkpointer=saver, name="assistant")
        old = await legacy.ainvoke({
            "messages": [HumanMessage(content="我的项目叫星河", id="legacy-human")]
        }, thread)
        other = await legacy.ainvoke({
            "messages": [HumanMessage(content="另一个会话的内容", id="other-human")]
        }, other_thread)
        original_messages = message_snapshot(old["messages"])
        other_messages = message_snapshot(other["messages"])

    # DeepAgentState uses DeltaChannel. It accepts the old message-list blob,
    # so this version needs neither a new database nor destructive migration.
    async with AsyncSqliteSaver.from_conn_string(path) as saver:
        upgraded = build_deep_graph(
            model=HistoryEchoModel(), checkpointer=saver, workspace_dir=tmp_path / "agent-files"
        )
        restored = await upgraded.aget_state(thread)
        assert message_snapshot(restored.values["messages"]) == original_messages

        continued = await upgraded.ainvoke({
            "messages": [HumanMessage(content="刚才说的名字是什么？", id="second-human")]
        }, thread)
        assert len(continued["messages"]) == 4
        assert message_snapshot(continued["messages"][:2]) == original_messages
        assert continued["messages"][-1].content == "我的项目叫星河 / 刚才说的名字是什么？"
        assert "另一个会话" not in continued["messages"][-1].content
        continued_messages = message_snapshot(continued["messages"])

    # Closing the connection and rebuilding the graph simulates server restart.
    async with AsyncSqliteSaver.from_conn_string(path) as saver:
        reopened = build_deep_graph(
            model=HistoryEchoModel(), checkpointer=saver, workspace_dir=tmp_path / "agent-files"
        )
        restored = await reopened.aget_state(thread)
        assert message_snapshot(restored.values["messages"]) == continued_messages
        result = await reopened.ainvoke({
            "messages": [HumanMessage(content="继续", id="third-human")]
        }, thread)
        assert len(result["messages"]) == 6
        assert result["messages"][-1].content == "我的项目叫星河 / 刚才说的名字是什么？ / 继续"
        untouched = await reopened.aget_state(other_thread)
        assert message_snapshot(untouched.values["messages"]) == other_messages
