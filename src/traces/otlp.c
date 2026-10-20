#include "otlp.h"
#include "foundation/mem_core.h"
#include <yyjson/yyjson.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Schema references:
 * https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
 * https://github.com/open-telemetry/opentelemetry-proto/tree/main/opentelemetry/proto
 * https://protobuf.dev/programming-guides/encoding/
 * A bounded metadata projection, not a general telemetry store. */
typedef enum {
    REQUEST,
    RESOURCE_SPANS,
    SCOPE_SPANS,
    RESOURCE,
    SCOPE,
    SPAN,
    STATUS,
    KEY_VALUE,
    ANY_VALUE,
    ARRAY_VALUE,
    KV_LIST,
    EVENT,
    LINK
} message_kind;
typedef enum {
    STR,
    BYTES,
    TRACE_ID,
    SPAN_ID,
    PARENT_ID,
    U32,
    U64,
    I64,
    ENUM,
    BOOL,
    DOUBLE,
    FIXED32,
    FIXED64,
    MESSAGE
} field_kind;
typedef struct {
    unsigned number;
    const char *name;
    field_kind kind;
    message_kind child;
    bool repeated;
} descriptor;
#define FIELD(n, name, type) {n, name, type, REQUEST, false}
#define CHILD(n, name, msg, repeat) {n, name, MESSAGE, msg, repeat}
static const descriptor request_fields[] = {CHILD(1, "resourceSpans", RESOURCE_SPANS, true)};
static const descriptor resource_spans_fields[] = {CHILD(1, "resource", RESOURCE, false),
                                                   CHILD(2, "scopeSpans", SCOPE_SPANS, true),
                                                   FIELD(3, "schemaUrl", STR)};
static const descriptor scope_spans_fields[] = {
    CHILD(1, "scope", SCOPE, false), CHILD(2, "spans", SPAN, true), FIELD(3, "schemaUrl", STR)};
static const descriptor resource_fields[] = {CHILD(1, "attributes", KEY_VALUE, true),
                                             FIELD(2, "droppedAttributesCount", U32)};
static const descriptor scope_fields[] = {FIELD(1, "name", STR), FIELD(2, "version", STR),
                                          CHILD(3, "attributes", KEY_VALUE, true),
                                          FIELD(4, "droppedAttributesCount", U32)};
static const descriptor span_fields[] = {FIELD(1, "traceId", TRACE_ID),
                                         FIELD(2, "spanId", SPAN_ID),
                                         FIELD(3, "traceState", STR),
                                         FIELD(4, "parentSpanId", PARENT_ID),
                                         FIELD(5, "name", STR),
                                         FIELD(6, "kind", ENUM),
                                         FIELD(7, "startTimeUnixNano", FIXED64),
                                         FIELD(8, "endTimeUnixNano", FIXED64),
                                         CHILD(9, "attributes", KEY_VALUE, true),
                                         FIELD(10, "droppedAttributesCount", U32),
                                         CHILD(11, "events", EVENT, true),
                                         FIELD(12, "droppedEventsCount", U32),
                                         CHILD(13, "links", LINK, true),
                                         FIELD(14, "droppedLinksCount", U32),
                                         CHILD(15, "status", STATUS, false),
                                         FIELD(16, "flags", FIXED32)};
static const descriptor status_fields[] = {FIELD(2, "message", STR), FIELD(3, "code", ENUM)};
static const descriptor key_value_fields[] = {
    FIELD(1, "key", STR), CHILD(2, "value", ANY_VALUE, false), FIELD(3, "keyStrindex", ENUM)};
static const descriptor any_value_fields[] = {FIELD(1, "stringValue", STR),
                                              FIELD(2, "boolValue", BOOL),
                                              FIELD(3, "intValue", I64),
                                              FIELD(4, "doubleValue", DOUBLE),
                                              CHILD(5, "arrayValue", ARRAY_VALUE, false),
                                              CHILD(6, "kvlistValue", KV_LIST, false),
                                              FIELD(7, "bytesValue", BYTES),
                                              FIELD(8, "stringValueStrindex", ENUM)};
static const descriptor array_fields[] = {CHILD(1, "values", ANY_VALUE, true)};
static const descriptor kv_list_fields[] = {CHILD(1, "values", KEY_VALUE, true)};
static const descriptor event_fields[] = {FIELD(1, "timeUnixNano", FIXED64), FIELD(2, "name", STR),
                                          CHILD(3, "attributes", KEY_VALUE, true),
                                          FIELD(4, "droppedAttributesCount", U32)};
