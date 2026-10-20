#include "test_framework.h"
#include "test_helpers.h"
#include "ui/documents.h"
#include "pipeline/pipeline.h"
#include "store/system_graph.h"
#include "foundation/compat.h"
#include "foundation/mem_core.h"
#include "foundation/sha256.h"
#include <sqlite3.h>
#include <yyjson/yyjson.h>
#include <unistd.h>

static int64_t docs_node(cbm_store_t *s, const char *project, const char *label, const char *name,
                         const char *file, const char *properties) {
    char qn[512];
    snprintf(qn, sizeof(qn), "%s.%s.%s", project, file, name);
    cbm_node_t node = {.project = project,
                       .label = label,
                       .name = name,
                       .qualified_name = qn,
                       .file_path = file,
                       .start_line = 2,
                       .end_line = 3,
                       .properties_json = properties};
    return cbm_store_upsert_node(s, &node);
}

static yyjson_doc *docs_parse(char *json) {
    yyjson_doc *doc = json ? yyjson_read(json, strlen(json), 0) : NULL;
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    return doc;
}

TEST(documents_catalog_scopes_filters_and_deduplicates_files) {
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, "docs", "/tmp");
    docs_node(s, "docs", "File", "README.md", "README.md", "{}");
    docs_node(s, "docs", "Section", "Intro", "README.md", "{}");
    docs_node(s, "docs", "File", "diagram.drawio", "diagram.drawio", "{}");
    docs_node(s, "docs", "File", "server.ts", "server.ts", "{}");
    docs_node(s, "other", "File", "secret.md", "secret.md", "{}");
    int status = 0;
    yyjson_doc *doc = docs_parse(cbm_documents_list(s, "docs", "all", "", "", &status));
    cbm_store_close(s);
    ASSERT_EQ(status, 200);
    ASSERT_NOT_NULL(doc);
    yyjson_val *rows = yyjson_obj_get(yyjson_doc_get_root(doc), "documents");
    ASSERT_EQ(yyjson_arr_size(rows), 2);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(yyjson_arr_get(rows, 0), "kind")), "markdown");
    yyjson_doc_free(doc);
    PASS();
}

TEST(documents_detail_includes_section_edges_and_rejects_wrong_generation) {
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, "docs", "/tmp");
    int64_t file = docs_node(s, "docs", "File", "README.md", "README.md", "{}");
    int64_t section =
        docs_node(s, "docs", "Section", "Users", "README.md", "{\"docstring\":\"User service\"}");
    int64_t code = docs_node(s, "docs", "Function", "loadUsers", "service.ts", "{}");
    cbm_edge_t edge = {.project = "docs",
                       .source_id = section,
                       .target_id = code,
                       .type = "MENTIONS",
                       .properties_json = "{\"line\":3,\"via\":\"markdown\"}"};
    cbm_store_insert_edge(s, &edge);
    char generation[128];
    cbm_store_generation(s, generation, sizeof(generation));
    int status = 0;
    yyjson_doc *doc = docs_parse(cbm_documents_detail(s, "docs", file, NULL, generation, &status));
    ASSERT_EQ(status, 200);
    ASSERT_NOT_NULL(doc);
    yyjson_val *root = yyjson_doc_get_root(doc);
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(root, "sections")), 1);
    yyjson_val *rels = yyjson_obj_get(root, "relationships");
    ASSERT_EQ(yyjson_arr_size(rels), 1);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(yyjson_arr_get(rels, 0), "type")), "MENTIONS");
    yyjson_doc_free(doc);
    doc = docs_parse(cbm_documents_detail(s, "docs", file, NULL, "old-generation", &status));
    ASSERT_EQ(status, 409);
    yyjson_doc_free(doc);
    doc = docs_parse(cbm_documents_detail(s, "other", file, NULL, generation, &status));
    ASSERT_EQ(status, 404);
    yyjson_doc_free(doc);
    cbm_store_close(s);
    PASS();
}

