"""Small, durable business store. Agent checkpoints use their own database."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from uuid import uuid4


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def text_content(content: Any) -> str:
    """Index visible text, excluding reasoning and non-text content blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") in {"text", "text_delta"}
        )
    return ""


class BusinessStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                    title TEXT NOT NULL,
                    pinned INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS conversations_project
                    ON conversations(project_id, updated_at);
                CREATE TABLE IF NOT EXISTS messages (
                    conversation_id TEXT NOT NULL
                        REFERENCES conversations(id) ON DELETE CASCADE,
                    id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (conversation_id, id)
                );
                CREATE INDEX IF NOT EXISTS messages_conversation
                    ON messages(conversation_id, position);
                """
            )

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA journal_mode = WAL")
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _conversation(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        result = dict(row)
        result["pinned"] = bool(result["pinned"])
        return result

    def list_projects(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM projects ORDER BY created_at")]

    def project_exists(self, project_id: str) -> bool:
        with self.connect() as db:
            return db.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone() is not None

    def create_project(self, name: str) -> dict[str, Any]:
        project = {"id": str(uuid4()), "name": name, "created_at": utc_now()}
        with self.connect() as db:
            db.execute(
                "INSERT INTO projects(id, name, created_at) VALUES (:id, :name, :created_at)",
                project,
            )
        return project

    def list_conversations(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            return [
                self._conversation(row)
                for row in db.execute("SELECT * FROM conversations ORDER BY pinned DESC, updated_at DESC")
            ]

    def conversation(self, conversation_id: str) -> dict[str, Any] | None:
        with self.connect() as db:
            return self._conversation(
                db.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            )

    def create_conversation(self, project_id: str | None, title: str) -> dict[str, Any]:
        now = utc_now()
        conversation = {
            "id": str(uuid4()), "project_id": project_id, "title": title,
            "pinned": False, "created_at": now, "updated_at": now,
        }
        with self.connect() as db:
            db.execute(
                """INSERT INTO conversations(id, project_id, title, pinned, created_at, updated_at)
                    VALUES (:id, :project_id, :title, :pinned, :created_at, :updated_at)""",
                conversation,
            )
        return conversation

    def update_conversation(self, conversation_id: str, fields: dict[str, Any]) -> dict[str, Any] | None:
        # Column names come from this fixed whitelist; values are always bound parameters.
        allowed = {key: value for key, value in fields.items() if key in {"title", "pinned", "project_id"}}
        if not allowed:
            return self.conversation(conversation_id)
        allowed["updated_at"] = utc_now()
        with self.connect() as db:
            columns = ", ".join(f"{key} = ?" for key in allowed)
            db.execute(f"UPDATE conversations SET {columns} WHERE id = ?", (*allowed.values(), conversation_id))
        return self.conversation(conversation_id)

    def delete_conversation(self, conversation_id: str) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))

    def messages(self, conversation_id: str) -> list[dict[str, Any]]:
        with self.connect() as db:
            return [
                json.loads(row["payload"])
                for row in db.execute(
                    "SELECT payload FROM messages WHERE conversation_id = ? ORDER BY position",
                    (conversation_id,),
                )
            ]

    def sync_messages(self, conversation_id: str, messages: Iterable[Any]) -> None:
        """Replace the projection of the latest checkpoint, never append replayed history."""
        projections = []
        role_map = {"human": "user", "ai": "assistant", "tool": "tool", "system": "system"}
        for position, message in enumerate(messages):
            role = role_map.get(message.type, message.type)
            payload: dict[str, Any] = {
                "id": message.id or f"{conversation_id}:{position}",
                "role": role,
                "content": text_content(message.content),
            }
            if role == "assistant" and getattr(message, "tool_calls", None):
                payload["toolCalls"] = [
                    {
                        "id": call["id"], "type": "function",
                        "function": {"name": call["name"], "arguments": json.dumps(call["args"], ensure_ascii=False)},
                    }
                    for call in message.tool_calls
                ]
            if role == "tool":
                payload["toolCallId"] = message.tool_call_id
            if getattr(message, "name", None):
                payload["name"] = message.name
            projections.append((position, payload))

        with self.connect() as db:
            if db.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone() is None:
                return
            old_rows = db.execute(
                "SELECT id, payload, created_at FROM messages WHERE conversation_id = ? ORDER BY position",
                (conversation_id,),
            ).fetchall()
            if [json.loads(row["payload"]) for row in old_rows] == [payload for _, payload in projections]:
                return
            old_times = {
                row["id"]: row["created_at"]
                for row in old_rows
            }
            db.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))
            now = utc_now()
            db.executemany(
                """INSERT INTO messages(conversation_id, id, position, role, content, payload, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)""",
                [
                    (conversation_id, payload["id"], position, payload["role"], payload["content"],
                     json.dumps(payload, ensure_ascii=False), old_times.get(payload["id"], now))
                    for position, payload in projections
                ],
            )
            if projections:
                first_user = next((p["content"] for _, p in projections if p["role"] == "user" and p["content"].strip()), "")
                title = " ".join(first_user.split())[:48]
                db.execute(
                    """UPDATE conversations SET updated_at = ?,
                       title = CASE WHEN title = '新任务' AND ? != '' THEN ? ELSE title END
                       WHERE id = ?""",
                    (now, title, title, conversation_id),
                )

    def search(self, query: str) -> list[dict[str, Any]]:
        query = query.strip()
        if not query:
            return []
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        with self.connect() as db:
            rows = db.execute(
                """SELECT c.id, c.title, c.project_id, p.name AS project_name, c.updated_at,
                    (SELECT m.content FROM messages m WHERE m.conversation_id = c.id
                     AND m.role IN ('user', 'assistant') AND m.content LIKE ? ESCAPE '\\'
                     ORDER BY m.position DESC LIMIT 1) AS matched_content
                   FROM conversations c LEFT JOIN projects p ON p.id = c.project_id
                   WHERE c.title LIKE ? ESCAPE '\\' OR EXISTS
                     (SELECT 1 FROM messages m WHERE m.conversation_id = c.id
                      AND m.role IN ('user', 'assistant') AND m.content LIKE ? ESCAPE '\\')
                   ORDER BY c.updated_at DESC LIMIT 50""",
                (pattern, pattern, pattern),
            ).fetchall()
        results = []
        for row in rows:
            result = dict(row)
            content = result.pop("matched_content") or result["title"]
            match = content.lower().find(query.lower())
            start = max(0, match - 28)
            end = min(len(content), max(start + 120, match + len(query)))
            result["snippet"] = ("…" if start else "") + content[start:end] + ("…" if end < len(content) else "")
            results.append(result)
        return results
