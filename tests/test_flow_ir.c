#include "test_framework.h"
#include "foundation/mem_core.h"
#include "store/flow_ir.h"
#include <sqlite3.h>
#include <yyjson/yyjson.h>

static cbm_store_t *flow_store(void) {
    cbm_store_t *store = cbm_store_open_memory();
    if (store)
        cbm_store_upsert_project(store, "flow", "/tmp/flow");
    return store;
}

static cbm_flow_value_t flow_value(const char *id, const char *binding, const char *path,
                                   int version) {
    return (cbm_flow_value_t){.id = id,
                              .symbol = "example.f",
                              .binding = binding,
                              .access_path = path,
                              .kind = "local",
                              .version = version,
                              .start_byte = version * 10,
                              .end_byte = version * 10 + 4,
                              .start_line = version + 1,
                              .end_line = version + 1,
                              .parameter_index = -1};
}

static bool flow_has(yyjson_val *array, const char *id) {
    size_t i, size;
    yyjson_val *item;
    yyjson_arr_foreach(array, i, size, item) {
        const char *actual = yyjson_get_str(yyjson_obj_get(item, "id"));
        if (actual && strcmp(actual, id) == 0)
            return true;
    }
    return false;
}

static yyjson_doc *flow_trace(cbm_store_t *store, const char *id, bool backward) {
    cbm_flow_trace_options_t opts = {.value_id = id, .backward = backward};
    char *json = NULL;
    if (cbm_flow_ir_trace(store, "flow", &opts, &json) != CBM_STORE_OK)
        return NULL;
    yyjson_doc *doc = yyjson_read(json, strlen(json), 0);
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    return doc;
}

TEST(flow_ir_preserves_versions_fields_and_real_transform_provenance) {
    cbm_store_t *store = flow_store();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    cbm_flow_value_t values[] = {flow_value("first", "scope1:user", "[\"email\"]", 0),
                                 flow_value("clean", "scope1:clean", "[]", 0),
                                 flow_value("overwrite", "scope1:user", "[\"email\"]", 1),
                                 flow_value("shadow", "scope2:user", "[\"email\"]", 0),
                                 flow_value("sibling", "scope1:user", "[\"name\"]", 0)};
    cbm_flow_operation_t ops[] = {{.id = "normalize",
                                   .symbol = "example.f",
                                   .kind = "transform",
                                   .operator_name = "trim",
                                   .start_byte = 20,
                                   .end_byte = 30,
                                   .start_line = 3,
                                   .end_line = 3}};
    cbm_flow_link_t links[] = {{.id = "e1",
                                .source = "first",
                                .target = "clean",
                                .operation_id = "normalize",
                                .kind = "transform",
                                .certainty = "derived"}};
    cbm_flow_file_t file = {.source_hash = "sha256:a",
                            .adapter = "fixture",
                            .adapter_version = 1,
                            .values = values,
                            .value_count = 5,
                            .operations = ops,
                            .operation_count = 1,
                            .links = links,
                            .link_count = 1};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "a.ts", &file), CBM_STORE_OK);
    const int changes = sqlite3_total_changes(cbm_store_get_db(store));
    yyjson_doc *doc = flow_trace(store, "first", false);
    ASSERT_NOT_NULL(doc);
    yyjson_val *root = yyjson_doc_get_root(doc);
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(root, "schema_version")), CBM_FLOW_IR_SCHEMA_VERSION);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(root, "analysis_kind")), "static_field_flow");
    yyjson_val *selected = yyjson_obj_get(root, "values");
    ASSERT_TRUE(flow_has(selected, "first"));
    ASSERT_TRUE(flow_has(selected, "clean"));
    ASSERT_FALSE(flow_has(selected, "overwrite"));
    ASSERT_FALSE(flow_has(selected, "shadow"));
    ASSERT_FALSE(flow_has(selected, "sibling"));
    yyjson_val *edge = yyjson_arr_get(yyjson_obj_get(root, "links"), 0);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(edge, "certainty")), "derived");
    yyjson_val *operation = yyjson_arr_get(yyjson_obj_get(root, "operations"), 0);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(operation, "operator_name")), "trim");
    ASSERT_EQ(sqlite3_total_changes(cbm_store_get_db(store)), changes);
    yyjson_doc_free(doc);
    cbm_store_close(store);
    PASS();
}

