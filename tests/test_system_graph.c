#include "test_framework.h"
#include "test_helpers.h"
#include "foundation/compat.h"
#include "foundation/mem_core.h"
#include "foundation/platform.h"
#include "mcp/architecture_jobs.h"
#include "store/system_graph.h"
#include "store/flow_ir.h"
#include <sqlite3.h>
#include <yyjson/yyjson.h>

static cbm_store_t *sg_store(void) {
    cbm_store_t *store = cbm_store_open_memory();
    if (store)
        cbm_store_upsert_project(store, "system", "/tmp/system");
    return store;
}

static int64_t sg_node(cbm_store_t *store, const char *label, const char *name, const char *file,
                       const char *properties) {
    cbm_node_t node = {.project = "system",
                       .label = label,
                       .name = name,
                       .qualified_name = name,
                       .file_path = file,
                       .start_line = 3,
                       .end_line = 8,
                       .properties_json = properties};
    return cbm_store_upsert_node(store, &node);
}

static int64_t sg_edge(cbm_store_t *store, int64_t source, int64_t target, const char *type,
                       const char *properties) {
    cbm_edge_t edge = {.project = "system",
                       .source_id = source,
                       .target_id = target,
                       .type = type,
                       .properties_json = properties};
    return cbm_store_insert_edge(store, &edge);
}

static yyjson_val *sg_find(yyjson_val *array, const char *key, const char *value) {
    size_t i, count;
    yyjson_val *item;
    yyjson_arr_foreach(array, i, count, item) {
        const char *text = yyjson_get_str(yyjson_obj_get(item, key));
        if (text && strcmp(text, value) == 0)
            return item;
    }
    return NULL;
}

TEST(system_graph_preserves_cross_layer_witnesses_and_no_invented_links) {
    cbm_store_t *store = sg_store();
    ASSERT_NOT_NULL(store);
    int64_t fn = sg_node(store, "Function", "app.users", "app.py", "{}");
    int64_t db = sg_node(store, "Table", "schema.users", "schema.sql", "{}");
    int64_t deploy = sg_node(store, "Resource", "k8s.api", "deploy.yaml",
                             "{\"kind\":\"Deployment\",\"ecosystem\":\"kubernetes\"}");
    int64_t image = sg_node(store, "Image", "api:1", "Dockerfile", "{}");
    int64_t doc = sg_node(store, "Section", "guide.page_2", "guide.pdf",
                          "{\"page\":2,\"docstring\":\"API documentation\"}");
    int64_t diagram = sg_node(store, "DiagramElement", "diagram.api", "system.drawio", "{}");
    int64_t de = sg_edge(store, deploy, image, "DEPLOYS", "{\"via\":\"helm\",\"line\":12}");
    sg_edge(store, doc, fn, "MENTIONS", "{\"syntax\":\"pdf_qn\",\"line\":2}");
    sg_edge(store, diagram, doc, "DIAGRAM_ARROW", "{\"kind\":\"arrow\",\"line\":4}");
    (void)db; /* same users spelling must never invent app -> table. */
    const int changes = sqlite3_total_changes(cbm_store_get_db(store));
    char generation[64];
    ASSERT_EQ(cbm_store_generation(store, generation, sizeof(generation)), CBM_STORE_OK);
    char *json = NULL;
    ASSERT_EQ(cbm_store_system_graph(store, "system", NULL, &json), CBM_STORE_OK);
    ASSERT_NOT_NULL(json);
    yyjson_doc *parsed = yyjson_read(json, strlen(json), 0);
    ASSERT_NOT_NULL(parsed);
    yyjson_val *root = yyjson_doc_get_root(parsed);
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(root, "schema_version")), 1);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(root, "generation")), generation);
    ASSERT_TRUE(yyjson_get_bool(yyjson_obj_get(root, "complete")));
    yyjson_val *entities = yyjson_obj_get(root, "entities");
    yyjson_val *relations = yyjson_obj_get(root, "relations");
    ASSERT_EQ(yyjson_arr_size(entities), 6);
    ASSERT_EQ(yyjson_arr_size(relations), 3);
    yyjson_val *relation = sg_find(relations, "type", "DEPLOYS");
    ASSERT_NOT_NULL(relation);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(relation, "layer")), "deployment");
    yyjson_val *witness = yyjson_arr_get(yyjson_obj_get(relation, "witnesses"), 0);
    yyjson_val *ref = yyjson_obj_get(witness, "ref");
    ASSERT_EQ(yyjson_get_sint(yyjson_obj_get(ref, "edge_id")), de);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(ref, "project")), "system");
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(ref, "generation")), generation);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(yyjson_obj_get(witness, "properties"), "via")),
                  "helm");
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(yyjson_obj_get(witness, "location"), "line")), 12);
    relation = sg_find(relations, "type", "MENTIONS");
    witness = yyjson_arr_get(yyjson_obj_get(relation, "witnesses"), 0);
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(yyjson_obj_get(witness, "location"), "page")), 2);
    ASSERT_NULL(yyjson_obj_get(yyjson_obj_get(witness, "location"), "line"));
    ASSERT_FALSE(
        yyjson_get_bool(yyjson_obj_get(yyjson_obj_get(root, "capabilities"), "field_value_flow")));
    ASSERT_EQ(sqlite3_total_changes(cbm_store_get_db(store)), changes);
    yyjson_doc_free(parsed);
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    cbm_store_close(store);
    PASS();
}

