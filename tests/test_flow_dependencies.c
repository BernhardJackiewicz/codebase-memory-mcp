#include "test_framework.h"
#include "test_helpers.h"
#include "pipeline/flow_dependencies.h"
#include "pipeline/pipeline.h"
#include "store/flow_ir.h"
#include "foundation/sha256.h"
#include "foundation/mem_core.h"
#include <sqlite3.h>
#include <yyjson/yyjson.h>

static const char *dependency_source = "export function identity(value) { return value; }";
static const char *dependency_manifest = "{\"name\":\"example\",\"version\":\"1.2.3\"}";

static bool dependency_fixture(const char *root) {
    return th_write_file(TH_PATH(root, "node_modules/example/package.json"), dependency_manifest) ==
               0 &&
           th_write_file(TH_PATH(root, "node_modules/example/index.js"), dependency_source) == 0;
}

static bool dependency_has_gap(const cbm_flow_dependency_snapshot_t *snapshot, const char *code) {
    for (size_t i = 0; i < snapshot->gap_count; i++)
        if (strcmp(snapshot->gaps[i].code, code) == 0)
            return true;
    return false;
}

TEST(flow_dependencies_disabled_does_not_read_installed_packages) {
    char *root = th_mktempdir("cbm_flow_dependency_off");
    ASSERT_NOT_NULL(root);
    ASSERT_TRUE(dependency_fixture(root));
    cbm_flow_dependency_snapshot_t *snapshot = NULL;
    ASSERT_EQ(cbm_flow_dependencies_snapshot(root, NULL, &snapshot), CBM_STORE_OK);
    ASSERT_FALSE(snapshot->enabled);
    ASSERT_EQ(snapshot->source_count, 0);
    cbm_flow_dependencies_free(snapshot);
    th_cleanup(root);
    PASS();
}

TEST(flow_dependencies_exact_package_identity_and_body_hash) {
    char *root = th_mktempdir("cbm_flow_dependency_identity");
    ASSERT_NOT_NULL(root);
    ASSERT_TRUE(dependency_fixture(root));
    ASSERT_EQ(th_write_file(TH_PATH(root, "node_modules/not-allowed/index.js"), "secret"), 0);
    cbm_flow_dependency_snapshot_t *snapshot = NULL;
    ASSERT_EQ(cbm_flow_dependencies_snapshot(root, "example", &snapshot), CBM_STORE_OK);
    ASSERT_TRUE(snapshot->enabled);
    ASSERT_EQ(snapshot->source_count, 1);
    const cbm_flow_dependency_source_t *source = &snapshot->sources[0];
    ASSERT_STR_EQ(source->file_path, "node_modules/example/index.js");
    ASSERT_STR_EQ(source->package_id, "npm:example");
    ASSERT_STR_EQ(source->package_version, "1.2.3");
    ASSERT_STR_EQ(source->source, dependency_source);
    char hash[65];
    cbm_sha256_hex(dependency_source, strlen(dependency_source), hash);
    ASSERT_STR_EQ(source->source_hash, hash);
    cbm_sha256_hex(dependency_manifest, strlen(dependency_manifest), hash);
    ASSERT_STR_EQ(source->package_manifest_hash, hash);
    cbm_flow_dependencies_free(snapshot);
    th_cleanup(root);
    PASS();
}

TEST(flow_dependencies_digest_changes_for_body_manifest_removal_and_optout) {
    char *root = th_mktempdir("cbm_flow_dependency_digest");
    ASSERT_NOT_NULL(root);
    ASSERT_TRUE(dependency_fixture(root));
    cbm_flow_dependency_snapshot_t *first = NULL, *body = NULL, *version = NULL, *removed = NULL,
                                   *off = NULL;
    ASSERT_EQ(cbm_flow_dependencies_snapshot(root, "example", &first), CBM_STORE_OK);
    ASSERT_EQ(th_write_file(TH_PATH(root, "node_modules/example/index.js"),
                            "export function identity(value) { return 0; }"),
              0);
    ASSERT_EQ(cbm_flow_dependencies_snapshot(root, "example", &body), CBM_STORE_OK);
    ASSERT_NEQ(strcmp(first->digest, body->digest), 0);
    ASSERT_EQ(th_write_file(TH_PATH(root, "node_modules/example/package.json"),
                            "{\"name\":\"example\",\"version\":\"1.2.4\"}"),
              0);
    ASSERT_EQ(cbm_flow_dependencies_snapshot(root, "example", &version), CBM_STORE_OK);
    ASSERT_NEQ(strcmp(body->digest, version->digest), 0);
    ASSERT_EQ(cbm_unlink(TH_PATH(root, "node_modules/example/index.js")), 0);
    ASSERT_EQ(cbm_flow_dependencies_snapshot(root, "example", &removed), CBM_STORE_OK);
    ASSERT_NEQ(strcmp(version->digest, removed->digest), 0);
    ASSERT_EQ(cbm_flow_dependencies_snapshot(root, NULL, &off), CBM_STORE_OK);
    ASSERT_NEQ(strcmp(removed->digest, off->digest), 0);
    cbm_flow_dependencies_free(first);
    cbm_flow_dependencies_free(body);
    cbm_flow_dependencies_free(version);
    cbm_flow_dependencies_free(removed);
    cbm_flow_dependencies_free(off);
    th_cleanup(root);
    PASS();
}

