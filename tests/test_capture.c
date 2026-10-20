#include "test_framework.h"
#include "traces/capture.h"
#include "foundation/mem_core.h"
#include "foundation/json_writer.h"
#include <yyjson/yyjson.h>

static const char *capture_start =
    "{\"project\":\"demo\",\"generation\":\"index-a\",\"profile\":\"node\","
    "\"values_enabled\":false,\"allowed_fields\":[],\"allowed_origin\":\"http://localhost:3000\"}";
static const char *capture_payload =
    "{\"schema_version\":1,\"producer\":{\"id\":\"worker-a\",\"language\":\"typescript\"},"
    "\"events\":[{\"sequence\":1,\"operation\":\"transform\",\"invocation_id\":\"call-1\","
    "\"value_id\":\"out-1\",\"inputs\":[\"in-1\"],\"access_path\":\"profile.email\","
    "\"source\":{\"file_path\":\"src/users.ts\",\"line\":12,\"source_hash\":\"abc\"},"
    "\"preview\":\"private@example.test\"}]}";

static yyjson_doc *capture_json(char *text) {
    yyjson_doc *doc = text ? yyjson_read(text, strlen(text), 0) : NULL;
    cbm_free(CBM_MEM_CLASS_OTHER, text);
    return doc;
}
static const char *capture_check(void *context, const char *file, const char *hash) {
    return strcmp(file, "src/users.ts") == 0 && strcmp(hash, "abc") == 0 ? "matched" : "stale";
}

TEST(capture_requires_explicit_session_and_token_and_exact_origin) {
    cbm_capture_manager_t *m = cbm_capture_new();
    int status = 0;
    yyjson_doc *start = capture_json(cbm_capture_create(m, capture_start, &status));
    ASSERT_EQ(status, 201);
    ASSERT_NOT_NULL(start);
    yyjson_val *root = yyjson_doc_get_root(start);
    const char *id = yyjson_get_str(yyjson_obj_get(yyjson_obj_get(root, "session"), "id"));
    const char *token = yyjson_get_str(yyjson_obj_get(root, "token"));
    ASSERT_NOT_NULL(id);
    ASSERT_NOT_NULL(token);
    ASSERT_TRUE(cbm_capture_authorized(m, id, token));
    ASSERT_FALSE(cbm_capture_authorized(m, id, "wrong-token"));
    ASSERT_TRUE(cbm_capture_origin_allowed(m, id, "http://localhost:3000"));
    ASSERT_FALSE(cbm_capture_origin_allowed(m, id, "http://localhost:3001"));
    ASSERT_FALSE(cbm_capture_origin_allowed(m, id, "https://untrusted.example"));
    yyjson_doc *reply =
        capture_json(cbm_capture_ingest(m, id, "wrong-token", "", capture_payload,
                                        strlen(capture_payload), capture_check, NULL, &status));
    ASSERT_EQ(status, 403);
    yyjson_doc_free(reply);
    yyjson_doc_free(start);
    cbm_capture_free(m);
    PASS();
}

TEST(capture_field_events_keep_identity_and_omit_unapproved_values) {
    cbm_capture_manager_t *m = cbm_capture_new();
    int status = 0;
    yyjson_doc *start = capture_json(cbm_capture_create(m, capture_start, &status));
    ASSERT_EQ(status, 201);
    yyjson_val *root = yyjson_doc_get_root(start);
    const char *id = yyjson_get_str(yyjson_obj_get(yyjson_obj_get(root, "session"), "id"));
    const char *token = yyjson_get_str(yyjson_obj_get(root, "token"));
    yyjson_doc *reply =
        capture_json(cbm_capture_ingest(m, id, token, "http://localhost:3000", capture_payload,
                                        strlen(capture_payload), capture_check, NULL, &status));
    ASSERT_EQ(status, 200);
    yyjson_doc_free(reply);
    reply = capture_json(cbm_capture_events(m, id, 0, &status));
    yyjson_val *events = yyjson_obj_get(yyjson_doc_get_root(reply), "events");
    ASSERT_EQ(yyjson_arr_size(events), 1);
    yyjson_val *event = yyjson_arr_get(events, 0);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(event, "source_status")), "matched");
    ASSERT_STR_EQ(yyjson_get_str(yyjson_arr_get(yyjson_obj_get(event, "inputs"), 0)), "in-1");
    ASSERT_NULL(yyjson_obj_get(event, "preview"));
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(event, "producer_id")), "worker-a");
    yyjson_doc_free(reply);
    reply = capture_json(cbm_capture_list(m, "demo", &status));
    char *listed = yyjson_val_write_opts(yyjson_doc_get_root(reply), 0, cbm_json_writer_allocator(),
                                         NULL, NULL);
    ASSERT_NULL(strstr(listed, token));
    cbm_free(CBM_MEM_CLASS_OTHER, listed);
    yyjson_doc_free(reply);
    yyjson_doc_free(start);
    cbm_capture_free(m);
    PASS();
}