TEST(flow_ir_call_returns_match_site_in_both_directions) {
    cbm_store_t *store = flow_store();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    cbm_flow_value_t values[] = {flow_value("a", "a", "[]", 0),
                                 flow_value("b", "b", "[]", 0),
                                 flow_value("param", "param", "[]", 0),
                                 flow_value("ret", "ret", "[]", 0),
                                 flow_value("a_result", "a_result", "[]", 0),
                                 flow_value("b_result", "b_result", "[]", 0)};
    cbm_flow_operation_t ops[] = {
        {.id = "call_a", .kind = "call", .symbol = "example.f", .operator_name = ""},
        {.id = "call_b", .kind = "call", .symbol = "example.f", .operator_name = ""},
        {.id = "body", .kind = "return", .symbol = "example.identity", .operator_name = ""}};
    cbm_flow_link_t links[] = {{.id = "arg_a",
                                .source = "a",
                                .target = "param",
                                .operation_id = "call_a",
                                .kind = "argument",
                                .certainty = "proven",
                                .callsite_id = "call_a"},
                               {.id = "arg_b",
                                .source = "b",
                                .target = "param",
                                .operation_id = "call_b",
                                .kind = "argument",
                                .certainty = "proven",
                                .callsite_id = "call_b"},
                               {.id = "body_flow",
                                .source = "param",
                                .target = "ret",
                                .operation_id = "body",
                                .kind = "assign",
                                .certainty = "proven"},
                               {.id = "return_a",
                                .source = "ret",
                                .target = "a_result",
                                .operation_id = "call_a",
                                .kind = "return",
                                .certainty = "proven",
                                .callsite_id = "call_a"},
                               {.id = "return_b",
                                .source = "ret",
                                .target = "b_result",
                                .operation_id = "call_b",
                                .kind = "return",
                                .certainty = "proven",
                                .callsite_id = "call_b"}};
    cbm_flow_file_t file = {.source_hash = "sha256:a",
                            .adapter = "fixture",
                            .adapter_version = 1,
                            .values = values,
                            .value_count = 6,
                            .operations = ops,
                            .operation_count = 3,
                            .links = links,
                            .link_count = 5};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "calls.c", &file), CBM_STORE_OK);
    yyjson_doc *doc = flow_trace(store, "a", false);
    ASSERT_NOT_NULL(doc);
    yyjson_val *selected = yyjson_obj_get(yyjson_doc_get_root(doc), "values");
    ASSERT_TRUE(flow_has(selected, "a_result"));
    ASSERT_FALSE(flow_has(selected, "b_result"));
    yyjson_doc_free(doc);
    doc = flow_trace(store, "a_result", true);
    ASSERT_NOT_NULL(doc);
    selected = yyjson_obj_get(yyjson_doc_get_root(doc), "values");
    ASSERT_TRUE(flow_has(selected, "a"));
    ASSERT_FALSE(flow_has(selected, "b"));
    yyjson_doc_free(doc);
    cbm_store_close(store);
    PASS();
}

