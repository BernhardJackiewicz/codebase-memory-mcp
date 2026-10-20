#include "test_framework.h"
#include "test_helpers.h"
#include "pipeline/flow_publication.h"
#include "pipeline/pipeline.h"
#include "store/flow_ir.h"
#include "foundation/sha256.h"
#include "foundation/mem_core.h"
#include <sqlite3.h>
#include <yyjson/yyjson.h>

static int publication_count(cbm_store_t *store, const char *sql) {
    sqlite3_stmt *statement = NULL;
    int count = -1;
    if (sqlite3_prepare_v2(cbm_store_get_db(store), sql, -1, &statement, NULL) == SQLITE_OK &&
        sqlite3_step(statement) == SQLITE_ROW)
        count = sqlite3_column_int(statement, 0);
    sqlite3_finalize(statement);
    return count;
}

static bool publication_index(const char *root, const char *db_path) {
    cbm_pipeline_t *pipeline = cbm_pipeline_new(root, db_path, CBM_MODE_FAST);
    if (!pipeline)
        return false;
    bool ok = cbm_pipeline_set_project_name(pipeline, "flow-publication") &&
              cbm_pipeline_run(pipeline) == 0;
    cbm_pipeline_free(pipeline);
    return ok;
}

static yyjson_doc *publication_parameter_trace(cbm_store_t *store, const char *file) {
    sqlite3_stmt *statement = NULL;
    char id[4096] = {0};
    if (sqlite3_prepare_v2(cbm_store_get_db(store),
                           "SELECT id FROM cbm_flow_values WHERE project='flow-publication' "
                           "AND file_path=?1 AND kind='parameter' ORDER BY start_byte LIMIT 1",
                           -1, &statement, NULL) == SQLITE_OK) {
        sqlite3_bind_text(statement, 1, file, -1, SQLITE_TRANSIENT);
        if (sqlite3_step(statement) == SQLITE_ROW)
            snprintf(id, sizeof(id), "%s", sqlite3_column_text(statement, 0));
    }
    sqlite3_finalize(statement);
    if (!id[0])
        return NULL;
    char *json = NULL;
    cbm_flow_trace_options_t options = {.value_id = id};
    if (cbm_flow_ir_trace(store, "flow-publication", &options, &json) != CBM_STORE_OK)
        return NULL;
    yyjson_doc *doc = yyjson_read(json, strlen(json), 0);
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    return doc;
}

static bool publication_reaches_return(yyjson_doc *doc) {
    yyjson_val *values = yyjson_obj_get(yyjson_doc_get_root(doc), "values");
    size_t i, count;
    yyjson_val *value;
    yyjson_arr_foreach(values, i, count, value) {
        const char *kind = yyjson_get_str(yyjson_obj_get(value, "kind"));
        if (kind && strcmp(kind, "return") == 0)
            return true;
    }
    return false;
}

TEST(flow_publication_dirty_snapshot_records_gap_without_new_source_proof) {
    char *root = th_mktempdir("cbm_flow_dirty");
    ASSERT_NOT_NULL(root);
    const char *indexed = "function f(input) { return input; }";
    const char *dirty = "function f(input) { return 0; }";
    ASSERT_EQ(th_write_file(TH_PATH(root, "a.js"), dirty), 0);
    char hash[65];
    cbm_sha256_hex(indexed, strlen(indexed), hash);
    cbm_file_hash_t manifest = {.project = "flow-publication",
                                .rel_path = "a.js",
                                .sha256 = hash,
                                .size = (int64_t)strlen(indexed)};
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_store_upsert_project(store, "flow-publication", root), CBM_STORE_OK);
    ASSERT_EQ(cbm_flow_publish_snapshot(store, "flow-publication", root, &manifest, 1, NULL),
              CBM_STORE_OK);
    ASSERT_EQ(publication_count(store, "SELECT count(*) FROM cbm_flow_values"), 0);
    ASSERT_EQ(publication_count(store, "SELECT count(*) FROM cbm_flow_gaps "
                                       "WHERE code='source_snapshot_changed'"),
              1);
    cbm_store_close(store);
    th_cleanup(root);
    PASS();
}

