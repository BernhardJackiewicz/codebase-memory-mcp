# Local development capture adapters

Adapters send explicit observations to the local CBM receiver. They do not start
when a session is created: launch your development application manually. Use only
test workloads. Original sources remain unchanged. Stop/delete the session in
Lens to stop accepting observations; remove the adapter from the next launch to
remove instrumentation.

The download manifest lists the adapter profiles included in this build. A
profile in the receiver alone does not mean an automatic adapter is available.

## Session configuration

Set `CBM_CAPTURE_ENDPOINT` to the absolute **Lineage receiver** URL shown in Lens.
Set `CBM_CAPTURE_TOKEN` to the newly created session token in your process's
environment. Keep it out of source files, command arguments and saved logs. Both
are required. Adapters accept only an explicit local HTTP receiver and never use
an external collector.

Values are off by default. To enable previews for test fields, opt in when
creating the Lens session, then set `CBM_CAPTURE_VALUES=1` and
`CBM_CAPTURE_FIELDS='["email"]'` with the same exact allowlist. Both receiver and
adapter enforce the allowlist. Only bounded builtin primitives are eligible;
no object dumps or getter calls are performed for previews.

## Python 3.9+

Extract the Python archive into a temporary directory. Run:

```sh
python3 /path/to/adapter/cbm_capture_python.py \
  --root /path/to/project --script /path/to/project/app.py -- application-arguments
```

Or replace `--script ...` with `--module your_package`. The import loader only
instruments Python sources inside `--root`, excludes virtual environments and
installed dependencies, rejects symlink escapes, and does not write `.pyc`
files for instrumented modules. It has a 4 MiB per-source limit.

Supported observations include scalar parameters, reads, copies, arithmetic
transformations, overwrites and returns. Direct, actually instrumented Python
function calls bind arguments and returns by code identity and invocation.
Names or equal runtime values never establish a link. Each invocation has its own
binding versions, including recursive calls. Calls invalidate earlier caller
binding assumptions while retaining independently observed return transport.
Assignments publish a binding version after the actual store only when the
overwritten name was unbound or held an exact builtin scalar. Possible object
finalization invalidates bindings before and after the store; an explicitly
labelled assignment-RHS observation does not prove the destination retained it.
Module annotation evaluation also remains a boundary. Old objects are never
kept alive across the store, and matching values do not establish provenance.
Iterator and context-manager entry/exit invalidate bindings on empty iterations,
exhaustion, normal completion and exceptions; loop `else` and `finally` start
after invalidation. Accessors and lifecycle methods are never replayed.
Other calls, heap/accessor reads,
comprehensions, dynamic scope, suspended caller transport and unsupported writes
are explicit coverage gaps. Modules referencing `eval`, `exec`, `locals`,
`globals`, `vars`, or frame introspection execute without probes. Qualified
reflective attributes, literal reflective `getattr`, and explicit `builtins`
imports (including aliases) conservatively disable probing for the whole module;
the gap is
reported outside their unchanged namespace. Functions using `global` or
`nonlocal` remain unmodified.

The runtime records at most 10,000 events and uses bounded asynchronous delivery.
A slow/unavailable receiver can leave gaps. Instrumentation adds execution cost
and frames; it is a development diagnostic, not a production launch setting.

## JavaScript / TypeScript: Node 20.6+ native ESM

Extract the JavaScript archive into a temporary directory. It includes the
TypeScript compiler and its licenses; no package install or provider download is
needed. Set the session configuration above and run:

```sh
export CBM_CAPTURE_ROOT='/absolute/path/to/project'
node --import "/absolute/path/to/adapter/register.mjs" "$CBM_CAPTURE_ROOT/app.mjs"
```

Replace the entry path with your ESM `.mjs`, module `.js`, `.ts` or `.mts` entry.
The loader transforms only real files inside the chosen root, excludes
dependencies and adapter files, and applies a 4 MiB per-source limit. It does not
rewrite source, create build output or instrument CommonJS modules.

