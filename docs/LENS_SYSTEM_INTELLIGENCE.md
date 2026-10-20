# Lens system evidence and local capture

This development work adds indexed documentation, a system graph projection,
a separate static field-flow IR, and an opt-in, memory-only runtime receiver.
These are separate evidence sources. A documentation reference is not a call;
a call is not proof that a particular value was transported; a trace span is
not a field-flow event.

## Documentation and system graph

The Docs workspace lists indexed Markdown, PDF text, diagrams, and ADRs.
The existing architecture decision editor is retained as a Docs subtab.
Relative documentation links stay inside indexed project documentation.
Code links open source evidence. PDF text comes from indexed sections rather
than treating a binary PDF as a text file. Missing, changed, or truncated
source is reported in the reader.
Selecting a Markdown section follows its indexed heading line, including when
headings have identical names. PDF sections and system graph PDF sources open
the extracted document at the recorded page, with the original index generation.
A PDF node without a recorded page opens the document without inventing a page
from its node line.

`GET /api/documents?project=...` supports `kind`, `query`, and `cursor`.
`GET /api/document?project=...&node_id=...&generation=...` reads one indexed
document and its recorded neighborhood. A relative indexed `file_path` may
replace `node_id`. Pagination and detail reads reject stale generations.
Relationships keep their recorded types, endpoints, and source evidence.
An exact relationship location is shown only when the edge records it. A
section's start line is not substituted for missing evidence. PDF text lines
are not page numbers. An explicit edge page takes priority; otherwise an
actual indexed page section can supply labeled source context, with
`position_kind: "source_context"`, rather than an exact relationship position.
PDF pages have separate numeric identities and plain extracted text, so page
navigation cannot be confused by Markdown-like headings in the source text.

`get_architecture` with `aspect: "system_graph"` provides entities,
relationships, witnesses, limits, and coverage for a named project and opaque
index generation. Lens uses that same model and identities in 3D and 2D.
Kind groups are display groups, not claims that their members share a service,
deployment, or runtime boundary. Filters and drilldown expose members and
recorded relationships without inventing cross-layer connections.

## Static field-flow boundary

`trace_field` reads the separate, versioned `cbm_flow_*` tables.
It accepts an explicit `value_id`, or a source selector containing
`file_path`, optional `symbol`, `access_path` (a string array), and
`start_byte`. A non-unique selector returns candidates rather than selecting
one occurrence arbitrarily. `expected_generation` pins the request to its
source snapshot.

The IR distinguishes lexical bindings, versioned values, static field paths,
operations, and typed links. Call/return traversal keeps a bounded call-site
stack. Control dependencies and unknown boundaries do not become proven
value transport. Derived transformations and possible branches retain their
evidence category. Replacing a file invalidates summaries that depend on its
body. Extraction coverage is reported separately from the existence of the
query API.

AST extraction covers supported scalar forms in JavaScript/TypeScript/TSX,
Python, Java/Kotlin, C#, Go, Rust, PHP, C/C++ and static CUDA sources.
This is not whole-language, whole-heap analysis. Dynamic dispatch, aliasing,
unsupported mutation/control forms and missing source remain explicit gaps.
Operators and truthiness retain reaching-value assumptions only when their
primitive semantics are established. Coercion, overloaded operators, implicit
conversion/copy, object lifetime effects, and unsupported reference aliases can
execute user code or mutate storage; the extractor exposes these boundaries
instead of treating their syntax as a pure read. A literal-shaped AST node is
not enough to establish a side-effect-free primitive value.
Cross-file argument/return links use the actual resolver result at the exact
call span and canonical declaration. A similarly named function or a legacy
`CALLS` edge is insufficient. Full and incremental indexing share the same
generation publication; dependency changes invalidate body summaries.

`CBM_FLOW_DEPENDENCIES` is an explicit comma-separated allowlist of at most
16 locally installed npm packages beneath the project `node_modules`.
Only existing regular sources are inspected: no package install, download or
application execution occurs. Selection is capped at 512 sources, 4 MiB each
and 32 MiB total. Package name/version, manifest hash and raw source hash are
recorded; package body, manifest and selection changes invalidate the flow
snapshot. For native JavaScript ESM callers, a named import (including an alias)
can bind to a direct exported function in the selected package. The resolver
requires an exact `exports` string/subpath or `main`/`index.js` path, an ESM body
(`.mjs`, or `.js` under `"type": "module"`), unshadowed immutable bindings and
compatible positional argument/return ports. Each cross-package edge carries
the exact import, invocation and declaration byte ranges, caller/callee hashes,
and package name/version/manifest identity. It does not manufacture graph nodes
or treat a `CALLS` edge as value transport.