TEST(flow_publication_cancelled_rebuild_preserves_previous_ir) {
    char *root = th_mktempdir("cbm_flow_cancel");
    ASSERT_NOT_NULL(root);
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_store_upsert_project(store, "flow-publication", root), CBM_STORE_OK);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    cbm_flow_value_t value = {.id = "old",
                              .symbol = "f",
                              .binding = "param:input",
                              .access_path = "[]",
                              .kind = "parameter",
                              .parameter_index = 0};
    cbm_flow_file_t file = {.source_hash = "old-hash",
                            .adapter = "fixture",
                            .adapter_version = 1,
                            .values = &value,
                            .value_count = 1};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow-publication", "a.js", &file), CBM_STORE_OK);
    atomic_int cancelled = 1;
    ASSERT_NEQ(cbm_flow_publish_snapshot(store, "flow-publication", root, NULL, 0, &cancelled),
               CBM_STORE_OK);
    ASSERT_EQ(publication_count(store, "SELECT count(*) FROM cbm_flow_values WHERE id='old'"), 1);
    atomic_store(&cancelled, 0);
    ASSERT_EQ(cbm_flow_publish_snapshot(store, "flow-publication", root, NULL, 0, &cancelled),
              CBM_STORE_OK);
    ASSERT_EQ(publication_count(store, "SELECT count(*) FROM cbm_flow_values"), 0);
    cbm_store_close(store);
    th_cleanup(root);
    PASS();
}

TEST(flow_publication_real_index_body_edit_and_deletion_match_full_rebuild) {
    char *root_tmp = th_mktempdir("cbm_flow_index");
    char *root = root_tmp ? strdup(root_tmp) : NULL;
    char *databases = th_mktempdir("cbm_flow_databases");
    ASSERT_NOT_NULL(root);
    ASSERT_NOT_NULL(databases);
    char db_path[1024], full_path[1024], file_path[1024];
    snprintf(db_path, sizeof(db_path), "%s/incremental.db", databases);
    snprintf(full_path, sizeof(full_path), "%s/full.db", databases);
    snprintf(file_path, sizeof(file_path), "%s/a.js", root);
    ASSERT_EQ(
        th_write_file(file_path, "function f(input) { let output = input; return output; }\n"), 0);
    ASSERT_TRUE(publication_index(root, db_path));
    cbm_store_t *store = cbm_store_open_path(db_path);
    ASSERT_NOT_NULL(store);
    yyjson_doc *doc = publication_parameter_trace(store, "a.js");
    ASSERT_NOT_NULL(doc);
    ASSERT_TRUE(publication_reaches_return(doc));
    char generation[64];
    ASSERT_EQ(cbm_store_generation(store, generation, sizeof(generation)), CBM_STORE_OK);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(yyjson_doc_get_root(doc), "generation")),
                  generation);
    yyjson_doc_free(doc);
    cbm_store_close(store);

    /* The exported signature is unchanged. A body-only overwrite must kill
     * the old dependency even on the incremental path. */
    ASSERT_EQ(
        th_write_file(file_path,
                      "function f(input) { let output = input; output = 0; return output; }\n"),
        0);
    ASSERT_TRUE(publication_index(root, db_path));
    ASSERT_TRUE(publication_index(root, full_path));
    store = cbm_store_open_path(db_path);
    cbm_store_t *full = cbm_store_open_path(full_path);
    ASSERT_NOT_NULL(store);
    ASSERT_NOT_NULL(full);
    doc = publication_parameter_trace(store, "a.js");
    ASSERT_NOT_NULL(doc);
    ASSERT_FALSE(publication_reaches_return(doc));
    yyjson_doc_free(doc);
    doc = publication_parameter_trace(full, "a.js");
    ASSERT_NOT_NULL(doc);
    ASSERT_FALSE(publication_reaches_return(doc));
    yyjson_doc_free(doc);
    ASSERT_EQ(publication_count(store, "SELECT count(*) FROM cbm_flow_values"),
              publication_count(full, "SELECT count(*) FROM cbm_flow_values"));
    ASSERT_EQ(publication_count(store, "SELECT count(*) FROM cbm_flow_links"),
              publication_count(full, "SELECT count(*) FROM cbm_flow_links"));
    cbm_store_close(store);
    cbm_store_close(full);
    ASSERT_EQ(remove(file_path), 0);
    ASSERT_EQ(th_write_file(TH_PATH(root, "remaining.js"), "const unchanged = 1;\n"), 0);
    ASSERT_TRUE(publication_index(root, db_path));
    store = cbm_store_open_path(db_path);
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(publication_count(store, "SELECT count(*) FROM cbm_flow_files "
                                       "WHERE file_path='a.js'"),
              0);
    cbm_store_close(store);
    th_cleanup(root);
    th_cleanup(databases);
    free(root);
    PASS();
}

