#include "ui/documents.h"
#include "foundation/json_writer.h"
#include "foundation/mem_core.h"
#include "foundation/compat.h"
#include "foundation/compat_fs.h"
#include "foundation/platform.h"
#include "foundation/sha256.h"
#include "foundation/workspace.h"
#include <sqlite3/sqlite3.h>
#include <yyjson/yyjson.h>
#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#define DOC_PAGE_SIZE 100
#define DOC_DETAIL_LIMIT 500
#define DOC_TEXT_LIMIT (256U * 1024U)
#define DOC_NODE_COLUMNS \
    "n.id,n.label,n.name,n.qualified_name,n.file_path,n.start_line,n.end_line,n.properties"
#define DOC_LABELS "('File','Section','ADR','Diagram','DiagramElement')"
#define DOC_PATH_SQL                                                               \
    "(lower(n.file_path) GLOB '*.md' OR lower(n.file_path) GLOB '*.mdx' OR "       \
    "lower(n.file_path) GLOB '*.markdown' OR lower(n.file_path) GLOB '*.rst' OR "  \
    "lower(n.file_path) GLOB '*.adoc' OR lower(n.file_path) GLOB '*.asciidoc' OR " \
    "lower(n.file_path) GLOB '*.pdf' OR lower(n.file_path) GLOB '*.drawio' OR "    \
    "lower(n.file_path) GLOB '*.mmd' OR lower(n.file_path) GLOB '*.mermaid' OR "   \
    "lower(n.file_path) GLOB '*.puml' OR lower(n.file_path) GLOB '*.plantuml' OR " \
    "lower(n.file_path) GLOB '*.dot' OR lower(n.file_path) GLOB '*.d2' OR "        \
    "lower(n.file_path) GLOB '*.excalidraw' OR n.label IN ('ADR','Diagram'))"

typedef struct {
    cbm_store_read_scope_t *scope;
    cbm_project_t project;
    yyjson_mut_doc *doc;
    yyjson_mut_val *root;
    yyjson_mut_val *warnings;
    char generation[128];
    uint64_t deadline;
} docs_context_t;

static bool docs_cancel(void *context) {
    return cbm_now_ms() > ((docs_context_t *)context)->deadline;
}

static char *docs_error(int *status, int code, const char *message) {
    *status = code;
    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    if (!doc)
        return NULL;
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);
    yyjson_mut_obj_add_strcpy(doc, root, "error", message);
    char *json = yyjson_mut_write_opts(doc, 0, cbm_json_writer_allocator(), NULL, NULL);
    yyjson_mut_doc_free(doc);
    return json;
}

static int docs_begin(cbm_store_t *store, const char *project, docs_context_t *ctx) {
    ctx->deadline = cbm_now_ms() + 3000;
    if (!store || !project || !*project)
        return 400;
    if (cbm_store_read_scope_open(store, docs_cancel, ctx, &ctx->scope) != CBM_STORE_OK)
        return 503;
    int rc = cbm_store_get_project(store, project, &ctx->project);
    if (rc != CBM_STORE_OK)
        return rc == CBM_STORE_NOT_FOUND ? 404 : 500;
    if (cbm_store_generation(store, ctx->generation, sizeof(ctx->generation)) != CBM_STORE_OK)
        return 500;
    ctx->doc = yyjson_mut_doc_new(NULL);
    if (!ctx->doc)
        return 500;
    ctx->root = yyjson_mut_obj(ctx->doc);
    ctx->warnings = yyjson_mut_arr(ctx->doc);
    yyjson_mut_doc_set_root(ctx->doc, ctx->root);
    yyjson_mut_obj_add_int(ctx->doc, ctx->root, "schema_version", 1);
    yyjson_mut_obj_add_strcpy(ctx->doc, ctx->root, "generation", ctx->generation);
    yyjson_mut_obj_add_val(ctx->doc, ctx->root, "warnings", ctx->warnings);
    return 200;
}

static char *docs_end(docs_context_t *ctx, int *status, int code, const char *message) {
    int rc = cbm_store_read_scope_close(ctx->scope);
    cbm_project_free_fields(&ctx->project);
    char *json = NULL;
    if (code == 200 && rc == CBM_STORE_OK)
        json = yyjson_mut_write_opts(ctx->doc, 0, cbm_json_writer_allocator(), NULL, NULL);
    yyjson_mut_doc_free(ctx->doc);
    if (code != 200)
        return docs_error(status, code, message);
    if (!json)
        return docs_error(status, 503, "Document query could not complete. Try a narrower search.");
    *status = 200;
    return json;
}

