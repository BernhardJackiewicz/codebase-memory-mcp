#include "store/system_graph.h"
#include "foundation/json_writer.h"
#include "foundation/mem_core.h"
#include "foundation/platform.h"
#include <sqlite3.h>
#include <yyjson/yyjson.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
    SG_JSON_BYTES = 32 * 1024 * 1024,
    SG_OUTPUT_BYTES = 8 * 1024 * 1024,
    SG_PROPERTY_BYTES = 1024 * 1024,
    SG_IDENTITY_BYTES = 2 * 1024 * 1024,
    SG_PROPERTY_ROW_BYTES = 16384,
    SG_IDENTITY_FIELD_BYTES = 4096,
};

typedef struct {
    size_t allocated;
    bool failed;
} sg_budget;

typedef struct {
    int64_t id;
    const char *kind;
    yyjson_mut_val *entity;
    int page;
    bool pdf;
} sg_node;

typedef struct {
    sqlite3 *db;
    const char *project;
    char generation[64];
    cbm_system_graph_options_t options;
    sg_budget budget;
    yyjson_mut_doc *doc;
    yyjson_mut_val *entities, *relations;
    sg_node *nodes;
    int count;
    int64_t total_nodes, total_edges;
    int unavailable;
    size_t property_bytes, identity_bytes;
    bool cancelled, expired;
} sg_context;

static void *sg_malloc(void *context, size_t size) {
    sg_budget *budget = context;
    if (size > SG_JSON_BYTES - budget->allocated) {
        budget->failed = true;
        return NULL;
    }
    void *ptr = cbm_alloc(CBM_MEM_CLASS_OTHER, size);
    if (ptr)
        budget->allocated += size;
    else
        budget->failed = true;
    return ptr;
}

static void *sg_realloc(void *context, void *ptr, size_t old_size, size_t size) {
    sg_budget *budget = context;
    size_t growth = size > old_size ? size - old_size : 0;
    if (growth > SG_JSON_BYTES - budget->allocated) {
        budget->failed = true;
        return NULL;
    }
    void *next = cbm_realloc(CBM_MEM_CLASS_OTHER, ptr, size);
    if (next)
        budget->allocated += growth;
    else
        budget->failed = true;
    return next;
}

static void sg_free(void *context, void *ptr) {
    (void)context;
    cbm_free(CBM_MEM_CLASS_OTHER, ptr);
}

static bool sg_stopped(sg_context *c) {
    if (c->options.cancel && c->options.cancel(c->options.cancel_context))
        c->cancelled = true;
    if (cbm_now_ms() >= c->options.deadline_ms)
        c->expired = true;
    return c->cancelled || c->expired;
}

static int sg_progress(void *context) {
    return sg_stopped(context) ? 1 : 0;
}

static bool sg_is(const char *value, const char *expected) {
    return value && strcmp(value, expected) == 0;
}

/* Indexed PDF extra properties use strings. Do not coerce whitespace, signs,
 * leading zeroes, fractions, embedded NULs or numbers outside the UI range. */
static int sg_page(yyjson_mut_val *value) {
    if (yyjson_mut_is_uint(value)) {
        uint64_t page = yyjson_mut_get_uint(value);
        return page > 0 && page <= INT32_MAX ? (int)page : 0;
    }
    if (yyjson_mut_is_sint(value)) {
        int64_t page = yyjson_mut_get_sint(value);
        return page > 0 && page <= INT32_MAX ? (int)page : 0;
    }
    const char *text = yyjson_mut_get_str(value);
    size_t length = yyjson_mut_get_len(value);
    if (!text || !length || length > 10 || text[0] < '1' || text[0] > '9')
        return 0;
    int page = 0;
    for (size_t i = 0; i < length; i++) {
        if (text[i] < '0' || text[i] > '9')
            return 0;
        int digit = text[i] - '0';
        if (page > (INT32_MAX - digit) / 10)
            return 0;
        page = page * 10 + digit;
    }
    return page;
}