TEST(documents_pdf_uses_page_text_never_binary_source) {
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, "docs", "/tmp");
    int64_t file = docs_node(s, "docs", "File", "Architecture.pdf", "Architecture.pdf", "{}");
    docs_node(s, "docs", "Section", "page 2", "Architecture.pdf",
              "{\"docstring\":\"User data goes to PostgreSQL.\",\"page\":2}");
    int status = 0;
    yyjson_doc *doc = docs_parse(cbm_documents_detail(s, "docs", file, NULL, NULL, &status));
    cbm_store_close(s);
    ASSERT_EQ(status, 200);
    ASSERT_NOT_NULL(doc);
    yyjson_val *root = yyjson_doc_get_root(doc);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(root, "source_mode")), "extracted");
    ASSERT_NOT_NULL(strstr(yyjson_get_str(yyjson_obj_get(root, "content")), "PostgreSQL"));
    yyjson_val *pages = yyjson_obj_get(root, "pages");
    ASSERT_EQ(yyjson_arr_size(pages), 1);
    ASSERT_EQ(yyjson_get_int(yyjson_obj_get(yyjson_arr_get(pages, 0), "page")), 2);
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(yyjson_arr_get(pages, 0), "text")),
                  "User data goes to PostgreSQL.");
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(yyjson_obj_get(root, "document"), "location_kind")),
                  "pages");
    yyjson_doc_free(doc);
    PASS();
}

TEST(documents_relationship_positions_require_recorded_edge_coordinates) {
    const char *properties[] = {"{}",
                                "{\"line\":0}",
                                "{\"line\":-1}",
                                "{\"line\":\"3\"}",
                                "{\"line\":2.5}",
                                "{\"line\":3}",
                                "{\"line\":3}",
                                "{\"page\":7,\"line\":3}"};
    for (int i = 0; i < 8; i++) {
        bool pdf = i >= 6;
        const char *path = pdf ? "guide.pdf" : "guide.md";
        cbm_store_t *s = cbm_store_open_memory();
        cbm_store_upsert_project(s, "docs", "/tmp");
        int64_t file = docs_node(s, "docs", "File", path, path, "{}");
        int64_t section = docs_node(s, "docs", "Section", "Topic", path, "{}");
        int64_t code = docs_node(s, "docs", "Function", "loadUsers", "service.ts", "{}");
        cbm_edge_t edge = {.project = "docs",
                           .source_id = section,
                           .target_id = code,
                           .type = "MENTIONS",
                           .properties_json = properties[i]};
        cbm_store_insert_edge(s, &edge);
        int status = 0;
        yyjson_doc *doc = docs_parse(cbm_documents_detail(s, "docs", file, NULL, NULL, &status));
        ASSERT_EQ(status, 200);
        yyjson_val *relationship =
            yyjson_arr_get(yyjson_obj_get(yyjson_doc_get_root(doc), "relationships"), 0);
        yyjson_val *evidence = yyjson_obj_get(relationship, "evidence");
        ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(evidence, "file_path")), path);
        if (i == 5) {
            ASSERT_EQ(yyjson_get_int(yyjson_obj_get(evidence, "line")), 3);
        } else {
            ASSERT_NULL(yyjson_obj_get(evidence, "line"));
        }
        if (i == 7) {
            ASSERT_EQ(yyjson_get_int(yyjson_obj_get(evidence, "page")), 7);
        } else {
            ASSERT_NULL(yyjson_obj_get(evidence, "page"));
        }
        yyjson_doc_free(doc);
        cbm_store_close(s);
    }
    PASS();
}