TEST(system_graph_pdf_prefers_edge_page_and_labels_section_context) {
    for (int explicit_page = 0; explicit_page < 2; explicit_page++) {
        cbm_store_t *store = sg_store();
        int64_t doc = sg_node(store, "Section", "guide.page_2", "guide.pdf", "{\"page\":2}");
        int64_t code = sg_node(store, "Function", "app.users", "app.py", "{}");
        sg_edge(store, doc, code, "MENTIONS", explicit_page ? "{\"page\":7}" : "{}");
        char *json = NULL;
        ASSERT_EQ(cbm_store_system_graph(store, "system", NULL, &json), CBM_STORE_OK);
        yyjson_doc *parsed = yyjson_read(json, strlen(json), 0);
        yyjson_val *relation =
            yyjson_arr_get(yyjson_obj_get(yyjson_doc_get_root(parsed), "relations"), 0);
        yyjson_val *witness = yyjson_arr_get(yyjson_obj_get(relation, "witnesses"), 0);
        yyjson_val *location = yyjson_obj_get(witness, "location");
        ASSERT_EQ(yyjson_get_int(yyjson_obj_get(location, "page")), explicit_page ? 7 : 2);
        ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(location, "position_kind")),
                      explicit_page ? "relationship" : "source_context");
        yyjson_doc_free(parsed);
        cbm_free(CBM_MEM_CLASS_OTHER, json);
        cbm_store_close(store);
    }
    PASS();
}

TEST(system_graph_pdf_normalizes_canonical_page_strings_without_coercing_invalid_values) {
    const char *values[] = {"\"2\"",
                            "\"2147483647\"",
                            "\"02\"",
                            "\"0\"",
                            "\"-2\"",
                            "\"+2\"",
                            "\" 2\"",
                            "\"2 \"",
                            "\"2.0\"",
                            "\"2e0\"",
                            "\"2x\"",
                            "\"2\\u0000x\"",
                            "\"2147483648\"",
                            "2",
                            "0",
                            "-1",
                            "2.0",
                            "true",
                            "null",
                            "18446744073709551615"};
    for (size_t i = 0; i < sizeof(values) / sizeof(values[0]); i++) {
        int expected = i == 1 ? 2147483647 : (i == 0 || i == 13) ? 2 : 0;
        for (int on_edge = 0; on_edge < 2; on_edge++) {
            cbm_store_t *store = sg_store();
            char properties[128];
            snprintf(properties, sizeof(properties), "{\"page\":%s}", values[i]);
            int64_t doc = sg_node(store, "Section", "page", "guide.pdf",
                                  on_edge ? "{\"page\":8}" : properties);
            int64_t code = sg_node(store, "Function", "target", "app.py", "{}");
            sg_edge(store, doc, code, "MENTIONS", on_edge ? properties : "{\"line\":3}");
            char *json = NULL;
            ASSERT_EQ(cbm_store_system_graph(store, "system", NULL, &json), CBM_STORE_OK);
            yyjson_doc *parsed = yyjson_read(json, strlen(json), 0);
            yyjson_val *root = yyjson_doc_get_root(parsed);
            yyjson_val *entity =
                sg_find(yyjson_obj_get(root, "entities"), "file_path", "guide.pdf");
            if (!on_edge && expected) {
                yyjson_val *page = yyjson_obj_get(yyjson_obj_get(entity, "properties"), "page");
                ASSERT_TRUE(yyjson_is_int(page));
                ASSERT_EQ(yyjson_get_int(page), expected);
            } else if (!on_edge) {
                ASSERT_NULL(yyjson_obj_get(yyjson_obj_get(entity, "properties"), "page"));
            }
            yyjson_val *relation = yyjson_arr_get(yyjson_obj_get(root, "relations"), 0);
            yyjson_val *witness = yyjson_arr_get(yyjson_obj_get(relation, "witnesses"), 0);
            yyjson_val *location = yyjson_obj_get(witness, "location");
            int actual_expected = on_edge && !expected ? 8 : expected;
            ASSERT_EQ(yyjson_get_int(yyjson_obj_get(location, "page")), actual_expected);
            ASSERT_NULL(yyjson_obj_get(location, "line"));
            if (actual_expected)
                ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(location, "position_kind")),
                              on_edge && expected ? "relationship" : "source_context");
            yyjson_doc_free(parsed);
            cbm_free(CBM_MEM_CLASS_OTHER, json);
            cbm_store_close(store);
        }
    }
    PASS();
}

