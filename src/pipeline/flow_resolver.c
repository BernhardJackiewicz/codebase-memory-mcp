#include "pipeline/flow_resolver.h"
#include "foundation/json_writer.h"
#include "foundation/mem_core.h"
#include "store/flow_ir.h"
#include "foundation/compat_thread.h"
#include "foundation/sha256.h"
#include <sqlite3.h>
#include <yyjson/yyjson.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    char *file_path, *json;
    char source_hash[65];
} flow_resolution_file;

struct cbm_flow_resolver {
    cbm_mutex_t mutex;
    flow_resolution_file *files;
    size_t count, capacity, bytes;
};

cbm_flow_resolver_t *cbm_flow_resolver_new(void) {
    cbm_flow_resolver_t *r = cbm_calloc(CBM_MEM_CLASS_OTHER, sizeof(*r));
    if (r)
        cbm_mutex_init(&r->mutex);
    return r;
}

void cbm_flow_resolver_free(cbm_flow_resolver_t *r) {
    if (!r)
        return;
    for (size_t i = 0; i < r->count; i++) {
        cbm_free(CBM_MEM_CLASS_OTHER, r->files[i].file_path);
        cbm_free(CBM_MEM_CLASS_OTHER, r->files[i].json);
    }
    cbm_free(CBM_MEM_CLASS_OTHER, r->files);
    cbm_mutex_destroy(&r->mutex);
    cbm_free(CBM_MEM_CLASS_OTHER, r);
}

/* These strategies identify direct/static declarations. Virtual dispatch,
 * callable aliases, unique-short-name guesses, reflection and preprocessed
 * locations require additional semantics and remain unresolved in Flow IR. */
static bool resolver_strategy(const char *s) {
    const char *allowed[] = {"lsp_direct",      "lsp_scoped",        "lsp_ts",
                             "lsp_ts_import",   "lsp_import_alias",  "lsp_module_attr",
                             "lsp_static_call", "lsp_static_import", "lsp_strategy_cross_file"};
    for (size_t i = 0; s && i < sizeof(allowed) / sizeof(allowed[0]); i++)
        if (!strcmp(s, allowed[i]))
            return true;
    return false;
}

