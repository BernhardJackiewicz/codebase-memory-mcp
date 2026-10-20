#include "traces/capture.h"
#include "foundation/platform.h"
#include "foundation/mem_core.h"
#include "foundation/json_writer.h"
#include "foundation/secure_random.h"
#include "foundation/sha256.h"
#include <yyjson/yyjson.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define CAPTURE_SESSIONS 4
#define CAPTURE_PRODUCERS 64
#define CAPTURE_EVENTS 10000
#define CAPTURE_BYTES (16U * 1024U * 1024U)
#define CAPTURE_DURATION_MS (15U * 60U * 1000U)
#define CAPTURE_PAGE 200
#define CAPTURE_SAFE_INTEGER UINT64_C(9007199254740991)

typedef struct {
    char id[129];
    char language[33];
    uint64_t sequence;
} capture_producer_t;

typedef struct {
    char id[33], token[65], project[513], generation[129], profile[16], origin[256];
    char fields[64][201];
    size_t field_count, event_count, bytes, producer_count;
    uint64_t created_at, expires_at, deadline, dropped;
    bool values_enabled;
    /* 0 = recording, 1 = stopped, 2 = limited. */
    int state;
    capture_producer_t producers[CAPTURE_PRODUCERS];
    char *events[CAPTURE_EVENTS];
    char span_keys[CAPTURE_EVENTS][65];
    uint16_t span_slots[16384]; /* Event index + 1; bounded open-addressed dedup. */
} capture_session_t;

struct cbm_capture_manager {
    capture_session_t *sessions[CAPTURE_SESSIONS];
};

static char *capture_error(int *status, int code, const char *message) {
    *status = code;
    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    if (!doc)
        return NULL;
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);
    yyjson_mut_obj_add_strcpy(doc, root, "error", message);
    char *json = yyjson_mut_write_opts(doc, 0, cbm_json_writer_allocator(), NULL, NULL);
    yyjson_mut_doc_free(doc);
    return json;
}

static capture_session_t *capture_find(cbm_capture_manager_t *m, const char *id) {
    if (m && id)
        for (size_t i = 0; i < CAPTURE_SESSIONS; i++)
            if (m->sessions[i] && strcmp(m->sessions[i]->id, id) == 0)
                return m->sessions[i];
    return NULL;
}

static void capture_expire(capture_session_t *session) {
    if (!session->state && cbm_now_ms() >= session->deadline)
        session->state = 2;
}

static void capture_destroy(capture_session_t *session) {
    if (!session)
        return;
    for (size_t i = 0; i < session->event_count; i++) {
        cbm_secure_zero(session->events[i], strlen(session->events[i]));
        cbm_free(CBM_MEM_CLASS_OTHER, session->events[i]);
    }
    cbm_secure_zero(session, sizeof(*session));
    cbm_free(CBM_MEM_CLASS_OTHER, session);
}

cbm_capture_manager_t *cbm_capture_new(void) {
    return cbm_calloc(CBM_MEM_CLASS_OTHER, sizeof(cbm_capture_manager_t));
}

void cbm_capture_free(cbm_capture_manager_t *manager) {
    if (!manager)
        return;
    for (size_t i = 0; i < CAPTURE_SESSIONS; i++)
        capture_destroy(manager->sessions[i]);
    cbm_free(CBM_MEM_CLASS_OTHER, manager);
}

static bool capture_string(yyjson_val *value, size_t limit, bool optional) {
    if (!value)
        return optional;
    return yyjson_is_str(value) && yyjson_get_len(value) > 0 && yyjson_get_len(value) <= limit &&
           strlen(yyjson_get_str(value)) == yyjson_get_len(value);
}

/* Ambiguous JSON must not select whichever field a parser happens to return.
 * Bound object width/depth as well as the already bounded input body. */
static bool capture_unique_json(yyjson_val *value, unsigned depth) {
    if (depth > 32)
        return false;
    if (yyjson_is_obj(value)) {
        if (yyjson_obj_size(value) > 128)
            return false;
        size_t i, max;
        yyjson_val *key, *child;
        yyjson_obj_foreach(value, i, max, key, child) {
            if (strlen(yyjson_get_str(key)) != yyjson_get_len(key))
                return false;
            size_t j, other_max;
            yyjson_val *other_key, *other_value;
            yyjson_obj_foreach(value, j, other_max, other_key, other_value) {
                if (j >= i)
                    break;
                if (yyjson_equals(key, other_key))
                    return false;
            }
            if (!capture_unique_json(child, depth + 1))
                return false;
        }
    } else if (yyjson_is_arr(value)) {
        size_t i, max;
        yyjson_val *child;
        yyjson_arr_foreach(value, i, max,
                           child) if (!capture_unique_json(child, depth + 1)) return false;
    }
    return true;
}

