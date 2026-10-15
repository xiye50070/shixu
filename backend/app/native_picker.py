"""Open the local macOS NSOpenPanel without exposing a shell to the Agent."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path


# Freeze the host bridge when the server imports this module. A workspace may
# contain Shixu's source tree; editing its .js file must not change the code a
# later picker invocation executes in this already-running server process.
NATIVE_PICKER_SCRIPT = Path(__file__).with_suffix(".js").read_text(encoding="utf-8")


class NativePickerError(RuntimeError):
    pass


def starting_directory(initial_path: str | None, default_path: Path) -> Path:
    try:
        if initial_path and "\x00" in initial_path:
            raise ValueError("Invalid path")
        path = Path(initial_path.strip()).expanduser() if initial_path and initial_path.strip() else default_path
        if not path.is_absolute():
            path = default_path
        while not path.is_dir() and path.parent != path:
            path = path.parent
        return path.resolve()
    except (OSError, RuntimeError, ValueError):
        return default_path.resolve()


async def choose_native_path(*, initial_path: Path, include_files: bool, title: str) -> dict:
    if sys.platform != "darwin":
        raise NativePickerError("系统选择窗口目前支持本机 macOS。请在路径输入框中填写绝对路径。")
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            "/usr/bin/osascript", "-l", "JavaScript", "-e", NATIVE_PICKER_SCRIPT, "--",
            "files_and_directories" if include_files else "directories", title, str(initial_path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        output, _ = await asyncio.wait_for(process.communicate(), timeout=300)
        if process.returncode:
            raise NativePickerError("无法打开系统选择窗口。请确认后端运行在本机已登录的 macOS 桌面中，或直接填写路径。")
        result = json.loads(output.decode("utf-8"))
        if result == {"path": None, "cancelled": True}:
            return result
        if not isinstance(result, dict) or result.get("cancelled") is not False or not isinstance(result.get("path"), str):
            raise ValueError("Invalid native picker response")
        return {"path": result["path"], "cancelled": False}
    except asyncio.CancelledError:
        raise
    except TimeoutError:
        raise NativePickerError("系统选择窗口等待超时，请点击浏览重新选择。") from None
    except (OSError, ValueError, UnicodeError):
        raise NativePickerError("系统选择窗口未能返回有效路径，请重试或直接填写路径。") from None
    finally:
        if process is not None and process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except TimeoutError:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                await process.wait()
