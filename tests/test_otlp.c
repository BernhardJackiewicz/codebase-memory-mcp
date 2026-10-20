#include "test_framework.h"
#include <traces/otlp.h>
#include "foundation/mem_core.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *otlp_json =
    "{\"resourceSpans\":[{\"resource\":{\"attributes\":["
    "{\"key\":\"service.name\",\"value\":{\"stringValue\":\"users\"}},"
    "{\"key\":\"service.namespace\",\"value\":{\"stringValue\":\"sample\"}},"
    "{\"key\":\"service.instance.id\",\"value\":{\"stringValue\":\"instance-A\"}},"
    "{\"key\":\"telemetry.sdk.language\",\"value\":{\"stringValue\":\"javascript\"}},"
    "{\"key\":\"db.statement\",\"value\":{\"stringValue\":\"secret-resource-payload\"}}]},"
    "\"scopeSpans\":[{\"spans\":[{\"traceId\":\"0102030405060708090A0B0C0D0E0F10\","
    "\"spanId\":\"0102030405060708\",\"parentSpanId\":\"0807060504030201\","
    "\"name\":\"secret-name-payload\",\"kind\":2,\"startTimeUnixNano\":\"18446744073709551000\","
    "\"endTimeUnixNano\":\"18446744073709551615\",\"status\":{\"code\":1,\"message\":\"secret-"
    "status-payload\"},"
    "\"attributes\":[{\"key\":\"db.query.text\",\"value\":{\"stringValue\":\"secret-query-"
    "payload\"}}],"
    "\"futureField\":{\"unknown\":[1,2,3]}}]}]}]}";

typedef struct {
    unsigned char data[4096];
    size_t size;
} otlp_bytes;
static void put_varint(otlp_bytes *b, uint64_t value) {
    do {
        unsigned char byte = (unsigned char)(value & 127u);
        value >>= 7;
        b->data[b->size++] = (unsigned char)(byte | (value ? 128u : 0u));
    } while (value);
}
static void put_bytes(otlp_bytes *b, unsigned field, const void *bytes, size_t n) {
    put_varint(b, ((uint64_t)field << 3) | 2u);
    put_varint(b, n);
    memcpy(b->data + b->size, bytes, n);
    b->size += n;
}
static void put_uint(otlp_bytes *b, unsigned field, uint64_t value) {
    put_varint(b, (uint64_t)field << 3);
    put_varint(b, value);
}
static void put_fixed64(otlp_bytes *b, unsigned field, uint64_t value) {
    put_varint(b, ((uint64_t)field << 3) | 1u);
    for (unsigned i = 0; i < 8; i++)
        b->data[b->size++] = (unsigned char)(value >> (i * 8));
}
static otlp_bytes attr(const char *key, const char *value) {
    otlp_bytes any = {0}, pair = {0};
    put_bytes(&any, 1, value, strlen(value));
    put_bytes(&pair, 1, key, strlen(key));
    put_bytes(&pair, 2, any.data, any.size);
    return pair;
}
static otlp_bytes protobuf_fixture(void) {
    otlp_bytes span = {0}, scope = {0}, resource = {0}, rs = {0}, request = {0}, status = {0};
    unsigned char trace[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16},
                  id[] = {1, 2, 3, 4, 5, 6, 7, 8};
    put_bytes(&span, 1, trace, sizeof(trace));
    put_bytes(&span, 2, id, sizeof(id));
    put_bytes(&span, 5, "secret-name-payload", 19);
    put_uint(&span, 6, 2);
    put_fixed64(&span, 7, UINT64_MAX - 615);
    put_fixed64(&span, 8, UINT64_MAX);
    put_uint(&status, 3, 1);
    put_bytes(&status, 2, "secret-status", 13);
    put_bytes(&span, 15, status.data, status.size);
    otlp_bytes pair = attr("service.name", "users");
    put_bytes(&resource, 1, pair.data, pair.size);
    pair = attr("service.instance.id", "instance-A");
    put_bytes(&resource, 1, pair.data, pair.size);
    pair = attr("cbm.producer.id", "worker-A");
    put_bytes(&resource, 1, pair.data, pair.size);
    pair = attr("db.statement", "secret-sql");
    put_bytes(&span, 9, pair.data, pair.size);
    put_bytes(&scope, 2, span.data, span.size);
    /* Resource metadata deliberately comes after spans: protobuf order is not significant. */
    put_bytes(&rs, 2, scope.data, scope.size);
    put_bytes(&rs, 1, resource.data, resource.size);
    put_bytes(&request, 1, rs.data, rs.size);
    put_uint(&request, 100, 1234);
    put_fixed64(&request, 101, UINT64_MAX);
    put_bytes(&request, 102, "\x00\xff\x80", 3);
    return request;
}