static bool capture_origin_valid(const char *origin) {
    const char *port = NULL;
    const char *prefixes[] = {"http://localhost:", "http://127.0.0.1:", "http://[::1]:"};
    for (size_t i = 0; i < sizeof(prefixes) / sizeof(prefixes[0]); i++)
        if (strncmp(origin, prefixes[i], strlen(prefixes[i])) == 0)
            port = origin + strlen(prefixes[i]);
    if (!port || !*port || *port == '0')
        return false;
    unsigned number = 0;
    for (const char *p = port; *p; p++) {
        if (*p < '0' || *p > '9' || number > 6553)
            return false;
        number = number * 10 + (unsigned)(*p - '0');
    }
    return number > 0 && number <= 65535;
}

static bool capture_field_valid(yyjson_val *value) {
    if (!capture_string(value, 200, false))
        return false;
    const char *s = yyjson_get_str(value);
    size_t n = strlen(s);
    if (s[0] == ' ' || s[n - 1] == ' ')
        return false;
    for (size_t i = 0; i < n; i++)
        if ((unsigned char)s[i] < 32 || s[i] == '*')
            return false;
    return true;
}

static bool capture_random_hex(char *output, size_t bytes) {
    unsigned char random[32];
    static const char hex[] = "0123456789abcdef";
    if (bytes > sizeof(random) || !cbm_secure_random(random, bytes))
        return false;
    for (size_t i = 0; i < bytes; i++) {
        output[2 * i] = hex[random[i] >> 4];
        output[2 * i + 1] = hex[random[i] & 15];
    }
    output[2 * bytes] = '\0';
    cbm_secure_zero(random, sizeof(random));
    return true;
}

static yyjson_mut_val *capture_session_json(yyjson_mut_doc *doc, capture_session_t *session) {
    capture_expire(session);
    yyjson_mut_val *value = yyjson_mut_obj(doc);
    yyjson_mut_obj_add_strcpy(doc, value, "id", session->id);
    yyjson_mut_obj_add_strcpy(doc, value, "project", session->project);
    yyjson_mut_obj_add_strcpy(doc, value, "generation", session->generation);
    yyjson_mut_obj_add_strcpy(doc, value, "profile", session->profile);
    yyjson_mut_obj_add_str(doc, value, "status",
                           session->state == 2 ? "limited"
                           : session->state    ? "stopped"
                                               : "recording");
    yyjson_mut_obj_add_uint(doc, value, "created_at", session->created_at);
    yyjson_mut_obj_add_uint(doc, value, "expires_at", session->expires_at);
    yyjson_mut_obj_add_uint(doc, value, "accepted_events", session->event_count);
    yyjson_mut_obj_add_uint(doc, value, "dropped_events", session->dropped);
    yyjson_mut_obj_add_uint(doc, value, "max_events", CAPTURE_EVENTS);
    yyjson_mut_obj_add_bool(doc, value, "values_enabled", session->values_enabled);
    yyjson_mut_val *fields = yyjson_mut_arr(doc);
    for (size_t i = 0; i < session->field_count; i++)
        yyjson_mut_arr_add_strcpy(doc, fields, session->fields[i]);
    yyjson_mut_obj_add_val(doc, value, "allowed_fields", fields);
    yyjson_mut_val *caps = yyjson_mut_arr(doc);
    yyjson_mut_arr_add_str(doc, caps, "explicit_lineage_events");
    yyjson_mut_arr_add_str(doc, caps, "otlp_http_json");
    yyjson_mut_arr_add_str(doc, caps, "otlp_http_protobuf");
    yyjson_mut_arr_add_str(doc, caps, "memory_only");
    yyjson_mut_obj_add_val(doc, value, "capabilities", caps);
    yyjson_mut_val *gaps = yyjson_mut_arr(doc);
    yyjson_mut_arr_add_str(doc, gaps,
                           "Only events emitted by an instrumented application are observed.");
    if (!session->values_enabled)
        yyjson_mut_arr_add_str(doc, gaps, "Raw test values are disabled.");
    if (session->dropped)
        yyjson_mut_arr_add_str(doc, gaps,
                               "Producer sequence gaps or capture limits left missing events.");
    if (session->state == 2)
        yyjson_mut_arr_add_str(doc, gaps,
                               "The time, producer, event or memory limit stopped recording.");
    yyjson_mut_obj_add_val(doc, value, "gaps", gaps);
    return value;
}

static yyjson_mut_doc *capture_envelope(void) {
    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    if (doc) {
        yyjson_mut_val *root = yyjson_mut_obj(doc);
        yyjson_mut_doc_set_root(doc, root);
        yyjson_mut_obj_add_int(doc, root, "schema_version", 1);
    }
    return doc;
}

