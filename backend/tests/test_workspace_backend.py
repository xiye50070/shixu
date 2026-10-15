"""Real-disk enforcement below model/tool prompts, including upload bypasses."""

from pathlib import Path

import pytest

from app.workspace_backend import DELETE_DISABLED, build_filesystem_backend


def workspace(root, grants=(), protected=()):
    return {"kind": "default", "root_dir": str(root), "project_id": None, "project_name": None,
            "grants": list(grants), "protected_paths": [str(path) for path in protected]}


def grant(path, access="read", kind="directory", grant_id="g1"):
    return {"id": grant_id, "path": str(path), "kind": kind, "access": access, "mount_path": f"/external/{grant_id}/"}


async def test_readonly_directory_denies_sync_async_write_edit_and_upload(tmp_path):
    root = tmp_path / "root"
    external = tmp_path / "external"
    root.mkdir()
    external.mkdir()
    existing = external / "keep.txt"
    existing.write_text("original")
    backend = build_filesystem_backend(root, workspace=workspace(root, [grant(external)]))
    assert backend.read(str(existing)).error is None
    assert (await backend.aread("/external/g1/keep.txt")).error is None
    assert backend.write(str(external / "no.txt"), "denied").error
    assert (await backend.awrite("/external/g1/no.txt", "denied")).error
    assert backend.edit(str(existing), "original", "changed").error
    assert (await backend.aedit("/external/g1/keep.txt", "original", "changed")).error
    assert backend.upload_files([(str(existing), b"overwrite")])[0].error == "permission_denied"
    assert (await backend.aupload_files([("/external/g1/keep.txt", b"overwrite")]))[0].error == "permission_denied"
    assert existing.read_text() == "original"
    assert not (external / "no.txt").exists()
    assert backend.grep("original", str(external)).matches[0]["path"] == "/external/g1/keep.txt"
    assert backend.glob("*.txt", "/external/g1/").matches[0]["path"] == "/external/g1/keep.txt"


async def test_readwrite_grant_and_new_revoked_snapshot(tmp_path):
    root, external = tmp_path / "root", tmp_path / "external"
    root.mkdir()
    external.mkdir()
    allowed = build_filesystem_backend(root, workspace=workspace(root, [grant(external, "read_write")]))
    assert allowed.write(str(external / "report.md"), "first").error is None
    assert (await allowed.aedit("/external/g1/report.md", "first", "second")).error is None
    assert allowed.upload_files([("/external/g1/upload.txt", b"upload")])[0].error is None
    assert (await allowed.adownload_files([str(external / "report.md")]))[0].content == b"second"
    # A revoked grant affects the next immutable run. Do not mutate a backend
    # currently executing another task to retarget its directory or permissions.
    revoked = build_filesystem_backend(root, workspace=workspace(root))
    assert revoked.read(str(external / "report.md")).error
    assert revoked.write("/external/g1/new.md", "denied").error
    assert not (external / "new.md").exists()
    assert (external / "report.md").read_text() == "second"


async def test_file_grant_never_grants_its_parent_or_siblings(tmp_path):
    root, external = tmp_path / "root", tmp_path / "external"
    root.mkdir()
    external.mkdir()
    selected, sibling = external / "selected.md", external / "secret.md"
    selected.write_text("selected")
    sibling.write_text("secret")
    backend = build_filesystem_backend(root, workspace=workspace(root, [grant(selected, "read_write", "file")]))
    assert backend.read(str(selected)).error is None
    assert backend.read(str(sibling)).error
    assert backend.read("/external/g1/secret.md").error
    assert backend.write("/external/g1/new.md", "denied").error
    assert backend.edit("/external/g1/selected.md", "selected", "changed").error is None
    assert backend.ls("/external/g1/").entries == [{"path": "/external/g1/selected.md", "is_dir": False}]
    assert [item["path"] for item in backend.glob("*.md", "/external/g1/").matches] == ["/external/g1/selected.md"]
    assert not backend.grep("secret", "/external/g1/").matches
    assert backend.upload_files([("/external/g1/secret.md", b"denied")])[0].error
    assert sibling.read_text() == "secret"


