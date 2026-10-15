"""Run-scoped file routing, grants and hard filesystem permissions."""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path, PurePosixPath
from typing import Any

from deepagents.backends import CompositeBackend, FilesystemBackend, StateBackend
from deepagents.backends.protocol import (
    BackendProtocol, DeleteResult, EditResult, FileDownloadResponse,
    FileUploadResponse, GlobResult, GrepResult, LsResult, ReadResult, WriteResult,
)
from deepagents.backends.utils import InvalidGlobPatternError, compile_grep_include_glob

DELETE_DISABLED = "Deletion is disabled in the Shixu file workspace."
ACCESS_DENIED = "路径未授权。请在当前会话的外部路径授权中添加该文件或目录及所需权限。"
READ_ONLY = "该外部路径仅有读取权限；请先授予可读写权限。"
PROTECTED = "该路径属于拾序内部数据或凭据，禁止文件工具访问。"
INTERNAL_PREFIXES = ("/large_tool_results/", "/conversation_history/", "/blobs/")


class DeniedBackend(BackendProtocol):
    """Unknown absolute paths must fail rather than become state-only files."""

    def ls(self, path):
        return LsResult(error=ACCESS_DENIED)

    def read(self, file_path, offset=0, limit=2000):
        return ReadResult(error=ACCESS_DENIED)

    def write(self, file_path, content):
        return WriteResult(error=ACCESS_DENIED)

    def edit(self, file_path, old_string, new_string, replace_all=False):
        return EditResult(error=ACCESS_DENIED)

    def grep(self, pattern, path=None, glob=None, *, max_count=None):
        return GrepResult(error=ACCESS_DENIED)

    def glob(self, pattern, path=None):
        return GlobResult(error=ACCESS_DENIED)

    def upload_files(self, files):
        return [FileUploadResponse(path=path, error="permission_denied") for path, _ in files]

    def download_files(self, paths):
        return [FileDownloadResponse(path=path, error="permission_denied") for path in paths]


class InternalStateBackend(StateBackend):
    """Keep original artifact keys, and never accept arbitrary user paths."""

    @staticmethod
    def _internal(path):
        return isinstance(path, str) and ".." not in PurePosixPath(path).parts and any(
            path == prefix.rstrip("/") or path.startswith(prefix) for prefix in INTERNAL_PREFIXES
        )

    def ls(self, path):
        return super().ls(path) if self._internal(path) else DeniedBackend().ls(path)

    def read(self, file_path, offset=0, limit=2000):
        return super().read(file_path, offset, limit) if self._internal(file_path) else DeniedBackend().read(file_path)

    def write(self, file_path, content):
        return super().write(file_path, content) if self._internal(file_path) else DeniedBackend().write(file_path, content)

    def edit(self, file_path, old_string, new_string, replace_all=False):
        return super().edit(file_path, old_string, new_string, replace_all) if self._internal(file_path) else DeniedBackend().edit(file_path, old_string, new_string)

    def grep(self, pattern, path=None, glob=None, *, max_count=None):
        return super().grep(pattern, path, glob, max_count=max_count) if self._internal(path) else DeniedBackend().grep(pattern, path, glob)

    def glob(self, pattern, path=None):
        return super().glob(pattern, path) if self._internal(path) else DeniedBackend().glob(pattern, path)

    def upload_files(self, files):
        return [
            super(InternalStateBackend, self).upload_files([(path, content)])[0]
            if self._internal(path) else FileUploadResponse(path=path, error="permission_denied")
            for path, content in files
        ]

    def download_files(self, paths):
        return [
            super(InternalStateBackend, self).download_files([path])[0]
            if self._internal(path) else FileDownloadResponse(path=path, error="permission_denied")
            for path in paths
        ]

    def delete(self, file_path):
        return DeleteResult(error=DELETE_DISABLED)

    async def adelete(self, file_path):
        return DeleteResult(error=DELETE_DISABLED)


