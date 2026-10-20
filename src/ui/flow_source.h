#ifndef CBM_UI_FLOW_SOURCE_H
#define CBM_UI_FLOW_SOURCE_H

#include "store/store.h"

/* Shared by static Flow and captured runtime source references. All identity
 * fields are required. Lines are one-based and inclusive; zero selects the
 * default (start 1, end start+199). No unverified source text is returned. */
typedef struct {
    const char *project;
    const char *generation;
    const char *file_path;
    const char *source_hash;
    int start_line;
    int end_line;
} cbm_source_evidence_request_t;

/* Caller frees JSON with cbm_free(CBM_MEM_CLASS_OTHER, ...). Errors are {"error":string}, status is
 * 400 invalid range/ref, 403 outside root, 404 unavailable/unindexed,
 * 409 stale generation/hash, 413 beyond verification budget, 503 read error.
 * Successful JSON has schema_version/project/generation/file_path/source_hash,
 * content/start_line/end_line/complete. Source verification reads <=4 MiB;
 * output contains <=200 complete lines from exactly those verified bytes. */
char *cbm_source_evidence(cbm_store_t *store, const cbm_source_evidence_request_t *request,
                          int *http_status);

#endif