TEST(flow_dependencies_missing_and_other_ecosystems_are_explicit_gaps) {
    char *root = th_mktempdir("cbm_flow_dependency_missing");
    ASSERT_NOT_NULL(root);
    cbm_flow_dependency_snapshot_t *snapshot = NULL;
    ASSERT_EQ(cbm_flow_dependencies_snapshot(root, "missing,pypi:requests", &snapshot),
              CBM_STORE_OK);
    ASSERT_EQ(snapshot->source_count, 0);
    ASSERT_TRUE(dependency_has_gap(snapshot, "dependency_missing"));
    ASSERT_TRUE(dependency_has_gap(snapshot, "dependency_ecosystem"));
    cbm_flow_dependencies_free(snapshot);
    th_cleanup(root);
    PASS();
}

TEST(flow_dependencies_reject_escape_and_manifest_name_mismatch) {
    char *root = th_mktempdir("cbm_flow_dependency_escape");
    ASSERT_NOT_NULL(root);
    ASSERT_TRUE(dependency_fixture(root));
    ASSERT_EQ(th_write_file(TH_PATH(root, "node_modules/example/package.json"),
                            "{\"name\":\"different\",\"version\":\"1.2.3\"}"),
              0);
    cbm_flow_dependency_snapshot_t *snapshot = NULL;
    ASSERT_EQ(cbm_flow_dependencies_snapshot(root, "../outside,example", &snapshot), CBM_STORE_OK);
    ASSERT_EQ(snapshot->source_count, 0);
    ASSERT_TRUE(dependency_has_gap(snapshot, "dependency_name"));
    ASSERT_TRUE(dependency_has_gap(snapshot, "dependency_manifest"));
    cbm_flow_dependencies_free(snapshot);
    th_cleanup(root);
    PASS();
}

TEST(flow_dependencies_never_follow_package_or_file_symlinks) {
#ifdef _WIN32
    SKIP_PLATFORM("POSIX symlink fixture");
#else
    const char *temporary = th_mktempdir("cbm_flow_dependency_symlink");
    char *root = temporary ? strdup(temporary) : NULL;
    temporary = th_mktempdir("cbm_flow_dependency_external");
    char *outside = temporary ? strdup(temporary) : NULL;
    ASSERT_NOT_NULL(root);
    ASSERT_NOT_NULL(outside);
    ASSERT_TRUE(dependency_fixture(root));
    ASSERT_EQ(th_write_file(TH_PATH(outside, "secret.js"), dependency_source), 0);
    ASSERT_EQ(symlink(TH_PATH(outside, "secret.js"), TH_PATH(root, "node_modules/example/link.js")),
              0);
    ASSERT_EQ(symlink(outside, TH_PATH(root, "node_modules/external")), 0);
    cbm_flow_dependency_snapshot_t *snapshot = NULL;
    ASSERT_EQ(cbm_flow_dependencies_snapshot(root, "example,external", &snapshot), CBM_STORE_OK);
    ASSERT_EQ(snapshot->source_count, 1);
    ASSERT_TRUE(dependency_has_gap(snapshot, "dependency_boundary"));
    cbm_flow_dependencies_free(snapshot);
    th_cleanup(root);
    th_cleanup(outside);
    free(root);
    free(outside);
    PASS();
#endif
}

static bool dependency_index(const char *root, const char *database) {
    cbm_pipeline_t *pipeline = cbm_pipeline_new(root, database, CBM_MODE_FAST);
    if (!pipeline)
        return false;
    bool ok = cbm_pipeline_set_project_name(pipeline, "dependency-index") &&
              cbm_pipeline_run(pipeline) == 0;
    cbm_pipeline_free(pipeline);
    return ok;
}