static bool sg_extension(const char *file, const char *extension) {
    const char *dot = file ? strrchr(file, '.') : NULL;
    return sg_is(dot, extension);
}

static bool sg_doc_file(const char *file) {
    return sg_extension(file, ".md") || sg_extension(file, ".mdx") || sg_extension(file, ".rst") ||
           sg_extension(file, ".adoc") || sg_extension(file, ".asciidoc") ||
           sg_extension(file, ".pdf");
}

/* Classify only explicit indexed labels/properties. In particular, a name
 * containing "users" or "database" never manufactures a data-store binding. */
static const char *sg_kind(const char *label, const char *file, yyjson_mut_val *properties) {
    if (sg_is(label, "Resource")) {
        const char *kind = yyjson_mut_get_str(yyjson_mut_obj_get(properties, "kind"));
        if (sg_is(kind, "Service"))
            return "service";
        if (sg_is(kind, "ConfigMap") || sg_is(kind, "Secret"))
            return "configuration";
        return "deployment";
    }
    if (sg_is(label, "Service"))
        return "service";
    if (sg_is(label, "Database"))
        return "database";
    if (sg_is(label, "Table") || sg_is(label, "View") || sg_is(label, "Collection") ||
        sg_is(label, "Schema") || sg_is(label, "Model") || sg_is(label, "Column"))
        return "data_structure";
    if (sg_is(label, "Image") || sg_is(label, "Container"))
        return "container";
    if (sg_is(label, "Chart") || sg_is(label, "Process") || sg_is(label, "Deployment"))
        return "deployment";
    if (sg_is(label, "EnvVar") || sg_is(label, "Config"))
        return "configuration";
    if (sg_is(label, "Diagram") || sg_is(label, "DiagramElement") || sg_extension(file, ".drawio"))
        return "diagram";
    if (sg_is(label, "Section") || sg_is(label, "ADR") || sg_is(label, "Document") ||
        (sg_is(label, "File") && sg_doc_file(file)))
        return "document";
    if (sg_is(label, "Package"))
        return "dependency";
    if (sg_is(label, "Route") || sg_is(label, "Endpoint"))
        return "api";
    if (sg_is(label, "Channel") || sg_is(label, "Queue"))
        return "queue";
    if (sg_is(label, "File") || sg_is(label, "Module") || sg_is(label, "Folder") ||
        sg_is(label, "Project") || sg_is(label, "Branch"))
        return "structural";
    if (sg_is(label, "Function") || sg_is(label, "Method") || sg_is(label, "Class") ||
        sg_is(label, "Interface") || sg_is(label, "Variable") || sg_is(label, "Field") ||
        sg_is(label, "Type") || sg_is(label, "Enum") || sg_is(label, "Macro") ||
        sg_is(label, "Decorator") || sg_is(label, "Struct") || sg_is(label, "Trait"))
        return "code";
    return "other";
}

static const char *sg_layer(const char *type, const sg_node *source, const sg_node *target) {
    if (sg_is(type, "DEPLOYS") || sg_is(type, "SPAWNS") || sg_is(type, "INFRA_MAPS") ||
        sg_is(type, "OVERRIDES") || sg_is(type, "CONNECTS_TO"))
        return "deployment";
    if (sg_is(type, "CONFIGURES"))
        return "configuration";
    if (sg_is(type, "MENTIONS") || sg_is(type, "SUPERSEDES") || sg_is(type, "REFERENCES_FILE") ||
        sg_is(type, "DIAGRAM_ARROW"))
        return "documentation";
    if (sg_is(type, "DEPENDS_ON") || sg_is(type, "IMPORTS"))
        return "dependency";
    if (sg_is(type, "DATA_FLOWS") || sg_is(source->kind, "database") ||
        sg_is(target->kind, "database") || sg_is(source->kind, "data_structure") ||
        sg_is(target->kind, "data_structure"))
        return "data";
    static const char *const code[] = {
        "CALLS",          "HTTP_CALLS", "ASYNC_CALLS", "CROSS_PROJECT_CALLS",
        "CALL_REFERENCE", "IMPLEMENTS", "INHERITS",    "READS",
        "WRITES",         "USAGE",      "DEFINES",     "DEFINES_METHOD",
        "CONTAINS",       "PUBLISHES",  "SUBSCRIBES",  "EMITS",
        "LISTENS_ON",     "HANDLES",    NULL};
    for (int i = 0; code[i]; i++)
        if (sg_is(type, code[i]))
            return "code";
    return "other";
}