TEST(documents_pdf_prefers_edge_page_and_labels_section_context) {
    for (int explicit_page = 0; explicit_page < 2; explicit_page++) {
        cbm_store_t *s = cbm_store_open_memory();
        cbm_store_upsert_project(s, "docs", "/tmp");
        int64_t file = docs_node(s, "docs", "File", "guide.pdf", "guide.pdf", "{}");
        int64_t section = docs_node(s, "docs", "Section", "Page 2", "guide.pdf", "{\"page\":2}");
        int64_t code = docs_node(s, "docs", "Function", "loadUsers", "service.ts", "{}");
        cbm_edge_t edge = {.project = "docs",
                           .source_id = section,
                           .target_id = code,
                           .type = "MENTIONS",
                           .properties_json = explicit_page ? "{\"page\":7}" : "{}"};
        cbm_store_insert_edge(s, &edge);
        int status = 0;
        yyjson_doc *doc = docs_parse(cbm_documents_detail(s, "docs", file, NULL, NULL, &status));
        ASSERT_EQ(status, 200);
        yyjson_val *relationship =
            yyjson_arr_get(yyjson_obj_get(yyjson_doc_get_root(doc), "relationships"), 0);
        yyjson_val *evidence = yyjson_obj_get(relationship, "evidence");
        ASSERT_EQ(yyjson_get_int(yyjson_obj_get(evidence, "page")), explicit_page ? 7 : 2);
        ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(evidence, "position_kind")),
                      explicit_page ? "relationship" : "source_context");
        yyjson_doc_free(doc);
        cbm_store_close(s);
    }
    PASS();
}

TEST(documents_pdf_page_coordinates_accept_only_positive_canonical_integers) {
    const char *values[] = {"\"2\"",
                            "\"2147483647\"",
                            "\"02\"",
                            "\"0\"",
                            "\"-2\"",
                            "\"+2\"",
                            "\" 2\"",
                            "\"2 \"",
                            "\"2.0\"",
                            "\"2e0\"",
                            "\"2x\"",
                            "\"2\\u0000x\"",
                            "\"2147483648\"",
                            "2",
                            "0",
                            "-1",
                            "2.0",
                            "true",
                            "null",
                            "18446744073709551615"};
    for (size_t i = 0; i < sizeof(values) / sizeof(values[0]); i++) {
        int expected = i == 1 ? 2147483647 : (i == 0 || i == 13) ? 2 : 0;
        for (int on_edge = 0; on_edge < 2; on_edge++) {
            cbm_store_t *s = cbm_store_open_memory();
            cbm_store_upsert_project(s, "docs", "/tmp");
            int64_t file = docs_node(s, "docs", "File", "guide.pdf", "guide.pdf", "{}");
            char properties[256];
            snprintf(properties, sizeof(properties), "{\"docstring\":\"body\",\"page\":%s}",
                     values[i]);
            int64_t section =
                docs_node(s, "docs", "Section", "page", "guide.pdf",
                          on_edge ? "{\"page\":8,\"docstring\":\"body\"}" : properties);
            int64_t code = docs_node(s, "docs", "Function", "target", "app.py", "{}");
            cbm_edge_t edge = {.project = "docs",
                               .source_id = section,
                               .target_id = code,
                               .type = "MENTIONS",
                               .properties_json = on_edge ? properties : "{\"line\":3}"};
            cbm_store_insert_edge(s, &edge);
            int status = 0;
            yyjson_doc *doc =
                docs_parse(cbm_documents_detail(s, "docs", file, NULL, NULL, &status));
            ASSERT_EQ(status, 200);
            yyjson_val *root = yyjson_doc_get_root(doc);
            yyjson_val *pages = yyjson_obj_get(root, "pages");
            ASSERT_EQ(yyjson_arr_size(pages), on_edge || expected ? 1 : 0);
            if (!on_edge && !expected)
                ASSERT_NULL(strstr(yyjson_get_str(yyjson_obj_get(root, "content")), "## Page"));
            if (!on_edge && expected)
                ASSERT_EQ(yyjson_get_int(yyjson_obj_get(yyjson_arr_get(pages, 0), "page")),
                          expected);
            yyjson_val *evidence = yyjson_obj_get(
                yyjson_arr_get(yyjson_obj_get(root, "relationships"), 0), "evidence");
            int actual_expected = on_edge && !expected ? 8 : expected;
            ASSERT_EQ(yyjson_get_int(yyjson_obj_get(evidence, "page")), actual_expected);
            ASSERT_NULL(yyjson_obj_get(evidence, "line"));
            if (actual_expected)
                ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(evidence, "position_kind")),
                              on_edge && expected ? "relationship" : "source_context");
            yyjson_doc_free(doc);
            cbm_store_close(s);
        }
    }
    PASS();
}