TEST(capture_values_need_field_allowlist_and_stop_preserves_review_until_delete) {
    cbm_capture_manager_t *m = cbm_capture_new();
    int status = 0;
    yyjson_doc *bad = capture_json(cbm_capture_create(
        m,
        "{\"project\":\"demo\",\"generation\":\"g\",\"profile\":\"node\",\"values_enabled\":true}",
        &status));
    ASSERT_EQ(status, 400);
    yyjson_doc_free(bad);
    yyjson_doc *start = capture_json(
        cbm_capture_create(m,
                           "{\"project\":\"demo\",\"generation\":\"g\",\"profile\":\"node\","
                           "\"values_enabled\":true,\"allowed_fields\":[\"profile.email\"]}",
                           &status));
    ASSERT_EQ(status, 201);
    yyjson_val *root = yyjson_doc_get_root(start);
    const char *id = yyjson_get_str(yyjson_obj_get(yyjson_obj_get(root, "session"), "id"));
    const char *token = yyjson_get_str(yyjson_obj_get(root, "token"));
    yyjson_doc *reply = capture_json(cbm_capture_ingest(
        m, id, token, "", capture_payload, strlen(capture_payload), NULL, NULL, &status));
    ASSERT_EQ(status, 200);
    yyjson_doc_free(reply);
    reply = capture_json(cbm_capture_stop(m, id, &status));
    ASSERT_EQ(status, 200);
    yyjson_doc_free(reply);
    reply = capture_json(cbm_capture_ingest(m, id, token, "", capture_payload,
                                            strlen(capture_payload), NULL, NULL, &status));
    ASSERT_EQ(status, 409);
    yyjson_doc_free(reply);
    reply = capture_json(cbm_capture_events(m, id, 0, &status));
    yyjson_val *event = yyjson_arr_get(yyjson_obj_get(yyjson_doc_get_root(reply), "events"), 0);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(event, "preview")), "private@example.test");
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(event, "source_status")), "unmatched");
    yyjson_doc_free(reply);
    reply = capture_json(cbm_capture_delete(m, id, &status));
    ASSERT_EQ(status, 200);
    yyjson_doc_free(reply);
    reply = capture_json(cbm_capture_events(m, id, 0, &status));
    ASSERT_EQ(status, 404);
    yyjson_doc_free(reply);
    yyjson_doc_free(start);
    cbm_capture_free(m);
    PASS();
}

TEST(capture_deduplicates_sequences_and_reports_missing_events) {
    cbm_capture_manager_t *m = cbm_capture_new();
    int status = 0;
    yyjson_doc *start = capture_json(cbm_capture_create(m, capture_start, &status));
    ASSERT_EQ(status, 201);
    yyjson_val *root = yyjson_doc_get_root(start);
    const char *id = yyjson_get_str(yyjson_obj_get(yyjson_obj_get(root, "session"), "id"));
    const char *token = yyjson_get_str(yyjson_obj_get(root, "token"));
    for (int i = 0; i < 2; i++)
        cbm_free(CBM_MEM_CLASS_OTHER,
                 cbm_capture_ingest(m, id, token, "", capture_payload, strlen(capture_payload),
                                    capture_check, NULL, &status));
    const char *gap =
        "{\"schema_version\":1,\"producer\":{\"id\":\"worker-a\",\"language\":\"typescript\"},"
        "\"events\":[{\"sequence\":3,\"operation\":\"return\",\"invocation_id\":\"call-1\","
        "\"value_id\":\"out-2\",\"inputs\":[\"out-1\"]}]}";
    cbm_free(CBM_MEM_CLASS_OTHER,
             cbm_capture_ingest(m, id, token, "", gap, strlen(gap), NULL, NULL, &status));
    yyjson_doc *reply = capture_json(cbm_capture_events(m, id, 0, &status));
    root = yyjson_doc_get_root(reply);
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(root, "events")), 2);
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(yyjson_obj_get(root, "session"), "dropped_events")), 1);
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(root, "next_after")), 2);
    yyjson_doc_free(reply);
    yyjson_doc_free(start);
    cbm_capture_free(m);
    PASS();
}