static bool dependency_stored_hash(cbm_store_t *store, char hash[65]) {
    sqlite3_stmt *statement = NULL;
    bool ok = sqlite3_prepare_v2(
                  cbm_store_get_db(store),
                  "SELECT source_hash FROM cbm_flow_files WHERE project='dependency-index' "
                  "AND file_path='node_modules/example/index.js'",
                  -1, &statement, NULL) == SQLITE_OK &&
              sqlite3_step(statement) == SQLITE_ROW;
    if (ok)
        snprintf(hash, 65, "%s", sqlite3_column_text(statement, 0));
    sqlite3_finalize(statement);
    return ok;
}

static bool dependency_return_trace(cbm_store_t *store, bool *reaches_return) {
    sqlite3_stmt *statement = NULL;
    char id[4096] = {0};
    bool found = sqlite3_prepare_v2(
                     cbm_store_get_db(store),
                     "SELECT id FROM cbm_flow_values WHERE project='dependency-index' "
                     "AND file_path='node_modules/example/index.js' AND kind='parameter' LIMIT 1",
                     -1, &statement, NULL) == SQLITE_OK &&
                 sqlite3_step(statement) == SQLITE_ROW;
    if (found)
        snprintf(id, sizeof(id), "%s", sqlite3_column_text(statement, 0));
    sqlite3_finalize(statement);
    if (!found)
        return false;
    cbm_flow_trace_options_t options = {.value_id = id};
    char *json = NULL;
    if (cbm_flow_ir_trace(store, "dependency-index", &options, &json) != CBM_STORE_OK)
        return false;
    yyjson_doc *doc = yyjson_read(json, strlen(json), 0);
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    if (!doc)
        return false;
    *reaches_return = false;
    bool provenance = true;
    char manifest_hash[65];
    cbm_sha256_hex(dependency_manifest, strlen(dependency_manifest), manifest_hash);
    yyjson_val *values = yyjson_obj_get(yyjson_doc_get_root(doc), "values");
    size_t index, count;
    yyjson_val *value;
    yyjson_arr_foreach(values, index, count, value) {
        const char *kind = yyjson_get_str(yyjson_obj_get(value, "kind"));
        if (kind && strcmp(kind, "return") == 0)
            *reaches_return = true;
        yyjson_val *package = yyjson_obj_get(value, "package");
        const char *id = yyjson_get_str(yyjson_obj_get(package, "id"));
        const char *version = yyjson_get_str(yyjson_obj_get(package, "version"));
        const char *actual_hash = yyjson_get_str(yyjson_obj_get(package, "manifest_hash"));
        if (!id || strcmp(id, "npm:example") != 0 || !version || strcmp(version, "1.2.3") != 0 ||
            !actual_hash || strcmp(actual_hash, manifest_hash) != 0)
            provenance = false;
    }
    yyjson_doc_free(doc);
    return provenance;
}

/* Keep the process environment and temporary stores isolated even when the
 * expected Red fails before the dependency publication hook is connected. */
static bool dependency_full_delta_case(void) {
    bool ok = false;
    const char *temporary = th_mktempdir("cbm_flow_dependency_index");
    char *root = temporary ? strdup(temporary) : NULL;
    temporary = th_mktempdir("cbm_flow_dependency_databases");
    char *databases = temporary ? strdup(temporary) : NULL;
    const char *previous = getenv(CBM_FLOW_DEPENDENCIES_ENV);
    char *saved = previous ? strdup(previous) : NULL;
    cbm_store_t *store = NULL, *full = NULL;
    bool reaches_return = false;
    char database[1024], full_database[1024], hash[65], expected[65], before[64], after[64];
    if (!root || !databases || (previous && !saved))
        goto finish;
    snprintf(database, sizeof(database), "%s/incremental.db", databases);
    snprintf(full_database, sizeof(full_database), "%s/full.db", databases);
    if (!dependency_fixture(root) ||
        th_write_file(TH_PATH(root, "app.js"), "export function app(input) { return input; }") !=
            0 ||
        cbm_setenv(CBM_FLOW_DEPENDENCIES_ENV, "example", 1) != 0 ||
        !dependency_index(root, database))
        goto finish;
    store = cbm_store_open_path(database);
    if (!store || !dependency_stored_hash(store, hash) ||
        cbm_store_generation(store, before, sizeof(before)) != CBM_STORE_OK ||
        !dependency_return_trace(store, &reaches_return) || !reaches_return)
        goto finish;
    cbm_sha256_hex(dependency_source, strlen(dependency_source), expected);
    if (strcmp(hash, expected) != 0)
        goto finish;
    cbm_store_close(store);
    store = NULL;
    const char *changed = "export function identity(value) { return 0; }";
    if (th_write_file(TH_PATH(root, "node_modules/example/index.js"), changed) != 0 ||
        !dependency_index(root, database) || !dependency_index(root, full_database))
        goto finish;
    store = cbm_store_open_path(database);
    full = cbm_store_open_path(full_database);
    if (!store || !full || !dependency_stored_hash(store, hash) ||
        cbm_store_generation(store, after, sizeof(after)) != CBM_STORE_OK ||
        strcmp(before, after) == 0)
        goto finish;
    cbm_sha256_hex(changed, strlen(changed), expected);
    if (strcmp(hash, expected) != 0 || !dependency_stored_hash(full, hash) ||
        strcmp(hash, expected) != 0 || !dependency_return_trace(store, &reaches_return) ||
        reaches_return || !dependency_return_trace(full, &reaches_return) || reaches_return)
        goto finish;
    cbm_store_close(store);
    store = NULL;
    cbm_store_close(full);
    full = NULL;
    if (cbm_unsetenv(CBM_FLOW_DEPENDENCIES_ENV) != 0 || !dependency_index(root, database))
        goto finish;
    store = cbm_store_open_path(database);
    if (!store || dependency_stored_hash(store, hash))
        goto finish;
    ok = true;
finish:
    if (store)
        cbm_store_close(store);
    if (full)
        cbm_store_close(full);
    if (saved)
        (void)cbm_setenv(CBM_FLOW_DEPENDENCIES_ENV, saved, 1);
    else
        (void)cbm_unsetenv(CBM_FLOW_DEPENDENCIES_ENV);
    free(saved);
    if (root)
        th_cleanup(root);
    if (databases)
        th_cleanup(databases);
    free(root);
    free(databases);
    return ok;
}

