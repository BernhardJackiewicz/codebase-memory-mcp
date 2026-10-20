# System intelligence: verified coverage and remaining backend inputs

The new Docs, System Graph, and static field-flow interfaces can present real
indexed evidence. The two source repositories below do **not** yet establish a
continuous UI → API → ORM → database → deployment value-flow proof.
This document records the concrete boundary and the backend evidence needed to
extend it. It is technical feedback for the maintainers; no external message was
sent.

## Reproducible source scope

Acceptance used these exact public commits, downloaded as source archives and
independently checked against GitHub's commit API:

| Repository | Pinned commit | Source files |
| --- | --- | ---: |
| [FastAPI full-stack template](https://github.com/fastapi/full-stack-fastapi-template/tree/b1125d8839482cb7bbae603ddc6d0081bf87532e) | `b1125d8839482cb7bbae603ddc6d0081bf87532e` | 248 |
| [Spring Petclinic microservices](https://github.com/spring-petclinic/spring-petclinic-microservices/tree/1d76b00d683e86b62867a6bf59530f8ab301244f) | `1d76b00d683e86b62867a6bf59530f8ab301244f` | 200 |

Both complete source trees were indexed with separate temporary cache/runtime
directories. No repository application, dependency installer, Maven/Gradle
wrapper, or project test suite was run. Source file hashes were unchanged after
indexing. `HOME` and existing user indexes were preserved.

This pinned-source acceptance was repeated on 20 October 2026 after the review
corrections, using the development binary with SHA-256
`14a8b75f9f5eb12debafdbd56f4555d1db15ddf109f635bf3e3953871a17b63e`.
The measurements below identify that tested local build, not a published release.

## What the native APIs actually returned

| Checked result | FastAPI | Petclinic |
| --- | ---: | ---: |
| Indexed documents, each detail checked against original contents | 9 | 4 |
| Relationships returned across those document details | 90 | 38 |
| System Graph entities | 1,744 | 1,553 |
| System Graph relationships | 4,779 | 2,874 |
| Distinct sampled graph witnesses checked against the actual source line through Source Evidence | 31 | 27 |
| Indexed SQL `Table` nodes | 0 | 14 |
| Relationships in the graph's data layer | 0 | 42 |

Document detail relationship totals count the returned per-document results,
including relationships that may be visible from more than one document. They
are not a count of unique system-wide edges.

Both graph projections fit the configured limits of 2,048 entities and 8,192
relations, with zero omitted entities/relations. Their `complete: true` means
that this bounded projection was returned completely. It does not mean all
program behavior, database bindings, or deployment relationships are known.

The source witness checks covered:

| Layer | FastAPI witnesses checked | Petclinic witnesses checked |
| --- | ---: | ---: |
| Code | 8 | 8 |
| Configuration | 8 | 4 |
| Dependencies | 4 | 3 |
| Deployment | 3 | 4 |
| Documentation | 8 | 8 |

Every checked witness retained its project/generation and actual edge ID,
matched its source/target node IDs, and resolved to the original file/line.
The Source Evidence API also verified the exact current source hash. These are
sampled positive checks, not an audit of every graph edge.

The graph contains useful real structure:

- FastAPI: 14 indexed service resources, 34 API entities, 9 images/containers,
  33 configuration entities, and 117 documentation entities including sections.
  The service resources span multiple Compose files/variants; repeated names
  are separate source identities.
- Petclinic: 11 service resources, 32 API entities, 12 images/containers,
  4 configuration entities, 37 documentation entities, and 14 table entities.
- Documentation connects through recorded `MENTIONS` and `REFERENCES_FILE`
  edges. Configuration uses recorded `CONFIGURES` edges.
- The deployment layer currently includes process `SPAWNS` evidence and three
  FastAPI Compose `CONNECTS_TO` edges. A shell process spawn is not a proof that
  an application service is deployed to a specific image, pod, or cloud resource.

## What static field flow proved

The real FastAPI
[`read_user_me`](https://github.com/fastapi/full-stack-fastapi-template/blob/b1125d8839482cb7bbae603ddc6d0081bf87532e/backend/app/api/routes/users.py#L125)
function provides a small, concrete positive case:

1. The `current_user` parameter at line 125, byte span `[3702, 3714)`.
2. Its actual read in `return current_user` at line 129, byte span `[3786, 3798)`.
3. The function's declared return port.

The native query returned three versioned values and two `assign` links with
`proven` certainty. Each value's source bytes, SHA-256, and Source Evidence
response were checked. This proves that intraprocedural transport. It does not
prove authentication dependency injection, decorator behavior, HTTP
serialization, database reads, or any caller-to-handler binding.

The complete file contains more than 200 candidate occurrences. The first
query correctly returned `selection_required` and a `candidate_limit` gap.
The precise selector
`{"file_path":"backend/app/api/routes/users.py","symbol":"read_user_me@3685"}`
reduced the result to four candidates. The parameter can alternatively be
selected by exact `start_byte: 3702`, then traced by its opaque value ID.
The UI must make narrowing controls discoverable when this limit appears.
It must not silently select the first occurrence or invent a symbol identity
from a display name.

This acceptance found a real adapter defect: Python's annotated parameter node
stores its lexical identifier separately from its type field. A parameter such
as `current_user: CurrentUser` was omitted. A failing native test preceded the
fix; regression tests now cover the lexical identity of annotated and
generic/union-annotated parameters.

Petclinic's
[`OwnerEntityMapper.map`](https://github.com/spring-petclinic/spring-petclinic-microservices/blob/1d76b00d683e86b62867a6bf59530f8ab301244f/spring-petclinic-customers-service/src/main/java/org/springframework/samples/petclinic/customers/web/mapper/OwnerEntityMapper.java#L11)
is a useful negative case. Selecting the actual `owner` parameter returned one
value, no transport links, and five explicit expression coverage gaps for the
getter/setter operations. The adapter did not invent a field mutation summary
or assert that the returned object still represented the original field state.
Source bytes and the parameter's evidence were checked.

Both field-flow responses remain `complete: false`. In the FastAPI case the
response includes 120 file-level coverage gaps, including gaps outside the
selected straight-line path. The final extractor explicitly reports unsupported
coercion, truthiness and lifetime effects rather than preserving potentially
stale values. UI copy should distinguish a demonstrated path from the broader
coverage of its file.

## Missing evidence for an end-to-end system view

The names below describe required semantics. They are proposed evidence
contracts, not claims that these edge types already exist.

| Boundary | Observed limitation | Backend evidence needed |
| --- | --- | --- |
| UI/client → API handler | Routes and calls exist, but a matching URL string alone does not prove a value binding. | Exact client request occurrence, method/path resolution, request-field ports, handler declaration, and the declared request serialization/validation mapping. Ambiguous/dynamic routing stays unresolved. |
| Framework → handler | FastAPI decorators/dependencies and Spring annotations/DI are not general transparent-function summaries. | Framework-specific resolution with original decorator/annotation/config evidence, selected implementation, parameter mapping, and explicit unsupported wrapper behavior. |
| Code/ORM → DB schema | FastAPI SQLModel produces no SQL table entities in this acceptance. Petclinic has SQL tables, but its 42 data relations are 14 file→table `DEFINES` and 28 file→table `USAGE` edges. | Anchored ORM model/table/column mappings plus actual query or write sites and parameter/result bindings. Schema existence, a `CALLS` edge, or a repository method name does not prove field transport. |
| Setter/getter or mapper → object fields | Petclinic's mapper field mutation is an explicit gap. | A verified callee field-effect summary, receiver/alias handling, exact argument/return ports, write versions, and body dependencies. Virtual dispatch and external implementations require their own evidence. |
| Service → image/build/deployment | Resource and image nodes exist, but most semantic bindings are not indexed edges. | Explicit Compose/Dockerfile/IaC build context, image reference/digest, workload declaration, and resolved workload/service selectors. Different Compose overlays/environments must retain separate identities until resolved. |
| DB connection → deployed database | A connection config or a database image does not identify the same database instance automatically. | Parsed connection configuration with secret values excluded, explicit config consumers, environment/namespace scope, and deployment/IaC database identity. Unresolved interpolation remains a gap. |
| Static ↔ runtime evidence | Static value paths and actual runtime events are separate sources of evidence. | Source hash and generation match, exact producer/invocation/value IDs, source occurrence, and declared event input references. Equal runtime values, trace IDs, or span names are not lineage. |

In particular, the UI cannot currently prove “this React input reaches this
PostgreSQL column deployed by this resource” on either complete sample.
It can show and navigate the available route, source, documentation,
configuration, image, SQL, and runtime evidence while identifying these
missing joins.

## Provenance requirements for additional relationships

For each new cross-layer relationship, preserve:

- Project, index generation, typed opaque endpoint identities, and a stable
  witness identity. Flow value IDs must remain separate from graph node IDs.
- Actual source file and byte/line span, raw-source hash, and the resolver rule
  or extractor version responsible for the relationship.
- The relevant declaration and use-site evidence together: for example both an
  ORM column mapping and the query binding that references it.
- Explicit semantics and certainty: direct transport, derived transformation,
  possible alternative, control dependence, or unresolved boundary. A
  confidence score alone must not promote a relationship to proven transport.
- Dependency body hashes and package/version/manifest identity where external
  source summaries participate. A dependency body update must invalidate
  dependent summaries even when exported signatures are unchanged.
- Scope and limitations: supported framework/version, environment/namespace,
  unresolved selectors, analysis budgets, and omitted results.

Many structural edges still lack an exact witness line. Their endpoint source
can remain navigable, but the relationship inspector should say that an edge
location was not recorded. It must not substitute a convenient line and present
it as the relationship's evidence.

## Frontend follow-through

The frontend already has the necessary places to expose additional evidence:
typed layers, indexed groups, relationship witnesses, source navigation,
explicit value occurrence selection, and separate static/runtime displays.
As backend coverage grows:

- Keep the initial system overview at the service/API/data/deployment level;
  drill into real source members without inventing service boundaries.
- Show source-file/variant context for repeated service names from multiple
  Compose inputs.
- Make candidate limits, precise symbol/byte selectors, and omitted results
  visible before presenting a partial list as the whole file.
- Distinguish “all indexed relations shown” from “the whole system is
  understood,” and file-level gaps from the evidence for one selected path.
- Keep unknown joins visible. A missing cross-layer edge is actionable
  backend feedback, not a reason to draw a plausible connection.

The external-source acceptance is separate from headed browser interaction
testing and from runtime adapter execution tests. Those checks establish their
own recorded scope; none substitutes for the source proofs described here.