static const char *docs_text(sqlite3_stmt *st, int col) {
    const char *value = (const char *)sqlite3_column_text(st, col);
    return value ? value : "";
}

static bool docs_suffix(const char *path, const char *suffix) {
    size_t n = strlen(path), m = strlen(suffix);
    if (m > n)
        return false;
    for (size_t i = 0; i < m; i++)
        if (tolower((unsigned char)path[n - m + i]) != suffix[i])
            return false;
    return true;
}

/* PDF extractors persist extra properties as strings. Accept only canonical
 * positive decimal page numbers, never text offsets or coercible JSON values. */
static int docs_page(yyjson_val *value) {
    if (yyjson_is_uint(value)) {
        uint64_t page = yyjson_get_uint(value);
        return page > 0 && page <= INT_MAX ? (int)page : 0;
    }
    if (yyjson_is_sint(value)) {
        int64_t page = yyjson_get_sint(value);
        return page > 0 && page <= INT_MAX ? (int)page : 0;
    }
    const char *text = yyjson_get_str(value);
    size_t length = yyjson_get_len(value);
    if (!text || !length || length > 10 || text[0] < '1' || text[0] > '9')
        return 0;
    int page = 0;
    for (size_t i = 0; i < length; i++) {
        if (text[i] < '0' || text[i] > '9')
            return 0;
        int digit = text[i] - '0';
        if (page > (INT_MAX - digit) / 10)
            return 0;
        page = page * 10 + digit;
    }
    return page;
}

static const char *docs_kind(const char *path, const char *label, bool adr) {
    if (adr || strcmp(label, "ADR") == 0)
        return "adr";
    if (docs_suffix(path, ".pdf"))
        return "pdf";
    if (strncmp(label, "Diagram", 7) == 0 || docs_suffix(path, ".drawio") ||
        docs_suffix(path, ".mmd") || docs_suffix(path, ".mermaid") || docs_suffix(path, ".puml") ||
        docs_suffix(path, ".plantuml") || docs_suffix(path, ".dot") || docs_suffix(path, ".d2") ||
        docs_suffix(path, ".excalidraw"))
        return "diagram";
    if (docs_suffix(path, ".md") || docs_suffix(path, ".mdx") || docs_suffix(path, ".markdown"))
        return "markdown";
    return "other";
}

static yyjson_mut_val *docs_node_json(docs_context_t *ctx, sqlite3_stmt *st, int offset,
                                      const char *project, bool adr) {
    yyjson_mut_doc *doc = ctx->doc;
    yyjson_mut_val *node = yyjson_mut_obj(doc);
    yyjson_mut_obj_add_int(doc, node, "id", sqlite3_column_int64(st, offset));
    yyjson_mut_obj_add_strcpy(doc, node, "project", project);
    const char *keys[] = {"label", "name", "qualified_name", "file_path"};
    for (int i = 0; i < 4; i++)
        yyjson_mut_obj_add_strcpy(doc, node, keys[i], docs_text(st, offset + 1 + i));
    int start = sqlite3_column_int(st, offset + 5), end = sqlite3_column_int(st, offset + 6);
    yyjson_mut_obj_add_int(doc, node, "start_line", start > 0 ? start : 0);
    yyjson_mut_obj_add_int(doc, node, "end_line", end > 0 ? end : 0);
    const char *kind = docs_kind(docs_text(st, offset + 4), docs_text(st, offset + 1), adr);
    yyjson_mut_obj_add_str(doc, node, "kind", kind);
    yyjson_mut_obj_add_str(doc, node, "location_kind",
                           strcmp(kind, "pdf") == 0       ? "pages"
                           : strcmp(kind, "diagram") == 0 ? "diagram"
                                                          : "lines");
    return node;
}

static bool docs_kind_valid(const char *kind) {
    return !kind || !*kind || strcmp(kind, "all") == 0 || strcmp(kind, "markdown") == 0 ||
           strcmp(kind, "pdf") == 0 || strcmp(kind, "diagram") == 0 || strcmp(kind, "adr") == 0 ||
           strcmp(kind, "other") == 0;
}

