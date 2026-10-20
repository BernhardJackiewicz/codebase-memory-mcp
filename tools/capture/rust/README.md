# Rust local development capture

Requires macOS or Linux, Python 3.9+, and an existing Rust/Cargo 1.69+ installation.
The archive contains the pinned parser sources and their licenses. No parser,
toolchain or application dependency is downloaded; Cargo is always offline.

Create a Rust capture session in Lens first. Set the standard
`CBM_CAPTURE_ENDPOINT` and `CBM_CAPTURE_TOKEN` environment variables from that
session. Never put the token in source, command arguments or logs. Raw values
are off unless the session and adapter both explicitly opt in with
`CBM_CAPTURE_VALUES=1` and the same `CBM_CAPTURE_FIELDS` JSON allowlist.

Extract the adapter outside the project. Start a Cargo application manually:

```sh
python3 /absolute/path/to/adapter/cbm_capture_rust.py \
  --root /absolute/path/to/workspace --manifest Cargo.toml
```

For workspaces with several binaries, select one with `--bin application_name`.
Existing Cargo features can be selected with `--features feature_a,feature_b`.
Pass application arguments after `--`. All workspace members and local path
dependencies must be contained in `--root`; existing external registry
dependencies must already be cached for offline building.

For a standalone Rust source:

```sh
python3 /absolute/path/to/adapter/cbm_capture_rust.py \
  --root /absolute/path/to/project --source /absolute/path/to/project/app.rs
```

The launcher copies a bounded project into a private temporary directory,
transforms local `.rs` modules using the Rust AST, and compiles into a temporary
target directory. Original source, Cargo.lock and target artifacts remain
unchanged. Build scripts and procedural macro crates are left uninstrumented.
Compilers and build scripts do not receive capture credentials. The exact built
executable then runs with the original project as its working directory.
`--action build` only validates the temporary build; it does not start the app
or retain the temporary executable.

The runtime sends bounded JSON events through a private local Unix socket to
the launcher's HTTP relay. The receiver token stays in the relay; the Rust app
does not need it. Events and optional previews are not written to a spool file.
Each process and crate owns a producer namespace. Stop the session in Lens to
stop accepting events, delete it to remove recorded events, and launch normally
without this wrapper to remove instrumentation. The temporary overlay is
removed on exit.

Supported observations are compiler-checked primitive scalar parameters, local
reads/copies, arithmetic transformations, overwrite versions, block shadowing,
returns, and direct reads of known primitive fields of local structs.
Primitives include standard numeric types, booleans, characters and `&str`.
An observed field read has no invented edge to prior heap or ownership state.
The adapter never uses value equality or a callable's name to infer an edge.

Ownership moves, arbitrary borrows, owned `String`/collection/object values,
call argument/return transport, cross-crate transport, closures, macros,
generics, async/unsafe/const functions and unsupported control statements are
outside this version's value-flow coverage. Calls and unsupported statements
invalidate scalar versions and report gaps. Short-circuit expressions retain
their original evaluation and report the result without fabricated operand
links. Generic, async, unsafe and const function bodies remain uninstrumented.
This is a scoped diagnostic, not universal Rust instrumentation.

Functions containing unknown owned bindings, borrows, calls, method calls or
other unproven lifetime effects keep actual scalar observations but report a
function-wide gap and omit explicit input edges. Destructors can mutate other
bindings at scope exit, replacement or the end of a temporary's statement; the
adapter does not infer destructor behavior from type or callable names.
Functions restricted to proven primitive expressions retain copy, arithmetic
and return edges. Initializers with unproven temporaries stay intact, and scalar
locals are observed after their original declaration so Rust's temporary lifetime
extension is preserved.
The adapter never retains owner objects or adds a user-value lifetime guard.

The overlay changes compiler source positions, `file!`/`line!`/`column!`
observations, stack traces and compile-time paths such as `CARGO_MANIFEST_DIR`.
Source-location/reflection-sensitive code and macros need a dedicated build
adapter. Existing procedural macros and build scripts may generate code that
is not covered. No-std/embedded targets, FFI, GPU execution and cross-compilation
are outside this local scope. Some unsupported type-inference or macro cases
can reject the temporary build; the original project remains untouched.

Limits: 10,000 copied files, 64 MiB copied data, 4 MiB per Rust source and
10,000 runtime events per producer. Project symlinks are rejected; `.git`,
`target`, `node_modules` and `.venv` are excluded. Delivery failures are reported
without logging credentials. An aborted or slow process can leave coverage
gaps.

Run the original-versus-overlay tests:

```sh
python3 -m unittest discover -s tools/capture/rust -p 'test_*.py'
```

Native acceptance creates an isolated index, receiver and sessions:

```sh
python3 tools/capture/rust/verify_native.py \
  --binary build/c/codebase-memory-mcp --out /tmp/cbm-rust-native-evidence
```

`vendor/manifest.json` records the exact file checksums, package checksums,
versions and licenses of the four parser crates copied from the already
available local Cargo cache.
