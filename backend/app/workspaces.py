"""Trusted, server-resolved filesystem context for one agent invocation."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal, NotRequired, TypedDict


class WorkspaceGrant(TypedDict):
    id: str
    path: str
    kind: Literal["file", "directory"]
    access: Literal["read", "read_write"]
    mount_path: str


class WorkspaceSnapshot(TypedDict):
    kind: Literal["default", "project"]
    root_dir: str
    project_id: str | None
    project_name: str | None
    grants: list[WorkspaceGrant]
    protected_paths: NotRequired[list[str]]


class ShixuContext(TypedDict):
    workspace: WorkspaceSnapshot


def canonical_path(value: str, *, directory: bool = False, writable: bool = False) -> Path:
    """Validate a deliberate user selection without creating arbitrary host paths."""
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise ValueError("请选择或填写有效的绝对路径。")
    path = Path(value.strip()).expanduser()
    if not path.is_absolute():
        raise ValueError("工作目录或授权路径必须是绝对路径。")
    try:
        path = path.resolve(strict=True)
        if directory and not path.is_dir():
            raise ValueError("请选择一个已存在的文件夹。")
        if not path.is_dir() and not path.is_file():
            raise ValueError("只能选择普通文件或文件夹。")
        required = os.R_OK | (os.X_OK if path.is_dir() else 0) | (os.W_OK if writable else 0)
        if not os.access(path, required):
            raise ValueError("该路径无法访问，请检查本机文件权限。")
    except (OSError, RuntimeError):
        raise ValueError("该路径不存在或无法访问，请重新选择。") from None
    return path


def browse_paths(value: str | None, *, initial: Path, include_files: bool = False) -> dict:
    path = canonical_path(value or str(initial), directory=True)
    try:
        entries = []
        for child in path.iterdir():
            if child.name.startswith("."):
                continue
            # A picker navigates explicit directories; it does not grant access.
            if child.is_dir():
                kind = "directory"
            elif include_files and child.is_file():
                kind = "file"
            else:
                continue
            entries.append({"name": child.name, "path": str(child), "kind": kind})
        entries.sort(key=lambda item: (item["kind"] != "directory", item["name"].casefold()))
        return {"path": str(path), "parent": str(path.parent) if path.parent != path else None, "entries": entries}
    except OSError:
        raise ValueError("无法读取这个文件夹，请检查本机文件权限。") from None