Both full and incremental publication also fingerprint caller package scopes,
the absence of nearer `node_modules`, and nested dependency manifests. Adding
a resolution boundary therefore invalidates a previous binding even when the
app and function bodies are unchanged. Resolution inspects at most 512 caller
files and bounded ancestor metadata; a partial snapshot or changed environment
leaves an explicit boundary. Ordinary dependency exclusions remain enabled.
Conditional/pattern exports, export lists/re-exports, default imports, CommonJS,
TypeScript path mapping, custom loaders, nested package scopes, package-to-package
imports, and ambiguous or
mutable bindings are not resolved by this native ESM strategy. Other package
ecosystems and unresolved cross-package calls remain coverage gaps.

Semantic index version 12 forces unchanged older repositories to rebuild their
Flow partitions. Until reindexing, obsolete `tree-sitter-lexical-flow` versions 1–3
partitions report `adapter_upgrade_required` and cannot transport values.

The verified reader at `GET /api/source-evidence` requires the project,
generation, relative file path, raw source hash and line range. It checks both
indexed membership and current on-disk bytes, including scoped package sources.
A stale generation, changed file or symlink escape never opens an apparently
verified source pane.

## Local receiver lifecycle

In System graph, expand **Local live capture**, choose the runtime profile,
and start a session. Start the development application separately. Creating
a session does not launch, modify, or instrument the application.

The receiver is owned by the existing loopback HTTP server:

| Operation | Endpoint |
| --- | --- |
| List project sessions | `GET /api/capture/sessions?project=...` |
| Create a session | `POST /api/capture/sessions` |
| Read events | `GET /api/capture/events?id=...&after=...` |
| Stop recording, retain review | `POST /api/capture/stop` |
| Delete session and events | `DELETE /api/capture/session?id=...` |
| Explicit field lineage | `POST /v1/cbm/lineage?session=...` |
| OTLP call spans | `POST /v1/traces?session=...` |

Creation requires `project`, `generation`, and a known `profile`.
Profiles are `node`, `browser`, `python`, `jvm`, `dotnet`, `go`, `rust`, `php`,
and `native`. The selector does not itself promise automatic instrumentation
for that language. CUDA is static analysis only.

The local adapter download manifest determines which complete instrumentation
packages are included in the current build. Packages use curated files and
include their third-party licenses. See the
[adapter launch instructions](../tools/capture/README.md) and each archive's
adapter-specific guide. Applications are always launched explicitly by the
developer. Temporary compilation and source overlays do not rewrite the
original project.

| Runtime | Instrumentation | Current boundary |
| --- | --- | --- |
| Node / browser JS/TS | Native ESM loader or browser overlay | CommonJS, framework bundlers, suspended caller transport and mutable heap state need additional rules |
| Python | Scoped AST import/entry loader | Dynamic scope, opaque extension calls, async caller transport and heap versions are gaps |
| Java / Kotlin | Temporary class build and removable JVM agent | Exact static calls; virtual/dynamic calls, custom loaders, suspension and mutable heap transport are gaps |
| .NET C# | Roslyn source overlay using a local SDK | Intraprocedural scalar flow; references, closures, async bodies and external transport are gaps |
| Go | Standard-library AST and Go build overlay | Per-invocation binding versions; cross-call/goroutine transport and mutable heap state are gaps |
| Rust | Offline parser, temporary Cargo/source overlay and local relay | Compiler-checked primitive forms; ownership/borrow semantics and unproven calls remain gaps |
| PHP | Bundled parser, temporary source overlay and prepend runtime | Named functions/methods; references, dynamic scope and caller transport remain gaps |
| C/C++ | Clang AST and temporary compilation overlay | Supported scalar forms; pointer/reference/volatile and unproven heap transport remain gaps |

An observation does not imply coverage of every application edge.
Unsupported operations invalidate earlier binding assumptions rather than
reusing stale values. Exact builtin previews never invoke application getters,
serializers, `toString`/`repr`, or value-equality matching.

Object destruction can change a scalar binding without a visible scalar
assignment. Python and PHP therefore confirm assignment provenance only after
the actual store and invalidate bindings around unproven object release.
C++ invalidates bindings after nested scopes with unmodeled automatic storage.
Rust functions with unproven ownership or temporary lifetimes retain scalar
observations but omit explicit input edges. These boundaries preserve actual
execution and prevent a previously observed value from being presented as the
source of a later, unrelated value.

The create response returns a random session token once. Exporters send
`Authorization: Bearer <token>`; URLs do not carry the token. Lens retains
the token only in memory. Session lists and event reads do not return it.
Stop revokes the token. Delete and server shutdown discard the session.
Expiry stops recording and retains events for review.