class WorkspaceFilesystemBackend(FilesystemBackend):
    """Official disk backend with per-mount access and protected path checks."""

    def __init__(self, *, root_dir, virtual_mode=True, access="read_write", file_only=None, protected_paths=()):
        super().__init__(root_dir=root_dir, virtual_mode=virtual_mode)
        self.access = access
        self.file_only = Path(file_only).resolve() if file_only else None
        self.protected_paths = tuple(Path(path).resolve() for path in protected_paths)

    def _allowed(self, path: Path) -> bool:
        resolved = path.resolve()
        return (
            resolved.is_relative_to(self.cwd)
            and not any(resolved == item or resolved.is_relative_to(item) for item in self.protected_paths)
            and (self.file_only is None or resolved == self.file_only)
        )

    def _resolve_path(self, key: str) -> Path:
        try:
            resolved = super()._resolve_path(key)
        except ValueError:
            raise PermissionError("Path must stay inside its authorized workspace.") from None
        if any(resolved == item or resolved.is_relative_to(item) for item in self.protected_paths):
            raise PermissionError(PROTECTED)
        if self.file_only is not None and resolved != self.file_only:
            raise PermissionError(ACCESS_DENIED)
        return resolved

    def write(self, file_path, content):
        if self.access != "read_write":
            return WriteResult(error=READ_ONLY)
        return super().write(file_path, content)

    def edit(self, file_path, old_string, new_string, replace_all=False):
        if self.access != "read_write":
            return EditResult(error=READ_ONLY)
        return super().edit(file_path, old_string, new_string, replace_all=replace_all)

    def upload_files(self, files):
        if self.access != "read_write":
            return [FileUploadResponse(path=path, error="permission_denied") for path, _ in files]
        return super().upload_files(files)

    def delete(self, file_path: str) -> DeleteResult:
        return DeleteResult(error=DELETE_DISABLED)

    def ls(self, path):
        if self.file_only is not None and path in {"/", ".", ""}:
            if not self._allowed(self.file_only):
                return LsResult(error=PROTECTED)
            return LsResult(entries=[{"path": f"/{self.file_only.name}", "is_dir": False}])
        result = super().ls(path)
        if result.entries:
            result.entries = [entry for entry in result.entries if self._allowed(self.cwd / entry["path"].lstrip("/"))]
        return result

    def _search_base(self, path):
        if self.file_only is not None and path in {None, "/", ".", ""}:
            return self._resolve_path(f"/{self.file_only.name}")
        return self._resolve_path(path or "/")

    def _safe_files(self, base):
        """Prune protected trees before listing or opening their files."""
        if base.is_file():
            if self._allowed(base):
                yield base
            return
        for directory, directories, files in os.walk(base, followlinks=False):
            directory = Path(directory)
            directories[:] = [name for name in directories if self._allowed(directory / name)]
            for name in files:
                file = directory / name
                if self._allowed(file) and file.is_file():
                    yield file

    def glob(self, pattern, path=None):
        try:
            matcher = compile_grep_include_glob(pattern)
            base = self._search_base(path)
            root = base if base.is_dir() else base.parent
            results = []
            deadline = time.monotonic() + 15
            for file in self._safe_files(base):
                if time.monotonic() > deadline:
                    return GlobResult(matches=results, truncated=True, truncation_reason="budget")
                if matcher(file.relative_to(root).as_posix()):
                    results.append({"path": self._to_virtual_path(file), "is_dir": False})
            return GlobResult(matches=sorted(results, key=lambda item: item["path"]))
        except (OSError, RuntimeError, ValueError, InvalidGlobPatternError):
            return GlobResult(error="无法搜索该路径，请检查路径与授权。")

    def grep(self, pattern, path=None, glob=None, *, max_count=None):
        try:
            matcher = compile_grep_include_glob(glob) if glob else None
            base = self._search_base(path)
            root = base if base.is_dir() else base.parent
            results = []
            deadline = time.monotonic() + 15
            for file in self._safe_files(base):
                if matcher and not matcher(file.relative_to(root).as_posix()):
                    continue
                if file.stat().st_size > self.max_file_size_bytes:
                    continue
                try:
                    with file.open(encoding="utf-8", errors="strict") as handle:
                        for number, line in enumerate(handle, 1):
                            if time.monotonic() > deadline:
                                return GrepResult(matches=results, truncated=True)
                            if pattern in line:
                                results.append({"path": self._to_virtual_path(file), "line": number, "text": line.rstrip("\r\n")})
                                if max_count is not None and len(results) >= max_count:
                                    return GrepResult(matches=results, truncated=True)
                except UnicodeDecodeError:
                    continue
            return GrepResult(matches=results)
        except (OSError, RuntimeError, ValueError, InvalidGlobPatternError):
            return GrepResult(error="无法搜索该路径，请检查路径与授权。")


