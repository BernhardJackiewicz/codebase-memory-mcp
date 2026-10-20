#include "ui/flow_source.h"
#include "foundation/compat.h"
#include "foundation/compat_fs.h"
#include "foundation/json_writer.h"
#include "foundation/platform.h"
#include "foundation/sha256.h"
#include "foundation/workspace.h"
#include <sqlite3.h>
#include <yyjson/yyjson.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef _WIN32
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#define SOURCE_MAX_BYTES (4U * 1024U * 1024U)
#define SOURCE_MAX_LINES 200

static char *source_error(int *status, int code, const char *message) {
    *status = code;
    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    if (!doc)
        return NULL;
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);
    yyjson_mut_obj_add_str(doc, root, "error", message);
    char *json = yyjson_mut_write_opts(doc, 0, cbm_json_writer_allocator(), NULL, NULL);
    yyjson_mut_doc_free(doc);
    return json;
}

static bool source_string(const char *text, size_t limit) {
    return text && text[0] && strlen(text) <= limit;
}

static bool source_relative(const char *path) {
    if (path[0] == '/' || path[0] == '\\' || strchr(path, '\\'))
        return false;
    const char *component = path;
    while (*component) {
        const char *slash = strchr(component, '/');
        size_t length = slash ? (size_t)(slash - component) : strlen(component);
        if (!length || (length == 1 && component[0] == '.') ||
            (length == 2 && component[0] == '.' && component[1] == '.'))
            return false;
        if (!slash)
            break;
        component = slash + 1;
    }
    return true;
}

static bool source_expired(void *context) {
    return cbm_now_ms() >= *(uint64_t *)context;
}

/* Anchor every component beneath the resolved root on POSIX. A symlink swap
 * between canonicalization and opening cannot redirect this read elsewhere.
 * The Windows compatibility path is canonicalized through native handles. */
