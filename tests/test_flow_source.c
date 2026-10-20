#include "test_framework.h"
#include "test_helpers.h"
#include "ui/flow_source.h"
#include "store/flow_ir.h"
#include "foundation/sha256.h"
#include "foundation/mem_core.h"
#include <sqlite3.h>
#include <yyjson/yyjson.h>

static cbm_store_t *source_store(const char *root, const char *path, const char *text,
                                 char hash[65], char generation[64]) {
    cbm_store_t *store = cbm_store_open_memory();
    if (!store)
        return NULL;
    cbm_store_upsert_project(store, "source", root);
    cbm_node_t node = {.project = "source",
                       .name = path,
                       .qualified_name = path,
                       .label = "File",
                       .file_path = path,
                       .properties_json = "{}"};
    cbm_store_upsert_node(store, &node);
    cbm_sha256_hex(text, strlen(text), hash);
    cbm_store_upsert_file_hash(store, "source", path, hash, 0, (int64_t)strlen(text));
    cbm_store_generation(store, generation, 64);
    return store;
}

static yyjson_doc *source_read(cbm_store_t *store, cbm_source_evidence_request_t *request,
                               int *status) {
    char *json = cbm_source_evidence(store, request, status);
    yyjson_doc *doc = json ? yyjson_read(json, strlen(json), 0) : NULL;
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    return doc;
}

TEST(source_evidence_returns_only_verified_snapshot_bytes_and_lines) {
    char *root = th_mktempdir("cbm_source_evidence");
    ASSERT_NOT_NULL(root);
    const char *text = "first\nconst name = 'Grüße';\nreturn name;\n";
    ASSERT_EQ(th_write_file(TH_PATH(root, "a.js"), text), 0);
    char hash[65], generation[64];
    cbm_store_t *store = source_store(root, "a.js", text, hash, generation);
    ASSERT_NOT_NULL(store);
    int changes = sqlite3_total_changes(cbm_store_get_db(store)), status = 0;
    cbm_source_evidence_request_t request = {.project = "source",
                                             .generation = generation,
                                             .file_path = "a.js",
                                             .source_hash = hash,
                                             .start_line = 2,
                                             .end_line = 2};
    yyjson_doc *doc = source_read(store, &request, &status);
    ASSERT_EQ(status, 200);
    ASSERT_NOT_NULL(doc);
    yyjson_val *result = yyjson_doc_get_root(doc);
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(result, "schema_version")), 1);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(result, "content")), "const name = 'Grüße';\n");
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(result, "source_hash")), hash);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(result, "generation")), generation);
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(result, "start_line")), 2);
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(result, "end_line")), 2);
    ASSERT_TRUE(yyjson_get_bool(yyjson_obj_get(result, "complete")));
    ASSERT_EQ(sqlite3_total_changes(cbm_store_get_db(store)), changes);
    yyjson_doc_free(doc);
    cbm_store_close(store);
    th_cleanup(root);
    PASS();
}

TEST(source_evidence_rejects_generation_hash_and_dirty_bytes_without_exposing_them) {
    char *root = th_mktempdir("cbm_source_stale");
    ASSERT_NOT_NULL(root);
    const char *text = "const oldValue = 1;\n";
    ASSERT_EQ(th_write_file(TH_PATH(root, "a.js"), text), 0);
    char hash[65], generation[64];
    cbm_store_t *store = source_store(root, "a.js", text, hash, generation);
    ASSERT_NOT_NULL(store);
    cbm_source_evidence_request_t request = {
        .project = "source", .generation = "old", .file_path = "a.js", .source_hash = hash};
    int status = 0;
    for (int i = 0; i < 3; i++) {
        if (i == 1) {
            request.generation = generation;
            request.source_hash = "wrong";
        } else if (i == 2) {
            request.source_hash = hash;
            ASSERT_EQ(th_write_file(TH_PATH(root, "a.js"), "SECRET_CURRENT_SOURCE\n"), 0);
        }
        yyjson_doc *doc = source_read(store, &request, &status);
        ASSERT_EQ(status, 409);
        ASSERT_NOT_NULL(doc);
        ASSERT_NULL(yyjson_obj_get(yyjson_doc_get_root(doc), "content"));
        ASSERT_NOT_NULL(yyjson_get_str(yyjson_obj_get(yyjson_doc_get_root(doc), "error")));
        yyjson_doc_free(doc);
    }
    cbm_store_close(store);
    th_cleanup(root);
    PASS();
}