def test_protected_data_is_never_opened_by_search_or_direct_tools(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    data = root / "data"
    data.mkdir()
    database = data / "workspace.db"
    key = root / ".env"
    database.write_text("secret-needle database")
    key.write_text("secret-needle key")
    (root / "public.md").write_text("public-needle")
    backend = build_filesystem_backend(root, workspace=workspace(root, protected=[data, key]))
    original_open = Path.open

    def checked_open(self, *args, **kwargs):
        assert self.resolve() not in {database, key}, "A protected file was opened"
        return original_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", checked_open)
    assert backend.read("/workspace/.env").error
    assert backend.read(str(database)).error
    assert backend.write("/workspace/data/new.md", "denied").error
    assert backend.edit("/workspace/.env", "key", "changed").error
    assert backend.upload_files([("/workspace/.env", b"denied")])[0].error
    assert backend.download_files([str(database)])[0].error
    assert not backend.grep("secret-needle", "/workspace/").matches
    assert backend.grep("public-needle", "/workspace/").matches
    assert [entry["path"] for entry in backend.ls("/workspace/").entries] == ["/workspace/public.md"]
    assert [entry["path"] for entry in backend.glob("*", "/workspace/").matches] == ["/workspace/public.md"]


async def test_symlink_escape_is_blocked_for_all_external_operations(tmp_path):
    root, external, outside = tmp_path / "root", tmp_path / "external", tmp_path / "outside"
    for folder in (root, external, outside):
        folder.mkdir()
    (outside / "secret.md").write_text("secret-needle")
    (external / "escape").symlink_to(outside, target_is_directory=True)
    backend = build_filesystem_backend(root, workspace=workspace(root, [grant(external, "read_write")]))
    path = "/external/g1/escape/secret.md"
    assert backend.read(path).error
    assert backend.edit(path, "secret", "changed").error
    assert backend.write("/external/g1/escape/new.md", "denied").error
    assert backend.upload_files([(path, b"denied")])[0].error
    assert backend.download_files([path])[0].error
    assert not backend.glob("*.md", "/external/g1/").matches
    assert not backend.grep("secret-needle", "/external/g1/").matches
    assert (outside / "secret.md").read_text() == "secret-needle"
    assert not (outside / "new.md").exists()
    for target in (path, "/workspace/", "/large_tool_results/internal"):
        assert backend.delete(target).error == DELETE_DISABLED
        assert (await backend.adelete(target)).error == DELETE_DISABLED


@pytest.mark.parametrize("kind", ["file", "directory"])
def test_saved_grant_cannot_follow_replaced_symlink_target(tmp_path, kind):
    root, outside, original = tmp_path / "root", tmp_path / "outside", tmp_path / "selected"
    root.mkdir()
    if kind == "file":
        original.write_text("selected")
        outside.write_text("outside-secret")
    else:
        original.mkdir()
        outside.mkdir()
        (outside / "secret.md").write_text("outside-secret")
    saved = workspace(root, [grant(original, "read_write", kind)])
    if kind == "file":
        original.unlink()
    else:
        original.rmdir()
    original.symlink_to(outside, target_is_directory=kind == "directory")
    with pytest.raises(ValueError, match="外部授权路径已变化"):
        build_filesystem_backend(root, workspace=saved)


def test_saved_file_grant_cannot_become_directory(tmp_path):
    root, original = tmp_path / "root", tmp_path / "selected"
    root.mkdir()
    original.write_text("selected")
    saved = workspace(root, [grant(original, "read_write", "file")])
    original.unlink()
    original.mkdir()
    (original / "secret.md").write_text("new-secret")
    with pytest.raises(ValueError, match="外部授权路径已变化"):
        build_filesystem_backend(root, workspace=saved)
