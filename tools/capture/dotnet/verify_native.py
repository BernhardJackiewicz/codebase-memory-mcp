#!/usr/bin/env python3
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("native_acceptance", HERE.parent / "verify_native.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--dotnet", default=os.environ.get("CBM_TEST_DOTNET") or shutil.which("dotnet"))
    args = parser.parse_args()
    if not args.dotnet:
        parser.error("An existing .NET 10 SDK is required")
    source = '''using System;
class Program {
 static string Flow(string email) {
   string copied = email;
   string output = copied + ".test";
   return output;
 }
 static void Main() { Console.WriteLine(Flow("sample@example")); }
}
'''
    def prepare(root, project, env):
        work = root / "tool"; work.mkdir()
        sdk_env = {**env, "DOTNET_CLI_HOME": str(root / "cli"), "NUGET_PACKAGES": str(root / "nuget"),
                   "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1", "DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1"}
        for name in ("CaptureTool.csproj", "Program.cs", "Runtime.cs", "NuGet.Config"):
            shutil.copy2(HERE / name, work / name)
        def run(command):
            result = subprocess.run(command, env=sdk_env, text=True, capture_output=True, timeout=120)
            assert result.returncode == 0, result.stdout + result.stderr
        run([args.dotnet, "build", str(work / "CaptureTool.csproj"), "-v:q"])
        overlay = root / "overlay"
        run([args.dotnet, str(work / "bin/Debug/net10.0/CaptureTool.dll"), "--root", str(project), "--out", str(overlay)])
        run([args.dotnet, "build", str(overlay / "App.csproj"), "-v:q"])
        return overlay, sdk_env
    def launch(prepared, project, env):
        overlay, sdk_env = prepared
        return [args.dotnet, str(overlay / "bin/Debug/net10.0/App.dll")], {**sdk_env, **env}, str(overlay)
    native.verify(binary=args.binary, output=args.out, profile="dotnet", files={
        "Program.cs": source,
        "App.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><NuGetAudit>false</NuGetAudit></PropertyGroup></Project>',
        "NuGet.Config": (HERE / "NuGet.Config").read_text(),
    }, prepare=prepare, launch=launch, expected_stdout="sample@example.test\n", field="email", preview="sample@example",
       source_file="Program.cs", source_text="return output", minimum_events=10)

if __name__ == "__main__":
    main()