static char *capture_write(yyjson_mut_doc *doc, int *status, int code) {
    char *json =
        doc ? yyjson_mut_write_opts(doc, 0, cbm_json_writer_allocator(), NULL, NULL) : NULL;
    yyjson_mut_doc_free(doc);
    if (!json)
        return capture_error(status, 500, "Unable to allocate capture response.");
    *status = code;
    return json;
}

char *cbm_capture_create(cbm_capture_manager_t *m, const char *body, int *status) {
    if (!m || !body || strlen(body) > 32768)
        return capture_error(status, 400, "Invalid capture session request.");
    yyjson_doc *input = yyjson_read(body, strlen(body), 0);
    yyjson_val *root = yyjson_doc_get_root(input);
    yyjson_val *project = yyjson_obj_get(root, "project");
    yyjson_val *generation = yyjson_obj_get(root, "generation");
    yyjson_val *profile = yyjson_obj_get(root, "profile");
    yyjson_val *values = yyjson_obj_get(root, "values_enabled");
    yyjson_val *fields = yyjson_obj_get(root, "allowed_fields");
    yyjson_val *origin = yyjson_obj_get(root, "allowed_origin");
    bool valid_profile = false;
    if (capture_string(profile, 15, false)) {
        const char *profiles[] = {"node", "browser", "python", "jvm",   "dotnet",
                                  "go",   "rust",    "php",    "native"};
        for (size_t i = 0; i < sizeof(profiles) / sizeof(profiles[0]); i++) {
            valid_profile |= strcmp(yyjson_get_str(profile), profiles[i]) == 0;
        }
    }
    bool valid = yyjson_is_obj(root) && capture_unique_json(root, 0) &&
                 capture_string(project, 512, false) && capture_string(generation, 128, false) &&
                 valid_profile && (!values || yyjson_is_bool(values)) &&
                 (!fields || (yyjson_is_arr(fields) && yyjson_arr_size(fields) <= 64)) &&
                 (!origin || (capture_string(origin, 255, false) &&
                              capture_origin_valid(yyjson_get_str(origin))));
    bool enabled = yyjson_get_bool(values);
    if (enabled ? yyjson_arr_size(fields) == 0 : yyjson_arr_size(fields) > 0)
        valid = false;
    size_t i, max;
    yyjson_val *field;
    yyjson_arr_foreach(fields, i, max, field) {
        if (!capture_field_valid(field))
            valid = false;
        for (size_t j = 0; j < i; j++)
            if (yyjson_equals(field, yyjson_arr_get(fields, j)))
                valid = false;
    }
    if (!valid) {
        yyjson_doc_free(input);
        return capture_error(status, 400,
                             "Use a known CPU profile, project and generation; raw values require "
                             "exact field names.");
    }
    size_t slot = 0;
    while (slot < CAPTURE_SESSIONS && m->sessions[slot])
        slot++;
    if (slot == CAPTURE_SESSIONS) {
        yyjson_doc_free(input);
        return capture_error(status, 409,
                             "Delete an existing capture before creating another (limit: 4).");
    }
    capture_session_t *session = cbm_calloc(CBM_MEM_CLASS_OTHER, sizeof(*session));
    if (!session || !capture_random_hex(session->id, 16) ||
        !capture_random_hex(session->token, 32)) {
        capture_destroy(session);
        yyjson_doc_free(input);
        return capture_error(status, 500, "Unable to create a capture session.");
    }
    snprintf(session->project, sizeof(session->project), "%s", yyjson_get_str(project));
    snprintf(session->generation, sizeof(session->generation), "%s", yyjson_get_str(generation));
    snprintf(session->profile, sizeof(session->profile), "%s", yyjson_get_str(profile));
    if (origin)
        snprintf(session->origin, sizeof(session->origin), "%s", yyjson_get_str(origin));
    yyjson_arr_foreach(fields, i, max, field) {
        snprintf(session->fields[i], sizeof(session->fields[i]), "%s", yyjson_get_str(field));
    }
    session->field_count = yyjson_arr_size(fields);
    session->values_enabled = enabled;
    session->created_at = (uint64_t)time(NULL) * 1000;
    session->expires_at = session->created_at + CAPTURE_DURATION_MS;
    session->deadline = cbm_now_ms() + CAPTURE_DURATION_MS;
    yyjson_doc_free(input);
    yyjson_mut_doc *doc = capture_envelope();
    if (!doc) {
        capture_destroy(session);
        return capture_error(status, 500, "Unable to create a capture session.");
    }
    yyjson_mut_val *out = yyjson_mut_doc_get_root(doc);
    yyjson_mut_obj_add_val(doc, out, "session", capture_session_json(doc, session));
    yyjson_mut_obj_add_strcpy(doc, out, "token", session->token);
    char url[128];
    snprintf(url, sizeof(url), "/v1/cbm/lineage?session=%s", session->id);
    yyjson_mut_obj_add_strcpy(doc, out, "lineage_url", url);
    snprintf(url, sizeof(url), "/v1/traces?session=%s", session->id);
    yyjson_mut_obj_add_strcpy(doc, out, "traces_url", url);
    yyjson_mut_val *instructions = yyjson_mut_arr(doc);
    yyjson_mut_arr_add_str(doc, instructions,
                           "Start your development application manually with a capture adapter.");
    yyjson_mut_arr_add_str(
        doc, instructions,
        "Send explicit lineage events with Authorization: Bearer <session token>.");
    yyjson_mut_arr_add_str(doc, instructions,
                           "A trace span alone does not establish field value lineage.");
    yyjson_mut_obj_add_val(doc, out, "instructions", instructions);
    char *json = capture_write(doc, status, 201);
    if (*status != 201)
        capture_destroy(session);
    else
        m->sessions[slot] = session;
    return json;
}

