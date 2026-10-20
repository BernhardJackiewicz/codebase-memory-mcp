#!/usr/bin/env python3
"""Reversible Rust/Cargo AST overlays; parser builds and application builds are offline."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import queue
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
CRATES = {"syn": "2.0.15", "quote": "1.0.26", "proc-macro2": "1.0.56", "unicode-ident": "1.0.8"}
EXCLUDED = {".git", "target", "node_modules", ".venv"}
MAX_SOURCE = 4 * 1024 * 1024


def command(args, *, env=None, timeout=180, cwd=None):
    result = subprocess.run(args, env=env, cwd=cwd, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        # Compiler commands never receive the token, and compiler environments are scrubbed.
        raise RuntimeError("Local build failed:\n" + result.stderr[-6000:])
    return result.stdout


def parser_crates():
    paths = {}
    cargo = Path(os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")))
    for name, version in CRATES.items():
        bundled = HERE / "vendor" / (name + "-" + version)
        candidates = [bundled] if bundled.is_dir() else sorted((cargo / "registry/src").glob("*/" + name + "-" + version))
        if not candidates:
            raise RuntimeError("Offline parser source is missing: %s-%s. No packages were downloaded." % (name, version))
        paths[name] = candidates[0].resolve(strict=True)
    return paths


def build_parser(work, env):
    build = work / "parser"
    build.mkdir()
    manifest = (HERE / "Cargo.toml").read_text()
    for name, path in parser_crates().items():
        manifest += '%s = { path = %s }\n' % (name, json.dumps(str(path)))
    (build / "Cargo.toml").write_text(manifest)
    shutil.copy2(HERE / "instrument.rs", build / "instrument.rs")
    command(["cargo", "build", "--offline", "--quiet", "--manifest-path", str(build / "Cargo.toml"),
             "--target-dir", str(work / "parser-target")], env=env, cwd=build)
    return work / "parser-target/debug/cbm-rust-overlay"


def copy_project(root, overlay):
    count = 0
    total = 0
    for source in root.rglob("*"):
        relative = source.relative_to(root)
        if EXCLUDED.intersection(relative.parts):
            continue
        if source.is_symlink():
            raise RuntimeError("Capture overlay rejects project symlinks: " + str(relative))
        target = overlay / relative
        if source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif source.is_file():
            count += 1
            total += source.stat().st_size
            if count > 10000 or total > 64 * 1024 * 1024:
                raise RuntimeError("Capture overlay exceeds 10,000 files or 64 MiB.")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)


class Relay:
    def __init__(self, work, endpoint, token, values, fields):
        parsed = urlsplit(endpoint)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.username or parsed.password or parsed.fragment or parsed.path != "/v1/cbm/lineage" or not parsed.query:
            raise ValueError("An explicit loopback HTTP lineage receiver is required")
        if not token or "\r" in token or "\n" in token:
            raise ValueError("A session token is required")
        if not isinstance(fields, list) or len(fields) > 64 or any(type(field) is not str or not field or len(field.encode()) > 200 or "*" in field or any(ord(c) < 32 for c in field) for field in fields):
            raise ValueError("Use at most 64 exact test field paths")
        self.parsed, self.token, self.values, self.fields = parsed, token, values, set(fields)
        self.path = str(work / "events.sock")
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(self.path)
        self.listener.listen(8)
        self.listener.settimeout(.1)
        self.closed = threading.Event()
        self.queue = queue.Queue(maxsize=10000)
        self.clients = []
        self.failed = False
        self.acceptor = threading.Thread(target=self.accept, daemon=True)
        self.sender = threading.Thread(target=self.send, daemon=True)
        self.acceptor.start()
        self.sender.start()

    def accept(self):
        while not self.closed.is_set():
            try:
                connection, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            thread = threading.Thread(target=self.read, args=(connection,), daemon=True)
            self.clients.append(thread)
            thread.start()

    def read(self, connection):
        try:
            connection.settimeout(2)
            stream = connection.makefile("rb")
            while True:
                line = stream.readline(16385)
                if not line:
                    break
                if len(line) > 16384:
                    self.failed = True
                    break
                packet = json.loads(line)
                event = packet["event"]
                if not self.values or event.get("access_path") not in self.fields:
                    event.pop("preview", None)
                try:
                    self.queue.put_nowait(packet)
                except queue.Full:
                    self.failed = True
                    break
        except (OSError, ValueError, KeyError):
            self.failed = True
        finally:
            connection.close()

    def send(self):
        while True:
            packet = self.queue.get()
            if packet is None:
                self.queue.task_done()
                break
            if not self.failed:
                connection = http.client.HTTPConnection(self.parsed.hostname, self.parsed.port, timeout=3)
                try:
                    body = json.dumps({"schema_version": 1, "producer": {"id": packet["producer"], "language": "rust"}, "events": [packet["event"]]})
                    connection.request("POST", self.parsed.path + "?" + self.parsed.query, body,
                                       {"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
                    response = connection.getresponse()
                    response.read()
                    if not 200 <= response.status < 300:
                        self.failed = True
                except OSError:
                    self.failed = True
                finally:
                    connection.close()
            self.queue.task_done()

    def close(self):
        self.closed.set()
        self.listener.close()
        self.acceptor.join(timeout=2)
        for thread in self.clients:
            thread.join(timeout=3)
        self.queue.put(None)
        self.sender.join(timeout=8)
        if self.sender.is_alive():
            self.failed = True
        if self.failed:
            sys.stderr.write("Some local Rust capture observations were not delivered.\n")


def launch(args):
    root = Path(args.root).resolve(strict=True)
    # Build tools do not need receiver credentials or raw-value settings.
    build_env = {key: value for key, value in os.environ.items() if not key.startswith("CBM_CAPTURE_")}
    build_env["CARGO_NET_OFFLINE"] = "true"
    fields = json.loads(os.environ.get("CBM_CAPTURE_FIELDS", "[]"))
    values = os.environ.get("CBM_CAPTURE_VALUES") == "1"
    with tempfile.TemporaryDirectory(prefix="cbm-rs-", dir="/private/tmp" if Path("/private/tmp").is_dir() else None) as tmp:
        work = Path(tmp)
        relay = Relay(work, os.environ.get("CBM_CAPTURE_ENDPOINT", ""), os.environ.get("CBM_CAPTURE_TOKEN", ""), values, fields)
        try:
            transformer = build_parser(work, build_env)
            overlay = work / "project"
            overlay.mkdir()
            copy_project(root, overlay)
            crate_roots = []
            skip_files = set()
            skip_packages = set()
            if args.source:
                source = Path(args.source).resolve(strict=True)
                source.relative_to(root)
                crate_roots = [source.relative_to(root)]
            else:
                manifest = (root / args.manifest).resolve(strict=True)
                manifest.relative_to(root)
                copied_manifest = overlay / manifest.relative_to(root)
                metadata = json.loads(command(["cargo", "metadata", "--offline", "--no-deps", "--format-version", "1",
                    "--manifest-path", str(copied_manifest)], env=build_env, cwd=overlay))
                for package in metadata["packages"]:
                    package_root = Path(package["manifest_path"]).resolve().parent.relative_to(overlay)
                    if any("proc-macro" in target["kind"] for target in package["targets"]):
                        skip_packages.add(package_root)
                    for target in package["targets"]:
                        if any(kind in target["kind"] for kind in ["custom-build", "proc-macro"]):
                            skip_files.add(Path(target["src_path"]).resolve().relative_to(overlay))
                        if any(kind in target["kind"] for kind in ["bin", "lib", "rlib"]):
                            crate_roots.append(Path(target["src_path"]).resolve().relative_to(overlay))
                if not crate_roots:
                    raise RuntimeError("No local Rust binary/library targets were found.")
            helper = "__cbm_capture_" + secrets.token_hex(6)
            sources = sorted(path for path in overlay.rglob("*.rs") if "vendor" not in path.relative_to(overlay).parts
                             and path.relative_to(overlay) not in skip_files
                             and not any(package == path.relative_to(overlay) or package in path.relative_to(overlay).parents for package in skip_packages))
            for copied in sources:
                relative = copied.relative_to(overlay)
                # The private overlay is the frozen source snapshot. Hash and
                # transform it, never reopen a concurrently editable original.
                raw = copied.read_bytes()
                if len(raw) > MAX_SOURCE:
                    raise RuntimeError("Rust source exceeds 4 MiB: " + str(relative))
                digest = hashlib.sha256(raw).hexdigest()
                result = command([str(transformer), relative.as_posix(), digest, helper, str(copied)], env=build_env)
                copied.write_text(result)
            runtime_dir = work / "runtime"
            runtime_dir.mkdir()
            for index, entry in enumerate(dict.fromkeys(crate_roots)):
                runtime_file = runtime_dir / ("runtime%d.rs" % index)
                runtime_file.write_text((HERE / "runtime.rs").read_text().replace("__CBM_CRATE_ID__", entry.as_posix()))
                with (overlay / entry).open("a") as output:
                    output.write('\n#[allow(dead_code)] #[path=%s] mod %s;\n' % (json.dumps(str(runtime_file)), helper))
            runtime_env = {**build_env, "CBM_CAPTURE_VALUES": "1" if values else "0", "CBM_CAPTURE_RUST_SOCKET": relay.path,
                           "CBM_CAPTURE_RUST_FIELDS": "\n".join(fields), "CBM_CAPTURE_RUST_PRODUCER": "rust-" + secrets.token_hex(16)}
            # The application/relay receives the token only through the environment.
            if args.source:
                binary = work / "application"
                command(["rustc", "--edition=" + args.edition, str(overlay / crate_roots[0]), "-o", str(binary)],
                        env=build_env, cwd=overlay)
                if args.action == "build":
                    return 0
                launched = subprocess.run([str(binary), *args.arguments], env=runtime_env, cwd=root)
            else:
                cargo = ["cargo", "build", "--offline", "--message-format=json", "--manifest-path", str(copied_manifest),
                         "--target-dir", str(work / "application-target")]
                if args.bin:
                    cargo += ["--bin", args.bin]
                if args.features:
                    cargo += ["--features", args.features]
                built = command(cargo, env=build_env, cwd=overlay)
                if args.action == "build":
                    return 0
                artifacts = [json.loads(line) for line in built.splitlines() if line.startswith("{")]
                executables = [item["executable"] for item in artifacts if item.get("reason") == "compiler-artifact"
                               and item.get("executable") and "bin" in item.get("target", {}).get("kind", [])]
                if len(executables) != 1:
                    raise RuntimeError("Choose one Cargo binary with --bin before manual capture execution.")
                # Build scripts never receive credentials. Launch only the exact built
                # executable after compilation, with the original project's working dir.
                launched = subprocess.run([executables[0], *args.arguments], env=runtime_env, cwd=root)
            return launched.returncode
        finally:
            relay.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--source")
    source.add_argument("--manifest")
    parser.add_argument("--edition", default="2021", choices=["2018", "2021"])
    parser.add_argument("--action", choices=["run", "build"], default="run")
    parser.add_argument("--bin")
    parser.add_argument("--features")
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.arguments[:1] == ["--"]:
        args.arguments.pop(0)
    try:
        return launch(args)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        sys.stderr.write(str(error) + "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