static yyjson_mut_val *sg_ref(sg_context *c, const char *key, int64_t id) {
    yyjson_mut_val *ref = yyjson_mut_obj(c->doc);
    yyjson_mut_obj_add_str(c->doc, ref, "project", c->project);
    yyjson_mut_obj_add_str(c->doc, ref, "generation", c->generation);
    yyjson_mut_obj_add_sint(c->doc, ref, key, id);
    return ref;
}

/* SQL bounds each row before SQLite copies it to us. Missing, oversized or
 * non-object evidence is visible as a gap, never replaced by guessed facts. */
static yyjson_mut_val *sg_properties(sg_context *c, sqlite3_stmt *stmt, int column) {
    const char *text = (const char *)sqlite3_column_text(stmt, column);
    size_t bytes = (size_t)sqlite3_column_bytes(stmt, column);
    yyjson_doc *parsed = NULL;
    if (text && bytes <= SG_PROPERTY_BYTES - c->property_bytes)
        parsed = yyjson_read(text, bytes, 0);
    yyjson_mut_val *value = NULL;
    if (parsed && yyjson_is_obj(yyjson_doc_get_root(parsed))) {
        c->property_bytes += bytes;
        value = yyjson_val_mut_copy(c->doc, yyjson_doc_get_root(parsed));
    } else {
        c->unavailable++;
        value = yyjson_mut_obj(c->doc);
    }
    yyjson_doc_free(parsed);
    return value;
}

static bool sg_identity(sg_context *c, sqlite3_stmt *stmt, int first, int last) {
    size_t total = 0;
    for (int i = first; i <= last; i++) {
        size_t bytes = (size_t)sqlite3_column_bytes(stmt, i);
        if (bytes > SG_IDENTITY_FIELD_BYTES)
            return false;
        total += bytes;
    }
    if (total > SG_IDENTITY_BYTES - c->identity_bytes)
        return false;
    c->identity_bytes += total;
    return true;
}

static const char *sg_text(sqlite3_stmt *stmt, int column) {
    const unsigned char *text = sqlite3_column_text(stmt, column);
    return text ? (const char *)text : "";
}

static int sg_compare_nodes(const void *left, const void *right) {
    int64_t a = ((const sg_node *)left)->id, b = ((const sg_node *)right)->id;
    return (a > b) - (a < b);
}

static sg_node *sg_find_node(sg_context *c, int64_t id) {
    sg_node key = {.id = id};
    return bsearch(&key, c->nodes, (size_t)c->count, sizeof(*c->nodes), sg_compare_nodes);
}