TEST(flow_dependencies_body_change_and_optout_invalidate_full_and_delta_snapshots) {
    ASSERT_TRUE(dependency_full_delta_case());
    PASS();
}

TEST(flow_dependencies_scoped_package_and_nested_boundary_are_explicit) {
    char *root = th_mktempdir("cbm_flow_dependency_scoped");
    ASSERT_NOT_NULL(root);
    ASSERT_EQ(th_write_file(TH_PATH(root, "node_modules/@team/library/package.json"),
                            "{\"name\":\"@team/library\",\"version\":\"2.0.0\"}"),
              0);
    ASSERT_EQ(th_write_file(TH_PATH(root, "node_modules/@team/library/src/main.ts"),
                            "export function identity(value: string) { return value; }"),
              0);
    ASSERT_EQ(
        th_write_file(TH_PATH(root, "node_modules/@team/library/node_modules/hidden/index.js"),
                      "export function hidden(value) { return value; }"),
        0);
    cbm_flow_dependency_snapshot_t *snapshot = NULL;
    ASSERT_EQ(cbm_flow_dependencies_snapshot(root, "@team/library,@team/library", &snapshot),
              CBM_STORE_OK);
    ASSERT_EQ(snapshot->source_count, 1);
    ASSERT_STR_EQ(snapshot->sources[0].package_id, "npm:@team/library");
    ASSERT_TRUE(dependency_has_gap(snapshot, "dependency_boundary"));
    cbm_flow_dependencies_free(snapshot);
    th_cleanup(root);
    PASS();
}

TEST(flow_dependencies_file_limit_keeps_partial_coverage_explicit) {
    char *root = th_mktempdir("cbm_flow_dependency_limit");
    ASSERT_NOT_NULL(root);
    ASSERT_EQ(
        th_write_file(TH_PATH(root, "node_modules/example/package.json"), dependency_manifest), 0);
    for (int i = 0; i < 514; i++) {
        char path[1024];
        snprintf(path, sizeof(path), "%s/node_modules/example/file-%04d.js", root, i);
        ASSERT_EQ(th_write_file(path, dependency_source), 0);
    }
    cbm_flow_dependency_snapshot_t *snapshot = NULL;
    ASSERT_EQ(cbm_flow_dependencies_snapshot(root, "example", &snapshot), CBM_STORE_OK);
    ASSERT_EQ(snapshot->source_count, 512);
    ASSERT_TRUE(snapshot->limited);
    ASSERT_TRUE(dependency_has_gap(snapshot, "dependency_limit"));
    cbm_flow_dependencies_free(snapshot);
    th_cleanup(root);
    PASS();
}