char *cbm_capture_list(cbm_capture_manager_t *m, const char *project, int *status) {
    if (!m || !project || !*project)
        return capture_error(status, 400, "A project is required.");
    yyjson_mut_doc *doc = capture_envelope();
    if (!doc)
        return capture_error(status, 500, "Unable to allocate response.");
    yyjson_mut_val *list = yyjson_mut_arr(doc);
    for (size_t i = 0; i < CAPTURE_SESSIONS; i++)
        if (m->sessions[i] && strcmp(m->sessions[i]->project, project) == 0)
            yyjson_mut_arr_add_val(list, capture_session_json(doc, m->sessions[i]));
    yyjson_mut_obj_add_val(doc, yyjson_mut_doc_get_root(doc), "sessions", list);
    return capture_write(doc, status, 200);
}

char *cbm_capture_stop(cbm_capture_manager_t *m, const char *id, int *status) {
    capture_session_t *session = capture_find(m, id);
    if (!session)
        return capture_error(status, 404, "Capture session not found.");
    session->state = 1;
    cbm_secure_zero(session->token, sizeof(session->token));
    yyjson_mut_doc *doc = capture_envelope();
    if (!doc)
        return capture_error(status, 500, "Unable to allocate response.");
    yyjson_mut_obj_add_val(doc, yyjson_mut_doc_get_root(doc), "session",
                           capture_session_json(doc, session));
    return capture_write(doc, status, 200);
}

char *cbm_capture_delete(cbm_capture_manager_t *m, const char *id, int *status) {
    if (m && id)
        for (size_t i = 0; i < CAPTURE_SESSIONS; i++)
            if (m->sessions[i] && strcmp(m->sessions[i]->id, id) == 0) {
                capture_destroy(m->sessions[i]);
                m->sessions[i] = NULL;
                yyjson_mut_doc *doc = capture_envelope();
                if (!doc)
                    return capture_error(status, 500, "Unable to allocate response.");
                yyjson_mut_obj_add_bool(doc, yyjson_mut_doc_get_root(doc), "deleted", true);
                return capture_write(doc, status, 200);
            }
    return capture_error(status, 404, "Capture session not found.");
}

char *cbm_capture_events(cbm_capture_manager_t *m, const char *id, uint64_t after, int *status) {
    capture_session_t *session = capture_find(m, id);
    if (!session)
        return capture_error(status, 404, "Capture session not found.");
    if (after > session->event_count)
        return capture_error(status, 400, "Capture cursor is ahead of available events.");
    yyjson_mut_doc *doc = capture_envelope();
    if (!doc)
        return capture_error(status, 500, "Unable to allocate response.");
    yyjson_mut_val *root = yyjson_mut_doc_get_root(doc), *events = yyjson_mut_arr(doc);
    size_t next = (size_t)after;
    while (next < session->event_count && next < after + CAPTURE_PAGE) {
        yyjson_doc *event = yyjson_read(session->events[next], strlen(session->events[next]), 0);
        if (!event) {
            yyjson_mut_doc_free(doc);
            return capture_error(status, 500, "Unable to read captured event.");
        }
        yyjson_mut_arr_add_val(events, yyjson_val_mut_copy(doc, yyjson_doc_get_root(event)));
        yyjson_doc_free(event);
        next++;
    }
    yyjson_mut_obj_add_val(doc, root, "session", capture_session_json(doc, session));
    yyjson_mut_obj_add_val(doc, root, "events", events);
    yyjson_mut_obj_add_uint(doc, root, "next_after", next);
    yyjson_mut_obj_add_bool(doc, root, "complete", next == session->event_count);
    return capture_write(doc, status, 200);
}