void cbm_flow_resolver_capture(cbm_flow_resolver_t *r, const char *path, const char *source,
                               int length, const CBMFileResult *result) {
    if (!r || !path || !source || length <= 0 || !result || strlen(path) >= 4096 ||
        length > 4 * 1024 * 1024)
        return;
    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    if (!doc)
        return;
    yyjson_mut_val *array = yyjson_mut_arr(doc);
    yyjson_mut_doc_set_root(doc, array);
    /* A failed resolver cannot publish a partially proved invocation set.
     * Empty capture clears an older witness for this exact file. */
    for (int i = 0; !result->has_error && i < result->resolved_calls.count && i < 10000; i++) {
        const CBMResolvedCall *call = &result->resolved_calls.items[i];
        if (call->kind != CBM_RESOLVED_INVOCATION || call->source_origin != CBM_SOURCE_ORIGIN_RAW ||
            call->site_end_byte <= call->site_start_byte ||
            call->site_end_byte > (uint32_t)length || !call->caller_qn || !call->callee_qn ||
            !call->caller_qn[0] || !call->callee_qn[0] || !resolver_strategy(call->strategy) ||
            (call->reason && call->reason[0]) || (call->callee_sig && call->callee_sig[0]) ||
            strlen(call->caller_qn) > 4096 || strlen(call->callee_qn) > 4096)
            continue;
        /* Multiple targets for one occurrence are not a proven direct call.
         * Bound the pairwise check rather than silently choosing one target. */
        bool ambiguous = result->resolved_calls.count > 10000, duplicate = false;
        for (int j = 0; !ambiguous && j < result->resolved_calls.count; j++) {
            const CBMResolvedCall *other = &result->resolved_calls.items[j];
            if (i != j && other->kind == CBM_RESOLVED_INVOCATION &&
                other->source_origin == CBM_SOURCE_ORIGIN_RAW &&
                other->site_start_byte == call->site_start_byte &&
                other->site_end_byte == call->site_end_byte && other->callee_qn &&
                (!other->reason || !other->reason[0]) && other->strategy &&
                strcmp(other->strategy, "lsp_unresolved")) {
                if (strcmp(other->callee_qn, call->callee_qn) || !other->caller_qn ||
                    strcmp(other->caller_qn, call->caller_qn))
                    ambiguous = true;
                else if (j < i && resolver_strategy(other->strategy))
                    duplicate = true;
            }
        }
        if (ambiguous || duplicate)
            continue;
        yyjson_mut_val *item = yyjson_mut_obj(doc);
        yyjson_mut_obj_add_strcpy(doc, item, "caller", call->caller_qn);
        yyjson_mut_obj_add_strcpy(doc, item, "callee", call->callee_qn);
        yyjson_mut_obj_add_strcpy(doc, item, "strategy", call->strategy);
        yyjson_mut_obj_add_uint(doc, item, "start", call->site_start_byte);
        yyjson_mut_obj_add_uint(doc, item, "end", call->site_end_byte);
        yyjson_mut_arr_append(array, item);
    }
    size_t bytes = 0;
    char *json = yyjson_mut_write_opts(doc, 0, cbm_json_writer_allocator(), &bytes, NULL);
    yyjson_mut_doc_free(doc);
    if (!json || bytes > 1024 * 1024) {
        cbm_free(CBM_MEM_CLASS_OTHER, json);
        return;
    }
    char *owned_path = cbm_mem_strdup(CBM_MEM_CLASS_OTHER, path);
    if (!owned_path) {
        cbm_free(CBM_MEM_CLASS_OTHER, json);
        return;
    }
    char hash[65];
    cbm_sha256_hex(source, (size_t)length, hash);
    cbm_mutex_lock(&r->mutex);
    size_t index = r->count;
    for (size_t i = 0; i < r->count; i++)
        if (!strcmp(r->files[i].file_path, path)) {
            index = i;
            break;
        }
    bool ok = r->count < 100000 && bytes <= 64U * 1024U * 1024U - r->bytes;
    if (ok && index == r->count && r->count == r->capacity) {
        size_t capacity = r->capacity ? r->capacity * 2 : 64;
        void *next = cbm_realloc(CBM_MEM_CLASS_OTHER, r->files, capacity * sizeof(*r->files));
        if (!next)
            ok = false;
        else {
            r->files = next;
            r->capacity = capacity;
        }
    }
    if (ok) {
        if (index < r->count) {
            r->bytes -= strlen(r->files[index].json);
            cbm_free(CBM_MEM_CLASS_OTHER, r->files[index].file_path);
            cbm_free(CBM_MEM_CLASS_OTHER, r->files[index].json);
        } else
            r->count++;
        r->files[index] = (flow_resolution_file){.file_path = owned_path, .json = json};
        memcpy(r->files[index].source_hash, hash, sizeof(hash));
        r->bytes += bytes;
    }
    cbm_mutex_unlock(&r->mutex);
    if (!ok) {
        cbm_free(CBM_MEM_CLASS_OTHER, owned_path);
        cbm_free(CBM_MEM_CLASS_OTHER, json);
    }
}

static void bind_text(sqlite3_stmt *s, int n, const char *text) {
    sqlite3_bind_text(s, n, text, -1, SQLITE_TRANSIENT);
}

static const char *column_text(sqlite3_stmt *s, int n) {
    const unsigned char *text = sqlite3_column_text(s, n);
    return text ? (const char *)text : "";
}

/* Only exact QN or the same QN with the explicit project namespace. This is
 * the strict graph resolver policy, without tail/leaf-name fallbacks. */
static bool resolver_node(sqlite3 *db, const char *project, const char *qn, cbm_node_t *out) {
    sqlite3_stmt *s = NULL;
    bool ok =
        sqlite3_prepare_v2(
            db,
            "SELECT id,qualified_name,file_path,start_line,end_line,name "
            "FROM nodes WHERE project=?1 AND (qualified_name=?2 OR qualified_name=?1||'.'||?2) "
            "AND label IN('Function','Method') LIMIT 2",
            -1, &s, NULL) == SQLITE_OK;
    if (ok) {
        bind_text(s, 1, project);
        bind_text(s, 2, qn);
        ok = sqlite3_step(s) == SQLITE_ROW;
    }
    if (ok) {
        out->id = sqlite3_column_int64(s, 0);
        out->qualified_name = cbm_mem_strdup(CBM_MEM_CLASS_OTHER, column_text(s, 1));
        out->file_path = cbm_mem_strdup(CBM_MEM_CLASS_OTHER, column_text(s, 2));
        out->start_line = sqlite3_column_int(s, 3);
        out->end_line = sqlite3_column_int(s, 4);
        out->name = cbm_mem_strdup(CBM_MEM_CLASS_OTHER, column_text(s, 5));
        ok = out->qualified_name && out->file_path && out->name && sqlite3_step(s) == SQLITE_DONE;
    }
    sqlite3_finalize(s);
    return ok;
}