TEST(capture_spans_deduplicate_without_inventing_field_links_or_cross_service_identity) {
    cbm_capture_manager_t *m = cbm_capture_new();
    int status = 0;
    yyjson_doc *start = capture_json(cbm_capture_create(m, capture_start, &status));
    ASSERT_EQ(status, 201);
    yyjson_val *root = yyjson_doc_get_root(start);
    const char *id = yyjson_get_str(yyjson_obj_get(yyjson_obj_get(root, "session"), "id"));
    const char *token = yyjson_get_str(yyjson_obj_get(root, "token"));
    cbm_otlp_span_t spans[2] = {0};
    for (int i = 0; i < 2; i++) {
        snprintf(spans[i].trace_id, sizeof(spans[i].trace_id), "%s",
                 "0102030405060708090a0b0c0d0e0f10");
        snprintf(spans[i].span_id, sizeof(spans[i].span_id), "%s", "0102030405060708");
        snprintf(spans[i].parent_span_id, sizeof(spans[i].parent_span_id), "%s",
                 "0807060504030201");
        snprintf(spans[i].producer_id, sizeof(spans[i].producer_id), "%s", "instance-a");
        snprintf(spans[i].service_name, sizeof(spans[i].service_name), "%s",
                 i ? "database" : "users");
        spans[i].producer_source = CBM_OTLP_PRODUCER_SERVICE_INSTANCE;
    }
    cbm_otlp_batch_t batch = {.spans = spans, .count = 2};
    size_t accepted = 0, rejected = 0;
    ASSERT_EQ(cbm_capture_ingest_spans(m, id, "wrong", "", &batch, &accepted, &rejected), 403);
    ASSERT_EQ(cbm_capture_ingest_spans(m, id, token, "", &batch, &accepted, &rejected), 200);
    ASSERT_EQ(accepted, 2);
    ASSERT_EQ(rejected, 0);
    ASSERT_EQ(cbm_capture_ingest_spans(m, id, token, "", &batch, &accepted, &rejected), 200);
    ASSERT_EQ(accepted, 0);
    yyjson_doc *reply = capture_json(cbm_capture_events(m, id, 0, &status));
    yyjson_val *events = yyjson_obj_get(yyjson_doc_get_root(reply), "events");
    ASSERT_EQ(yyjson_arr_size(events), 2);
    yyjson_val *a = yyjson_arr_get(events, 0), *b = yyjson_arr_get(events, 1);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(a, "operation")), "span");
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(a, "inputs")), 0);
    ASSERT_NULL(yyjson_obj_get(a, "value_id"));
    ASSERT_NULL(yyjson_obj_get(a, "preview"));
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(a, "parent_span_id")), "0807060504030201");
    ASSERT_TRUE(strcmp(yyjson_get_str(yyjson_obj_get(a, "producer_id")),
                       yyjson_get_str(yyjson_obj_get(b, "producer_id"))) != 0);
    yyjson_doc_free(reply);
    yyjson_doc_free(start);
    cbm_capture_free(m);
    PASS();
}

TEST(capture_rejects_ambiguous_event_batch_before_accepting_any_event) {
    cbm_capture_manager_t *m = cbm_capture_new();
    int status = 0;
    yyjson_doc *start = capture_json(cbm_capture_create(m, capture_start, &status));
    ASSERT_EQ(status, 201);
    yyjson_val *root = yyjson_doc_get_root(start);
    const char *id = yyjson_get_str(yyjson_obj_get(yyjson_obj_get(root, "session"), "id"));
    const char *token = yyjson_get_str(yyjson_obj_get(root, "token"));
    const char *body =
        "{\"schema_version\":1,\"producer\":{\"id\":\"p\",\"language\":\"go\"},"
        "\"events\":[{\"sequence\":1,\"operation\":\"copy\",\"invocation_id\":\"f\",\"inputs\":[]},"
        "{\"sequence\":2,\"operation\":\"copy\",\"invocation_id\":\"f\",\"inputs\":[],\"inputs\":["
        "\"a\"]}]}";
    cbm_free(CBM_MEM_CLASS_OTHER,
             cbm_capture_ingest(m, id, token, "", body, strlen(body), NULL, NULL, &status));
    ASSERT_EQ(status, 400);
    yyjson_doc *reply = capture_json(cbm_capture_events(m, id, 0, &status));
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(yyjson_doc_get_root(reply), "events")), 0);
    yyjson_doc_free(reply);
    yyjson_doc_free(start);
    cbm_capture_free(m);
    PASS();
}

SUITE(capture) {
    RUN_TEST(capture_requires_explicit_session_and_token_and_exact_origin);
    RUN_TEST(capture_field_events_keep_identity_and_omit_unapproved_values);
    RUN_TEST(capture_values_need_field_allowlist_and_stop_preserves_review_until_delete);
    RUN_TEST(capture_deduplicates_sequences_and_reports_missing_events);
    RUN_TEST(capture_spans_deduplicate_without_inventing_field_links_or_cross_service_identity);
    RUN_TEST(capture_rejects_ambiguous_event_batch_before_accepting_any_event);
}