TEST(flow_ir_unknown_and_control_links_do_not_claim_field_transport) {
    cbm_store_t *store = flow_store();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    cbm_flow_value_t values[] = {flow_value("a", "a", "[]", 0),
                                 flow_value("conditioned", "conditioned", "[]", 0),
                                 flow_value("opaque", "opaque", "[]", 0)};
    cbm_flow_operation_t ops[] = {
        {.id = "op", .kind = "unknown", .symbol = "example.f", .operator_name = ""}};
    cbm_flow_link_t links[] = {{.id = "control",
                                .source = "a",
                                .target = "conditioned",
                                .operation_id = "op",
                                .kind = "control",
                                .certainty = "control"},
                               {.id = "unknown",
                                .source = "a",
                                .target = "opaque",
                                .operation_id = "op",
                                .kind = "unknown",
                                .certainty = "unknown"}};
    cbm_flow_file_t file = {.source_hash = "sha256:a",
                            .adapter = "fixture",
                            .adapter_version = 1,
                            .values = values,
                            .value_count = 3,
                            .operations = ops,
                            .operation_count = 1,
                            .links = links,
                            .link_count = 2};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "a.py", &file), CBM_STORE_OK);
    yyjson_doc *doc = flow_trace(store, "a", false);
    ASSERT_NOT_NULL(doc);
    yyjson_val *root = yyjson_doc_get_root(doc);
    ASSERT_FALSE(yyjson_get_bool(yyjson_obj_get(root, "complete")));
    ASSERT_GT(yyjson_arr_size(yyjson_obj_get(root, "gaps")), 0);
    yyjson_val *selected = yyjson_obj_get(root, "values");
    ASSERT_FALSE(flow_has(selected, "conditioned"));
    ASSERT_FALSE(flow_has(selected, "opaque"));
    yyjson_doc_free(doc);
    cbm_store_close(store);
    PASS();
}

TEST(flow_ir_atomic_replace_keeps_old_partition_on_invalid_links) {
    cbm_store_t *store = flow_store();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    cbm_flow_value_t value = flow_value("old", "old", "[]", 0);
    cbm_flow_file_t file = {.source_hash = "sha256:a",
                            .adapter = "fixture",
                            .adapter_version = 1,
                            .values = &value,
                            .value_count = 1};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "a.rs", &file), CBM_STORE_OK);
    cbm_flow_operation_t op = {
        .id = "op", .kind = "assign", .symbol = "example.f", .operator_name = ""};
    cbm_flow_link_t broken = {.id = "broken",
                              .source = "new",
                              .target = "absent",
                              .operation_id = "op",
                              .kind = "assign",
                              .certainty = "proven"};
    value = flow_value("new", "new", "[]", 0);
    file.source_hash = "sha256:b";
    file.operations = &op;
    file.operation_count = 1;
    file.links = &broken;
    file.link_count = 1;
    ASSERT_NEQ(cbm_flow_ir_replace_file(store, "flow", "a.rs", &file), CBM_STORE_OK);
    yyjson_doc *doc = flow_trace(store, "old", false);
    ASSERT_NOT_NULL(doc);
    ASSERT_TRUE(flow_has(yyjson_obj_get(yyjson_doc_get_root(doc), "values"), "old"));
    yyjson_doc_free(doc);
    cbm_store_close(store);
    PASS();
}

TEST(flow_ir_body_dependency_invalidation_and_project_isolation) {
    cbm_store_t *store = flow_store();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    cbm_flow_value_t value = flow_value("callee", "callee", "[]", 0);
    cbm_flow_file_t file = {.source_hash = "sha256:a",
                            .adapter = "fixture",
                            .adapter_version = 1,
                            .values = &value,
                            .value_count = 1};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "callee.go", &file), CBM_STORE_OK);
    value = flow_value("caller", "caller", "[]", 0);
    const char *dependencies[] = {"callee.go"};
    file.dependencies = dependencies;
    file.dependency_count = 1;
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "caller.go", &file), CBM_STORE_OK);
    value = flow_value("callee_new", "callee", "[]", 1);
    file.dependencies = NULL;
    file.dependency_count = 0;
    file.source_hash = "sha256:changed_body_same_signature";
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "callee.go", &file), CBM_STORE_OK);
    yyjson_doc *doc = flow_trace(store, "caller", false);
    ASSERT_NOT_NULL(doc);
    yyjson_val *root = yyjson_doc_get_root(doc);
    ASSERT_FALSE(yyjson_get_bool(yyjson_obj_get(root, "complete")));
    ASSERT_GT(yyjson_arr_size(yyjson_obj_get(root, "gaps")), 0);
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(root, "links")), 0);
    yyjson_doc_free(doc);
    cbm_store_upsert_project(store, "other", "/tmp/other");
    cbm_flow_trace_options_t opts = {.value_id = "callee_new"};
    char *json = NULL;
    ASSERT_EQ(cbm_flow_ir_trace(store, "other", &opts, &json), CBM_STORE_NOT_FOUND);
    ASSERT_NULL(json);
    cbm_store_close(store);
    PASS();
}