static const descriptor link_fields[] = {FIELD(1, "traceId", TRACE_ID),
                                         FIELD(2, "spanId", SPAN_ID),
                                         FIELD(3, "traceState", STR),
                                         CHILD(4, "attributes", KEY_VALUE, true),
                                         FIELD(5, "droppedAttributesCount", U32),
                                         FIELD(6, "flags", FIXED32)};
#undef FIELD
#undef CHILD
typedef struct {
    const descriptor *fields;
    size_t count;
} schema;
#define SCHEMA(fields) {fields, sizeof(fields) / sizeof(fields[0])}
static const schema schemas[] = {
    SCHEMA(request_fields),  SCHEMA(resource_spans_fields), SCHEMA(scope_spans_fields),
    SCHEMA(resource_fields), SCHEMA(scope_fields),          SCHEMA(span_fields),
    SCHEMA(status_fields),   SCHEMA(key_value_fields),      SCHEMA(any_value_fields),
    SCHEMA(array_fields),    SCHEMA(kv_list_fields),        SCHEMA(event_fields),
    SCHEMA(link_fields)};
#undef SCHEMA
typedef struct {
    cbm_otlp_batch_t batch;
    size_t capacity, fields;
    const char *error;
} decoder;
typedef struct {
    char explicit_id[256], instance_id[256], service_name[256], service_namespace[256],
        language[64];
    unsigned seen;
} resource_meta;
static bool fail(decoder *d, const char *error) {
    if (!d->error)
        d->error = error;
    return false;
}
static bool budget(decoder *d, unsigned depth) {
    if (depth > CBM_OTLP_MAX_DEPTH || ++d->fields > CBM_OTLP_MAX_FIELDS)
        return fail(d, "OTLP nesting or field limit exceeded.");
    return true;
}
static bool utf8(const unsigned char *s, size_t n) {
    for (size_t i = 0; i < n;) {
        unsigned c = s[i++], remaining = 0, low = 0x80, high = 0xbf;
        if (c <= 0x7f)
            continue;
        if (c >= 0xc2 && c <= 0xdf)
            remaining = 1;
        else if (c >= 0xe0 && c <= 0xef) {
            remaining = 2;
            if (c == 0xe0)
                low = 0xa0;
            if (c == 0xed)
                high = 0x9f;
        } else if (c >= 0xf0 && c <= 0xf4) {
            remaining = 3;
            if (c == 0xf0)
                low = 0x90;
            if (c == 0xf4)
                high = 0x8f;
        } else
            return false;
        if (remaining > n - i || s[i] < low || s[i] > high)
            return false;
        i++;
        for (unsigned j = 1; j < remaining; j++, i++)
            if (s[i] < 0x80 || s[i] > 0xbf)
                return false;
    }
    return true;
}
static bool meta_value(decoder *d, resource_meta *meta, const char *key, size_t key_len,
                       const char *value, size_t value_len) {
    const char *keys[] = {"cbm.producer.id", "service.instance.id", "service.name",
                          "service.namespace", "telemetry.sdk.language"};
    char *targets[] = {meta->explicit_id, meta->instance_id, meta->service_name,
                       meta->service_namespace, meta->language};
    const size_t sizes[] = {256, 256, 256, 256, 64};
    for (unsigned i = 0; i < 5; i++)
        if (strlen(keys[i]) == key_len && memcmp(key, keys[i], key_len) == 0) {
            if ((meta->seen & (1u << i)) || value_len >= sizes[i])
                return fail(d, "Ambiguous or oversized OTLP resource identity.");
            meta->seen |= 1u << i;
            if (!value)
                break;
            for (size_t j = 0; j < value_len; j++)
                if ((unsigned char)value[j] < 0x20 || value[j] == 0x7f)
                    return fail(d, "Invalid OTLP resource identity.");
            memcpy(targets[i], value, value_len);
            targets[i][value_len] = '\0';
            break;
        }
    return true;
}
static void inherit_meta(cbm_otlp_span_t *span, const resource_meta *meta) {
    memcpy(span->service_name, meta->service_name, sizeof(span->service_name));
    memcpy(span->service_namespace, meta->service_namespace, sizeof(span->service_namespace));
    memcpy(span->sdk_language, meta->language, sizeof(span->sdk_language));
    if (meta->explicit_id[0]) {
        memcpy(span->producer_id, meta->explicit_id, sizeof(span->producer_id));
        span->producer_source = CBM_OTLP_PRODUCER_EXPLICIT;
    } else if (meta->instance_id[0]) {
        memcpy(span->producer_id, meta->instance_id, sizeof(span->producer_id));
        span->producer_source = CBM_OTLP_PRODUCER_SERVICE_INSTANCE;
    }
}
static bool append_span(decoder *d, const cbm_otlp_span_t *span) {
    if (!span->trace_id[0] || !span->span_id[0])
        return fail(d, "OTLP span requires nonzero trace and span IDs.");
    if (d->batch.count >= CBM_OTLP_MAX_SPANS)
        return fail(d, "OTLP span limit exceeded.");
    if (d->batch.count == d->capacity) {
        size_t capacity = d->capacity ? d->capacity * 2 : 16;
        cbm_otlp_span_t *next =
            cbm_realloc(CBM_MEM_CLASS_OTHER, d->batch.spans, capacity * sizeof(*next));
        if (!next)
            return fail(d, "OTLP allocation failed.");
        d->batch.spans = next;
        d->capacity = capacity;
    }
    d->batch.spans[d->batch.count++] = *span;
    return true;
}
static bool binary_id(const unsigned char *s, size_t n, size_t expected, bool optional, char *out) {
    if (!n && optional) {
        if (out)
            out[0] = '\0';
        return true;
    }
    if (n != expected)
        return false;
    unsigned any = 0;
    const char *digits = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) {
        any |= s[i];
        if (out) {
            out[i * 2] = digits[s[i] >> 4];
            out[i * 2 + 1] = digits[s[i] & 15];
        }
    }
    if (out)
        out[n * 2] = '\0';
    return any != 0;
}
static int hex(unsigned char c) {
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}
static bool hex_id(const char *s, size_t n, size_t expected, bool optional, char *out) {
    if (expected != 8 && expected != 16)
        return false;
    if (!n && optional) {
        if (out)
            out[0] = '\0';
        return true;
    }
    if (n != expected * 2)
        return false;
    unsigned char bytes[16] = {0};
    for (size_t i = 0; i < expected; i++) {
        int hi = hex((unsigned char)s[i * 2]), lo = hex((unsigned char)s[i * 2 + 1]);
        if (hi < 0 || lo < 0)
            return false;
        bytes[i] = (unsigned char)((hi << 4) | lo);
    }
    return binary_id(bytes, expected, expected, optional, out);
}
/* Decimal strings and JSON numeric literals, including exact exponent forms.
 * yyjson's raw-number mode avoids a double round-trip for nanosecond timestamps. */