bool cbm_capture_origin_allowed(cbm_capture_manager_t *m, const char *id, const char *origin) {
    capture_session_t *session = capture_find(m, id);
    return session &&
           (!origin || !*origin || (session->origin[0] && strcmp(session->origin, origin) == 0));
}

bool cbm_capture_authorized(cbm_capture_manager_t *m, const char *id, const char *token) {
    capture_session_t *session = capture_find(m, id);
    if (!session || !token || !session->token[0] || strlen(token) != 64)
        return false;
    unsigned mismatch = 0;
    for (size_t i = 0; i < 64; i++)
        mismatch |= (unsigned char)token[i] ^ (unsigned char)session->token[i];
    return mismatch == 0;
}

const char *cbm_capture_project(cbm_capture_manager_t *m, const char *id) {
    capture_session_t *session = capture_find(m, id);
    return session ? session->project : NULL;
}

const char *cbm_capture_generation(cbm_capture_manager_t *m, const char *id) {
    capture_session_t *session = capture_find(m, id);
    return session ? session->generation : NULL;
}

int cbm_capture_ingest_spans(cbm_capture_manager_t *manager, const char *id, const char *token,
                             const char *origin, const cbm_otlp_batch_t *batch, size_t *accepted,
                             size_t *rejected) {
    *accepted = 0;
    *rejected = 0;
    capture_session_t *session = capture_find(manager, id);
    if (!session)
        return 404;
    capture_expire(session);
    if (session->state)
        return 409;
    if (!cbm_capture_authorized(manager, id, token) ||
        !cbm_capture_origin_allowed(manager, id, origin))
        return 403;
    if (!batch || batch->count > CBM_OTLP_MAX_SPANS || (batch->count && !batch->spans))
        return 400;
    for (size_t i = 0; i < batch->count; i++) {
        const cbm_otlp_span_t *span = &batch->spans[i];
        char producer_id[80] = "otlp:unattributed";
        if (span->producer_source != CBM_OTLP_PRODUCER_UNKNOWN) {
            /* Length prefixes prevent delimiter ambiguity. Instance IDs are
             * only identities inside their service namespace/name. */
            char identity[1024], digest[65];
            int n = snprintf(identity, sizeof(identity), "%d:%zu:%s%zu:%s%zu:%s",
                             span->producer_source, strlen(span->producer_id), span->producer_id,
                             strlen(span->service_namespace), span->service_namespace,
                             strlen(span->service_name), span->service_name);
            if (n < 0 || (size_t)n >= sizeof(identity)) {
                (*rejected)++;
                continue;
            }
            cbm_sha256_hex(identity, (size_t)n, digest);
            snprintf(producer_id, sizeof(producer_id), "otlp:%s", digest);
        }
        char identity[160], key[65];
        int n = snprintf(identity, sizeof(identity), "%s:%s:%s", producer_id, span->trace_id,
                         span->span_id);
        if (n < 0 || (size_t)n >= sizeof(identity)) {
            (*rejected)++;
            continue;
        }
        cbm_sha256_hex(identity, (size_t)n, key);
        uint32_t hash = 2166136261U;
        for (size_t k = 0; k < 64; k++)
            hash = (hash ^ (unsigned char)key[k]) * 16777619U;
        size_t slot = hash & 16383;
        while (session->span_slots[slot] &&
               strcmp(session->span_keys[session->span_slots[slot] - 1], key) != 0)
            slot = (slot + 1) & 16383;
        if (session->span_slots[slot])
            continue; /* Export retries do not create a second observation. */
        capture_producer_t *producer = NULL;
        for (size_t p = 0; p < session->producer_count; p++)
            if (strcmp(session->producers[p].id, producer_id) == 0)
                producer = &session->producers[p];
        if (!producer && session->producer_count < CAPTURE_PRODUCERS) {
            producer = &session->producers[session->producer_count++];
            snprintf(producer->id, sizeof(producer->id), "%s", producer_id);
            snprintf(producer->language, sizeof(producer->language), "%s", "otlp");
        }
        if (!producer || session->state || session->event_count == CAPTURE_EVENTS) {
            session->state = 2;
            (*rejected)++;
            continue;
        }
        yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
        if (!doc) {
            session->state = 2;
            (*rejected)++;
            continue;
        }
        yyjson_mut_val *event = yyjson_mut_obj(doc);
        yyjson_mut_doc_set_root(doc, event);
        yyjson_mut_obj_add_uint(doc, event, "id", session->event_count + 1);
        yyjson_mut_obj_add_uint(doc, event, "sequence", producer->sequence + 1);
        yyjson_mut_obj_add_strcpy(doc, event, "producer_id", producer_id);
        yyjson_mut_obj_add_strcpy(doc, event, "language",
                                  span->sdk_language[0] ? span->sdk_language : "unknown");
        yyjson_mut_obj_add_str(doc, event, "operation", "span");
        yyjson_mut_obj_add_strcpy(doc, event, "invocation_id", span->span_id);
        yyjson_mut_obj_add_strcpy(doc, event, "trace_id", span->trace_id);
        yyjson_mut_obj_add_strcpy(doc, event, "span_id", span->span_id);
        if (span->parent_span_id[0])
            yyjson_mut_obj_add_strcpy(doc, event, "parent_span_id", span->parent_span_id);
        yyjson_mut_obj_add_val(doc, event, "inputs", yyjson_mut_arr(doc));
        yyjson_mut_obj_add_str(doc, event, "source_status", "unmatched");
        yyjson_mut_obj_add_str(
            doc, event, "detail",
            span->producer_source == CBM_OTLP_PRODUCER_UNKNOWN
                ? "OTLP call span; producer identity and field lineage are unavailable."
                : "OTLP call span; no field value lineage was declared.");
        yyjson_mut_obj_add_strcpy(doc, event, "service_name", span->service_name);
        yyjson_mut_obj_add_strcpy(doc, event, "service_namespace", span->service_namespace);
        /* Nanoseconds exceed JS safe integer range; preserve as decimal text. */
        char timestamp[32];
        snprintf(timestamp, sizeof(timestamp), "%llu",
                 (unsigned long long)span->start_time_unix_nano);
        yyjson_mut_obj_add_strcpy(doc, event, "start_time_unix_nano", timestamp);
        snprintf(timestamp, sizeof(timestamp), "%llu",
                 (unsigned long long)span->end_time_unix_nano);
        yyjson_mut_obj_add_strcpy(doc, event, "end_time_unix_nano", timestamp);
        yyjson_mut_obj_add_int(doc, event, "span_kind", span->kind);
        yyjson_mut_obj_add_int(doc, event, "span_status", span->status_code);
        char *json = yyjson_mut_write_opts(doc, 0, cbm_json_writer_allocator(), NULL, NULL);
        yyjson_mut_doc_free(doc);
        if (!json || strlen(json) > CAPTURE_BYTES - session->bytes) {
            cbm_free(CBM_MEM_CLASS_OTHER, json);
            session->state = 2;
            (*rejected)++;
            continue;
        }
        producer->sequence++;
        size_t index = session->event_count++;
        session->events[index] = json;
        session->bytes += strlen(json);
        memcpy(session->span_keys[index], key, sizeof(key));
        session->span_slots[slot] = (uint16_t)(index + 1);
        (*accepted)++;
    }
    if (*rejected > CAPTURE_SAFE_INTEGER - session->dropped)
        session->dropped = CAPTURE_SAFE_INTEGER;
    else
        session->dropped += *rejected;
    return 200;
}

