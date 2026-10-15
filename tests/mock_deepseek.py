"""Test-only chat-completions transport; never used by the Demo launcher.

Both supported provider adapters call this local fixture during E2E checks. The
OpenAI-compatible model has a distinct answer so a settings change is verified
through the actual Agent stream, rather than merely reading saved form values.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import time
import uuid


FILE_CONTENT = "拾序文件练习\n关键词：蓝色鲸鱼\n状态：初稿\n"
FILE_TEST_MARKER = re.compile(r"【文件测试:(WRITE|READ|EDIT|SEARCH|DELETE|EXECUTE):(/workspace/e2e-[a-z0-9-]+\.txt)】")
PATH_TEST_MARKER = re.compile(r"【路径测试:(\{[^\n]*\})】")


def path_test_response(data, messages, latest):
    """Exercise runtime-scoped routing through the real Agent tools.

    The marker is a local test protocol, not production model behavior. It
    instructs this deterministic fixture to request tools and inspect results.
    A successful reply requires both the expected dynamic system context and a
    real tool result; Playwright independently reads the disposable disk.
    """
    marker = PATH_TEST_MARKER.search(latest)
    if marker is None:
        return None
    command = json.loads(marker.group(1))
    operation = command["op"]
    token = command["token"]
    file_path = command["path"]
    system = "\n".join(str(item.get("content", "")) for item in messages if item.get("role") == "system")
    if command["root"] not in system:
        raise ValueError("The dynamic system environment is missing the backend-resolved workspace root")
    if command.get("project") and command["project"] not in system:
        raise ValueError("The dynamic system environment is missing the current project")
    for grant in command.get("grants", []):
        if grant["path"] not in system or grant["label"] not in system:
            raise ValueError("The dynamic system environment is missing an active external grant")
    for revoked in command.get("revoked", []):
        if revoked in system:
            raise ValueError("Revoked external grants remain in the model's current environment")
    tool_names = {item.get("function", {}).get("name") for item in data.get("tools", [])}
    required = {"ls", "read_file", "write_file", "edit_file", "glob", "grep"}
    if not required.issubset(tool_names) or tool_names & {"delete", "execute"}:
        raise ValueError("Path fixture requires scoped file tools and forbids delete/execute")
    current_user = max(index for index, item in enumerate(messages) if item.get("role") == "user")
    tool_results = [item for item in messages[current_user + 1:] if item.get("role") == "tool"]
    if command.get("delegate"):
        if "task" not in tool_names:
            raise ValueError("The main agent cannot delegate to the real general-purpose subagent")
        child_command = {**command, "delegate": False}
        child_prompt = "验证同一工作区上下文并执行文件操作。【路径测试:" + json.dumps(child_command, ensure_ascii=False) + "】"
        name, arguments = "task", {"description": child_prompt, "subagent_type": "general-purpose"}
    elif operation == "WRITE":
        name, arguments = "write_file", {"file_path": file_path, "content": "路径隔离验证：" + token + "\n"}
    elif operation == "READ":
        name, arguments = "read_file", {"file_path": file_path}
    elif operation == "DELETE":
        name, arguments = "delete", {"path": file_path}
    elif operation == "EXECUTE":
        name, arguments = "execute", {"command": "rm " + file_path}
    else:
        raise ValueError("Unknown path fixture operation")
    if not tool_results:
        return {"tool_call": {"id": "call-" + uuid.uuid4().hex, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)}}}
    result = str(tool_results[-1].get("content", ""))
    expected = command.get("expected", "allowed")
    if command.get("delegate"):
        child_reply = f"路径验证 {token} {expected}"
        if child_reply not in result:
            raise ValueError("Subagent did not return a verified runtime-context/file-tool result")
        return {"answer": f"子 Agent 路径验证 {token} {expected}"}
    if operation in {"DELETE", "EXECUTE"}:
        if "not a valid tool" not in result or name not in result:
            raise ValueError("Expected an unavailable-tool refusal")
    elif expected == "blocked":
        if not any(term in result.lower() for term in ("error", "denied", "permission", "not authorized", "not granted", "授权", "禁止", "不可", "仅有读取权限")):
            raise ValueError("Expected a backend authorization refusal, got: " + result)
    elif operation == "WRITE":
        if "Updated file" not in result:
            raise ValueError("Missing actual disk write result: " + result)
    elif operation == "READ":
        if command["contains"] not in result:
            raise ValueError("The real file content was not returned: " + result)
    return {"answer": f"路径验证 {token} {expected}"}


def file_test_response(data, messages, latest):
    """Drive real ToolNode calls without giving the fixture disk access.

    Replies depend on tool results produced by the Agent, while Playwright
    separately checks the disposable files. This cannot pass by returning a
    canned success sentence without exercising the file backend.
    """
    marker = FILE_TEST_MARKER.search(latest)
    if marker is None:
        return None
    operation, file_path = marker.groups()
    tool_names = {item.get("function", {}).get("name") for item in data.get("tools", [])}
    required = {"ls", "read_file", "write_file", "edit_file", "glob", "grep"}
    if not required.issubset(tool_names) or tool_names & {"delete", "execute"}:
        raise ValueError("Filesystem fixture requires the six allowed tools and forbids delete/execute")

    # Ignore previous turns' tool messages so each prompt starts its own script.
    current_user = max(index for index, item in enumerate(messages) if item.get("role") == "user")
    tool_results = [item for item in messages[current_user + 1:] if item.get("role") == "tool"]
    scripts = {
        "WRITE": [("ls", {"path": "/workspace/"}), ("write_file", {"file_path": file_path, "content": FILE_CONTENT})],
        "READ": [("read_file", {"file_path": file_path})],
        "EDIT": [("read_file", {"file_path": file_path}), ("edit_file", {"file_path": file_path, "old_string": "状态：初稿", "new_string": "状态：已完成"})],
        "SEARCH": [("glob", {"pattern": file_path.rsplit("/", 1)[-1], "path": "/workspace/"}), ("grep", {"pattern": "蓝色鲸鱼", "path": "/workspace/", "glob": file_path.rsplit("/", 1)[-1], "output_mode": "content"})],
        # Deliberately emulate an errant model requesting tools it was not given.
        "DELETE": [("delete", {"path": file_path})],
        "EXECUTE": [("execute", {"command": "rm " + file_path})],
    }
    script = scripts[operation]
    if len(tool_results) < len(script):
        name, arguments = script[len(tool_results)]
        return {"tool_call": {"id": "call-" + uuid.uuid4().hex, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)}}}

    results = [str(item.get("content", "")) for item in tool_results]
    if operation in {"DELETE", "EXECUTE"}:
        tool_name = script[0][0]
        if not any("not a valid tool" in content and tool_name in content for content in results):
            raise ValueError("Expected an unavailable-tool error; refusing to fake a blocked operation")
        return {"answer": f"已拒绝 {tool_name}：该工具未开放，文件保留。"}
    if any(content.startswith("Error:") for content in results):
        return {"answer": "文件操作失败：" + "\n".join(results)}
    if operation == "WRITE":
        if "Updated file" not in results[-1]:
            raise ValueError("Missing real write_file result")
        return {"answer": f"已创建文件：{file_path}。"}
    if operation == "READ":
        return {"answer": "文件读取结果：\n" + results[-1]}
    if operation == "EDIT":
        if "Successfully replaced" not in results[-1]:
            raise ValueError("Missing real edit_file result")
        return {"answer": f"已修改文件：{file_path}，状态已完成。"}
    return {"answer": "文件搜索结果：\n" + "\n".join(results)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"test_fixture":true}')

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        model = data.get("model")
        if self.path not in {"/chat/completions", "/v1/chat/completions"}:
            self.send_error(404, "Only chat completions expected in fixture")
            return
        if model not in {"deepseek-flash", "fixture-openai"}:
            self.send_error(400, "Only test fixture models are allowed")
            return
        if model == "fixture-openai" and any(key in data for key in ("thinking", "stream_options")):
            self.send_error(400, "The generic adapter must use a minimal chat-completions request")
            return
        messages = data.get("messages", [])
        user_messages = [str(m.get("content", "")) for m in messages if m.get("role") == "user"]
        latest = user_messages[-1] if user_messages else ""
        if "触发错误" in latest:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": {"message": "TEST_ONLY_PROVIDER_ERROR", "type": "invalid_request_error"}}).encode())
            return
        try:
            file_response = path_test_response(data, messages, latest) or file_test_response(data, messages, latest)
        except ValueError as error:
            print(f"Local fixture validation failed: {error}", flush=True)
            self.send_error(400, "LOCAL_FIXTURE_VALIDATION_FAILED")
            return
        tool_call = file_response.get("tool_call") if file_response else None
        if file_response:
            answer = file_response.get("answer", "")
        elif model == "fixture-openai":
            answer = "这是 OpenAI 兼容模型的测试回复，新的模型配置已经生效。"
        elif "记住" in latest:
            answer = "好的，我记住了：蓝色鲸鱼。你可以在这个任务里继续提问。"
        elif "关键词" in latest:
            answer = "你之前提到的关键词是蓝色鲸鱼。" if any("蓝色鲸鱼" in m for m in user_messages[:-1]) else "这个会话中没有这个关键词。"
        else:
            answer = "我已收到你的任务。我们可以先整理目标，再拆分步骤，逐项完成。"
        slow = "慢速" in latest
        if slow:
            answer = "这是用于验证停止按钮的测试响应。" * 20
        response_id = "chatcmpl-test-" + uuid.uuid4().hex
        if not data.get("stream", False):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "id": response_id,
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": None if tool_call else answer, **({"tool_calls": [tool_call]} if tool_call else {})}, "finish_reason": "tool_calls" if tool_call else "stop"}],
                "usage": {"prompt_tokens": 8, "completion_tokens": 16, "total_tokens": 24},
            }, ensure_ascii=False).encode())
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            if tool_call:
                # Function arguments are deliberately split into deltas, as real
                # providers do; this exercises the adapters' tool-call assembly.
                function = tool_call["function"]
                argument_chunks = [function["arguments"][index:index + 16] for index in range(0, len(function["arguments"]), 16)]
                for index, arguments in enumerate(argument_chunks):
                    delta_call = {"index": 0, "function": {"arguments": arguments}}
                    if index == 0:
                        delta_call.update({"id": tool_call["id"], "type": "function"})
                        delta_call["function"]["name"] = function["name"]
                    event = {"id": response_id, "object": "chat.completion.chunk", "created": int(time.time()), "model": model, "choices": [{"index": 0, "delta": {"tool_calls": [delta_call], **({"role": "assistant"} if index == 0 else {})}, "finish_reason": None}]}
                    self.wfile.write(("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode())
                    self.wfile.flush()
                event = {"id": response_id, "object": "chat.completion.chunk", "created": int(time.time()), "model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}
                self.wfile.write(("data: " + json.dumps(event) + "\n\ndata: [DONE]\n\n").encode())
                self.wfile.flush()
                return
            pieces = [answer[i:i + 3] for i in range(0, len(answer), 3)]
            for index, piece in enumerate(pieces):
                event = {"id": response_id, "object": "chat.completion.chunk", "created": int(time.time()), "model": model, "choices": [{"index": 0, "delta": {"content": piece, **({"role": "assistant"} if index == 0 else {})}, "finish_reason": None}]}
                self.wfile.write(("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode())
                self.wfile.flush()
                time.sleep(0.25 if slow else 0.04)
            self.wfile.write(("data: " + json.dumps({"id": response_id, "object": "chat.completion.chunk", "created": int(time.time()), "model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}) + "\n\ndata: [DONE]\n\n").encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.getenv("FIXTURE_PORT", "18965"))), Handler).serve_forever()