/* An actual two-page PDF, not manually inserted numeric graph properties.
 * Compute xref offsets so the production PDF extractor and graph writer both
 * participate in the regression. The second page names a real indexed file. */
static bool docs_write_pdf(const char *path) {
    const char *objects[] = {
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> "
        ">> /Contents 5 0 R >>",
        "BT /F1 12 Tf 72 740 Td (First page.) Tj ET\n",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> "
        ">> /Contents 7 0 R >>",
        "BT /F1 12 Tf 72 740 Td (See app.py.) Tj ET\n",
    };
    FILE *file = fopen(path, "wb");
    if (!file)
        return false;
    long offsets[8] = {0};
    fputs("%PDF-1.7\n", file);
    for (int i = 0; i < 7; i++) {
        offsets[i + 1] = ftell(file);
        fprintf(file, "%d 0 obj\n", i + 1);
        if (i == 4 || i == 6)
            fprintf(file, "<< /Length %zu >>\nstream\n%sendstream\n", strlen(objects[i]),
                    objects[i]);
        else
            fprintf(file, "%s\n", objects[i]);
        fputs("endobj\n", file);
    }
    long xref = ftell(file);
    fputs("xref\n0 8\n0000000000 65535 f \n", file);
    for (int i = 1; i < 8; i++)
        fprintf(file, "%010ld 00000 n \n", offsets[i]);
    fprintf(file, "trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n%ld\n%%%%EOF\n", xref);
    bool ok = !ferror(file);
    return fclose(file) == 0 && ok;
}

