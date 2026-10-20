# Go development overlay

This adapter generates a temporary Go build overlay. It never edits the project,
its `go.mod`, or installed modules. The generator uses only Go's standard library
and does not run the application or download dependencies.

From the extracted adapter directory:

```sh
go run . --root /absolute/project --out /absolute/empty-temporary-directory
```

The output directory must be outside the project. The command prints the absolute
path of `overlay.json`. After creating a Go session in Lens, set
`CBM_CAPTURE_ENDPOINT` and `CBM_CAPTURE_TOKEN` in the application environment, then
start the application yourself:

```sh
cd /absolute/project
go run -overlay /absolute/temporary-directory/overlay.json .
```

`go build -overlay /absolute/temporary-directory/overlay.json ./...` is also
supported. Remove `-overlay` on the next build to remove the probes. Stop or
delete the Lens session to stop accepting observations.

Values are disabled by default. Test previews require both the Lens session's
exact field allowlist and `CBM_CAPTURE_VALUES=1` with
`CBM_CAPTURE_FIELDS='["Email"]'`. Only bounded builtin primitive values can appear
as previews. Named types, object serialization and String methods are excluded.

The adapter records scalar parameter/read/write/transform/return occurrences
using AST declaration identities and a separate binding map for each invocation.
Actual scalar struct-field reads become independent observations. Original source
hashes and line locations accompany every event. Contextual constants and named
scalar types retain their original Go type.

Calls do not establish argument/return links between invocations. Go caller and
goroutine correlation is an explicit gap. Unsupported statements, loop control,
heap state, closures, address-taking, generics, deferred/named returns and
non-scalar shapes run with conservative gaps. No pointer identity, equal-value
matching, goroutine-ID parsing or thread-local caller stack is used.

Coverage is limited to 512 local non-generated `.go` files, 32 MiB total,
4 MiB per file, 8,192 directory entries and a five-second discovery window.
Tests, vendor directories, hidden directories and symlinks are excluded.
`coverage.json` lists skipped sources. Type information that cannot be established
locally leaves the corresponding expression uninstrumented. Runtime delivery is
bounded to 10,000 events per package producer, a fixed queue, and a one-second
main-function flush. Delivery failure or process termination can leave gaps.

Run `go test ./...` in this directory for actual application/output, typing,
scope, overwrite, field-preview, panic/recover and concurrency checks.
`verify_native.py --binary /path/to/codebase-memory-mcp --out /tmp/evidence`
checks both preview modes against an isolated real native receiver and verifies
the source-evidence response.
