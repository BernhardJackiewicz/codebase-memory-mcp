#include "store/flow_ir.h"
#include "foundation/json_writer.h"
#include "foundation/mem_core.h"
#include "foundation/platform.h"
#include <sqlite3.h>
#include <yyjson/yyjson.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *FLOW_DDL =
    "CREATE TABLE IF NOT EXISTS cbm_flow_meta(version INTEGER NOT NULL);"
    "INSERT INTO cbm_flow_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM cbm_flow_meta);"
    "CREATE TABLE IF NOT EXISTS cbm_flow_files("
    "project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,"
    "file_path TEXT NOT NULL,source_hash TEXT NOT NULL,adapter TEXT NOT NULL,"
    "adapter_version INTEGER NOT NULL,status TEXT NOT NULL,"
    "PRIMARY KEY(project,file_path));"
    "CREATE TABLE IF NOT EXISTS cbm_flow_values("
    "project TEXT NOT NULL,id TEXT NOT NULL,file_path TEXT NOT NULL,symbol TEXT NOT NULL,"
    "binding TEXT NOT NULL,access_path TEXT NOT NULL,kind TEXT NOT NULL,"
    "symbol_node_id INTEGER NOT NULL,version INTEGER NOT NULL,start_byte INTEGER NOT NULL,"
    "end_byte INTEGER NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,"
    "parameter_index INTEGER NOT NULL,PRIMARY KEY(project,id),"
    "FOREIGN KEY(project,file_path) REFERENCES cbm_flow_files(project,file_path) ON DELETE "
    "CASCADE);"
    "CREATE INDEX IF NOT EXISTS cbm_flow_values_file ON cbm_flow_values(project,file_path);"
    "CREATE TABLE IF NOT EXISTS cbm_flow_operations("
    "project TEXT NOT NULL,id TEXT NOT NULL,file_path TEXT NOT NULL,symbol TEXT NOT NULL,"
    "kind TEXT NOT NULL,operator_name TEXT NOT NULL,start_byte INTEGER NOT NULL,"
    "end_byte INTEGER NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,"
    "PRIMARY KEY(project,id),"
    "FOREIGN KEY(project,file_path) REFERENCES cbm_flow_files(project,file_path) ON DELETE "
    "CASCADE);"
    "CREATE TABLE IF NOT EXISTS cbm_flow_links("
    "project TEXT NOT NULL,id TEXT NOT NULL,file_path TEXT NOT NULL,"
    "source TEXT NOT NULL,target TEXT NOT NULL,operation_id TEXT NOT NULL,"
    "kind TEXT NOT NULL,certainty TEXT NOT NULL,callsite_id TEXT NOT NULL,"
    "PRIMARY KEY(project,id),"
    "FOREIGN KEY(project,file_path) REFERENCES cbm_flow_files(project,file_path) ON DELETE CASCADE,"
    "FOREIGN KEY(project,source) REFERENCES cbm_flow_values(project,id) ON DELETE CASCADE,"
    "FOREIGN KEY(project,target) REFERENCES cbm_flow_values(project,id) ON DELETE CASCADE,"
    "FOREIGN KEY(project,operation_id) REFERENCES cbm_flow_operations(project,id) ON DELETE "
    "CASCADE);"
    "CREATE INDEX IF NOT EXISTS cbm_flow_links_source ON cbm_flow_links(project,source);"
    "CREATE INDEX IF NOT EXISTS cbm_flow_links_target ON cbm_flow_links(project,target);"
    "CREATE TABLE IF NOT EXISTS cbm_flow_gaps("
    "project TEXT NOT NULL,file_path TEXT NOT NULL,ordinal INTEGER NOT NULL,"
    "code TEXT NOT NULL,message TEXT NOT NULL,symbol TEXT NOT NULL,"
    "start_byte INTEGER NOT NULL,end_byte INTEGER NOT NULL,start_line INTEGER NOT NULL,"
    "PRIMARY KEY(project,file_path,ordinal),"
    "FOREIGN KEY(project,file_path) REFERENCES cbm_flow_files(project,file_path) ON DELETE "
    "CASCADE);"
    "CREATE TABLE IF NOT EXISTS cbm_flow_dependencies("
    "project TEXT NOT NULL,file_path TEXT NOT NULL,dependency_path TEXT NOT NULL,"
    "PRIMARY KEY(project,file_path,dependency_path),"
    "FOREIGN KEY(project,file_path) REFERENCES cbm_flow_files(project,file_path) ON DELETE "
    "CASCADE);"
    "CREATE INDEX IF NOT EXISTS cbm_flow_dependents "
    "ON cbm_flow_dependencies(project,dependency_path);"
    "CREATE TABLE IF NOT EXISTS cbm_flow_functions("
    "project TEXT NOT NULL,file_path TEXT NOT NULL,symbol TEXT NOT NULL,name TEXT NOT NULL,"
    "return_value_id TEXT NOT NULL,start_byte INTEGER NOT NULL,end_byte INTEGER NOT NULL,"
    "start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,positional INTEGER NOT NULL,"
    "method INTEGER NOT NULL,lexical_capture INTEGER NOT NULL,"
    "PRIMARY KEY(project,file_path,symbol),"
    "FOREIGN KEY(project,file_path) REFERENCES cbm_flow_files(project,file_path) ON DELETE CASCADE,"
    "FOREIGN KEY(project,return_value_id) REFERENCES cbm_flow_values(project,id) ON DELETE "
    "CASCADE);"
    "CREATE TABLE IF NOT EXISTS cbm_flow_formals("
    "project TEXT NOT NULL,file_path TEXT NOT NULL,symbol TEXT NOT NULL,ordinal INTEGER NOT NULL,"
    "value_id TEXT NOT NULL,PRIMARY KEY(project,file_path,symbol,ordinal),"
    "FOREIGN KEY(project,file_path,symbol) REFERENCES cbm_flow_functions(project,file_path,symbol)"
    " ON DELETE CASCADE,"
    "FOREIGN KEY(project,value_id) REFERENCES cbm_flow_values(project,id) ON DELETE CASCADE);"
    "CREATE TABLE IF NOT EXISTS cbm_flow_callsites("
    "project TEXT NOT NULL,operation_id TEXT NOT NULL,file_path TEXT NOT NULL,symbol TEXT NOT NULL,"
    "result_value_id TEXT NOT NULL,start_byte INTEGER NOT NULL,end_byte INTEGER NOT NULL,"
    "positional INTEGER NOT NULL,PRIMARY KEY(project,operation_id),"
    "FOREIGN KEY(project,operation_id) REFERENCES cbm_flow_operations(project,id) ON DELETE "
    "CASCADE,"
    "FOREIGN KEY(project,result_value_id) REFERENCES cbm_flow_values(project,id) ON DELETE "
    "CASCADE);"
    "CREATE TABLE IF NOT EXISTS cbm_flow_actuals("
    "project TEXT NOT NULL,operation_id TEXT NOT NULL,ordinal INTEGER NOT NULL,value_id TEXT NOT "
    "NULL,"
    "PRIMARY KEY(project,operation_id,ordinal),"
    "FOREIGN KEY(project,operation_id) REFERENCES cbm_flow_callsites(project,operation_id)"
    " ON DELETE CASCADE,"
    "FOREIGN KEY(project,value_id) REFERENCES cbm_flow_values(project,id) ON DELETE CASCADE);"
    "CREATE TABLE IF NOT EXISTS cbm_flow_bindings("
    "project TEXT NOT NULL,operation_id TEXT NOT NULL,caller_file TEXT NOT NULL,"
    "callee_file TEXT NOT NULL,source_hash TEXT NOT NULL,callee_hash TEXT NOT NULL,"
    "caller_qn TEXT NOT NULL,callee_qn TEXT NOT NULL,strategy TEXT NOT NULL,certainty TEXT NOT "
    "NULL,"
    "caller_node_id INTEGER NOT NULL,callee_node_id INTEGER NOT NULL,"
    "site_start_byte INTEGER NOT NULL,site_end_byte INTEGER NOT NULL,"
    "PRIMARY KEY(project,operation_id),"
    "FOREIGN KEY(project,operation_id) REFERENCES cbm_flow_callsites(project,operation_id)"
    " ON DELETE CASCADE,"
    "FOREIGN KEY(project,callee_file) REFERENCES cbm_flow_files(project,file_path) ON DELETE "
    "CASCADE);"
    "CREATE TABLE IF NOT EXISTS cbm_flow_package_bindings("
    "project TEXT NOT NULL,operation_id TEXT NOT NULL,callee_file TEXT NOT NULL,proof TEXT NOT "
    "NULL,"
    "PRIMARY KEY(project,operation_id),"
    "FOREIGN KEY(project,operation_id) REFERENCES cbm_flow_callsites(project,operation_id)"
    " ON DELETE CASCADE,"
    "FOREIGN KEY(project,callee_file) REFERENCES cbm_flow_files(project,file_path) ON DELETE "
    "CASCADE);"
    "CREATE TABLE IF NOT EXISTS cbm_flow_packages("
    "project TEXT NOT NULL,file_path TEXT NOT NULL,package_id TEXT NOT NULL,"
    "package_version TEXT NOT NULL,manifest_hash TEXT NOT NULL,PRIMARY KEY(project,file_path),"
    "FOREIGN KEY(project,file_path) REFERENCES cbm_flow_files(project,file_path) ON DELETE "
    "CASCADE);";

static bool flow_string(const char *value, bool empty) {
    return value && (empty || value[0]) && strlen(value) <= 4096;
}

static bool flow_path(const char *path) {
    return flow_string(path, false) && path[0] != '/' && path[0] != '\\' && !strchr(path, '\\') &&
           strcmp(path, "..") != 0 && strncmp(path, "../", 3) != 0 && !strstr(path, "/../") &&
           (strlen(path) < 3 || strcmp(path + strlen(path) - 3, "/..") != 0);
}

static bool flow_is(const char *value, const char *other) {
    return value && strcmp(value, other) == 0;
}

static void flow_bind(sqlite3_stmt *stmt, int slot, const char *value) {
    sqlite3_bind_text(stmt, slot, value ? value : "", -1, SQLITE_TRANSIENT);
}

static int flow_schema(sqlite3 *db) {
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, "SELECT version FROM cbm_flow_meta", -1, &stmt, NULL) != SQLITE_OK)
        return CBM_STORE_NOT_FOUND;
    int result = CBM_STORE_ERR;
    if (sqlite3_step(stmt) == SQLITE_ROW &&
        sqlite3_column_int(stmt, 0) == CBM_FLOW_IR_SCHEMA_VERSION &&
        sqlite3_step(stmt) == SQLITE_DONE)
        result = CBM_STORE_OK;
    sqlite3_finalize(stmt);
    return result;
}

