#include "pipeline/flow_dependencies.h"
#include "foundation/mem_core.h"
#include "flow_extract.h"
#include <sqlite3.h>
#include "lang_specs.h"
#include "discover/discover.h"
#include "foundation/compat_fs.h"
#include "foundation/platform.h"
#include "foundation/sha256.h"
#include <yyjson/yyjson.h>
#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef _WIN32
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

enum {
    DEP_PACKAGES = 16,
    DEP_FILES = 512,
    DEP_GAPS = 256,
    DEP_ENTRIES = 8192,
    DEP_DEPTH = 32,
    DEP_FILE_BYTES = 4 * 1024 * 1024,
    DEP_TOTAL_BYTES = 32 * 1024 * 1024,
    DEP_MANIFEST_BYTES = 256 * 1024
};
typedef struct {
    cbm_flow_dependency_snapshot_t *snapshot;
    cbm_flow_dependency_source_t *sources;
    cbm_flow_dependency_gap_t *gaps;
    const char *root, *package, *version, *manifest_hash;
    size_t bytes, entries;
    bool failed, limit_reported;
    uint64_t deadline;
    cbm_sha256_ctx *digest;
} dependency_context;
static bool pkg_unique_object(yyjson_val *object);

static const char *dep_copy(dependency_context *c, const char *value) {
    const char *copy = cbm_arena_strdup(&c->snapshot->arena, value ? value : "");
    if (!copy)
        c->failed = true;
    return copy ? copy : "";
}
static void dep_gap(dependency_context *c, const char *path, const char *code,
                    const char *message) {
    if (c->snapshot->gap_count >= DEP_GAPS) {
        c->snapshot->limited = true;
        return;
    }
    c->gaps[c->snapshot->gap_count++] =
        (cbm_flow_dependency_gap_t){.package_id = dep_copy(c, c->package),
                                    .file_path = dep_copy(c, path),
                                    .code = dep_copy(c, code),
                                    .message = dep_copy(c, message)};
}
static bool dep_budget(dependency_context *c, const char *path) {
    if (c->failed)
        return false;
    if (c->entries >= DEP_ENTRIES || c->bytes >= DEP_TOTAL_BYTES ||
        c->snapshot->source_count >= DEP_FILES || cbm_now_ms() >= c->deadline) {
        c->snapshot->limited = true;
        if (!c->limit_reported) {
            c->limit_reported = true;
            dep_gap(c, path, "dependency_limit",
                    "Local dependency analysis reached its bounded file, byte, directory-entry or "
                    "elapsed-time limit.");
        }
        return false;
    }
    return true;
}
static bool dep_name(const char *name) {
    if (!name || !name[0] || strlen(name) > 214 || name[0] == '.' || strchr(name, '\\'))
        return false;
    int slashes = 0;
    for (const unsigned char *p = (const unsigned char *)name; *p; p++) {
        if (*p == '/') {
            slashes++;
            if (p == (const unsigned char *)name || !p[1] || p[1] == '.')
                return false;
        } else if (!(isalnum(*p) || *p == '-' || *p == '_' || *p == '.' ||
                     (*p == '@' && p == (const unsigned char *)name)))
            return false;
    }
    return name[0] == '@' ? slashes == 1 && name[1] != '/' : slashes == 0;
}
static void dep_hash_part(cbm_sha256_ctx *hash, const char *part) {
    size_t length = strlen(part ? part : "");
    char size[32];
    int count = snprintf(size, sizeof(size), "%zu:", length);
    cbm_sha256_update(hash, size, (size_t)count);
    cbm_sha256_update(hash, part ? part : "", length);
}
static int dep_string_compare(const void *a, const void *b) {
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}
static int dep_source_compare(const void *a, const void *b) {
    return strcmp(((const cbm_flow_dependency_source_t *)a)->file_path,
                  ((const cbm_flow_dependency_source_t *)b)->file_path);
}

#ifndef _WIN32
/* Every path component is opened relative to the root descriptor. Symlinks
 * cannot redirect either directory enumeration or content reads after a check. */
static int dep_open(const char *root, const char *relative, bool directory) {
    int current = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (current < 0)
        return -1;
    char parts[4096];
    if (!relative || strlen(relative) >= sizeof(parts)) {
        close(current);
        return -1;
    }
    memcpy(parts, relative, strlen(relative) + 1);
    char *component = parts;
    for (;;) {
        char *slash = strchr(component, '/');
        if (slash)
            *slash = 0;
        if (!component[0] || strcmp(component, ".") == 0 || strcmp(component, "..") == 0) {
            close(current);
            return -1;
        }
        int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
        if (slash || directory)
            flags |= O_DIRECTORY;
        int next = openat(current, component, flags);
        close(current);
        if (next < 0)
            return -1;
        current = next;
        if (!slash)
            break;
        component = slash + 1;
    }
    struct stat info;
    if (fstat(current, &info) != 0 ||
        (directory ? !S_ISDIR(info.st_mode) : !S_ISREG(info.st_mode))) {
        close(current);
        return -1;
    }
    return current;
}
#endif