static int sg_load_nodes(sg_context *c) {
    /* Cross-layer facts receive display space before the often much larger
     * symbol population. This is selection, never semantic aggregation. */
    const char *sql =
        "SELECT id,label,name,qualified_name,file_path,start_line,end_line,"
        "CASE WHEN properties IS NULL OR length(CAST(properties AS BLOB))<=16384 "
        "THEN coalesce(properties,'{}') END "
        "FROM nodes WHERE project=?1 ORDER BY CASE WHEN label IN "
        "('Resource','Image','Container','Chart','Database','Table','View','Schema','Collection',"
        "'Model','Column','Section','ADR','Document','Diagram','DiagramElement','EnvVar','Config',"
        "'Route','Channel','Queue','Service','Deployment','Process','Package') THEN 0 "
        "WHEN label IN ('Project','Folder','File','Module','Branch') THEN 2 ELSE 1 END,"
        "qualified_name,id LIMIT ?2";
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(c->db, sql, -1, &stmt, NULL) != SQLITE_OK)
        return CBM_STORE_ERR;
    sqlite3_bind_text(stmt, 1, c->project, -1, SQLITE_STATIC);
    sqlite3_bind_int(stmt, 2, c->options.max_entities);
    int step;
    while ((step = sqlite3_step(stmt)) == SQLITE_ROW) {
        if (sg_stopped(c))
            break;
        if (!sg_identity(c, stmt, 1, 4)) {
            c->unavailable++;
            continue;
        }
        yyjson_mut_val *entity = yyjson_mut_obj(c->doc);
        yyjson_mut_val *properties = sg_properties(c, stmt, 7);
        sg_node *node = &c->nodes[c->count++];
        node->id = sqlite3_column_int64(stmt, 0);
        node->kind = sg_kind(sg_text(stmt, 1), sg_text(stmt, 4), properties);
        node->pdf = sg_extension(sg_text(stmt, 4), ".pdf");
        yyjson_mut_val *page = yyjson_mut_obj_get(properties, "page");
        node->page = sg_page(page);
        if (node->pdf) {
            yyjson_mut_obj_remove_key(properties, "page");
            if (node->page > 0)
                yyjson_mut_obj_add_int(c->doc, properties, "page", node->page);
        }
        node->entity = entity;
        char id[48];
        snprintf(id, sizeof(id), "n:%" PRId64, node->id);
        yyjson_mut_obj_add_strcpy(c->doc, entity, "id", id);
        yyjson_mut_obj_add_str(c->doc, entity, "kind", node->kind);
        yyjson_mut_obj_add_strcpy(c->doc, entity, "label", sg_text(stmt, 1));
        yyjson_mut_obj_add_strcpy(c->doc, entity, "name", sg_text(stmt, 2));
        yyjson_mut_obj_add_strcpy(c->doc, entity, "qualified_name", sg_text(stmt, 3));
        yyjson_mut_obj_add_strcpy(c->doc, entity, "file_path", sg_text(stmt, 4));
        if (!node->pdf) {
            yyjson_mut_obj_add_int(c->doc, entity, "start_line",
                                   sqlite3_column_int(stmt, 5) > 0 ? sqlite3_column_int(stmt, 5)
                                                                   : 0);
            yyjson_mut_obj_add_int(c->doc, entity, "end_line",
                                   sqlite3_column_int(stmt, 6) > 0 ? sqlite3_column_int(stmt, 6)
                                                                   : 0);
        }
        yyjson_mut_obj_add_val(c->doc, entity, "ref", sg_ref(c, "node_id", node->id));
        yyjson_mut_obj_add_val(c->doc, entity, "properties", properties);
        yyjson_mut_arr_append(c->entities, entity);
        if (c->budget.failed)
            break;
    }
    sqlite3_finalize(stmt);
    qsort(c->nodes, (size_t)c->count, sizeof(*c->nodes), sg_compare_nodes);
    return step == SQLITE_DONE && !c->budget.failed ? CBM_STORE_OK : CBM_STORE_ERR;
}