static bool docs_real_pdf_case(void) {
    const char *temporary = th_mktempdir("cbm_docs_pdf");
    char *root = temporary ? strdup(temporary) : NULL;
    temporary = th_mktempdir("cbm_docs_pdf_db");
    char *database_root = temporary ? strdup(temporary) : NULL;
    cbm_pipeline_t *pipeline = NULL;
    cbm_store_t *store = NULL;
    yyjson_doc *detail = NULL, *graph = NULL;
    sqlite3_stmt *statement = NULL;
    char *graph_json = NULL;
    bool ok = false;
    const char *stage = "fixture creation";
    if (!root || !database_root || !docs_write_pdf(TH_PATH(root, "guide.pdf")) ||
        th_write_file(TH_PATH(root, "app.py"), "def target(value):\n    return value\n"))
        goto finish;
    char database[1024];
    snprintf(database, sizeof(database), "%s/index.db", database_root);
    /* Fast discovery intentionally excludes PDF documents. Exercise the same
     * full-index route used for repository documentation in the product. */
    stage = "full PDF indexing";
    pipeline = cbm_pipeline_new(root, database, CBM_MODE_FULL);
    if (!pipeline || !cbm_pipeline_set_project_name(pipeline, "docs-real-pdf") ||
        cbm_pipeline_run(pipeline))
        goto finish;
    cbm_pipeline_free(pipeline);
    pipeline = NULL;
    stage = "persisted extractor page strings";
    store = cbm_store_open_path_query(database);
    if (!store ||
        sqlite3_prepare_v2(
            cbm_store_get_db(store),
            "SELECT count(*) FROM nodes WHERE file_path='guide.pdf' AND label='Section' "
            "AND json_type(properties,'$.page')='text'",
            -1, &statement, NULL) != SQLITE_OK ||
        sqlite3_step(statement) != SQLITE_ROW || sqlite3_column_int(statement, 0) != 2)
        goto finish;
    sqlite3_finalize(statement);
    statement = NULL;
    int status = 0;
    stage = "Docs structured pages";
    detail =
        docs_parse(cbm_documents_detail(store, "docs-real-pdf", 0, "guide.pdf", NULL, &status));
    yyjson_val *document = detail ? yyjson_doc_get_root(detail) : NULL;
    yyjson_val *pages = yyjson_obj_get(document, "pages");
    if (status != 200 || yyjson_arr_size(pages) != 2 ||
        yyjson_get_int(yyjson_obj_get(yyjson_arr_get(pages, 0), "page")) != 1 ||
        yyjson_get_int(yyjson_obj_get(yyjson_arr_get(pages, 1), "page")) != 2)
        goto finish;
    const char *body = yyjson_get_str(yyjson_obj_get(yyjson_arr_get(pages, 1), "text"));
    stage = "Docs second page text";
    if (!body || !strstr(body, "app.py"))
        goto finish;
    bool docs_witness = false, graph_witness = false, graph_entity = false;
    stage = "Docs actual PDF relationship";
    size_t i, count;
    yyjson_val *value;
    yyjson_arr_foreach(yyjson_obj_get(document, "relationships"), i, count, value) {
        yyjson_val *evidence = yyjson_obj_get(value, "evidence");
        if (yyjson_equals_str(yyjson_obj_get(value, "type"), "MENTIONS") &&
            yyjson_get_int(yyjson_obj_get(evidence, "page")) == 2 &&
            yyjson_equals_str(yyjson_obj_get(evidence, "position_kind"), "source_context") &&
            !yyjson_obj_get(evidence, "line"))
            docs_witness = true;
    }
    if (!docs_witness)
        goto finish;
    stage = "System Graph response";
    if (cbm_store_system_graph(store, "docs-real-pdf", NULL, &graph_json) != CBM_STORE_OK)
        goto finish;
    graph = yyjson_read(graph_json, strlen(graph_json), 0);
    yyjson_val *graph_root = graph ? yyjson_doc_get_root(graph) : NULL;
    yyjson_arr_foreach(
        yyjson_obj_get(graph_root, "entities"), i, count,
        value) if (yyjson_equals_str(yyjson_obj_get(value, "file_path"), "guide.pdf") &&
                   yyjson_equals_str(yyjson_obj_get(value, "name"), "page 2") &&
                   yyjson_get_int(yyjson_obj_get(yyjson_obj_get(value, "properties"), "page")) == 2)
        graph_entity = true;
    yyjson_arr_foreach(yyjson_obj_get(graph_root, "relations"), i, count, value) {
        if (!yyjson_equals_str(yyjson_obj_get(value, "type"), "MENTIONS"))
            continue;
        size_t j, length;
        yyjson_val *witness;
        yyjson_arr_foreach(yyjson_obj_get(value, "witnesses"), j, length, witness) {
            yyjson_val *location = yyjson_obj_get(witness, "location");
            if (yyjson_get_int(yyjson_obj_get(location, "page")) == 2 &&
                yyjson_equals_str(yyjson_obj_get(location, "position_kind"), "source_context") &&
                !yyjson_obj_get(location, "line"))
                graph_witness = true;
        }
    }
    ok = graph_entity && graph_witness;
    stage = graph_entity ? "System Graph actual PDF witness" : "System Graph numeric PDF page";
finish:
    if (!ok)
        fprintf(stderr, "real PDF integration failed at: %s\n", stage);
    sqlite3_finalize(statement);
    cbm_pipeline_free(pipeline);
    cbm_store_close(store);
    yyjson_doc_free(detail);
    yyjson_doc_free(graph);
    cbm_free(CBM_MEM_CLASS_OTHER, graph_json);
    if (root) {
        th_cleanup(root);
        free(root);
    }
    if (database_root) {
        th_cleanup(database_root);
        free(database_root);
    }
    return ok;
}