TEST(flow_ir_source_selector_requires_unique_occurrence_and_generation) {
    cbm_store_t *store = flow_store();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    cbm_flow_value_t values[] = {flow_value("old", "input", "[\"email\"]", 0),
                                 flow_value("new", "input", "[\"email\"]", 1)};
    cbm_flow_file_t file = {.source_hash = "fixture",
                            .adapter = "fixture",
                            .adapter_version = 1,
                            .values = values,
                            .value_count = 2};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "a.ts", &file), CBM_STORE_OK);
    cbm_flow_trace_options_t opts = {
        .file_path = "a.ts", .symbol = "example.f", .access_path = "[\"email\"]"};
    char *json = NULL;
    ASSERT_EQ(cbm_flow_ir_trace(store, "flow", &opts, &json), CBM_STORE_OK);
    yyjson_doc *doc = yyjson_read(json, strlen(json), 0);
    ASSERT_NOT_NULL(doc);
    yyjson_val *root = yyjson_doc_get_root(doc);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(root, "status")), "selection_required");
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(root, "values")), 2);
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(root, "paths")), 0);
    yyjson_doc_free(doc);
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    opts.has_start_byte = true;
    opts.start_byte = 10;
    ASSERT_EQ(cbm_flow_ir_trace(store, "flow", &opts, &json), CBM_STORE_OK);
    doc = yyjson_read(json, strlen(json), 0);
    ASSERT_NOT_NULL(doc);
    root = yyjson_doc_get_root(doc);
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(root, "values")), 1);
    ASSERT_TRUE(flow_has(yyjson_obj_get(root, "values"), "new"));
    yyjson_doc_free(doc);
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    opts.expected_generation = "wrong_generation";
    json = NULL;
    ASSERT_EQ(cbm_flow_ir_trace(store, "flow", &opts, &json), CBM_STORE_ERR);
    ASSERT_NULL(json);
    cbm_store_close(store);
    PASS();
}

TEST(flow_ir_file_without_values_exposes_adapter_gap_source) {
    cbm_store_t *store = flow_store();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    cbm_flow_gap_t gap = {.code = "unsupported_construct",
                          .message = "A dynamic property.",
                          .symbol = "example.f",
                          .start_byte = 20,
                          .end_byte = 40,
                          .start_line = 3};
    cbm_flow_file_t file = {.source_hash = "snapshot-hash",
                            .adapter = "fixture",
                            .adapter_version = 1,
                            .gaps = &gap,
                            .gap_count = 1};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "a.ts", &file), CBM_STORE_OK);
    cbm_flow_trace_options_t opts = {.file_path = "a.ts"};
    char *json = NULL;
    ASSERT_EQ(cbm_flow_ir_trace(store, "flow", &opts, &json), CBM_STORE_OK);
    yyjson_doc *doc = yyjson_read(json, strlen(json), 0);
    ASSERT_NOT_NULL(doc);
    yyjson_val *root = yyjson_doc_get_root(doc);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(root, "status")), "limited");
    ASSERT_FALSE(yyjson_get_bool(yyjson_obj_get(root, "complete")));
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(root, "values")), 0);
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(root, "paths")), 0);
    yyjson_val *first = yyjson_arr_get(yyjson_obj_get(root, "gaps"), 0);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(first, "symbol")), "example.f");
    yyjson_val *source = yyjson_obj_get(first, "source");
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(source, "start_byte")), 20);
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(source, "end_byte")), 40);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(source, "source_hash")), "snapshot-hash");
    yyjson_doc_free(doc);
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    cbm_store_close(store);
    PASS();
}

