#include "foundation/arena.h"
#include "foundation/mem_core.h"
#include "pipeline/flow_publication.h"
#include "pipeline/flow_dependencies.h"
#include "pipeline/pipeline_internal.h"
#include "flow_extract.h"
#include "discover/discover.h"
#include "foundation/compat.h"
#include "foundation/compat_fs.h"
#include "foundation/sha256.h"
#include "foundation/platform.h"
#include "foundation/workspace.h"
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* These bounds apply to the additional Flow parser, independently of the
 * primary graph's larger resource policy. Skipped source has a stored gap. */
#define FLOW_SOURCE_FILE_LIMIT (4U * 1024U * 1024U)
#define FLOW_SOURCE_TOTAL_LIMIT (256U * 1024U * 1024U)

static bool publication_cancelled(const atomic_int *cancelled) {
    return cancelled && atomic_load(cancelled) != 0;
}

static bool publication_relative(const char *path) {
    if (!path || !path[0] || strlen(path) >= 4096 || path[0] == '/' || strchr(path, '\\'))
        return false;
    const char *component = path;
    while (*component) {
        const char *slash = strchr(component, '/');
        size_t length = slash ? (size_t)(slash - component) : strlen(component);
        if (length == 0 || (length == 1 && component[0] == '.') ||
            (length == 2 && component[0] == '.' && component[1] == '.'))
            return false;
        if (!slash)
            break;
        component = slash + 1;
    }
    return true;
}

static int publication_gap(cbm_store_t *store, const char *project, const cbm_file_hash_t *entry,
                           const char *code, const char *message) {
    cbm_flow_gap_t gap = {.code = code, .message = message, .symbol = ""};
    cbm_flow_file_t file = {.source_hash = entry->sha256,
                            .adapter = "unavailable",
                            .adapter_version = CBM_FLOW_IR_SCHEMA_VERSION,
                            .gaps = &gap,
                            .gap_count = 1};
    return cbm_flow_ir_replace_file(store, project, entry->rel_path, &file);
}

static int publication_file(cbm_store_t *store, const char *project, const char *root,
                            const cbm_file_hash_t *entry, size_t *source_bytes,
                            const atomic_int *cancelled) {
    const char *name = strrchr(entry->rel_path, '/');
    name = name ? name + 1 : entry->rel_path;
    CBMLanguage language = cbm_language_for_filename(name);
    /* Infra/docs/control files are in the semantic manifest too. Record the
     * unsupported semantic layer without rereading their potentially large
     * payloads or mislabelling their existing graph facts as field flow. */
    if (language != CBM_LANG_COUNT && !cbm_flow_extract_supports_language(language))
        return publication_gap(store, project, entry, "unsupported_language",
                               "No field-value semantic adapter is available for this file.");
    if (entry->size < 0 || (uint64_t)entry->size > FLOW_SOURCE_FILE_LIMIT ||
        *source_bytes >= FLOW_SOURCE_TOTAL_LIMIT ||
        (uint64_t)entry->size > FLOW_SOURCE_TOTAL_LIMIT - *source_bytes)
        return publication_gap(store, project, entry, "source_budget",
                               "The source exceeds this generation's field-analysis byte budget.");
    char path[4096], canonical[4096];
    int length = snprintf(path, sizeof(path), "%s/%s", root, entry->rel_path);
    cbm_path_info_t info = {0};
    if (length < 0 || (size_t)length >= sizeof(path) ||
        !cbm_canonical_path(path, canonical, sizeof(canonical)) ||
        !cbm_path_within_root(root, canonical) ||
        cbm_path_info_utf8(canonical, &info) != CBM_PATH_INFO_OK || !info.is_regular)
        return publication_gap(store, project, entry, "source_unavailable",
                               "The indexed source is unavailable inside the project root.");
    FILE *input = cbm_fopen(canonical, "rb");
    if (!input)
        return publication_gap(store, project, entry, "source_unavailable",
                               "The indexed source could not be read.");
    /* The manifest size is only a hint. A concurrent growth is detected by
     * reading one extra byte and never interpreted as a truncated AST. */
    size_t capacity = (size_t)entry->size + 1;
    char *source = cbm_alloc(CBM_MEM_CLASS_OTHER, capacity + 1);
    if (!source) {
        fclose(input);
        return CBM_STORE_ERR;
    }
    size_t bytes = fread(source, 1, capacity, input);
    bool read_ok = !ferror(input);
    if (fclose(input) != 0)
        read_ok = false;
    source[bytes] = '\0';
    *source_bytes += bytes;
    int rc = CBM_STORE_OK;
    if (publication_cancelled(cancelled))
        rc = CBM_STORE_CANCELLED;
    else if (!read_ok)
        rc = publication_gap(store, project, entry, "source_unavailable",
                             "The indexed source could not be read completely.");
    else {
        char hash[65];
        cbm_sha256_hex(source, bytes, hash);
        if (bytes != (size_t)entry->size || strcmp(hash, entry->sha256) != 0)
            rc = publication_gap(store, project, entry, "source_snapshot_changed",
                                 "The source changed after the graph snapshot was indexed.");
        else if (memchr(source, '\0', bytes))
            rc = publication_gap(store, project, entry, "unsupported_source",
                                 "Binary source is not analyzed as field-value syntax.");
        else {
            language =
                cbm_language_classify(name, (const unsigned char *)source, bytes, false, true);
            if (!cbm_flow_extract_supports_language(language))
                rc = publication_gap(store, project, entry, "unsupported_language",
                                     "No field-value semantic adapter is available for this file.");
            else {
                cbm_flow_extraction_t *extraction = NULL;
                rc = cbm_flow_extract_source(source, (int)bytes, language, project, entry->rel_path,
                                             &extraction);
                if (rc == CBM_STORE_OK && extraction) {
                    /* The validated manifest is the source identity shared
                     * with graph/Docs, independent of adapter internals. */
                    extraction->file.source_hash = entry->sha256;
                    rc = cbm_flow_ir_replace_file(store, project, entry->rel_path,
                                                  &extraction->file);
                } else if (rc == CBM_STORE_OK) {
                    rc = CBM_STORE_ERR;
                }
                cbm_flow_extraction_free(extraction);
            }
        }
    }
    cbm_free(CBM_MEM_CLASS_OTHER, source);
    return rc;
}