TEST(documents_real_pdf_index_normalizes_pages_for_docs_and_system_graph) {
    ASSERT_TRUE(docs_real_pdf_case());
    PASS();
}

TEST(documents_reads_only_indexed_sources_and_reports_stale_text) {
    char directory[] = "/tmp/cbm_documents_XXXXXX";
    ASSERT_NOT_NULL(cbm_mkdtemp(directory));
    char path[512];
    snprintf(path, sizeof(path), "%s/README.md", directory);
    FILE *f = fopen(path, "wb");
    ASSERT_NOT_NULL(f);
    fputs("# Changed content\n", f);
    fclose(f);
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, "docs", directory);
    int64_t file = docs_node(s, "docs", "File", "README.md", "README.md", "{}");
    char hash[65];
    cbm_sha256_hex("old", 3, hash);
    cbm_store_upsert_file_hash(s, "docs", "README.md", hash, 0, 3);
    int status = 0;
    yyjson_doc *doc = docs_parse(cbm_documents_detail(s, "docs", file, NULL, NULL, &status));
    ASSERT_EQ(status, 200);
    ASSERT_TRUE(yyjson_get_bool(yyjson_obj_get(yyjson_doc_get_root(doc), "source_stale")));
    ASSERT_STR_EQ(yyjson_get_str(yyjson_obj_get(yyjson_doc_get_root(doc), "content")),
                  "# Changed content\n");
    yyjson_doc_free(doc);
    doc = docs_parse(cbm_documents_detail(s, "docs", 0, "../outside.md", NULL, &status));
    ASSERT_EQ(status, 404);
    yyjson_doc_free(doc);
    cbm_store_close(s);
    remove(path);
    rmdir(directory);
    PASS();
}

TEST(documents_catalog_pagination_is_bound_to_index_generation) {
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, "docs", "/tmp");
    for (int i = 0; i < 102; i++) {
        char file[32];
        snprintf(file, sizeof(file), "doc-%03d.md", i);
        docs_node(s, "docs", "File", file, file, "{}");
    }
    int status = 0;
    yyjson_doc *doc = docs_parse(cbm_documents_list(s, "docs", "all", "", NULL, &status));
    ASSERT_EQ(status, 200);
    yyjson_val *root = yyjson_doc_get_root(doc);
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(root, "documents")), 100);
    const char *next = yyjson_get_str(yyjson_obj_get(root, "next_cursor"));
    ASSERT_NOT_NULL(next);
    char *cursor = strdup(next);
    yyjson_doc_free(doc);
    doc = docs_parse(cbm_documents_list(s, "docs", "all", "", cursor, &status));
    ASSERT_EQ(status, 200);
    ASSERT_EQ(yyjson_arr_size(yyjson_obj_get(yyjson_doc_get_root(doc), "documents")), 2);
    yyjson_doc_free(doc);
    cbm_store_generation_advance(s);
    doc = docs_parse(cbm_documents_list(s, "docs", "all", "", cursor, &status));
    ASSERT_EQ(status, 409);
    yyjson_doc_free(doc);
    free(cursor);
    cbm_store_close(s);
    PASS();
}

SUITE(documents) {
    RUN_TEST(documents_catalog_scopes_filters_and_deduplicates_files);
    RUN_TEST(documents_detail_includes_section_edges_and_rejects_wrong_generation);
    RUN_TEST(documents_pdf_uses_page_text_never_binary_source);
    RUN_TEST(documents_relationship_positions_require_recorded_edge_coordinates);
    RUN_TEST(documents_pdf_prefers_edge_page_and_labels_section_context);
    RUN_TEST(documents_pdf_page_coordinates_accept_only_positive_canonical_integers);
    RUN_TEST(documents_real_pdf_index_normalizes_pages_for_docs_and_system_graph);
    RUN_TEST(documents_reads_only_indexed_sources_and_reports_stale_text);
    RUN_TEST(documents_catalog_pagination_is_bound_to_index_generation);
}