TEST(otlp_json_keeps_only_span_metadata_and_explicit_resource_identity) {
    cbm_otlp_batch_t batch = {0};
    char error[160];
    ASSERT(
        cbm_otlp_decode(otlp_json, strlen(otlp_json), CBM_OTLP_JSON, &batch, error, sizeof(error)));
    ASSERT_EQ(batch.count, 1);
    ASSERT_STR_EQ(batch.spans[0].trace_id, "0102030405060708090a0b0c0d0e0f10");
    ASSERT_STR_EQ(batch.spans[0].span_id, "0102030405060708");
    ASSERT_STR_EQ(batch.spans[0].service_name, "users");
    ASSERT_STR_EQ(batch.spans[0].service_namespace, "sample");
    ASSERT_STR_EQ(batch.spans[0].producer_id, "instance-A");
    ASSERT_EQ(batch.spans[0].producer_source, CBM_OTLP_PRODUCER_SERVICE_INSTANCE);
    ASSERT_EQ(batch.spans[0].status_code, 1);
    ASSERT(batch.spans[0].end_time_unix_nano == UINT64_MAX);
    const unsigned char *bytes = (const unsigned char *)batch.spans;
    for (size_t i = 0; i + 6 <= sizeof(*batch.spans); i++)
        ASSERT(memcmp(bytes + i, "secret", 6) != 0);
    cbm_otlp_batch_free(&batch);
    ASSERT_NULL(batch.spans);
    ASSERT_EQ(batch.count, 0);
    PASS();
}
TEST(otlp_protobuf_decodes_unordered_metadata_and_ignores_unknown_wire_fields) {
    otlp_bytes body = protobuf_fixture();
    cbm_otlp_batch_t batch = {0};
    char error[160];
    ASSERT(cbm_otlp_decode(body.data, body.size, CBM_OTLP_PROTOBUF, &batch, error, sizeof(error)));
    ASSERT_EQ(batch.count, 1);
    ASSERT_STR_EQ(batch.spans[0].producer_id, "worker-A");
    ASSERT_EQ(batch.spans[0].producer_source, CBM_OTLP_PRODUCER_EXPLICIT);
    ASSERT_STR_EQ(batch.spans[0].trace_id, "0102030405060708090a0b0c0d0e0f10");
    ASSERT(batch.spans[0].end_time_unix_nano == UINT64_MAX);
    ASSERT_EQ(batch.spans[0].kind, 2);
    ASSERT_EQ(batch.spans[0].status_code, 1);
    cbm_otlp_batch_free(&batch);
    PASS();
}
TEST(otlp_rejects_invalid_ids_overflows_and_numeric_enum_names_atomically) {
    const char *bad[] = {
        "{\"resourceSpans\":[{\"scopeSpans\":[{\"spans\":[{\"traceId\":"
        "\"00000000000000000000000000000000\",\"spanId\":\"0102030405060708\"}]}]}]}",
        "{\"resourceSpans\":[{\"scopeSpans\":[{\"spans\":[{\"traceId\":"
        "\"0102030405060708090a0b0c0d0e0f10\",\"spanId\":\"0102030405060708\",\"kind\":\"SPAN_KIND_"
        "SERVER\"}]}]}]}",
        "{\"resourceSpans\":[{\"scopeSpans\":[{\"spans\":[{\"traceId\":"
        "\"0102030405060708090a0b0c0d0e0f10\",\"spanId\":\"0102030405060708\",\"endTimeUnixNano\":"
        "\"18446744073709551616\"}]}]}]}",
        "{\"resourceSpans\":{}}",
        "{\"resourceSpans\":[{\"scopeSpans\":3}]}",
        "{"};
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        cbm_otlp_batch_t batch = {0};
        char error[160];
        ASSERT_FALSE(
            cbm_otlp_decode(bad[i], strlen(bad[i]), CBM_OTLP_JSON, &batch, error, sizeof(error)));
        ASSERT_EQ(batch.count, 0);
        ASSERT_NULL(batch.spans);
        ASSERT(error[0]);
    }
    PASS();
}
TEST(otlp_protobuf_rejects_truncated_overflow_and_wrong_wire_without_partial_spans) {
    const unsigned char *bad[] = {
        (const unsigned char *)"\x0a\xff\xff\xff\xff\xff\xff\xff\xff\xff\x02",
        (const unsigned char *)"\x0a\x04\x12\x03\x00",
        (const unsigned char *)"\x00",
        (const unsigned char *)"\x08\x01",
        (const unsigned char *)"\x0e",
        (const unsigned char *)"\x0b\x14"};
    const size_t sizes[] = {11, 5, 1, 2, 1, 2};
    for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) {
        cbm_otlp_batch_t batch = {0};
        char error[160];
        ASSERT_FALSE(
            cbm_otlp_decode(bad[i], sizes[i], CBM_OTLP_PROTOBUF, &batch, error, sizeof(error)));
        ASSERT_NULL(batch.spans);
        ASSERT_EQ(batch.count, 0);
    }
    otlp_bytes body = protobuf_fixture();
    body.data[body.size++] = 0x80;
    cbm_otlp_batch_t batch = {0};
    char error[160];
    ASSERT_FALSE(
        cbm_otlp_decode(body.data, body.size, CBM_OTLP_PROTOBUF, &batch, error, sizeof(error)));
    ASSERT_NULL(batch.spans);
    PASS();
}
TEST(otlp_unknown_producer_remains_unknown_and_empty_exports_are_valid) {
    cbm_otlp_batch_t batch = {0};
    char error[160];
    const char *body =
        "{\"resourceSpans\":[{\"scopeSpans\":[{\"spans\":[{\"traceId\":"
        "\"0102030405060708090a0b0c0d0e0f10\",\"spanId\":\"0102030405060708\"}]}]}]}";
    ASSERT(cbm_otlp_decode(body, strlen(body), CBM_OTLP_JSON, &batch, error, sizeof(error)));
    ASSERT_STR_EQ(batch.spans[0].producer_id, "");
    ASSERT_EQ(batch.spans[0].producer_source, CBM_OTLP_PRODUCER_UNKNOWN);
    cbm_otlp_batch_free(&batch);
    ASSERT(cbm_otlp_decode("{}", 2, CBM_OTLP_JSON, &batch, error, sizeof(error)));
    ASSERT_EQ(batch.count, 0);
    ASSERT(cbm_otlp_decode(NULL, 0, CBM_OTLP_PROTOBUF, &batch, error, sizeof(error)));
    PASS();
}
TEST(otlp_rejects_body_and_nesting_limits) {
    cbm_otlp_batch_t batch = {0};
    char error[160];
    ASSERT_FALSE(
        cbm_otlp_decode("x", CBM_OTLP_MAX_BODY + 1, CBM_OTLP_JSON, &batch, error, sizeof(error)));
    char deep[256];
    size_t p = 0;
    memcpy(deep, "{\"unknown\":", 11);
    p = 11;
    for (size_t i = 0; i < CBM_OTLP_MAX_DEPTH + 1; i++)
        deep[p++] = '[';
    deep[p++] = '0';
    for (size_t i = 0; i < CBM_OTLP_MAX_DEPTH + 1; i++)
        deep[p++] = ']';
    deep[p++] = '}';
    ASSERT_FALSE(cbm_otlp_decode(deep, p, CBM_OTLP_JSON, &batch, error, sizeof(error)));
    PASS();
}
TEST(otlp_rejects_ambiguous_resource_identity_even_when_the_second_value_is_not_text) {
    const char *body = "{\"resourceSpans\":[{\"resource\":{\"attributes\":["
                       "{\"key\":\"cbm.producer.id\",\"value\":{\"stringValue\":\"worker-A\"}},"
                       "{\"key\":\"cbm.producer.id\",\"value\":{\"intValue\":\"1\"}}]}}]}";
    cbm_otlp_batch_t batch = {0};
    char error[160];
    ASSERT_FALSE(cbm_otlp_decode(body, strlen(body), CBM_OTLP_JSON, &batch, error, sizeof(error)));
    ASSERT_NULL(batch.spans);
    PASS();
}
TEST(otlp_preserves_exact_numeric_exponent_timestamps_and_enforces_span_budget) {
    const char *body =
        "{\"resourceSpans\":[{\"scopeSpans\":[{\"spans\":[{"
        "\"traceId\":\"0102030405060708090a0b0c0d0e0f10\",\"spanId\":\"0102030405060708\","
        "\"startTimeUnixNano\":1.8446744073709551000e19,\"endTimeUnixNano\":\"1."
        "8446744073709551615e19\"}]}]}]}";
    cbm_otlp_batch_t batch = {0};
    char error[160];
    ASSERT(cbm_otlp_decode(body, strlen(body), CBM_OTLP_JSON, &batch, error, sizeof(error)));
    ASSERT(batch.spans[0].start_time_unix_nano == UINT64_MAX - 615);
    ASSERT(batch.spans[0].end_time_unix_nano == UINT64_MAX);
    cbm_otlp_batch_free(&batch);
    const char *span =
        "{\"traceId\":\"0102030405060708090a0b0c0d0e0f10\",\"spanId\":\"0102030405060708\"}";
    size_t size = (strlen(span) + 1) * (CBM_OTLP_MAX_SPANS + 1) + 100;
    char *many = cbm_calloc(CBM_MEM_CLASS_OTHER, size);
    ASSERT_NOT_NULL(many);
    size_t used = (size_t)snprintf(many, size, "{\"resourceSpans\":[{\"scopeSpans\":[{\"spans\":[");
    for (size_t i = 0; i <= CBM_OTLP_MAX_SPANS; i++)
        used += (size_t)snprintf(many + used, size - used, "%s%s", i ? "," : "", span);
    used += (size_t)snprintf(many + used, size - used, "]}]}]}");
    bool ok = cbm_otlp_decode(many, used, CBM_OTLP_JSON, &batch, error, sizeof(error));
    cbm_free(CBM_MEM_CLASS_OTHER, many);
    ASSERT_FALSE(ok);
    ASSERT_NULL(batch.spans);
    ASSERT_EQ(batch.count, 0);
    PASS();
}
TEST(otlp_unknown_groups_are_skipped_and_malformed_utf8_is_rejected) {
    otlp_bytes body = protobuf_fixture();
    put_varint(&body, (100u << 3) | 3u);
    put_uint(&body, 1, 42);
    put_varint(&body, (100u << 3) | 4u);
    cbm_otlp_batch_t batch = {0};
    char error[160];
    ASSERT(cbm_otlp_decode(body.data, body.size, CBM_OTLP_PROTOBUF, &batch, error, sizeof(error)));
    ASSERT_EQ(batch.count, 1);
    cbm_otlp_batch_free(&batch);
    otlp_bytes span = {0}, scope = {0}, rs = {0}, bad = {0};
    put_bytes(&span, 5, "\xc0\xaf", 2);
    put_bytes(&scope, 2, span.data, span.size);
    put_bytes(&rs, 2, scope.data, scope.size);
    put_bytes(&bad, 1, rs.data, rs.size);
    ASSERT_FALSE(
        cbm_otlp_decode(bad.data, bad.size, CBM_OTLP_PROTOBUF, &batch, error, sizeof(error)));
    ASSERT_NULL(batch.spans);
    PASS();
}
TEST(otlp_bounded_malformed_byte_smoke_has_no_partial_result_or_memory_errors) {
    uint32_t seed = 0x9e3779b9u;
    for (size_t round = 0; round < 1500; round++) {
        unsigned char bytes[128];
        size_t n = round % sizeof(bytes);
        for (size_t i = 0; i < n; i++) {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            bytes[i] = (unsigned char)seed;
        }
        cbm_otlp_batch_t batch = {0};
        char error[160];
        bool ok = cbm_otlp_decode(bytes, n, CBM_OTLP_PROTOBUF, &batch, error, sizeof(error));
        if (!ok) {
            ASSERT_NULL(batch.spans);
            ASSERT_EQ(batch.count, 0);
        }
        cbm_otlp_batch_free(&batch);
    }
    otlp_bytes body = protobuf_fixture();
    for (size_t i = 0; i < body.size; i++) {
        cbm_otlp_batch_t batch = {0};
        char error[160];
        bool ok = cbm_otlp_decode(body.data, i, CBM_OTLP_PROTOBUF, &batch, error, sizeof(error));
        if (!ok) {
            ASSERT_NULL(batch.spans);
            ASSERT_EQ(batch.count, 0);
        }
        cbm_otlp_batch_free(&batch);
    }
    PASS();
}
SUITE(otlp) {
    RUN_TEST(otlp_json_keeps_only_span_metadata_and_explicit_resource_identity);
    RUN_TEST(otlp_protobuf_decodes_unordered_metadata_and_ignores_unknown_wire_fields);
    RUN_TEST(otlp_rejects_invalid_ids_overflows_and_numeric_enum_names_atomically);
    RUN_TEST(otlp_protobuf_rejects_truncated_overflow_and_wrong_wire_without_partial_spans);
    RUN_TEST(otlp_unknown_producer_remains_unknown_and_empty_exports_are_valid);
    RUN_TEST(otlp_rejects_body_and_nesting_limits);
    RUN_TEST(otlp_rejects_ambiguous_resource_identity_even_when_the_second_value_is_not_text);
    RUN_TEST(otlp_preserves_exact_numeric_exponent_timestamps_and_enforces_span_budget);
    RUN_TEST(otlp_unknown_groups_are_skipped_and_malformed_utf8_is_rejected);
    RUN_TEST(otlp_bounded_malformed_byte_smoke_has_no_partial_result_or_memory_errors);
}