int cbm_flow_ir_initialize(cbm_store_t *store) {
    if (!store)
        return CBM_STORE_ERR;
    sqlite3 *db = cbm_store_get_db(store);
    if (sqlite3_exec(db, "SAVEPOINT cbm_flow_init", NULL, NULL, NULL) != SQLITE_OK)
        return CBM_STORE_ERR;
    bool ok = sqlite3_exec(db, FLOW_DDL, NULL, NULL, NULL) == SQLITE_OK &&
              flow_schema(db) == CBM_STORE_OK;
    if (!ok)
        sqlite3_exec(db, "ROLLBACK TO cbm_flow_init", NULL, NULL, NULL);
    if (sqlite3_exec(db, "RELEASE cbm_flow_init", NULL, NULL, NULL) != SQLITE_OK)
        ok = false;
    return ok ? CBM_STORE_OK : CBM_STORE_ERR;
}

static bool flow_access_path(const char *text) {
    if (!flow_string(text, false))
        return false;
    yyjson_doc *doc = yyjson_read(text, strlen(text), 0);
    yyjson_val *root = doc ? yyjson_doc_get_root(doc) : NULL;
    bool ok = yyjson_is_arr(root) && yyjson_arr_size(root) <= 32;
    size_t i, size;
    yyjson_val *item;
    yyjson_arr_foreach(root, i, size, item) {
        if (!yyjson_is_str(item) || !yyjson_get_len(item) || yyjson_get_len(item) > 512)
            ok = false;
    }
    yyjson_doc_free(doc);
    return ok;
}

static bool flow_validate(const cbm_flow_file_t *file) {
    if (!file || !flow_string(file->source_hash, false) || !flow_string(file->adapter, false) ||
        file->adapter_version <= 0 || file->value_count > 100000 ||
        file->operation_count > 100000 || file->link_count > 400000 || file->gap_count > 10000 ||
        file->dependency_count > 10000 || file->function_count > 10000 ||
        file->callsite_count > 100000 || (file->value_count && !file->values) ||
        (file->operation_count && !file->operations) || (file->link_count && !file->links) ||
        (file->gap_count && !file->gaps) || (file->dependency_count && !file->dependencies) ||
        (file->function_count && !file->functions) || (file->callsite_count && !file->callsites) ||
        (file->package_id && file->package_id[0] &&
         (!flow_string(file->package_id, false) || !flow_string(file->package_version, false) ||
          !flow_string(file->package_manifest_hash, false))))
        return false;
    for (size_t i = 0; i < file->value_count; i++) {
        const cbm_flow_value_t *v = &file->values[i];
        if (!flow_string(v->id, false) || !flow_string(v->symbol, false) ||
            !flow_string(v->binding, false) || !flow_access_path(v->access_path) ||
            !flow_string(v->kind, false) || v->version < 0 || v->start_byte < 0 ||
            v->end_byte < v->start_byte || v->start_line < 0 || v->end_line < v->start_line ||
            v->symbol_node_id < 0 || v->parameter_index < -1)
            return false;
    }
    for (size_t i = 0; i < file->operation_count; i++) {
        const cbm_flow_operation_t *op = &file->operations[i];
        if (!flow_string(op->id, false) || !flow_string(op->symbol, false) ||
            !flow_string(op->kind, false) || !flow_string(op->operator_name, true) ||
            op->start_byte < 0 || op->end_byte < op->start_byte || op->start_line < 0 ||
            op->end_line < op->start_line)
            return false;
    }
    for (size_t i = 0; i < file->link_count; i++) {
        const cbm_flow_link_t *link = &file->links[i];
        bool certainty = flow_is(link->certainty, "proven") || flow_is(link->certainty, "may") ||
                         flow_is(link->certainty, "derived") ||
                         flow_is(link->certainty, "control") || flow_is(link->certainty, "unknown");
        if (!flow_string(link->id, false) || !flow_string(link->source, false) ||
            !flow_string(link->target, false) || !flow_string(link->operation_id, false) ||
            !flow_string(link->kind, false) || !certainty ||
            (link->callsite_id && !flow_string(link->callsite_id, true)) ||
            ((flow_is(link->kind, "argument") || flow_is(link->kind, "return")) &&
             !flow_string(link->callsite_id, false)))
            return false;
    }
    for (size_t i = 0; i < file->gap_count; i++) {
        const cbm_flow_gap_t *gap = &file->gaps[i];
        if (!flow_string(gap->code, false) || !flow_string(gap->message, false) ||
            !flow_string(gap->symbol, true) || gap->start_byte < 0 ||
            gap->end_byte < gap->start_byte || gap->start_line < 0)
            return false;
    }
    for (size_t i = 0; i < file->dependency_count; i++)
        if (!flow_path(file->dependencies[i]))
            return false;
    for (size_t i = 0; i < file->function_count; i++) {
        const cbm_flow_function_t *fn = &file->functions[i];
        if (!flow_string(fn->symbol, false) || !flow_string(fn->name, false) ||
            !flow_string(fn->return_value_id, false) || fn->parameter_count > 256 ||
            (fn->parameter_count && !fn->parameter_value_ids) || fn->start_byte < 0 ||
            fn->end_byte <= fn->start_byte || fn->start_line < 1 || fn->end_line < fn->start_line)
            return false;
        for (size_t p = 0; p < fn->parameter_count; p++)
            if (!flow_string(fn->parameter_value_ids[p], false))
                return false;
    }
    for (size_t i = 0; i < file->callsite_count; i++) {
        const cbm_flow_callsite_t *site = &file->callsites[i];
        if (!flow_string(site->operation_id, false) || !flow_string(site->symbol, false) ||
            !flow_string(site->result_value_id, false) || site->argument_count > 256 ||
            (site->argument_count && !site->argument_value_ids) || site->start_byte < 0 ||
            site->end_byte <= site->start_byte)
            return false;
        for (size_t a = 0; a < site->argument_count; a++)
            if (!flow_string(site->argument_value_ids[a], false))
                return false;
    }
    return true;
}

static int flow_invalidate_delete(sqlite3 *db, const char *project, const char *path) {
    const char *invalidate =
        "WITH RECURSIVE impacted(file_path) AS("
        "SELECT file_path FROM cbm_flow_dependencies WHERE project=?1 AND dependency_path=?2 "
        "UNION SELECT d.file_path FROM cbm_flow_dependencies d JOIN impacted i "
        "ON d.dependency_path=i.file_path WHERE d.project=?1) "
        "UPDATE cbm_flow_files SET status='stale' WHERE project=?1 "
        "AND file_path IN(SELECT file_path FROM impacted)";
    sqlite3_stmt *stmt = NULL;
    bool ok = sqlite3_prepare_v2(db, invalidate, -1, &stmt, NULL) == SQLITE_OK;
    if (ok) {
        flow_bind(stmt, 1, project);
        flow_bind(stmt, 2, path);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
    }
    sqlite3_finalize(stmt);
    stmt = NULL;
    if (ok)
        ok = sqlite3_prepare_v2(db, "DELETE FROM cbm_flow_files WHERE project=?1 AND file_path=?2",
                                -1, &stmt, NULL) == SQLITE_OK;
    if (ok) {
        flow_bind(stmt, 1, project);
        flow_bind(stmt, 2, path);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
    }
    sqlite3_finalize(stmt);
    return ok ? CBM_STORE_OK : CBM_STORE_ERR;
}

static bool flow_insert_values(sqlite3 *db, const char *project, const char *path,
                               const cbm_flow_file_t *file) {
    sqlite3_stmt *stmt = NULL;
    const char *sql = "INSERT INTO cbm_flow_values VALUES("
                      "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)";
    bool ok = sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK;
    for (size_t i = 0; ok && i < file->value_count; i++) {
        const cbm_flow_value_t *v = &file->values[i];
        flow_bind(stmt, 1, project);
        flow_bind(stmt, 2, v->id);
        flow_bind(stmt, 3, path);
        flow_bind(stmt, 4, v->symbol);
        flow_bind(stmt, 5, v->binding);
        flow_bind(stmt, 6, v->access_path);
        flow_bind(stmt, 7, v->kind);
        sqlite3_bind_int64(stmt, 8, v->symbol_node_id);
        sqlite3_bind_int(stmt, 9, v->version);
        sqlite3_bind_int(stmt, 10, v->start_byte);
        sqlite3_bind_int(stmt, 11, v->end_byte);
        sqlite3_bind_int(stmt, 12, v->start_line);
        sqlite3_bind_int(stmt, 13, v->end_line);
        sqlite3_bind_int(stmt, 14, v->parameter_index);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_reset(stmt);
    }
    sqlite3_finalize(stmt);
    return ok;
}