class AgentFilesystemBackend(CompositeBackend):
    """Immutable mount table for one run; only framework artifacts use state."""

    def __init__(self, workspace: dict[str, Any]):
        self.workspace = workspace
        self.root_dir = Path(workspace["root_dir"])
        if not self.root_dir.is_absolute() or self.root_dir.resolve() != self.root_dir or not self.root_dir.is_dir():
            raise ValueError("工作目录已变化或无法访问，请重新选择目录。")
        protected = workspace.get("protected_paths", ())
        routes = {"/workspace/": WorkspaceFilesystemBackend(root_dir=self.root_dir, protected_paths=protected)}
        self.host_mounts = [(self.root_dir, "/workspace/", "directory")]
        for grant in workspace["grants"]:
            target = Path(grant["path"])
            # A saved grant authorizes its original canonical target, not a new
            # symlink target or a directory replacing a previously selected file.
            expected_kind = target.is_dir() if grant["kind"] == "directory" else target.is_file()
            if not target.is_absolute() or target.resolve() != target or not expected_kind:
                raise ValueError("外部授权路径已变化或无法访问，请撤销后重新授权。")
            mount = grant["mount_path"].rstrip("/") + "/"
            if not mount.startswith("/external/") or ".." in PurePosixPath(mount).parts:
                raise ValueError("Invalid external mount path")
            routes[mount] = WorkspaceFilesystemBackend(
                root_dir=target if grant["kind"] == "directory" else target.parent,
                file_only=target if grant["kind"] == "file" else None,
                access=grant["access"], protected_paths=protected,
            )
            self.host_mounts.append((target, mount, grant["kind"]))
        super().__init__(default=InternalStateBackend(), routes=routes)

    def normalize_path(self, path: str | None) -> str:
        if not path or path in {".", "/"}:
            return "/workspace/"
        if ".." in PurePosixPath(path.replace("\\", "/")).parts or "\x00" in path:
            raise ValueError("Path traversal is not allowed")
        if not path.startswith("/") and not path.startswith("~"):
            return "/workspace/" + path.removeprefix("./")
        if any(path == prefix.rstrip("/") or path.startswith(prefix) for prefix in (*self.routes, *INTERNAL_PREFIXES)):
            return path
        # Host absolute paths are aliases only after canonical grant checking.
        target = Path(path).expanduser().resolve()
        for host, mount, kind in sorted(self.host_mounts, key=lambda item: len(str(item[0])), reverse=True):
            if kind == "file" and target == host:
                return mount + host.name
            if kind == "directory" and target.is_relative_to(host):
                relative = target.relative_to(host).as_posix()
                return mount if relative == "." else mount + relative
        return path  # DeniedBackend returns the actionable authorization error.

    def _get_backend_and_key(self, key):
        try:
            return super()._get_backend_and_key(self.normalize_path(key))
        except (OSError, RuntimeError, ValueError):
            return self.default, key

    def ls(self, path):
        try:
            return super().ls(self.normalize_path(path))
        except (OSError, RuntimeError, ValueError):
            return LsResult(error=ACCESS_DENIED)

    async def als(self, path):
        return await asyncio.to_thread(self.ls, path)

    def glob(self, pattern, path=None):
        try:
            normalized = self.normalize_path(path)
            # Absolute route patterns also work without an explicit search path.
            if path is None and pattern.startswith("/"):
                for prefix in self.routes:
                    if pattern.startswith(prefix):
                        normalized, pattern = prefix, pattern[len(prefix):]
                        break
            return super().glob(pattern, normalized)
        except (OSError, RuntimeError, ValueError):
            return GlobResult(error=ACCESS_DENIED)

    async def aglob(self, pattern, path=None):
        return await asyncio.to_thread(self.glob, pattern, path)

    def grep(self, pattern, path=None, glob=None, *, max_count=None):
        try:
            return super().grep(pattern, self.normalize_path(path), glob, max_count=max_count)
        except (OSError, RuntimeError, ValueError):
            return GrepResult(error=ACCESS_DENIED)

    async def agrep(self, pattern, path=None, glob=None, *, max_count=None):
        return await asyncio.to_thread(self.grep, pattern, path, glob, max_count=max_count)

    def delete(self, file_path):
        return DeleteResult(error=DELETE_DISABLED)

    async def adelete(self, file_path):
        return DeleteResult(error=DELETE_DISABLED)


def build_filesystem_backend(workspace_dir: Path, *, workspace=None):
    if workspace is None:
        workspace_dir = workspace_dir.expanduser().resolve()
        workspace_dir.mkdir(parents=True, exist_ok=True)
        workspace = {"kind": "default", "root_dir": str(workspace_dir), "project_id": None, "project_name": None, "grants": []}
    if not Path(workspace["root_dir"]).is_dir():
        raise ValueError("工作目录不存在或无法访问，请重新选择目录。")
    return AgentFilesystemBackend(workspace)