static void resolver_node_free(cbm_node_t *n) {
    cbm_free(CBM_MEM_CLASS_OTHER, (char *)n->qualified_name);
    cbm_free(CBM_MEM_CLASS_OTHER, (char *)n->file_path);
    cbm_free(CBM_MEM_CLASS_OTHER, (char *)n->name);
}

static void resolver_apply_call(cbm_store_t *store, const char *project, const char *file,
                                const char *hash, yyjson_val *call) {
    const char *caller_qn = yyjson_get_str(yyjson_obj_get(call, "caller"));
    const char *callee_qn = yyjson_get_str(yyjson_obj_get(call, "callee"));
    const char *strategy = yyjson_get_str(yyjson_obj_get(call, "strategy"));
    if (!caller_qn || !callee_qn || !resolver_strategy(strategy))
        return;
    sqlite3 *db = cbm_store_get_db(store);
    cbm_node_t caller = {0}, callee = {0};
    bool ok = resolver_node(db, project, caller_qn, &caller) &&
              resolver_node(db, project, callee_qn, &callee) && !strcmp(caller.file_path, file) &&
              strcmp(callee.file_path, file);
    sqlite3_stmt *s = NULL;
    if (ok)
        ok = sqlite3_prepare_v2(
                 db,
                 "SELECT c.operation_id,f.symbol,ff.source_hash FROM cbm_flow_callsites c "
                 "JOIN cbm_flow_functions f ON f.project=c.project AND f.file_path=?3 "
                 "JOIN cbm_flow_files ff ON ff.project=f.project AND ff.file_path=f.file_path "
                 "WHERE c.project=?1 AND c.file_path=?2 AND c.start_byte=?4 AND c.end_byte=?5 "
                 "AND f.name=?6 AND f.start_line=?7 AND f.end_line=?8 LIMIT 2",
                 -1, &s, NULL) == SQLITE_OK;
    if (ok) {
        bind_text(s, 1, project);
        bind_text(s, 2, file);
        bind_text(s, 3, callee.file_path);
        sqlite3_bind_int64(s, 4, yyjson_get_sint(yyjson_obj_get(call, "start")));
        sqlite3_bind_int64(s, 5, yyjson_get_sint(yyjson_obj_get(call, "end")));
        bind_text(s, 6, callee.name);
        sqlite3_bind_int(s, 7, callee.start_line);
        sqlite3_bind_int(s, 8, callee.end_line);
        ok = sqlite3_step(s) == SQLITE_ROW;
    }
    char *operation = NULL, *symbol = NULL, *callee_hash = NULL;
    if (ok) {
        operation = cbm_mem_strdup(CBM_MEM_CLASS_OTHER, column_text(s, 0));
        symbol = cbm_mem_strdup(CBM_MEM_CLASS_OTHER, column_text(s, 1));
        callee_hash = cbm_mem_strdup(CBM_MEM_CLASS_OTHER, column_text(s, 2));
        ok = operation && symbol && callee_hash && sqlite3_step(s) == SQLITE_DONE;
    }
    sqlite3_finalize(s);
    if (ok) {
        cbm_flow_binding_t binding = {
            .caller_file = file,
            .caller_hash = hash,
            .callee_file = callee.file_path,
            .callee_hash = callee_hash,
            .operation_id = operation,
            .callee_symbol = symbol,
            .caller_qn = caller.qualified_name,
            .callee_qn = callee.qualified_name,
            .strategy = strategy,
            .certainty = "proven",
            .caller_node_id = caller.id,
            .callee_node_id = callee.id,
            .site_start_byte = (int)yyjson_get_sint(yyjson_obj_get(call, "start")),
            .site_end_byte = (int)yyjson_get_sint(yyjson_obj_get(call, "end"))};
        /* An unsupported/ambiguous port shape leaves its existing unknown
         * flow and coverage gap. It does not abort the primary index. */
        (void)cbm_flow_ir_bind_call(store, project, &binding);
    }
    cbm_free(CBM_MEM_CLASS_OTHER, operation);
    cbm_free(CBM_MEM_CLASS_OTHER, symbol);
    cbm_free(CBM_MEM_CLASS_OTHER, callee_hash);
    resolver_node_free(&caller);
    resolver_node_free(&callee);
}