static bool flow_insert_operations(sqlite3 *db, const char *project, const char *path,
                                   const cbm_flow_file_t *file) {
    sqlite3_stmt *stmt = NULL;
    bool ok = sqlite3_prepare_v2(db,
                                 "INSERT INTO cbm_flow_operations VALUES("
                                 "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                                 -1, &stmt, NULL) == SQLITE_OK;
    for (size_t i = 0; ok && i < file->operation_count; i++) {
        const cbm_flow_operation_t *op = &file->operations[i];
        flow_bind(stmt, 1, project);
        flow_bind(stmt, 2, op->id);
        flow_bind(stmt, 3, path);
        flow_bind(stmt, 4, op->symbol);
        flow_bind(stmt, 5, op->kind);
        flow_bind(stmt, 6, op->operator_name);
        sqlite3_bind_int(stmt, 7, op->start_byte);
        sqlite3_bind_int(stmt, 8, op->end_byte);
        sqlite3_bind_int(stmt, 9, op->start_line);
        sqlite3_bind_int(stmt, 10, op->end_line);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_reset(stmt);
    }
    sqlite3_finalize(stmt);
    return ok;
}

static bool flow_insert_links(sqlite3 *db, const char *project, const char *path,
                              const cbm_flow_file_t *file) {
    sqlite3_stmt *stmt = NULL;
    bool ok = sqlite3_prepare_v2(db,
                                 "INSERT INTO cbm_flow_links VALUES("
                                 "?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                                 -1, &stmt, NULL) == SQLITE_OK;
    for (size_t i = 0; ok && i < file->link_count; i++) {
        const cbm_flow_link_t *link = &file->links[i];
        flow_bind(stmt, 1, project);
        flow_bind(stmt, 2, link->id);
        flow_bind(stmt, 3, path);
        flow_bind(stmt, 4, link->source);
        flow_bind(stmt, 5, link->target);
        flow_bind(stmt, 6, link->operation_id);
        flow_bind(stmt, 7, link->kind);
        flow_bind(stmt, 8, link->certainty);
        flow_bind(stmt, 9, link->callsite_id);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_reset(stmt);
    }
    sqlite3_finalize(stmt);
    return ok;
}

static bool flow_insert_gaps_dependencies(sqlite3 *db, const char *project, const char *path,
                                          const cbm_flow_file_t *file) {
    sqlite3_stmt *stmt = NULL;
    bool ok = sqlite3_prepare_v2(db,
                                 "INSERT INTO cbm_flow_gaps VALUES("
                                 "?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                                 -1, &stmt, NULL) == SQLITE_OK;
    for (size_t i = 0; ok && i < file->gap_count; i++) {
        const cbm_flow_gap_t *gap = &file->gaps[i];
        flow_bind(stmt, 1, project);
        flow_bind(stmt, 2, path);
        sqlite3_bind_int64(stmt, 3, (int64_t)i);
        flow_bind(stmt, 4, gap->code);
        flow_bind(stmt, 5, gap->message);
        flow_bind(stmt, 6, gap->symbol);
        sqlite3_bind_int(stmt, 7, gap->start_byte);
        sqlite3_bind_int(stmt, 8, gap->end_byte);
        sqlite3_bind_int(stmt, 9, gap->start_line);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_reset(stmt);
    }
    sqlite3_finalize(stmt);
    stmt = NULL;
    if (ok)
        ok = sqlite3_prepare_v2(db, "INSERT OR IGNORE INTO cbm_flow_dependencies VALUES(?1,?2,?3)",
                                -1, &stmt, NULL) == SQLITE_OK;
    for (size_t i = 0; ok && i < file->dependency_count; i++) {
        flow_bind(stmt, 1, project);
        flow_bind(stmt, 2, path);
        flow_bind(stmt, 3, file->dependencies[i]);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_reset(stmt);
    }
    sqlite3_finalize(stmt);
    return ok;
}

static bool flow_insert_ports(sqlite3 *db, const char *project, const char *path,
                              const cbm_flow_file_t *file) {
    sqlite3_stmt *fn = NULL, *formal = NULL, *call = NULL, *actual = NULL, *package = NULL;
    bool ok = sqlite3_prepare_v2(db,
                                 "INSERT INTO cbm_flow_functions VALUES("
                                 "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                                 -1, &fn, NULL) == SQLITE_OK &&
              sqlite3_prepare_v2(db, "INSERT INTO cbm_flow_formals VALUES(?1,?2,?3,?4,?5)", -1,
                                 &formal, NULL) == SQLITE_OK &&
              sqlite3_prepare_v2(db,
                                 "INSERT INTO cbm_flow_callsites VALUES("
                                 "?1,?2,?3,?4,?5,?6,?7,?8)",
                                 -1, &call, NULL) == SQLITE_OK &&
              sqlite3_prepare_v2(db, "INSERT INTO cbm_flow_actuals VALUES(?1,?2,?3,?4)", -1,
                                 &actual, NULL) == SQLITE_OK;
    for (size_t i = 0; ok && i < file->function_count; i++) {
        const cbm_flow_function_t *f = &file->functions[i];
        flow_bind(fn, 1, project);
        flow_bind(fn, 2, path);
        flow_bind(fn, 3, f->symbol);
        flow_bind(fn, 4, f->name);
        flow_bind(fn, 5, f->return_value_id);
        sqlite3_bind_int(fn, 6, f->start_byte);
        sqlite3_bind_int(fn, 7, f->end_byte);
        sqlite3_bind_int(fn, 8, f->start_line);
        sqlite3_bind_int(fn, 9, f->end_line);
        sqlite3_bind_int(fn, 10, f->positional);
        sqlite3_bind_int(fn, 11, f->method);
        sqlite3_bind_int(fn, 12, f->lexical_capture);
        ok = sqlite3_step(fn) == SQLITE_DONE;
        sqlite3_reset(fn);
        for (size_t p = 0; ok && p < f->parameter_count; p++) {
            flow_bind(formal, 1, project);
            flow_bind(formal, 2, path);
            flow_bind(formal, 3, f->symbol);
            sqlite3_bind_int64(formal, 4, (int64_t)p);
            flow_bind(formal, 5, f->parameter_value_ids[p]);
            ok = sqlite3_step(formal) == SQLITE_DONE;
            sqlite3_reset(formal);
        }
    }
    for (size_t i = 0; ok && i < file->callsite_count; i++) {
        const cbm_flow_callsite_t *s = &file->callsites[i];
        flow_bind(call, 1, project);
        flow_bind(call, 2, s->operation_id);
        flow_bind(call, 3, path);
        flow_bind(call, 4, s->symbol);
        flow_bind(call, 5, s->result_value_id);
        sqlite3_bind_int(call, 6, s->start_byte);
        sqlite3_bind_int(call, 7, s->end_byte);
        sqlite3_bind_int(call, 8, s->positional);
        ok = sqlite3_step(call) == SQLITE_DONE;
        sqlite3_reset(call);
        for (size_t a = 0; ok && a < s->argument_count; a++) {
            flow_bind(actual, 1, project);
            flow_bind(actual, 2, s->operation_id);
            sqlite3_bind_int64(actual, 3, (int64_t)a);
            flow_bind(actual, 4, s->argument_value_ids[a]);
            ok = sqlite3_step(actual) == SQLITE_DONE;
            sqlite3_reset(actual);
        }
    }
    if (ok && file->package_id && file->package_id[0]) {
        ok = sqlite3_prepare_v2(db, "INSERT INTO cbm_flow_packages VALUES(?1,?2,?3,?4,?5)", -1,
                                &package, NULL) == SQLITE_OK;
        if (ok) {
            flow_bind(package, 1, project);
            flow_bind(package, 2, path);
            flow_bind(package, 3, file->package_id);
            flow_bind(package, 4, file->package_version);
            flow_bind(package, 5, file->package_manifest_hash);
            ok = sqlite3_step(package) == SQLITE_DONE;
        }
    }
    sqlite3_finalize(fn);
    sqlite3_finalize(formal);
    sqlite3_finalize(call);
    sqlite3_finalize(actual);
    sqlite3_finalize(package);
    return ok;
}

int cbm_flow_ir_replace_file(cbm_store_t *store, const char *project, const char *file_path,
                             const cbm_flow_file_t *file) {
    if (!store || !flow_string(project, false) || !flow_path(file_path) || !flow_validate(file))
        return CBM_STORE_ERR;
    sqlite3 *db = cbm_store_get_db(store);
    if (flow_schema(db) != CBM_STORE_OK ||
        sqlite3_exec(db, "SAVEPOINT cbm_flow_replace", NULL, NULL, NULL) != SQLITE_OK)
        return CBM_STORE_ERR;
    bool ok = flow_invalidate_delete(db, project, file_path) == CBM_STORE_OK;
    sqlite3_stmt *stmt = NULL;
    if (ok)
        ok = sqlite3_prepare_v2(db, "INSERT INTO cbm_flow_files VALUES(?1,?2,?3,?4,?5,'ready')", -1,
                                &stmt, NULL) == SQLITE_OK;
    if (ok) {
        flow_bind(stmt, 1, project);
        flow_bind(stmt, 2, file_path);
        flow_bind(stmt, 3, file->source_hash);
        flow_bind(stmt, 4, file->adapter);
        sqlite3_bind_int(stmt, 5, file->adapter_version);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
    }
    sqlite3_finalize(stmt);
    if (ok)
        ok = flow_insert_values(db, project, file_path, file) &&
             flow_insert_operations(db, project, file_path, file) &&
             flow_insert_links(db, project, file_path, file) &&
             flow_insert_gaps_dependencies(db, project, file_path, file) &&
             flow_insert_ports(db, project, file_path, file);
    if (!ok)
        sqlite3_exec(db, "ROLLBACK TO cbm_flow_replace", NULL, NULL, NULL);
    if (sqlite3_exec(db, "RELEASE cbm_flow_replace", NULL, NULL, NULL) != SQLITE_OK)
        ok = false;
    return ok ? CBM_STORE_OK : CBM_STORE_ERR;
}

int cbm_flow_ir_delete_file(cbm_store_t *store, const char *project, const char *file_path) {
    if (!store || !flow_string(project, false) || !flow_path(file_path))
        return CBM_STORE_ERR;
    sqlite3 *db = cbm_store_get_db(store);
    if (flow_schema(db) != CBM_STORE_OK ||
        sqlite3_exec(db, "SAVEPOINT cbm_flow_delete", NULL, NULL, NULL) != SQLITE_OK)
        return CBM_STORE_ERR;
    bool ok = flow_invalidate_delete(db, project, file_path) == CBM_STORE_OK;
    if (!ok)
        sqlite3_exec(db, "ROLLBACK TO cbm_flow_delete", NULL, NULL, NULL);
    if (sqlite3_exec(db, "RELEASE cbm_flow_delete", NULL, NULL, NULL) != SQLITE_OK)
        ok = false;
    return ok ? CBM_STORE_OK : CBM_STORE_ERR;
}

/* Every statement shares this numbered parameter namespace. Only slots
 * present in a statement are bound; no SQL contains caller-provided text. */
static sqlite3_stmt *flow_binding_statement(sqlite3 *db, const char *sql, const char *project,
                                            const cbm_flow_binding_t *b) {
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) != SQLITE_OK)
        return NULL;
    int count = sqlite3_bind_parameter_count(stmt);
    const char *strings[] = {project,        b->caller_file,  b->caller_hash,   b->callee_file,
                             b->callee_hash, b->operation_id, b->callee_symbol, b->caller_qn,
                             b->callee_qn,   b->strategy,     b->certainty};
    for (int i = 0; i < count && i < 11; i++)
        flow_bind(stmt, i + 1, strings[i]);
    if (count >= 12)
        sqlite3_bind_int64(stmt, 12, b->caller_node_id);
    if (count >= 13)
        sqlite3_bind_int64(stmt, 13, b->callee_node_id);
    if (count >= 14)
        sqlite3_bind_int(stmt, 14, b->site_start_byte);
    if (count >= 15)
        sqlite3_bind_int(stmt, 15, b->site_end_byte);
    return stmt;
}

int cbm_flow_ir_bind_call(cbm_store_t *store, const char *project, const cbm_flow_binding_t *b) {
    if (!store || !flow_string(project, false) || !b || !flow_path(b->caller_file) ||
        !flow_path(b->callee_file) || !flow_string(b->caller_hash, false) ||
        !flow_string(b->callee_hash, false) || !flow_string(b->operation_id, false) ||
        strlen(b->operation_id) > 4000 || !flow_string(b->callee_symbol, false) ||
        !flow_string(b->caller_qn, false) || !flow_string(b->callee_qn, false) ||
        !flow_string(b->strategy, false) ||
        !(flow_is(b->certainty, "proven") || flow_is(b->certainty, "may")) ||
        b->caller_node_id <= 0 || b->callee_node_id <= 0 || b->site_start_byte < 0 ||
        b->site_end_byte <= b->site_start_byte)
        return CBM_STORE_ERR;
    sqlite3 *db = cbm_store_get_db(store);
    if (flow_schema(db) != CBM_STORE_OK ||
        sqlite3_exec(db, "SAVEPOINT cbm_flow_bind", NULL, NULL, NULL) != SQLITE_OK)
        return CBM_STORE_ERR;
    /* An exact invocation record, compatible AST ports, and canonical
     * declaration identity are all required. A graph CALLS edge alone does
     * not contain enough information to satisfy this query. */
    const char *check =
        "SELECT 1 FROM cbm_flow_callsites c "
        "JOIN cbm_flow_operations o ON o.project=c.project AND o.id=c.operation_id "
        "JOIN cbm_flow_values rv ON rv.project=c.project AND rv.id=c.result_value_id "
        "JOIN cbm_flow_files src ON src.project=c.project AND src.file_path=c.file_path "
        "JOIN cbm_flow_functions fn ON fn.project=c.project AND fn.file_path=?4 AND fn.symbol=?7 "
        "JOIN cbm_flow_values ret ON ret.project=fn.project AND ret.id=fn.return_value_id "
        "JOIN cbm_flow_files dst ON dst.project=fn.project AND dst.file_path=fn.file_path "
        "JOIN nodes caller ON caller.project=c.project AND caller.id=?12 "
        "JOIN nodes callee ON callee.project=fn.project AND callee.id=?13 "
        "WHERE c.project=?1 AND c.operation_id=?6 AND c.file_path=?2 "
        "AND src.source_hash=?3 AND dst.source_hash=?5 AND src.status='ready' AND "
        "dst.status='ready' "
        "AND c.positional=1 AND fn.positional=1 AND fn.method=0 AND fn.lexical_capture=0 "
        "AND c.start_byte=?14 AND c.end_byte=?15 AND o.start_byte=?14 AND o.end_byte=?15 "
        "AND o.kind='call' AND o.symbol=c.symbol AND rv.file_path=c.file_path "
        "AND rv.symbol=c.symbol AND ret.file_path=fn.file_path AND ret.symbol=fn.symbol "
        "AND caller.qualified_name=?8 AND caller.file_path=c.file_path "
        "AND caller.label IN('Function','Method') AND caller.start_line<=o.start_line "
        "AND caller.end_line>=o.end_line AND o.start_line>0 "
        "AND callee.qualified_name=?9 AND callee.file_path=fn.file_path "
        "AND callee.label='Function' AND callee.name=fn.name "
        "AND callee.start_line=fn.start_line AND callee.end_line=fn.end_line "
        "AND (SELECT COUNT(*) FROM cbm_flow_functions f WHERE f.project=fn.project "
        " AND f.file_path=fn.file_path AND f.start_line=fn.start_line "
        " AND f.end_line=fn.end_line AND f.name=fn.name)=1 "
        "AND (SELECT COUNT(*) FROM cbm_flow_actuals a WHERE a.project=c.project "
        " AND a.operation_id=c.operation_id)="
        "(SELECT COUNT(*) FROM cbm_flow_formals p WHERE p.project=fn.project "
        " AND p.file_path=fn.file_path AND p.symbol=fn.symbol) "
        "AND NOT EXISTS(SELECT 1 FROM cbm_flow_actuals a "
        " JOIN cbm_flow_values v ON v.project=a.project AND v.id=a.value_id "
        " WHERE a.project=c.project AND a.operation_id=c.operation_id "
        " AND (v.file_path<>c.file_path OR v.symbol<>c.symbol)) "
        "AND NOT EXISTS(SELECT 1 FROM cbm_flow_formals p "
        " JOIN cbm_flow_values v ON v.project=p.project AND v.id=p.value_id "
        " WHERE p.project=fn.project AND p.file_path=fn.file_path AND p.symbol=fn.symbol "
        " AND (v.file_path<>fn.file_path OR v.symbol<>fn.symbol OR v.kind<>'parameter' "
        " OR v.parameter_index<>p.ordinal)) "
        "AND NOT EXISTS(SELECT 1 FROM cbm_flow_bindings WHERE project=?1 AND operation_id=?6) "
        "AND NOT EXISTS(SELECT 1 FROM cbm_flow_package_bindings WHERE project=?1 AND "
        "operation_id=?6)";
    sqlite3_stmt *stmt = flow_binding_statement(db, check, project, b);
    bool ok = stmt && sqlite3_step(stmt) == SQLITE_ROW;
    sqlite3_finalize(stmt);
    const char *mutations[] = {
        "INSERT INTO cbm_flow_bindings VALUES("
        "?1,?6,?2,?4,?3,?5,?8,?9,?10,?11,?12,?13,?14,?15)",
        "DELETE FROM cbm_flow_links WHERE project=?1 AND operation_id=?6 "
        "AND certainty='unknown' AND kind='unknown'",
        "INSERT INTO cbm_flow_links "
        "SELECT ?1,'resolved:'||?6||':arg:'||a.ordinal,?2,a.value_id,p.value_id,?6,"
        "'argument',?11,?6 FROM cbm_flow_actuals a JOIN cbm_flow_formals p "
        "ON p.project=a.project AND p.ordinal=a.ordinal AND p.file_path=?4 AND p.symbol=?7 "
        "WHERE a.project=?1 AND a.operation_id=?6",
        "INSERT INTO cbm_flow_links SELECT ?1,'resolved:'||?6||':return',?2,"
        "f.return_value_id,c.result_value_id,?6,'return',?11,?6 "
        "FROM cbm_flow_functions f JOIN cbm_flow_callsites c ON c.project=f.project "
        "WHERE f.project=?1 AND f.file_path=?4 AND f.symbol=?7 AND c.operation_id=?6",
        "INSERT OR IGNORE INTO cbm_flow_dependencies VALUES(?1,?2,?4)",
        "UPDATE cbm_flow_values SET kind='call_result' WHERE project=?1 AND id="
        "(SELECT result_value_id FROM cbm_flow_callsites WHERE project=?1 AND operation_id=?6)",
        "DELETE FROM cbm_flow_gaps WHERE project=?1 AND file_path=?2 "
        "AND code='unresolved_call' AND start_byte=?14 AND end_byte=?15"};
    for (size_t i = 0; ok && i < sizeof(mutations) / sizeof(mutations[0]); i++) {
        stmt = flow_binding_statement(db, mutations[i], project, b);
        ok = stmt && sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
    }
    if (!ok)
        sqlite3_exec(db, "ROLLBACK TO cbm_flow_bind", NULL, NULL, NULL);
    if (sqlite3_exec(db, "RELEASE cbm_flow_bind", NULL, NULL, NULL) != SQLITE_OK)
        ok = false;
    return ok ? CBM_STORE_OK : CBM_STORE_ERR;
}

int cbm_flow_ir_bind_package_call(cbm_store_t *store, const char *project,
                                  const cbm_flow_package_binding_t *b) {
    if (!store || !flow_string(project, false) || !b || !flow_path(b->caller_file) ||
        !flow_path(b->callee_file) || !flow_path(b->manifest_path) ||
        !flow_string(b->caller_hash, false) || !flow_string(b->callee_hash, false) ||
        !flow_string(b->operation_id, false) || strlen(b->operation_id) > 4000 ||
        !flow_string(b->callee_symbol, false) || !flow_string(b->package_id, false) ||
        !flow_string(b->package_version, false) || !flow_string(b->manifest_hash, false) ||
        !flow_string(b->specifier, false) || !flow_string(b->imported_name, false) ||
        !flow_string(b->local_name, false) || b->import_start < 0 ||
        b->import_end <= b->import_start || b->export_start < 0 || b->export_end <= b->export_start)
        return CBM_STORE_ERR;
    sqlite3 *db = cbm_store_get_db(store);
    if (sqlite3_exec(db, "SAVEPOINT cbm_flow_package_bind", NULL, NULL, NULL) != SQLITE_OK)
        return CBM_STORE_ERR;
    sqlite3_stmt *s = NULL;
    const char *check =
        "SELECT c.symbol,fn.symbol,c.start_byte,c.end_byte "
        "FROM cbm_flow_callsites c JOIN cbm_flow_operations o ON o.project=c.project AND "
        "o.id=c.operation_id "
        "JOIN cbm_flow_values rv ON rv.project=c.project AND rv.id=c.result_value_id "
        "JOIN cbm_flow_files src ON src.project=c.project AND src.file_path=c.file_path "
        "JOIN cbm_flow_functions fn ON fn.project=c.project AND fn.file_path=?4 AND fn.symbol=?6 "
        "JOIN cbm_flow_values ret ON ret.project=fn.project AND ret.id=fn.return_value_id "
        "JOIN cbm_flow_files dst ON dst.project=fn.project AND dst.file_path=fn.file_path "
        "JOIN cbm_flow_packages p ON p.project=fn.project AND p.file_path=fn.file_path "
        "WHERE c.project=?1 AND c.file_path=?2 AND src.source_hash=?3 AND dst.source_hash=?5 "
        "AND c.operation_id=?7 AND o.operator_name=?8 AND fn.name=?9 "
        "AND p.package_id=?10 AND p.package_version=?11 AND p.manifest_hash=?12 "
        "AND fn.start_byte=?13 AND fn.end_byte=?14 "
        "AND src.status='ready' AND dst.status='ready' AND c.positional=1 AND fn.positional=1 "
        "AND fn.method=0 AND fn.lexical_capture=0 AND o.kind='call' AND o.symbol=c.symbol "
        "AND o.file_path=c.file_path AND rv.file_path=c.file_path AND rv.symbol=c.symbol "
        "AND ret.file_path=fn.file_path AND ret.symbol=fn.symbol "
        "AND o.start_byte=c.start_byte AND o.end_byte=c.end_byte "
        "AND EXISTS(SELECT 1 FROM cbm_flow_functions cf WHERE cf.project=c.project "
        "AND cf.file_path=c.file_path AND cf.symbol=c.symbol "
        "AND cf.start_byte<=c.start_byte AND cf.end_byte>=c.end_byte) "
        "AND (SELECT count(*) FROM cbm_flow_actuals a WHERE a.project=c.project AND "
        "a.operation_id=c.operation_id)="
        "(SELECT count(*) FROM cbm_flow_formals f WHERE f.project=fn.project AND "
        "f.file_path=fn.file_path AND f.symbol=fn.symbol) "
        "AND NOT EXISTS(SELECT 1 FROM cbm_flow_actuals a "
        "JOIN cbm_flow_values v ON v.project=a.project AND v.id=a.value_id "
        "WHERE a.project=c.project AND a.operation_id=c.operation_id "
        "AND (v.file_path<>c.file_path OR v.symbol<>c.symbol)) "
        "AND NOT EXISTS(SELECT 1 FROM cbm_flow_formals p "
        "JOIN cbm_flow_values v ON v.project=p.project AND v.id=p.value_id "
        "WHERE p.project=fn.project AND p.file_path=fn.file_path AND p.symbol=fn.symbol "
        "AND (v.file_path<>fn.file_path OR v.symbol<>fn.symbol OR v.kind<>'parameter' "
        "OR v.parameter_index<>p.ordinal)) "
        "AND NOT EXISTS(SELECT 1 FROM cbm_flow_bindings WHERE project=?1 AND operation_id=?7) "
        "AND NOT EXISTS(SELECT 1 FROM cbm_flow_package_bindings WHERE project=?1 AND "
        "operation_id=?7)";
    bool ok = sqlite3_prepare_v2(db, check, -1, &s, NULL) == SQLITE_OK;
    const char *strings[] = {project,         b->caller_file,     b->caller_hash,
                             b->callee_file,  b->callee_hash,     b->callee_symbol,
                             b->operation_id, b->local_name,      b->imported_name,
                             b->package_id,   b->package_version, b->manifest_hash};
    if (ok) {
        for (int i = 0; i < 12; i++)
            flow_bind(s, i + 1, strings[i]);
        sqlite3_bind_int(s, 13, b->export_start);
        sqlite3_bind_int(s, 14, b->export_end);
        ok = sqlite3_step(s) == SQLITE_ROW;
    }
    yyjson_mut_doc *doc = ok ? yyjson_mut_doc_new(NULL) : NULL;
    if (ok && !doc)
        ok = false;
    int call_start = 0, call_end = 0;
    if (ok) {
        yyjson_mut_val *root = yyjson_mut_obj(doc), *package = yyjson_mut_obj(doc),
                       *import = yyjson_mut_obj(doc), *export = yyjson_mut_obj(doc);
        yyjson_mut_doc_set_root(doc, root);
        yyjson_mut_obj_add_str(doc, root, "proof_kind", "package_export");
        yyjson_mut_obj_add_str(doc, root, "strategy", "npm_esm_named_export");
        yyjson_mut_obj_add_str(doc, root, "certainty", "proven");
        const char *keys[] = {"caller_file", "source_hash", "callee_file", "callee_hash"};
        const char *values[] = {b->caller_file, b->caller_hash, b->callee_file, b->callee_hash};
        for (int i = 0; i < 4; i++)
            yyjson_mut_obj_add_strcpy(doc, root, keys[i], values[i]);
        yyjson_mut_obj_add_strcpy(doc, root, "caller_symbol",
                                  (const char *)sqlite3_column_text(s, 0));
        yyjson_mut_obj_add_strcpy(doc, root, "callee_symbol",
                                  (const char *)sqlite3_column_text(s, 1));
        call_start = sqlite3_column_int(s, 2);
        call_end = sqlite3_column_int(s, 3);
        yyjson_mut_obj_add_int(doc, root, "start_byte", call_start);
        yyjson_mut_obj_add_int(doc, root, "end_byte", call_end);
        yyjson_mut_obj_add_strcpy(doc, package, "id", b->package_id);
        yyjson_mut_obj_add_strcpy(doc, package, "version", b->package_version);
        yyjson_mut_obj_add_strcpy(doc, package, "manifest_hash", b->manifest_hash);
        yyjson_mut_obj_add_strcpy(doc, package, "manifest_path", b->manifest_path);
        yyjson_mut_obj_add_val(doc, root, "package", package);
        yyjson_mut_obj_add_strcpy(doc, import, "specifier", b->specifier);
        yyjson_mut_obj_add_strcpy(doc, import, "imported_name", b->imported_name);
        yyjson_mut_obj_add_strcpy(doc, import, "local_name", b->local_name);
        yyjson_mut_obj_add_int(doc, import, "start_byte", b->import_start);
        yyjson_mut_obj_add_int(doc, import, "end_byte", b->import_end);
        yyjson_mut_obj_add_val(doc, root, "import", import);
        yyjson_mut_obj_add_strcpy(doc, export, "name", b->imported_name);
        yyjson_mut_obj_add_int(doc, export, "start_byte", b->export_start);
        yyjson_mut_obj_add_int(doc, export, "end_byte", b->export_end);
        yyjson_mut_obj_add_val(doc, root, "export", export);
        ok = sqlite3_step(s) == SQLITE_DONE;
    }
    sqlite3_finalize(s);
    s = NULL;
    char *proof =
        ok ? yyjson_mut_write_opts(doc, 0, cbm_json_writer_allocator(), NULL, NULL) : NULL;
    yyjson_mut_doc_free(doc);
    if (!proof)
        ok = false;
    const char *mutations[] = {
        "INSERT INTO cbm_flow_package_bindings VALUES(?1,?7,?4,?15)",
        "DELETE FROM cbm_flow_links WHERE project=?1 AND operation_id=?7 AND kind='unknown' AND "
        "certainty='unknown'",
        "INSERT INTO cbm_flow_links SELECT "
        "?1,'package:'||?7||':arg:'||a.ordinal,?2,a.value_id,f.value_id,?7,"
        "'argument','proven',?7 FROM cbm_flow_actuals a JOIN cbm_flow_formals f ON "
        "f.project=a.project "
        "AND f.ordinal=a.ordinal AND f.file_path=?4 AND f.symbol=?6 WHERE a.project=?1 AND "
        "a.operation_id=?7",
        "INSERT INTO cbm_flow_links SELECT "
        "?1,'package:'||?7||':return',?2,f.return_value_id,c.result_value_id,"
        "?7,'return','proven',?7 FROM cbm_flow_functions f JOIN cbm_flow_callsites c ON "
        "c.project=f.project "
        "WHERE f.project=?1 AND f.file_path=?4 AND f.symbol=?6 AND c.operation_id=?7",
        "INSERT OR IGNORE INTO cbm_flow_dependencies VALUES(?1,?2,?4)",
        "UPDATE cbm_flow_values SET kind='call_result' WHERE project=?1 AND id="
        "(SELECT result_value_id FROM cbm_flow_callsites WHERE project=?1 AND operation_id=?7)",
        "DELETE FROM cbm_flow_gaps WHERE project=?1 AND file_path=?2 AND code='unresolved_call' "
        "AND start_byte=?16 AND end_byte=?17"};
    for (size_t n = 0; ok && n < sizeof(mutations) / sizeof(mutations[0]); n++) {
        ok = sqlite3_prepare_v2(db, mutations[n], -1, &s, NULL) == SQLITE_OK;
        if (ok) {
            int count = sqlite3_bind_parameter_count(s);
            for (int i = 0; i < 12 && i < count; i++)
                flow_bind(s, i + 1, strings[i]);
            if (count >= 15)
                flow_bind(s, 15, proof);
            if (count >= 16)
                sqlite3_bind_int(s, 16, call_start);
            if (count >= 17)
                sqlite3_bind_int(s, 17, call_end);
            ok = sqlite3_step(s) == SQLITE_DONE;
        }
        sqlite3_finalize(s);
        s = NULL;
    }
    cbm_free(CBM_MEM_CLASS_OTHER, proof);
    if (!ok)
        sqlite3_exec(db, "ROLLBACK TO cbm_flow_package_bind", NULL, NULL, NULL);
    if (sqlite3_exec(db, "RELEASE cbm_flow_package_bind", NULL, NULL, NULL) != SQLITE_OK)
        ok = false;
    return ok ? CBM_STORE_OK : CBM_STORE_ERR;
}

typedef struct {
    const char *id;
    const char *file;
    yyjson_mut_val *json;
    bool ready;
    bool needs_upgrade;
} flow_trace_value;

typedef struct {
    int value, parent, depth, call_count;
    const char *via;
    const char *calls[8];
} flow_trace_state;

typedef struct {
    cbm_store_t *store;
    sqlite3 *db;
    const char *project;
    char generation[64];
    cbm_flow_trace_options_t options;
    yyjson_mut_doc *doc;
    yyjson_mut_val *values, *links, *operations, *paths, *gaps;
    flow_trace_value *seen;
    flow_trace_state *states;
    int value_count, state_count;
    size_t allocated;
    bool allocation_failed, complete, cancelled, expired, selection_required;
} flow_trace_context;

static void *flow_json_malloc(void *context, size_t bytes) {
    flow_trace_context *c = context;
    if (bytes > 32U * 1024U * 1024U - c->allocated) {
        c->allocation_failed = true;
        return NULL;
    }
    void *ptr = cbm_alloc(CBM_MEM_CLASS_OTHER, bytes);
    if (ptr)
        c->allocated += bytes;
    else
        c->allocation_failed = true;
    return ptr;
}

static void *flow_json_realloc(void *context, void *ptr, size_t old_size, size_t bytes) {
    flow_trace_context *c = context;
    size_t growth = bytes > old_size ? bytes - old_size : 0;
    if (growth > 32U * 1024U * 1024U - c->allocated) {
        c->allocation_failed = true;
        return NULL;
    }
    void *result = cbm_realloc(CBM_MEM_CLASS_OTHER, ptr, bytes);
    if (result)
        c->allocated += growth;
    else
        c->allocation_failed = true;
    return result;
}

static void flow_json_free(void *context, void *ptr) {
    (void)context;
    cbm_free(CBM_MEM_CLASS_OTHER, ptr);
}

static bool flow_trace_cancel(void *context) {
    flow_trace_context *c = context;
    if (c->options.cancel && c->options.cancel(c->options.cancel_context))
        c->cancelled = true;
    if (cbm_now_ms() >= c->options.deadline_ms)
        c->expired = true;
    return c->cancelled || c->expired;
}

static const char *flow_text(sqlite3_stmt *stmt, int column) {
    const unsigned char *text = sqlite3_column_text(stmt, column);
    return text ? (const char *)text : "";
}

static yyjson_mut_val *flow_ref(flow_trace_context *c, const char *key, const char *id) {
    yyjson_mut_val *ref = yyjson_mut_obj(c->doc);
    yyjson_mut_obj_add_str(c->doc, ref, "project", c->project);
    yyjson_mut_obj_add_str(c->doc, ref, "generation", c->generation);
    yyjson_mut_obj_add_strcpy(c->doc, ref, key, id);
    return ref;
}

static void flow_trace_gap(flow_trace_context *c, const char *code, const char *message,
                           const char *file, const char *value) {
    c->complete = false;
    /* One report for each cause/site, even when alternative paths revisit it. */
    size_t i, count;
    yyjson_mut_val *item;
    yyjson_mut_arr_foreach(c->gaps, i, count, item) {
        if (flow_is(yyjson_mut_get_str(yyjson_mut_obj_get(item, "code")), code) &&
            flow_is(yyjson_mut_get_str(yyjson_mut_obj_get(item, "file_path")), file ? file : "") &&
            flow_is(yyjson_mut_get_str(yyjson_mut_obj_get(item, "value_id")), value ? value : ""))
            return;
    }
    yyjson_mut_val *gap = yyjson_mut_obj(c->doc);
    yyjson_mut_obj_add_strcpy(c->doc, gap, "code", code);
    yyjson_mut_obj_add_strcpy(c->doc, gap, "message", message);
    yyjson_mut_obj_add_strcpy(c->doc, gap, "file_path", file ? file : "");
    yyjson_mut_obj_add_strcpy(c->doc, gap, "value_id", value ? value : "");
    yyjson_mut_arr_append(c->gaps, gap);
}

static int flow_file_gaps(flow_trace_context *c, const char *file) {
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(c->db,
                           "SELECT g.code,g.message,g.symbol,g.start_byte,g.end_byte,g.start_line,"
                           "f.source_hash,g.ordinal FROM cbm_flow_gaps g JOIN cbm_flow_files f "
                           "ON f.project=g.project AND f.file_path=g.file_path "
                           "WHERE g.project=?1 AND g.file_path=?2 ORDER BY g.ordinal LIMIT 1001",
                           -1, &stmt, NULL) != SQLITE_OK)
        return CBM_STORE_ERR;
    flow_bind(stmt, 1, c->project);
    flow_bind(stmt, 2, file);
    int step, count = 0;
    while ((step = sqlite3_step(stmt)) == SQLITE_ROW) {
        if (++count > 1000) {
            flow_trace_gap(c, "gap_limit", "Further adapter gaps exceed the response budget.", file,
                           NULL);
            break;
        }
        c->complete = false;
        yyjson_mut_val *gap = yyjson_mut_obj(c->doc), *source = yyjson_mut_obj(c->doc);
        yyjson_mut_obj_add_strcpy(c->doc, gap, "code", flow_text(stmt, 0));
        yyjson_mut_obj_add_strcpy(c->doc, gap, "message", flow_text(stmt, 1));
        yyjson_mut_obj_add_strcpy(c->doc, gap, "symbol", flow_text(stmt, 2));
        yyjson_mut_obj_add_strcpy(c->doc, gap, "file_path", file);
        yyjson_mut_obj_add_strcpy(c->doc, source, "file_path", file);
        yyjson_mut_obj_add_strcpy(c->doc, source, "source_hash", flow_text(stmt, 6));
        yyjson_mut_obj_add_int(c->doc, source, "start_byte", sqlite3_column_int(stmt, 3));
        yyjson_mut_obj_add_int(c->doc, source, "end_byte", sqlite3_column_int(stmt, 4));
        yyjson_mut_obj_add_int(c->doc, source, "start_line", sqlite3_column_int(stmt, 5));
        yyjson_mut_obj_add_val(c->doc, gap, "source", source);
        yyjson_mut_val *ref = yyjson_mut_obj(c->doc);
        yyjson_mut_obj_add_str(c->doc, ref, "project", c->project);
        yyjson_mut_obj_add_str(c->doc, ref, "generation", c->generation);
        yyjson_mut_obj_add_strcpy(c->doc, ref, "file_path", file);
        yyjson_mut_obj_add_int(c->doc, ref, "gap_ordinal", sqlite3_column_int(stmt, 7));
        yyjson_mut_obj_add_val(c->doc, gap, "ref", ref);
        yyjson_mut_arr_append(c->gaps, gap);
    }
    sqlite3_finalize(stmt);
    return step == SQLITE_DONE || count > 1000 ? CBM_STORE_OK : CBM_STORE_ERR;
}

static void flow_value_package(flow_trace_context *c, yyjson_mut_val *value,
                               const char *file_path) {
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(c->db,
                           "SELECT package_id,package_version,manifest_hash "
                           "FROM cbm_flow_packages WHERE project=?1 AND file_path=?2",
                           -1, &stmt, NULL) != SQLITE_OK)
        return; /* Additive table is absent in an older read-only snapshot. */
    flow_bind(stmt, 1, c->project);
    flow_bind(stmt, 2, file_path);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        yyjson_mut_val *package = yyjson_mut_obj(c->doc);
        yyjson_mut_obj_add_strcpy(c->doc, package, "id", flow_text(stmt, 0));
        yyjson_mut_obj_add_strcpy(c->doc, package, "version", flow_text(stmt, 1));
        yyjson_mut_obj_add_strcpy(c->doc, package, "manifest_hash", flow_text(stmt, 2));
        yyjson_mut_obj_add_val(c->doc, value, "package", package);
    }
    sqlite3_finalize(stmt);
}