static char *dep_read(dependency_context *c, const char *path, size_t limit, size_t *length) {
    *length = 0;
#ifdef _WIN32
    (void)c;
    (void)path;
    (void)limit;
    return NULL; /* Explicit coverage gap until a handle-anchored reader exists. */
#else
    int fd = dep_open(c->root, path, false);
    if (fd < 0)
        return NULL;
    struct stat info;
    if (fstat(fd, &info) != 0 || info.st_size < 0 || (uint64_t)info.st_size > limit) {
        close(fd);
        return NULL;
    }
    size_t expected = (size_t)info.st_size;
    char *bytes = cbm_alloc(CBM_MEM_CLASS_OTHER, expected + 2);
    if (!bytes) {
        close(fd);
        c->failed = true;
        return NULL;
    }
    size_t total = 0;
    while (total <= expected) {
        ssize_t got = read(fd, bytes + total, expected + 1 - total);
        if (got < 0) {
            cbm_free(CBM_MEM_CLASS_OTHER, bytes);
            close(fd);
            return NULL;
        }
        if (!got)
            break;
        total += (size_t)got;
    }
    close(fd);
    if (total != expected || memchr(bytes, 0, total)) {
        cbm_free(CBM_MEM_CLASS_OTHER, bytes);
        return NULL;
    }
    bytes[total] = 0;
    *length = total;
    return bytes;
#endif
}
#ifndef _WIN32
static void dep_source(dependency_context *c, const char *path, CBMLanguage language) {
    if (!dep_budget(c, path))
        return;
    size_t length = 0;
    size_t limit = DEP_TOTAL_BYTES - c->bytes;
    if (limit > DEP_FILE_BYTES)
        limit = DEP_FILE_BYTES;
    char *source = dep_read(c, path, limit, &length);
    if (!source) {
        dep_gap(c, path, "dependency_source",
                "The dependency source is unavailable, binary, changed during reading or exceeds "
                "the per-file byte budget.");
        return;
    }
    char hash[65];
    cbm_sha256_hex(source, length, hash);
    char *owned = cbm_arena_strndup(&c->snapshot->arena, source, length);
    cbm_free(CBM_MEM_CLASS_OTHER, source);
    if (!owned) {
        c->failed = true;
        return;
    }
    c->sources[c->snapshot->source_count++] =
        (cbm_flow_dependency_source_t){.file_path = dep_copy(c, path),
                                       .source = owned,
                                       .source_length = length,
                                       .source_hash = dep_copy(c, hash),
                                       .package_id = c->package,
                                       .package_version = c->version,
                                       .package_manifest_hash = c->manifest_hash,
                                       .language = language};
    c->bytes += length;
}
#endif
static void dep_walk(dependency_context *c, const char *path, int depth) {
    if (!dep_budget(c, path))
        return;
    if (depth > DEP_DEPTH) {
        c->snapshot->limited = true;
        dep_gap(c, path, "dependency_limit",
                "The installed package exceeds the directory-depth limit.");
        return;
    }
#ifdef _WIN32
    (void)depth;
    dep_gap(c, path, "dependency_platform",
            "Local dependency reads require an anchored filesystem reader on this platform.");
#else
    int fd = dep_open(c->root, path, true);
    if (fd < 0) {
        dep_gap(c, path, "dependency_boundary",
                "The dependency directory cannot be opened inside its package boundary without "
                "following symlinks.");
        return;
    }
    DIR *directory = fdopendir(fd);
    if (!directory) {
        close(fd);
        dep_gap(c, path, "dependency_source", "The dependency directory cannot be enumerated.");
        return;
    }
    char **names = cbm_calloc(CBM_MEM_CLASS_OTHER, DEP_ENTRIES * sizeof(*names));
    if (!names) {
        c->failed = true;
        closedir(directory);
        return;
    }
    size_t count = 0;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
            continue;
        if (c->entries >= DEP_ENTRIES)
            break;
        c->entries++;
        names[count] = cbm_mem_strdup(CBM_MEM_CLASS_OTHER, entry->d_name);
        if (!names[count]) {
            c->failed = true;
            break;
        }
        count++;
    }
    qsort(names, count, sizeof(*names), dep_string_compare);
    for (size_t i = 0; i < count && dep_budget(c, path); i++) {
        char child[4096];
        int path_length = snprintf(child, sizeof(child), "%s/%s", path, names[i]);
        if (path_length < 0 || (size_t)path_length >= sizeof(child)) {
            dep_gap(c, path, "dependency_limit",
                    "An installed package path exceeds the source identity length limit.");
            continue;
        }
        struct stat info;
        if (fstatat(dirfd(directory), names[i], &info, AT_SYMLINK_NOFOLLOW) != 0) {
            dep_gap(c, child, "dependency_source",
                    "The installed entry changed during directory enumeration.");
            continue;
        }
        if (S_ISLNK(info.st_mode)) {
            dep_gap(c, child, "dependency_boundary",
                    "Symlinked dependency entries are excluded from local package analysis.");
            continue;
        }
        if (S_ISDIR(info.st_mode)) {
            if (strcmp(names[i], "node_modules") == 0 || strcmp(names[i], ".git") == 0) {
                dep_gap(c, child, "dependency_boundary",
                        "Nested packages and repository internals require their own explicit "
                        "allowlist entry.");
                continue;
            }
            dep_walk(c, child, depth + 1);
        } else if (S_ISREG(info.st_mode) && !strcmp(names[i], "package.json")) {
            /* Nested package scopes affect .js interpretation even though
             * package manifests are not executable Flow source files. */
            size_t length = 0;
            size_t limit = DEP_TOTAL_BYTES - c->bytes;
            if (limit > DEP_MANIFEST_BYTES)
                limit = DEP_MANIFEST_BYTES;
            char *bytes = dep_read(c, child, limit, &length);
            dep_hash_part(c->digest, child);
            if (bytes) {
                char hash[65];
                cbm_sha256_hex(bytes, length, hash);
                dep_hash_part(c->digest, hash);
                c->bytes += length;
                cbm_free(CBM_MEM_CLASS_OTHER, bytes);
            } else {
                dep_hash_part(c->digest, "unavailable");
                dep_gap(c, child, "dependency_manifest",
                        "A nested package scope could not be verified.");
            }
        } else if (S_ISREG(info.st_mode)) {
            CBMLanguage language = cbm_language_for_filename(names[i]);
            if (language != CBM_LANG_COUNT && cbm_flow_extract_supports_language(language))
                dep_source(c, child, language);
            else if (language != CBM_LANG_COUNT)
                dep_gap(c, child, "dependency_language",
                        "This installed source language has no verified value-flow adapter.");
        }
    }
    for (size_t i = 0; i < count; i++)
        cbm_free(CBM_MEM_CLASS_OTHER, names[i]);
    cbm_free(CBM_MEM_CLASS_OTHER, names);
    closedir(directory);
