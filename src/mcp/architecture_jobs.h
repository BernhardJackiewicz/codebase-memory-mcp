#ifndef CBM_ARCHITECTURE_JOBS_H
#define CBM_ARCHITECTURE_JOBS_H

#include <stdbool.h>
#include <stdint.h>
#include "store/store.h"

typedef struct cbm_architecture_jobs cbm_architecture_jobs_t;

/* One worker and a small result cache per server. Requests only enqueue/poll;
 * the worker owns a separate read-only SQLite connection and snapshot. */
cbm_architecture_jobs_t *cbm_architecture_jobs_new(void);
void cbm_architecture_jobs_free(cbm_architecture_jobs_t *jobs);

/* Returns CBM_MEM_CLASS_OTHER-owned JSON; release it with
 * cbm_free(CBM_MEM_CLASS_OTHER, json).
 * Payload: {status, generation, retry_after_ms?, result?, error?}.
 * The supplied store is inspected only on the calling thread. */
char *cbm_architecture_jobs_request(cbm_architecture_jobs_t *jobs, cbm_store_t *store,
                                    const char *project, int64_t entry_node_id);
char *cbm_architecture_jobs_request_query(cbm_architecture_jobs_t *jobs, cbm_store_t *store,
                                          const char *project, int64_t entry_node_id,
                                          int64_t target_node_id, const char *expected_generation,
                                          bool include_behavior_evidence);

/* Additive system-graph projection. Public generation is cbm_store_generation,
 * shared with document/source references; cache identity remains private. */
char *cbm_architecture_jobs_request_system_graph(cbm_architecture_jobs_t *jobs, cbm_store_t *store,
                                                 const char *project,
                                                 const char *expected_generation);

#endif