static int flow_load_value(flow_trace_context *c, const char *id, int *out_index) {
    for (int i = 0; i < c->value_count; i++) {
        if (flow_is(c->seen[i].id, id)) {
            *out_index = i;
            return CBM_STORE_OK;
        }
    }
    if (c->value_count >= c->options.max_states)
        return CBM_STORE_SCAN_LIMIT;
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT v.id,v.file_path,v.symbol,v.binding,v.access_path,v.kind,"
        "v.symbol_node_id,v.version,v.start_byte,v.end_byte,v.start_line,"
        "v.end_line,v.parameter_index,f.source_hash,f.status,f.adapter,f.adapter_version "
        "FROM cbm_flow_values v JOIN cbm_flow_files f "
        "ON f.project=v.project AND f.file_path=v.file_path "
        "WHERE v.project=?1 AND v.id=?2";
    if (sqlite3_prepare_v2(c->db, sql, -1, &stmt, NULL) != SQLITE_OK)
        return CBM_STORE_ERR;
    flow_bind(stmt, 1, c->project);
    flow_bind(stmt, 2, id);
    int step = sqlite3_step(stmt), rc = CBM_STORE_NOT_FOUND;
    if (step == SQLITE_ROW) {
        yyjson_mut_val *value = yyjson_mut_obj(c->doc);
        yyjson_mut_val *source = yyjson_mut_obj(c->doc);
        const char *fields[] = {"id", "file_path", "symbol", "binding", NULL, "kind"};
        for (int i = 0; i < 6; i++)
            if (fields[i])
                yyjson_mut_obj_add_strcpy(c->doc, value, fields[i], flow_text(stmt, i));
        const char *path = flow_text(stmt, 4);
        yyjson_doc *access = yyjson_read(path, strlen(path), 0);
        if (!access || !yyjson_is_arr(yyjson_doc_get_root(access))) {
            yyjson_doc_free(access);
            sqlite3_finalize(stmt);
            return CBM_STORE_ERR;
        }
        yyjson_mut_obj_add_val(c->doc, value, "access_path",
                               yyjson_val_mut_copy(c->doc, yyjson_doc_get_root(access)));
        yyjson_doc_free(access);
        yyjson_mut_obj_add_int(c->doc, value, "version", sqlite3_column_int(stmt, 7));
        yyjson_mut_obj_add_int(c->doc, value, "parameter_index", sqlite3_column_int(stmt, 12));
        yyjson_mut_obj_add_strcpy(c->doc, source, "file_path", flow_text(stmt, 1));
        yyjson_mut_obj_add_strcpy(c->doc, source, "source_hash", flow_text(stmt, 13));
        const char *span[] = {"start_byte", "end_byte", "start_line", "end_line"};
        for (int i = 0; i < 4; i++)
            yyjson_mut_obj_add_int(c->doc, source, span[i], sqlite3_column_int(stmt, 8 + i));
        yyjson_mut_obj_add_val(c->doc, value, "source", source);
        yyjson_mut_obj_add_val(c->doc, value, "ref", flow_ref(c, "value_id", flow_text(stmt, 0)));
        flow_value_package(c, value, flow_text(stmt, 1));
        if (sqlite3_column_int64(stmt, 6) > 0) {
            yyjson_mut_val *symbol_ref = yyjson_mut_obj(c->doc);
            yyjson_mut_obj_add_str(c->doc, symbol_ref, "project", c->project);
            yyjson_mut_obj_add_str(c->doc, symbol_ref, "generation", c->generation);
            yyjson_mut_obj_add_sint(c->doc, symbol_ref, "node_id", sqlite3_column_int64(stmt, 6));
            yyjson_mut_obj_add_val(c->doc, value, "symbol_ref", symbol_ref);
        }
        flow_trace_value *seen = &c->seen[c->value_count];
        seen->id = yyjson_mut_get_str(yyjson_mut_obj_get(value, "id"));
        seen->file = yyjson_mut_get_str(yyjson_mut_obj_get(value, "file_path"));
        seen->json = value;
        seen->needs_upgrade = flow_is(flow_text(stmt, 15), "tree-sitter-lexical-flow") &&
                              sqlite3_column_int(stmt, 16) < 4;
        seen->ready = flow_is(flow_text(stmt, 14), "ready") && !seen->needs_upgrade;
        yyjson_mut_obj_add_str(c->doc, value, "analysis_status", seen->ready ? "ready" : "stale");
        yyjson_mut_arr_append(c->values, value);
        *out_index = c->value_count++;
        rc = c->allocation_failed ? CBM_STORE_ERR : CBM_STORE_OK;
    } else if (step != SQLITE_DONE) {
        rc = CBM_STORE_ERR;
    }
    sqlite3_finalize(stmt);
    if (rc == CBM_STORE_OK) {
        flow_trace_value *value = &c->seen[*out_index];
        bool file_seen = false;
        for (int i = 0; i < *out_index; i++)
            if (flow_is(c->seen[i].file, value->file))
                file_seen = true;
        if (!file_seen)
            rc = flow_file_gaps(c, value->file);
        if (value->needs_upgrade)
            flow_trace_gap(c, "adapter_upgrade_required",
                           "Reindex this partition before using its obsolete field-flow semantics.",
                           value->file, value->id);
        else if (!value->ready)
            flow_trace_gap(c, "stale_dependency",
                           "A changed body dependency invalidated this analysis partition.",
                           value->file, value->id);
    }
    return rc;
}