static bool capture_event_valid(yyjson_val *event) {
    const char *ops[] = {"value",     "copy",        "field",   "transform", "call", "return",
                         "serialize", "deserialize", "db_bind", "db_result", "gap",  "span"};
    yyjson_val *sequence = yyjson_obj_get(event, "sequence");
    yyjson_val *operation = yyjson_obj_get(event, "operation");
    yyjson_val *inputs = yyjson_obj_get(event, "inputs");
    if (!yyjson_is_obj(event) || !yyjson_is_uint(sequence) || !yyjson_get_uint(sequence) ||
        yyjson_get_uint(sequence) > CAPTURE_SAFE_INTEGER || !capture_string(operation, 32, false) ||
        !capture_string(yyjson_obj_get(event, "invocation_id"), 256, false) ||
        !yyjson_is_arr(inputs) || yyjson_arr_size(inputs) > 64)
        return false;
    bool known = false;
    for (size_t i = 0; i < sizeof(ops) / sizeof(ops[0]); i++)
        known |= strcmp(yyjson_get_str(operation), ops[i]) == 0;
    if (!known)
        return false;
    const char *keys[] = {"value_id", "access_path", "trace_id", "span_id", "detail"};
    const size_t limits[] = {256, 512, 128, 128, 1024};
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++)
        if (!capture_string(yyjson_obj_get(event, keys[i]), limits[i], true))
            return false;
    size_t i, max;
    yyjson_val *value;
    yyjson_arr_foreach(inputs, i, max, value) if (!capture_string(value, 256, false)) return false;
    yyjson_val *refs = yyjson_obj_get(event, "input_refs");
    if (refs && (!yyjson_is_arr(refs) || yyjson_arr_size(refs) > 64))
        return false;
    yyjson_arr_foreach(
        refs, i, max,
        value) if (!yyjson_is_obj(value) ||
                   !capture_string(yyjson_obj_get(value, "producer_id"), 128, false) ||
                   !capture_string(yyjson_obj_get(value, "value_id"), 256, false)) return false;
    yyjson_val *source = yyjson_obj_get(event, "source");
    if (source && (!yyjson_is_obj(source) ||
                   !capture_string(yyjson_obj_get(source, "file_path"), 4096, false) ||
                   !capture_string(yyjson_obj_get(source, "source_hash"), 128, false) ||
                   !capture_string(yyjson_obj_get(source, "symbol"), 1024, true) ||
                   !yyjson_is_uint(yyjson_obj_get(source, "line")) ||
                   yyjson_get_uint(yyjson_obj_get(source, "line")) == 0 ||
                   yyjson_get_uint(yyjson_obj_get(source, "line")) > INT32_MAX))
        return false;
    return true;
}

