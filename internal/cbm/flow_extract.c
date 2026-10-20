#include "flow_extract.h"
#include "lang_specs.h"
#include "foundation/mem_core.h"
#include "foundation/platform.h"
#include "foundation/sha256.h"
#include <stdio.h>
#include <string.h>

/* Independent value IR: reads resolve lexical declarations and reaching writes.
 * Unsupported semantics stop the affected path and leave source-located gaps. */
enum {
    MAX_RECORDS = 20000,
    MAX_WALK = 100000,
    MAX_DEPTH = 128,
    MAX_PARAMS = 128,
    MAX_FUNCTIONS = 1024,
    MAX_GAPS = 4096,
    MAX_SOURCE = 8 * 1024 * 1024,
    MAX_ARENA = 64 * 1024 * 1024
};
typedef struct {
    int parent;
    bool object_lifetime;
} flow_scope;
typedef struct {
    const char *name, *id;
    int scope, declaration, current, version;
    bool immutable, primitive_storage, inferred_storage;
} flow_binding;
typedef struct {
    TSNode node, body, name_node, parameters;
    const char *name, *symbol;
    int parent, return_value, parameter_values[MAX_PARAMS], parameter_count;
    int scope_start, scope_end;
    TSNode parameter_nodes[MAX_PARAMS];
    bool method, ambiguous_write, invalid, call_unsupported, reference_alias, primitive_return;
} flow_function;
typedef struct {
    cbm_flow_extraction_t *result;
    const char *source, *identity;
    int source_len, function, scope, function_scope;
    CBMLanguage language;
    bool oom, limited, dynamic_scope;
    size_t visits;
    uint64_t deadline;
    cbm_flow_value_t *values;
    size_t nv, cv;
    bool *primitive;
    size_t cprimitive;
    cbm_flow_operation_t *operations;
    size_t no, co;
    cbm_flow_link_t *links;
    size_t nl, cl;
    cbm_flow_gap_t *gaps;
    size_t ng, cg;
    flow_scope *scopes;
    size_t ns, cs;
    flow_binding *bindings;
    size_t nb, cb;
    flow_function *functions;
    size_t nfn, cfn;
    cbm_flow_function_t *function_ports;
    size_t nfp, cfp;
    cbm_flow_callsite_t *callsites;
    size_t nc, cc;
} flow_context;

/* Tree-sitter's count APIs dereference the node even for a missing field.
 * Grammar-specific optional fields must remain normal unsupported shapes. */
static uint32_t named_count(TSNode n) {
    return ts_node_is_null(n) ? 0 : ts_node_named_child_count(n);
}
static uint32_t child_count(TSNode n) {
    return ts_node_is_null(n) ? 0 : ts_node_child_count(n);
}
static bool is(TSNode n, const char *type) {
    return !ts_node_is_null(n) && strcmp(ts_node_type(n), type) == 0;
}
static TSNode field(TSNode n, const char *name) {
    return ts_node_is_null(n) ? (TSNode){0}
                              : ts_node_child_by_field_name(n, name, (uint32_t)strlen(name));
}
static TSNode child_type(TSNode n, const char *type) {
    for (uint32_t i = 0; i < named_count(n); i++) {
        TSNode child = ts_node_named_child(n, i);
        if (is(child, type))
            return child;
    }
    return (TSNode){0};
}
static bool js_family(CBMLanguage lang) {
    return lang == CBM_LANG_JAVASCRIPT || lang == CBM_LANG_TYPESCRIPT || lang == CBM_LANG_TSX;
}
static bool cpp_family(CBMLanguage lang) {
    return lang == CBM_LANG_CPP || lang == CBM_LANG_CUDA;
}
static bool implicit_conversion_family(CBMLanguage lang) {
    return cpp_family(lang) || lang == CBM_LANG_CSHARP;
}
bool cbm_flow_extract_supports_language(CBMLanguage lang) {
    return js_family(lang) || lang == CBM_LANG_PYTHON || lang == CBM_LANG_GO ||
           lang == CBM_LANG_RUST || lang == CBM_LANG_JAVA || lang == CBM_LANG_KOTLIN ||
           lang == CBM_LANG_CSHARP || lang == CBM_LANG_PHP || lang == CBM_LANG_C ||
           lang == CBM_LANG_CPP || lang == CBM_LANG_CUDA;
}
static void *grow(flow_context *c, void *old, size_t count, size_t *capacity, size_t item) {
    if (count < *capacity)
        return old;
    if (count >= MAX_RECORDS) {
        c->limited = true;
        return NULL;
    }
    size_t next = *capacity ? *capacity * 2 : 32;
    if (next > MAX_RECORDS)
        next = MAX_RECORDS;
    void *p = cbm_arena_alloc(&c->result->arena, next * item);
    if (!p) {
        c->oom = true;
        return NULL;
    }
    if (old)
        memcpy(p, old, count * item);
    *capacity = next;
    return p;
}
#define GROW(c, member, count, capacity)                                                        \
    do {                                                                                        \
        void *next_ = grow((c), (c)->member, (c)->count, &(c)->capacity, sizeof(*(c)->member)); \
        if (!next_) {                                                                           \
            return -1;                                                                          \
        }                                                                                       \
        (c)->member = next_;                                                                    \
    } while (0)
static const char *copy(flow_context *c, const char *s) {
    char *out = cbm_arena_strdup(&c->result->arena, s ? s : "");
    if (!out)
        c->oom = true;
    return out ? out : "";
}
static const char *text(flow_context *c, TSNode n) {
    if (ts_node_is_null(n))
        return "";
    uint32_t a = ts_node_start_byte(n), b = ts_node_end_byte(n);
    if (b < a || b > (uint32_t)c->source_len || b - a > 2048) {
        c->limited = true;
        return "";
    }
    char *out = cbm_arena_strndup(&c->result->arena, c->source + a, b - a);
    if (!out)
        c->oom = true;
    return out ? out : "";
}
static const char *identifier(flow_context *c, TSNode n) {
    const char *name = text(c, n);
    return name[0] == '$' ? name + 1 : name;
}
static const char *symbol(flow_context *c) {
    return c->function >= 0 ? c->functions[c->function].symbol : "<module>";
}
static int start(TSNode n) {
    return ts_node_is_null(n) ? 0 : (int)ts_node_start_byte(n);
}
static int end(TSNode n) {
    return ts_node_is_null(n) ? 0 : (int)ts_node_end_byte(n);
}
static int line(TSNode n) {
    return ts_node_is_null(n) ? 0 : (int)ts_node_start_point(n).row + 1;
}
static int end_line(TSNode n) {
    return ts_node_is_null(n) ? 0 : (int)ts_node_end_point(n).row + 1;
}
static const char *record_id(flow_context *c, const char *kind, size_t number) {
    char *out = cbm_arena_sprintf(&c->result->arena, "flow:%s:%s%zu", c->identity, kind, number);
    if (!out)
        c->oom = true;
    return out ? out : "";
}
static int gap(flow_context *c, TSNode n, const char *code, const char *message) {
    if (c->ng >= MAX_GAPS) {
        c->limited = true;
        return -1;
    }
    GROW(c, gaps, ng, cg);
    c->gaps[c->ng++] = (cbm_flow_gap_t){.code = copy(c, code),
                                        .message = copy(c, message),
                                        .symbol = copy(c, symbol(c)),
                                        .start_byte = start(n),
                                        .end_byte = end(n),
                                        .start_line = line(n)};
    return 0;
}
static bool budget(flow_context *c, TSNode n, int depth) {
    if (c->oom || c->limited)
        return false;
    if ((c->visits & 63) == 0 && cbm_now_ms() >= c->deadline) {
        (void)gap(c, n, "analysis_budget",
                  "The per-file elapsed-time budget expired during AST value-flow analysis.");
        c->limited = true;
        return false;
    }
    if (c->result->arena.total_alloc > MAX_ARENA) {
        (void)gap(c, n, "memory_budget", "The per-file flow-analysis memory budget was reached.");
        c->limited = true;
        return false;
    }
    if (++c->visits > MAX_WALK || depth > MAX_DEPTH) {
        (void)gap(c, n, "analysis_limit", "The bounded AST walk stopped before this construct.");
        c->limited = true;
        return false;
    }
    return true;
}
static int value(flow_context *c, TSNode n, const char *kind, const char *binding, const char *path,
                 int version, int parameter) {
    GROW(c, values, nv, cv);
    GROW(c, primitive, nv, cprimitive);
    size_t i = c->nv++;
    c->primitive[i] = false;
    const char *id = record_id(c, "v", i);
    c->values[i] = (cbm_flow_value_t){.id = id,
                                      .symbol = copy(c, symbol(c)),
                                      .binding = binding && binding[0] ? copy(c, binding) : id,
                                      .access_path = copy(c, path ? path : "[]"),
                                      .kind = copy(c, kind),
                                      .version = version,
                                      .start_byte = start(n),
                                      .end_byte = end(n),
                                      .start_line = line(n),
                                      .end_line = end_line(n),
                                      .parameter_index = parameter};
    return (int)i;
}
static bool primitive_value(flow_context *c, int v) {
    return v >= 0 && (size_t)v < c->nv && c->primitive[v];
}
static void primitive_from(flow_context *c, int to, int from) {
    if (to >= 0)
        c->primitive[to] = primitive_value(c, from);
}
/* These are syntax-level builtin types, not short-name guesses for aliases or
 * user classes. Reference/pointer declarators deliberately remain unsupported. */