TEST(flow_ir_cross_file_join_requires_exact_source_site_and_declaration_proof) {
    cbm_store_t *store = flow_store();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    cbm_node_t caller = {.project = "flow",
                         .label = "Function",
                         .name = "f",
                         .qualified_name = "flow.caller.f",
                         .file_path = "caller.ts",
                         .start_line = 1,
                         .end_line = 10,
                         .properties_json = "{}"};
    cbm_node_t callee = {.project = "flow",
                         .label = "Function",
                         .name = "identity",
                         .qualified_name = "flow.callee.identity",
                         .file_path = "callee.ts",
                         .start_line = 1,
                         .end_line = 3,
                         .properties_json = "{}"};
    int64_t caller_id = cbm_store_upsert_node(store, &caller);
    int64_t callee_id = cbm_store_upsert_node(store, &callee);
    ASSERT_GT(caller_id, 0);
    ASSERT_GT(callee_id, 0);
    cbm_flow_value_t formal[] = {flow_value("formal", "arg", "[]", 0),
                                 flow_value("returned", "return", "[]", 0)};
    formal[0].symbol = formal[1].symbol = "identity@0";
    formal[0].kind = "parameter";
    formal[0].parameter_index = 0;
    formal[1].kind = "return";
    cbm_flow_operation_t return_op = {
        .id = "return", .symbol = "identity@0", .kind = "return", .operator_name = ""};
    cbm_flow_link_t body = {.id = "body",
                            .source = "formal",
                            .target = "returned",
                            .operation_id = "return",
                            .kind = "assign",
                            .certainty = "proven"};
    const char *parameters[] = {"formal"};
    cbm_flow_function_t function = {.symbol = "identity@0",
                                    .name = "identity",
                                    .return_value_id = "returned",
                                    .parameter_value_ids = parameters,
                                    .parameter_count = 1,
                                    .start_byte = 0,
                                    .end_byte = 40,
                                    .start_line = 1,
                                    .end_line = 3,
                                    .positional = true};
    cbm_flow_file_t file = {.source_hash = "callee-hash",
                            .adapter = "fixture",
                            .adapter_version = 1,
                            .values = formal,
                            .value_count = 2,
                            .operations = &return_op,
                            .operation_count = 1,
                            .links = &body,
                            .link_count = 1,
                            .functions = &function,
                            .function_count = 1};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "callee.ts", &file), CBM_STORE_OK);

    cbm_flow_value_t actual[] = {
        flow_value("first", "a", "[]", 0), flow_value("second", "b", "[]", 0),
        flow_value("first_result", "x", "[]", 0), flow_value("second_result", "y", "[]", 0)};
    cbm_flow_operation_t calls[] = {{.id = "call1",
                                     .symbol = "example.f",
                                     .kind = "call",
                                     .operator_name = "identity",
                                     .start_byte = 20,
                                     .end_byte = 31,
                                     .start_line = 3,
                                     .end_line = 3},
                                    {.id = "call2",
                                     .symbol = "example.f",
                                     .kind = "call",
                                     .operator_name = "identity",
                                     .start_byte = 40,
                                     .end_byte = 51,
                                     .start_line = 5,
                                     .end_line = 5}};
    const char *arguments1[] = {"first"}, *arguments2[] = {"second"};
    cbm_flow_callsite_t sites[] = {{.operation_id = "call1",
                                    .result_value_id = "first_result",
                                    .symbol = "example.f",
                                    .argument_value_ids = arguments1,
                                    .argument_count = 1,
                                    .start_byte = 20,
                                    .end_byte = 31,
                                    .positional = true},
                                   {.operation_id = "call2",
                                    .result_value_id = "second_result",
                                    .symbol = "example.f",
                                    .argument_value_ids = arguments2,
                                    .argument_count = 1,
                                    .start_byte = 40,
                                    .end_byte = 51,
                                    .positional = true}};
    cbm_flow_link_t unknown[] = {{.id = "unknown1",
                                  .source = "first",
                                  .target = "first_result",
                                  .operation_id = "call1",
                                  .kind = "unknown",
                                  .certainty = "unknown"},
                                 {.id = "unknown2",
                                  .source = "second",
                                  .target = "second_result",
                                  .operation_id = "call2",
                                  .kind = "unknown",
                                  .certainty = "unknown"}};
    file = (cbm_flow_file_t){.source_hash = "caller-hash",
                             .adapter = "fixture",
                             .adapter_version = 1,
                             .values = actual,
                             .value_count = 4,
                             .operations = calls,
                             .operation_count = 2,
                             .links = unknown,
                             .link_count = 2,
                             .callsites = sites,
                             .callsite_count = 2};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "caller.ts", &file), CBM_STORE_OK);
    cbm_flow_binding_t binding = {.caller_file = "caller.ts",
                                  .caller_hash = "stale",
                                  .callee_file = "callee.ts",
                                  .callee_hash = "callee-hash",
                                  .operation_id = "call1",
                                  .callee_symbol = "identity@0",
                                  .caller_qn = caller.qualified_name,
                                  .callee_qn = callee.qualified_name,
                                  .strategy = "lsp_direct",
                                  .certainty = "proven",
                                  .caller_node_id = caller_id,
                                  .callee_node_id = callee_id,
                                  .site_start_byte = 20,
                                  .site_end_byte = 31};
    ASSERT_NEQ(cbm_flow_ir_bind_call(store, "flow", &binding), CBM_STORE_OK);
    binding.caller_hash = "caller-hash";
    binding.site_start_byte = 21;
    ASSERT_NEQ(cbm_flow_ir_bind_call(store, "flow", &binding), CBM_STORE_OK);
    yyjson_doc *doc = flow_trace(store, "first", false);
    ASSERT_NOT_NULL(doc);
    ASSERT_FALSE(flow_has(yyjson_obj_get(yyjson_doc_get_root(doc), "values"), "first_result"));
    yyjson_doc_free(doc);
    binding.site_start_byte = 20;
    ASSERT_EQ(cbm_flow_ir_bind_call(store, "flow", &binding), CBM_STORE_OK);
    binding.operation_id = "call2";
    binding.site_start_byte = 40;
    binding.site_end_byte = 51;
    ASSERT_EQ(cbm_flow_ir_bind_call(store, "flow", &binding), CBM_STORE_OK);
    doc = flow_trace(store, "first", false);
    ASSERT_NOT_NULL(doc);
    yyjson_val *root = yyjson_doc_get_root(doc);
    ASSERT_TRUE(flow_has(yyjson_obj_get(root, "values"), "first_result"));
    ASSERT_FALSE(flow_has(yyjson_obj_get(root, "values"), "second_result"));
    yyjson_val *edge = yyjson_arr_get(yyjson_obj_get(root, "links"), 0);
    yyjson_val *proof = yyjson_obj_get(edge, "resolution");
    ASSERT_NOT_NULL(proof);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(proof, "strategy")), "lsp_direct");
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(proof, "source_hash")), "caller-hash");
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(proof, "callee_qn")), callee.qualified_name);
    yyjson_doc_free(doc);
    cbm_store_close(store);
    PASS();
}