TEST(system_graph_limits_do_not_publish_dangling_relations) {
    cbm_store_t *store = sg_store();
    ASSERT_NOT_NULL(store);
    int64_t a = sg_node(store, "Function", "a", "a.c", "{}");
    int64_t b = sg_node(store, "Function", "b", "b.c", "{}");
    int64_t c = sg_node(store, "Function", "c", "c.c", "{}");
    sg_edge(store, a, b, "CALLS", "{}");
    sg_edge(store, b, c, "CALLS", "{}");
    cbm_system_graph_options_t opts = {.max_entities = 2, .max_relations = 1};
    char *json = NULL;
    ASSERT_EQ(cbm_store_system_graph(store, "system", &opts, &json), CBM_STORE_OK);
    yyjson_doc *parsed = yyjson_read(json, strlen(json), 0);
    ASSERT_NOT_NULL(parsed);
    yyjson_val *root = yyjson_doc_get_root(parsed);
    ASSERT_FALSE(yyjson_get_bool(yyjson_obj_get(root, "complete")));
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(root, "status")), "limited");
    yyjson_val *entities = yyjson_obj_get(root, "entities");
    yyjson_val *relations = yyjson_obj_get(root, "relations");
    ASSERT_EQ(yyjson_arr_size(entities), 2);
    ASSERT_EQ(yyjson_arr_size(relations), 1);
    yyjson_val *edge = yyjson_arr_get(relations, 0);
    ASSERT_NOT_NULL(sg_find(entities, "id", yyjson_get_str(yyjson_obj_get(edge, "source"))));
    ASSERT_NOT_NULL(sg_find(entities, "id", yyjson_get_str(yyjson_obj_get(edge, "target"))));
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(yyjson_obj_get(root, "limits"), "omitted_entities")),
              1);
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(yyjson_obj_get(root, "limits"), "omitted_relations")),
              1);
    yyjson_doc_free(parsed);
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    cbm_store_close(store);
    PASS();
}

TEST(system_graph_reports_unavailable_evidence_without_inventing_properties) {
    cbm_store_t *store = sg_store();
    ASSERT_NOT_NULL(store);
    int64_t a = sg_node(store, "Function", "a", "a.c", "{}");
    int64_t b = sg_node(store, "Function", "b", "b.c", "{}");
    sg_edge(store, a, b, "UNKNOWN_EXTENSION_EDGE", "{}");
    ASSERT_EQ(sqlite3_exec(cbm_store_get_db(store),
                           "UPDATE edges SET properties='[]' WHERE project='system'", NULL, NULL,
                           NULL),
              SQLITE_OK);
    char *json = NULL;
    ASSERT_EQ(cbm_store_system_graph(store, "system", NULL, &json), CBM_STORE_OK);
    yyjson_doc *parsed = yyjson_read(json, strlen(json), 0);
    ASSERT_NOT_NULL(parsed);
    yyjson_val *root = yyjson_doc_get_root(parsed);
    ASSERT_NOT_NULL(sg_find(yyjson_obj_get(root, "relations"), "type", "UNKNOWN_EXTENSION_EDGE"));
    ASSERT_NOT_NULL(sg_find(yyjson_obj_get(root, "gaps"), "code", "evidence_unavailable"));
    ASSERT_FALSE(yyjson_get_bool(yyjson_obj_get(root, "complete")));
    yyjson_doc_free(parsed);
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    cbm_store_close(store);
    PASS();
}

static bool sg_cancel(void *context) {
    (void)context;
    return true;
}

