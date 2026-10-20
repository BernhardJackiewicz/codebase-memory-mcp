#ifndef CBM_FLOW_IR_H
#define CBM_FLOW_IR_H

#include "store/store.h"

#define CBM_FLOW_IR_SCHEMA_VERSION 1

/* Flow identities belong to this IR. They are never graph node/edge IDs.
 * access_path is a JSON string array below the resolved lexical binding.
 * Each write/expression has a distinct value; version is local to binding. */
typedef struct {
    const char *id;
    const char *symbol;
    const char *binding;
    const char *access_path;
    const char *kind;
    int64_t symbol_node_id; /* Optional source anchor, not value identity. */
    int version;
    int start_byte, end_byte, start_line, end_line;
    int parameter_index; /* -1 except formal parameters. */
} cbm_flow_value_t;

typedef struct {
    const char *id;
    const char *symbol;
    const char *kind;
    const char *operator_name;
    int start_byte, end_byte, start_line, end_line;
} cbm_flow_operation_t;

typedef struct {
    const char *id;
    const char *source;
    const char *target;
    const char *operation_id;
    const char *kind;
    /* proven / may / derived / control / unknown. These describe evidence,
     * not a probability. Control links do not transport field values. */
    const char *certainty;
    /* Required for argument/return links. It matches one lexical call site;
     * the bounded traversal stack must match returns to calls. */
    const char *callsite_id;
} cbm_flow_link_t;

typedef struct {
    const char *code;
    const char *message;
    const char *symbol;
    int start_byte, end_byte, start_line;
} cbm_flow_gap_t;

/* AST ports are occurrence identities, not callee resolution. A separate
 * resolver witness must bind a cross-file invocation to a declaration. */
typedef struct {
    const char *symbol;
    const char *name;
    const char *return_value_id;
    const char *const *parameter_value_ids;
    size_t parameter_count;
    int start_byte, end_byte, start_line, end_line;
    /* Exact ordinary positional/value ports only. Defaults, destructuring,
     * varargs, keyword binding, ref/out and implicit receivers need rules. */
    bool positional;
    bool method;
    bool lexical_capture;
} cbm_flow_function_t;

typedef struct {
    const char *operation_id;
    const char *result_value_id;
    const char *symbol;
    const char *const *argument_value_ids;
    size_t argument_count;
    int start_byte, end_byte;
    bool positional;
} cbm_flow_callsite_t;

typedef struct {
    const char *source_hash;
    const char *adapter;
    int adapter_version;
    const cbm_flow_value_t *values;
    size_t value_count;
    const cbm_flow_operation_t *operations;
    size_t operation_count;
    const cbm_flow_link_t *links;
    size_t link_count;
    const cbm_flow_gap_t *gaps;
    size_t gap_count;
    /* Body dependencies, not merely exported-signature dependencies. A
     * replaced dependency invalidates dependent summaries transitively. */
    const char *const *dependencies;
    size_t dependency_count;
    const cbm_flow_function_t *functions;
    size_t function_count;
    const cbm_flow_callsite_t *callsites;
    size_t callsite_count;
    /* Optional installed source-package identity. Empty/NULL means ordinary
     * project source. File bodies still use their own exact source_hash. */
    const char *package_id;
    const char *package_version;
    const char *package_manifest_hash;
} cbm_flow_file_t;

typedef struct {
    const char *value_id;
    /* Alternative source selector. Unspecified fields enumerate candidates;
     * multiple matching occurrences require explicit selection. */
    const char *file_path;
    const char *symbol;
    const char *access_path; /* canonical JSON array, or NULL */
    bool has_start_byte;
    int start_byte;
    const char *expected_generation;
    bool backward;
    int max_depth;      /* default 32, ceiling 128 */
    int max_paths;      /* default 32, ceiling 128 */
    int max_states;     /* default 4096, ceiling 16384 */
    int max_call_depth; /* default 4, ceiling 8 */
    uint64_t deadline_ms;
    cbm_store_cancel_fn cancel;
    void *cancel_context;
} cbm_flow_trace_options_t;

typedef struct {
    const char *caller_file;
    const char *caller_hash;
    const char *callee_file;
    const char *callee_hash;
    const char *operation_id;
    const char *callee_symbol;
    const char *caller_qn;
    const char *callee_qn;
    const char *strategy;
    const char *certainty; /* proven or may; confidence alone is not proof. */
    int64_t caller_node_id;
    int64_t callee_node_id;
    int site_start_byte;
    int site_end_byte;
} cbm_flow_binding_t;

/* Writer-only, additive schema. Reader calls never create/migrate tables. */
int cbm_flow_ir_initialize(cbm_store_t *store);
/* Atomically replaces one partition and invalidates dependent summaries.
 * On failure retains the previous partition. Caller publishes graph
 * generation only after its whole indexing transaction is complete. */
int cbm_flow_ir_replace_file(cbm_store_t *store, const char *project, const char *file_path,
                             const cbm_flow_file_t *file);
int cbm_flow_ir_delete_file(cbm_store_t *store, const char *project, const char *file_path);
/* Atomic cross-file port join, only after all file partitions exist. Requires
 * matching raw-source hashes, exact invocation span, canonical graph
 * declaration anchors and supported ordered value ports on both sides.
 * Rejected evidence leaves the original unknown call/gap intact. */
int cbm_flow_ir_bind_call(cbm_store_t *store, const char *project,
                          const cbm_flow_binding_t *binding);
/* An independently resolved ESM import/export witness. Package declarations
 * are exact Flow AST ports, not invented primary graph nodes. The resolver
 * must establish immutable lexical import identity and direct named export. */
typedef struct {
    const char *caller_file, *caller_hash, *callee_file, *callee_hash;
    const char *operation_id, *callee_symbol;
    const char *package_id, *package_version, *manifest_hash, *manifest_path;
    const char *specifier, *imported_name, *local_name;
    int import_start, import_end, export_start, export_end;
} cbm_flow_package_binding_t;
int cbm_flow_ir_bind_package_call(cbm_store_t *store, const char *project,
                                  const cbm_flow_package_binding_t *binding);
/* Read-only bounded slice. Unknown/may/derived links remain explicitly typed;
 * control/unknown links cannot be reported as proven field transport.
 * Returned JSON belongs to CBM_MEM_CLASS_OTHER. */
int cbm_flow_ir_trace(cbm_store_t *store, const char *project,
                      const cbm_flow_trace_options_t *options, char **out_json);

#endif
