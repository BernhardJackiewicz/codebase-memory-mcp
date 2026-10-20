#ifndef CBM_FLOW_PUBLICATION_H
#define CBM_FLOW_PUBLICATION_H

#include "store/store.h"
#include <stdatomic.h>

/* Rebuilds Flow IR from the exact generation manifest inside the private
 * staging store. A source changed since indexing becomes an explicit gap,
 * never evidence from a different source snapshot. Atomic on failure.
 * This must run before advancing the store generation / publishing it. */
int cbm_flow_publish_snapshot(cbm_store_t *store, const char *project, const char *root_path,
                              const cbm_file_hash_t *manifest, int manifest_count,
                              const atomic_int *cancelled);

#endif