TEST(system_graph_unknown_empty_cancel_and_connection_reuse) {
    cbm_store_t *store = sg_store();
    ASSERT_NOT_NULL(store);
    char *json = NULL;
    ASSERT_EQ(cbm_store_system_graph(store, "absent", NULL, &json), CBM_STORE_NOT_FOUND);
    ASSERT_NULL(json);
    cbm_system_graph_options_t opts = {.cancel = sg_cancel};
    ASSERT_EQ(cbm_store_system_graph(store, "system", &opts, &json), CBM_STORE_CANCELLED);
    ASSERT_NULL(json);
    ASSERT_EQ(cbm_store_system_graph(store, "system", NULL, &json), CBM_STORE_OK);
    yyjson_doc *parsed = yyjson_read(json, strlen(json), 0);
    ASSERT_NOT_NULL(parsed);
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(yyjson_doc_get_root(parsed), "entities")), 0);
    yyjson_doc_free(parsed);
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    cbm_store_close(store);
    PASS();
}

TEST(system_graph_job_uses_store_generation_and_separate_cache) {
    char temp[256] = "/tmp/cbm_system_graph_XXXXXX";
    ASSERT_NOT_NULL(cbm_mkdtemp(temp));
    char path[1024];
    snprintf(path, sizeof(path), "%s/index.db", temp);
    cbm_store_t *store = cbm_store_open_path(path);
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_store_upsert_project(store, "system", temp), CBM_STORE_OK);
    sg_node(store, "Resource", "service", "service.yaml", "{\"kind\":\"Service\"}");
    char generation[64];
    ASSERT_EQ(cbm_store_generation(store, generation, sizeof(generation)), CBM_STORE_OK);
    cbm_store_t *reader = cbm_store_open_path_query(path);
    ASSERT_NOT_NULL(reader);
    cbm_architecture_jobs_t *jobs = cbm_architecture_jobs_new();
    ASSERT_NOT_NULL(jobs);
    bool ready = false, identity_matches = false, cached = false, rejected_stale = false;
    uint64_t deadline = cbm_now_ms() + 10000;
    do {
        char *json = cbm_architecture_jobs_request_system_graph(jobs, store, "system", generation);
        yyjson_doc *parsed = json ? yyjson_read(json, strlen(json), 0) : NULL;
        yyjson_val *root = parsed ? yyjson_doc_get_root(parsed) : NULL;
        const char *status = yyjson_get_str(yyjson_obj_get(root, "status"));
        ready = status && strcmp(status, "ready") == 0;
        bool pending = status && strcmp(status, "pending") == 0;
        if (ready) {
            const char *outer = yyjson_get_str(yyjson_obj_get(root, "generation"));
            const char *inner =
                yyjson_get_str(yyjson_obj_get(yyjson_obj_get(root, "result"), "generation"));
            identity_matches =
                outer && inner && strcmp(outer, generation) == 0 && strcmp(inner, generation) == 0;
        }
        yyjson_doc_free(parsed);
        cbm_free(CBM_MEM_CLASS_OTHER, json);
        if (!pending)
            break;
        cbm_usleep(1000);
    } while (cbm_now_ms() < deadline);
    if (ready) {
        /* A second connection's local data_version/total_changes cannot make
         * a source reference stale. Cache entries remain aspect-specific. */
        char *json = cbm_architecture_jobs_request_system_graph(jobs, reader, "system", generation);
        yyjson_doc *parsed = json ? yyjson_read(json, strlen(json), 0) : NULL;
        yyjson_val *root = parsed ? yyjson_doc_get_root(parsed) : NULL;
        const char *status = yyjson_get_str(yyjson_obj_get(root, "status"));
        cached = status && strcmp(status, "ready") == 0;
        yyjson_doc_free(parsed);
        cbm_free(CBM_MEM_CLASS_OTHER, json);
        json = cbm_architecture_jobs_request_system_graph(jobs, reader, "system", "stale");
        parsed = json ? yyjson_read(json, strlen(json), 0) : NULL;
        root = parsed ? yyjson_doc_get_root(parsed) : NULL;
        status = yyjson_get_str(yyjson_obj_get(root, "status"));
        rejected_stale = status && strcmp(status, "failed") == 0;
        yyjson_doc_free(parsed);
        cbm_free(CBM_MEM_CLASS_OTHER, json);
    }
    cbm_architecture_jobs_free(jobs);
    cbm_store_close(reader);
    cbm_store_close(store);
    th_rmtree(temp);
    ASSERT_TRUE(ready);
    ASSERT_TRUE(identity_matches);
    ASSERT_TRUE(cached);
    ASSERT_TRUE(rejected_stale);
    PASS();
}