static bool primitive_type(flow_context *c, TSNode type) {
    if (is(type, "primitive_type") || is(type, "sized_type_specifier") ||
        is(type, "integral_type") || is(type, "floating_point_type") || is(type, "boolean_type"))
        return strcmp(text(c, type), "void") != 0;
    if (is(type, "predefined_type")) {
        const char *name = text(c, type);
        return strcmp(name, "object") && strcmp(name, "dynamic") && strcmp(name, "void");
    }
    return false;
}
static TSNode storage_type(TSNode name) {
    TSNode n = name;
    for (int i = 0; i < 8 && !ts_node_is_null(n); i++, n = ts_node_parent(n)) {
        if (is(n, "reference_declarator") || is(n, "pointer_declarator") ||
            is(n, "array_declarator") || is(n, "ref_type"))
            return (TSNode){0};
        TSNode type = field(n, "type");
        if (!ts_node_is_null(type))
            return type;
    }
    return (TSNode){0};
}
static int operation(flow_context *c, TSNode n, const char *kind, const char *operator_name) {
    GROW(c, operations, no, co);
    size_t i = c->no++;
    c->operations[i] = (cbm_flow_operation_t){.id = record_id(c, "o", i),
                                              .symbol = copy(c, symbol(c)),
                                              .kind = copy(c, kind),
                                              .operator_name = copy(c, operator_name),
                                              .start_byte = start(n),
                                              .end_byte = end(n),
                                              .start_line = line(n),
                                              .end_line = end_line(n)};
    return (int)i;
}
static int link_values(flow_context *c, int from, int to, int op, const char *kind,
                       const char *certainty, const char *callsite) {
    if (from < 0 || to < 0 || op < 0)
        return -1;
    GROW(c, links, nl, cl);
    size_t i = c->nl++;
    c->links[i] = (cbm_flow_link_t){.id = record_id(c, "e", i),
                                    .source = c->values[from].id,
                                    .target = c->values[to].id,
                                    .operation_id = c->operations[op].id,
                                    .kind = copy(c, kind),
                                    .certainty = copy(c, certainty),
                                    .callsite_id = copy(c, callsite)};
    return 0;
}
static int new_scope(flow_context *c, int parent) {
    GROW(c, scopes, ns, cs);
    c->scopes[c->ns] = (flow_scope){.parent = parent};
    return (int)c->ns++;
}
static int find_binding(flow_context *c, const char *name, int scope, bool parents) {
    for (int s = scope; s >= 0; s = parents ? c->scopes[s].parent : -1)
        for (size_t i = c->nb; i > 0; i--)
            if (c->bindings[i - 1].scope == s && strcmp(c->bindings[i - 1].name, name) == 0)
                return (int)i - 1;
    return -1;
}
static int declare(flow_context *c, TSNode n, int scope, bool reuse) {
    const char *name = identifier(c, n);
    if (!name[0])
        return -1;
    for (size_t i = c->nb; i > 0; i--)
        if (c->bindings[i - 1].scope == scope && strcmp(c->bindings[i - 1].name, name) == 0 &&
            (reuse || c->bindings[i - 1].declaration == start(n)))
            return (int)i - 1;
    GROW(c, bindings, nb, cb);
    size_t i = c->nb++;
    TSNode declaration = ts_node_parent(ts_node_parent(n));
    bool immutable = js_family(c->language) && is(declaration, "lexical_declaration") &&
                     is(field(declaration, "kind"), "const");
    c->bindings[i] = (flow_binding){.name = name,
                                    .id = record_id(c, "b", i),
                                    .scope = scope,
                                    .declaration = start(n),
                                    .current = -1,
                                    .immutable = immutable};
    TSNode type = storage_type(n);
    c->bindings[i].primitive_storage = primitive_type(c, type);
    const char *type_name = text(c, type);
    c->bindings[i].inferred_storage =
        strcmp(type_name, "auto") == 0 || strcmp(type_name, "var") == 0;
    return (int)i;
}
static bool simple_name(TSNode n) {
    return is(n, "identifier") || is(n, "simple_identifier") || is(n, "variable_name") ||
           is(n, "name");
}
static TSNode unwrap(TSNode n) {
    for (int i = 0; i < 12; i++) {
        if ((is(n, "parenthesized_expression") || is(n, "expression_list") ||
             is(n, "directly_assignable_expression") || is(n, "argument")) &&
            named_count(n) == 1)
            n = ts_node_named_child(n, 0);
        else
            break;
    }
    return n;
}
static TSNode declarator_name(TSNode n) {
    for (int i = 0; i < 12 && !ts_node_is_null(n); i++) {
        if (simple_name(n))
            return n;
        TSNode next = field(n, "name");
        if (ts_node_is_null(next))
            next = field(n, "pattern");
        if (ts_node_is_null(next))
            next = field(n, "declarator");
        /* Python typed_parameter has an unnamed lexical target followed by a
         * named "type" field. The annotation is not the value's binding. */
        if (ts_node_is_null(next) &&
            (is(n, "parameter") || is(n, "variable_declaration") || is(n, "typed_parameter")))
            next = ts_node_named_child(n, 0);
        n = next;
    }
    return (TSNode){0};
}
static bool function_node(TSNode n) {
    return is(n, "function_declaration") || is(n, "function_definition") ||
           is(n, "function_item") || is(n, "method_declaration") || is(n, "arrow_function") ||
           is(n, "function_expression");
}
static bool block_node(TSNode n) {
    return is(n, "statement_block") || is(n, "block") || is(n, "compound_statement") ||
           is(n, "function_body") || is(n, "control_structure_body");
}
static bool wrapped_callable(flow_context *c, TSNode n, int depth) {
    if (function_node(n))
        return false; /* A nested callable has its own rules. */
    if (!budget(c, n, depth))
        return true;
    const char *type = ts_node_type(n);
    if (is(n, "async") || strstr(type, "async_modifier") || is(n, "yield") ||
        strstr(type, "yield_expression") || strstr(type, "yield_statement"))
        return true;
    for (uint32_t i = 0; i < child_count(n); i++)
        if (wrapped_callable(c, ts_node_child(n, i), depth + 1))
            return true;
    return false;
}
static bool reference_alias(flow_context *c, TSNode n, int depth) {
    if (function_node(n))
        return false;
    if (!budget(c, n, depth))
        return true;
    if (is(n, "reference_declarator") || is(n, "reference_assignment_expression") ||
        is(n, "reference_modifier") || is(n, "by_ref") || is(n, "ref_expression") ||
        is(n, "ref_type"))
        return true;
    for (uint32_t i = 0; i < named_count(n); i++)
        if (reference_alias(c, ts_node_named_child(n, i), depth + 1))
            return true;
    return false;
}
static void collect_functions(flow_context *c, TSNode n, int parent, int depth) {
    if (!budget(c, n, depth))
        return;
    int child_parent = parent;
    if (function_node(n)) {
        if (c->nfn >= MAX_FUNCTIONS) {
            c->limited = true;
            return;
        }
        void *grown = grow(c, c->functions, c->nfn, &c->cfn, sizeof(*c->functions));
        if (!grown)
            return;
        c->functions = grown;
        int index = (int)c->nfn++;
        flow_function *fn = &c->functions[index];
        memset(fn, 0, sizeof(*fn));
        fn->node = n;
        fn->parent = parent;
        fn->return_value = -1;
        fn->method = is(n, "method_declaration");
        fn->name_node = field(n, "name");
        TSNode declarator = field(n, "declarator");
        if (ts_node_is_null(fn->name_node) && !ts_node_is_null(declarator))
            fn->name_node = declarator_name(declarator);
        if (ts_node_is_null(fn->name_node) && c->language == CBM_LANG_KOTLIN)
            fn->name_node = child_type(n, "simple_identifier");
        if (ts_node_is_null(fn->name_node) && is(ts_node_parent(n), "variable_declarator"))
            fn->name_node = field(ts_node_parent(n), "name");
        fn->name = identifier(c, fn->name_node);
        fn->symbol = cbm_arena_sprintf(&c->result->arena, "%s@%d",
                                       fn->name[0] ? fn->name : "<anonymous>", start(n));
        if (!fn->symbol) {
            c->oom = true;
            return;
        }
        fn->parameters = field(n, "parameters");
        if (ts_node_is_null(fn->parameters))
            fn->parameters = field(n, "parameter");
        TSNode signature = declarator;
        for (int peel = 0;
             peel < 12 && !ts_node_is_null(signature) && !is(signature, "function_declarator");
             peel++)
            signature = field(signature, "declarator");
        if (ts_node_is_null(fn->parameters) && !ts_node_is_null(signature))
            fn->parameters = field(signature, "parameters");
        if (ts_node_is_null(fn->parameters))
            fn->parameters = child_type(n, "function_value_parameters");
        fn->body = field(n, "body");
        if (ts_node_is_null(fn->body))
            fn->body = child_type(n, "function_body");
        fn->reference_alias = reference_alias(c, fn->body, depth + 1) ||
                              reference_alias(c, fn->parameters, depth + 1);
        TSNode return_type = field(n, "type");
        if (ts_node_is_null(return_type))
            return_type = field(n, "returns");
        fn->primitive_return =
            primitive_type(c, cpp_family(c->language) ? storage_type(fn->name_node) : return_type);
        fn->invalid = ts_node_is_null(fn->body) || ts_node_has_error(n);
        fn->call_unsupported = is(ts_node_parent(n), "decorated_definition");
        if (implicit_conversion_family(c->language) && !fn->primitive_return)
            fn->call_unsupported = true;
        if (fn->reference_alias)
            fn->call_unsupported = true;
        for (uint32_t i = 0; i < child_count(n); i++)
            if (wrapped_callable(c, ts_node_child(n, i), depth + 1))
                fn->call_unsupported = true;
        TSNode scope = ts_node_parent(n);
        while (!ts_node_is_null(scope) && !block_node(scope) && !is(scope, "program") &&
               !is(scope, "module") && !is(scope, "source_file") &&
               !is(scope, "translation_unit") && !is(scope, "class_body"))
            scope = ts_node_parent(scope);
        fn->scope_start = start(scope);
        fn->scope_end = ts_node_is_null(scope) ? c->source_len : end(scope);
        child_parent = index;
    }
    for (uint32_t i = 0; i < named_count(n); i++)
        collect_functions(c, ts_node_named_child(n, i), child_parent, depth + 1);
}
static bool complex_parameter(flow_context *c, TSNode n, int depth) {
    if (depth > 16)
        return true;
    const char *kind = ts_node_type(n);
    if (strstr(kind, "optional") || strstr(kind, "default") || strstr(kind, "rest") ||
        strstr(kind, "spread") || strstr(kind, "splat") || strstr(kind, "variadic") ||
        is(n, "reference_declarator") || is(n, "reference_modifier") || is(n, "assignment_pattern"))
        return true;
    if (!ts_node_is_null(field(n, "value")))
        return true;
    if (is(n, "modifier")) {
        const char *modifier = text(c, n);
        if (strcmp(modifier, "ref") == 0 || strcmp(modifier, "out") == 0 ||
            strcmp(modifier, "in") == 0 || strcmp(modifier, "params") == 0)
            return true;
    }
    for (uint32_t i = 0; i < named_count(n); i++)
        if (complex_parameter(c, ts_node_named_child(n, i), depth + 1))
            return true;
    return false;
}
static void add_parameter(flow_context *c, flow_function *fn, TSNode n) {
    if (fn->parameter_count >= MAX_PARAMS) {
        fn->call_unsupported = true;
        c->limited = true;
        return;
    }
    int i = fn->parameter_count++;
    fn->parameter_values[i] = -1;
    fn->parameter_nodes[i] = (TSNode){0};
    if (!simple_name(n)) {
        fn->call_unsupported = true;
        (void)gap(c, n, "parameter_pattern",
                  "This parameter pattern is not modeled as a lexical value port; its formal "
                  "position remains reserved.");
        return;
    }
    fn->parameter_nodes[i] = n;
    const char *binding =
        cbm_arena_sprintf(&c->result->arena, "flow:%s:param:%d:%d", c->identity, c->function, i);
    if (!binding) {
        c->oom = true;
        return;
    }
    fn->parameter_values[i] = value(c, n, "parameter", binding, "[]", 0, i);
    if (fn->parameter_values[i] >= 0) {
        bool primitive = primitive_type(c, storage_type(n));
        c->primitive[fn->parameter_values[i]] = primitive;
        if (implicit_conversion_family(c->language) && !primitive)
            fn->call_unsupported = true;
    }
}
static void signatures(flow_context *c) {
    for (size_t f = 0; f < c->nfn; f++) {
        if (!budget(c, c->functions[f].node, 0))
            break;
        c->function = (int)f;
        flow_function *fn = &c->functions[f];
        if (fn->invalid) {
            (void)gap(c, fn->node, "parse_error", "The function has no complete parseable body.");
            continue;
        }
        if (fn->call_unsupported)
            (void)gap(c, fn->node, "callable_shape",
                      "Decorated, async and generator callables require a verified wrapper or "
                      "iterator summary.");
        if (fn->reference_alias)
            (void)gap(c, fn->body, "reference_alias",
                      "Unmodeled reference aliases may share lexical storage; every later write "
                      "invalidates other reaching local values.");
        TSNode params = fn->parameters;
        if (simple_name(params))
            add_parameter(c, fn, params);
        else
            for (uint32_t i = 0; i < named_count(params); i++) {
                TSNode p = ts_node_named_child(params, i);
                if (is(p, "comment"))
                    continue;
                if ((c->language == CBM_LANG_C || c->language == CBM_LANG_CPP ||
                     c->language == CBM_LANG_CUDA) &&
                    named_count(params) == 1 && strcmp(text(c, p), "void") == 0)
                    continue;
                if (complex_parameter(c, p, 0)) {
                    fn->call_unsupported = true;
                    (void)gap(c, p, "parameter_semantics",
                              "Defaults, variadics and reference parameter effects need a verified "
                              "call signature summary.");
                }
                if (c->language == CBM_LANG_GO && is(p, "parameter_declaration")) {
                    for (uint32_t j = 0; j < child_count(p); j++) {
                        const char *role = ts_node_field_name_for_child(p, j);
                        if (role && strcmp(role, "name") == 0)
                            add_parameter(c, fn, ts_node_child(p, j));
                    }
                } else
                    add_parameter(c, fn, simple_name(p) ? p : declarator_name(p));
            }
        fn->return_value = value(c, ts_node_is_null(fn->name_node) ? fn->node : fn->name_node,
                                 "return", NULL, "[]", 0, -1);
    }
    c->function = -1;
}
static int unknown(flow_context *c, TSNode n, const char *code, const char *message) {
    (void)gap(c, n, code, message);
    return value(c, n, "unknown", NULL, "[]", 0, -1);
}
static void invalidate_locals(flow_context *c, TSNode n);
static void invalidate_heap_effects(flow_context *c, TSNode n);
static int expr(flow_context *c, TSNode n, int depth);
static bool statement(flow_context *c, TSNode n, int depth);
static int binding_version(flow_context *c, int b) {
    int current = c->bindings[b].current;
    return current < 0 ? 0 : c->values[current].version;
}
static int read_binding(flow_context *c, TSNode n, int b) {
    if (b < 0)
        return unknown(c, n, "unresolved_binding",
                       "No lexical local or parameter resolves this read; globals and closure "
                       "captures are not inferred.");
    int source = c->bindings[b].current;
    if (source < 0)
        return unknown(c, n, "uninitialized_binding",
                       "The lexical binding has no reaching write at this source location.");
    int v = value(c, n, "read", c->bindings[b].id, "[]", binding_version(c, b), -1);
    int op = operation(c, n, "read", "");
    (void)link_values(c, source, v, op, "assign", "proven", "");
    primitive_from(c, v, source);
    return v;
}
static const char *append_path(flow_context *c, const char *path, const char *part) {
    size_t length = strlen(path), n = strlen(part);
    if (length + n * 2 + 5 > 4096) {
        c->limited = true;
        return NULL;
    }
    char *out = cbm_arena_alloc(&c->result->arena, length + n * 2 + 5);
    if (!out) {
        c->oom = true;
        return NULL;
    }
    memcpy(out, path, length - 1);
    size_t at = length - 1;
    if (length > 2)
        out[at++] = ',';
    out[at++] = '"';
    for (size_t i = 0; i < n; i++) {
        unsigned char ch = (unsigned char)part[i];
        if (ch < 32)
            return NULL;
        if (ch == '\\' || ch == '"')
            out[at++] = '\\';
        out[at++] = (char)ch;
    }
    out[at++] = '"';
    out[at++] = ']';
    out[at] = 0;
    return out;
}
/* Static syntax resolves a lexical base plus literal path. A dynamic subscript
 * is never conflated with every member of the container. */