#endif
}
static void dep_package(dependency_context *c, const char *name, cbm_sha256_ctx *digest) {
    c->package = cbm_arena_sprintf(&c->snapshot->arena, "npm:%s", name);
    if (!c->package) {
        c->failed = true;
        return;
    }
    char directory[512], manifest[576];
    snprintf(directory, sizeof(directory), "node_modules/%s", name);
    snprintf(manifest, sizeof(manifest), "%s/package.json", directory);
#ifndef _WIN32
    int directory_fd = dep_open(c->root, directory, true);
    if (directory_fd < 0) {
        char full[4096];
        cbm_path_info_t info = {0};
        int size = snprintf(full, sizeof(full), "%s/%s", c->root, directory);
        bool unsafe = size > 0 && (size_t)size < sizeof(full) &&
                      cbm_path_info_utf8(full, &info) == CBM_PATH_INFO_OK && info.is_symlink;
        dep_gap(
            c, directory, unsafe ? "dependency_boundary" : "dependency_missing",
            unsafe
                ? "The selected package is a symlink; external installed sources are not traversed."
                : "The allowlisted package is not installed as a local directory in this project.");
        return;
    }
    close(directory_fd);
#endif
    size_t length = 0;
    char *source = dep_read(c, manifest, DEP_MANIFEST_BYTES, &length);
    if (!source) {
        dep_gap(c, manifest, "dependency_manifest",
                "A bounded local package.json with verified name and version is required.");
        return;
    }
    char hash[65];
    cbm_sha256_hex(source, length, hash);
    dep_hash_part(digest, manifest);
    dep_hash_part(digest, hash);
    yyjson_doc *doc = yyjson_read(source, length, 0);
    yyjson_val *root = doc ? yyjson_doc_get_root(doc) : NULL;
    const char *actual_name = yyjson_get_str(yyjson_obj_get(root, "name"));
    const char *version = yyjson_get_str(yyjson_obj_get(root, "version"));
    bool valid = pkg_unique_object(root) && actual_name && strcmp(actual_name, name) == 0 &&
                 strlen(actual_name) == yyjson_get_len(yyjson_obj_get(root, "name")) && version &&
                 version[0] && strlen(version) <= 255 &&
                 strlen(version) == yyjson_get_len(yyjson_obj_get(root, "version"));
    for (const unsigned char *p = (const unsigned char *)(version ? version : ""); valid && *p; p++)
        if (*p < 33 || *p == 127)
            valid = false;
    if (valid) {
        c->version = dep_copy(c, version);
        c->manifest_hash = dep_copy(c, hash);
        dep_hash_part(digest, c->package);
        dep_hash_part(digest, c->version);
    } else
        dep_gap(
            c, manifest, "dependency_manifest",
            "The installed package manifest has no matching package name and nonempty version.");
    yyjson_doc_free(doc);
    cbm_free(CBM_MEM_CLASS_OTHER, source);
    if (!valid)
        return;
    size_t before = c->snapshot->source_count;
    dep_walk(c, directory, 0);
    if (c->snapshot->source_count == before && !c->snapshot->limited)
        dep_gap(
            c, directory, "dependency_no_source",
            "The selected package has no readable source supported by the value-flow adapters.");
}
int cbm_flow_dependencies_snapshot(const char *root, const char *allowlist,
                                   cbm_flow_dependency_snapshot_t **out) {
    if (!root || !root[0] || !out)
        return CBM_STORE_ERR;
    *out = NULL;
    cbm_flow_dependency_snapshot_t *snapshot = cbm_calloc(CBM_MEM_CLASS_OTHER, sizeof(*snapshot));
    if (!snapshot)
        return CBM_STORE_ERR;
    cbm_arena_init_lazy(&snapshot->arena, 16384);
    dependency_context c = {.snapshot = snapshot, .root = root, .deadline = cbm_now_ms() + 3000};
    c.sources = cbm_arena_calloc(&snapshot->arena, DEP_FILES * sizeof(*c.sources));
    c.gaps = cbm_arena_calloc(&snapshot->arena, DEP_GAPS * sizeof(*c.gaps));
    if (!c.sources || !c.gaps) {
        cbm_flow_dependencies_free(snapshot);
        return CBM_STORE_ERR;
    }
    snapshot->sources = c.sources;
    snapshot->gaps = c.gaps;
    cbm_sha256_ctx hash;
    cbm_sha256_init(&hash);
    c.digest = &hash;
    dep_hash_part(&hash, "cbm-local-npm-source-v2:16:512:32MiB:4MiB");
    dep_hash_part(&hash, allowlist ? allowlist : "");
    snapshot->enabled = allowlist && allowlist[0];
    if (snapshot->enabled) {
#ifdef _WIN32
        dep_gap(&c, "node_modules", "dependency_platform",
                "Local dependency analysis is unavailable until a handle-anchored package reader "
                "is implemented for this platform.");
#endif
        char canonical[4096];
        if (!cbm_canonical_path(root, canonical, sizeof(canonical))) {
            cbm_flow_dependencies_free(snapshot);
            return CBM_STORE_ERR;
        }
        c.root = dep_copy(&c, canonical);
        if (strlen(allowlist) > 4096)
            dep_gap(&c, "", "dependency_limit",
                    "The explicit dependency allowlist exceeds 4096 bytes.");
        else {
            char *list = cbm_arena_strdup(&snapshot->arena, allowlist);
            if (!list)
                c.failed = true;
            const char *packages[DEP_PACKAGES] = {0};
            size_t count = 0;
            for (char *part = list; part && *part;) {
                char *next = strchr(part, ',');
                if (next)
                    *next++ = 0;
                while (isspace((unsigned char)*part))
                    part++;
                size_t length = strlen(part);
                while (length && isspace((unsigned char)part[length - 1]))
                    part[--length] = 0;
                c.package = dep_copy(&c, part);
                if (strchr(part, ':'))
                    dep_gap(&c, "", "dependency_ecosystem",
                            "Only explicitly allowlisted local npm packages are supported; other "
                            "package managers have no verified resolver.");
                else if (!dep_name(part))
                    dep_gap(&c, "", "dependency_name",
                            "An allowlist entry must be an exact npm package name or @scope/name, "
                            "without paths or traversal.");
                else if (count >= DEP_PACKAGES) {
                    snapshot->limited = true;
                    dep_gap(&c, "", "dependency_limit",
                            "At most 16 installed packages can be selected per project.");
                    break;
                } else
                    packages[count++] = part;
                part = next;
            }
            qsort(packages, count, sizeof(*packages), dep_string_compare);
            for (size_t i = 0; i < count && !c.failed; i++)
                if (!i || strcmp(packages[i - 1], packages[i]) != 0)
                    dep_package(&c, packages[i], &hash);
        }
    }
    qsort(c.sources, snapshot->source_count, sizeof(*c.sources), dep_source_compare);
    for (size_t i = 0; i < snapshot->source_count; i++) {
        dep_hash_part(&hash, c.sources[i].file_path);
        dep_hash_part(&hash, c.sources[i].source_hash);
        dep_hash_part(&hash, c.sources[i].package_id);
        dep_hash_part(&hash, c.sources[i].package_version);
        dep_hash_part(&hash, c.sources[i].package_manifest_hash);
    }
    for (size_t i = 0; i < snapshot->gap_count; i++) {
        dep_hash_part(&hash, c.gaps[i].package_id);
        dep_hash_part(&hash, c.gaps[i].file_path);
        dep_hash_part(&hash, c.gaps[i].code);
    }
    uint8_t raw[CBM_SHA256_DIGEST_LEN];
    cbm_sha256_final(&hash, raw);
    for (size_t i = 0; i < sizeof(raw); i++)
        snprintf(snapshot->digest + i * 2, 3, "%02x", raw[i]);
    if (c.failed) {
        cbm_flow_dependencies_free(snapshot);
        return CBM_STORE_ERR;
    }
    *out = snapshot;
    return CBM_STORE_OK;
}
void cbm_flow_dependencies_free(cbm_flow_dependency_snapshot_t *snapshot) {
    if (snapshot) {
        cbm_arena_destroy(&snapshot->arena);
        cbm_free(CBM_MEM_CLASS_OTHER, snapshot);
    }
}
int cbm_flow_dependencies_digest(const char *root, char digest[65]) {
    if (!digest)
        return CBM_STORE_ERR;
    cbm_flow_dependency_snapshot_t *snapshot = NULL;
    int rc = cbm_flow_dependencies_snapshot(root, getenv(CBM_FLOW_DEPENDENCIES_ENV), &snapshot);
    if (rc == CBM_STORE_OK)
        memcpy(digest, snapshot->digest, 65);
    cbm_flow_dependencies_free(snapshot);
    return rc;
}