TEST(flow_ir_stale_target_cannot_receive_a_proven_transport_link) {
    cbm_store_t *store = flow_store();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    cbm_flow_file_t file = {.source_hash = "leaf-1", .adapter = "fixture", .adapter_version = 1};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "leaf.c", &file), CBM_STORE_OK);
    cbm_flow_value_t target = flow_value("target", "target", "[]", 0);
    const char *dependencies[] = {"leaf.c"};
    file = (cbm_flow_file_t){.source_hash = "target",
                             .adapter = "fixture",
                             .adapter_version = 1,
                             .values = &target,
                             .value_count = 1,
                             .dependencies = dependencies,
                             .dependency_count = 1};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "target.c", &file), CBM_STORE_OK);
    cbm_flow_value_t source = flow_value("source", "source", "[]", 0);
    cbm_flow_operation_t operation = {
        .id = "transport", .symbol = "example.f", .kind = "assign", .operator_name = "="};
    cbm_flow_link_t link = {.id = "edge",
                            .source = "source",
                            .target = "target",
                            .operation_id = "transport",
                            .kind = "assign",
                            .certainty = "proven"};
    file = (cbm_flow_file_t){.source_hash = "source",
                             .adapter = "fixture",
                             .adapter_version = 1,
                             .values = &source,
                             .value_count = 1,
                             .operations = &operation,
                             .operation_count = 1,
                             .links = &link,
                             .link_count = 1};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "source.c", &file), CBM_STORE_OK);
    file = (cbm_flow_file_t){.source_hash = "leaf-2", .adapter = "fixture", .adapter_version = 1};
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "leaf.c", &file), CBM_STORE_OK);
    yyjson_doc *doc = flow_trace(store, "source", false);
    ASSERT_NOT_NULL(doc);
    yyjson_val *root = yyjson_doc_get_root(doc);
    ASSERT_FALSE(yyjson_get_bool(yyjson_obj_get(root, "complete")));
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(root, "links")), 0);
    yyjson_doc_free(doc);
    cbm_store_close(store);
    PASS();
}