static yyjson_doc *dependency_path_trace(cbm_store_t *store, const char *path) {
    sqlite3_stmt *statement = NULL;
    char id[4096] = {0};
    if (sqlite3_prepare_v2(cbm_store_get_db(store),
                           "SELECT id FROM cbm_flow_values WHERE project='dependency-index' "
                           "AND file_path=?1 AND kind='parameter' ORDER BY start_byte LIMIT 1",
                           -1, &statement, NULL) == SQLITE_OK) {
        sqlite3_bind_text(statement, 1, path, -1, SQLITE_TRANSIENT);
        if (sqlite3_step(statement) == SQLITE_ROW)
            snprintf(id, sizeof(id), "%s", sqlite3_column_text(statement, 0));
    }
    sqlite3_finalize(statement);
    cbm_flow_trace_options_t options = {.value_id = id};
    char *json = NULL;
    if (!id[0] || cbm_flow_ir_trace(store, "dependency-index", &options, &json) != CBM_STORE_OK)
        return NULL;
    yyjson_doc *doc = yyjson_read(json, strlen(json), 0);
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    return doc;
}
static yyjson_doc *dependency_app_trace(cbm_store_t *store) {
    return dependency_path_trace(store, "app.js");
}

static bool dependency_path_returns(yyjson_doc *doc, const char *path) {
    size_t i, count;
    yyjson_val *value;
    yyjson_arr_foreach(yyjson_obj_get(yyjson_doc_get_root(doc), "values"), i, count, value) {
        const char *file = yyjson_get_str(yyjson_obj_get(value, "file_path"));
        const char *kind = yyjson_get_str(yyjson_obj_get(value, "kind"));
        if (file && kind && !strcmp(file, path) && !strcmp(kind, "return"))
            return true;
    }
    return false;
}
static bool dependency_app_returns(yyjson_doc *doc) {
    return dependency_path_returns(doc, "app.js");
}

/* Runs the real indexing routes. No manually inserted graph node or resolver
 * fact can make the package source appear resolved in this test. */