char *cbm_documents_list(cbm_store_t *store, const char *project, const char *kind,
                         const char *query, const char *cursor, int *http_status) {
    if (!docs_kind_valid(kind))
        return docs_error(http_status, 400, "Unknown document kind.");
    docs_context_t ctx = {0};
    int status = docs_begin(store, project, &ctx);
    if (status != 200)
        return docs_end(&ctx, http_status, status, "Project documentation is unavailable.");
    int64_t after = 0;
    if (cursor && *cursor) {
        size_t n = strlen(ctx.generation);
        if (strncmp(cursor, ctx.generation, n) != 0 || cursor[n] != '|')
            return docs_end(&ctx, http_status, 409, "The index changed. Refresh the catalog.");
        char *end = NULL;
        errno = 0;
        after = strtoll(cursor + n + 1, &end, 10);
        if (errno || !end || *end || after <= 0)
            return docs_end(&ctx, http_status, 400, "Invalid document cursor.");
    }
    static const char *sql =
        "WITH paths AS (SELECT DISTINCT n.file_path FROM nodes n WHERE n.project=?1 "
        "AND n.label IN " DOC_LABELS " AND n.file_path<>'' AND " DOC_PATH_SQL "), "
        "selected AS (SELECT coalesce("
        "(SELECT min(id) FROM nodes WHERE project=?1 AND file_path=p.file_path AND label='File'),"
        "(SELECT min(id) FROM nodes WHERE project=?1 AND file_path=p.file_path AND label "
        "IN " DOC_LABELS ")) AS id FROM paths p) "
        "SELECT " DOC_NODE_COLUMNS ",EXISTS(SELECT 1 FROM nodes a WHERE a.project=?1 "
        "AND a.file_path=n.file_path AND a.label='ADR') FROM nodes n "
        "JOIN selected d ON d.id=n.id WHERE n.id>?2 AND "
        "(?3='' OR instr(lower(n.file_path),lower(?3))>0 OR instr(lower(n.name),lower(?3))>0) "
        "ORDER BY n.id";
    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(cbm_store_get_db(store), sql, -1, &st, NULL) != SQLITE_OK)
        return docs_end(&ctx, http_status, 500, "Document catalog query failed.");
    sqlite3_bind_text(st, 1, project, -1, SQLITE_STATIC);
    sqlite3_bind_int64(st, 2, after);
    sqlite3_bind_text(st, 3, query ? query : "", -1, SQLITE_STATIC);
    yyjson_mut_val *rows = yyjson_mut_arr(ctx.doc);
    yyjson_mut_obj_add_val(ctx.doc, ctx.root, "documents", rows);
    int rc, count = 0;
    int64_t last = after;
    bool more = false;
    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
        const char *row_kind =
            docs_kind(docs_text(st, 4), docs_text(st, 1), sqlite3_column_int(st, 8) != 0);
        if (kind && *kind && strcmp(kind, "all") != 0 && strcmp(kind, row_kind) != 0)
            continue;
        if (count == DOC_PAGE_SIZE) {
            more = true;
            break;
        }
        yyjson_mut_arr_add_val(
            rows, docs_node_json(&ctx, st, 0, project, sqlite3_column_int(st, 8) != 0));
        last = sqlite3_column_int64(st, 0);
        count++;
    }
    sqlite3_finalize(st);
    if (rc != SQLITE_DONE && !more)
        return docs_end(&ctx, http_status, 503, "Document catalog exceeded its query budget.");
    yyjson_mut_obj_add_bool(ctx.doc, ctx.root, "complete", !more);
    if (more) {
        char next[192];
        snprintf(next, sizeof(next), "%s|%lld", ctx.generation, (long long)last);
        yyjson_mut_obj_add_strcpy(ctx.doc, ctx.root, "next_cursor", next);
    }
    return docs_end(&ctx, http_status, 200, NULL);
}

static void docs_warning(docs_context_t *ctx, const char *warning) {
    yyjson_mut_arr_add_strcpy(ctx->doc, ctx->warnings, warning);
}