static bool flow_has_gap(yyjson_val *root, const char *code) {
    size_t i, count;
    yyjson_val *entry;
    yyjson_arr_foreach(yyjson_obj_get(root, "gaps"), i, count, entry) {
        const char *actual = yyjson_get_str(yyjson_obj_get(entry, "code"));
        if (actual && strcmp(actual, code) == 0)
            return true;
    }
    return false;
}

TEST(flow_ir_obsolete_lexical_adapter_is_blocked_but_other_v1_adapters_remain_valid) {
    const struct {
        const char *adapter;
        int version;
        bool obsolete;
    } cases[] = {{"tree-sitter-lexical-flow", 1, true},
                 {"tree-sitter-lexical-flow", 2, true},
                 {"tree-sitter-lexical-flow", 3, true},
                 {"tree-sitter-lexical-flow", 4, false},
                 {"fixture", 1, false}};
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        bool obsolete = cases[i].obsolete;
        cbm_store_t *store = flow_store();
        ASSERT_NOT_NULL(store);
        ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
        cbm_flow_value_t values[] = {flow_value("input", "input", "[]", 0),
                                     flow_value("returned", "a", "[\"email\"]", 0)};
        cbm_flow_operation_t op = {.id = "old-heap-read",
                                   .symbol = "example.f",
                                   .kind = "field_read",
                                   .operator_name = ""};
        cbm_flow_link_t link = {.id = "old-proof",
                                .source = "input",
                                .target = "returned",
                                .operation_id = "old-heap-read",
                                .kind = "assign",
                                .certainty = "proven"};
        cbm_flow_file_t file = {.source_hash = "unchanged",
                                .adapter = cases[i].adapter,
                                .adapter_version = cases[i].version,
                                .values = values,
                                .value_count = 2,
                                .operations = &op,
                                .operation_count = 1,
                                .links = &link,
                                .link_count = 1};
        ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "old.js", &file), CBM_STORE_OK);
        for (int backward = 0; backward < 2; backward++) {
            yyjson_doc *doc = flow_trace(store, backward ? "returned" : "input", backward != 0);
            ASSERT_NOT_NULL(doc);
            yyjson_val *root = yyjson_doc_get_root(doc);
            ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(root, "links")), obsolete ? 0 : 1);
            ASSERT_EQ(flow_has(yyjson_obj_get(root, "values"), backward ? "input" : "returned"),
                      !obsolete);
            ASSERT_EQ(flow_has_gap(root, "adapter_upgrade_required"), obsolete);
            if (obsolete)
                ASSERT_FALSE(yyjson_get_bool(yyjson_obj_get(root, "complete")));
            yyjson_doc_free(doc);
        }
        cbm_store_close(store);
    }
    PASS();
}

