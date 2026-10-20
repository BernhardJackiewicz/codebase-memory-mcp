# Java / Kotlin local JVM capture

This adapter compiles a copy of selected project sources outside the project and
uses a removable Java agent when you launch that copy. It does not start the
application, change original sources, install dependencies, or run from CBM's
indexer. Use a development workload with an existing local JDK 17 or newer.

Create a JVM capture session in Lens. Set the displayed `CBM_CAPTURE_ENDPOINT`
and `CBM_CAPTURE_TOKEN` in your application's environment. The receiver must be
an explicit loopback HTTP address. Tokens never belong in source or launch
arguments. Values remain disabled unless the session and
`CBM_CAPTURE_VALUES=1` both opt in; `CBM_CAPTURE_FIELDS='["input"]'` lists exact
parameter, local, or qualified field names.

Build the agent and a Java overlay:

```sh
python3 /path/to/adapter/build.py \
  --root /path/to/project --output /path/to/new-temporary-overlay
```

The command prints the agent, manifest, and classpath. Launch the copied
application yourself:

```sh
java -javaagent:/path/to/new-temporary-overlay/cbm-capture-agent.jar=/path/to/new-temporary-overlay/sources.cbm \
  -cp /path/to/new-temporary-overlay/classes your.package.Main
```

For Kotlin, point `CBM_KOTLIN_LIB` at an existing compiler library directory
containing `kotlin-compiler*.jar` and `kotlin-stdlib-<version>.jar`, and add
`--language kotlin`. Use the full `classpath` printed in the JSON, including the
local standard library. The adapter never fetches Kotlin. Java and Kotlin
sources are compiled separately; existing mixed-language build pipelines,
annotation processors (disabled in this overlay), framework bootstrapping, and generated sources may need
their own explicit local build configuration. `--classpath` accepts existing
local dependencies for compilation and execution. Those dependencies are not
automatically instrumented.

Remove `-javaagent` or return to the original application's launch to remove
instrumentation. Stop/delete the session in Lens to stop accepting observations.
The agent changes only loaded bytecode, never the class files on disk.

## Observed behavior

The agent tracks actual operand identities and local-slot writes for supported
method bodies. It records scalar parameters, reads, copies, overwrites,
arithmetic/conversions, and normal returns. Each thread and invocation owns its
frames. Exact instrumented static calls connect actual argument and return
ports by class-loader, method descriptor, and invocation identity. Matching names
or equal values never connect observations.

Supported final `java.lang.String` operations (`trim`, `strip`,
`stripLeading`, `stripTrailing`, zero-argument `toLowerCase`/`toUpperCase`,
integer `substring`, `concat(String)`, and `replace(char,char)`) produce explicit
derived transformations. Other external, virtual/interface, reflective,
native, and dynamic calls retain an explicit gap at their result boundary.
The callee's own instrumented body can still have independent observations.

Real field reads/writes are observed once. Previews inspect only builtin
primitives and strings; they never call application `equals`, `toString`, or
getters. A field read has no asserted link to a prior mutable heap version,
including concurrent writes. Arrays, constructors/class initializers,
Kotlin suspension, inline/multi-source debug mappings, legacy subroutines,
custom class loaders, and named modules are explicit coverage gaps.
Exception handlers clear pending call/operand state; an exceptional exit never
creates a normal-return link.

## Provenance and bounds

The temporary compiler consumes frozen copies of the original bytes.
Instrumentation requires the compiled class SHA-256, the current original
source SHA-256, a unique `SourceFile` mapping, and valid debug lines to match
the overlay manifest. Events carry the original relative path, raw-byte hash,
line, and method descriptor. Source hashes are checked independently by CBM.
The manifest contains paths/hashes, never the capture token.

Source selection excludes symlinks and generated/dependency directories and is
bounded to 512 sources, 4 MiB per file, and 32 MiB total. The agent bounds
method instruction count, invocation/operand depth, and the event stream to
10,000 observations. A bounded asynchronous queue flushes small batches while
the app runs. Delivery failures or shutdown can lose observations; capture
adds execution overhead and must not be used as a production launcher.

ASM 9.9 is included under its BSD-3-Clause license. `vendor/NOTICE.json` records
the exact artifact hashes and local provenance. The build verifies those hashes
and relocates ASM inside the agent so the application's ASM version is separate.

## Verification

```sh
CBM_KOTLIN_LIB=/path/to/local/compiler/lib \
  python3 -m unittest discover -s /path/to/adapter -p 'test_capture_jvm.py'

CBM_KOTLIN_LIB=/path/to/local/compiler/lib \
  python3 /path/to/adapter/verify_native.py \
    --binary /path/to/codebase-memory-mcp --out /tmp/cbm-jvm-evidence
```

These tests compile and execute real Java and Kotlin programs, compare normal
application output, verify lineage boundaries and side effects, and use
separate native cache/runtime directories. They preserve `HOME`.
