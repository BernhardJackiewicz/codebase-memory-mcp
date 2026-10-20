# C and C++ development capture

This adapter uses the installed Clang JSON AST and a temporary Clang VFS
overlay. It never edits the original project. Generating an overlay parses
source; building and running are separate, explicit commands. The indexer
does not start the application.

Requirements: Python 3, Clang, a POSIX development machine, and a local
capture session in Lens with the **C/C++** profile. This implementation is
tested with Apple Clang 17 on macOS. It does not provide GPU execution
capture, Windows injection, or a replacement for an application's build
system.

Choose an empty overlay directory **outside** the project. For example:

```sh
PROJECT=/absolute/path/to/project
ADAPTERS=/absolute/path/to/extracted/capture-adapters
OVERLAY="$(mktemp -d)"

python3 "$ADAPTERS/native/instrument.py" \
  --root "$PROJECT" --source main.cpp \
  --out "$OVERLAY" --compiler clang++ -- -std=c++17

python3 "$ADAPTERS/native/build.py" \
  --manifest "$OVERLAY/capture.json" --output "$OVERLAY/program"

# Set the session-specific environment shown by Lens, then launch explicitly:
python3 "$ADAPTERS/native/launch.py" -- "$OVERLAY/program"
```

For C, select `main.c`, use `--compiler clang`, and pass `-std=c11`. Repeat
`--source` for up to sixteen translation units. `-I`, `-D`, `-U`, system
include paths, language standard, and explicit target flags can follow `--`.
Run the application from its normal working directory if it uses relative
files. The build helper creates one development executable outside the
project. Projects requiring custom link steps can instead use the manifest's
`compile_arguments` and compile/link its `runtime_source` exactly once.

The launcher uses these environment variables:

- `CBM_CAPTURE_ENDPOINT`: the local session lineage URL shown by Lens.
- `CBM_CAPTURE_TOKEN`: that session's bearer token.
- `CBM_CAPTURE_VALUES=1`: optional preview opt-in; otherwise no values leave
  the instrumented program.
- `CBM_CAPTURE_FIELDS='["input"]'`: exact allowed integral/bool field names.
  Wildcards, object traversal, floating-point previews, pointers, and user
  serializers are unsupported. Integers outside JSON's exact integer range
  are omitted.

The explicit launcher owns HTTP delivery. The application emits bounded,
nonblocking local datagrams to an inherited socket. Delivery accepts loopback
HTTP only, disables proxies and redirects, and stops after a delivery failure.
Closing a session does not stop the application. Do not put the session token
in source, compile arguments, or a checked-in file.

## What the events prove

Clang declaration IDs distinguish local bindings and shadowed names. Each
actual invocation receives separate binding versions. Supported builtin
integral/bool parameters, reads, assignments, arithmetic, integral
conversions, returns, and simple scalar field reads emit actual occurrence
events. A field read starts independent evidence; it does not infer a heap
write or alias connection. Arithmetic itself still executes once using the
original language operators. Original source SHA-256, relative file path,
symbol, and line accompany every event.

Opaque calls and unsupported statements clear the caller's binding evidence.
No name/value matching or guessed caller, return, thread, network, or database
links are generated. Pointer/reference/volatile storage, floating-point
functions, complex object lifetimes, and unsupported controls execute with
explicit gaps. Loops execute unchanged and clear evidence on both sides.
Leaving a nested scope containing unmodeled automatic storage clears binding
evidence after the original destructors/cleanup have run. A later scalar write
inside that scope cannot carry stale provenance past object destruction.
Primitive-only scopes retain their normal transport; scalar return expressions
are observed before scope teardown, matching their original evaluation order.
Templates, constexpr/consteval, attributed functions, and visibly address-taken
callbacks remain unmodified; `capture.json` records these coverage gaps.
Methods, coroutine bodies, headers, and signal-handler instrumentation are
outside this adapter's coverage. Do not use it to instrument signal handlers
or allocation/runtime hooks. Fork children disable probes and need their own
explicit launch for separate capture.

Temporary instrumentation adds CPU, stack, and timing overhead. It is for
explicit development runs. It makes no coverage or timing guarantee for
production, undefined C/C++ behavior, external callbacks, or real-time code.

## Bounds and checks

Generation allows at most sixteen selected translation units, 4 MiB per
source, 32 MiB of selected source, and 64 MiB/20 seconds of AST output per
translation unit. Functions have bounded binding/occurrence tables. A producer
emits at most 10,000 events; kernel buffers, parent queues, and delivery
timeouts are bounded. Missing sequence numbers remain visible to the native
receiver.

The adapter tests compile and execute both original and overlaid C/C++
programs, compare output/exit behavior, and check original source bytes.
They cover overwrites, shadowing, integral conversions, exceptions, field
reads, loops, scope destructors, return evaluation order, exact preview opt-in,
fork isolation, and `__FILE__`/`__LINE__`.

```sh
cd tools/capture/native
python3 -m unittest -v test_native.py
```

`verify_native.py` additionally indexes isolated C/C++ fixture projects and
checks real native receiver events plus hash-bound source evidence:

```sh
python3 tools/capture/native/verify_native.py \
  --binary build/c/codebase-memory-mcp --out /tmp/cbm-native-evidence
```