TEST(flow_publication_cross_file_resolution_is_source_bound_and_survives_body_delta) {
    char *root_tmp = th_mktempdir("cbm_flow_cross");
    char *root = root_tmp ? strdup(root_tmp) : NULL;
    char *databases = th_mktempdir("cbm_flow_cross_db");
    ASSERT_NOT_NULL(root);
    ASSERT_NOT_NULL(databases);
    char db_path[1024], full_path[1024];
    snprintf(db_path, sizeof(db_path), "%s/delta.db", databases);
    snprintf(full_path, sizeof(full_path), "%s/full.db", databases);
    ASSERT_EQ(
        th_write_file(TH_PATH(root, "callee.ts"),
                      "export function identity(input: string): string {\n  return input;\n}\n"),
        0);
    ASSERT_EQ(th_write_file(TH_PATH(root, "caller.ts"),
                            "import { identity } from './callee';\n"
                            "export function f(input: string): string {\n"
                            "  const output = identity(input);\n  return output;\n}\n"),
              0);
    ASSERT_TRUE(publication_index(root, db_path));
    cbm_store_t *store = cbm_store_open_path(db_path);
    ASSERT_NOT_NULL(store);
    yyjson_doc *doc = publication_parameter_trace(store, "caller.ts");
    ASSERT_NOT_NULL(doc);
    ASSERT_TRUE(publication_reaches_return(doc));
    ASSERT_EQ(publication_count(store, "SELECT count(*) FROM cbm_flow_bindings"), 1);
    yyjson_doc_free(doc);
    cbm_store_close(store);
    /* Export signature unchanged: the target body kills field transport.
     * Fresh full and incremental generations must agree, including explicit
     * callsite evidence and absence of the previous return path. */
    ASSERT_EQ(
        th_write_file(TH_PATH(root, "callee.ts"),
                      "export function identity(input: string): string {\n  return 'fixed';\n}\n"),
        0);
    ASSERT_TRUE(publication_index(root, db_path));
    ASSERT_TRUE(publication_index(root, full_path));
    store = cbm_store_open_path(db_path);
    cbm_store_t *full = cbm_store_open_path(full_path);
    ASSERT_NOT_NULL(store);
    ASSERT_NOT_NULL(full);
    doc = publication_parameter_trace(store, "caller.ts");
    ASSERT_NOT_NULL(doc);
    ASSERT_FALSE(publication_reaches_return(doc));
    yyjson_doc_free(doc);
    doc = publication_parameter_trace(full, "caller.ts");
    ASSERT_NOT_NULL(doc);
    ASSERT_FALSE(publication_reaches_return(doc));
    yyjson_doc_free(doc);
    ASSERT_EQ(publication_count(store, "SELECT count(*) FROM cbm_flow_bindings"), 1);
    ASSERT_EQ(publication_count(store, "SELECT count(*) FROM cbm_flow_links"),
              publication_count(full, "SELECT count(*) FROM cbm_flow_links"));
    cbm_store_close(store);
    cbm_store_close(full);
    th_cleanup(root);
    th_cleanup(databases);
    free(root);
    PASS();
}