/* Only indexed paths inside the registered project root can be read. */
static char *docs_read_source(cbm_store_t *store, docs_context_t *ctx, const char *file,
                              bool *truncated, bool *stale) {
    char path[4096], canonical[4096];
    int length = snprintf(path, sizeof(path), "%s/%s", ctx->project.root_path, file);
    if (length < 0 || (size_t)length >= sizeof(path) ||
        !cbm_canonical_path(path, canonical, sizeof(canonical)) ||
        !cbm_path_within_root(ctx->project.root_path, canonical)) {
        docs_warning(ctx, "The indexed source is missing or outside the project.");
        return NULL;
    }
    cbm_path_info_t info;
    if (cbm_path_info_utf8(canonical, &info) != CBM_PATH_INFO_OK || !info.is_regular)
        return NULL;
    FILE *input = cbm_fopen(canonical, "rb");
    if (!input)
        return NULL;
    char *text = cbm_alloc(CBM_MEM_CLASS_OTHER, DOC_TEXT_LIMIT + 2);
    if (!text) {
        fclose(input);
        return NULL;
    }
    size_t n = fread(text, 1, DOC_TEXT_LIMIT + 1, input);
    bool failed = ferror(input) != 0;
    fclose(input);
    if (failed || memchr(text, '\0', n)) {
        cbm_free(CBM_MEM_CLASS_OTHER, text);
        docs_warning(ctx, "The source could not be read as text.");
        return NULL;
    }
    *truncated = n > DOC_TEXT_LIMIT;
    cbm_file_hash_t hash = {0};
    if (!*truncated &&
        cbm_store_get_file_hash(store, ctx->project.name, file, &hash) == CBM_STORE_OK) {
        char actual[65];
        cbm_sha256_hex(text, n, actual);
        *stale = !hash.sha256 || strcmp(actual, hash.sha256) != 0;
        cbm_store_clear_file_hash(&hash);
    } else {
        docs_warning(ctx, "Source freshness could not be verified against the index.");
    }
    if (*truncated) {
        n = DOC_TEXT_LIMIT;
        while (n && ((unsigned char)text[n] & 0xc0) == 0x80)
            n--;
    }
    text[n] = '\0';
    return text;
}

