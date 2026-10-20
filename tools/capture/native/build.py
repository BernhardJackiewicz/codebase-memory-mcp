#!/usr/bin/env python3
"""Explicitly compile a generated native development overlay; never run it."""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    options = parser.parse_args()
    manifest = Path(options.manifest).resolve(strict=True)
    if manifest.stat().st_size > 1024 * 1024:
        parser.error("Overlay manifest exceeds its limit")
    config = json.loads(manifest.read_text())
    if config.get("schema_version") != 1:
        parser.error("Unsupported overlay manifest")
    root = Path(config["root"]).resolve(strict=True)
    output = Path(options.output).resolve()
    if output == root or root in output.parents or output.exists():
        parser.error("Use a new output binary outside the original project")
    if not output.parent.is_dir():
        parser.error("Output parent directory must already exist")
    command = [config["compiler"], *config["semantic_flags"],
               *config["compile_arguments"], *config["sources"],
               config["runtime_source"], "-o", str(output)]
    return subprocess.run(command, cwd=root, check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