TEST(flow_ir_obsolete_link_owner_cannot_connect_current_value_partitions) {
    cbm_store_t *store = flow_store();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    const char *names[] = {"input", "returned"};
    for (size_t i = 0; i < 2; i++) {
        cbm_flow_value_t value = flow_value(names[i], names[i], "[]", 0);
        cbm_flow_file_t file = {.source_hash = "current",
                                .adapter = "tree-sitter-lexical-flow",
                                .adapter_version = 4,
                                .values = &value,
                                .value_count = 1};
        ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", names[i], &file), CBM_STORE_OK);
    }
    cbm_flow_operation_t op = {
        .id = "old-link-owner", .symbol = "example.f", .kind = "assign", .operator_name = "="};
    cbm_flow_link_t link = {.id = "old-proof",
                            .source = "input",
                            .target = "returned",
                            .operation_id = "old-link-owner",
                            .kind = "assign",
                            .certainty = "proven"};
    cbm_flow_file_t file = {.source_hash = "legacy",
                            .adapter = "tree-sitter-lexical-flow",
                            .adapter_version = 1,
                            .operations = &op,
                            .operation_count = 1,
                            .links = &link,
                            .link_count = 1};
    for (int version = 1; version <= 3; version++) {
        file.adapter_version = version;
        ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", "old-owner.js", &file), CBM_STORE_OK);
        for (int backward = 0; backward < 2; backward++) {
            yyjson_doc *doc = flow_trace(store, backward ? "returned" : "input", backward != 0);
            ASSERT_NOT_NULL(doc);
            yyjson_val *root = yyjson_doc_get_root(doc);
            ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(root, "links")), 0);
            ASSERT_FALSE(flow_has(yyjson_obj_get(root, "values"), backward ? "input" : "returned"));
            ASSERT_TRUE(flow_has_gap(root, "adapter_upgrade_required"));
            ASSERT_FALSE(yyjson_get_bool(yyjson_obj_get(root, "complete")));
            yyjson_doc_free(doc);
        }
    }
    cbm_store_close(store);
    PASS();
}

SUITE(flow_ir) {
    RUN_TEST(flow_ir_preserves_versions_fields_and_real_transform_provenance);
    RUN_TEST(flow_ir_call_returns_match_site_in_both_directions);
    RUN_TEST(flow_ir_unknown_and_control_links_do_not_claim_field_transport);
    RUN_TEST(flow_ir_atomic_replace_keeps_old_partition_on_invalid_links);
    RUN_TEST(flow_ir_body_dependency_invalidation_and_project_isolation);
    RUN_TEST(flow_ir_source_selector_requires_unique_occurrence_and_generation);
    RUN_TEST(flow_ir_file_without_values_exposes_adapter_gap_source);
    RUN_TEST(flow_ir_cross_file_join_requires_exact_source_site_and_declaration_proof);
    RUN_TEST(flow_ir_stale_target_cannot_receive_a_proven_transport_link);
    RUN_TEST(flow_ir_obsolete_lexical_adapter_is_blocked_but_other_v1_adapters_remain_valid);
    RUN_TEST(flow_ir_obsolete_link_owner_cannot_connect_current_value_partitions);
}