static bool flow_array_has(yyjson_mut_val *array, const char *id) {
    size_t i, count;
    yyjson_mut_val *value;
    yyjson_mut_arr_foreach(
        array, i, count,
        value) if (flow_is(yyjson_mut_get_str(yyjson_mut_obj_get(value, "id")), id)) return true;
    return false;
}

static int flow_load_operation(flow_trace_context *c, const char *id) {
    if (flow_array_has(c->operations, id))
        return CBM_STORE_OK;
    sqlite3_stmt *stmt = NULL;
    const char *sql = "SELECT o.id,o.file_path,o.symbol,o.kind,o.operator_name,o.start_byte,"
                      "o.end_byte,o.start_line,o.end_line,f.source_hash FROM cbm_flow_operations o "
                      "JOIN cbm_flow_files f ON f.project=o.project AND f.file_path=o.file_path "
                      "WHERE o.project=?1 AND o.id=?2";
    if (sqlite3_prepare_v2(c->db, sql, -1, &stmt, NULL) != SQLITE_OK)
        return CBM_STORE_ERR;
    flow_bind(stmt, 1, c->project);
    flow_bind(stmt, 2, id);
    int rc = CBM_STORE_ERR;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        yyjson_mut_val *op = yyjson_mut_obj(c->doc), *source = yyjson_mut_obj(c->doc);
        const char *fields[] = {"id", "file_path", "symbol", "kind", "operator_name"};
        for (int i = 0; i < 5; i++)
            yyjson_mut_obj_add_strcpy(c->doc, op, fields[i], flow_text(stmt, i));
        yyjson_mut_obj_add_strcpy(c->doc, source, "file_path", flow_text(stmt, 1));
        yyjson_mut_obj_add_strcpy(c->doc, source, "source_hash", flow_text(stmt, 9));
        const char *span[] = {"start_byte", "end_byte", "start_line", "end_line"};
        for (int i = 0; i < 4; i++)
            yyjson_mut_obj_add_int(c->doc, source, span[i], sqlite3_column_int(stmt, 5 + i));
        yyjson_mut_obj_add_val(c->doc, op, "source", source);
        yyjson_mut_obj_add_val(c->doc, op, "ref", flow_ref(c, "operation_id", flow_text(stmt, 0)));
        yyjson_mut_arr_append(c->operations, op);
        rc = c->allocation_failed ? CBM_STORE_ERR : CBM_STORE_OK;
    }
    sqlite3_finalize(stmt);
    return rc;
}

