#!/usr/bin/env python3
"""Manually launch a development binary; forward bounded local scalar events."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
from urllib.parse import urlsplit, urlunsplit, parse_qs
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from urllib.error import HTTPError
import ipaddress
import queue


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def settings(environment):
    fields = []
    if environment.get("CBM_CAPTURE_VALUES") == "1":
        raw = environment.get("CBM_CAPTURE_FIELDS", "[]")
        if len(raw) > 16384:
            raise ValueError("Preview allowlist exceeds its limit")
        fields = json.loads(raw)
        if not isinstance(fields, list) or len(fields) > 64 or any(
            not isinstance(field, str) or not field or len(field) > 200 or "*" in field
            or any(ord(character) < 32 for character in field) for field in fields
        ):
            raise ValueError("Preview fields must be bounded exact names")
    endpoint, token = environment.get("CBM_CAPTURE_ENDPOINT", ""), environment.get("CBM_CAPTURE_TOKEN", "")
    if not endpoint and not token:
        return "", "", fields
    parsed = urlsplit(endpoint)
    host = parsed.hostname
    if (parsed.scheme != "http" or parsed.path != "/v1/cbm/lineage" or parsed.username
            or parsed.password or parsed.fragment or not parse_qs(parsed.query).get("session")
            or not token or len(token) > 4096 or "\n" in token or "\r" in token):
        raise ValueError("Expected an explicit native loopback capture endpoint and token")
    if host == "localhost":
        parsed = parsed._replace(netloc="127.0.0.1:" + str(parsed.port or 80))
    elif not host or not ipaddress.ip_address(host).is_loopback:
        raise ValueError("Capture delivery is restricted to loopback")
    return urlunsplit(parsed), token, fields


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", help="Optional bounded local event output for adapter tests")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    command = options.command[1:] if options.command[:1] == ["--"] else options.command
    if not command:
        parser.error("Pass the already-built application after --")
    if os.name != "posix":
        parser.error("Native scalar probes currently require POSIX local sockets")
    endpoint, token, fields = settings(os.environ)
    if not endpoint and not options.events:
        parser.error("Set the capture session environment before explicitly launching the application")
    reader, writer = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
    # A short native program can finish before Python is next scheduled. Keep
    # that burst bounded in the kernel without blocking the target application.
    for endpoint_socket in (reader, writer):
        for option in (socket.SO_SNDBUF, socket.SO_RCVBUF):
            try:
                endpoint_socket.setsockopt(socket.SOL_SOCKET, option, 256 * 1024)
            except OSError:
                pass  # Sequence gaps still disclose dropped events.
    writer.setblocking(False)
    if hasattr(socket, "SO_NOSIGPIPE"):
        writer.setsockopt(socket.SOL_SOCKET, socket.SO_NOSIGPIPE, 1)
    reader.settimeout(.05)
    environment = dict(os.environ, CBM_NATIVE_FD=str(writer.fileno()),
                       CBM_NATIVE_FIELDS="\n".join(fields))
    records, pending = [], queue.Queue(maxsize=64)
    finished = threading.Event()
    producer = {"id": "native-" + secrets.token_hex(16), "language": "native"}
    delivery_failed = threading.Event()
    delivery_reason = []

    def deliver():
        opener = build_opener(ProxyHandler({}), NoRedirect())
        while True:
            batch = pending.get()
            if batch is None:
                return
            if not endpoint or delivery_failed.is_set():
                continue
            payload = json.dumps({"schema_version": 1, "producer": producer, "events": batch}).encode()
            request = Request(endpoint, data=payload, headers={
                "Content-Type": "application/json", "Authorization": "Bearer " + token})
            try:
                with opener.open(request, timeout=.3) as response:
                    if response.status // 100 != 2:
                        delivery_failed.set()
            except HTTPError as error:
                delivery_reason.append("HTTP " + str(error.code) + ": " + error.read(2048).decode(errors="replace"))
                delivery_failed.set()
            except Exception as error:
                delivery_reason.append(type(error).__name__)
                delivery_failed.set()

    def receive():
        batch = []
        received_bytes = 0
        while True:
            try:
                packet = reader.recv(8193)
            except socket.timeout:
                if batch:
                    try:
                        pending.put_nowait(batch)
                    except queue.Full:
                        delivery_failed.set()
                    batch = []
                if finished.is_set():
                    break
                continue
            except ConnectionResetError:
                break  # A very short-lived datagram peer can close before wait() completes.
            except OSError:
                if finished.is_set():
                    break
                raise
            if len(records) >= 10000 or received_bytes + len(packet) > 32 * 1024 * 1024:
                continue
            received_bytes += len(packet)
            try:
                event = json.loads(packet)
            except (ValueError, UnicodeError):
                continue
            if not isinstance(event, dict):
                continue
            records.append(event)
            batch.append(event)
            if len(batch) == 128:
                try:
                    pending.put_nowait(batch)
                except queue.Full:
                    delivery_failed.set()
                batch = []
        if batch:
            try:
                pending.put_nowait(batch)
            except queue.Full:
                delivery_failed.set()

    sender = threading.Thread(target=deliver, daemon=True)
    receiver = threading.Thread(target=receive, daemon=True)
    sender.start()
    receiver.start()
    try:
        process = subprocess.Popen(command, env=environment, pass_fds=(writer.fileno(),))
        writer.close()
        result = process.wait()
    finally:
        finished.set()
        receiver.join(timeout=1)
        reader.close()
        writer.close()
        try:
            pending.put_nowait(None)
        except queue.Full:
            delivery_failed.set()
        sender.join(timeout=1)
    if options.events:
        destination = Path(options.events)
        with destination.open("x") as target:
            json.dump(records, target)
    if endpoint and (delivery_failed.is_set() or sender.is_alive()):
        print("Native capture delivery was incomplete; original program execution has finished."
              + (" " + delivery_reason[0] if delivery_reason else ""), file=sys.stderr)
    return result if result >= 0 else 128 - result


if __name__ == "__main__":
    sys.exit(main())
