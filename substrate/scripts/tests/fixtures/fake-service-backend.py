#!/usr/bin/env python3
"""Fake agent-services backend for agent-services.test.sh.

Plays the app's /agent-services/v1 routes for fleet-service and the service
wrappers. Usage:

    fake-service-backend.py <state-dir> <steps.json>

steps.json is a list; each POST or GET to /agent-services/v1/jobs/<id> takes
the next step:

    {"status": 200, "body": {...}, "files": ["png-0", "png-1"]}
    {"status": 202}                      still running
    {"status": 404, "body": {...}}       any refusal, as the backend sends it
    {"drop": true}                       close the connection without answering

The last step repeats once the list runs out. Output files from the last 200
step are served at /files/<i>. Everything received is recorded in
<state-dir>: calls.log (one "METHOD path auth=<header>" line per call),
envelope.json (the request field of the last POST) and attachments.json
({slot: {filename, content}}). The port it listens on is written to
<state-dir>/port once it's ready.
"""
import json
import os
import sys
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = sys.argv[1]
with open(sys.argv[2]) as f:
    STEPS = json.load(f)
step_index = 0
last_files = []


def next_step():
    global step_index
    step = STEPS[min(step_index, len(STEPS) - 1)]
    step_index += 1
    return step


def record(line):
    with open(os.path.join(STATE, "calls.log"), "a") as f:
        f.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else b"")
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream" if raw is not None else "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def job_step(self):
        global last_files
        step = next_step()
        if step.get("drop"):
            self.close_connection = True
            self.connection.shutdown(2)
            return
        if step.get("status") == 200:
            last_files = step.get("files", [])
            body = dict(step["body"])
            if body.get("ok"):
                body["files"] = [{"ext": "png", "size": len(c)} for c in last_files]
            self.reply(200, body)
        else:
            self.reply(step["status"], step.get("body", {"state": "running"}))

    def do_POST(self):
        record(f"POST {self.path} auth={self.headers.get('Authorization', '')}")
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        msg = BytesParser(policy=HTTP).parsebytes(
            b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + raw
        )
        attachments = {}
        for part in msg.iter_parts():
            name = part.get_param("name", header="content-disposition")
            content = part.get_payload(decode=True) or b""
            if name == "request":
                with open(os.path.join(STATE, "envelope.json"), "wb") as f:
                    f.write(content)
            elif name and name.startswith("attachment."):
                attachments[name[len("attachment."):]] = {
                    "filename": part.get_filename(),
                    "content": content.decode("utf-8", "replace"),
                }
        with open(os.path.join(STATE, "attachments.json"), "w") as f:
            json.dump(attachments, f)
        self.job_step()

    def do_GET(self):
        record(f"GET {self.path} auth={self.headers.get('Authorization', '')}")
        if "/files/" in self.path:
            i = int(self.path.rsplit("/", 1)[1])
            if i < len(last_files):
                self.reply(200, raw=last_files[i].encode())
            else:
                self.reply(404, {"ok": False, "service": None, "error": {"code": "lost"}})
            return
        self.job_step()

    def do_DELETE(self):
        record(f"DELETE {self.path} auth={self.headers.get('Authorization', '')}")
        self.reply(204)


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(os.path.join(STATE, "port.tmp"), "w") as f:
    f.write(str(server.server_address[1]))
os.rename(os.path.join(STATE, "port.tmp"), os.path.join(STATE, "port"))
server.serve_forever()