/* Deliberately small ESM resolver. A package name and a call spelling are not
 * evidence: join the exact import declaration, manifest-selected file, direct
 * export declaration and immutable lexical call target before publishing ports. */
static bool pkg_is(TSNode node, const char *type) {
    return !ts_node_is_null(node) && !strcmp(ts_node_type(node), type);
}
static TSNode pkg_field(TSNode node, const char *name) {
    return ts_node_is_null(node) ? (TSNode){0}
                                 : ts_node_child_by_field_name(node, name, (uint32_t)strlen(name));
}
static bool pkg_text(const char *source, TSNode node, char *out, size_t capacity) {
    if (ts_node_is_null(node))
        return false;
    size_t start = ts_node_start_byte(node), end = ts_node_end_byte(node);
    if (end <= start || end - start >= capacity)
        return false;
    memcpy(out, source + start, end - start);
    out[end - start] = 0;
    return true;
}
static bool pkg_equal(const char *source, TSNode node, const char *name) {
    return !ts_node_is_null(node) &&
           ts_node_end_byte(node) - ts_node_start_byte(node) == strlen(name) &&
           !memcmp(source + ts_node_start_byte(node), name, strlen(name));
}
static bool pkg_contains(const char *source, TSNode node, const char *name, unsigned depth) {
    if (ts_node_is_null(node))
        return false;
    if (depth > 64)
        return true;
    if (pkg_is(node, "identifier") && pkg_equal(source, node, name))
        return true;
    for (uint32_t i = 0; i < ts_node_named_child_count(node); i++)
        if (pkg_contains(source, ts_node_named_child(node, i), name, depth + 1))
            return true;
    return false;
}
static bool pkg_type_only(TSNode node) {
    for (uint32_t i = 0; i < ts_node_child_count(node); i++) {
        TSNode child = ts_node_child(node, i);
        if (!ts_node_is_named(child) && pkg_is(child, "type"))
            return true;
    }
    return false;
}
/* Reject shadowing anywhere in this bounded source. This over-approximates
 * lexical conflicts intentionally; false absence is a gap, never false proof. */
static bool pkg_unsafe(const char *source, TSNode node, const char *name, uint32_t allowed_import,
                       uint32_t allowed_export, unsigned depth, size_t *visited) {
    if (ts_node_is_null(node))
        return false;
    if (++*visited > 100000 || depth > 128)
        return true;
    if (pkg_is(node, "import_statement"))
        return ts_node_start_byte(node) != allowed_import && pkg_contains(source, node, name, 0);
    if (pkg_is(node, "with_statement"))
        return true;
    if (pkg_is(node, "identifier") && pkg_equal(source, node, "eval"))
        return true;
    if (pkg_is(node, "call_expression") && pkg_equal(source, pkg_field(node, "function"), "eval"))
        return true;
    if (pkg_is(node, "assignment_expression") || pkg_is(node, "augmented_assignment_expression"))
        if (pkg_contains(source, pkg_field(node, "left"), name, 0))
            return true;
    if (pkg_is(node, "for_in_statement"))
        if (pkg_contains(source, pkg_field(node, "left"), name, 0))
            return true;
    if (pkg_is(node, "update_expression"))
        if (pkg_contains(source, pkg_field(node, "argument"), name, 0))
            return true;
    if (pkg_is(node, "variable_declarator") || pkg_is(node, "catch_clause")) {
        TSNode target = pkg_field(node, pkg_is(node, "catch_clause") ? "parameter" : "name");
        if (pkg_contains(source, target, name, 0))
            return true;
    }
    if (pkg_is(node, "formal_parameters") || pkg_is(node, "required_parameter") ||
        pkg_is(node, "optional_parameter"))
        if (pkg_contains(source, node, name, 0))
            return true;
    if (pkg_is(node, "function_declaration") || pkg_is(node, "function_expression") ||
        pkg_is(node, "class_declaration") || pkg_is(node, "generator_function_declaration"))
        if (ts_node_start_byte(node) != allowed_export &&
            pkg_equal(source, pkg_field(node, "name"), name))
            return true;
    if (pkg_is(node, "arrow_function") &&
        pkg_contains(source, pkg_field(node, "parameter"), name, 0))
        return true;
    for (uint32_t i = 0; i < ts_node_named_child_count(node); i++)
        if (pkg_unsafe(source, ts_node_named_child(node, i), name, allowed_import, allowed_export,
                       depth + 1, visited))
            return true;
    return false;
}
typedef struct {
    uint64_t deadline;
} pkg_parse_budget;
static bool pkg_parse_progress(TSParseState *state) {
    return cbm_now_ms() >= ((pkg_parse_budget *)state->payload)->deadline;
}
static TSTree *pkg_parse(const char *source, size_t length, CBMLanguage language) {
    if (language != CBM_LANG_JAVASCRIPT && language != CBM_LANG_TYPESCRIPT &&
        language != CBM_LANG_TSX)
        return NULL;
    TSParser *parser = ts_parser_new();
    if (!parser || !ts_parser_set_language(parser, cbm_ts_language(language))) {
        ts_parser_delete(parser);
        return NULL;
    }
    pkg_parse_budget budget = {.deadline = cbm_now_ms() + 500};
    TSTree *tree = cbm_parse_source(
        parser, source, (uint32_t)length,
        (TSParseOptions){.payload = &budget, .progress_callback = pkg_parse_progress});
    ts_parser_delete(parser);
    if (tree && ts_node_has_error(ts_tree_root_node(tree))) {
        ts_tree_delete(tree);
        tree = NULL;
    }
    return tree;
}
static bool pkg_unique_object(yyjson_val *object) {
    if (!yyjson_is_obj(object) || yyjson_obj_size(object) > 256)
        return false;
    size_t i, count;
    yyjson_val *key, *value;
    yyjson_obj_foreach(object, i, count, key, value) {
        if (strlen(yyjson_get_str(key)) != yyjson_get_len(key))
            return false;
        size_t j, other_count;
        yyjson_val *other, *unused;
        yyjson_obj_foreach(object, j, other_count, other, unused) {
            if (j >= i)
                break;
            if (yyjson_equals(key, other))
                return false;
        }
    }
    return true;
}
static bool pkg_relative(const char *path) {
    if (!path || !path[0] || path[0] == '/' || strpbrk(path, "\\:%?#*"))
        return false;
    for (const char *p = path; *p;) {
        const char *slash = strchr(p, '/');
        size_t n = slash ? (size_t)(slash - p) : strlen(p);
        if (!n || (n == 1 && p[0] == '.') || (n == 2 && p[0] == '.' && p[1] == '.'))
            return false;
        if (!slash)
            return true;
        p = slash + 1;
        if (!*p)
            return false;
    }
    return false;
}
static bool pkg_caller_path(const char *path) {
    if (!pkg_relative(path) || cbm_language_for_filename(path) != CBM_LANG_JAVASCRIPT)
        return false;
    const char *ext = strrchr(path, '.');
    return ext && (!strcmp(ext, ".js") || !strcmp(ext, ".mjs"));
}
/* Scope absence is part of the semantic input too: creating an ignored nearer
 * node_modules must invalidate an earlier root-package resolution. Inspect only
 * ancestors of up to 512 eligible indexed callers, never recursively traverse
 * another dependency tree. Limits disable binding rather than select a timing-
 * dependent subset of callers. */