static int sg_load_edges(sg_context *c) {
    if (!c->count)
        return CBM_STORE_OK;
    /* json_each binds a bounded list, avoiding writes/temp tables and SQLite's
     * per-statement host-parameter limit. Both endpoints must be in the view. */
    yyjson_mut_val *ids = yyjson_mut_arr(c->doc);
    for (int i = 0; i < c->count; i++)
        yyjson_mut_arr_add_sint(c->doc, ids, c->nodes[i].id);
    char *ids_json = yyjson_mut_val_write_opts(ids, 0, cbm_json_writer_allocator(), NULL, NULL);
    if (!ids_json)
        return CBM_STORE_ERR;
    const char *sql =
        "SELECT id,source_id,target_id,type,"
        "CASE WHEN properties IS NULL OR length(CAST(properties AS BLOB))<=16384 "
        "THEN coalesce(properties,'{}') END "
        "FROM edges WHERE project=?1 AND source_id IN (SELECT value FROM json_each(?2)) "
        "AND target_id IN (SELECT value FROM json_each(?2)) "
        "ORDER BY CASE WHEN type IN ('DEPLOYS','CONFIGURES','INFRA_MAPS','SPAWNS','MENTIONS',"
        "'SUPERSEDES','REFERENCES_FILE','DIAGRAM_ARROW','HTTP_CALLS','ASYNC_CALLS','DATA_FLOWS') "
        "THEN 0 ELSE 1 END,source_id,target_id,type,id LIMIT ?3";
    sqlite3_stmt *stmt = NULL;
    int rc = sqlite3_prepare_v2(c->db, sql, -1, &stmt, NULL);
    if (rc != SQLITE_OK) {
        cbm_free(CBM_MEM_CLASS_OTHER, ids_json);
        return CBM_STORE_ERR;
    }
    sqlite3_bind_text(stmt, 1, c->project, -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 2, ids_json, -1, SQLITE_STATIC);
    sqlite3_bind_int(stmt, 3, c->options.max_relations);
    int step;
    while ((step = sqlite3_step(stmt)) == SQLITE_ROW) {
        if (sg_stopped(c))
            break;
        sg_node *source = sg_find_node(c, sqlite3_column_int64(stmt, 1));
        sg_node *target = sg_find_node(c, sqlite3_column_int64(stmt, 2));
        if (!source || !target || !sg_identity(c, stmt, 3, 3)) {
            c->unavailable++;
            continue;
        }
        yyjson_mut_val *relation = yyjson_mut_obj(c->doc), *witness = yyjson_mut_obj(c->doc);
        yyjson_mut_val *witnesses = yyjson_mut_arr(c->doc);
        yyjson_mut_val *properties = sg_properties(c, stmt, 4);
        int64_t edge_id = sqlite3_column_int64(stmt, 0);
        char id[48];
        snprintf(id, sizeof(id), "r:%" PRId64, edge_id);
        yyjson_mut_obj_add_strcpy(c->doc, relation, "id", id);
        yyjson_mut_obj_add_str(c->doc, relation, "source",
                               yyjson_mut_get_str(yyjson_mut_obj_get(source->entity, "id")));
        yyjson_mut_obj_add_str(c->doc, relation, "target",
                               yyjson_mut_get_str(yyjson_mut_obj_get(target->entity, "id")));
        yyjson_mut_obj_add_strcpy(c->doc, relation, "type", sg_text(stmt, 3));
        yyjson_mut_obj_add_str(c->doc, relation, "layer",
                               sg_layer(sg_text(stmt, 3), source, target));
        yyjson_mut_obj_add_str(c->doc, relation, "evidence", "indexed");
        yyjson_mut_obj_add_val(c->doc, witness, "ref", sg_ref(c, "edge_id", edge_id));
        yyjson_mut_obj_add_val(c->doc, witness, "source", sg_ref(c, "node_id", source->id));
        yyjson_mut_obj_add_val(c->doc, witness, "target", sg_ref(c, "node_id", target->id));
        yyjson_mut_obj_add_val(c->doc, witness, "properties", properties);
        const char *file = yyjson_mut_get_str(yyjson_mut_obj_get(source->entity, "file_path"));
        if (file && file[0]) {
            yyjson_mut_val *location = yyjson_mut_obj(c->doc);
            yyjson_mut_obj_add_str(c->doc, location, "file_path", file);
            yyjson_mut_val *line = yyjson_mut_obj_get(properties, "line");
            if (source->pdf) {
                yyjson_mut_val *page = yyjson_mut_obj_get(properties, "page");
                int explicit_page = sg_page(page);
                bool recorded = explicit_page > 0;
                int64_t page_number = recorded ? explicit_page : source->page;
                if (page_number > 0) {
                    yyjson_mut_obj_add_int(c->doc, location, "page", page_number);
                    yyjson_mut_obj_add_str(c->doc, location, "position_kind",
                                           recorded ? "relationship" : "source_context");
                }
            } else if (yyjson_mut_is_int(line) && yyjson_mut_get_sint(line) > 0) {
                yyjson_mut_obj_add_sint(c->doc, location, "line", yyjson_mut_get_sint(line));
            }
            yyjson_mut_obj_add_val(c->doc, witness, "location", location);
        }
        yyjson_mut_arr_append(witnesses, witness);
        yyjson_mut_obj_add_val(c->doc, relation, "witnesses", witnesses);
        yyjson_mut_arr_append(c->relations, relation);
        if (c->budget.failed)
            break;
    }
    sqlite3_finalize(stmt);
    cbm_free(CBM_MEM_CLASS_OTHER, ids_json);
    return step == SQLITE_DONE && !c->budget.failed ? CBM_STORE_OK : CBM_STORE_ERR;
}