static bool member(flow_context *c, TSNode n, int *binding, const char **path, int depth) {
    if (depth > MAX_DEPTH)
        return false;
    n = unwrap(n);
    if (simple_name(n)) {
        *binding = find_binding(c, identifier(c, n), c->scope, true);
        *path = "[]";
        return *binding >= 0;
    }
    TSNode object = field(n, "object"), property = field(n, "property");
    if (ts_node_is_null(object))
        object = field(n, "argument");
    if (ts_node_is_null(object))
        object = field(n, "value");
    if (ts_node_is_null(property))
        property = field(n, "field");
    bool index = false;
    if (ts_node_is_null(property)) {
        property = field(n, "index");
        index = true;
    }
    if (ts_node_is_null(object) || ts_node_is_null(property) ||
        !member(c, object, binding, path, depth + 1))
        return false;
    const char *part = text(c, property);
    if (index) {
        size_t len = strlen(part);
        if (len >= 2 &&
            ((part[0] == '"' && part[len - 1] == '"') ||
             (part[0] == '\'' && part[len - 1] == '\'')) &&
            !strchr(part, '\\')) {
            part = cbm_arena_strndup(&c->result->arena, part + 1, len - 2);
            if (!part) {
                c->oom = true;
                return false;
            }
        } else {
            if (!len || (len > 1 && part[0] == '0'))
                return false;
            for (size_t i = 0; i < len; i++)
                if (part[i] < '0' || part[i] > '9')
                    return false;
        }
    }
    *path = append_path(c, *path, part);
    return *path != NULL;
}
static int member_read(flow_context *c, TSNode n) {
    int binding = -1;
    const char *path = NULL;
    if (!member(c, n, &binding, &path, 0) || !path || strcmp(path, "[]") == 0) {
        /* A computed index or member base can itself contain assignments or
         * calls. An unsupported read cannot silently preserve stale writes. */
        invalidate_locals(c, n);
        return unknown(c, n, "dynamic_access",
                       "The member base or path is not resolved; possible nested side effects "
                       "invalidate visible local values.");
    }
    /* A lexical base and a literal path identify a source occurrence, not a
     * heap region or accessor. Different parameters can alias, parent writes
     * can replace a child region, and getters need not return prior writes.
     * Until a typed alias/accessor summary exists, each read is an independent
     * value boundary in every language family. Do not even join repeated reads
     * or infer field transport from the containing object parameter. */
    int version = binding_version(c, binding);
    invalidate_heap_effects(c, n);
    int v = value(c, n, "field_read", c->bindings[binding].id, path, version, -1);
    (void)operation(c, n, "field_read", "");
    (void)gap(c, n, "heap_read",
              "This field-read occurrence has no verified storage, alias or accessor summary; its "
              "value is not linked to a previous field write or container.");
    return v;
}
static bool member_node(TSNode n) {
    return is(n, "member_expression") || is(n, "subscript_expression") ||
           is(n, "field_expression") || is(n, "field_access") || is(n, "member_access_expression");
}
static int assign(flow_context *c, TSNode lhs, int rhs, TSNode whole, bool declaration,
                  bool function_scoped) {
    lhs = unwrap(lhs);
    if (c->function >= 0 && c->functions[c->function].reference_alias)
        invalidate_locals(c, whole);
    if (simple_name(lhs)) {
        if (c->language == CBM_LANG_GO && !strcmp(identifier(c, lhs), "_"))
            return rhs; /* The blank identifier discards the evaluated RHS. */
        int scope = function_scoped ? c->function_scope : c->scope;
        int b = declaration ? declare(c, lhs, scope, function_scoped || c->language == CBM_LANG_GO)
                            : find_binding(c, identifier(c, lhs), c->scope, true);
        if (b < 0 && (c->language == CBM_LANG_PYTHON || c->language == CBM_LANG_PHP))
            b = declare(c, lhs, c->function_scope, true);
        if (b < 0) {
            invalidate_locals(c, whole);
            return unknown(c, whole, "unresolved_write",
                           "The write does not resolve to a local lexical declaration; it may "
                           "affect visible storage through an unmodeled reference.");
        }
        bool releases_object = (c->language == CBM_LANG_PYTHON || c->language == CBM_LANG_PHP ||
                                c->language == CBM_LANG_RUST) &&
                               c->bindings[b].current >= 0 &&
                               !primitive_value(c, c->bindings[b].current);
        if (releases_object) {
            invalidate_locals(c, whole);
            (void)gap(c, whole, "object_release",
                      "Replacing an unverified object reference may run a finalizer that changes "
                      "visible locals; prior reaching values are invalidated.");
        }
        if (implicit_conversion_family(c->language)) {
            if (declaration && c->bindings[b].inferred_storage && primitive_value(c, rhs))
                c->bindings[b].primitive_storage = true;
            bool scalar = c->bindings[b].primitive_storage;
            if (declaration && !scalar && c->scope >= 0)
                c->scopes[c->scope].object_lifetime = true;
            if (!scalar || (rhs >= 0 && !primitive_value(c, rhs))) {
                invalidate_locals(c, whole);
                rhs = unknown(c, whole, "implicit_conversion",
                              "Construction, copying, assignment or conversion has no verified "
                              "primitive storage rule; user code may change visible locals.");
            }
        }
        if (rhs < 0)
            return c->bindings[b].current;
        int v = value(c, lhs, "write", c->bindings[b].id, "[]", ++c->bindings[b].version, -1);
        int op = operation(c, whole, "assign", "=");
        (void)link_values(c, rhs, v, op, "assign", "proven", "");
        primitive_from(c, v, rhs);
        c->bindings[b].current = v;
        /* Python/PHP finalizers can rebind even the assignment destination
         * during release. Keep the syntactic RHS occurrence, not a post-release
         * claim about the binding. Rust Drop also lacks an effects summary. */
        if (releases_object)
            invalidate_locals(c, whole);
        return v;
    }
    int binding = -1;
    const char *path = NULL;
    if (member(c, lhs, &binding, &path, 0) && path && strcmp(path, "[]") != 0) {
        int v = value(c, lhs, "field_write", c->bindings[binding].id, path,
                      binding_version(c, binding), -1);
        int op = operation(c, whole, "field_write", "=");
        /* This records the RHS supplied to a syntactic write, not a proven
         * heap cell. Setters may ignore it or run arbitrary user code. */
        (void)link_values(c, rhs, v, op, "assign", "proven", "");
        invalidate_heap_effects(c, whole);
        (void)gap(c, whole, "heap_write",
                  "The value reaches this syntactic write RHS, but stored contents, aliases and "
                  "accessor effects are unverified; later heap reads remain independent.");
        return v;
    }
    invalidate_locals(c, whole);
    return unknown(
        c, whole, "assignment_pattern",
        "This destructuring, pointer or dynamic write is not resolved into lexical storage.");
}
static const char *operator_text(flow_context *c, TSNode n) {
    TSNode op = field(n, "operator");
    if (!ts_node_is_null(op))
        return text(c, op);
    for (uint32_t i = 0; i < child_count(n); i++) {
        TSNode child = ts_node_child(n, i);
        if (!ts_node_is_named(child)) {
            const char *token = text(c, child);
            if (token[0] && strchr("=+-*/%&|^!<>?:", token[0]))
                return token;
        }
    }
    return "";
}
static bool positional_argument(TSNode n, int depth) {
    if (depth > 8)
        return false;
    const char *kind = ts_node_type(n);
    if (strstr(kind, "spread") || strstr(kind, "splat") || strstr(kind, "keyword") ||
        is(n, "named_argument") || !ts_node_is_null(field(n, "name")))
        return false;
    if (is(n, "argument")) {
        for (uint32_t i = 0; i < child_count(n); i++) {
            TSNode child = ts_node_child(n, i);
            const char *type = ts_node_type(child);
            if (strcmp(type, "ref") == 0 || strcmp(type, "out") == 0 || strcmp(type, "in") == 0)
                return false;
        }
        if (named_count(n) != 1)
            return false;
        return positional_argument(ts_node_named_child(n, 0), depth + 1);
    }
    return true;
}
static int callsite_port(flow_context *c, TSNode n, int result, int op, const int *actual,
                         int count, bool positional) {
    if (result < 0 || op < 0)
        return -1;
    for (int i = 0; i < count; i++)
        if (actual[i] < 0)
            return -1;
    const char **ids = cbm_arena_alloc(&c->result->arena, (size_t)(count + 1) * sizeof(*ids));
    if (!ids) {
        c->oom = true;
        return -1;
    }
    for (int i = 0; i < count; i++)
        ids[i] = c->values[actual[i]].id;
    GROW(c, callsites, nc, cc);
    c->callsites[c->nc++] = (cbm_flow_callsite_t){.operation_id = c->operations[op].id,
                                                  .result_value_id = c->values[result].id,
                                                  .symbol = copy(c, symbol(c)),
                                                  .argument_value_ids = ids,
                                                  .argument_count = (size_t)count,
                                                  .start_byte = start(n),
                                                  .end_byte = end(n),
                                                  .positional = positional};
    return 0;
}
static int function_port(flow_context *c, flow_function *fn) {
    if (fn->invalid || fn->return_value < 0 || !fn->name[0])
        return -1;
    for (int i = 0; i < fn->parameter_count; i++)
        if (fn->parameter_values[i] < 0)
            return -1;
    const char **ids =
        cbm_arena_alloc(&c->result->arena, (size_t)(fn->parameter_count + 1) * sizeof(*ids));
    if (!ids) {
        c->oom = true;
        return -1;
    }
    for (int i = 0; i < fn->parameter_count; i++)
        ids[i] = c->values[fn->parameter_values[i]].id;
    GROW(c, function_ports, nfp, cfp);
    c->function_ports[c->nfp++] =
        (cbm_flow_function_t){.symbol = fn->symbol,
                              .name = fn->name,
                              .return_value_id = c->values[fn->return_value].id,
                              .parameter_value_ids = ids,
                              .parameter_count = (size_t)fn->parameter_count,
                              .start_byte = start(fn->node),
                              .end_byte = end(fn->node),
                              .start_line = line(fn->node),
                              .end_line = end_line(fn->node),
                              .positional = !c->dynamic_scope && !fn->call_unsupported &&
                                            !fn->method && fn->parent < 0 && !fn->ambiguous_write,
                              .method = fn->method,
                              .lexical_capture = fn->parent >= 0};
    return 0;
}
static int call(flow_context *c, TSNode n, int depth) {
    TSNode callee = field(n, "function");
    if (ts_node_is_null(callee))
        callee = field(n, "name");
    TSNode arguments = field(n, "arguments");
    int actual[MAX_PARAMS], count = 0;
    bool positional = !c->dynamic_scope && simple_name(callee) && !ts_node_is_null(arguments);
    for (uint32_t i = 0; i < named_count(arguments); i++) {
        TSNode arg = ts_node_named_child(arguments, i);
        if (is(arg, "comment"))
            continue;
        if (count == MAX_PARAMS) {
            c->limited = true;
            positional = false;
            break;
        }
        if (!positional_argument(arg, 0))
            positional = false;
        actual[count++] = expr(c, unwrap(arg), depth + 1);
        if (implicit_conversion_family(c->language) && !primitive_value(c, actual[count - 1]))
            positional = false;
    }
    int target = -1, matches = 0;
    const char *name = simple_name(callee) ? identifier(c, callee) : "";
    if (positional && name[0] && find_binding(c, name, c->scope, true) < 0) {
        for (size_t i = 0; i < c->nfn; i++) {
            flow_function *fn = &c->functions[i];
            if (!fn->invalid && !fn->method && !fn->ambiguous_write && !fn->call_unsupported &&
                strcmp(fn->name, name) == 0 && fn->parameter_count == count &&
                start(n) >= fn->scope_start && end(n) <= fn->scope_end &&
                (fn->parent == -1 || fn->parent == c->function ||
                 fn->parent == c->functions[c->function].parent)) {
                target = (int)i;
                matches++;
            }
        }
    }
    /* Resolving a call target does not prove its effects. Even a top-level
     * function can invoke a supplied callback or a previously registered
     * closure from global state. Keep evaluated argument/result occurrences,
     * but no current caller binding survives without an effect summary. */
    (void)gap(
        c, n, "call_effects",
        "The call has no verified lexical side-effect summary; visible locals are invalidated.");
    invalidate_locals(c, n);
    int result = value(c, n, matches == 1 ? "call_result" : "unknown", NULL, "[]", 0, -1);
    int op = operation(c, n, "call", name);
    if (matches != 1) {
        (void)callsite_port(c, n, result, op, actual, count, positional);
        (void)gap(c, n, "unresolved_call",
                  "Dynamic, overloaded, member, cross-file or shadowed calls need an exact "
                  "callsite/argument summary.");
        for (int i = 0; i < count; i++) {
            (void)link_values(c, actual[i], result, op, "unknown", "unknown", "");
        }
        return result;
    }
    flow_function *fn = &c->functions[target];
    const char *site = op >= 0 ? c->operations[op].id : "";
    for (int i = 0; i < count; i++)
        (void)link_values(c, actual[i], fn->parameter_values[i], op, "argument", "proven", site);
    (void)link_values(c, fn->return_value, result, op, "return", "proven", site);
    if (result >= 0)
        c->primitive[result] = fn->primitive_return;
    return result;
}
static bool primitive_literal(TSNode n) {
    const char *types[] = {"number",
                           "integer",
                           "float",
                           "true",
                           "false",
                           "null",
                           "none",
                           "boolean",
                           "string",
                           "number_literal",
                           "integer_literal",
                           "int_literal",
                           "float_literal",
                           "real_literal",
                           "floating_point_literal",
                           "boolean_literal",
                           "char_literal",
                           "character_literal",
                           "decimal_integer_literal",
                           "hex_integer_literal",
                           "octal_integer_literal",
                           "binary_integer_literal",
                           "decimal_floating_point_literal",
                           "hex_floating_point_literal",
                           "null_literal",
                           "string_literal",
                           "raw_string_literal",
                           "interpreted_string_literal",
                           "rune_literal"};
    for (size_t i = 0; i < sizeof(types) / sizeof(types[0]); i++)
        if (is(n, types[i]))
            return true;
    return false;
}
static bool interpolated_literal(flow_context *c, TSNode n, int depth) {
    if (!budget(c, n, depth))
        return true;
    const char *type = ts_node_type(n);
    if (strstr(type, "interpolat") || strstr(type, "template") || strstr(type, "substitution"))
        return true;
    for (uint32_t i = 0; i < named_count(n); i++)
        if (interpolated_literal(c, ts_node_named_child(n, i), depth + 1))
            return true;
    return false;
}
static void operator_effects(flow_context *c, TSNode n, bool primitive) {
    if (primitive)
        return;
    invalidate_heap_effects(c, n);
    (void)gap(c, n, "operator_effects",
              "Operand coercion, overloaded operators or truthiness may execute user code; "
              "mutable reaching locals require a verified primitive evaluation.");
}
static void operator_operand(flow_context *c, int operand, int result, int op, bool primitive) {
    /* An unresolved coercion/overload is an opaque call boundary. Syntax alone
     * does not establish a transformation from its operand to its result. */
    (void)link_values(c, operand, result, op, primitive ? "derive" : "unknown",
                      primitive ? "derived" : "unknown", "");
}
static int expr(flow_context *c, TSNode n, int depth) {
    if (ts_node_is_null(n) || !budget(c, n, depth))
        return -1;
    n = unwrap(n);
    if (simple_name(n))
        return read_binding(c, n, find_binding(c, identifier(c, n), c->scope, true));
    if (member_node(n))
        return member_read(c, n);
    if (is(n, "call_expression") || is(n, "function_call_expression") ||
        is(n, "invocation_expression"))
        return call(c, n, depth);
    if (is(n, "assignment_expression") || is(n, "assignment") || is(n, "assignment_statement") ||
        is(n, "augmented_assignment") || is(n, "augmented_assignment_expression")) {
        TSNode lhs = field(n, "left"), rhs = field(n, "right");
        if (ts_node_is_null(lhs))
            lhs = ts_node_named_child(n, 0);
        if (ts_node_is_null(rhs))
            rhs = ts_node_named_child(n, named_count(n) - 1);
        const char *op_name = operator_text(c, n);
        if (!strcmp(op_name, "&&=") || !strcmp(op_name, "||=") ||
            !strcmp(op_name, "?"
                             "?=")) {
            invalidate_locals(c, n);
            return unknown(c, n, "short_circuit",
                           "Conditional assignment does not prove that its RHS was evaluated.");
        }
        int left = -1;
        bool compound = op_name[0] && strcmp(op_name, "=") != 0;
        if (compound)
            left = expr(c, lhs, depth + 1);
        int right = expr(c, rhs, depth + 1);
        if (compound) {
            bool primitive = primitive_value(c, left) && primitive_value(c, right);
            operator_effects(c, n, primitive);
            int derived = value(c, n, "expression", NULL, "[]", 0, -1);
            if (derived >= 0)
                c->primitive[derived] = primitive;
            int op = operation(c, n, "compound_assign", op_name);
            operator_operand(c, left, derived, op, primitive);
            operator_operand(c, right, derived, op, primitive);
            right = derived;
        }
        return assign(c, lhs, right, n, false, false);
    }
    if (is(n, "update_expression")) {
        TSNode arg = field(n, "argument");
        if (ts_node_is_null(arg))
            arg = ts_node_named_child(n, 0);
        int old = expr(c, arg, depth + 1);
        bool primitive = primitive_value(c, old);
        operator_effects(c, n, primitive);
        int changed = value(c, n, "expression", NULL, "[]", 0, -1);
        if (changed >= 0)
            c->primitive[changed] = primitive;
        int op = operation(c, n, "update", operator_text(c, n));
        operator_operand(c, old, changed, op, primitive);
        int written = assign(c, arg, changed, n, false, false);
        if (start(arg) != start(n))
            return written;
        /* Postfix returns the converted old value, not the original object or
         * string reference. Even pure numeric conversion is a derivation. */
        int previous = value(c, n, "expression", NULL, "[]", 0, -1);
        if (previous >= 0)
            c->primitive[previous] = primitive;
        operator_operand(c, old, previous, op, primitive);
        return previous;
    }
    if (is(n, "unary_expression") || is(n, "unary_operator") || is(n, "prefix_unary_expression") ||
        is(n, "prefix_expression") || is(n, "unary_op_expression") || is(n, "not_operator")) {
        const char *op_name = operator_text(c, n);
        if (is(n, "not_operator"))
            op_name = "not";
        if (!strcmp(op_name, "+") || !strcmp(op_name, "-") || !strcmp(op_name, "!") ||
            !strcmp(op_name, "~") || !strcmp(op_name, "not")) {
            TSNode arg = field(n, "argument");
            if (ts_node_is_null(arg))
                arg = field(n, "operand");
            if (ts_node_is_null(arg))
                arg = ts_node_named_child(n, named_count(n) - 1);
            int old = expr(c, arg, depth + 1);
            bool primitive = primitive_value(c, old);
            operator_effects(c, n, primitive);
            int derived = value(c, n, "expression", NULL, "[]", 0, -1);
            if (derived >= 0)
                c->primitive[derived] = primitive;
            int op = operation(c, n, "unary", op_name);
            operator_operand(c, old, derived, op, primitive);
            return derived;
        }
    }
    if (is(n, "binary_expression") || is(n, "binary_operator") || is(n, "additive_expression") ||
        is(n, "multiplicative_expression") || is(n, "comparison_expression")) {
        const char *binary_operator = operator_text(c, n);
        if (strcmp(binary_operator, "&&") == 0 || strcmp(binary_operator, "||") == 0 ||
            strcmp(binary_operator, "??") == 0 || strcmp(binary_operator, "and") == 0 ||
            strcmp(binary_operator, "or") == 0) {
            invalidate_locals(c, n);
            return unknown(c, n, "short_circuit",
                           "Conditional operand evaluation needs a dedicated control-flow rule; "
                           "unevaluated operands do not transport values.");
        }
        TSNode left = field(n, "left"), right = field(n, "right");
        if (ts_node_is_null(left))
            left = ts_node_named_child(n, 0);
        if (ts_node_is_null(right))
            right = ts_node_named_child(n, named_count(n) - 1);
        int a = expr(c, left, depth + 1), b = expr(c, right, depth + 1);
        bool primitive = primitive_value(c, a) && primitive_value(c, b);
        operator_effects(c, n, primitive);
        int v = value(c, n, "expression", NULL, "[]", 0, -1),
            op = operation(c, n, "binary", operator_text(c, n));
        if (v >= 0)
            c->primitive[v] = primitive;
        operator_operand(c, a, v, op, primitive);
        operator_operand(c, b, v, op, primitive);
        return v;
    }
    if (primitive_literal(n)) {
        if (interpolated_literal(c, n, depth + 1)) {
            invalidate_locals(c, n);
            return unknown(c, n, "interpolation",
                           "String interpolation evaluation and side effects are not modeled by "
                           "this adapter.");
        }
        int v = value(c, n, "literal", NULL, "[]", 0, -1);
        if (v >= 0)
            c->primitive[v] = true;
        return v;
    }
    /* Unsupported syntax is not assumed pure: comma/ternary expressions,
     * destructuring, interpolation and foreign constructs can contain writes. */
    invalidate_locals(c, n);
    return unknown(c, n, "expression_form",
                   "This expression form has no verified value-flow rule.");
}
static void predeclare(flow_context *c, TSNode n, bool recursive, int depth) {
    if (!budget(c, n, depth) || function_node(n))
        return;
    bool js_lexical = js_family(c->language) && is(n, "lexical_declaration");
    bool js_var = js_family(c->language) && is(n, "variable_declaration");
    bool implicit = (c->language == CBM_LANG_PYTHON || c->language == CBM_LANG_PHP) &&
                    (is(n, "assignment") || is(n, "assignment_expression"));
    if (js_lexical || js_var) {
        for (uint32_t i = 0; i < named_count(n); i++) {
            TSNode name = field(ts_node_named_child(n, i), "name");
            if (simple_name(name))
                (void)declare(c, name, js_var ? c->function_scope : c->scope, js_var);
        }
    } else if (implicit) {
        TSNode lhs = unwrap(field(n, "left"));
        if (simple_name(lhs))
            (void)declare(c, lhs, c->function_scope, true);
    }
    if (recursive || is(n, "statement_list") || is(n, "statements"))
        for (uint32_t i = 0; i < named_count(n); i++)
            predeclare(c, ts_node_named_child(n, i), recursive, depth + 1);
}
static void hoist_var(flow_context *c, TSNode n, int depth) {
    if (!budget(c, n, depth) || function_node(n))
        return;
    if (is(n, "variable_declaration"))
        predeclare(c, n, false, depth);
    for (uint32_t i = 0; i < named_count(n); i++)
        hoist_var(c, ts_node_named_child(n, i), depth + 1);
}
static int return_expression(flow_context *c, TSNode n, TSNode expression, int depth) {
    int v = expr(c, expression, depth + 1);
    if (implicit_conversion_family(c->language) &&
        (!c->functions[c->function].primitive_return || !primitive_value(c, v))) {
        invalidate_locals(c, n);
        v = unknown(c, n, "return_conversion",
                    "Returning this value may copy or convert an object through user code; "
                    "no primitive return transport is established.");
    }
    int op = operation(c, n, "return", "");
    (void)link_values(c, v, c->functions[c->function].return_value, op, "assign", "proven", "");
    return v;
}
static bool branch(flow_context *c, TSNode n, int depth) {
    TSNode condition = field(n, "condition"), yes = field(n, "consequence"),
           no = field(n, "alternative");
    if (ts_node_is_null(yes))
        yes = field(n, "body");
    int condition_value = expr(c, condition, depth + 1); /* control only, no field transport */
    if (c->language == CBM_LANG_PYTHON || implicit_conversion_family(c->language))
        operator_effects(c, condition, primitive_value(c, condition_value));
    if (ts_node_is_null(yes)) {
        (void)gap(c, n, "branch_shape", "The branch body could not be identified.");
        invalidate_locals(c, n);
        return false;
    }
    TSNode predicate = unwrap(condition);
    bool literal_boolean = is(predicate, "boolean") || is(predicate, "boolean_literal");
    const char *literal_text = literal_boolean ? text(c, predicate) : "";
    if (is(predicate, "false") || (literal_boolean && strcmp(literal_text, "false") == 0))
        return !ts_node_is_null(no) && statement(c, no, depth + 1);
    if (is(predicate, "true") || (literal_boolean && strcmp(literal_text, "true") == 0))
        return statement(c, yes, depth + 1);
    size_t count = c->nb;
    int *before = cbm_arena_alloc(&c->result->arena, (count + 1) * sizeof(int));
    int *then = cbm_arena_alloc(&c->result->arena, (count + 1) * sizeof(int));
    if (!before || !then) {
        c->oom = true;
        return false;
    }
    for (size_t i = 0; i < count; i++)
        before[i] = c->bindings[i].current;
    bool yes_stops = statement(c, yes, depth + 1);
    for (size_t i = 0; i < count; i++) {
        then[i] = c->bindings[i].current;
        c->bindings[i].current = before[i];
    }
    bool no_stops = !ts_node_is_null(no) && statement(c, no, depth + 1);
    int op = -1;
    for (size_t i = 0; i < count; i++) {
        int a = then[i], b = c->bindings[i].current;
        if (yes_stops && !no_stops)
            continue;
        if (no_stops && !yes_stops) {
            c->bindings[i].current = a;
            continue;
        }
        if (a == b || (yes_stops && no_stops))
            continue;
        if (op < 0)
            op = operation(c, n, "phi", "if");
        int v = value(c, n, "phi", c->bindings[i].id, "[]", ++c->bindings[i].version, -1);
        if (v >= 0)
            c->primitive[v] = primitive_value(c, a) && primitive_value(c, b);
        (void)link_values(c, a, v, op, "phi", "may", "");
        (void)link_values(c, b, v, op, "phi", "may", "");
        c->bindings[i].current = v;
    }
    return yes_stops && no_stops;
}
static void invalidate_visible_locals(flow_context *c, TSNode n, bool preserve_immutable) {
    for (size_t i = 0; i < c->nb; i++) {
        int s = c->scope;
        while (s >= 0 && s != c->bindings[i].scope)
            s = c->scopes[s].parent;
        if (s < 0)
            continue;
        if (preserve_immutable && c->bindings[i].immutable)
            continue;
        c->bindings[i].current =
            value(c, n, "unknown", c->bindings[i].id, "[]", ++c->bindings[i].version, -1);
    }
}
static void invalidate_locals(flow_context *c, TSNode n) {
    invalidate_visible_locals(c, n, false);
}
static void invalidate_heap_effects(flow_context *c, TSNode n) {
    /* A user accessor/overload may invoke a closure that changes visible
     * mutable locals. A JS const binding cannot be rebound; retaining that
     * lexical value does not retain any mutable contents behind it. */
    invalidate_visible_locals(c, n, true);
}
static bool statement(flow_context *c, TSNode n, int depth) {
    if (ts_node_is_null(n) || !budget(c, n, depth))
        return false;
    if (function_node(n) || is(n, "comment") || is(n, "empty_statement"))
        return false;
    if (is(n, "if_statement") || is(n, "if_expression"))
        return branch(c, n, depth);
    if (is(n, "return_statement") || is(n, "return_expression") || is(n, "jump_expression")) {
        if (is(n, "jump_expression") && strncmp(c->source + start(n), "return", 6) != 0) {
            (void)gap(c, n, "jump", "Non-return jumps are not modeled.");
            return true;
        }
        TSNode result = ts_node_named_child(n, 0);
        if (!ts_node_is_null(result))
            (void)return_expression(c, n, result, depth);
        return true;
    }
    const char *kind = ts_node_type(n);
    if (strstr(kind, "for_statement") || strstr(kind, "while_statement") || is(n, "do_statement") ||
        is(n, "for_expression") || is(n, "loop_expression") || is(n, "while_expression") ||
        is(n, "try_statement") || is(n, "try_expression") || strstr(kind, "switch") ||
        is(n, "match_expression")) {
        (void)gap(c, n, "control_flow",
                  "Loops, exceptional control flow and pattern dispatch need a dedicated "
                  "control-flow summary.");
        invalidate_locals(c, n);
        return false;
    }
    if (block_node(n) || is(n, "statement_list") || is(n, "statements") || is(n, "else_clause")) {
        int old_scope = c->scope;
        bool scoped =
            block_node(n) && c->language != CBM_LANG_PYTHON && c->language != CBM_LANG_PHP;
        if (scoped)
            c->scope = new_scope(c, old_scope);
        for (uint32_t i = 0; i < named_count(n); i++)
            predeclare(c, ts_node_named_child(n, i), false, depth + 1);
        bool stops = false;
        uint32_t count = named_count(n);
        for (uint32_t i = 0; i < count && !stops; i++) {
            TSNode child = ts_node_named_child(n, i);
            bool rust_tail = c->language == CBM_LANG_RUST && is(n, "block") && i + 1 == count &&
                             !is(child, "expression_statement") && !is(child, "let_declaration") &&
                             !is(child, "comment") && !is(child, "if_expression");
            if (rust_tail) {
                (void)return_expression(c, child, child, depth);
                stops = true;
            } else
                stops = statement(c, child, depth + 1);
        }
        if ((implicit_conversion_family(c->language) || c->language == CBM_LANG_RUST) &&
            c->scope >= 0 && c->scopes[c->scope].object_lifetime) {
            invalidate_locals(c, n);
            (void)gap(c, n, "object_lifetime",
                      "An automatic object leaves this scope without a verified destructor "
                      "summary; subsequent local reads cannot retain earlier reaching writes.");
        }
        c->scope = old_scope;
        return stops;
    }
    if (is(n, "expression_statement")) {
        for (uint32_t i = 0; i < named_count(n); i++)
            if (statement(c, ts_node_named_child(n, i), depth + 1))
                return true;
        return false;
    }
    if (is(n, "variable_declarator") || is(n, "init_declarator") || is(n, "let_declaration") ||
        is(n, "short_var_declaration") || is(n, "property_declaration")) {
        TSNode lhs = field(n, "name"), rhs = field(n, "value");
        if (ts_node_is_null(lhs))
            lhs = field(n, "declarator");
        if (ts_node_is_null(lhs))
            lhs = field(n, "pattern");
        if (is(n, "short_var_declaration")) {
            lhs = field(n, "left");
            rhs = field(n, "right");
        }
        if (is(n, "property_declaration")) {
            lhs = declarator_name(child_type(n, "variable_declaration"));
            rhs = ts_node_named_child(n, named_count(n) - 1);
            if (is(rhs, "variable_declaration"))
                rhs = (TSNode){0};
        }
        if (c->language == CBM_LANG_CSHARP && is(n, "variable_declarator") &&
            ts_node_is_null(rhs) && named_count(n) > 1)
            rhs = ts_node_named_child(n, named_count(n) - 1);
        bool function_scoped =
            js_family(c->language) && is(ts_node_parent(n), "variable_declaration");
        int initializer = ts_node_is_null(rhs) ? -1 : expr(c, rhs, depth + 1);
        if (c->language == CBM_LANG_RUST && !primitive_value(c, initializer) && c->scope >= 0)
            c->scopes[c->scope].object_lifetime = true;
        (void)assign(c, lhs, initializer, n, true, function_scoped);
        return false;
    }
    if (is(n, "lexical_declaration") || is(n, "variable_declaration") ||
        is(n, "local_variable_declaration") || is(n, "local_declaration_statement") ||
        is(n, "declaration")) {
        if (cpp_family(c->language) && is(n, "declaration")) {
            TSNode type = field(n, "type");
            if (!primitive_type(c, type) && strcmp(text(c, type), "auto") != 0) {
                c->scopes[c->scope].object_lifetime = true;
                invalidate_locals(c, n);
                (void)gap(c, n, "object_construction",
                          "This declaration has no verified primitive type; constructor and "
                          "destructor effects are not assumed absent.");
            }
        }
        for (uint32_t i = 0; i < named_count(n); i++) {
            TSNode child = ts_node_named_child(n, i);
            if (is(child, "variable_declarator") || is(child, "init_declarator") ||
                is(child, "variable_declaration"))
                (void)statement(c, child, depth + 1);
        }
        return false;
    }
    (void)expr(c, n, depth + 1);
    return false;
}
static void mark_function_writes(flow_context *c, TSNode n, int depth) {
    if (!budget(c, n, depth))
        return;
    /* Dynamic code can replace a function binding without a source-level
     * assignment to its name. Disable both local joins and resolver ports for
     * this file; invalidating current values alone would still bind a later
     * freshly created argument to the obsolete function body. */
    bool dynamic = js_family(c->language) && is(n, "with_statement");
    if (simple_name(n)) {
        const char *name = identifier(c, n);
        if (js_family(c->language))
            dynamic = dynamic || strcmp(name, "eval") == 0 || strcmp(name, "Function") == 0;
        if (c->language == CBM_LANG_PYTHON)
            dynamic = dynamic || strcmp(name, "exec") == 0 || strcmp(name, "eval") == 0 ||
                      strcmp(name, "globals") == 0 || strcmp(name, "locals") == 0 ||
                      strcmp(name, "vars") == 0;
    }
    if (dynamic && !c->dynamic_scope) {
        c->dynamic_scope = true;
        (void)gap(c, n, "dynamic_scope",
                  "Dynamic evaluation or scope access prevents a verified function binding in this "
                  "file; local and external call-target joins are disabled.");
    }
    if (is(n, "assignment_expression") || is(n, "assignment") || is(n, "assignment_statement") ||
        is(n, "update_expression") || is(n, "augmented_assignment")) {
        TSNode lhs = unwrap(field(n, "left"));
        if (ts_node_is_null(lhs))
            lhs = field(n, "argument");
        if (simple_name(lhs)) {
            const char *name = identifier(c, lhs);
            for (size_t i = 0; i < c->nfn; i++)
                if (strcmp(c->functions[i].name, name) == 0)
                    c->functions[i].ambiguous_write = true;
        }
    }
    if (is(n, "preproc_if") || is(n, "preproc_ifdef"))
        (void)gap(c, n, "conditional_compilation",
                  "Raw-source branches are indexed without a compiler configuration; active macro "
                  "branches are not established.");
    for (uint32_t i = 0; i < named_count(n); i++)
        mark_function_writes(c, ts_node_named_child(n, i), depth + 1);
}
typedef struct {
    uint64_t deadline;
    bool expired;
} parse_budget;
/* TSParseOptions requires this exact non-const callback signature. */
// cppcheck-suppress constParameterCallback
static bool parse_progress(TSParseState *state) {
    parse_budget *b = state->payload;
    b->expired = cbm_now_ms() >= b->deadline;
    return b->expired;
}
int cbm_flow_extract_source(const char *source, int source_len, CBMLanguage language,
                            const char *project, const char *rel_path,
                            cbm_flow_extraction_t **out) {
    if (!out)
        return CBM_STORE_ERR;
    *out = NULL;
    if (!source || source_len < 0 || !project || !project[0] || !rel_path || !rel_path[0])
        return CBM_STORE_ERR;
    cbm_flow_extraction_t *result = cbm_calloc(CBM_MEM_CLASS_OTHER, sizeof(*result));
    if (!result)
        return CBM_STORE_ERR;
    cbm_arena_init_lazy(&result->arena, 16384);
    result->language = language;
    flow_context c = {.result = result,
                      .source = source,
                      .source_len = source_len,
                      .language = language,
                      .function = -1,
                      .scope = -1,
                      .function_scope = -1,
                      .deadline = cbm_now_ms() + 2000};
    char hash[CBM_SHA256_HEX_LEN + 1];
    cbm_sha256_hex(source, (size_t)source_len, hash);
    result->file.source_hash = copy(&c, hash);
    cbm_sha256_ctx identity;
    uint8_t raw[CBM_SHA256_DIGEST_LEN];
    cbm_sha256_init(&identity);
    cbm_sha256_update(&identity, project, strlen(project) + 1);
    cbm_sha256_update(&identity, rel_path, strlen(rel_path) + 1);
    cbm_sha256_update(&identity, hash, strlen(hash));
    cbm_sha256_final(&identity, raw);
    for (size_t i = 0; i < sizeof(raw); i++)
        (void)snprintf(hash + i * 2, 3, "%02x", raw[i]);
    c.identity = copy(&c, hash);
    result->file.adapter = copy(&c, "tree-sitter-lexical-flow");
    result->file.adapter_version = 4;
    TSParser *parser = NULL;
    TSTree *tree = NULL;
    if (!cbm_flow_extract_supports_language(language))
        (void)gap(&c, (TSNode){0}, "unsupported_language",
                  "No semantic value-flow adapter is implemented for this language.");
    else if (source_len > MAX_SOURCE)
        (void)gap(&c, (TSNode){0}, "source_limit",
                  "The source exceeds the bounded flow adapter input size.");
    else {
        parser = ts_parser_new();
        if (!parser || !ts_parser_set_language(parser, cbm_ts_language(language)))
            goto failure;
        parse_budget b = {.deadline = cbm_now_ms() + 1000};
        tree =
            cbm_parse_source(parser, source, (uint32_t)source_len,
                             (TSParseOptions){.payload = &b, .progress_callback = parse_progress});
        if (!tree) {
            if (!b.expired)
                goto failure;
            (void)gap(&c, (TSNode){0}, "parse_budget",
                      "The parser exceeded the local flow-analysis time budget.");
        } else {
            TSNode root = ts_tree_root_node(tree);
            collect_functions(&c, root, -1, 0);
            mark_function_writes(&c, root, 0);
            signatures(&c);
            for (size_t i = 0; i < c.nfn && !c.oom && !c.limited; i++) {
                flow_function *fn = &c.functions[i];
                if (fn->invalid)
                    continue;
                c.function = (int)i;
                c.function_scope = new_scope(&c, -1);
                c.scope = c.function_scope;
                for (int p = 0; p < fn->parameter_count; p++) {
                    int binding = declare(&c, fn->parameter_nodes[p], c.scope, true);
                    if (binding >= 0 && fn->parameter_values[p] >= 0) {
                        c.bindings[binding].id = c.values[fn->parameter_values[p]].binding;
                        c.bindings[binding].current = fn->parameter_values[p];
                    }
                }
                if (c.language == CBM_LANG_PYTHON || c.language == CBM_LANG_PHP)
                    predeclare(&c, fn->body, true, 0);
                if (js_family(c.language))
                    hoist_var(&c, fn->body, 0);
                if (block_node(fn->body))
                    (void)statement(&c, fn->body, 0);
                else
                    (void)return_expression(&c, fn->body, fn->body, 0);
            }
            for (size_t i = 0; i < c.nfn && !c.oom; i++)
                (void)function_port(&c, &c.functions[i]);
            if (ts_node_has_error(root))
                (void)gap(&c, root, "parse_error",
                          "The raw source contains syntax errors; affected functions are omitted.");
            if (!c.nfn)
                (void)gap(&c, root, "module_flow",
                          "No supported named function body was found; module initialization flow "
                          "is not modeled.");
        }
    }
    if (c.oom)
        goto failure;
    if (c.limited)
        (void)gap(&c, (TSNode){0}, "analysis_limit",
                  "The adapter reached a source, walk or record limit; the result is incomplete.");
    result->file.values = c.values;
    result->file.value_count = c.nv;
    result->file.operations = c.operations;
    result->file.operation_count = c.no;
    result->file.links = c.links;
    result->file.link_count = c.nl;
    result->file.gaps = c.gaps;
    result->file.gap_count = c.ng;
    result->file.functions = c.function_ports;
    result->file.function_count = c.nfp;
    result->file.callsites = c.callsites;
    result->file.callsite_count = c.nc;
    ts_tree_delete(tree);
    ts_parser_delete(parser);
    *out = result;
    return CBM_STORE_OK;
failure:
    ts_tree_delete(tree);
    ts_parser_delete(parser);
    cbm_flow_extraction_free(result);
    return CBM_STORE_ERR;
}
void cbm_flow_extraction_free(cbm_flow_extraction_t *result) {
    if (!result)
        return;
    cbm_arena_destroy(&result->arena);
    cbm_free(CBM_MEM_CLASS_OTHER, result);
}