static bool capture_preview_allowed(const capture_session_t *session, const char *field) {
    if (!session->values_enabled || !field)
        return false;
    for (size_t i = 0; i < session->field_count; i++)
        if (strcmp(field, session->fields[i]) == 0)
            return true;
    return false;
}

static char *capture_event_json(capture_session_t *session, const capture_producer_t *producer,
                                yyjson_val *event, cbm_capture_source_check_fn check,
                                void *context) {
    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    if (!doc)
        return NULL;
    yyjson_mut_val *out = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, out);
    yyjson_mut_obj_add_uint(doc, out, "id", session->event_count + 1);
    yyjson_mut_obj_add_strcpy(doc, out, "producer_id", producer->id);
    yyjson_mut_obj_add_strcpy(doc, out, "language", producer->language);
    const char *keys[] = {"sequence",    "operation", "invocation_id", "value_id", "inputs",
                          "access_path", "trace_id",  "span_id",       "detail"};
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
        yyjson_val *value = yyjson_obj_get(event, keys[i]);
        if (value)
            yyjson_mut_obj_add_val(doc, out, keys[i], yyjson_val_mut_copy(doc, value));
    }
    yyjson_val *refs = yyjson_obj_get(event, "input_refs");
    if (refs) {
        yyjson_mut_val *result = yyjson_mut_arr(doc);
        size_t i, max;
        yyjson_val *ref;
        yyjson_arr_foreach(refs, i, max, ref) {
            yyjson_mut_val *item = yyjson_mut_obj(doc);
            yyjson_mut_obj_add_strcpy(doc, item, "producer_id",
                                      yyjson_get_str(yyjson_obj_get(ref, "producer_id")));
            yyjson_mut_obj_add_strcpy(doc, item, "value_id",
                                      yyjson_get_str(yyjson_obj_get(ref, "value_id")));
            yyjson_mut_arr_add_val(result, item);
        }
        yyjson_mut_obj_add_val(doc, out, "input_refs", result);
    }
    const char *source_status = "unmatched";
    yyjson_val *source = yyjson_obj_get(event, "source");
    if (source) {
        const char *path = yyjson_get_str(yyjson_obj_get(source, "file_path"));
        const char *hash = yyjson_get_str(yyjson_obj_get(source, "source_hash"));
        yyjson_mut_val *clean = yyjson_mut_obj(doc);
        yyjson_mut_obj_add_strcpy(doc, clean, "file_path", path);
        yyjson_mut_obj_add_strcpy(doc, clean, "source_hash", hash);
        yyjson_mut_obj_add_uint(doc, clean, "line",
                                yyjson_get_uint(yyjson_obj_get(source, "line")));
        const char *symbol = yyjson_get_str(yyjson_obj_get(source, "symbol"));
        if (symbol)
            yyjson_mut_obj_add_strcpy(doc, clean, "symbol", symbol);
        yyjson_mut_obj_add_val(doc, out, "source", clean);
        const char *checked = check ? check(context, path, hash) : NULL;
        if (checked && (strcmp(checked, "matched") == 0 || strcmp(checked, "stale") == 0))
            source_status = checked;
    }
    yyjson_mut_obj_add_str(doc, out, "source_status", source_status);
    yyjson_val *preview = yyjson_obj_get(event, "preview");
    if (preview &&
        capture_preview_allowed(session, yyjson_get_str(yyjson_obj_get(event, "access_path"))) &&
        !yyjson_is_obj(preview) && !yyjson_is_arr(preview)) {
        char *serialized =
            yyjson_is_str(preview)
                ? NULL
                : yyjson_val_write_opts(preview, 0, cbm_json_writer_allocator(), NULL, NULL);
        const char *text = yyjson_is_str(preview) ? yyjson_get_str(preview) : serialized;
        if (text) {
            size_t n = strlen(text);
            if (n > 256) {
                n = 256;
                while (n && ((unsigned char)text[n] & 0xc0) == 0x80)
                    n--;
            }
            yyjson_mut_obj_add_strncpy(doc, out, "preview", text, n);
        }
        if (serialized) {
            cbm_secure_zero(serialized, strlen(serialized));
            cbm_free(CBM_MEM_CLASS_OTHER, serialized);
        }
    }
    char *json = yyjson_mut_write_opts(doc, 0, cbm_json_writer_allocator(), NULL, NULL);
    yyjson_mut_doc_free(doc);
    return json;
}

