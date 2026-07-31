from __future__ import annotations

import hashlib
import json
import ntpath
import os
import posixpath
import socket
import sys
import queue
import threading
from typing import Any, BinaryIO, Dict, List, Optional

FRAME_DELIMITER = b"\n"
UNIX_SOCKET_BASE_DIRECTORY = "/tmp"
DAEMON_SOCKET_FILENAME = "daemon.sock"
DEFAULT_TIMEOUT_MS = 130_000


class PaneDaemonClientError(RuntimeError):
    def __init__(self, message: str, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


class RetainedDaemonConnection:
    def __init__(self, pane_dir: Optional[str] = None) -> None:
        endpoint = get_pane_daemon_endpoint(resolve_pane_directory(pane_dir))
        self._endpoint = endpoint
        self._socket: Optional[socket.socket] = None
        self._pipe: Optional[BinaryIO] = None
        self._decoder = PaneDaemonFrameDecoder()
        self._pending: Dict[int, queue.Queue[Any]] = {}
        self.events: queue.Queue[Any] = queue.Queue()
        self.errors: queue.Queue[Exception] = queue.Queue()
        self._next_id = 1
        self._closed = False
        if endpoint["transport"] == "pipe":
            self._pipe = open(endpoint["path"], "r+b", buffering=0)
        else:
            self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self._socket.connect(endpoint["path"])
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    def request(self, channel: str, args: Optional[List[Any]] = None, timeout_ms: float = DEFAULT_TIMEOUT_MS) -> Any:
        request_id = self._next_id
        self._next_id += 1
        response_queue: queue.Queue[Any] = queue.Queue(maxsize=1)
        self._pending[request_id] = response_queue
        self._write(encode_frame({"type": "request", "id": request_id, "channel": channel, "args": args or []}))
        try:
            response = response_queue.get(timeout=timeout_ms / 1000)
        except queue.Empty as error:
            self._pending.pop(request_id, None)
            raise PaneDaemonClientError("Timed out waiting for Pane daemon response", "ERR_RUNPANE_DAEMON_TIMEOUT") from error
        if isinstance(response, Exception):
            raise response
        return response

    def close(self) -> None:
        self._closed = True
        if self._socket:
            self._socket.close()
        if self._pipe:
            self._pipe.close()

    def _write(self, data: bytes) -> None:
        if self._socket:
            self._socket.sendall(data)
        elif self._pipe:
            self._pipe.write(data)

    def _read_loop(self) -> None:
        try:
            while not self._closed:
                chunk = self._socket.recv(65536) if self._socket else self._pipe.read(65536) if self._pipe else b""
                if not chunk:
                    raise PaneDaemonClientError("Pane daemon closed the retained connection", "ERR_RUNPANE_DAEMON_CLOSED")
                for frame in self._decoder.push(chunk):
                    if frame.get("type") == "event" and frame.get("channel") == "panel:semanticEvent":
                        args = frame.get("args")
                        self.events.put(args[0] if isinstance(args, list) and args else None)
                    elif frame.get("type") == "response":
                        target = self._pending.pop(frame.get("id"), None)
                        if target:
                            if frame.get("ok") is True:
                                target.put(frame.get("result"))
                            else:
                                payload = frame.get("error") or {}
                                target.put(PaneDaemonClientError(payload.get("message", "Pane daemon request failed"), payload.get("code")))
        except Exception as error:
            if not self._closed:
                self.errors.put(error)
                for target in self._pending.values():
                    target.put(error)
                self._pending.clear()


def resolve_pane_directory(pane_dir: Optional[str] = None) -> str:
    return pane_dir or os.environ.get("PANE_DIR") or os.environ.get("FOOZOL_DIR") or os.path.join(os.path.expanduser("~"), ".pane")


def get_pane_daemon_endpoint(app_directory: str, platform: str = sys.platform) -> Dict[str, str]:
    resolved_app_directory = resolve_app_directory(app_directory, platform)
    if platform.startswith("win"):
        return {
            "transport": "pipe",
            "path": get_windows_pipe_name(resolved_app_directory),
        }

    return {
        "transport": "unix",
        "path": posixpath.join(get_unix_socket_directory_name(resolved_app_directory), DAEMON_SOCKET_FILENAME),
    }


def invoke_daemon(
    channel: str,
    args: Optional[List[Any]] = None,
    pane_dir: Optional[str] = None,
    timeout_ms: Optional[float] = None,
) -> Any:
    endpoint = get_pane_daemon_endpoint(resolve_pane_directory(pane_dir))
    request = {
        "type": "request",
        "id": 1,
        "channel": channel,
        "args": args or [],
    }
    encoded = encode_frame(request)

    if endpoint["transport"] == "pipe":
        return invoke_windows_pipe(endpoint["path"], encoded, timeout_ms or DEFAULT_TIMEOUT_MS)
    return invoke_unix_socket(endpoint["path"], encoded, timeout_ms or DEFAULT_TIMEOUT_MS)


def invoke_unix_socket(socket_path: str, encoded_request: bytes, timeout_ms: float) -> Any:
    decoder = PaneDaemonFrameDecoder()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout_ms / 1000)
        try:
            client.connect(socket_path)
        except OSError as error:
            raise PaneDaemonClientError(f"Could not connect to Pane daemon at {socket_path}: {error}") from error

        client.sendall(encoded_request)
        while True:
            chunk = client.recv(65536)
            if not chunk:
                raise PaneDaemonClientError(
                    f"Pane daemon closed the connection before responding at {socket_path}",
                    "ERR_RUNPANE_DAEMON_CLOSED",
                )
            response = first_matching_response(decoder.push(chunk))
            if response is not None:
                return response