static bool dependency_package_workflow(void) {
    bool ok = false;
    const char *temporary = th_mktempdir("cbm_package_call");
    char *root = temporary ? strdup(temporary) : NULL;
    temporary = th_mktempdir("cbm_package_call_db");
    char *databases = temporary ? strdup(temporary) : NULL;
    const char *previous = getenv(CBM_FLOW_DEPENDENCIES_ENV);
    char *saved = previous ? strdup(previous) : NULL;
    cbm_store_t *store = NULL;
    yyjson_doc *trace = NULL;
    char database[1024], full_database[1024];
    const char *manifest = "{\"name\":\"example\",\"version\":\"1.2.3\",\"type\":\"module\","
                           "\"exports\":{\".\":\"./index.js\"}}";
    const char *app = "import { identity as selected } from 'example';\n"
                      "export function app(input) { return selected(input); }\n";
    if (!root || !databases || (previous && !saved))
        goto finish;
    snprintf(database, sizeof(database), "%s/delta.db", databases);
    snprintf(full_database, sizeof(full_database), "%s/full.db", databases);
    if (th_write_file(TH_PATH(root, "app.js"), app) ||
        th_write_file(TH_PATH(root, "node_modules/example/package.json"), manifest) ||
        th_write_file(TH_PATH(root, "node_modules/example/index.js"), dependency_source) ||
        cbm_setenv(CBM_FLOW_DEPENDENCIES_ENV, "example", 1) || !dependency_index(root, database))
        goto finish;
    store = cbm_store_open_path_query(database);
    trace = store ? dependency_app_trace(store) : NULL;
    if (!trace || !dependency_app_returns(trace))
        goto finish;
    bool package_proof = false;
    size_t i, count;
    yyjson_val *link;
    yyjson_arr_foreach(yyjson_obj_get(yyjson_doc_get_root(trace), "links"), i, count, link) {
        yyjson_val *proof = yyjson_obj_get(link, "resolution");
        const char *kind = yyjson_get_str(yyjson_obj_get(proof, "proof_kind"));
        if (!kind || strcmp(kind, "package_export"))
            continue;
        yyjson_val *package = yyjson_obj_get(proof, "package");
        yyjson_val *import = yyjson_obj_get(proof, "import");
        char hash[65];
        cbm_sha256_hex(manifest, strlen(manifest), hash);
        if (!yyjson_equals_str(yyjson_obj_get(package, "id"), "npm:example") ||
            !yyjson_equals_str(yyjson_obj_get(package, "version"), "1.2.3") ||
            !yyjson_equals_str(yyjson_obj_get(package, "manifest_hash"), hash) ||
            !yyjson_equals_str(yyjson_obj_get(import, "local_name"), "selected") ||
            !yyjson_equals_str(yyjson_obj_get(import, "imported_name"), "identity") ||
            yyjson_get_int(yyjson_obj_get(import, "start_byte")) != 0 ||
            yyjson_get_int(yyjson_obj_get(import, "end_byte")) != 47)
            goto finish;
        package_proof = true;
    }
    if (!package_proof)
        goto finish;
    yyjson_doc_free(trace);
    trace = NULL;
    cbm_store_close(store);
    store = NULL;
    if (th_write_file(TH_PATH(root, "node_modules/example/index.js"),
                      "export function identity(value) { return 0; }") ||
        !dependency_index(root, database) || !dependency_index(root, full_database))
        goto finish;
    const char *paths[] = {database, full_database};
    for (size_t p = 0; p < 2; p++) {
        store = cbm_store_open_path_query(paths[p]);
        trace = store ? dependency_app_trace(store) : NULL;
        if (!trace || dependency_app_returns(trace))
            goto finish;
        yyjson_doc_free(trace);
        trace = NULL;
        cbm_store_close(store);
        store = NULL;
    }
    /* Equal spelling, a conditional exports map, a mutable export or a local
     * shadow cannot stand in for a verified import/export binding. */
    const char *apps[] = {
        "import { identity } from 'example'; export function app(input, identity) { return "
        "identity(input); }",
        "import { identity } from 'example'; export function app(input) { return identity(input); "
        "}",
        "import { identity } from 'example'; export function app(input) { return identity(input); "
        "}",
    };
    const char *manifests[] = {
        manifest,
        "{\"name\":\"example\",\"version\":\"1.2.3\",\"type\":\"module\",\"exports\":{\"import\":"
        "\"./index.js\",\"require\":\"./other.js\"}}",
        manifest};
    const char *sources[] = {
        dependency_source, dependency_source,
        "export function identity(value) { return value; } identity = value => 0;"};
    for (size_t p = 0; p < 3; p++) {
        if (th_write_file(TH_PATH(root, "app.js"), apps[p]) ||
            th_write_file(TH_PATH(root, "node_modules/example/package.json"), manifests[p]) ||
            th_write_file(TH_PATH(root, "node_modules/example/index.js"), sources[p]) ||
            !dependency_index(root, database))
            goto finish;
        store = cbm_store_open_path_query(database);
        trace = store ? dependency_app_trace(store) : NULL;
        if (!trace || dependency_app_returns(trace))
            goto finish;
        yyjson_doc_free(trace);
        trace = NULL;
        cbm_store_close(store);
        store = NULL;
    }
    ok = true;
finish:
    yyjson_doc_free(trace);
    cbm_store_close(store);
    if (saved)
        (void)cbm_setenv(CBM_FLOW_DEPENDENCIES_ENV, saved, 1);
    else
        (void)cbm_unsetenv(CBM_FLOW_DEPENDENCIES_ENV);
    free(saved);
    if (root) {
        th_cleanup(root);
        free(root);
    }
    if (databases) {
        th_cleanup(databases);
        free(databases);
    }
    return ok;
}

TEST(flow_dependencies_real_package_import_return_and_body_invalidation) {
    ASSERT_TRUE(dependency_package_workflow());
    PASS();
}

TEST(flow_dependencies_manifest_identity_rejects_nul_and_duplicate_fields) {
    char *root = th_mktempdir("cbm_pkg_identity");
    ASSERT_NOT_NULL(root);
    ASSERT_EQ(th_write_file(TH_PATH(root, "node_modules/example/index.js"), dependency_source), 0);
    const char *manifests[] = {
        "{\"name\":\"example\\u0000suffix\",\"version\":\"1.2.3\"}",
        "{\"name\":\"example\",\"version\":\"1.2.3\\u0000suffix\"}",
        "{\"name\":\"example\",\"version\":\"1.2.3\",\"version\":\"2.0.0\"}",
    };
    for (size_t i = 0; i < sizeof(manifests) / sizeof(manifests[0]); i++) {
        ASSERT_EQ(th_write_file(TH_PATH(root, "node_modules/example/package.json"), manifests[i]),
                  0);
        cbm_flow_dependency_snapshot_t *snapshot = NULL;
        ASSERT_EQ(cbm_flow_dependencies_snapshot(root, "example", &snapshot), CBM_STORE_OK);
        ASSERT_EQ(snapshot->source_count, 0);
        ASSERT_TRUE(dependency_has_gap(snapshot, "dependency_manifest"));
        cbm_flow_dependencies_free(snapshot);
    }
    th_cleanup(root);
    PASS();
}

typedef struct {
    const char *label, *app_path, *app, *manifest, *body_path, *body, *extra_path, *extra;
    bool resolves;
    bool invalidate_after;
} dependency_case;