char *cbm_capture_ingest(cbm_capture_manager_t *m, const char *id, const char *token,
                         const char *origin, const char *body, size_t length,
                         cbm_capture_source_check_fn check, void *context, int *status) {
    capture_session_t *session = capture_find(m, id);
    if (!session)
        return capture_error(status, 404, "Capture session not found.");
    capture_expire(session);
    if (session->state)
        return capture_error(status, 409, "Capture recording has stopped.");
    if (!cbm_capture_authorized(m, id, token) || !cbm_capture_origin_allowed(m, id, origin))
        return capture_error(status, 403, "Capture token or application origin is not authorized.");
    if (!body || length > 1024U * 1024U)
        return capture_error(status, 413, "Capture request exceeds 1 MiB.");
    yyjson_doc *doc = yyjson_read(body, length, 0);
    yyjson_val *root = yyjson_doc_get_root(doc), *producer = yyjson_obj_get(root, "producer");
    yyjson_val *events = yyjson_obj_get(root, "events");
    bool valid = yyjson_is_obj(root) && capture_unique_json(root, 0) &&
                 yyjson_get_int(yyjson_obj_get(root, "schema_version")) == 1 &&
                 capture_string(yyjson_obj_get(producer, "id"), 128, false) &&
                 capture_string(yyjson_obj_get(producer, "language"), 32, false) &&
                 yyjson_is_arr(events) && yyjson_arr_size(events) <= 1000;
    size_t i, max;
    yyjson_val *event;
    yyjson_arr_foreach(events, i, max, event) valid &= capture_event_valid(event);
    if (!valid) {
        yyjson_doc_free(doc);
        return capture_error(status, 400, "Invalid explicit lineage event batch.");
    }
    const char *producer_id = yyjson_get_str(yyjson_obj_get(producer, "id"));
    const char *language = yyjson_get_str(yyjson_obj_get(producer, "language"));
    if (strncmp(producer_id, "otlp:", 5) == 0) {
        yyjson_doc_free(doc);
        return capture_error(status, 400,
                             "The otlp producer namespace is reserved for call spans.");
    }
    capture_producer_t *state = NULL;
    for (i = 0; i < session->producer_count; i++)
        if (strcmp(session->producers[i].id, producer_id) == 0)
            state = &session->producers[i];
    if (state && strcmp(state->language, language) != 0) {
        yyjson_doc_free(doc);
        return capture_error(status, 409,
                             "Producer identity cannot change language during a session.");
    }
    if (!state) {
        if (session->producer_count == CAPTURE_PRODUCERS) {
            session->state = 2;
            yyjson_doc_free(doc);
            return capture_error(status, 409, "Capture producer limit reached.");
        }
        state = &session->producers[session->producer_count++];
        snprintf(state->id, sizeof(state->id), "%s", producer_id);
        snprintf(state->language, sizeof(state->language), "%s", language);
    }
    size_t accepted = 0;
    yyjson_arr_foreach(events, i, max, event) {
        uint64_t sequence = yyjson_get_uint(yyjson_obj_get(event, "sequence"));
        if (sequence <= state->sequence)
            continue; /* Retries are idempotent within one explicit producer. */
        if (session->event_count >= CAPTURE_EVENTS || session->state) {
            session->state = 2;
            session->dropped++;
            continue;
        }
        char *json = capture_event_json(session, state, event, check, context);
        if (!json || strlen(json) > CAPTURE_BYTES - session->bytes) {
            if (json) {
                cbm_secure_zero(json, strlen(json));
                cbm_free(CBM_MEM_CLASS_OTHER, json);
            }
            session->state = 2;
            session->dropped++;
            continue;
        }
        uint64_t missing = sequence - state->sequence - 1;
        if (missing > CAPTURE_SAFE_INTEGER - session->dropped)
            session->dropped = CAPTURE_SAFE_INTEGER;
        else
            session->dropped += missing;
        state->sequence = sequence;
        session->bytes += strlen(json);
        session->events[session->event_count++] = json;
        accepted++;
    }
    yyjson_doc_free(doc);
    yyjson_mut_doc *out = capture_envelope();
    if (!out)
        return capture_error(status, 500, "Unable to allocate response.");
    yyjson_mut_obj_add_uint(out, yyjson_mut_doc_get_root(out), "accepted", accepted);
    yyjson_mut_obj_add_val(out, yyjson_mut_doc_get_root(out), "session",
                           capture_session_json(out, session));
    return capture_write(out, status, 200);
}
