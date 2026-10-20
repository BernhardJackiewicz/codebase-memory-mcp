#ifndef CBM_FLOW_EXTRACT_H
#define CBM_FLOW_EXTRACT_H

#include "cbm.h"
#include "../../src/store/flow_ir.h"

/* An independent typed IR for the exact raw source snapshot. Does not turn
 * CALLS/USAGE rows or identifier spelling into def-use proof. The returned
 * arena owns every array/string in file; callers release it as one unit. */
typedef struct {
    CBMArena arena;
    cbm_flow_file_t file;
    CBMLanguage language;
} cbm_flow_extraction_t;

bool cbm_flow_extract_supports_language(CBMLanguage language);
int cbm_flow_extract_source(const char *source, int source_len, CBMLanguage language,
                            const char *project, const char *rel_path, cbm_flow_extraction_t **out);
void cbm_flow_extraction_free(cbm_flow_extraction_t *result);

#endif