static bool flow_same_context(const flow_trace_state *a, const flow_trace_state *b) {
    if (a->value != b->value || a->call_count != b->call_count)
        return false;
    for (int i = 0; i < a->call_count; i++)
        if (!flow_is(a->calls[i], b->calls[i]))
            return false;
    return true;
}

static void flow_add_path(flow_trace_context *c, int index) {
    if (yyjson_mut_arr_size(c->paths) >= (size_t)c->options.max_paths) {
        flow_trace_gap(c, "path_limit", "Further paths exceed the configured path budget.", NULL,
                       NULL);
        return;
    }
    int reverse[129], count = 0;
    for (int at = index; at >= 0 && count < 129; at = c->states[at].parent)
        reverse[count++] = at;
    yyjson_mut_val *path = yyjson_mut_obj(c->doc);
    yyjson_mut_val *values = yyjson_mut_arr(c->doc), *links = yyjson_mut_arr(c->doc);
    for (int i = count - 1; i >= 0; i--) {
        flow_trace_state *state = &c->states[reverse[i]];
        yyjson_mut_arr_add_str(c->doc, values, c->seen[state->value].id);
        if (state->via)
            yyjson_mut_arr_add_str(c->doc, links, state->via);
    }
    yyjson_mut_obj_add_val(c->doc, path, "values", values);
    yyjson_mut_obj_add_val(c->doc, path, "links", links);
    yyjson_mut_obj_add_str(c->doc, path, "direction", c->options.backward ? "backward" : "forward");
    yyjson_mut_obj_add_str(c->doc, path, "semantics", "context_matched_static_value_dependence");
    yyjson_mut_arr_append(c->paths, path);
}