static bool dependency_resolution_case(const dependency_case *test) {
    bool ok = false;
    const char *temporary = th_mktempdir("cbm_pkg_case");
    char *root = temporary ? strdup(temporary) : NULL;
    temporary = th_mktempdir("cbm_pkg_case_db");
    char *databases = temporary ? strdup(temporary) : NULL;
    const char *previous = getenv(CBM_FLOW_DEPENDENCIES_ENV);
    char *saved = previous ? strdup(previous) : NULL;
    cbm_store_t *store = NULL;
    yyjson_doc *trace = NULL;
    char database[1024];
    if (!root || !databases || (previous && !saved))
        goto finish;
    snprintf(database, sizeof(database), "%s/test.db", databases);
    if (th_write_file(TH_PATH(root, test->app_path), test->app) ||
        th_write_file(TH_PATH(root, "node_modules/example/package.json"), test->manifest) ||
        th_write_file(TH_PATH(root, test->body_path), test->body) ||
        (test->extra_path && !test->invalidate_after &&
         th_write_file(TH_PATH(root, test->extra_path), test->extra)) ||
        cbm_setenv(CBM_FLOW_DEPENDENCIES_ENV, "example", 1) || !dependency_index(root, database))
        goto finish;
    store = cbm_store_open_path_query(database);
    trace = store ? dependency_path_trace(store, test->app_path) : NULL;
    ok = trace && dependency_path_returns(trace, test->app_path) == test->resolves;
    if (ok && !test->resolves)
        ok = yyjson_arr_size(yyjson_obj_get(yyjson_doc_get_root(trace), "gaps")) > 0;
    if (ok && test->invalidate_after) {
        yyjson_doc_free(trace);
        trace = NULL;
        cbm_store_close(store);
        store = NULL;
        char full_database[1024];
        snprintf(full_database, sizeof(full_database), "%s/full.db", databases);
        ok = test->extra_path && !th_write_file(TH_PATH(root, test->extra_path), test->extra) &&
             dependency_index(root, database) && dependency_index(root, full_database);
        const char *paths[] = {database, full_database};
        for (size_t i = 0; ok && i < 2; i++) {
            store = cbm_store_open_path_query(paths[i]);
            trace = store ? dependency_path_trace(store, test->app_path) : NULL;
            ok = trace && !dependency_path_returns(trace, test->app_path) &&
                 yyjson_arr_size(yyjson_obj_get(yyjson_doc_get_root(trace), "gaps")) > 0;
            yyjson_doc_free(trace);
            trace = NULL;
            cbm_store_close(store);
            store = NULL;
        }
    }
finish:
    if (!ok)
        fprintf(stderr, "package resolution case failed: %s\n", test->label);
    yyjson_doc_free(trace);
    cbm_store_close(store);
    if (saved)
        (void)cbm_setenv(CBM_FLOW_DEPENDENCIES_ENV, saved, 1);
    else
        (void)cbm_unsetenv(CBM_FLOW_DEPENDENCIES_ENV);
    free(saved);
    if (root) {
        th_cleanup(root);
        free(root);
    }
    if (databases) {
        th_cleanup(databases);
        free(databases);
    }
    return ok;
}