int cbm_flow_dependencies_scope_digest(const char *root, const cbm_file_hash_t *manifest, int count,
                                       char digest[65], bool *limited) {
    if (!root || !digest || !limited || count < 0 || (count && !manifest))
        return CBM_STORE_ERR;
    *limited = false;
    cbm_sha256_ctx hash;
    cbm_sha256_init(&hash);
    dep_hash_part(&hash, "npm-native-esm-scopes-v1");
    const char *allowlist = getenv(CBM_FLOW_DEPENDENCIES_ENV);
    char **directories = cbm_calloc(CBM_MEM_CLASS_OTHER, 8192 * sizeof(*directories));
    if (!directories)
        return CBM_STORE_ERR;
    size_t directory_count = 0, callers = 0;
    int result = CBM_STORE_OK;
    if (allowlist && allowlist[0]) {
        for (int i = 0; i < count && !*limited; i++) {
            if (!pkg_caller_path(manifest[i].rel_path))
                continue;
            if (++callers > 512) {
                *limited = true;
                break;
            }
            char parent[4096];
            if (strlen(manifest[i].rel_path) >= sizeof(parent)) {
                *limited = true;
                break;
            }
            snprintf(parent, sizeof(parent), "%s", manifest[i].rel_path);
            unsigned depth = 0;
            for (;;) {
                char *slash = strrchr(parent, '/');
                if (slash)
                    *slash = 0;
                else
                    parent[0] = 0;
                if (directory_count == 8192 || ++depth > 64) {
                    *limited = true;
                    break;
                }
                directories[directory_count] = cbm_mem_strdup(CBM_MEM_CLASS_OTHER, parent);
                if (!directories[directory_count]) {
                    result = CBM_STORE_ERR;
                    break;
                }
                directory_count++;
                if (!parent[0])
                    break;
            }
            if (result != CBM_STORE_OK)
                break;
        }
    }
    qsort(directories, directory_count, sizeof(*directories), dep_string_compare);
#ifndef _WIN32
    char canonical[4096];
    if (!cbm_canonical_path(root, canonical, sizeof(canonical)))
        result = CBM_STORE_ERR;
    dependency_context context = {.root = canonical};
    uint64_t deadline = cbm_now_ms() + 3000;
    size_t total = 0;
    for (size_t i = 0; result == CBM_STORE_OK && !*limited && i < directory_count; i++) {
        const char *parent = directories[i];
        if (i && !strcmp(parent, directories[i - 1]))
            continue;
        if (cbm_now_ms() >= deadline || total >= DEP_TOTAL_BYTES) {
            *limited = true;
            break;
        }
        dep_hash_part(&hash, parent);
        int fd = parent[0] ? dep_open(canonical, parent, true)
                           : open(canonical, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (fd < 0) {
            dep_hash_part(&hash, "unavailable-directory");
            continue;
        }
        struct stat info;
        if (parent[0]) {
            int found = fstatat(fd, "node_modules", &info, AT_SYMLINK_NOFOLLOW);
            dep_hash_part(&hash, found == 0        ? "nearer-node-modules"
                                 : errno == ENOENT ? "no-nearer-node-modules"
                                                   : "unavailable-node-modules");
        }
        int found = fstatat(fd, "package.json", &info, AT_SYMLINK_NOFOLLOW);
        if (found == 0 && S_ISREG(info.st_mode)) {
            char path[4096];
            size_t length = 0;
            int used =
                snprintf(path, sizeof(path), "%s%spackage.json", parent, parent[0] ? "/" : "");
            size_t limit = DEP_TOTAL_BYTES - total;
            if (limit > DEP_MANIFEST_BYTES)
                limit = DEP_MANIFEST_BYTES;
            char *bytes = used > 0 && (size_t)used < sizeof(path)
                              ? dep_read(&context, path, limit, &length)
                              : NULL;
            if (bytes) {
                char content_hash[65];
                cbm_sha256_hex(bytes, length, content_hash);
                dep_hash_part(&hash, content_hash);
                total += length;
                cbm_free(CBM_MEM_CLASS_OTHER, bytes);
            } else
                dep_hash_part(&hash, "unavailable-package");
        } else
            dep_hash_part(&hash, found == 0        ? "unsafe-package"
                                 : errno == ENOENT ? "no-package"
                                                   : "unavailable-package");
        close(fd);
    }
    if (context.failed)
        result = CBM_STORE_ERR;
#endif
    if (*limited) {
        cbm_sha256_init(&hash);
        dep_hash_part(&hash, "npm-native-esm-scopes-v1:unsupported-budget");
    }
    uint8_t raw[CBM_SHA256_DIGEST_LEN];
    cbm_sha256_final(&hash, raw);
    for (size_t i = 0; i < sizeof(raw); i++)
        snprintf(digest + i * 2, 3, "%02x", raw[i]);
    for (size_t i = 0; i < directory_count; i++)
        cbm_free(CBM_MEM_CLASS_OTHER, directories[i]);
    cbm_free(CBM_MEM_CLASS_OTHER, directories);
    return result;
}
/* A closer package directory or package self-reference changes Node resolution.
 * Reject inaccessible/symlinked ancestors too; absence must be observed, not
 * inferred from a failed read. External loaders/configured aliases are outside
 * this deliberately narrow native ESM strategy. */
static bool pkg_root_lookup(dependency_context *context, const char *caller, const char *name) {
#ifdef _WIN32
    (void)context;
    (void)caller;
    (void)name;
    return false;
#else
    char parent[4096];
    if (strlen(caller) >= sizeof(parent))
        return false;
    snprintf(parent, sizeof(parent), "%s", caller);
    char *slash = strrchr(parent, '/');
    if (slash)
        *slash = 0;
    else
        parent[0] = 0;
    bool nearest_package = false;
    for (;;) {
        int fd = parent[0] ? dep_open(context->root, parent, true)
                           : open(context->root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (fd < 0)
            return false;
        struct stat st;
        if (parent[0]) {
            /* Even a partial nearer node_modules can alter a package lookup;
             * conservatively reject it rather than follow its symlinks. */
            int found = fstatat(fd, "node_modules", &st, AT_SYMLINK_NOFOLLOW);
            if (found == 0 || errno != ENOENT) {
                close(fd);
                return false;
            }
        }
        if (!nearest_package) {
            int found = fstatat(fd, "package.json", &st, AT_SYMLINK_NOFOLLOW);
            if (found == 0) {
                nearest_package = true;
                if (!S_ISREG(st.st_mode)) {
                    close(fd);
                    return false;
                }
                char path[4096];
                size_t length = 0;
                int used =
                    snprintf(path, sizeof(path), "%s%spackage.json", parent, parent[0] ? "/" : "");
                char *bytes = used > 0 && (size_t)used < sizeof(path)
                                  ? dep_read(context, path, DEP_MANIFEST_BYTES, &length)
                                  : NULL;
                yyjson_doc *doc = bytes ? yyjson_read(bytes, length, 0) : NULL;
                yyjson_val *root = doc ? yyjson_doc_get_root(doc) : NULL;
                bool valid = pkg_unique_object(root) &&
                             !(yyjson_equals_str(yyjson_obj_get(root, "name"), name) &&
                               yyjson_obj_get(root, "exports")) &&
                             !yyjson_equals_str(yyjson_obj_get(root, "type"), "commonjs");
                yyjson_doc_free(doc);
                cbm_free(CBM_MEM_CLASS_OTHER, bytes);
                if (!valid) {
                    close(fd);
                    return false;
                }
            } else if (errno != ENOENT) {
                close(fd);
                return false;
            }
        }
        close(fd);
        if (!parent[0])
            return true;
        slash = strrchr(parent, '/');
        if (slash)
            *slash = 0;
        else
            parent[0] = 0;
    }
#endif
}
static const cbm_flow_dependency_source_t *pkg_target(
    dependency_context *context, const cbm_flow_dependency_snapshot_t *snapshot, const char *caller,
    const char *specifier, char manifest_path[576]) {
    char name[256], subpath[512] = ".";
    const char *slash = strchr(specifier, '/');
    if (specifier[0] == '@')
        slash = slash ? strchr(slash + 1, '/') : NULL;
    size_t n = slash ? (size_t)(slash - specifier) : strlen(specifier);
    if (!n || n >= sizeof(name))
        return NULL;
    memcpy(name, specifier, n);
    name[n] = 0;
    if (!dep_name(name) || !pkg_root_lookup(context, caller, name))
        return NULL;
    /* Native modules take precedence over an identically named installed
     * package. Node-prefix-only modules are conservatively reserved too. */
    static const char *builtins[] = {"assert",       "async_hooks",
                                     "buffer",       "child_process",
                                     "cluster",      "console",
                                     "constants",    "crypto",
                                     "dgram",        "diagnostics_channel",
                                     "dns",          "domain",
                                     "events",       "fs",
                                     "http",         "http2",
                                     "https",        "inspector",
                                     "module",       "net",
                                     "os",           "path",
                                     "perf_hooks",   "process",
                                     "punycode",     "querystring",
                                     "readline",     "repl",
                                     "sea",          "sqlite",
                                     "stream",       "string_decoder",
                                     "sys",          "test",
                                     "timers",       "tls",
                                     "trace_events", "tty",
                                     "url",          "util",
                                     "v8",           "vm",
                                     "wasi",         "worker_threads",
                                     "zlib"};
    if (name[0] == '_')
        return NULL;
    for (size_t i = 0; i < sizeof(builtins) / sizeof(builtins[0]); i++)
        if (!strcmp(name, builtins[i]))
            return NULL;
    if (slash) {
        if (!pkg_relative(slash + 1) || strlen(slash) + 2 > sizeof(subpath))
            return NULL;
        snprintf(subpath, sizeof(subpath), ".%s", slash);
    }
    char package_id[260];
    snprintf(package_id, sizeof(package_id), "npm:%s", name);
    const cbm_flow_dependency_source_t *selected = NULL;
    for (size_t i = 0; i < snapshot->source_count; i++)
        if (!strcmp(snapshot->sources[i].package_id, package_id)) {
            selected = &snapshot->sources[i];
            break;
        }
    if (!selected)
        return NULL; /* Exact explicit allowlist, never global lookup. */
    snprintf(manifest_path, 576, "node_modules/%s/package.json", name);
    size_t length = 0;
    char *bytes = dep_read(context, manifest_path, DEP_MANIFEST_BYTES, &length);
    if (!bytes)
        return NULL;
    char hash[65];
    cbm_sha256_hex(bytes, length, hash);
    yyjson_doc *doc =
        !strcmp(hash, selected->package_manifest_hash) ? yyjson_read(bytes, length, 0) : NULL;
    yyjson_val *root = doc ? yyjson_doc_get_root(doc) : NULL;
    const char *entry = NULL;
    yyjson_val *exports = yyjson_obj_get(root, "exports");
    if (pkg_unique_object(root)) {
        if (exports) {
            bool map = pkg_unique_object(exports);
            if (map) {
                size_t i, count;
                yyjson_val *key, *value;
                yyjson_obj_foreach(exports, i, count, key, value) {
                    const char *text = yyjson_get_str(key);
                    if (strcmp(text, ".") && strncmp(text, "./", 2))
                        map = false;
                }
            }
            yyjson_val *target = yyjson_is_str(exports) && !strcmp(subpath, ".") ? exports
                                 : map ? yyjson_obj_get(exports, subpath)
                                       : NULL;
            if (yyjson_is_str(target) && yyjson_get_len(target) == strlen(yyjson_get_str(target))) {
                const char *candidate = yyjson_get_str(target);
                if (!strncmp(candidate, "./", 2))
                    entry = candidate + 2;
            }
        } else if (!slash) {
            yyjson_val *main = yyjson_obj_get(root, "main");
            if (!main)
                entry = "index.js";
            else if (yyjson_is_str(main) && yyjson_get_len(main) == strlen(yyjson_get_str(main))) {
                entry = yyjson_get_str(main);
                if (!strncmp(entry, "./", 2))
                    entry += 2;
            }
        }
    }
    const cbm_flow_dependency_source_t *found = NULL;
    if (pkg_relative(entry)) {
        char path[4096];
        int used = snprintf(path, sizeof(path), "node_modules/%s/%s", name, entry);
        bool module = yyjson_equals_str(yyjson_obj_get(root, "type"), "module");
        const char *ext = strrchr(entry, '.');
        bool esm = ext && (!strcmp(ext, ".mjs") || (module && !strcmp(ext, ".js")));
#ifndef _WIN32
        if (esm && strcmp(ext, ".mjs")) {
            /* A nested package scope can reinterpret .js as CommonJS. Until
             * scope-chain resolution is supported, require its absence. */
            char parent[4096];
            snprintf(parent, sizeof(parent), "%s", path);
            char package_root[512];
            snprintf(package_root, sizeof(package_root), "node_modules/%s", name);
            for (char *parent_slash = strrchr(parent, '/'); parent_slash;
                 parent_slash = strrchr(parent, '/')) {
                *parent_slash = 0;
                if (!strcmp(parent, package_root))
                    break;
                int fd = dep_open(context->root, parent, true);
                struct stat info;
                if (fd < 0) {
                    esm = false;
                    break;
                }
                int exists = fstatat(fd, "package.json", &info, AT_SYMLINK_NOFOLLOW);
                bool absent = exists != 0 && errno == ENOENT;
                close(fd);
                if (!absent) {
                    esm = false;
                    break;
                }
            }
        }
#endif
        if (esm && used > 0 && (size_t)used < sizeof(path))
            for (size_t i = 0; i < snapshot->source_count; i++)
                if (!strcmp(snapshot->sources[i].file_path, path) &&
                    !strcmp(snapshot->sources[i].package_id, package_id)) {
                    found = &snapshot->sources[i];
                    break;
                }
    }
    yyjson_doc_free(doc);
    cbm_free(CBM_MEM_CLASS_OTHER, bytes);
    return found;
}
static bool pkg_export(const cbm_flow_dependency_source_t *source, const char *name, int *start,
                       int *end) {
    TSTree *tree = pkg_parse(source->source, source->source_length, source->language);
    if (!tree)
        return false;
    TSNode root = ts_tree_root_node(tree), target = {0};
    unsigned matches = 0;
    bool conflicting = false;
    for (uint32_t i = 0; i < ts_node_named_child_count(root); i++) {
        TSNode export = ts_node_named_child(root, i),
               declaration = pkg_field(export, "declaration");
        if (!pkg_is(export, "export_statement"))
            continue;
        if (!pkg_is(declaration, "function_declaration")) {
            /* Re-exports, export lists and star exports need their own exact
             * resolution proof, including duplicate-export validation. */
            if (ts_node_is_null(declaration) || pkg_contains(source->source, export, name, 0))
                conflicting = true;
            continue;
        }
        bool default_export = false;
        for (uint32_t j = 0; j < ts_node_child_count(export); j++)
            if (pkg_is(ts_node_child(export, j), "default"))
                default_export = true;
        if (!default_export && pkg_equal(source->source, pkg_field(declaration, "name"), name)) {
            target = declaration;
            matches++;
        }
    }
    size_t visited = 0;
    bool ok = !conflicting && matches == 1 &&
              !pkg_unsafe(source->source, root, name, UINT32_MAX, ts_node_start_byte(target), 0,
                          &visited);
    if (ok) {
        *start = (int)ts_node_start_byte(target);
        *end = (int)ts_node_end_byte(target);
    }
    ts_tree_delete(tree);
    return ok;
}
static void pkg_join(cbm_store_t *store, const char *project, const char *caller,
                     const char *caller_hash, const cbm_flow_dependency_source_t *target,
                     const char *manifest_path, const char *specifier, const char *imported,
                     const char *local, int import_start, int import_end, int export_start,
                     int export_end, uint64_t deadline, const atomic_int *cancelled) {
    sqlite3 *db = cbm_store_get_db(store);
    sqlite3_stmt *s = NULL;
    const char *sql =
        "SELECT c.operation_id,f.symbol FROM cbm_flow_callsites c "
        "JOIN cbm_flow_operations o ON o.project=c.project AND o.id=c.operation_id "
        "JOIN cbm_flow_functions f ON f.project=c.project AND f.file_path=?3 "
        "WHERE c.project=?1 AND c.file_path=?2 AND o.operator_name=?4 "
        "AND f.name=?5 AND f.start_byte=?6 AND f.end_byte=?7 ORDER BY c.start_byte LIMIT 1025";
    if (sqlite3_prepare_v2(db, sql, -1, &s, NULL) != SQLITE_OK)
        return;
    sqlite3_bind_text(s, 1, project, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(s, 2, caller, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(s, 3, target->file_path, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(s, 4, local, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(s, 5, imported, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(s, 6, export_start);
    sqlite3_bind_int(s, 7, export_end);
    unsigned count = 0;
    while (cbm_now_ms() < deadline && !(cancelled && atomic_load(cancelled)) &&
           sqlite3_step(s) == SQLITE_ROW && count++ < 1024) {
        cbm_flow_package_binding_t b = {.caller_file = caller,
                                        .caller_hash = caller_hash,
                                        .callee_file = target->file_path,
                                        .callee_hash = target->source_hash,
                                        .operation_id = (const char *)sqlite3_column_text(s, 0),
                                        .callee_symbol = (const char *)sqlite3_column_text(s, 1),
                                        .package_id = target->package_id,
                                        .package_version = target->package_version,
                                        .manifest_hash = target->package_manifest_hash,
                                        .manifest_path = manifest_path,
                                        .specifier = specifier,
                                        .imported_name = imported,
                                        .local_name = local,
                                        .import_start = import_start,
                                        .import_end = import_end,
                                        .export_start = export_start,
                                        .export_end = export_end};
        (void)cbm_flow_ir_bind_package_call(store, project, &b);
    }
    sqlite3_finalize(s);
}
static void pkg_caller(cbm_store_t *store, const char *project, dependency_context *context,
                       const cbm_flow_dependency_snapshot_t *snapshot, const char *path,
                       const char *hash, const char *source, size_t length, CBMLanguage language,
                       const atomic_int *cancelled) {
    TSTree *tree = pkg_parse(source, length, language);
    if (!tree)
        return;
    TSNode root = ts_tree_root_node(tree);
    unsigned imports = 0;
    for (uint32_t i = 0; i < ts_node_named_child_count(root) && imports < 128 &&
                         cbm_now_ms() < context->deadline && !(cancelled && atomic_load(cancelled));
         i++) {
        TSNode import = ts_node_named_child(root, i);
        if (!pkg_is(import, "import_statement") || pkg_type_only(import))
            continue;
        bool ordinary_import = true;
        for (uint32_t j = 0; j < ts_node_named_child_count(import); j++) {
            TSNode child = ts_node_named_child(import, j);
            if (!pkg_is(child, "import_clause") && !pkg_is(child, "string") &&
                !pkg_is(child, "comment"))
                ordinary_import = false;
        }
        if (!ordinary_import)
            continue;
        char quoted[512], specifier[512], manifest_path[576];
        if (!pkg_text(source, pkg_field(import, "source"), quoted, sizeof(quoted)))
            continue;
        size_t n = strlen(quoted);
        if (n < 3 || (quoted[0] != '\'' && quoted[0] != '"') || quoted[n - 1] != quoted[0] ||
            strchr(quoted, '\\'))
            continue;
        memcpy(specifier, quoted + 1, n - 2);
        specifier[n - 2] = 0;
        const cbm_flow_dependency_source_t *target =
            pkg_target(context, snapshot, path, specifier, manifest_path);
        if (!target)
            continue;
        TSNode clause = {0}, named = {0};
        for (uint32_t j = 0; j < ts_node_named_child_count(import); j++)
            if (pkg_is(ts_node_named_child(import, j), "import_clause"))
                clause = ts_node_named_child(import, j);
        if (ts_node_is_null(clause))
            continue;
        for (uint32_t j = 0; j < ts_node_named_child_count(clause); j++)
            if (pkg_is(ts_node_named_child(clause, j), "named_imports"))
                named = ts_node_named_child(clause, j);
        if (ts_node_is_null(named))
            continue;
        for (uint32_t j = 0;
             j < ts_node_named_child_count(named) && imports++ < 128 &&
             cbm_now_ms() < context->deadline && !(cancelled && atomic_load(cancelled));
             j++) {
            TSNode binding = ts_node_named_child(named, j), original = pkg_field(binding, "name"),
                   alias = pkg_field(binding, "alias");
            if (!pkg_is(binding, "import_specifier") || pkg_type_only(binding) ||
                !pkg_is(original, "identifier"))
                continue;
            if (ts_node_is_null(alias))
                alias = original;
            char imported[256], local[256];
            if (!pkg_is(alias, "identifier") ||
                !pkg_text(source, original, imported, sizeof(imported)) ||
                !pkg_text(source, alias, local, sizeof(local)))
                continue;
            unsigned same = 0;
            for (uint32_t k = 0; k < ts_node_named_child_count(named); k++) {
                TSNode other = ts_node_named_child(named, k),
                       local_node = pkg_field(other, "alias");
                if (ts_node_is_null(local_node))
                    local_node = pkg_field(other, "name");
                if (pkg_equal(source, local_node, local))
                    same++;
            }
            for (uint32_t k = 0; k < ts_node_named_child_count(clause); k++) {
                TSNode child = ts_node_named_child(clause, k);
                if (!pkg_is(child, "named_imports") && pkg_contains(source, child, local, 0))
                    same++;
            }
            if (same != 1)
                continue;
            size_t visited = 0;
            int export_start = 0, export_end = 0;
            if (pkg_unsafe(source, root, local, ts_node_start_byte(import), UINT32_MAX, 0,
                           &visited) ||
                !pkg_export(target, imported, &export_start, &export_end))
                continue;
            pkg_join(store, project, path, hash, target, manifest_path, specifier, imported, local,
                     (int)ts_node_start_byte(import), (int)ts_node_end_byte(import), export_start,
                     export_end, context->deadline, cancelled);
        }
    }
    ts_tree_delete(tree);
}
static int pkg_resolution_gap(cbm_store_t *store, const char *project, const char *hash,
                              const char *code, const char *message) {
    cbm_flow_gap_t gap = {.code = code, .message = message, .symbol = ""};
    cbm_flow_file_t file = {.source_hash = hash,
                            .adapter = "local-dependency-coverage",
                            .adapter_version = 1,
                            .gaps = &gap,
                            .gap_count = 1};
    return cbm_flow_ir_replace_file(store, project,
                                    ".codebase-memory/flow-dependency-resolution-status", &file);
}
int cbm_flow_dependencies_bind(cbm_store_t *store, const char *project, const char *root,
                               const cbm_file_hash_t *manifest, int count,
                               const cbm_flow_dependency_snapshot_t *snapshot,
                               const atomic_int *cancelled) {
    if (!store || !project || !root || count < 0 || (count && !manifest))
        return CBM_STORE_ERR;
    if (!snapshot || !snapshot->enabled || !snapshot->source_count)
        return CBM_STORE_OK;
    if (snapshot->limited)
        return pkg_resolution_gap(
            store, project, snapshot->digest, "dependency_resolution_budget",
            "An incomplete package snapshot cannot prove the absence of another package scope.");
    char scope_hash[65];
    bool scope_limited = false;
    int scope_rc =
        cbm_flow_dependencies_scope_digest(root, manifest, count, scope_hash, &scope_limited);
    if (scope_rc != CBM_STORE_OK)
        return scope_rc;
    const char *expected_scope = NULL;
    for (int i = 0; i < count; i++)
        if (manifest[i].rel_path && !strcmp(manifest[i].rel_path, CBM_FLOW_DEPENDENCIES_SCOPES))
            expected_scope = manifest[i].sha256;
    if (scope_limited)
        return pkg_resolution_gap(
            store, project, scope_hash, "dependency_resolution_budget",
            "Package binding exceeds the bounded caller or package-scope verification budget.");
    if (!expected_scope || strcmp(expected_scope, scope_hash))
        return pkg_resolution_gap(
            store, project, scope_hash, "dependency_resolution_snapshot_changed",
            "The package-resolution environment changed after the semantic manifest.");
    /* This context is used only by the anchored byte reader; never mutates
     * or adds entries to the frozen dependency snapshot. */
    char canonical[4096];
    if (!cbm_canonical_path(root, canonical, sizeof(canonical)))
        return CBM_STORE_ERR;
    dependency_context context = {.root = canonical, .deadline = cbm_now_ms() + 10000};
    size_t total = 0;
    unsigned files = 0;
    bool limited = false;
    for (int i = 0; i < count; i++) {
        if (cancelled && atomic_load(cancelled))
            return CBM_STORE_CANCELLED;
        if (files >= 512 || total >= DEP_TOTAL_BYTES || cbm_now_ms() >= context.deadline) {
            limited = true;
            break;
        }
        const cbm_file_hash_t *entry = &manifest[i];
        CBMLanguage language = cbm_language_for_filename(entry->rel_path);
        /* TypeScript paths/baseUrl and transpiler module resolution require a
         * separate verified resolver. Never assume native Node semantics. */
        if (!pkg_caller_path(entry->rel_path))
            continue;
        if (entry->size < 0 || entry->size > DEP_FILE_BYTES ||
            (uint64_t)entry->size > DEP_TOTAL_BYTES - total)
            continue;
        size_t length = 0;
        char *bytes = dep_read(&context, entry->rel_path, DEP_FILE_BYTES, &length);
        if (!bytes)
            continue;
        files++;
        total += length;
        char hash[65];
        cbm_sha256_hex(bytes, length, hash);
        if (!strcmp(hash, entry->sha256))
            pkg_caller(store, project, &context, snapshot, entry->rel_path, hash, bytes, length,
                       language, cancelled);
        cbm_free(CBM_MEM_CLASS_OTHER, bytes);
    }
    if (cancelled && atomic_load(cancelled))
        return CBM_STORE_CANCELLED;
    if (context.failed)
        return CBM_STORE_ERR;
    if (limited || cbm_now_ms() >= context.deadline)
        return pkg_resolution_gap(
            store, project, scope_hash, "dependency_resolution_budget",
            "Further package bindings exceed the 512-file, 32-MiB or 10-second resolution budget.");
    return CBM_STORE_OK;
}