static void sg_gap(sg_context *c, yyjson_mut_val *gaps, const char *code, const char *message,
                   int64_t count) {
    yyjson_mut_val *gap = yyjson_mut_obj(c->doc);
    yyjson_mut_obj_add_str(c->doc, gap, "code", code);
    yyjson_mut_obj_add_str(c->doc, gap, "message", message);
    yyjson_mut_obj_add_sint(c->doc, gap, "count", count);
    yyjson_mut_arr_append(gaps, gap);
}

static bool sg_flow_coverage(sg_context *c, yyjson_mut_val *root) {
    int64_t files = 0, with_values = 0, gapped = 0, stale = 0;
    sqlite3_stmt *statement = NULL;
    /* Older generations have no Flow schema. Absence never makes a
     * read-only system graph initialize or migrate the store. */
    const char *sql =
        "SELECT count(*),coalesce(sum(f.status='ready' "
        "AND NOT(f.adapter='tree-sitter-lexical-flow' AND f.adapter_version<4) AND EXISTS("
        "SELECT 1 FROM cbm_flow_values v WHERE v.project=f.project AND "
        "v.file_path=f.file_path)),0),"
        "coalesce(sum(EXISTS(SELECT 1 FROM cbm_flow_gaps g "
        "WHERE g.project=f.project AND g.file_path=f.file_path)),0),"
        "coalesce(sum(f.status<>'ready' OR "
        "(f.adapter='tree-sitter-lexical-flow' AND f.adapter_version<4)),0) "
        "FROM cbm_flow_files f WHERE f.project=?1";
    if (sqlite3_prepare_v2(c->db, sql, -1, &statement, NULL) == SQLITE_OK) {
        sqlite3_bind_text(statement, 1, c->project, -1, SQLITE_TRANSIENT);
        if (sqlite3_step(statement) == SQLITE_ROW) {
            files = sqlite3_column_int64(statement, 0);
            with_values = sqlite3_column_int64(statement, 1);
            gapped = sqlite3_column_int64(statement, 2);
            stale = sqlite3_column_int64(statement, 3);
        }
    }
    sqlite3_finalize(statement);
    yyjson_mut_val *coverage = yyjson_mut_obj(c->doc);
    yyjson_mut_obj_add_str(c->doc, coverage, "scope", "indexed_flow_partitions");
    yyjson_mut_obj_add_sint(c->doc, coverage, "indexed_files", files);
    yyjson_mut_obj_add_sint(c->doc, coverage, "files_with_values", with_values);
    yyjson_mut_obj_add_sint(c->doc, coverage, "gapped_files", gapped);
    yyjson_mut_obj_add_sint(c->doc, coverage, "stale_files", stale);
    yyjson_mut_obj_add_val(c->doc, root, "flow_coverage", coverage);
    return with_values > 0;
}