static bool decimal(const char *s, size_t n, uint64_t *value, bool *negative) {
    if (!s || !n || n > 128)
        return false;
    size_t p = 0, count = 0, fraction = 0;
    char digits[128];
    bool dot = false;
    *negative = s[p] == '-';
    if (*negative && ++p == n)
        return false;
    bool before = false, after = false;
    while (p < n && s[p] != 'e' && s[p] != 'E') {
        if (s[p] == '.' && !dot && before) {
            dot = true;
            p++;
            continue;
        }
        if (s[p] < '0' || s[p] > '9')
            return false;
        digits[count++] = s[p++];
        if (dot) {
            fraction++;
            after = true;
        } else
            before = true;
    }
    if (!before || (dot && !after))
        return false;
    int exponent = 0;
    if (p < n) {
        bool exp_negative = false;
        p++;
        if (p < n && (s[p] == '+' || s[p] == '-'))
            exp_negative = s[p++] == '-';
        if (p == n)
            return false;
        for (; p < n; p++) {
            if (s[p] < '0' || s[p] > '9' || exponent > 1000)
                return false;
            exponent = exponent * 10 + s[p] - '0';
        }
        if (exp_negative)
            exponent = -exponent;
    }
    int shift = exponent - (int)fraction;
    size_t start = 0;
    while (start < count && digits[start] == '0')
        start++;
    if (start == count) {
        *value = 0;
        *negative = false;
        return true;
    }
    while (shift < 0 && count > start && digits[count - 1] == '0') {
        count--;
        shift++;
    }
    if (shift < 0 || shift > 20 || count - start + (size_t)shift > 20)
        return false;
    uint64_t result = 0;
    for (size_t i = start; i < count; i++) {
        unsigned digit = (unsigned)(digits[i] - '0');
        if (result > (UINT64_MAX - digit) / 10)
            return false;
        result = result * 10 + digit;
    }
    for (int i = 0; i < shift; i++) {
        if (result > UINT64_MAX / 10)
            return false;
        result *= 10;
    }
    *value = result;
    return true;
}
static bool json_integer(yyjson_val *value, field_kind type, uint64_t *result) {
    bool string_allowed = type == U64 || type == I64 || type == FIXED64;
    const char *s = yyjson_is_raw(value)                     ? yyjson_get_raw(value)
                    : string_allowed && yyjson_is_str(value) ? yyjson_get_str(value)
                                                             : NULL;
    bool negative;
    uint64_t number;
    if (!decimal(s, yyjson_get_len(value), &number, &negative))
        return false;
    uint64_t limit = type == ENUM                     ? (negative ? 2147483648ULL : INT32_MAX)
                     : type == I64                    ? (negative ? (1ULL << 63) : INT64_MAX)
                     : type == U32 || type == FIXED32 ? UINT32_MAX
                                                      : UINT64_MAX;
    if (number > limit || (negative && type != ENUM && type != I64))
        return false;
    if (result)
        *result = negative ? (uint64_t)(0 - number) : number;
    return true;
}
static bool json_budget(decoder *d, yyjson_val *value, unsigned depth) {
    if (!budget(d, depth))
        return false;
    size_t i, max;
    yyjson_val *item;
    if (yyjson_is_arr(value)) {
        yyjson_arr_foreach(value, i, max, item) if (!json_budget(d, item, depth + 1)) return false;
    } else if (yyjson_is_obj(value)) {
        yyjson_val *key;
        yyjson_obj_foreach(value, i, max, key,
                           item) if (!json_budget(d, item, depth + 1)) return false;
    }
    return true;
}
static bool base64_valid(const char *s, size_t n) {
    size_t useful = n;
    while (useful && s[useful - 1] == '=')
        useful--;
    if (n - useful > 2 || useful % 4 == 1 || (n != useful && n % 4 != 0))
        return false;
    for (size_t i = 0; i < useful; i++) {
        char c = s[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
              c == '+' || c == '/' || c == '-' || c == '_'))
            return false;
    }
    return true;
}
static bool json_message(decoder *, yyjson_val *, message_kind, unsigned);
static bool json_scalar(decoder *d, yyjson_val *value, const descriptor *field, unsigned depth) {
    if (field->kind == MESSAGE)
        return json_message(d, value, field->child, depth + 1);
    if (field->kind == BOOL)
        return yyjson_is_bool(value);
    if (field->kind == DOUBLE)
        return yyjson_is_raw(value) ||
               (yyjson_is_str(value) &&
                (yyjson_equals_str(value, "NaN") || yyjson_equals_str(value, "Infinity") ||
                 yyjson_equals_str(value, "-Infinity")));
    if (field->kind == STR)
        return yyjson_is_str(value);
    if (field->kind == BYTES)
        return yyjson_is_str(value) && base64_valid(yyjson_get_str(value), yyjson_get_len(value));
    if (field->kind == TRACE_ID || field->kind == SPAN_ID || field->kind == PARENT_ID)
        return yyjson_is_str(value) &&
               hex_id(yyjson_get_str(value), yyjson_get_len(value),
                      field->kind == TRACE_ID ? 16 : 8, field->kind == PARENT_ID, NULL);
    return json_integer(value, field->kind, NULL);
}
static bool json_message(decoder *d, yyjson_val *value, message_kind kind, unsigned depth) {
    if (!yyjson_is_obj(value) || depth > CBM_OTLP_MAX_DEPTH)
        return false;
    schema spec = schemas[kind];
    unsigned seen = 0, oneof = 0;
    size_t i, max;
    yyjson_val *key, *item;
    yyjson_obj_foreach(value, i, max, key, item) {
        const descriptor *field = NULL;
        for (size_t j = 0; j < spec.count; j++)
            if (yyjson_equals_str(key, spec.fields[j].name)) {
                field = &spec.fields[j];
                break;
            }
        if (!field)
            continue;
        if (seen & (1u << field->number))
            return false;
        seen |= 1u << field->number;
        if (yyjson_is_null(item))
            continue;
        if (kind == ANY_VALUE && ++oneof > 1)
            return false;
        if (field->repeated) {
            if (!yyjson_is_arr(item))
                return false;
            size_t index, count;
            yyjson_val *entry;
            yyjson_arr_foreach(item, index, count,
                               entry) if (!json_scalar(d, entry, field, depth)) return false;
        } else if (!json_scalar(d, item, field, depth))
            return false;
    }
    return true;
}
static bool json_meta(decoder *d, yyjson_val *resource, resource_meta *meta) {
    yyjson_val *attrs = yyjson_obj_get(resource, "attributes"), *item;
    size_t i, n;
    yyjson_arr_foreach(attrs, i, n, item) {
        yyjson_val *key = yyjson_obj_get(item, "key"),
                   *value = yyjson_obj_get(yyjson_obj_get(item, "value"), "stringValue");
        if (yyjson_is_str(key) && !meta_value(d, meta, yyjson_get_str(key), yyjson_get_len(key),
                                              yyjson_is_str(value) ? yyjson_get_str(value) : NULL,
                                              yyjson_is_str(value) ? yyjson_get_len(value) : 0))
            return false;
    }
    return true;
}
static bool decode_json(decoder *d, const void *body, size_t length) {
    yyjson_doc *doc = yyjson_read(body, length, YYJSON_READ_NUMBER_AS_RAW);
    if (!doc)
        return fail(d, "Malformed OTLP JSON.");
    yyjson_val *root = yyjson_doc_get_root(doc);
    bool ok = json_budget(d, root, 0) && json_message(d, root, REQUEST, 0);
    if (ok) {
        yyjson_val *resources = yyjson_obj_get(root, "resourceSpans"), *rs;
        size_t ri, rn;
        yyjson_arr_foreach(resources, ri, rn, rs) {
            resource_meta meta = {0};
            if (!json_meta(d, yyjson_obj_get(rs, "resource"), &meta)) {
                ok = false;
                break;
            }
            yyjson_val *scopes = yyjson_obj_get(rs, "scopeSpans"), *scope;
            size_t si, sn;
            yyjson_arr_foreach(scopes, si, sn, scope) {
                yyjson_val *spans = yyjson_obj_get(scope, "spans"), *item;
                size_t pi, pn;
                yyjson_arr_foreach(spans, pi, pn, item) {
                    cbm_otlp_span_t span = {0};
                    inherit_meta(&span, &meta);
                    yyjson_val *trace = yyjson_obj_get(item, "traceId"),
                               *id = yyjson_obj_get(item, "spanId"),
                               *parent = yyjson_obj_get(item, "parentSpanId");
                    if (!yyjson_is_str(trace) || !yyjson_is_str(id)) {
                        ok = false;
                        break;
                    }
                    (void)hex_id(yyjson_get_str(trace), yyjson_get_len(trace), 16, false,
                                 span.trace_id);
                    (void)hex_id(yyjson_get_str(id), yyjson_get_len(id), 8, false, span.span_id);
                    if (yyjson_is_str(parent))
                        (void)hex_id(yyjson_get_str(parent), yyjson_get_len(parent), 8, true,
                                     span.parent_span_id);
                    uint64_t number;
                    if (json_integer(yyjson_obj_get(item, "startTimeUnixNano"), FIXED64, &number))
                        span.start_time_unix_nano = number;
                    if (json_integer(yyjson_obj_get(item, "endTimeUnixNano"), FIXED64, &number))
                        span.end_time_unix_nano = number;
                    if (json_integer(yyjson_obj_get(item, "kind"), ENUM, &number))
                        span.kind = (int32_t)number;
                    if (json_integer(yyjson_obj_get(item, "flags"), FIXED32, &number))
                        span.flags = (uint32_t)number;
                    if (json_integer(yyjson_obj_get(yyjson_obj_get(item, "status"), "code"), ENUM,
                                     &number))
                        span.status_code = (int32_t)number;
                    if (!append_span(d, &span)) {
                        ok = false;
                        break;
                    }
                }
                if (!ok)
                    break;
            }
            if (!ok)
                break;
        }
    }
    yyjson_doc_free(doc);
    if (!ok)
        return fail(d, "Malformed OTLP JSON message.");
    return true;
}