static FILE *source_open(const char *root, const char *path) {
#ifdef _WIN32
    (void)root;
    return cbm_fopen(path, "rb");
#else
    size_t root_length = strlen(root);
    const char *relative = path + root_length;
    while (*relative == '/')
        relative++;
    if (!*relative)
        return NULL;
    int directory = open(root, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (directory < 0)
        return NULL;
    char *parts = cbm_mem_strdup(CBM_MEM_CLASS_OTHER, relative);
    if (!parts) {
        close(directory);
        return NULL;
    }
    char *component = parts, *slash = NULL;
    while ((slash = strchr(component, '/')) != NULL) {
        *slash = '\0';
        int next = openat(directory, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        close(directory);
        directory = next;
        if (directory < 0)
            break;
        component = slash + 1;
    }
    int descriptor = directory >= 0 ? openat(directory, component,
                                             O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
                                    : -1;
    if (directory >= 0)
        close(directory);
    cbm_free(CBM_MEM_CLASS_OTHER, parts);
    if (descriptor < 0)
        return NULL;
    struct stat information;
    if (fstat(descriptor, &information) != 0 || !S_ISREG(information.st_mode)) {
        close(descriptor);
        return NULL;
    }
    FILE *input = fdopen(descriptor, "rb");
    if (!input)
        close(descriptor);
    return input;
#endif
}

char *cbm_source_evidence(cbm_store_t *store, const cbm_source_evidence_request_t *request,
                          int *http_status) {
    if (!http_status)
        return NULL;
    if (!store || !request || !source_string(request->project, 4096) ||
        !source_string(request->generation, 63) || !source_string(request->file_path, 4095) ||
        !source_string(request->source_hash, 128) || request->start_line < 0 ||
        request->end_line < 0 || request->start_line > INT_MAX - SOURCE_MAX_LINES ||
        (request->end_line && request->end_line < (request->start_line ? request->start_line : 1)))
        return source_error(http_status, 400, "Invalid source identity or line range.");
    if (!source_relative(request->file_path))
        return source_error(http_status, 403, "Source path is outside the project.");
    int status = 503;
    const char *error = "Source evidence could not be read.";
    cbm_store_read_scope_t *scope = NULL;
    cbm_project_t project = {0};
    cbm_file_hash_t stored_hash = {0};
    sqlite3_stmt *statement = NULL;
    char *source = NULL, *json = NULL;
    FILE *input = NULL;
    yyjson_mut_doc *doc = NULL;
    uint64_t deadline = cbm_now_ms() + 3000;
    if (cbm_store_read_scope_open(store, source_expired, &deadline, &scope) != CBM_STORE_OK)
        goto finish;
    char generation[64];
    if (cbm_store_generation(store, generation, sizeof(generation)) != CBM_STORE_OK)
        goto finish;
    if (strcmp(generation, request->generation) != 0) {
        status = 409;
        error = "The source reference belongs to a different index generation.";
        goto finish;
    }
    int rc = cbm_store_get_project(store, request->project, &project);
    if (rc != CBM_STORE_OK) {
        if (rc == CBM_STORE_NOT_FOUND) {
            status = 404;
            error = "The source project is unavailable.";
        }
        goto finish;
    }
    if (sqlite3_prepare_v2(cbm_store_get_db(store),
                           "SELECT 1 FROM nodes WHERE project=?1 AND file_path=?2 "
                           "AND label NOT IN ('Project','Folder') LIMIT 1",
                           -1, &statement, NULL) != SQLITE_OK)
        goto finish;
    sqlite3_bind_text(statement, 1, request->project, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(statement, 2, request->file_path, -1, SQLITE_TRANSIENT);
    rc = sqlite3_step(statement);
    sqlite3_finalize(statement);
    statement = NULL;
    bool package_verified = false;
    if (rc == SQLITE_DONE) {
        /* Explicitly selected installed sources have their own Flow partition,
         * not invented File nodes in the primary graph. Require a complete
         * stored package identity and the same ready source snapshot. */
        if (sqlite3_prepare_v2(
                cbm_store_get_db(store),
                "SELECT f.source_hash FROM cbm_flow_files f JOIN cbm_flow_packages p "
                "ON p.project=f.project AND p.file_path=f.file_path "
                "WHERE f.project=?1 AND f.file_path=?2 AND f.status='ready' "
                "AND p.package_id<>'' AND p.package_version<>'' AND p.manifest_hash<>''",
                -1, &statement, NULL) == SQLITE_OK) {
            sqlite3_bind_text(statement, 1, request->project, -1, SQLITE_TRANSIENT);
            sqlite3_bind_text(statement, 2, request->file_path, -1, SQLITE_TRANSIENT);
            if (sqlite3_step(statement) == SQLITE_ROW) {
                const char *hash = (const char *)sqlite3_column_text(statement, 0);
                package_verified = hash && !strcmp(hash, request->source_hash);
                if (!package_verified) {
                    status = 409;
                    error = "The package source differs from the indexed snapshot.";
                }
            }
        }
        sqlite3_finalize(statement);
        statement = NULL;
        if (!package_verified) {
            if (status != 409) {
                status = 404;
                error = "The file is not an indexed source in this project.";
            }
            goto finish;
        }
    } else if (rc != SQLITE_ROW) {
        goto finish;
    }
    if (!package_verified) {
        rc = cbm_store_get_file_hash(store, request->project, request->file_path, &stored_hash);
        if (rc != CBM_STORE_OK) {
            if (rc == CBM_STORE_NOT_FOUND) {
                status = 404;
                error = "The source snapshot has no verifiable content hash.";
            }
            goto finish;
        }
        if (!stored_hash.sha256 || strcmp(stored_hash.sha256, request->source_hash) != 0) {
            status = 409;
            error = "The requested source hash differs from the indexed snapshot.";
            goto finish;
        }
    }
    char path[4096], canonical[4096], canonical_root[4096];
    int length = snprintf(path, sizeof(path), "%s/%s", project.root_path, request->file_path);
    if (length < 0 || (size_t)length >= sizeof(path) ||
        !cbm_canonical_path(project.root_path, canonical_root, sizeof(canonical_root)) ||
        !cbm_canonical_path(path, canonical, sizeof(canonical))) {
        status = 404;
        error = "The indexed source file is unavailable.";
        goto finish;
    }
    if (!cbm_path_within_root(canonical_root, canonical)) {
        status = 403;
        error = "Source path resolves outside the project.";
        goto finish;
    }
    cbm_path_info_t info = {0};
    if (cbm_path_info_utf8(canonical, &info) != CBM_PATH_INFO_OK || !info.is_regular ||
        info.size < 0) {
        status = 404;
        error = "The source is not an available regular file.";
        goto finish;
    }
    if ((uint64_t)info.size > SOURCE_MAX_BYTES) {
        status = 413;
        error = "The source exceeds the 4 MiB verification budget.";
        goto finish;
    }
    input = source_open(canonical_root, canonical);
    if (!input) {
        status = 404;
        error = "The indexed source file could not be opened safely.";
        goto finish;
    }
    size_t capacity = (size_t)info.size + 1;
    source = cbm_alloc(CBM_MEM_CLASS_OTHER, capacity + 1);
    if (!source)
        goto finish;
    size_t bytes = fread(source, 1, capacity, input);
    bool read_ok = !ferror(input);
    if (fclose(input) != 0)
        read_ok = false;
    input = NULL;
    if (!read_ok || source_expired(&deadline))
        goto finish;
    source[bytes] = '\0';
    char actual_hash[65];
    cbm_sha256_hex(source, bytes, actual_hash);
    if (bytes != (size_t)info.size || strcmp(actual_hash, request->source_hash) != 0) {
        status = 409;
        error = "The local source changed after this evidence was indexed.";
        goto finish;
    }
    if (memchr(source, '\0', bytes)) {
        status = 404;
        error = "Binary source cannot be displayed as code text.";
        goto finish;
    }
    int first = request->start_line ? request->start_line : 1;
    int requested_last = request->end_line ? request->end_line : first + SOURCE_MAX_LINES - 1;
    int last = requested_last < first + SOURCE_MAX_LINES - 1 ? requested_last
                                                             : first + SOURCE_MAX_LINES - 1;
    size_t begin = 0;
    int current = 1;
    while (current < first && begin < bytes) {
        if (source[begin++] == '\n')
            current++;
    }
    if (current != first || (begin == bytes && first > 1)) {
        status = 400;
        error = "The requested start line is beyond the verified source.";
        goto finish;
    }
    size_t finish_offset = begin;
    int actual_last = first;
    while (finish_offset < bytes) {
        if (source[finish_offset++] == '\n') {
            actual_last = current;
            if (current++ == last)
                break;
        } else {
            actual_last = current;
        }
    }
    bool complete = requested_last <= last || finish_offset == bytes;
    doc = yyjson_mut_doc_new(NULL);
    if (!doc)
        goto finish;
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);
    yyjson_mut_obj_add_int(doc, root, "schema_version", 1);
    yyjson_mut_obj_add_strcpy(doc, root, "project", request->project);
    yyjson_mut_obj_add_strcpy(doc, root, "generation", generation);
    yyjson_mut_obj_add_strcpy(doc, root, "file_path", request->file_path);
    yyjson_mut_obj_add_strcpy(doc, root, "source_hash", request->source_hash);
    yyjson_mut_obj_add_strncpy(doc, root, "content", source + begin, finish_offset - begin);
    yyjson_mut_obj_add_int(doc, root, "start_line", first);
    yyjson_mut_obj_add_int(doc, root, "end_line", actual_last);
    yyjson_mut_obj_add_bool(doc, root, "complete", complete);
    json = yyjson_mut_write_opts(doc, 0, cbm_json_writer_allocator(), NULL, NULL);
    if (json)
        status = 200;
finish:
    if (input)
        fclose(input);
    sqlite3_finalize(statement);
    cbm_free(CBM_MEM_CLASS_OTHER, source);
    yyjson_mut_doc_free(doc);
    cbm_store_clear_file_hash(&stored_hash);
    cbm_project_free_fields(&project);
    if (cbm_store_read_scope_close(scope) != CBM_STORE_OK) {
        status = 503;
        error = "The source snapshot could not remain stable.";
    }
    if (status != 200) {
        cbm_free(CBM_MEM_CLASS_OTHER, json);
        return source_error(http_status, status, error);
    }
    *http_status = 200;
    return json;
}