static void flow_link_resolution(flow_trace_context *c, yyjson_mut_val *link,
                                 const char *operation) {
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(c->db,
                           "SELECT proof FROM cbm_flow_package_bindings "
                           "WHERE project=?1 AND operation_id=?2",
                           -1, &stmt, NULL) == SQLITE_OK) {
        flow_bind(stmt, 1, c->project);
        flow_bind(stmt, 2, operation);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            const char *text = flow_text(stmt, 0);
            yyjson_doc *parsed = yyjson_read(text, strlen(text), 0);
            if (parsed && yyjson_is_obj(yyjson_doc_get_root(parsed))) {
                yyjson_mut_val *proof = yyjson_val_mut_copy(c->doc, yyjson_doc_get_root(parsed));
                yyjson_mut_obj_add_strcpy(c->doc, proof, "project", c->project);
                yyjson_mut_obj_add_strcpy(c->doc, proof, "generation", c->generation);
                yyjson_mut_obj_add_val(c->doc, link, "resolution", proof);
            }
            yyjson_doc_free(parsed);
            sqlite3_finalize(stmt);
            return;
        }
    }
    sqlite3_finalize(stmt);
    stmt = NULL;
    /* Optional additive table: older read-only IR snapshots remain readable. */
    if (sqlite3_prepare_v2(c->db,
                           "SELECT caller_file,callee_file,source_hash,callee_hash,"
                           "caller_qn,callee_qn,strategy,certainty,caller_node_id,callee_node_id,"
                           "site_start_byte,site_end_byte FROM cbm_flow_bindings WHERE project=?1 "
                           "AND operation_id=?2",
                           -1, &stmt, NULL) != SQLITE_OK)
        return;
    flow_bind(stmt, 1, c->project);
    flow_bind(stmt, 2, operation);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        yyjson_mut_val *proof = yyjson_mut_obj(c->doc);
        const char *fields[] = {"caller_file", "callee_file", "source_hash", "callee_hash",
                                "caller_qn",   "callee_qn",   "strategy",    "certainty"};
        for (int i = 0; i < 8; i++)
            yyjson_mut_obj_add_strcpy(c->doc, proof, fields[i], flow_text(stmt, i));
        yyjson_mut_obj_add_int(c->doc, proof, "caller_node_id", sqlite3_column_int64(stmt, 8));
        yyjson_mut_obj_add_int(c->doc, proof, "callee_node_id", sqlite3_column_int64(stmt, 9));
        yyjson_mut_obj_add_int(c->doc, proof, "start_byte", sqlite3_column_int(stmt, 10));
        yyjson_mut_obj_add_int(c->doc, proof, "end_byte", sqlite3_column_int(stmt, 11));
        yyjson_mut_obj_add_strcpy(c->doc, proof, "project", c->project);
        yyjson_mut_obj_add_strcpy(c->doc, proof, "generation", c->generation);
        yyjson_mut_obj_add_val(c->doc, link, "resolution", proof);
    }
    sqlite3_finalize(stmt);
}

static int flow_walk(flow_trace_context *c) {
    const char *forward = "SELECT "
                          "l.id,l.source,l.target,l.operation_id,l.kind,l.certainty,l.callsite_id,"
                          "f.status,f.adapter,f.adapter_version "
                          "FROM cbm_flow_links l JOIN cbm_flow_files f "
                          "ON f.project=l.project AND f.file_path=l.file_path "
                          "WHERE l.project=?1 AND l.source=?2 ORDER BY l.id LIMIT ?3";
    const char *backward = "SELECT "
                           "l.id,l.source,l.target,l.operation_id,l.kind,l.certainty,l.callsite_id,"
                           "f.status,f.adapter,f.adapter_version "
                           "FROM cbm_flow_links l JOIN cbm_flow_files f "
                           "ON f.project=l.project AND f.file_path=l.file_path "
                           "WHERE l.project=?1 AND l.target=?2 ORDER BY l.id LIMIT ?3";
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(c->db, c->options.backward ? backward : forward, -1, &stmt, NULL) !=
        SQLITE_OK)
        return CBM_STORE_ERR;
    int rc = CBM_STORE_OK;
    for (int current = 0; rc == CBM_STORE_OK && current < c->state_count; current++) {
        if (flow_trace_cancel(c)) {
            rc = CBM_STORE_CANCELLED;
            break;
        }
        flow_trace_state *state = &c->states[current];
        flow_trace_value *value = &c->seen[state->value];
        if (!value->ready || state->depth >= c->options.max_depth) {
            if (value->ready)
                flow_trace_gap(c, "depth_limit", "The slice reached its configured depth bound.",
                               value->file, value->id);
            flow_add_path(c, current);
            continue;
        }
        flow_bind(stmt, 1, c->project);
        flow_bind(stmt, 2, value->id);
        sqlite3_bind_int(stmt, 3, c->options.max_states + 1);
        int step, neighbors = 0, children = 0;
        while ((step = sqlite3_step(stmt)) == SQLITE_ROW) {
            if (++neighbors > c->options.max_states) {
                flow_trace_gap(c, "neighbor_limit",
                               "Further relationships exceed the state budget.", value->file,
                               value->id);
                break;
            }
            if (flow_is(flow_text(stmt, 8), "tree-sitter-lexical-flow") &&
                sqlite3_column_int(stmt, 9) < 4) {
                flow_trace_gap(c, "adapter_upgrade_required",
                               "Reindex this relationship's obsolete field-flow partition.",
                               value->file, value->id);
                continue;
            }
            if (!flow_is(flow_text(stmt, 7), "ready")) {
                flow_trace_gap(c, "stale_dependency", "A relationship's body analysis is stale.",
                               value->file, value->id);
                continue;
            }
            const char *kind = flow_text(stmt, 4), *certainty = flow_text(stmt, 5);
            if (flow_is(kind, "unknown") || flow_is(certainty, "unknown") ||
                flow_is(kind, "control") || flow_is(certainty, "control")) {
                flow_trace_gap(c,
                               flow_is(certainty, "control") ? "control_boundary" : "unknown_flow",
                               "This relationship does not prove transport of a field value.",
                               value->file, value->id);
                continue;
            }
            flow_trace_state next = *state;
            next.parent = current;
            next.depth++;
            const char *callsite = flow_text(stmt, 6);
            bool push = flow_is(kind, c->options.backward ? "return" : "argument");
            bool pop = flow_is(kind, c->options.backward ? "argument" : "return");
            if (push) {
                if (next.call_count >= c->options.max_call_depth) {
                    flow_trace_gap(c, "call_context_limit",
                                   "The slice reached its call-context bound.", value->file,
                                   value->id);
                    continue;
                }
                yyjson_mut_val *copy = yyjson_mut_strcpy(c->doc, callsite);
                next.calls[next.call_count++] = yyjson_mut_get_str(copy);
            } else if (pop) {
                if (!next.call_count) {
                    flow_trace_gap(c, "call_context_boundary",
                                   "A caller context is required to cross this function boundary.",
                                   value->file, value->id);
                    continue;
                }
                if (!flow_is(next.calls[next.call_count - 1], callsite))
                    continue;
                next.call_count--;
            }
            if (c->state_count >= c->options.max_states) {
                flow_trace_gap(c, "state_limit",
                               "Further paths exceed the configured state budget.", value->file,
                               value->id);
                break;
            }
            rc = flow_load_value(c, flow_text(stmt, c->options.backward ? 1 : 2), &next.value);
            if (rc != CBM_STORE_OK)
                break;
            if (!c->seen[next.value].ready) {
                flow_trace_gap(c, "stale_dependency",
                               "A target value belongs to a stale body analysis.",
                               c->seen[next.value].file, c->seen[next.value].id);
                continue;
            }
            bool cycle = false;
            for (int ancestor = current; ancestor >= 0; ancestor = c->states[ancestor].parent)
                if (flow_same_context(&next, &c->states[ancestor]))
                    cycle = true;
            if (cycle) {
                flow_trace_gap(c, "cycle_boundary",
                               "A repeated value/context is not expanded into an infinite path.",
                               value->file, value->id);
                continue;
            }
            rc = flow_load_operation(c, flow_text(stmt, 3));
            if (rc != CBM_STORE_OK)
                break;
            yyjson_mut_val *id = yyjson_mut_strcpy(c->doc, flow_text(stmt, 0));
            next.via = yyjson_mut_get_str(id);
            if (!flow_array_has(c->links, next.via)) {
                yyjson_mut_val *link = yyjson_mut_obj(c->doc);
                const char *fields[] = {"id",   "source",    "target",     "operation_id",
                                        "kind", "certainty", "callsite_id"};
                for (int i = 0; i < 7; i++)
                    yyjson_mut_obj_add_strcpy(c->doc, link, fields[i], flow_text(stmt, i));
                yyjson_mut_obj_add_val(c->doc, link, "ref",
                                       flow_ref(c, "link_id", flow_text(stmt, 0)));
                if (flow_is(kind, "argument") || flow_is(kind, "return"))
                    flow_link_resolution(c, link, flow_text(stmt, 3));
                yyjson_mut_arr_append(c->links, link);
            }
            if (c->allocation_failed) {
                rc = CBM_STORE_ERR;
                break;
            }
            c->states[c->state_count++] = next;
            children++;
        }
        if (rc == CBM_STORE_OK && step != SQLITE_DONE && step != SQLITE_ROW)
            rc = CBM_STORE_ERR;
        sqlite3_reset(stmt);
        if (!children)
            flow_add_path(c, current);
    }
    sqlite3_finalize(stmt);
    return rc;
}

