"""Native bridge checks mock the process; real NSOpenPanel is verified separately."""

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import Settings, create_app
from app.native_picker import NATIVE_PICKER_SCRIPT, NativePickerError, choose_native_path, starting_directory


def test_starting_directory_handles_existing_files_and_missing_drafts(tmp_path):
    selected = tmp_path / "文档.txt"
    selected.write_text("text")
    assert starting_directory(str(selected), tmp_path) == tmp_path
    assert starting_directory(str(tmp_path / "not-created" / "draft"), tmp_path) == tmp_path
    assert starting_directory(None, tmp_path) == tmp_path
    assert starting_directory("relative", tmp_path) == tmp_path


def test_starting_directory_rejects_nul_and_handles_path_value_errors(tmp_path, monkeypatch):
    assert starting_directory(str(tmp_path / "bad\x00path"), tmp_path) == tmp_path

    def invalid_path(self):
        raise ValueError("Invalid path")

    monkeypatch.setattr(Path, "is_dir", invalid_path)
    assert starting_directory(str(tmp_path / "value-error"), tmp_path) == tmp_path


class Process:
    def __init__(self, response=None, *, returncode=0, hang=False):
        self.response = response
        self.returncode = None
        self.final_code = returncode
        self.hang = hang
        self.terminated = False

    async def communicate(self):
        if self.hang:
            await asyncio.Event().wait()
        self.returncode = self.final_code
        return json.dumps(self.response, ensure_ascii=False).encode(), b"private process error"

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    async def wait(self):
        return self.returncode


async def test_native_process_uses_fixed_script_and_arguments_not_shell(tmp_path, monkeypatch):
    arguments = []
    selected = str(tmp_path / '中文 "$()" 目录')
    process = Process({"path": selected, "cancelled": False})

    async def spawn(*args, **kwargs):
        arguments.append(args)
        return process

    monkeypatch.setattr("app.native_picker.sys.platform", "darwin")
    monkeypatch.setattr("app.native_picker.asyncio.create_subprocess_exec", spawn)
    # No helper file is re-read when opening a picker. User/model edits to a
    # selected source workspace cannot replace the running bridge's script.
    def unexpected_file_read(self, *args, **kwargs):
        pytest.fail("Picker invocation re-read mutable bridge source")
    monkeypatch.setattr(Path, "read_text", unexpected_file_read)
    result = await choose_native_path(initial_path=tmp_path, include_files=True, title='选择 "目录"')
    assert result == {"path": selected, "cancelled": False}
    assert arguments[0][:3] == ("/usr/bin/osascript", "-l", "JavaScript")
    assert arguments[0][3:6] == ("-e", NATIVE_PICKER_SCRIPT, "--")
    assert "NSOpenPanel" in arguments[0][4]
    assert arguments[0][6:] == ("files_and_directories", '选择 "目录"', str(tmp_path))


@pytest.mark.parametrize("response,code,raises", [
    ({"path": None, "cancelled": True}, 0, False),
    ({"path": None, "cancelled": False}, 0, True),
    ({"path": "/chosen", "cancelled": False}, 1, True),
])
async def test_native_cancellation_and_errors_are_distinct(tmp_path, monkeypatch, response, code, raises):
    async def spawn(*args, **kwargs):
        return Process(response, returncode=code)
    monkeypatch.setattr("app.native_picker.sys.platform", "darwin")
    monkeypatch.setattr("app.native_picker.asyncio.create_subprocess_exec", spawn)
    if raises:
        with pytest.raises(NativePickerError) as error:
            await choose_native_path(initial_path=tmp_path, include_files=False, title="选择")
        assert "private process error" not in str(error.value)
    else:
        assert await choose_native_path(initial_path=tmp_path, include_files=False, title="选择") == response


async def test_aborted_request_terminates_its_native_process(tmp_path, monkeypatch):
    process = Process(hang=True)
    spawned = asyncio.Event()
    async def spawn(*args, **kwargs):
        spawned.set()
        return process
    monkeypatch.setattr("app.native_picker.sys.platform", "darwin")
    monkeypatch.setattr("app.native_picker.asyncio.create_subprocess_exec", spawn)
    task = asyncio.create_task(choose_native_path(initial_path=tmp_path, include_files=False, title="选择"))
    await spawned.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert process.terminated


