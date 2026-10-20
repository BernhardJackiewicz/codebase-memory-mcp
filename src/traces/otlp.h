#ifndef CBM_OTLP_H
#define CBM_OTLP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Limits apply to decompressed OTLP/HTTP bodies. This module does no I/O. */
#define CBM_OTLP_MAX_BODY (1024u * 1024u)
#define CBM_OTLP_MAX_SPANS 2048u
#define CBM_OTLP_MAX_DEPTH 32u
#define CBM_OTLP_MAX_FIELDS 131072u
typedef enum { CBM_OTLP_JSON, CBM_OTLP_PROTOBUF } cbm_otlp_encoding_t;
typedef enum {
    CBM_OTLP_PRODUCER_UNKNOWN,
    CBM_OTLP_PRODUCER_EXPLICIT,
    CBM_OTLP_PRODUCER_SERVICE_INSTANCE
} cbm_otlp_producer_source_t;

/* Only identifiers, timings, enums and narrowly selected resource metadata.
 * No arbitrary attributes, names, SQL, URLs, status messages or payload values.
 * service.instance.id is scoped by service_name + service_namespace.
 * Trace/parent IDs describe call spans and never imply field/value lineage. */
typedef struct {
    char trace_id[33], span_id[17], parent_span_id[17];
    char producer_id[256], service_name[256], service_namespace[256], sdk_language[64];
    cbm_otlp_producer_source_t producer_source;
    uint64_t start_time_unix_nano, end_time_unix_nano;
    int32_t kind, status_code;
    uint32_t flags;
} cbm_otlp_span_t;
typedef struct {
    cbm_otlp_span_t *spans;
    size_t count;
} cbm_otlp_batch_t;

/* Initialize out to {0}, then cbm_otlp_batch_free before reuse. Failure leaves it empty.
 * Diagnostics never include request content. Empty exports are valid.
 * Caller handles authentication, compression, Content-Type and OTLP responses. */
bool cbm_otlp_decode(const void *body, size_t length, cbm_otlp_encoding_t encoding,
                     cbm_otlp_batch_t *out, char *error, size_t error_size);
void cbm_otlp_batch_free(cbm_otlp_batch_t *batch);

#endif
