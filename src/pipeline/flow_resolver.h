#ifndef CBM_FLOW_RESOLVER_H
#define CBM_FLOW_RESOLVER_H

#include "cbm.h"
#include "store/store.h"
#include <stdatomic.h>

typedef struct cbm_flow_resolver cbm_flow_resolver_t;

/* Captures pre-deduplication raw invocation facts while their AST source and
 * resolver-owned strings are alive. Thread safe; each file replaces its own
 * previous capture. Bounded independently of the primary call graph. */
cbm_flow_resolver_t *cbm_flow_resolver_new(void);
void cbm_flow_resolver_free(cbm_flow_resolver_t *resolver);
void cbm_flow_resolver_capture(cbm_flow_resolver_t *resolver, const char *file_path,
                               const char *source, int source_length, const CBMFileResult *result);

/* Applied only after all local Flow partitions are published in the private
 * staging database. Incremental mode preserves unchanged source-bound
 * witnesses; a changed/deleted source cannot retain its old witnesses. */
int cbm_flow_resolver_publish(cbm_store_t *store, const char *project,
                              const cbm_flow_resolver_t *resolver, bool incremental,
                              const atomic_int *cancelled);

#endif