static int flow_bound(int value, int fallback, int ceiling) {
    return value <= 0 ? fallback : value > ceiling ? ceiling : value;
}

static int flow_select_source(flow_trace_context *c) {
    if (c->options.value_id)
        return flow_load_value(c, c->options.value_id, &c->states[0].value);
    /* Compare decoded path segments, so JSON whitespace/escaping never
     * changes lexical field identity. Every selector remains project-scoped. */
    const char *sql =
        "SELECT id FROM cbm_flow_values v WHERE project=?1 AND file_path=?2 "
        "AND (?3 IS NULL OR symbol=?3) AND (?4 IS NULL OR "
        "(json_array_length(access_path)=json_array_length(?4) AND NOT EXISTS("
        "SELECT 1 FROM json_each(v.access_path) a LEFT JOIN json_each(?4) b ON a.key=b.key "
        "WHERE a.value IS NOT b.value))) AND (?5 IS NULL OR start_byte=?5) "
        "ORDER BY start_byte,end_byte,id LIMIT ?6";
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(c->db, sql, -1, &stmt, NULL) != SQLITE_OK)
        return CBM_STORE_ERR;
    flow_bind(stmt, 1, c->project);
    flow_bind(stmt, 2, c->options.file_path);
    if (c->options.symbol)
        flow_bind(stmt, 3, c->options.symbol);
    if (c->options.access_path)
        flow_bind(stmt, 4, c->options.access_path);
    if (c->options.has_start_byte)
        sqlite3_bind_int(stmt, 5, c->options.start_byte);
    int limit = c->options.max_states < 200 ? c->options.max_states : 200;
    sqlite3_bind_int(stmt, 6, limit + 1);
    int step, count = 0, rc = CBM_STORE_OK;
    while ((step = sqlite3_step(stmt)) == SQLITE_ROW) {
        if (++count > limit) {
            flow_trace_gap(c, "candidate_limit",
                           "Further source occurrences exceed the display bound.",
                           c->options.file_path, NULL);
            break;
        }
        int index = -1;
        rc = flow_load_value(c, flow_text(stmt, 0), &index);
        if (rc != CBM_STORE_OK)
            break;
        if (count == 1)
            c->states[0].value = index;
    }
    if (rc == CBM_STORE_OK && step != SQLITE_DONE && step != SQLITE_ROW)
        rc = CBM_STORE_ERR;
    sqlite3_finalize(stmt);
    if (rc != CBM_STORE_OK)
        return rc;
    if (!count) {
        /* A parsed/gapped partition is different from an unindexed file.
         * Preserve its diagnostics even if no value occurrence is supported. */
        if (sqlite3_prepare_v2(c->db,
                               "SELECT 1 FROM cbm_flow_files "
                               "WHERE project=?1 AND file_path=?2",
                               -1, &stmt, NULL) != SQLITE_OK)
            return CBM_STORE_ERR;
        flow_bind(stmt, 1, c->project);
        flow_bind(stmt, 2, c->options.file_path);
        step = sqlite3_step(stmt);
        sqlite3_finalize(stmt);
        if (step != SQLITE_ROW)
            return step == SQLITE_DONE ? CBM_STORE_NOT_FOUND : CBM_STORE_ERR;
        rc = flow_file_gaps(c, c->options.file_path);
        if (rc == CBM_STORE_OK && yyjson_mut_arr_size(c->gaps) == 0)
            flow_trace_gap(c, "source_occurrence_unavailable",
                           "No supported value occurrence matches this file selector.",
                           c->options.file_path, NULL);
        return rc;
    }
    if (count > 1) {
        c->selection_required = true;
        flow_trace_gap(c, "ambiguous_source",
                       "Select one returned value_id; multiple occurrences match this source.",
                       c->options.file_path, NULL);
    }
    return CBM_STORE_OK;
}

int cbm_flow_ir_trace(cbm_store_t *store, const char *project,
                      const cbm_flow_trace_options_t *options, char **out_json) {
    if (!store || !flow_string(project, false) || !options || !out_json ||
        (options->value_id ? !flow_string(options->value_id, false) || options->file_path
                           : !flow_path(options->file_path)) ||
        (options->symbol && !flow_string(options->symbol, false)) ||
        (options->access_path && !flow_access_path(options->access_path)) ||
        (options->has_start_byte && options->start_byte < 0))
        return CBM_STORE_ERR;
    *out_json = NULL;
    flow_trace_context c = {.store = store,
                            .db = cbm_store_get_db(store),
                            .project = project,
                            .options = *options,
                            .complete = true};
    c.options.max_depth = flow_bound(c.options.max_depth, 32, 128);
    c.options.max_paths = flow_bound(c.options.max_paths, 32, 128);
    c.options.max_states = flow_bound(c.options.max_states, 4096, 16384);
    c.options.max_call_depth = flow_bound(c.options.max_call_depth, 4, 8);
    if (!c.options.deadline_ms)
        c.options.deadline_ms = cbm_now_ms() + 5000;
    if (flow_trace_cancel(&c))
        return c.cancelled ? CBM_STORE_CANCELLED : CBM_STORE_SCAN_LIMIT;
    cbm_store_read_scope_t *scope = NULL;
    int rc = cbm_store_read_scope_open(store, flow_trace_cancel, &c, &scope);
    if (rc == CBM_STORE_OK)
        rc = flow_schema(c.db);
    if (rc == CBM_STORE_OK)
        rc = cbm_store_generation(store, c.generation, sizeof(c.generation));
    if (rc == CBM_STORE_OK && options->expected_generation &&
        !flow_is(c.generation, options->expected_generation))
        rc = CBM_STORE_ERR;
    yyjson_alc allocator = {.malloc = flow_json_malloc,
                            .realloc = flow_json_realloc,
                            .free = flow_json_free,
                            .ctx = &c};
    if (rc == CBM_STORE_OK) {
        c.doc = yyjson_mut_doc_new(&allocator);
        c.seen = cbm_calloc(CBM_MEM_CLASS_OTHER, sizeof(*c.seen) * (size_t)c.options.max_states);
        c.states =
            cbm_calloc(CBM_MEM_CLASS_OTHER, sizeof(*c.states) * (size_t)c.options.max_states);
        if (!c.doc || !c.seen || !c.states)
            rc = CBM_STORE_ERR;
    }
    if (rc == CBM_STORE_OK) {
        c.values = yyjson_mut_arr(c.doc);
        c.operations = yyjson_mut_arr(c.doc);
        c.links = yyjson_mut_arr(c.doc);
        c.paths = yyjson_mut_arr(c.doc);
        c.gaps = yyjson_mut_arr(c.doc);
        rc = flow_select_source(&c);
    }
    if (rc == CBM_STORE_OK && !c.selection_required && c.value_count > 0) {
        c.states[0].parent = -1;
        c.state_count = 1;
        rc = flow_walk(&c);
    }
    if (rc == CBM_STORE_OK && !c.allocation_failed) {
        yyjson_mut_val *root = yyjson_mut_obj(c.doc), *limits = yyjson_mut_obj(c.doc);
        yyjson_mut_doc_set_root(c.doc, root);
        yyjson_mut_obj_add_int(c.doc, root, "schema_version", CBM_FLOW_IR_SCHEMA_VERSION);
        yyjson_mut_obj_add_str(c.doc, root, "analysis_kind", "static_field_flow");
        yyjson_mut_obj_add_str(c.doc, root, "project", project);
        yyjson_mut_obj_add_str(c.doc, root, "generation", c.generation);
        yyjson_mut_obj_add_str(c.doc, root, "status",
                               c.selection_required ? "selection_required"
                               : c.complete         ? "ready"
                                                    : "limited");
        yyjson_mut_obj_add_bool(c.doc, root, "complete", c.complete);
        yyjson_mut_obj_add_str(c.doc, root, "completeness_scope", "indexed_flow_ir_slice");
        yyjson_mut_obj_add_val(c.doc, root, "values", c.values);
        yyjson_mut_obj_add_val(c.doc, root, "links", c.links);
        yyjson_mut_obj_add_val(c.doc, root, "operations", c.operations);
        yyjson_mut_obj_add_val(c.doc, root, "paths", c.paths);
        yyjson_mut_obj_add_val(c.doc, root, "gaps", c.gaps);
        yyjson_mut_obj_add_int(c.doc, limits, "max_depth", c.options.max_depth);
        yyjson_mut_obj_add_int(c.doc, limits, "max_paths", c.options.max_paths);
        yyjson_mut_obj_add_int(c.doc, limits, "max_states", c.options.max_states);
        yyjson_mut_obj_add_int(c.doc, limits, "max_call_depth", c.options.max_call_depth);
        yyjson_mut_obj_add_int(c.doc, limits, "visited_states", c.state_count);
        yyjson_mut_obj_add_val(c.doc, root, "limits", limits);
        size_t bytes = 0;
        if (!c.allocation_failed)
            *out_json = yyjson_mut_write_opts(c.doc, 0, cbm_json_writer_allocator(), &bytes, NULL);
        if (!*out_json)
            rc = CBM_STORE_ERR;
        else if (bytes > 8U * 1024U * 1024U)
            rc = CBM_STORE_SCAN_LIMIT;
    } else if (c.allocation_failed) {
        rc = CBM_STORE_SCAN_LIMIT;
    }
    int scope_rc = cbm_store_read_scope_close(scope);
    if (scope_rc != CBM_STORE_OK)
        rc = scope_rc;
    if (rc != CBM_STORE_SCOPE_DISCARD) {
        if (c.cancelled)
            rc = CBM_STORE_CANCELLED;
        else if (c.expired)
            rc = CBM_STORE_SCAN_LIMIT;
    }
    yyjson_mut_doc_free(c.doc);
    cbm_free(CBM_MEM_CLASS_OTHER, c.seen);
    cbm_free(CBM_MEM_CLASS_OTHER, c.states);
    if (rc != CBM_STORE_OK) {
        cbm_free(CBM_MEM_CLASS_OTHER, *out_json);
        *out_json = NULL;
    }
    return rc;
}