typedef struct {
    const unsigned char *data;
    size_t size, position;
} cursor;
typedef struct {
    unsigned number, wire;
    uint64_t integer;
    const unsigned char *data;
    size_t size;
} wire_field;
static bool varint(cursor *c, uint64_t *value) {
    uint64_t result = 0;
    for (unsigned i = 0; i < 10; i++) {
        if (c->position == c->size)
            return false;
        unsigned byte = c->data[c->position++];
        if (i == 9 && byte > 1)
            return false;
        result |= (uint64_t)(byte & 127u) << (i * 7);
        if (!(byte & 128u)) {
            *value = result;
            return true;
        }
    }
    return false;
}
static bool next_field(decoder *d, cursor *c, wire_field *out, unsigned depth, unsigned group) {
    if (!budget(d, depth))
        return false;
    memset(out, 0, sizeof(*out));
    uint64_t tag;
    if (!varint(c, &tag) || tag >> 3 == 0 || tag >> 3 > 536870911u)
        return false;
    out->number = (unsigned)(tag >> 3);
    out->wire = (unsigned)(tag & 7u);
    if (out->wire == 0)
        return varint(c, &out->integer);
    if (out->wire == 4)
        return group != 0 && out->number == group;
    if (out->wire == 3) {
        while (c->position < c->size) {
            wire_field child;
            if (!next_field(d, c, &child, depth + 1, out->number))
                return false;
            if (child.wire == 4)
                return true;
        }
        return false;
    }
    uint64_t size = out->wire == 1 ? 8 : out->wire == 5 ? 4 : 0;
    if (out->wire == 2) {
        if (!varint(c, &size))
            return false;
    } else if (!size)
        return false;
    if (size > c->size - c->position)
        return false;
    out->data = c->data + c->position;
    out->size = (size_t)size;
    c->position += (size_t)size;
    if (out->wire == 1 || out->wire == 5)
        for (size_t i = 0; i < out->size; i++)
            out->integer |= (uint64_t)out->data[i] << (i * 8);
    return true;
}
static unsigned expected_wire(field_kind kind) {
    if (kind == DOUBLE || kind == FIXED64)
        return 1;
    if (kind == FIXED32)
        return 5;
    if (kind == U32 || kind == U64 || kind == I64 || kind == ENUM || kind == BOOL)
        return 0;
    return 2;
}
static bool protobuf_message(decoder *d, cursor c, message_kind kind, unsigned depth) {
    if (depth > CBM_OTLP_MAX_DEPTH)
        return fail(d, "OTLP nesting limit exceeded.");
    schema spec = schemas[kind];
    while (c.position < c.size) {
        wire_field field;
        if (!next_field(d, &c, &field, depth, 0))
            return false;
        const descriptor *desc = NULL;
        for (size_t i = 0; i < spec.count; i++)
            if (spec.fields[i].number == field.number) {
                desc = &spec.fields[i];
                break;
            }
        if (!desc)
            continue;
        if (field.wire != expected_wire(desc->kind))
            return false;
        if (desc->kind == MESSAGE) {
            if (!protobuf_message(d, (cursor){field.data, field.size, 0}, desc->child, depth + 1))
                return false;
        } else if (desc->kind == STR) {
            if (!utf8(field.data, field.size))
                return false;
        } else if (desc->kind == TRACE_ID || desc->kind == SPAN_ID || desc->kind == PARENT_ID) {
            if (!binary_id(field.data, field.size, desc->kind == TRACE_ID ? 16 : 8,
                           desc->kind == PARENT_ID, NULL))
                return false;
        } else if (desc->kind == U32 && field.integer > UINT32_MAX)
            return false;
        else if (desc->kind == ENUM && field.integer > INT32_MAX &&
                 field.integer < UINT64_MAX - INT32_MAX)
            return false;
    }
    return true;
}
static bool protobuf_meta(decoder *d, cursor resource, resource_meta *meta) {
    while (resource.position < resource.size) {
        wire_field attr;
        if (!next_field(d, &resource, &attr, 2, 0))
            return false;
        if (attr.number != 1)
            continue;
        cursor kv = {attr.data, attr.size, 0};
        const char *key = NULL, *value = NULL;
        size_t key_size = 0, value_size = 0;
        while (kv.position < kv.size) {
            wire_field field;
            if (!next_field(d, &kv, &field, 3, 0))
                return false;
            if (field.number == 1) {
                key = (const char *)field.data;
                key_size = field.size;
            } else if (field.number == 2) {
                cursor any = {field.data, field.size, 0};
                while (any.position < any.size) {
                    wire_field v;
                    if (!next_field(d, &any, &v, 4, 0))
                        return false;
                    if (v.number >= 1 && v.number <= 8) {
                        value = v.number == 1 ? (const char *)v.data : NULL;
                        value_size = v.number == 1 ? v.size : 0;
                    }
                }
            }
        }
        if (key && !meta_value(d, meta, key, key_size, value, value_size))
            return false;
    }
    return true;
}
static bool protobuf_span(decoder *d, cursor c, const resource_meta *meta) {
    cbm_otlp_span_t span = {0};
    inherit_meta(&span, meta);
    while (c.position < c.size) {
        wire_field field;
        if (!next_field(d, &c, &field, 3, 0))
            return false;
        switch (field.number) {
        case 1:
            (void)binary_id(field.data, field.size, 16, false, span.trace_id);
            break;
        case 2:
            (void)binary_id(field.data, field.size, 8, false, span.span_id);
            break;
        case 4:
            (void)binary_id(field.data, field.size, 8, true, span.parent_span_id);
            break;
        case 6:
            span.kind = (int32_t)field.integer;
            break;
        case 7:
            span.start_time_unix_nano = field.integer;
            break;
        case 8:
            span.end_time_unix_nano = field.integer;
            break;
        case 16:
            span.flags = (uint32_t)field.integer;
            break;
        case 15: {
            cursor status = {field.data, field.size, 0};
            while (status.position < status.size) {
                wire_field code;
                if (!next_field(d, &status, &code, 4, 0))
                    return false;
                if (code.number == 3)
                    span.status_code = (int32_t)code.integer;
            }
            break;
        }
        default:
            break;
        }
    }
    return append_span(d, &span);
}
static bool decode_protobuf(decoder *d, const void *body, size_t length) {
    cursor root = {body, length, 0};
    if (!protobuf_message(d, root, REQUEST, 0))
        return fail(d, "Malformed OTLP protobuf message.");
    while (root.position < root.size) {
        wire_field resource;
        if (!next_field(d, &root, &resource, 0, 0))
            return false;
        if (resource.number != 1)
            continue;
        resource_meta meta = {0};
        cursor rs = {resource.data, resource.size, 0};
        /* Two passes preserve protobuf's arbitrary field ordering. */
        while (rs.position < rs.size) {
            wire_field field;
            if (!next_field(d, &rs, &field, 1, 0))
                return false;
            if (field.number == 1 && !protobuf_meta(d, (cursor){field.data, field.size, 0}, &meta))
                return false;
        }
        rs.position = 0;
        while (rs.position < rs.size) {
            wire_field scopes;
            if (!next_field(d, &rs, &scopes, 1, 0))
                return false;
            if (scopes.number != 2)
                continue;
            cursor scope = {scopes.data, scopes.size, 0};
            while (scope.position < scope.size) {
                wire_field span;
                if (!next_field(d, &scope, &span, 2, 0))
                    return false;
                if (span.number == 2 && !protobuf_span(d, (cursor){span.data, span.size, 0}, &meta))
                    return false;
            }
        }
    }
    return true;
}
bool cbm_otlp_decode(const void *body, size_t length, cbm_otlp_encoding_t encoding,
                     cbm_otlp_batch_t *out, char *error, size_t error_size) {
    if (error && error_size)
        error[0] = '\0';
    if (!out) {
        if (error && error_size)
            snprintf(error, error_size, "OTLP output is required.");
        return false;
    }
    memset(out, 0, sizeof(*out));
    decoder d = {0};
    bool ok = false;
    if (length > CBM_OTLP_MAX_BODY)
        fail(&d, "OTLP body limit exceeded.");
    else if (!body && length)
        fail(&d, "OTLP body is missing.");
    else if (encoding == CBM_OTLP_JSON)
        ok = decode_json(&d, body, length);
    else if (encoding == CBM_OTLP_PROTOBUF)
        ok = decode_protobuf(&d, body, length);
    else
        fail(&d, "Unsupported OTLP encoding.");
    if (!ok) {
        cbm_otlp_batch_free(&d.batch);
        if (error && error_size)
            snprintf(error, error_size, "%s", d.error ? d.error : "Malformed OTLP payload.");
        return false;
    }
    *out = d.batch;
    return true;
}
void cbm_otlp_batch_free(cbm_otlp_batch_t *batch) {
    if (!batch)
        return;
    cbm_free(CBM_MEM_CLASS_OTHER, batch->spans);
    batch->spans = NULL;
    batch->count = 0;
}