Sessions are bounded to four retained sessions, 64 producers per session,
10,000 events, 16 MiB of serialized events, and 15 minutes of recording.
Event reads return at most 200 events. Request and decompressed body sizes
are capped at 1 MiB. Limit exhaustion is explicit and does not silently
pretend that a trace is complete.

For browser exporters, `allowed_origin` may name one exact local HTTP
application origin with a port. This grants ingestion access only, alongside
the token. It does not grant that application access to session management
or other Lens APIs. Native exporters can omit the Origin header.

## Explicit lineage protocol, version 1

An instrumented producer sends the following shape:

```json
{
  "schema_version": 1,
  "producer": { "id": "worker-unique-per-session", "language": "typescript" },
  "events": [
    {
      "sequence": 1,
      "operation": "value",
      "invocation_id": "call-1",
      "value_id": "value-1",
      "inputs": [],
      "access_path": "profile.email",
      "source": {
        "file_path": "src/users.ts",
        "line": 7,
        "source_hash": "<sha256 of original source bytes>"
      }
    }
  ]
}
```

Each producer uses a strictly increasing sequence and unique versioned value
identities for its session. Retries at an already seen sequence are ignored.
Gaps in the sequence increase the missing-event count. Batches are validated
before any event is admitted; ambiguous duplicate JSON members are rejected.
At most 1,000 explicit events are accepted in a batch.

Operations are `value`, `copy`, `field`, `transform`, `call`, `return`,
`serialize`, `deserialize`, `db_bind`, `db_result`, `gap`, and `span`.
`inputs` refers only to values in the same producer namespace. Explicit
`input_refs: [{"producer_id": "...", "value_id": "..."}]` is required for
cross-producer value references. Equal previews, trace IDs, or field names
never establish a value link. Ambiguous or missing value identities remain
unresolved in the displayed slice.

Source attribution checks the capture's pinned generation and indexed source
hash. Unmatched and stale source stays visible as such. Lens only enables
source navigation for matching source in the current generation.

Raw values are off by default. Enabling them requires both
`values_enabled: true` and an exact `allowed_fields` list at session creation.
There are no wildcard fields. Only a primitive `preview` for an allowed
`access_path` is retained, truncated at a UTF-8 boundary to 256 bytes.
Object and array previews are discarded. Previews are never used as identities
or static analysis facts, and are not written to the index or a trace file.

## OTLP call spans

The native receiver supports OTLP/HTTP JSON and binary Protobuf, both plain
and gzip-compressed. It accepts trace exports only, with standard
`application/json` or `application/x-protobuf` response encoding.
Successful retries deduplicate span identity; bounded partial acceptance
reports rejected spans. No external collector is required.

Only trace/span/parent IDs, timestamps, enums, and selected resource identity
metadata are retained. Arbitrary attributes, span names, queries, URLs,
status messages, and payloads are discarded. Nanosecond timestamps are
returned as decimal strings to preserve their precision in JavaScript.

An explicit `cbm.producer.id`, or `service.instance.id` scoped by service name
and namespace, identifies an OTLP producer. Missing producer identity remains
unattributed. OTLP events have empty field inputs and no value ID. Parent
span relationships describe calls; they do not prove field transport.

Protocol reference:
[OTLP specification](https://opentelemetry.io/docs/specs/otlp/).
The earlier [runtime observation design](RUNTIME_TRACE_MODEL.md) describes a
different proposed durable sidecar. These local capture sessions are not that
durable publication model.

## Development verification

Native suites cover documents, system graph, field IR, capture, OTLP decoding,
and HTTP lifecycle and origin boundaries. Tests use their own stores.
The headed browser runner is:

```sh
node graph-ui/tools/system-intelligence-browser.mjs \
  --binary build/c/codebase-memory-mcp \
  --only docs,system,field,capture,runtime,adapters,regression \
  --out /tmp/cbm-browser-evidence
```

Build the native binary with UI support and `graph-ui/dist` first. The runner
copies a controlled fixture into an isolated directory, uses separate cache
and runtime directories, preserves HOME, takes screenshots, and shuts down
its own daemon. The `capture` group uses a controlled emitter to test receiver/UI
lifecycle boundaries. The `runtime` group separately downloads and executes real
Node and browser adapters and verifies original hashes, explicit links, preview
allowlists, source navigation, stop and delete. The `adapters` group clicks each
bundled profile's ZIP download, checks its manifest checksum and archive,
copies the manual launch command, and checks that setup itself creates no events.
Other adapters have real
original-versus-instrumented semantic tests and isolated native receiver
acceptance scripts. Compiler success alone does not establish lineage correctness.