static int publication_dependencies(cbm_store_t *store, const char *project, const char *root,
                                    const cbm_file_hash_t *manifest, int count,
                                    const atomic_int *cancelled) {
    cbm_flow_dependency_snapshot_t *snapshot = NULL;
    int rc = cbm_flow_dependencies_snapshot(root, getenv(CBM_FLOW_DEPENDENCIES_ENV), &snapshot);
    if (rc != CBM_STORE_OK || !snapshot) {
        cbm_flow_dependencies_free(snapshot);
        return CBM_STORE_ERR;
    }
    const char *expected = NULL;
    for (int i = 0; i < count; i++)
        if (manifest[i].rel_path && !strcmp(manifest[i].rel_path, CBM_FLOW_DEPENDENCIES_MANIFEST))
            expected = manifest[i].sha256;
    bool matched = expected && !strcmp(expected, snapshot->digest);
    if (snapshot->enabled && !matched) {
        cbm_flow_gap_t gap = {
            .code = "dependency_snapshot_changed",
            .symbol = "",
            .message = "The selected installed packages changed after the semantic manifest."};
        cbm_flow_file_t file = {.source_hash = expected ? expected : snapshot->digest,
                                .adapter = "local-dependency-coverage",
                                .adapter_version = 1,
                                .gaps = &gap,
                                .gap_count = 1};
        rc = cbm_flow_ir_replace_file(store, project, ".codebase-memory/flow-dependency-status",
                                      &file);
    } else if (snapshot->enabled) {
        uint64_t analysis_deadline = cbm_now_ms() + 10000;
        bool analysis_limited = false;
        for (size_t i = 0; rc == CBM_STORE_OK && i < snapshot->source_count; i++) {
            if (publication_cancelled(cancelled)) {
                rc = CBM_STORE_CANCELLED;
                break;
            }
            if (cbm_now_ms() >= analysis_deadline) {
                analysis_limited = true;
                break;
            }
            const cbm_flow_dependency_source_t *source = &snapshot->sources[i];
            cbm_flow_extraction_t *extraction = NULL;
            rc = cbm_flow_extract_source(source->source, (int)source->source_length,
                                         source->language, project, source->file_path, &extraction);
            if (rc == CBM_STORE_OK && extraction) {
                extraction->file.source_hash = source->source_hash;
                extraction->file.package_id = source->package_id;
                extraction->file.package_version = source->package_version;
                extraction->file.package_manifest_hash = source->package_manifest_hash;
                rc = cbm_flow_ir_replace_file(store, project, source->file_path, &extraction->file);
            } else if (rc == CBM_STORE_OK)
                rc = CBM_STORE_ERR;
            cbm_flow_extraction_free(extraction);
        }
        if (rc == CBM_STORE_OK)
            rc = cbm_flow_dependencies_bind(store, project, root, manifest, count, snapshot,
                                            cancelled);
        if (rc == CBM_STORE_OK && (snapshot->gap_count || snapshot->limited || analysis_limited)) {
            size_t gap_count =
                snapshot->gap_count + (snapshot->limited ? 1 : 0) + (analysis_limited ? 1 : 0);
            cbm_flow_gap_t *gaps = cbm_calloc(CBM_MEM_CLASS_OTHER, gap_count * sizeof(*gaps));
            if (!gaps)
                rc = CBM_STORE_ERR;
            else {
                for (size_t i = 0; i < snapshot->gap_count; i++) {
                    gaps[i] = (cbm_flow_gap_t){.code = snapshot->gaps[i].code,
                                               .message = snapshot->gaps[i].message,
                                               .symbol = snapshot->gaps[i].package_id};
                }
                size_t next = snapshot->gap_count;
                if (snapshot->limited)
                    gaps[next++] = (cbm_flow_gap_t){
                        .code = "dependency_limit",
                        .symbol = "",
                        .message =
                            "The installed-package snapshot or its coverage list was bounded."};
                if (analysis_limited)
                    gaps[next++] = (cbm_flow_gap_t){
                        .code = "dependency_analysis_budget",
                        .symbol = "",
                        .message =
                            "Further package bodies exceeded the 10-second analysis budget."};
                cbm_flow_file_t file = {.source_hash = snapshot->digest,
                                        .adapter = "local-dependency-coverage",
                                        .adapter_version = 1,
                                        .gaps = gaps,
                                        .gap_count = gap_count};
                rc = cbm_flow_ir_replace_file(store, project,
                                              ".codebase-memory/flow-dependency-status", &file);
                cbm_free(CBM_MEM_CLASS_OTHER, gaps);
            }
        }
    }
    cbm_flow_dependencies_free(snapshot);
    return rc;
}