int cbm_flow_resolver_publish(cbm_store_t *store, const char *project, const cbm_flow_resolver_t *r,
                              bool incremental, const atomic_int *cancelled) {
    sqlite3 *db = store ? cbm_store_get_db(store) : NULL;
    if (!db || !project)
        return CBM_STORE_ERR;
    const char *ddl = "CREATE TABLE IF NOT EXISTS cbm_flow_resolver_files("
                      "project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,"
                      "file_path TEXT NOT NULL,source_hash TEXT NOT NULL,calls TEXT NOT NULL,"
                      "PRIMARY KEY(project,file_path));";
    bool ok = sqlite3_exec(db, ddl, NULL, NULL, NULL) == SQLITE_OK;
    sqlite3_stmt *s = NULL;
    const char *purge =
        incremental ? "DELETE FROM cbm_flow_resolver_files WHERE project=?1 AND NOT EXISTS("
                      "SELECT 1 FROM cbm_flow_files f WHERE f.project=?1 "
                      "AND f.file_path=cbm_flow_resolver_files.file_path "
                      "AND f.source_hash=cbm_flow_resolver_files.source_hash AND f.status='ready')"
                    : "DELETE FROM cbm_flow_resolver_files WHERE project=?1";
    if (ok)
        ok = sqlite3_prepare_v2(db, purge, -1, &s, NULL) == SQLITE_OK;
    if (ok) {
        bind_text(s, 1, project);
        ok = sqlite3_step(s) == SQLITE_DONE;
    }
    sqlite3_finalize(s);
    s = NULL;
    if (ok)
        ok = sqlite3_prepare_v2(
                 db,
                 "INSERT OR REPLACE INTO cbm_flow_resolver_files "
                 "SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM cbm_flow_files "
                 "WHERE project=?1 AND file_path=?2 AND source_hash=?3 AND status='ready')",
                 -1, &s, NULL) == SQLITE_OK;
    for (size_t i = 0; ok && r && i < r->count; i++) {
        if (cancelled && atomic_load(cancelled)) {
            ok = false;
            break;
        }
        bind_text(s, 1, project);
        bind_text(s, 2, r->files[i].file_path);
        bind_text(s, 3, r->files[i].source_hash);
        bind_text(s, 4, r->files[i].json);
        ok = sqlite3_step(s) == SQLITE_DONE;
        sqlite3_reset(s);
    }
    sqlite3_finalize(s);
    s = NULL;
    if (ok)
        ok = sqlite3_prepare_v2(db,
                                "SELECT file_path,source_hash,calls FROM cbm_flow_resolver_files "
                                "WHERE project=?1 ORDER BY file_path",
                                -1, &s, NULL) == SQLITE_OK;
    if (ok)
        bind_text(s, 1, project);
    int step = SQLITE_DONE;
    while (ok && (step = sqlite3_step(s)) == SQLITE_ROW) {
        if (cancelled && atomic_load(cancelled)) {
            ok = false;
            break;
        }
        const char *json = column_text(s, 2);
        yyjson_doc *doc = yyjson_read(json, strlen(json), 0);
        yyjson_val *array = doc ? yyjson_doc_get_root(doc) : NULL;
        size_t i, count;
        yyjson_val *call;
        yyjson_arr_foreach(array, i, count, call)
            resolver_apply_call(store, project, column_text(s, 0), column_text(s, 1), call);
        yyjson_doc_free(doc);
    }
    if (ok && step != SQLITE_DONE)
        ok = false;
    sqlite3_finalize(s);
    return ok ? CBM_STORE_OK : CBM_STORE_ERR;
}
