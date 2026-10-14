"""Test-only DeepSeek chat-completions transport; never used by the Demo launcher."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import time
import uuid


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
        if data.get("model") != "deepseek-flash":
            self.send_error(400, "Only deepseek-flash expected in fixture")
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
        if "记住" in latest:
            answer = "好的，我记住了：蓝色鲸鱼。你可以在这个任务里继续提问。"
        elif "关键词" in latest:
            answer = "你之前提到的关键词是蓝色鲸鱼。" if any("蓝色鲸鱼" in m for m in user_messages[:-1]) else "这个会话中没有这个关键词。"
        else:
            answer = "我已收到你的任务。我们可以先整理目标，再拆分步骤，逐项完成。"
        slow = "慢速" in latest
        if slow:
            answer = "这是用于验证停止按钮的测试响应。" * 20
        response_id = "chatcmpl-test-" + uuid.uuid4().hex
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            pieces = [answer[i:i + 3] for i in range(0, len(answer), 3)]
            for index, piece in enumerate(pieces):
                event = {"id": response_id, "object": "chat.completion.chunk", "created": int(time.time()), "model": "deepseek-flash", "choices": [{"index": 0, "delta": {"content": piece, **({"role": "assistant"} if index == 0 else {})}, "finish_reason": None}]}
                self.wfile.write(("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode())
                self.wfile.flush()
                time.sleep(0.25 if slow else 0.04)
            self.wfile.write(("data: " + json.dumps({"id": response_id, "object": "chat.completion.chunk", "created": int(time.time()), "model": "deepseek-flash", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}) + "\n\ndata: [DONE]\n\n").encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.getenv("FIXTURE_PORT", "18965"))), Handler).serve_forever()