char *cbm_documents_detail(cbm_store_t *store, const char *project, int64_t node_id,
                           const char *file_path, const char *generation, int *http_status) {
    docs_context_t ctx = {0};
    int status = docs_begin(store, project, &ctx);
    if (status != 200)
        return docs_end(&ctx, http_status, status, "Project documentation is unavailable.");
    if (generation && *generation && strcmp(generation, ctx.generation) != 0)
        return docs_end(&ctx, http_status, 409, "The index changed. Refresh the catalog.");
    sqlite3 *db = cbm_store_get_db(store);
    sqlite3_stmt *st = NULL;
    static const char *lookup =
        "SELECT " DOC_NODE_COLUMNS " FROM nodes n WHERE n.project=?1 AND "
        "n.label IN " DOC_LABELS " AND (?2>0 AND n.id=?2 OR ?2<=0 AND n.file_path=?3) "
        "AND (" DOC_PATH_SQL " OR EXISTS(SELECT 1 FROM nodes d WHERE d.project=?1 "
        "AND d.file_path=n.file_path AND d.label IN ('ADR','Diagram'))) "
        "ORDER BY CASE n.label WHEN 'File' THEN 0 ELSE 1 END,n.id LIMIT 1";
    if (sqlite3_prepare_v2(db, lookup, -1, &st, NULL) != SQLITE_OK)
        return docs_end(&ctx, http_status, 500, "Document lookup failed.");
    sqlite3_bind_text(st, 1, project, -1, SQLITE_STATIC);
    sqlite3_bind_int64(st, 2, node_id);
    sqlite3_bind_text(st, 3, file_path ? file_path : "", -1, SQLITE_STATIC);
    int rc = sqlite3_step(st);
    if (rc != SQLITE_ROW) {
        sqlite3_finalize(st);
        return docs_end(&ctx, http_status, rc == SQLITE_DONE ? 404 : 503,
                        "Document not found in this project index.");
    }
    char *file = cbm_mem_strdup(CBM_MEM_CLASS_OTHER, docs_text(st, 4));
    const char *kind = docs_kind(docs_text(st, 4), docs_text(st, 1), false);
    bool pdf = strcmp(kind, "pdf") == 0;
    yyjson_mut_val *document = docs_node_json(&ctx, st, 0, project, false);
    yyjson_mut_obj_add_val(ctx.doc, ctx.root, "document", document);
    sqlite3_finalize(st);
    st = NULL;
    if (!file)
        return docs_end(&ctx, http_status, 500, "Cannot allocate document.");
    yyjson_mut_val *sections = yyjson_mut_arr(ctx.doc), *relations = yyjson_mut_arr(ctx.doc);
    yyjson_mut_val *pages = pdf ? yyjson_mut_arr(ctx.doc) : NULL;
    yyjson_mut_obj_add_val(ctx.doc, ctx.root, "sections", sections);
    yyjson_mut_obj_add_val(ctx.doc, ctx.root, "relationships", relations);
    if (pdf)
        yyjson_mut_obj_add_val(ctx.doc, ctx.root, "pages", pages);
    bool truncated = false, stale = false;
    char *text = pdf ? cbm_calloc(CBM_MEM_CLASS_OTHER, DOC_TEXT_LIMIT + 1)
                     : docs_read_source(store, &ctx, file, &truncated, &stale);
    size_t text_length = 0;
    const char *mode = pdf ? "extracted" : text ? "full" : "unavailable";
    if (pdf && !text)
        goto fail;
    static const char *section_sql =
        "SELECT " DOC_NODE_COLUMNS " FROM nodes n WHERE n.project=?1 AND n.file_path=?2 "
        "AND n.label IN ('Section','ADR','Diagram','DiagramElement') "
        "ORDER BY n.start_line,n.id LIMIT 501";
    if (sqlite3_prepare_v2(db, section_sql, -1, &st, NULL) != SQLITE_OK)
        goto fail;
    sqlite3_bind_text(st, 1, project, -1, SQLITE_STATIC);
    sqlite3_bind_text(st, 2, file, -1, SQLITE_STATIC);
    int count = 0;
    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
        if (++count > DOC_DETAIL_LIMIT) {
            docs_warning(&ctx, "Only the first 500 document sections are shown.");
            truncated = true;
            break;
        }
        yyjson_mut_arr_add_val(sections, docs_node_json(&ctx, st, 0, project, false));
        if (strcmp(docs_text(st, 1), "ADR") == 0)
            yyjson_mut_obj_put(document, yyjson_mut_str(ctx.doc, "kind"),
                               yyjson_mut_str(ctx.doc, "adr"));
        if (pdf && strcmp(docs_text(st, 1), "Section") == 0) {
            const char *raw = docs_text(st, 7);
            yyjson_doc *props = yyjson_read(raw, strlen(raw), 0);
            const char *body =
                props ? yyjson_get_str(yyjson_obj_get(yyjson_doc_get_root(props), "docstring"))
                      : NULL;
            yyjson_val *page_value =
                props ? yyjson_obj_get(yyjson_doc_get_root(props), "page") : NULL;
            int page_number = docs_page(page_value);
            size_t body_length = 0;
            if (body && *body) {
                char heading[96];
                if (page_number > 0)
                    snprintf(heading, sizeof(heading), "\n\n## Page %d\n\n", page_number);
                else
                    heading[0] = '\0';
                const char *pieces[] = {heading, body};
                for (int i = 0; i < 2; i++) {
                    size_t length = strlen(pieces[i]), available = DOC_TEXT_LIMIT - text_length;
                    if (length > available) {
                        length = available;
                        while (length && ((unsigned char)pieces[i][length] & 0xc0) == 0x80)
                            length--;
                        truncated = true;
                    }
                    memcpy(text + text_length, pieces[i], length);
                    text_length += length;
                    text[text_length] = '\0';
                    if (i == 1)
                        body_length = length;
                }
            }
            if (page_number > 0 && page_number <= INT_MAX) {
                yyjson_mut_val *page = yyjson_mut_obj(ctx.doc);
                yyjson_mut_obj_add_int(ctx.doc, page, "page", page_number);
                yyjson_mut_obj_add_strncpy(ctx.doc, page, "text", body ? body : "", body_length);
                yyjson_mut_arr_add_val(pages, page);
            }
            yyjson_doc_free(props);
        }
    }
    sqlite3_finalize(st);
    st = NULL;
    if (rc != SQLITE_DONE && count <= DOC_DETAIL_LIMIT)
        goto fail;
    if (pdf && !text_length) {
        mode = "unavailable";
        docs_warning(&ctx,
                     "No indexed PDF text layer is available. Scanned pages need text extraction.");
    }
    if (pdf)
        docs_warning(&ctx, "PDF text and relationships describe the indexed snapshot.");
    static const char *relations_sql =
        "SELECT e.id,e.type,e.properties,"
        "CASE WHEN s.file_path=?2 THEN 'outgoing' ELSE 'incoming' END," DOC_NODE_COLUMNS
        ",s.file_path,s.properties "
        "FROM edges e JOIN nodes s ON s.id=e.source_id JOIN nodes t ON t.id=e.target_id "
        "JOIN nodes n ON n.id=CASE WHEN s.file_path=?2 THEN t.id ELSE s.id END "
        "WHERE e.project=?1 AND s.project=?1 AND t.project=?1 "
        "AND (s.file_path=?2 OR t.file_path=?2) "
        "AND e.type IN ('MENTIONS','REFERENCES_FILE','SUPERSEDES','DIAGRAM_ARROW') "
        "ORDER BY e.id LIMIT 501";
    if (sqlite3_prepare_v2(db, relations_sql, -1, &st, NULL) != SQLITE_OK)
        goto fail;
    sqlite3_bind_text(st, 1, project, -1, SQLITE_STATIC);
    sqlite3_bind_text(st, 2, file, -1, SQLITE_STATIC);
    count = 0;
    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
        if (++count > DOC_DETAIL_LIMIT) {
            docs_warning(&ctx, "Only the first 500 document relationships are shown.");
            break;
        }
        yyjson_mut_val *edge = yyjson_mut_obj(ctx.doc);
        yyjson_mut_obj_add_int(ctx.doc, edge, "id", sqlite3_column_int64(st, 0));
        yyjson_mut_obj_add_strcpy(ctx.doc, edge, "type", docs_text(st, 1));
        yyjson_mut_obj_add_strcpy(ctx.doc, edge, "direction", docs_text(st, 3));
        yyjson_mut_obj_add_val(ctx.doc, edge, "target",
                               docs_node_json(&ctx, st, 4, project, false));
        const char *raw = docs_text(st, 2);
        yyjson_doc *props = yyjson_read(raw, strlen(raw), 0);
        yyjson_val *p = props ? yyjson_doc_get_root(props) : NULL;
        if (yyjson_is_obj(p))
            yyjson_mut_obj_add_val(ctx.doc, edge, "properties", yyjson_val_mut_copy(ctx.doc, p));
        yyjson_mut_val *evidence = yyjson_mut_obj(ctx.doc);
        yyjson_mut_obj_add_strcpy(ctx.doc, evidence, "file_path", docs_text(st, 12));
        /* A section start is context, not the relationship's witness.
         * PDF extractors may record a text line within a page, so a "line"
         * property cannot be reinterpreted as a page number either. */
        const char *coordinate = docs_suffix(docs_text(st, 12), ".pdf") ? "page" : "line";
        yyjson_val *position = yyjson_obj_get(p, coordinate);
        int64_t location = strcmp(coordinate, "page") == 0 ? docs_page(position)
                           : yyjson_is_int(position)       ? yyjson_get_int(position)
                                                           : 0;
        bool source_context = false;
        if (strcmp(coordinate, "page") == 0 && (location <= 0 || location > INT_MAX)) {
            const char *source_raw = docs_text(st, 13);
            yyjson_doc *source_properties = yyjson_read(source_raw, strlen(source_raw), 0);
            yyjson_val *source_page =
                source_properties ? yyjson_obj_get(yyjson_doc_get_root(source_properties), "page")
                                  : NULL;
            location = docs_page(source_page);
            source_context = true;
            yyjson_doc_free(source_properties);
        }
        if (location > 0 && location <= INT_MAX) {
            yyjson_mut_obj_add_int(ctx.doc, evidence, coordinate, location);
            if (strcmp(coordinate, "page") == 0)
                yyjson_mut_obj_add_str(ctx.doc, evidence, "position_kind",
                                       source_context ? "source_context" : "relationship");
        }
        yyjson_mut_obj_add_val(ctx.doc, edge, "evidence", evidence);
        yyjson_doc_free(props);
        yyjson_mut_arr_add_val(relations, edge);
    }
    sqlite3_finalize(st);
    st = NULL;
    if (rc != SQLITE_DONE && count <= DOC_DETAIL_LIMIT)
        goto fail;
    yyjson_mut_obj_add_strcpy(ctx.doc, ctx.root, "content", text ? text : "");
    yyjson_mut_obj_add_str(ctx.doc, ctx.root, "source_mode", mode);
    yyjson_mut_obj_add_bool(ctx.doc, ctx.root, "source_stale", stale);
    yyjson_mut_obj_add_bool(ctx.doc, ctx.root, "source_truncated", truncated);
    cbm_free(CBM_MEM_CLASS_OTHER, text);
    cbm_free(CBM_MEM_CLASS_OTHER, file);
    return docs_end(&ctx, http_status, 200, NULL);
fail:
    sqlite3_finalize(st);
    cbm_free(CBM_MEM_CLASS_OTHER, text);
    cbm_free(CBM_MEM_CLASS_OTHER, file);
    return docs_end(&ctx, http_status, 503, "Document evidence could not be read completely.");
}