TEST(source_evidence_requires_index_membership_and_root_containment) {
    char *root = th_mktempdir("cbm_source_boundary");
    ASSERT_NOT_NULL(root);
    const char *text = "not graph source\n";
    ASSERT_EQ(th_write_file(TH_PATH(root, "unindexed.js"), text), 0);
    char hash[65], generation[64];
    cbm_store_t *store = source_store(root, "indexed.js", text, hash, generation);
    ASSERT_NOT_NULL(store);
    /* A manifest-only control file is not an indexed source node. */
    cbm_store_upsert_file_hash(store, "source", "unindexed.js", hash, 0, (int64_t)strlen(text));
    cbm_source_evidence_request_t request = {.project = "source",
                                             .generation = generation,
                                             .file_path = "unindexed.js",
                                             .source_hash = hash};
    int status = 0;
    yyjson_doc *doc = source_read(store, &request, &status);
    ASSERT_EQ(status, 404);
    yyjson_doc_free(doc);
    request.file_path = "../outside.js";
    doc = source_read(store, &request, &status);
    ASSERT_EQ(status, 403);
    yyjson_doc_free(doc);
    cbm_store_close(store);
    th_cleanup(root);
    PASS();
}

TEST(source_evidence_caps_complete_lines_and_marks_truncation) {
    char *root = th_mktempdir("cbm_source_lines");
    ASSERT_NOT_NULL(root);
    char text[2048] = {0};
    for (int i = 0; i < 250; i++)
        strcat(text, "line\n");
    ASSERT_EQ(th_write_file(TH_PATH(root, "a.js"), text), 0);
    char hash[65], generation[64];
    cbm_store_t *store = source_store(root, "a.js", text, hash, generation);
    ASSERT_NOT_NULL(store);
    cbm_source_evidence_request_t request = {.project = "source",
                                             .generation = generation,
                                             .file_path = "a.js",
                                             .source_hash = hash,
                                             .start_line = 1,
                                             .end_line = 250};
    int status = 0;
    yyjson_doc *doc = source_read(store, &request, &status);
    ASSERT_EQ(status, 200);
    ASSERT_NOT_NULL(doc);
    yyjson_val *result = yyjson_doc_get_root(doc);
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(result, "end_line")), 200);
    ASSERT_EQ(yyjson_get_len(yyjson_obj_get(result, "content")), 1000);
    ASSERT_FALSE(yyjson_get_bool(yyjson_obj_get(result, "complete")));
    yyjson_doc_free(doc);
    request.start_line = 199;
    doc = source_read(store, &request, &status);
    ASSERT_EQ(status, 200);
    ASSERT_TRUE(yyjson_get_bool(yyjson_obj_get(yyjson_doc_get_root(doc), "complete")));
    yyjson_doc_free(doc);
    cbm_store_close(store);
    th_cleanup(root);
    PASS();
}

TEST(source_evidence_reads_verified_installed_package_without_graph_node) {
    char *root = th_mktempdir("cbm_source_package");
    ASSERT_NOT_NULL(root);
    const char *path = "node_modules/example/index.js";
    const char *text = "export function identity(input) { return input; }\n";
    ASSERT_EQ(th_write_file(TH_PATH(root, path), text), 0);
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_store_upsert_project(store, "source", root), CBM_STORE_OK);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    char hash[65], generation[64];
    cbm_sha256_hex(text, strlen(text), hash);
    cbm_flow_file_t file = {.source_hash = hash,
                            .adapter = "ast",
                            .adapter_version = 1,
                            .package_id = "example",
                            .package_version = "1.0.0",
                            .package_manifest_hash = "manifest"};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "source", path, &file), CBM_STORE_OK);
    ASSERT_EQ(cbm_store_generation(store, generation, sizeof(generation)), CBM_STORE_OK);
    cbm_source_evidence_request_t request = {
        .project = "source", .generation = generation, .file_path = path, .source_hash = hash};
    int status = 0;
    yyjson_doc *doc = source_read(store, &request, &status);
    ASSERT_EQ(status, 200);
    ASSERT_NOT_NULL(doc);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(yyjson_doc_get_root(doc), "content")), text);
    yyjson_doc_free(doc);
    ASSERT_EQ(th_write_file(TH_PATH(root, path), "changed package body\n"), 0);
    doc = source_read(store, &request, &status);
    ASSERT_EQ(status, 409);
    ASSERT_NULL(yyjson_obj_get(yyjson_doc_get_root(doc), "content"));
    yyjson_doc_free(doc);
    cbm_store_close(store);
    th_cleanup(root);
    PASS();
}

SUITE(source_evidence) {
    RUN_TEST(source_evidence_returns_only_verified_snapshot_bytes_and_lines);
    RUN_TEST(source_evidence_rejects_generation_hash_and_dirty_bytes_without_exposing_them);
    RUN_TEST(source_evidence_requires_index_membership_and_root_containment);
    RUN_TEST(source_evidence_caps_complete_lines_and_marks_truncation);
    RUN_TEST(source_evidence_reads_verified_installed_package_without_graph_node);
}