TEST(flow_publication_unchanged_version11_repo_rebuilds_obsolete_flow_partitions) {
    char *root_tmp = th_mktempdir("cbm_flow_upgrade");
    char *root = root_tmp ? strdup(root_tmp) : NULL;
    char *databases = th_mktempdir("cbm_flow_upgrade_db");
    ASSERT_NOT_NULL(root);
    ASSERT_NOT_NULL(databases);
    char db_path[1024];
    snprintf(db_path, sizeof(db_path), "%s/upgrade.db", databases);
    const char *source = "function f(input) { return input; }\n";
    ASSERT_EQ(th_write_file(TH_PATH(root, "a.js"), source), 0);
    ASSERT_TRUE(publication_index(root, db_path));
    cbm_store_t *store = cbm_store_open_path(db_path);
    ASSERT_NOT_NULL(store);
    cbm_coverage_meta_t meta = {0};
    cbm_coverage_row_t *rows = NULL;
    int count = 0;
    ASSERT_EQ(cbm_store_coverage_meta_get(store, "flow-publication", &meta), CBM_STORE_OK);
    ASSERT_EQ(cbm_store_coverage_get(store, "flow-publication", &rows, &count), CBM_STORE_OK);
    cbm_coverage_meta_t legacy = meta;
    legacy.coverage_version = 11;
    ASSERT_EQ(cbm_store_coverage_replace_ex(store, "flow-publication", rows, count, &legacy),
              CBM_STORE_OK);
    cbm_store_free_coverage(rows, count);
    cbm_store_coverage_meta_clear(&meta);
    ASSERT_EQ(
        sqlite3_exec(cbm_store_get_db(store),
                     "UPDATE cbm_flow_files SET adapter_version=3 "
                     "WHERE project='flow-publication' AND adapter='tree-sitter-lexical-flow'",
                     NULL, NULL, NULL),
        SQLITE_OK);
    char before[64], after[64];
    ASSERT_EQ(cbm_store_generation(store, before, sizeof(before)), CBM_STORE_OK);
    ASSERT_EQ(publication_count(store,
                                "SELECT count(*) FROM cbm_flow_files "
                                "WHERE adapter='tree-sitter-lexical-flow' AND adapter_version=3"),
              1);
    cbm_store_close(store);

    /* No source, export, package or build-config bytes changed. The semantic
     * version alone must reject an incremental no-op and replace the old IR. */
    ASSERT_TRUE(publication_index(root, db_path));
    store = cbm_store_open_path(db_path);
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_store_generation(store, after, sizeof(after)), CBM_STORE_OK);
    ASSERT_TRUE(strcmp(before, after) != 0);
    ASSERT_EQ(cbm_store_coverage_meta_get(store, "flow-publication", &meta), CBM_STORE_OK);
    ASSERT_EQ(meta.coverage_version, 12);
    cbm_store_coverage_meta_clear(&meta);
    ASSERT_EQ(publication_count(store,
                                "SELECT count(*) FROM cbm_flow_files "
                                "WHERE adapter='tree-sitter-lexical-flow' AND adapter_version<4"),
              0);
    yyjson_doc *doc = publication_parameter_trace(store, "a.js");
    ASSERT_NOT_NULL(doc);
    ASSERT_TRUE(publication_reaches_return(doc));
    yyjson_doc_free(doc);
    cbm_store_close(store);
    th_cleanup(root);
    th_cleanup(databases);
    free(root);
    PASS();
}

SUITE(flow_publication) {
    RUN_TEST(flow_publication_dirty_snapshot_records_gap_without_new_source_proof);
    RUN_TEST(flow_publication_cancelled_rebuild_preserves_previous_ir);
    RUN_TEST(flow_publication_real_index_body_edit_and_deletion_match_full_rebuild);
    RUN_TEST(flow_publication_cross_file_resolution_is_source_bound_and_survives_body_delta);
    RUN_TEST(flow_publication_unchanged_version11_repo_rebuilds_obsolete_flow_partitions);
}