def invoke_windows_pipe(pipe_path: str, encoded_request: bytes, timeout_ms: float) -> Any:
    decoder = PaneDaemonFrameDecoder()
    try:
        with open(pipe_path, "r+b", buffering=0) as pipe:
            pipe.write(encoded_request)
            while True:
                chunk = pipe.read(65536)
                if not chunk:
                    raise PaneDaemonClientError(
                        f"Pane daemon closed the connection before responding at {pipe_path}",
                        "ERR_RUNPANE_DAEMON_CLOSED",
                    )
                response = first_matching_response(decoder.push(chunk))
                if response is not None:
                    return response
    except OSError as error:
        raise PaneDaemonClientError(f"Could not connect to Pane daemon at {pipe_path}: {error}") from error


def first_matching_response(frames: List[Dict[str, Any]]) -> Optional[Any]:
    for frame in frames:
        if frame.get("type") != "response" or frame.get("id") != 1:
            continue
        if frame.get("ok") is True:
            return frame.get("result")
        error = frame.get("error") or {}
        raise PaneDaemonClientError(error.get("message", "Pane daemon request failed"), error.get("code"))
    return None


def resolve_app_directory(app_directory: str, platform: str) -> str:
    if platform.startswith("win"):
        return ntpath.abspath(app_directory)
    return posixpath.abspath(app_directory)


def get_windows_pipe_name(app_directory: str) -> str:
    digest = hashlib.sha256(app_directory.lower().encode("utf-8")).hexdigest()[:16]
    return "\\\\.\\pipe\\pane-daemon-" + digest


def get_unix_socket_directory_name(app_directory: str) -> str:
    digest = hashlib.sha256(app_directory.encode("utf-8")).hexdigest()[:16]
    uid_suffix = f"-{os.getuid()}" if hasattr(os, "getuid") else ""
    return posixpath.join(UNIX_SOCKET_BASE_DIRECTORY, f"pane-daemon{uid_suffix}-{digest}")


def encode_frame(frame: Dict[str, Any]) -> bytes:
    return json.dumps(frame, separators=(",", ":")).encode("utf-8") + FRAME_DELIMITER


class PaneDaemonFrameDecoder:
    def __init__(self) -> None:
        self.buffer = b""

    def push(self, chunk: bytes) -> List[Dict[str, Any]]:
        self.buffer += chunk
        frames: List[Dict[str, Any]] = []
        while FRAME_DELIMITER in self.buffer:
            raw_frame, self.buffer = self.buffer.split(FRAME_DELIMITER, 1)
            if raw_frame.strip():
                frames.append(json.loads(raw_frame.decode("utf-8")))
        return frames
