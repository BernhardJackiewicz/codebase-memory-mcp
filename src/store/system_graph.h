#ifndef CBM_SYSTEM_GRAPH_H
#define CBM_SYSTEM_GRAPH_H

#include "store/store.h"

typedef struct {
    int max_entities;  /* default 2048, ceiling 8192 */
    int max_relations; /* default 8192, ceiling 32768 */
    uint64_t deadline_ms;
    cbm_store_cancel_fn cancel;
    void *cancel_context;
} cbm_system_graph_options_t;

/* Bounded, read-only projection of indexed system relationships. The caller
 * owns the exclusive connection; an existing snapshot is reused. Public
 * references use cbm_store_generation. Never invents service boundaries,
 * field flows or deployment bindings. Returned JSON uses CBM_MEM_CLASS_OTHER. */
int cbm_store_system_graph(cbm_store_t *store, const char *project,
                           const cbm_system_graph_options_t *options, char **out_json);

#endif