@pytest.mark.parametrize("exit_stage", ["terminate", "kill"])
async def test_cleanup_tolerates_process_exiting_between_check_and_signal(tmp_path, monkeypatch, exit_stage):
    class ExitingProcess(Process):
        waits = 0

        def terminate(self):
            if exit_stage == "terminate":
                self.returncode = 0
                raise ProcessLookupError

        async def wait(self):
            self.waits += 1
            if exit_stage == "kill" and self.waits == 1:
                raise TimeoutError
            return self.returncode

        def kill(self):
            self.returncode = 0
            raise ProcessLookupError

    process = ExitingProcess(hang=True)
    spawned = asyncio.Event()

    async def spawn(*args, **kwargs):
        spawned.set()
        return process

    monkeypatch.setattr("app.native_picker.sys.platform", "darwin")
    monkeypatch.setattr("app.native_picker.asyncio.create_subprocess_exec", spawn)
    task = asyncio.create_task(choose_native_path(initial_path=tmp_path, include_files=False, title="选择"))
    await spawned.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert process.waits == (1 if exit_stage == "terminate" else 2)


async def test_other_platform_has_actionable_manual_path_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr("app.native_picker.sys.platform", "linux")
    with pytest.raises(NativePickerError, match="绝对路径"):
        await choose_native_path(initial_path=tmp_path, include_files=False, title="选择")


def test_picker_api_returns_real_path_without_saving_or_granting(tmp_path, monkeypatch):
    selected = tmp_path / "项目目录"
    selected.mkdir()
    calls = []
    async def choose(**kwargs):
        calls.append(kwargs)
        return {"path": str(selected), "cancelled": False}
    monkeypatch.setattr("app.main.choose_native_path", choose)
    app = create_app(Settings(data_dir=tmp_path / "data", files_dir=tmp_path / "default"))
    with TestClient(app, client=("127.0.0.1", 50000)) as client:
        initial = client.get("/api/settings/workspace").json()
        result = client.post("/api/filesystem/pick", json={"title": "选择项目工作目录", "initial_path": str(selected), "include_files": False})
        assert result.status_code == 200
        assert result.json() == {"path": str(selected), "cancelled": False}
        assert calls[0]["initial_path"] == selected
        assert client.get("/api/settings/workspace").json() == initial
        assert client.get("/api/projects").json() == []


@pytest.mark.parametrize("remote,origin", [(True, None), (False, "https://external.example"), (False, "http://[")])
def test_picker_api_refuses_remote_and_cross_origin_invocations(tmp_path, monkeypatch, remote, origin):
    async def never(**kwargs):
        pytest.fail("Untrusted request opened a system window")
    monkeypatch.setattr("app.main.choose_native_path", never)
    app = create_app(Settings(data_dir=tmp_path / "data", files_dir=tmp_path / "default"))
    with TestClient(app, client=("192.0.2.5" if remote else "127.0.0.1", 50000)) as client:
        result = client.post("/api/filesystem/pick", json={}, headers={"Origin": origin} if origin else {})
        assert result.status_code == 403


def test_picker_api_cancel_busy_and_unsupported_results(tmp_path, monkeypatch):
    async def cancel(**kwargs):
        return {"path": None, "cancelled": True}
    monkeypatch.setattr("app.main.choose_native_path", cancel)
    app = create_app(Settings(data_dir=tmp_path / "data", files_dir=tmp_path / "default"))
    with TestClient(app, client=("127.0.0.1", 50000)) as client:
        assert client.post("/api/filesystem/pick", json={}).json() == {"path": None, "cancelled": True}
        client.portal.call(app.state.native_picker_lock.acquire)
        try:
            assert client.post("/api/filesystem/pick", json={}).status_code == 409
        finally:
            client.portal.call(app.state.native_picker_lock.release)
        async def unsupported(**kwargs):
            raise NativePickerError("请直接填写路径")
        monkeypatch.setattr("app.main.choose_native_path", unsupported)
        result = client.post("/api/filesystem/pick", json={})
        assert result.status_code == 503 and "填写路径" in result.json()["detail"]


def test_picker_api_still_validates_selection_type_and_protected_paths(tmp_path, monkeypatch):
    selected = tmp_path / "file.txt"
    selected.write_text("file")
    result = {"path": str(selected), "cancelled": False}
    async def choose(**kwargs):
        return result
    monkeypatch.setattr("app.main.choose_native_path", choose)
    app = create_app(Settings(data_dir=tmp_path / "data", files_dir=tmp_path / "default"))
    with TestClient(app, client=("127.0.0.1", 50000)) as client:
        assert client.post("/api/filesystem/pick", json={"include_files": False}).status_code == 422
        assert client.post("/api/filesystem/pick", json={"include_files": True}).status_code == 200
        result["path"] = str(tmp_path / "data")
        assert client.post("/api/filesystem/pick", json={}).status_code == 422