TEST(system_graph_field_capability_requires_project_scoped_ready_values) {
    cbm_store_t *store = sg_store();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    ASSERT_EQ(cbm_store_upsert_project(store, "other", "/tmp/other"), CBM_STORE_OK);
    cbm_flow_value_t value = {.id = "parameter",
                              .symbol = "f",
                              .binding = "input",
                              .access_path = "[]",
                              .kind = "parameter",
                              .parameter_index = 0};
    cbm_flow_file_t file = {.source_hash = "snapshot",
                            .adapter = "fixture",
                            .adapter_version = 1,
                            .values = &value,
                            .value_count = 1};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "other", "a.js", &file), CBM_STORE_OK);
    for (int own = 0; own < 2; own++) {
        if (own)
            ASSERT_EQ(cbm_flow_ir_replace_file(store, "system", "a.js", &file), CBM_STORE_OK);
        char *json = NULL;
        ASSERT_EQ(cbm_store_system_graph(store, "system", NULL, &json), CBM_STORE_OK);
        yyjson_doc *doc = yyjson_read(json, strlen(json), 0);
        ASSERT_NOT_NULL(doc);
        yyjson_val *root = yyjson_doc_get_root(doc);
        ASSERT_EQ(yyjson_get_bool(
                      yyjson_obj_get(yyjson_obj_get(root, "capabilities"), "field_value_flow")),
                  own != 0);
        ASSERT_EQ(yyjson_get_int(
                      yyjson_obj_get(yyjson_obj_get(root, "flow_coverage"), "files_with_values")),
                  own);
        yyjson_doc_free(doc);
        cbm_free(CBM_MEM_CLASS_OTHER, json);
    }
    cbm_store_close(store);
    PASS();
}

TEST(system_graph_field_capability_excludes_obsolete_adapter_three) {
    cbm_store_t *store = sg_store();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    cbm_flow_value_t value = {.id = "parameter",
                              .symbol = "f",
                              .binding = "input",
                              .access_path = "[]",
                              .kind = "parameter",
                              .parameter_index = 0};
    cbm_flow_file_t file = {.source_hash = "snapshot",
                            .adapter = "tree-sitter-lexical-flow",
                            .values = &value,
                            .value_count = 1};
    for (int version = 3; version <= 4; version++) {
        file.adapter_version = version;
        ASSERT_EQ(cbm_flow_ir_replace_file(store, "system", "a.js", &file), CBM_STORE_OK);
        char *json = NULL;
        ASSERT_EQ(cbm_store_system_graph(store, "system", NULL, &json), CBM_STORE_OK);
        yyjson_doc *doc = yyjson_read(json, strlen(json), 0);
        ASSERT_NOT_NULL(doc);
        yyjson_val *root = yyjson_doc_get_root(doc);
        yyjson_val *coverage = yyjson_obj_get(root, "flow_coverage");
        ASSERT_EQ(yyjson_get_bool(
                      yyjson_obj_get(yyjson_obj_get(root, "capabilities"), "field_value_flow")),
                  version == 4);
        ASSERT_EQ(yyjson_get_int(yyjson_obj_get(coverage, "indexed_files")), 1);
        ASSERT_EQ(yyjson_get_int(yyjson_obj_get(coverage, "files_with_values")),
                  version == 4 ? 1 : 0);
        ASSERT_EQ(yyjson_get_int(yyjson_obj_get(coverage, "stale_files")), version == 3 ? 1 : 0);
        yyjson_doc_free(doc);
        cbm_free(CBM_MEM_CLASS_OTHER, json);
    }
    cbm_store_close(store);
    PASS();
}

SUITE(system_graph) {
    RUN_TEST(system_graph_preserves_cross_layer_witnesses_and_no_invented_links);
    RUN_TEST(system_graph_pdf_prefers_edge_page_and_labels_section_context);
    RUN_TEST(system_graph_pdf_normalizes_canonical_page_strings_without_coercing_invalid_values);
    RUN_TEST(system_graph_limits_do_not_publish_dangling_relations);
    RUN_TEST(system_graph_reports_unavailable_evidence_without_inventing_properties);
    RUN_TEST(system_graph_unknown_empty_cancel_and_connection_reuse);
    RUN_TEST(system_graph_job_uses_store_generation_and_separate_cache);
    RUN_TEST(system_graph_field_capability_requires_project_scoped_ready_values);
    RUN_TEST(system_graph_field_capability_excludes_obsolete_adapter_three);
}
