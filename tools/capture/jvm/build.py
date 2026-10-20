#!/usr/bin/env python3
"""Build a local, removable JVM capture overlay. Never invoked by the indexer."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
EXCLUDED = {".git", "node_modules", "build", "target", ".gradle", ".idea"}


def tool(name):
    found = shutil.which(name)
    if not found:
        raise RuntimeError("Install a local JDK 17+ and put %s on PATH" % name)
    return found


def run(args):
    return subprocess.run([str(a) for a in args], check=True, capture_output=True, text=True)


def build_agent(output):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    jars = sorted((HERE / "vendor").glob("asm*.jar"))
    notices = json.loads((HERE / "vendor/NOTICE.json").read_text())
    for jar in jars:
        if hashlib.sha256(jar.read_bytes()).hexdigest() != notices["artifacts"][jar.name]:
            raise RuntimeError("ASM artifact hash mismatch")
    if len(jars) != 3:
        raise RuntimeError("The three pinned ASM artifacts are required")
    cp = os.pathsep.join(map(str, jars))
    with tempfile.TemporaryDirectory(prefix="cbm-jvm-agent-") as temporary:
        temp = Path(temporary)
        classes = temp / "classes"
        classes.mkdir()
        run([tool("javac"), "--release", "17", "-cp", cp, "-d", classes,
             *sorted((HERE / "src").rglob("*.java"))])
        # Relocate ASM so the agent cannot shadow the application's ASM version.
        shade = temp / "Shade.java"
        shade.write_text('''import java.nio.file.*; import java.util.*; import java.util.jar.*;
import org.objectweb.asm.*; import org.objectweb.asm.commons.*;
public class Shade {
 public static void main(String[] args) throws Exception {
  var manifest = new Manifest(); manifest.getMainAttributes().putValue("Manifest-Version","1.0");
  manifest.getMainAttributes().putValue("Premain-Class","cbm.capture.Agent");
  var seen = new HashSet<String>();
  var remapper = new Remapper(Opcodes.ASM9) { public String map(String n) {
   return n.startsWith("org/objectweb/asm/") ? "cbm/capture/asm/"+n.substring(18) : n;
  }};
  try (var out = new JarOutputStream(Files.newOutputStream(Path.of(args[0])),manifest)) {
   for (int i=1;i<args.length;i++) try(var input=new JarInputStream(Files.newInputStream(Path.of(args[i])))) {
    JarEntry e; while((e=input.getNextJarEntry())!=null) {
     if(!e.getName().endsWith(".class") || e.getName().equals("module-info.class")) continue;
     byte[] bytes=input.readAllBytes(); var reader=new ClassReader(bytes); var writer=new ClassWriter(0);
     reader.accept(new ClassRemapper(writer,remapper),0);
     String name=remapper.map(reader.getClassName())+".class"; if(!seen.add(name))continue;
     var entry=new JarEntry(name); entry.setTime(0); out.putNextEntry(entry);out.write(writer.toByteArray());out.closeEntry();
    }
   }
  }
 }
}''')
        run([tool("javac"), "--release", "17", "-cp", cp, "-d", temp, shade])
        own = temp / "own.jar"
        with zipfile.ZipFile(own, "w") as archive:
            for path in sorted(classes.rglob("*.class")):
                archive.write(path, path.relative_to(classes).as_posix())
        destination = output / "cbm-capture-agent.jar"
        run([tool("java"), "-cp", str(temp) + os.pathsep + cp, "Shade", destination, own, *jars])
        with zipfile.ZipFile(destination, "a") as archive:
            archive.write(HERE / "vendor/ASM-LICENSE.txt", "META-INF/ASM-LICENSE.txt")
            archive.write(HERE / "vendor/NOTICE.json", "META-INF/ASM-NOTICE.json")
    return destination


def class_source(data):
    """Read only class name and SourceFile; never load/execute application code."""
    if data[:4] != b"\xca\xfe\xba\xbe":
        raise ValueError("Invalid class file")
    pos, count = 10, struct.unpack_from(">H", data, 8)[0]
    pool, index = {}, 1
    while index < count:
        tag = data[pos]
        pos += 1
        if tag == 1:
            size = struct.unpack_from(">H", data, pos)[0]
            pos += 2
            pool[index] = data[pos:pos + size].decode("utf-8", "replace")
            pos += size
        elif tag in (7, 8, 16, 19, 20):
            pool[index] = struct.unpack_from(">H", data, pos)[0]
            pos += 2
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):
            pos += 4
        elif tag in (5, 6):
            pos += 8
            index += 1
        elif tag == 15:
            pos += 3
        else:
            raise ValueError("Unsupported class constant")
        index += 1
    name = pool[pool[struct.unpack_from(">H", data, pos + 2)[0]]]
    pos += 6
    interfaces = struct.unpack_from(">H", data, pos)[0]
    pos += 2 + interfaces * 2
    for _ in range(2):  # fields, methods
        members = struct.unpack_from(">H", data, pos)[0]
        pos += 2
        for _ in range(members):
            attributes = struct.unpack_from(">H", data, pos + 6)[0]
            pos += 8
            for _ in range(attributes):
                length = struct.unpack_from(">I", data, pos + 2)[0]
                pos += 6 + length
    attributes = struct.unpack_from(">H", data, pos)[0]
    pos += 2
    source = None
    for _ in range(attributes):
        attr, length = struct.unpack_from(">HI", data, pos)
        pos += 6
        if pool[attr] == "SourceFile":
            source = pool[struct.unpack_from(">H", data, pos)[0]]
        pos += length
    return name, source


def kotlin_classpath():
    # Explicit local compiler directory; this tool never fetches a toolchain.
    supplied = os.environ.get("CBM_KOTLIN_LIB")
    if not supplied:
        raise RuntimeError("Set CBM_KOTLIN_LIB to a local Kotlin compiler library directory")
    lib = Path(supplied).resolve(strict=True)
    compilers = list(lib.glob("kotlin-compiler*.jar"))
    stdlibs = list(lib.glob("kotlin-stdlib-[0-9]*.jar"))
    if not compilers or not stdlibs:
        raise RuntimeError("Local Kotlin compiler and stdlib jars are required")
    return lib, sorted(stdlibs)[-1]


def build_overlay(root, output, language="java", classpath=""):
    root, output = Path(root).resolve(strict=True), Path(output).resolve()
    if output == root or root in output.parents:
        raise ValueError("The build overlay must be outside the project")
    output.mkdir(parents=True, exist_ok=True)
    frozen, classes = output / "source", output / "classes"
    if frozen.exists() or classes.exists():
        raise ValueError("Use a new overlay; existing source or class output cannot be reused")
    frozen.mkdir()
    classes.mkdir()
    suffix = ".kt" if language == "kotlin" else ".java"
    sources, by_name, total = [], {}, 0
    for directory, children, files in os.walk(root, followlinks=False):
        children[:] = sorted(c for c in children if c not in EXCLUDED and not (Path(directory) / c).is_symlink())
        for filename in sorted(files):
            path = Path(directory) / filename
            if path.suffix != suffix or path.is_symlink():
                continue
            with path.open("rb") as stream:
                raw = stream.read(4 * 1024 * 1024 + 1)
            total += len(raw)
            if len(raw) > 4 * 1024 * 1024 or total > 32 * 1024 * 1024 or len(sources) >= 512:
                raise ValueError("JVM overlay source budget exceeded")
            relative = path.relative_to(root)
            copied = frozen / relative
            copied.parent.mkdir(parents=True, exist_ok=True)
            copied.write_bytes(raw)
            record = (relative.as_posix(), hashlib.sha256(raw).hexdigest())
            by_name.setdefault(filename, []).append(record)
            sources.append(copied)
    if not sources:
        raise ValueError("No eligible local source files")
    runtime_cp = str(classes)
    if language == "java":
        command = [tool("javac"), "-g", "-parameters", "-proc:none", "-d", classes]
        if classpath:
            command += ["-classpath", classpath]
        run(command + sources)
    else:
        lib, stdlib = kotlin_classpath()
        cp = str(stdlib) + (os.pathsep + classpath if classpath else "")
        run([tool("java"), "-cp", str(lib / "*"), "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
             "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-java-parameters",
             "-classpath", cp, "-d", classes, *sources])
        runtime_cp += os.pathsep + str(stdlib)
    if classpath:
        runtime_cp += os.pathsep + classpath
    b64 = lambda value: base64.b64encode(value.encode()).decode()
    rows = ["CBM-JVM-1\t" + b64(str(root))]
    gaps = []
    for path in sorted(classes.rglob("*.class")):
        raw = path.read_bytes()
        name, source = class_source(raw)
        matches = by_name.get(source, [])
        if len(matches) != 1:
            gaps.append({"class": name, "reason": "SourceFile mapping is absent or ambiguous"})
            continue
        relative, digest = matches[0]
        rows.append("\t".join([name, hashlib.sha256(raw).hexdigest(), b64(relative), digest, language]))
    manifest = output / "sources.cbm"
    manifest.write_text("\n".join(rows) + "\n")
    result = {"classes": str(classes), "classpath": runtime_cp, "manifest": str(manifest),
              "source_count": len(sources), "coverage_gaps": gaps}
    (output / "overlay.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--root")
    parser.add_argument("--language", choices=("java", "kotlin"), default="java")
    parser.add_argument("--classpath", default="")
    options = parser.parse_args()
    result = {"agent": str(build_agent(options.output))}
    if options.root:
        result.update(build_overlay(options.root, options.output, options.language, options.classpath))
    print(json.dumps(result, indent=2))
