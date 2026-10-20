#ifndef CBM_FLOW_DEPENDENCIES_H
#define CBM_FLOW_DEPENDENCIES_H

#include "foundation/arena.h"
#include "cbm.h"
#include "store/store.h"
#include <stdatomic.h>

#define CBM_FLOW_DEPENDENCIES_ENV "CBM_FLOW_DEPENDENCIES"
#define CBM_FLOW_DEPENDENCIES_MANIFEST ".codebase-memory/.semantic-input/flow-dependencies-v1"
#define CBM_FLOW_DEPENDENCIES_SCOPES ".codebase-memory/.semantic-input/flow-dependency-scopes-v1"

typedef struct {
    const char *file_path; /* Exact project-relative installed source path. */
    const char *source;
    size_t source_length;
    const char *source_hash;
    const char *package_id;
    const char *package_version;
    const char *package_manifest_hash;
    CBMLanguage language;
} cbm_flow_dependency_source_t;

typedef struct {
    const char *package_id;
    const char *file_path;
    const char *code;
    const char *message;
} cbm_flow_dependency_gap_t;

typedef struct {
    CBMArena arena;
    char digest[65];
    bool enabled;
    bool limited;
    const cbm_flow_dependency_source_t *sources;
    size_t source_count;
    const cbm_flow_dependency_gap_t *gaps;
    size_t gap_count;
} cbm_flow_dependency_snapshot_t;

/* Explicit local opt-in: comma-separated npm package names, at most 16.
 * Only already installed project/node_modules sources are read. No process,
 * network request, package installation or repository config can enable it.
 * Missing/unsupported/unsafe inputs are source-located coverage gaps. */
int cbm_flow_dependencies_snapshot(const char *root, const char *allowlist,
                                   cbm_flow_dependency_snapshot_t **out);
void cbm_flow_dependencies_free(cbm_flow_dependency_snapshot_t *snapshot);
/* Includes opt-in, installed manifest/version and exact selected source bodies.
 * Called by both semantic manifest routes, including no-op verification. */
int cbm_flow_dependencies_digest(const char *root, char digest[65]);
int cbm_flow_dependencies_scope_digest(const char *root, const cbm_file_hash_t *manifest, int count,
                                       char digest[65], bool *limited);
/* Bind verified ordinary ESM imports to immutable direct package exports.
 * Unsupported resolution keeps the extractor's unresolved_call boundary. */
int cbm_flow_dependencies_bind(cbm_store_t *store, const char *project, const char *root,
                               const cbm_file_hash_t *manifest, int count,
                               const cbm_flow_dependency_snapshot_t *snapshot,
                               const atomic_int *cancelled);

#endif
