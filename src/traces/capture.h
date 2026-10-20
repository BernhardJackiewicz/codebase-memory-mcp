#ifndef CBM_CAPTURE_H
#define CBM_CAPTURE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "traces/otlp.h"

/* Session-scoped, memory-only observations. Owned by the HTTP event-loop thread. */
typedef struct cbm_capture_manager cbm_capture_manager_t;
typedef const char *(*cbm_capture_source_check_fn)(void *context, const char *file,
                                                   const char *source_hash);
cbm_capture_manager_t *cbm_capture_new(void);
void cbm_capture_free(cbm_capture_manager_t *manager);
/* All JSON strings below are caller-owned: cbm_free(CBM_MEM_CLASS_OTHER, json). */
char *cbm_capture_create(cbm_capture_manager_t *manager, const char *body, int *status);
char *cbm_capture_list(cbm_capture_manager_t *manager, const char *project, int *status);
char *cbm_capture_stop(cbm_capture_manager_t *manager, const char *id, int *status);
char *cbm_capture_delete(cbm_capture_manager_t *manager, const char *id, int *status);
char *cbm_capture_events(cbm_capture_manager_t *manager, const char *id, uint64_t after,
                         int *status);
char *cbm_capture_ingest(cbm_capture_manager_t *manager, const char *id, const char *token,
                         const char *origin, const char *body, size_t length,
                         cbm_capture_source_check_fn check_source, void *source_context,
                         int *status);
bool cbm_capture_origin_allowed(cbm_capture_manager_t *manager, const char *id, const char *origin);
bool cbm_capture_authorized(cbm_capture_manager_t *manager, const char *id, const char *token);
const char *cbm_capture_project(cbm_capture_manager_t *manager, const char *id);
const char *cbm_capture_generation(cbm_capture_manager_t *manager, const char *id);
/* Normalized call spans remain distinct from explicit field lineage.
 * Counts support OTLP partial-success responses; no span attributes/values. */
int cbm_capture_ingest_spans(cbm_capture_manager_t *manager, const char *id, const char *token,
                             const char *origin, const cbm_otlp_batch_t *batch, size_t *accepted,
                             size_t *rejected);

#endif