static int sg_render(sg_context *c, char **out_json) {
    yyjson_mut_doc *doc = c->doc;
    yyjson_mut_val *root = yyjson_mut_obj(doc), *totals = yyjson_mut_obj(doc);
    yyjson_mut_val *limits = yyjson_mut_obj(doc), *gaps = yyjson_mut_arr(doc);
    yyjson_mut_val *capabilities = yyjson_mut_obj(doc), *groups = yyjson_mut_arr(doc);
    int64_t relations = (int64_t)yyjson_mut_arr_size(c->relations);
    int64_t omitted_nodes = c->total_nodes - c->count, omitted_edges = c->total_edges - relations;
    bool complete = !omitted_nodes && !omitted_edges && !c->unavailable;
    yyjson_mut_doc_set_root(doc, root);
    yyjson_mut_obj_add_int(doc, root, "schema_version", 1);
    yyjson_mut_obj_add_str(doc, root, "project", c->project);
    yyjson_mut_obj_add_str(doc, root, "generation", c->generation);
    yyjson_mut_obj_add_str(doc, root, "status", complete ? "ready" : "limited");
    yyjson_mut_obj_add_bool(doc, root, "complete", complete);
    yyjson_mut_obj_add_str(doc, root, "completeness_scope", "indexed_graph_projection");
    yyjson_mut_obj_add_val(doc, root, "entities", c->entities);
    yyjson_mut_obj_add_val(doc, root, "relations", c->relations);
    yyjson_mut_obj_add_sint(doc, totals, "nodes", c->total_nodes);
    yyjson_mut_obj_add_sint(doc, totals, "edges", c->total_edges);
    yyjson_mut_obj_add_int(doc, totals, "entities", c->count);
    yyjson_mut_obj_add_sint(doc, totals, "relations", relations);
    yyjson_mut_obj_add_val(doc, root, "totals", totals);
    yyjson_mut_obj_add_int(doc, limits, "max_entities", c->options.max_entities);
    yyjson_mut_obj_add_int(doc, limits, "max_relations", c->options.max_relations);
    yyjson_mut_obj_add_sint(doc, limits, "omitted_entities", omitted_nodes);
    yyjson_mut_obj_add_sint(doc, limits, "omitted_relations", omitted_edges);
    yyjson_mut_obj_add_val(doc, root, "limits", limits);
    yyjson_mut_obj_add_bool(doc, capabilities, "static_system_graph", true);
    yyjson_mut_obj_add_bool(doc, capabilities, "field_value_flow", sg_flow_coverage(c, root));
    yyjson_mut_obj_add_bool(doc, capabilities, "live_capture", false);
    yyjson_mut_obj_add_val(doc, root, "capabilities", capabilities);
    if (omitted_nodes)
        sg_gap(c, gaps, "entity_limit", "Indexed entities exceed the bounded display budget.",
               omitted_nodes);
    if (omitted_edges)
        sg_gap(c, gaps, "relation_limit",
               "Indexed relationships exceed the display budget or have undisplayed endpoints.",
               omitted_edges);
    if (c->unavailable)
        sg_gap(
            c, gaps, "evidence_unavailable",
            "Some indexed identity or property evidence was invalid or exceeded the text budget.",
            c->unavailable);
    yyjson_mut_obj_add_val(doc, root, "gaps", gaps);
    static const char *const kinds[] = {
        "code",      "service",       "database",   "data_structure", "deployment",
        "container", "configuration", "document",   "diagram",        "dependency",
        "api",       "queue",         "structural", "other",          NULL};
    for (int k = 0; kinds[k]; k++) {
        int count = 0;
        for (int i = 0; i < c->count; i++)
            if (sg_is(c->nodes[i].kind, kinds[k]))
                count++;
        if (count) {
            yyjson_mut_val *group = yyjson_mut_obj(doc);
            yyjson_mut_obj_add_str(doc, group, "kind", kinds[k]);
            yyjson_mut_obj_add_int(doc, group, "count", count);
            yyjson_mut_arr_append(groups, group);
        }
    }
    yyjson_mut_obj_add_val(doc, root, "groups", groups);
    if (c->budget.failed)
        return CBM_STORE_SCAN_LIMIT;
    size_t bytes = 0;
    *out_json = yyjson_mut_write_opts(doc, 0, cbm_json_writer_allocator(), &bytes, NULL);
    if (*out_json && bytes > SG_OUTPUT_BYTES) {
        cbm_free(CBM_MEM_CLASS_OTHER, *out_json);
        *out_json = NULL;
        return CBM_STORE_SCAN_LIMIT;
    }
    return *out_json ? CBM_STORE_OK : CBM_STORE_ERR;
}