Simple synchronous function declarations and assigned function expressions/
arrows record actual parameters, scalar reads/copies, arithmetic transformations
and returns. Direct calls use the actual registered function object's identity,
not a symbol name or equal value. Block shadowing and invocations have separate
identities. Caller binding versions are conservatively invalidated after calls
because callbacks may change captured variables. Getter reads execute once and
record the field result, with an explicit gap for prior heap provenance.
Async/generator transport, default/destructured parameters, closures outside the
current binding scope, dynamic calls, classes, loops and unsupported control
statements are coverage gaps. Instrumentation changes stack traces and adds
runtime overhead; do not use it for production execution or reflective code.

## JavaScript / TypeScript: local browser ESM overlay

Start a browser capture session allowing exactly `http://127.0.0.1:4319`.
Set the session environment above and run:

```sh
export CBM_CAPTURE_ROOT='/absolute/path/to/project'
export CBM_CAPTURE_BROWSER_PORT=4319
node "/absolute/path/to/adapter/browser.mjs"
```

Open `http://127.0.0.1:4319` yourself. The overlay serves the project's existing
`index.html` and transforms native ES modules in memory. Each transformed module
depends on the session bootstrap before running. Original files remain
unchanged; stop the overlay and return to the usual launch to remove probes.
The receiver must allow that exact origin, including its port. The server rejects
foreign origins, hosts and source symlink escapes and does not serve hidden paths.
The session token exists in the local in-memory bootstrap; use only your own
development page and test workload.

This is a native ESM overlay, not a Vite/webpack/React build pipeline or general
bundler integration. Bare dependency specifiers and framework transforms require
their own reversible build adapter. Source hashes refer to original files.
Raw values remain off unless both the adapter and receiver allow the exact field.
At most 10,000 events are recorded; failed delivery disables further submission,
and page closure can lose the final in-flight batch.

## .NET C# source overlay (.NET 10 SDK)

The adapter uses Roslyn bundled with an existing .NET 10 SDK. It has no NuGet
dependencies and ships a NuGet configuration with remote sources disabled.
Extract the archive into a temporary directory, then build the tool there:

```sh
dotnet build /path/to/adapter/CaptureTool.csproj
dotnet /path/to/adapter/bin/Debug/net10.0/CaptureTool.dll \
  --root /path/to/project --out /path/to/new-temporary-overlay
```

Set the session environment above, then start the copied project manually with
`dotnet run --project /path/to/new-temporary-overlay/YourProject.csproj`.
Return to your original project for normal development. Only the new overlay is
written; no application is launched by the overlay generator. The copy is bounded
to 2,000 files / 64 MiB, excludes generated directories and symlinks, and records
original source hashes.

Regular methods and synchronous top-level statements observe scalar parameters,
reads, copies, arithmetic transformations and returns with separate invocation
and binding versions. Static property reads observe the actual result once, with
an explicit gap for prior object state. This initial adapter is intraprocedural:
call argument/return transport, async/iterator bodies, references, closures,
overloaded operators and unsupported expressions are reported as gaps.
External project references or custom build generators may require their normal
local build environment. Execution adds probe overhead and changes stack/source
positions; it is a development diagnostic.

## Building and testing

`node tools/capture/package.mjs` creates deterministic download ZIPs from a
curated source list and includes licenses. It never installs or downloads
packages. `node --test tools/capture/package.test.mjs` verifies the archive with
an independent unzip implementation.

Run Python semantic tests with:

```sh
python3 -m unittest discover -s tools/capture/python -p 'test_*.py'
```

Run the JS/TS runtime, compiler-overlay and actual Node-loader tests with:

```sh
node --test tools/capture/javascript/*.test.mjs
```

Run isolated native receiver acceptance with:

```sh
python3 tools/capture/python/verify_native.py \
  --binary build/c/codebase-memory-mcp --out /tmp/cbm-python-native-evidence
```

This uses a copied fixture and separate cache/runtime namespace. It preserves
`HOME`, checks actual source hashes and previews, and stops its own processes.
