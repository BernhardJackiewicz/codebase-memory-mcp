#ifndef CBM_UI_DOCUMENTS_H
#define CBM_UI_DOCUMENTS_H

#include "store/store.h"

/* JSON is owned by the caller (cbm_free with CBM_MEM_CLASS_OTHER).
 * All queries are project/generation scoped. */
char *cbm_documents_list(cbm_store_t *store, const char *project, const char *kind,
                         const char *query, const char *cursor, int *http_status);
char *cbm_documents_detail(cbm_store_t *store, const char *project, int64_t node_id,
                           const char *file_path, const char *generation, int *http_status);

#endif