int cbm_store_system_graph(cbm_store_t *store, const char *project,
                           const cbm_system_graph_options_t *options, char **out_json) {
    if (!store || !project || !project[0] || !out_json)
        return CBM_STORE_ERR;
    *out_json = NULL;
    sg_context c = {.db = cbm_store_get_db(store), .project = project};
    if (options)
        c.options = *options;
    c.options.max_entities = c.options.max_entities <= 0     ? 2048
                             : c.options.max_entities > 8192 ? 8192
                                                             : c.options.max_entities;
    c.options.max_relations = c.options.max_relations <= 0      ? 8192
                              : c.options.max_relations > 32768 ? 32768
                                                                : c.options.max_relations;
    if (!c.options.deadline_ms)
        c.options.deadline_ms = cbm_now_ms() + 5000;
    if (sg_stopped(&c))
        return c.cancelled ? CBM_STORE_CANCELLED : CBM_STORE_SCAN_LIMIT;
    bool transaction = sqlite3_get_autocommit(c.db) != 0;
    sqlite3_progress_handler(c.db, 1000, sg_progress, &c);
    int rc = transaction && sqlite3_exec(c.db, "BEGIN", NULL, NULL, NULL) != SQLITE_OK
                 ? CBM_STORE_ERR
                 : CBM_STORE_OK;
    cbm_project_t metadata = {0};
    if (rc == CBM_STORE_OK)
        rc = cbm_store_get_project(store, project, &metadata);
    cbm_project_free_fields(&metadata);
    if (rc == CBM_STORE_OK)
        rc = cbm_store_generation(store, c.generation, sizeof(c.generation));
    yyjson_alc allocator = {
        .malloc = sg_malloc, .realloc = sg_realloc, .free = sg_free, .ctx = &c.budget};
    if (rc == CBM_STORE_OK) {
        c.total_nodes = cbm_store_count_nodes(store, project);
        c.total_edges = cbm_store_count_edges(store, project);
        c.doc = yyjson_mut_doc_new(&allocator);
        c.nodes =
            cbm_calloc(CBM_MEM_CLASS_OTHER, (size_t)c.options.max_entities * sizeof(*c.nodes));
        if (c.total_nodes < 0 || c.total_edges < 0 || !c.doc || !c.nodes)
            rc = CBM_STORE_ERR;
    }
    if (rc == CBM_STORE_OK) {
        c.entities = yyjson_mut_arr(c.doc);
        c.relations = yyjson_mut_arr(c.doc);
        rc = sg_load_nodes(&c);
    }
    if (rc == CBM_STORE_OK)
        rc = sg_load_edges(&c);
    if (rc == CBM_STORE_OK && !sg_stopped(&c))
        rc = sg_render(&c, out_json);
    sqlite3_progress_handler(c.db, 0, NULL, NULL);
    if (transaction && sqlite3_exec(c.db, "ROLLBACK", NULL, NULL, NULL) != SQLITE_OK)
        rc = CBM_STORE_SCOPE_DISCARD;
    yyjson_mut_doc_free(c.doc);
    cbm_free(CBM_MEM_CLASS_OTHER, c.nodes);
    if (c.cancelled)
        rc = CBM_STORE_CANCELLED;
    else if (c.expired)
        rc = CBM_STORE_SCAN_LIMIT;
    if (rc != CBM_STORE_OK) {
        cbm_free(CBM_MEM_CLASS_OTHER, *out_json);
        *out_json = NULL;
    }
    return rc;
}