int cbm_flow_publish_snapshot(cbm_store_t *store, const char *project, const char *root_path,
                              const cbm_file_hash_t *manifest, int manifest_count,
                              const atomic_int *cancelled) {
    if (!store || !project || !project[0] || !root_path || !root_path[0] || manifest_count < 0 ||
        (manifest_count && !manifest))
        return CBM_STORE_ERR;
    if (publication_cancelled(cancelled))
        return CBM_STORE_CANCELLED;
    sqlite3 *db = cbm_store_get_db(store);
    if (sqlite3_exec(db, "SAVEPOINT cbm_flow_snapshot", NULL, NULL, NULL) != SQLITE_OK)
        return CBM_STORE_ERR;
    int rc = cbm_flow_ir_initialize(store);
    sqlite3_stmt *statement = NULL;
    if (rc == CBM_STORE_OK && sqlite3_prepare_v2(db, "DELETE FROM cbm_flow_files WHERE project=?1",
                                                 -1, &statement, NULL) != SQLITE_OK)
        rc = CBM_STORE_ERR;
    if (rc == CBM_STORE_OK) {
        sqlite3_bind_text(statement, 1, project, -1, SQLITE_TRANSIENT);
        if (sqlite3_step(statement) != SQLITE_DONE)
            rc = CBM_STORE_ERR;
    }
    sqlite3_finalize(statement);
    size_t source_bytes = 0;
    for (int i = 0; rc == CBM_STORE_OK && i < manifest_count; i++) {
        const cbm_file_hash_t *entry = &manifest[i];
        if (publication_cancelled(cancelled)) {
            rc = CBM_STORE_CANCELLED;
            break;
        }
        /* Semantic input pseudo-paths represent configuration digests, not
         * source files. The primary manifest owns their validation. */
        if (entry->rel_path && strncmp(entry->rel_path, CBM_SEMANTIC_INPUT_PREFIX,
                                       strlen(CBM_SEMANTIC_INPUT_PREFIX)) == 0)
            continue;
        if (!entry->project || strcmp(entry->project, project) != 0 ||
            !publication_relative(entry->rel_path) || !entry->sha256 || !entry->sha256[0]) {
            rc = CBM_STORE_ERR;
            break;
        }
        rc = publication_file(store, project, root_path, entry, &source_bytes, cancelled);
    }
    if (rc == CBM_STORE_OK)
        rc = publication_dependencies(store, project, root_path, manifest, manifest_count,
                                      cancelled);
    if (rc == CBM_STORE_OK && publication_cancelled(cancelled))
        rc = CBM_STORE_CANCELLED;
    if (rc != CBM_STORE_OK)
        sqlite3_exec(db, "ROLLBACK TO cbm_flow_snapshot", NULL, NULL, NULL);
    if (sqlite3_exec(db, "RELEASE cbm_flow_snapshot", NULL, NULL, NULL) != SQLITE_OK)
        rc = CBM_STORE_ERR;
    return rc;
}