TEST(flow_dependencies_native_esm_resolution_boundaries) {
    const char *app = "import { identity } from 'example'; export function app(input) { return "
                      "identity(input); }";
    const char *manifest = "{\"name\":\"example\",\"version\":\"1.2.3\",\"type\":\"module\","
                           "\"exports\":{\".\":\"./index.js\"}}";
    dependency_case cases[] = {
        {"main", "app.js", app,
         "{\"name\":\"example\",\"version\":\"1.2.3\",\"type\":\"module\",\"main\":\"index.js\"}",
         "node_modules/example/index.js", dependency_source, NULL, NULL, true, false},
        {"subpath-mjs", "app.js",
         "import { identity } from 'example/identity'; export function app(input) { return "
         "identity(input); }",
         "{\"name\":\"example\",\"version\":\"1.2.3\",\"exports\":{\"./identity\":\"./lib.mjs\"}}",
         "node_modules/example/lib.mjs", dependency_source, NULL, NULL, true, false},
        {"mixed-exports", "app.js", app,
         "{\"name\":\"example\",\"version\":\"1.2.3\",\"type\":\"module\",\"exports\":{\".\":\"./"
         "index.js\",\"import\":\"./other.js\"}}",
         "node_modules/example/index.js", dependency_source, NULL, NULL, false, false},
        {"nested-package-scope", "app.js", app,
         "{\"name\":\"example\",\"version\":\"1.2.3\",\"type\":\"module\",\"exports\":\"./lib/"
         "index.js\"}",
         "node_modules/example/lib/index.js", dependency_source,
         "node_modules/example/lib/package.json", "{\"type\":\"commonjs\"}", false, false},
        {"nearer-node-modules", "src/app.js", app, manifest, "node_modules/example/index.js",
         dependency_source, "src/node_modules/example/package.json",
         "{\"name\":\"example\",\"main\":\"other.js\"}", false, false},
        {"package-self-reference", "app.js", app, manifest, "node_modules/example/index.js",
         dependency_source, "package.json",
         "{\"name\":\"example\",\"type\":\"module\",\"exports\":\"./own.js\"}", false, false},
        {"duplicate-import", "app.js",
         "import { identity, other as identity } from 'example'; export function app(input) { "
         "return identity(input); }",
         manifest, "node_modules/example/index.js", dependency_source, NULL, NULL, false, false},
        {"export-list-conflict", "app.js", app, manifest, "node_modules/example/index.js",
         "export function identity(value) { return value; } function zero() { return 0; } export { "
         "zero as identity };",
         NULL, NULL, false, false},
        {"loop-mutates-export", "app.js", app, manifest, "node_modules/example/index.js",
         "export function identity(value) { return value; } for (identity of [value => 0]) {}",
         NULL, NULL, false, false},
        {"parenthesized-eval", "app.js", app, manifest, "node_modules/example/index.js",
         "export function identity(value) { return value; } (eval)('identity = value => 0');", NULL,
         NULL, false, false},
        {"import-attributes", "app.js",
         "import { identity } from 'example' with { type: 'json' }; export function app(input) { "
         "return identity(input); }",
         manifest, "node_modules/example/index.js", dependency_source, NULL, NULL, false, false},
        {"commonjs", "app.js", app,
         "{\"name\":\"example\",\"version\":\"1.2.3\",\"main\":\"index.js\"}",
         "node_modules/example/index.js", dependency_source, NULL, NULL, false, false},
        {"ts-paths-unsupported", "app.ts", app, manifest, "node_modules/example/index.js",
         dependency_source, NULL, NULL, false, false},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++)
        ASSERT_TRUE(dependency_resolution_case(&cases[i]));
    PASS();
}

TEST(flow_dependencies_resolution_environment_invalidates_unchanged_sources) {
    const char *app = "import { identity } from 'example'; export function app(input) { return "
                      "identity(input); }";
    dependency_case cases[] = {
        {"new-nearer-node-modules", "src/app.js", app,
         "{\"name\":\"example\",\"version\":\"1.2.3\",\"type\":\"module\",\"exports\":\"./"
         "index.js\"}",
         "node_modules/example/index.js", dependency_source,
         "src/node_modules/example/package.json", "{\"name\":\"example\",\"main\":\"other.js\"}",
         true, true},
        {"new-nested-package-scope", "app.js", app,
         "{\"name\":\"example\",\"version\":\"1.2.3\",\"type\":\"module\",\"exports\":\"./lib/"
         "index.js\"}",
         "node_modules/example/lib/index.js", dependency_source,
         "node_modules/example/lib/package.json", "{\"type\":\"commonjs\"}", true, true},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++)
        ASSERT_TRUE(dependency_resolution_case(&cases[i]));
    PASS();
}

SUITE(flow_dependencies) {
    RUN_TEST(flow_dependencies_disabled_does_not_read_installed_packages);
    RUN_TEST(flow_dependencies_exact_package_identity_and_body_hash);
    RUN_TEST(flow_dependencies_digest_changes_for_body_manifest_removal_and_optout);
    RUN_TEST(flow_dependencies_missing_and_other_ecosystems_are_explicit_gaps);
    RUN_TEST(flow_dependencies_reject_escape_and_manifest_name_mismatch);
    RUN_TEST(flow_dependencies_never_follow_package_or_file_symlinks);
    RUN_TEST(flow_dependencies_body_change_and_optout_invalidate_full_and_delta_snapshots);
    RUN_TEST(flow_dependencies_scoped_package_and_nested_boundary_are_explicit);
    RUN_TEST(flow_dependencies_file_limit_keeps_partial_coverage_explicit);
    RUN_TEST(flow_dependencies_real_package_import_return_and_body_invalidation);
    RUN_TEST(flow_dependencies_manifest_identity_rejects_nul_and_duplicate_fields);
    RUN_TEST(flow_dependencies_native_esm_resolution_boundaries);
    RUN_TEST(flow_dependencies_resolution_environment_invalidates_unchanged_sources);
}
