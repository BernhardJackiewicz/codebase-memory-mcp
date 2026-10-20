#include "test_framework.h"
#include "flow_extract.h"
#include "foundation/mem_core.h"
#include <yyjson/yyjson.h>

static const cbm_flow_value_t *extract_kind(cbm_flow_extraction_t *result, const char *kind) {
    for (size_t i = 0; i < result->file.value_count; i++)
        if (strcmp(result->file.values[i].kind, kind) == 0)
            return &result->file.values[i];
    return NULL;
}

static bool extract_reaches(cbm_flow_extraction_t *result, const char *path, const char *source,
                            const char *kind, const char *target_id) {
    cbm_store_t *store = cbm_store_open_memory();
    if (!store)
        return false;
    bool found = false;
    cbm_store_upsert_project(store, "flow", "/tmp/flow");
    if (cbm_flow_ir_initialize(store) == CBM_STORE_OK &&
        cbm_flow_ir_replace_file(store, "flow", path, &result->file) == CBM_STORE_OK) {
        cbm_flow_trace_options_t options = {.value_id = source};
        char *json = NULL;
        if (cbm_flow_ir_trace(store, "flow", &options, &json) == CBM_STORE_OK) {
            yyjson_doc *doc = yyjson_read(json, strlen(json), 0);
            yyjson_val *values = yyjson_obj_get(yyjson_doc_get_root(doc), "values");
            size_t i, count;
            yyjson_val *value;
            yyjson_arr_foreach(values, i, count, value) {
                const char *actual = yyjson_get_str(yyjson_obj_get(value, "kind"));
                const char *id = yyjson_get_str(yyjson_obj_get(value, "id"));
                if (actual && strcmp(actual, kind) == 0 &&
                    (!target_id || (id && strcmp(id, target_id) == 0)))
                    found = true;
            }
            yyjson_doc_free(doc);
            cbm_free(CBM_MEM_CLASS_OTHER, json);
        }
    }
    cbm_store_close(store);
    return found;
}

static bool extract_reaches_kind(cbm_flow_extraction_t *result, const char *path,
                                 const char *source, const char *kind) {
    return extract_reaches(result, path, source, kind, NULL);
}

static const cbm_flow_value_t *extract_function_kind(cbm_flow_extraction_t *result,
                                                     const char *function, const char *kind) {
    size_t length = strlen(function);
    for (size_t i = 0; i < result->file.value_count; i++) {
        const cbm_flow_value_t *value = &result->file.values[i];
        if (strcmp(value->kind, kind) == 0 && strncmp(value->symbol, function, length) == 0 &&
            value->symbol[length] == '@')
            return value;
    }
    return NULL;
}

TEST(flow_extract_real_ast_assignment_parameter_return_per_semantic_language) {
    static const struct {
        CBMLanguage language;
        const char *path;
        const char *source;
    } fixtures[] = {
        {CBM_LANG_JAVASCRIPT, "a.js", "function f(input) { let output = input; return output; }"},
        {CBM_LANG_TYPESCRIPT, "a.ts",
         "function f(input: string): string { let output = input; return output; }"},
        {CBM_LANG_TSX, "a.tsx",
         "function f(input: string): string { let output = input; return output; }"},
        {CBM_LANG_PYTHON, "a.py", "def f(input):\n    output = input\n    return output\n"},
        {CBM_LANG_GO, "a.go",
         "package p\nfunc f(input string) string { output := input; return output }\n"},
        {CBM_LANG_RUST, "a.rs", "fn f(input: i32) -> i32 { let output = input; return output; }\n"},
        {CBM_LANG_JAVA, "A.java",
         "class A { int f(int input) { int output = input; return output; } }"},
        {CBM_LANG_KOTLIN, "a.kt", "fun f(input: Int): Int { val output = input; return output }\n"},
        {CBM_LANG_CSHARP, "A.cs",
         "class A { int F(int input) { int output = input; return output; } }"},
        {CBM_LANG_PHP, "a.php", "<?php function f($input) { $output = $input; return $output; }"},
        {CBM_LANG_C, "a.c", "int f(int input) { int output = input; return output; }"},
        {CBM_LANG_CPP, "a.cpp", "int f(int input) { int output = input; return output; }"},
        {CBM_LANG_CUDA, "a.cu", "int f(int input) { int output = input; return output; }"},
    };
    for (size_t i = 0; i < sizeof(fixtures) / sizeof(fixtures[0]); i++) {
        cbm_flow_extraction_t *result = NULL;
        ASSERT_EQ(cbm_flow_extract_source(fixtures[i].source, (int)strlen(fixtures[i].source),
                                          fixtures[i].language, "flow", fixtures[i].path, &result),
                  CBM_STORE_OK);
        ASSERT_NOT_NULL(result);
        const cbm_flow_value_t *parameter = extract_kind(result, "parameter");
        ASSERT_NOT_NULL(parameter);
        ASSERT_TRUE(extract_reaches_kind(result, fixtures[i].path, parameter->id, "return"));
        cbm_flow_extraction_free(result);
    }
    PASS();
}

TEST(flow_extract_overwrite_kills_old_value_and_shadow_preserves_outer_binding) {
    const char *overwrite = "function f(input) { let x = input; x = 0; return x; }";
    const char *shadow = "function f(input) { let x = input; { let x = 0; } return x; }";
    const char *sources[] = {overwrite, shadow};
    for (int i = 0; i < 2; i++) {
        cbm_flow_extraction_t *result = NULL;
        ASSERT_EQ(cbm_flow_extract_source(sources[i], (int)strlen(sources[i]), CBM_LANG_JAVASCRIPT,
                                          "flow", "a.js", &result),
                  CBM_STORE_OK);
        ASSERT_NOT_NULL(result);
        const cbm_flow_value_t *parameter = extract_kind(result, "parameter");
        ASSERT_NOT_NULL(parameter);
        ASSERT_EQ(extract_reaches_kind(result, "a.js", parameter->id, "return"), i == 1);
        cbm_flow_extraction_free(result);
    }
    PASS();
}

TEST(flow_extract_fields_remain_distinct_and_branch_phi_preserves_alternatives) {
    const char *fields = "function f(a) { const x = a.email; const y = a.name; return x; }";
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(fields, (int)strlen(fields), CBM_LANG_JAVASCRIPT, "flow",
                                      "a.js", &result),
              CBM_STORE_OK);
    const cbm_flow_value_t *email = NULL, *name = NULL;
    for (size_t i = 0; i < result->file.value_count; i++) {
        const cbm_flow_value_t *value = &result->file.values[i];
        if (strcmp(value->access_path, "[\"email\"]") == 0)
            email = value;
        if (strcmp(value->access_path, "[\"name\"]") == 0)
            name = value;
    }
    ASSERT_NOT_NULL(email);
    ASSERT_NOT_NULL(name);
    ASSERT_TRUE(extract_reaches_kind(result, "a.js", email->id, "return"));
    ASSERT_FALSE(extract_reaches_kind(result, "a.js", name->id, "return"));
    cbm_flow_extraction_free(result);

    const char *branch =
        "function f(input, flag) { let x = input; if (flag) { x = 0; } return x; }";
    ASSERT_EQ(cbm_flow_extract_source(branch, (int)strlen(branch), CBM_LANG_JAVASCRIPT, "flow",
                                      "a.js", &result),
              CBM_STORE_OK);
    const cbm_flow_value_t *parameter = extract_kind(result, "parameter");
    ASSERT_NOT_NULL(parameter);
    ASSERT_TRUE(extract_reaches_kind(result, "a.js", parameter->id, "return"));
    bool phi = false, may = false;
    for (size_t i = 0; i < result->file.operation_count; i++)
        if (strcmp(result->file.operations[i].kind, "phi") == 0)
            phi = true;
    for (size_t i = 0; i < result->file.link_count; i++)
        if (strcmp(result->file.links[i].certainty, "may") == 0)
            may = true;
    ASSERT_TRUE(phi);
    ASSERT_TRUE(may);
    cbm_flow_extraction_free(result);
    PASS();
}

static int extract_side_effect_case(const char *source) {
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(source, (int)strlen(source), CBM_LANG_JAVASCRIPT, "flow",
                                      "side-effects.js", &result),
              CBM_STORE_OK);
    const cbm_flow_value_t *parameter = extract_function_kind(result, "f", "parameter");
    const cbm_flow_value_t *returned = extract_function_kind(result, "f", "return");
    ASSERT_NOT_NULL(parameter);
    ASSERT_NOT_NULL(returned);
    ASSERT_FALSE(extract_reaches(result, "side-effects.js", parameter->id, "return", returned->id));
    ASSERT_GT(result->file.gap_count, 0);
    cbm_flow_extraction_free(result);
    PASS();
}

TEST(flow_extract_comma_write_invalidates_stale_value) {
    return extract_side_effect_case("function f(input) { let x=input; (x=0, 1); return x; }");
}

TEST(flow_extract_ternary_write_invalidates_stale_value) {
    return extract_side_effect_case(
        "function f(input, flag) { let x=input; (flag ? (x=0) : (x=1)); return x; }");
}

TEST(flow_extract_direct_eval_invalidates_stale_value) {
    return extract_side_effect_case("function f(input) { let x=input; eval('x=0'); return x; }");
}

TEST(flow_extract_closure_write_invalidates_stale_value) {
    return extract_side_effect_case(
        "function f(input) { let x=input; function g(){x=0;} g(); return x; }");
}

TEST(flow_extract_top_level_callee_callback_invalidates_caller_lexicals) {
    static const struct {
        CBMLanguage language;
        const char *path, *source;
    } fixtures[] = {
        {CBM_LANG_JAVASCRIPT, "callback.js",
         "function apply(cb){cb();return 0;} function f(input){let x=input;function "
         "mutate(){x=0;}apply(mutate);return x;}"},
        {CBM_LANG_TYPESCRIPT, "callback.ts",
         "function apply(cb:()=>void){cb();return 0;} function f(input:number){let "
         "x=input;function mutate(){x=0;}apply(mutate);return x;}"},
        {CBM_LANG_TSX, "callback.tsx",
         "function apply(cb:()=>void){cb();return 0;} function f(input:number){let "
         "x=input;function mutate(){x=0;}apply(mutate);return x;}"},
        {CBM_LANG_PYTHON, "callback.py",
         "def apply(cb):\n    cb()\n    return 0\ndef f(input):\n    x=input\n    def mutate():\n  "
         "      nonlocal x\n        x=0\n    apply(mutate)\n    return x\n"},
    };
    for (size_t i = 0; i < sizeof(fixtures) / sizeof(fixtures[0]); i++) {
        cbm_flow_extraction_t *result = NULL;
        ASSERT_EQ(cbm_flow_extract_source(fixtures[i].source, (int)strlen(fixtures[i].source),
                                          fixtures[i].language, "flow", fixtures[i].path, &result),
                  CBM_STORE_OK);
        const cbm_flow_value_t *parameter = extract_function_kind(result, "f", "parameter");
        const cbm_flow_value_t *returned = extract_function_kind(result, "f", "return");
        ASSERT_NOT_NULL(parameter);
        ASSERT_NOT_NULL(returned);
        ASSERT_FALSE(
            extract_reaches(result, fixtures[i].path, parameter->id, "return", returned->id));
        ASSERT_GT(result->file.gap_count, 0);
        cbm_flow_extraction_free(result);
    }
    PASS();
}

TEST(flow_extract_verified_primitive_operator_results_remain_derived) {
    const char *primitive = "function f(){let x=42;let a=x+1;let b=-a;b+=1;let c=b++;return ++c;}";
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(primitive, (int)strlen(primitive), CBM_LANG_JAVASCRIPT,
                                      "flow", "primitive-results.js", &result),
              CBM_STORE_OK);
    const cbm_flow_value_t *literal = extract_kind(result, "literal");
    ASSERT_NOT_NULL(literal);
    ASSERT_TRUE(extract_reaches_kind(result, "primitive-results.js", literal->id, "return"));
    bool derived = false;
    for (size_t i = 0; i < result->file.link_count; i++) {
        const cbm_flow_link_t *link = &result->file.links[i];
        ASSERT_STR_NEQ(link->certainty, "unknown");
        if (!strcmp(link->kind, "derive")) {
            ASSERT_STR_EQ(link->certainty, "derived");
            derived = true;
        }
    }
    ASSERT_TRUE(derived);
    cbm_flow_extraction_free(result);
    PASS();
}

TEST(flow_extract_top_level_callee_indirect_callback_invalidates_caller_lexicals) {
    /* A callee can invoke a closure through global state without receiving it
     * as an argument. Its top-level declaration is not an effect summary. */
    return extract_side_effect_case(
        "let queued; function apply(){queued();return 0;} "
        "function f(input){let x=input;function mutate(){x=0;}queued=mutate;apply();return x;}");
}

TEST(flow_extract_dynamic_scope_rebinding_blocks_original_callee_proof) {
    static const struct {
        CBMLanguage language;
        const char *path, *source;
    } fixtures[] = {
        {CBM_LANG_JAVASCRIPT, "eval.js",
         "function identity(x){return x;} function f(){eval('identity=x=>0');const fresh=1;return "
         "identity(fresh);}"},
        {CBM_LANG_TYPESCRIPT, "eval.ts",
         "function identity(x:number){return x;} function f(){(eval)('identity=x=>0');const "
         "fresh=1;return identity(fresh);}"},
        {CBM_LANG_PYTHON, "exec.py",
         "def identity(x):\n    return x\ndef f():\n    exec('global identity\\nidentity=lambda "
         "x:0')\n    fresh=1\n    return identity(fresh)\n"},
    };
    for (size_t i = 0; i < sizeof(fixtures) / sizeof(fixtures[0]); i++) {
        cbm_flow_extraction_t *result = NULL;
        ASSERT_EQ(cbm_flow_extract_source(fixtures[i].source, (int)strlen(fixtures[i].source),
                                          fixtures[i].language, "flow", fixtures[i].path, &result),
                  CBM_STORE_OK);
        const cbm_flow_value_t *fresh = NULL;
        int offset = (int)(strstr(fixtures[i].source, "fresh=1") - fixtures[i].source) + 6;
        for (size_t j = 0; j < result->file.value_count; j++)
            if (result->file.values[j].start_byte == offset &&
                strcmp(result->file.values[j].kind, "literal") == 0)
                fresh = &result->file.values[j];
        const cbm_flow_value_t *returned = extract_function_kind(result, "f", "return");
        ASSERT_NOT_NULL(fresh);
        ASSERT_NOT_NULL(returned);
        ASSERT_FALSE(extract_reaches(result, fixtures[i].path, fresh->id, "return", returned->id));
        /* An external resolver must not restore the rejected binding from
         * otherwise positional AST argument/function ports. */
        for (size_t j = 0; j < result->file.callsite_count; j++)
            ASSERT_FALSE(result->file.callsites[j].positional);
        for (size_t j = 0; j < result->file.function_count; j++)
            ASSERT_FALSE(result->file.functions[j].positional);
        ASSERT_GT(result->file.gap_count, 0);
        cbm_flow_extraction_free(result);
    }
    PASS();
}

static int extract_literal_effect_case(CBMLanguage language, const char *path, const char *source,
                                       bool reaches_return) {
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(source, (int)strlen(source), language, "flow", path, &result),
              CBM_STORE_OK);
    const char *selected = strstr(source, "42");
    ASSERT_NOT_NULL(selected);
    const cbm_flow_value_t *literal = NULL;
    for (size_t i = 0; i < result->file.value_count; i++)
        if (result->file.values[i].start_byte == selected - source &&
            strcmp(result->file.values[i].kind, "literal") == 0)
            literal = &result->file.values[i];
    const cbm_flow_value_t *returned = extract_function_kind(result, "f", "return");
    ASSERT_NOT_NULL(literal);
    ASSERT_NOT_NULL(returned);
    bool actual = extract_reaches(result, path, literal->id, "return", returned->id);
    if (actual != reaches_return)
        fprintf(stderr, "operator effect fixture %s has unexpected transport=%d\n", path, actual);
    ASSERT_EQ(actual, reaches_return);
    if (!reaches_return)
        ASSERT_GT(result->file.gap_count, 0);
    cbm_flow_extraction_free(result);
    PASS();
}

TEST(flow_extract_js_operator_coercion_invalidates_mutable_lexicals) {
    const char *operations[] = {"obj+1", "obj-1", "obj<1", "obj==1", "+obj",  "-obj",
                                "~obj",  "obj++", "++obj", "obj+=1", "obj-=1"};
    CBMLanguage languages[] = {CBM_LANG_JAVASCRIPT, CBM_LANG_TYPESCRIPT, CBM_LANG_TSX};
    for (size_t i = 0; i < sizeof(languages) / sizeof(languages[0]); i++)
        for (size_t j = 0; j < sizeof(operations) / sizeof(operations[0]); j++) {
            char source[512], path[64];
            snprintf(source, sizeof(source),
                     "function f(){let x=0;let obj={valueOf(){x=0;return 1;}};"
                     "x=42;const n=(%s);return x;}",
                     operations[j]);
            snprintf(path, sizeof(path), "coercion-%zu-%zu.js", i, j);
            ASSERT_EQ(extract_literal_effect_case(languages[i], path, source, false), 0);
        }
    PASS();
}

TEST(flow_extract_unverified_operators_do_not_transport_operands_to_unknown_results) {
    static const struct {
        CBMLanguage language;
        const char *path, *source;
    } fixtures[] = {
        {CBM_LANG_JAVASCRIPT, "binary.js", "function f(input){return input+1;}"},
        {CBM_LANG_TYPESCRIPT, "binary.ts", "function f(input:any){return input+1;}"},
        {CBM_LANG_TSX, "binary.tsx", "function f(input:any){return input+1;}"},
        {CBM_LANG_JAVASCRIPT, "unary.js", "function f(input){return -input;}"},
        {CBM_LANG_JAVASCRIPT, "compound.js", "function f(input){return input+=1;}"},
        {CBM_LANG_JAVASCRIPT, "prefix.js", "function f(input){return ++input;}"},
        {CBM_LANG_JAVASCRIPT, "postfix.js", "function f(input){return input++;}"},
        {CBM_LANG_PYTHON, "binary.py", "def f(input):\n    return input+1\n"},
        {CBM_LANG_PYTHON, "unary.py", "def f(input):\n    return -input\n"},
        {CBM_LANG_PYTHON, "compound.py", "def f(input):\n    input+=1\n    return input\n"},
    };
    for (size_t i = 0; i < sizeof(fixtures) / sizeof(fixtures[0]); i++) {
        cbm_flow_extraction_t *result = NULL;
        ASSERT_EQ(cbm_flow_extract_source(fixtures[i].source, (int)strlen(fixtures[i].source),
                                          fixtures[i].language, "flow", fixtures[i].path, &result),
                  CBM_STORE_OK);
        const cbm_flow_value_t *input = extract_function_kind(result, "f", "parameter");
        const cbm_flow_value_t *returned = extract_function_kind(result, "f", "return");
        ASSERT_NOT_NULL(input);
        ASSERT_NOT_NULL(returned);
        ASSERT_FALSE(extract_reaches(result, fixtures[i].path, input->id, "return", returned->id));
        bool unknown = false;
        for (size_t j = 0; j < result->file.link_count; j++)
            if (!strcmp(result->file.links[j].certainty, "unknown"))
                unknown = true;
        ASSERT_TRUE(unknown);
        ASSERT_GT(result->file.gap_count, 0);
        cbm_flow_extraction_free(result);
    }
    PASS();
}

TEST(flow_extract_python_operator_and_truthiness_effects_are_boundaries) {
    const char *operations[] = {"n=obj+1", "obj+=1", "n=-obj", "n=not obj", "if obj:\n        y=1"};
    for (size_t i = 0; i < sizeof(operations) / sizeof(operations[0]); i++) {
        char source[1024], path[64];
        snprintf(source, sizeof(source),
                 "def f():\n    x=0\n    class C:\n"
                 "        def __add__(self,n):\n            nonlocal x\n            x=0\n          "
                 "  return 1\n"
                 "        def __iadd__(self,n):\n            nonlocal x\n            x=0\n         "
                 "   return self\n"
                 "        def __neg__(self):\n            nonlocal x\n            x=0\n            "
                 "return 1\n"
                 "        def __bool__(self):\n            nonlocal x\n            x=0\n           "
                 " return True\n"
                 "    obj=C()\n    x=42\n    %s\n    return x\n",
                 operations[i]);
        snprintf(path, sizeof(path), "python-effects-%zu.py", i);
        ASSERT_EQ(extract_literal_effect_case(CBM_LANG_PYTHON, path, source, false), 0);
    }
    PASS();
}

TEST(flow_extract_overloaded_operators_in_typed_families_are_boundaries) {
    static const struct {
        CBMLanguage language;
        const char *path, *source;
    } fixtures[] = {
        {CBM_LANG_CPP, "operator.cpp",
         "struct Box{int &x;Box(int &v):x(v){} int operator+(int){x=0;return 1;}}; int f(){int "
         "x=0;Box obj(x);x=42;int n=obj+1;return x;}"},
        {CBM_LANG_CUDA, "operator.cu",
         "struct Box{int &x;Box(int &v):x(v){} int operator+(int){x=0;return 1;}}; int f(){int "
         "x=0;Box obj(x);x=42;int n=obj+1;return x;}"},
        {CBM_LANG_CSHARP, "operator.cs",
         "using System; class A{class Box{public Action M;public static int operator +(Box b,int "
         "n){b.M();return 1;}} int f(){int x=0;var obj=new Box{M=()=>x=0};x=42;var n=obj+1;return "
         "x;}}"},
        {CBM_LANG_KOTLIN, "operator.kt",
         "class Box(val effect:()->Unit){operator fun plus(n:Int):Int{effect();return 1}} fun "
         "f():Int{var x=0;val obj=Box {x=0};x=42;val n=obj+1;return x}"},
        {CBM_LANG_RUST, "operator.rs",
         "struct Boxed(*mut i32);impl std::ops::Add<i32> for Boxed{type Output=i32;fn "
         "add(self,n:i32)->i32{unsafe{*self.0=0;}1}}fn f()->i32{let mut x=0;let obj=Boxed(&mut "
         "x);x=42;let n=obj+1;return x;}"},
    };
    for (size_t i = 0; i < sizeof(fixtures) / sizeof(fixtures[0]); i++)
        ASSERT_EQ(extract_literal_effect_case(fixtures[i].language, fixtures[i].path,
                                              fixtures[i].source, false),
                  0);
    PASS();
}

TEST(flow_extract_cpp_copy_conversion_assignment_and_scope_lifetime_are_boundaries) {
    const char *sources[] = {
        "struct Box{int &target;Box(int &t):target(t){} Box(const Box "
        "&b):target(b.target){target=0;}};int f(){int x=0;Box obj(x);x=42;Box copy=obj;return x;}",
        "struct Box{int &target;Box(int &t):target(t){} operator int(){target=0;return 1;}};int "
        "f(){int x=0;Box obj(x);x=42;int n=obj;return x;}",
        "struct Box{int &target;Box(int &t):target(t){} Box &operator=(int){target=0;return "
        "*this;}};int f(){int x=0;Box obj(x);x=42;obj=1;return x;}",
        "struct Box{int &target;Box(int &t):target(t){} ~Box(){target=0;}};int f(){int x=0;{Box "
        "obj(x);x=42;}return x;}",
        "struct Box{static int *target;~Box(){*target=0;}};int *Box::target;int f(){int "
        "x=0;Box::target=&x;{Box obj;x=42;}return x;}",
    };
    for (size_t i = 0; i < sizeof(sources) / sizeof(sources[0]); i++) {
        char path[64];
        snprintf(path, sizeof(path), "class-effects-%zu.cpp", i);
        ASSERT_EQ(extract_literal_effect_case(CBM_LANG_CPP, path, sources[i], false), 0);
    }
    PASS();
}

TEST(flow_extract_csharp_implicit_conversion_invalidates_mutable_lexicals) {
    return extract_literal_effect_case(
        CBM_LANG_CSHARP, "conversion.cs",
        "using System;class Box{Action change;public Box(Action a){change=a;}"
        "public static implicit operator int(Box b){b.change();return 1;}}"
        "class App{int f(){int x=0;Box obj=new Box(()=>x=0);x=42;int n=obj;return x;}}",
        false);
}

TEST(flow_extract_compound_and_user_defined_literals_do_not_hide_effects) {
    ASSERT_EQ(extract_literal_effect_case(CBM_LANG_C, "compound.c",
                                          "int f(){int x=42;int y=(int){x=0};return x;}", false),
              0);
    ASSERT_EQ(extract_literal_effect_case(
                  CBM_LANG_CPP, "literal.cpp",
                  "int *target;int operator\"\"_tag(unsigned long long){*target=0;return 1;}int "
                  "f(){int x=0;target=&x;x=42;auto n=1_tag;return x;}",
                  false),
              0);
    PASS();
}

TEST(flow_extract_reference_alias_effects_survive_later_reassignments) {
    ASSERT_EQ(extract_literal_effect_case(CBM_LANG_CPP, "reference.cpp",
                                          "int f(){int x=0;int &y=x;x=42;y=0;return x;}", false),
              0);
    ASSERT_EQ(extract_literal_effect_case(CBM_LANG_PHP, "reference.php",
                                          "<?php function f(){$x=0;$y =& $x;$x=42;$y=0;return $x;}",
                                          false),
              0);
    ASSERT_EQ(extract_literal_effect_case(
                  CBM_LANG_CSHARP, "reference.cs",
                  "class A{int f(){int x=0;ref int y=ref x;x=42;y=0;return x;}}", false),
              0);
    PASS();
}

TEST(flow_extract_string_interpolation_does_not_hide_callback_effects) {
    return extract_literal_effect_case(CBM_LANG_KOTLIN, "interpolation.kt",
                                       "fun f():Int{var x=42;val n=\"${run {x=0;1}}\";return x}",
                                       false);
}

TEST(flow_extract_releasing_unknown_objects_can_change_other_locals) {
    ASSERT_EQ(
        extract_literal_effect_case(
            CBM_LANG_PYTHON, "finalizer.py",
            "def f():\n    x=0\n    class C:\n        def __del__(self):\n            nonlocal x\n "
            "           x=0\n    obj=C()\n    x=42\n    obj=None\n    return x\n",
            false),
        0);
    ASSERT_EQ(extract_literal_effect_case(
                  CBM_LANG_PHP, "finalizer.php",
                  "<?php class Box{private $target;function __construct(&$x){$this->target=&$x;}"
                  "function __destruct(){$this->target=0;}}function f(){$x=0;$obj=new "
                  "Box($x);$x=42;$obj=null;return $x;}",
                  false),
              0);
    PASS();
}

TEST(flow_extract_finalizer_cannot_leave_a_proven_destination_write) {
    return extract_literal_effect_case(
        CBM_LANG_PYTHON, "finalizer-destination.py",
        "def f():\n    x=0\n    class C:\n        def __del__(self):\n            nonlocal x\n     "
        "       x=0\n    x=C()\n    x=42\n    return x\n",
        false);
}

TEST(flow_extract_rust_replacement_drops_the_previous_object) {
    return extract_literal_effect_case(
        CBM_LANG_RUST, "replace-drop.rs",
        "struct Boxed(*mut i32);impl Drop for Boxed{fn drop(&mut self){unsafe{if "
        "!self.0.is_null(){*self.0=0;}}}}"
        "fn f()->i32{let mut x=0;let mut obj=Boxed(&mut x);let "
        "other=Boxed(std::ptr::null_mut());x=42;obj=other;return x;}",
        false);
}

TEST(flow_extract_rust_scope_drop_requires_a_primitive_lifetime) {
    return extract_literal_effect_case(
        CBM_LANG_RUST, "drop.rs",
        "struct Boxed(*mut i32);impl Drop for Boxed{fn drop(&mut self){unsafe{*self.0=0;}}}"
        "fn f()->i32{let mut x=0;{let obj=Boxed(&mut x);x=42;}return x;}",
        false);
}

TEST(flow_extract_verified_primitive_operations_preserve_values_and_results) {
    static const struct {
        CBMLanguage language;
        const char *path, *source;
    } fixtures[] = {
        {CBM_LANG_JAVASCRIPT, "primitive.js",
         "function f(){let x=42;let a=1;const b=a+2;const n=-b;return x;}"},
        {CBM_LANG_TYPESCRIPT, "primitive.ts",
         "function f(){let x=42;let a=1;const b=a+2;const n=-b;return x;}"},
        {CBM_LANG_TSX, "primitive.tsx",
         "function f(){let x=42;let a=1;const b=a+2;const n=-b;return x;}"},
        {CBM_LANG_PYTHON, "primitive.py",
         "def f():\n    x=42\n    a=1\n    b=a+2\n    n=-b\n    if True:\n        y=1\n    return "
         "x\n"},
        {CBM_LANG_CPP, "primitive.cpp", "int f(){int x=42;int a=1;int b=a+2;int n=-b;return x;}"},
        {CBM_LANG_CUDA, "primitive.cu", "int f(){int x=42;int a=1;int b=a+2;int n=-b;return x;}"},
        {CBM_LANG_C, "primitive.c", "int f(){int x=42;int a=1;int b=a+2;int n=-b;return x;}"},
        {CBM_LANG_GO, "primitive.go",
         "package p\nfunc f() int { x:=42; a:=1; b:=a+2; n:=-b; _=n; return x }"},
        {CBM_LANG_RUST, "primitive.rs",
         "fn f()->i32{let x=42;let a=1;let b=a+2;let n=-b;return x;}"},
        {CBM_LANG_JAVA, "primitive.java",
         "class A{int f(){int x=42;int a=1;int b=a+2;int n=-b;return x;}}"},
        {CBM_LANG_KOTLIN, "primitive.kt",
         "fun f():Int{val x=42;val a=1;val b=a+2;val n=-b;return x}"},
        {CBM_LANG_CSHARP, "primitive.cs",
         "class A{int f(){int x=42;int a=1;int b=a+2;int n=-b;return x;}}"},
        {CBM_LANG_PHP, "primitive.php", "<?php function f(){$x=42;$a=1;$b=$a+2;$n=-$b;return $x;}"},
        {CBM_LANG_JAVASCRIPT, "result.js", "function f(){let x=42;x+=1;return -x;}"},
        {CBM_LANG_CPP, "copy-int.cpp", "int f(){int x=42;int copy=x;return copy;}"},
    };
    for (size_t i = 0; i < sizeof(fixtures) / sizeof(fixtures[0]); i++)
        ASSERT_EQ(extract_literal_effect_case(fixtures[i].language, fixtures[i].path,
                                              fixtures[i].source, true),
                  0);
    PASS();
}

TEST(flow_extract_destructuring_write_invalidates_stale_value) {
    return extract_side_effect_case("function f(input) { let x=input; [x]=[0]; return x; }");
}

TEST(flow_extract_local_call_heap_write_invalidates_stale_value) {
    return extract_side_effect_case(
        "function f(a) { clear(a); return a.email; } function clear(x) { x.email=0; }");
}

TEST(flow_extract_local_call_nested_heap_write_invalidates_stale_value) {
    return extract_side_effect_case(
        "function f(a) { clear(a.email); return a.email.name; } function clear(x) { x.name=0; }");
}

TEST(flow_extract_dynamic_field_write_invalidates_stale_value) {
    return extract_side_effect_case("function f(a, key) { a[key]=0; return a.email; }");
}

TEST(flow_extract_exact_local_call_ports_do_not_cross_return_sites) {
    const char *sources[] = {
        "function f(input) { return identity(input); } function identity(value) { return value; }",
        "function f(input) { identity(input); return identity(0); } function identity(value) { "
        "return value; }",
    };
    for (size_t i = 0; i < sizeof(sources) / sizeof(sources[0]); i++) {
        cbm_flow_extraction_t *result = NULL;
        ASSERT_EQ(cbm_flow_extract_source(sources[i], (int)strlen(sources[i]), CBM_LANG_JAVASCRIPT,
                                          "flow", "call-sites.js", &result),
                  CBM_STORE_OK);
        const cbm_flow_value_t *parameter = extract_function_kind(result, "f", "parameter");
        const cbm_flow_value_t *returned = extract_function_kind(result, "f", "return");
        ASSERT_NOT_NULL(parameter);
        ASSERT_NOT_NULL(returned);
        ASSERT_EQ(extract_reaches(result, "call-sites.js", parameter->id, "return", returned->id),
                  i == 0);
        cbm_flow_extraction_free(result);
    }
    PASS();
}

TEST(flow_extract_unmodeled_parameter_preserves_formal_positions) {
    const char *source = "function f(input) { return g(input); } function g({x}, y) { return y; }";
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(source, (int)strlen(source), CBM_LANG_JAVASCRIPT, "flow",
                                      "parameters.js", &result),
              CBM_STORE_OK);
    const cbm_flow_value_t *parameter = extract_function_kind(result, "f", "parameter");
    const cbm_flow_value_t *returned = extract_function_kind(result, "f", "return");
    const cbm_flow_value_t *second = extract_function_kind(result, "g", "parameter");
    ASSERT_NOT_NULL(parameter);
    ASSERT_NOT_NULL(returned);
    ASSERT_NOT_NULL(second);
    ASSERT_EQ(second->parameter_index, 1);
    ASSERT_FALSE(extract_reaches(result, "parameters.js", parameter->id, "return", returned->id));
    cbm_flow_extraction_free(result);
    PASS();
}

TEST(flow_extract_reference_parameter_call_invalidates_caller_storage) {
    const char *source = "<?php function f($input) { $x=$input; clear($x); return $x; } function "
                         "clear(&$x) { $x=0; }";
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(source, (int)strlen(source), CBM_LANG_PHP, "flow",
                                      "references.php", &result),
              CBM_STORE_OK);
    const cbm_flow_value_t *parameter = extract_function_kind(result, "f", "parameter");
    const cbm_flow_value_t *returned = extract_function_kind(result, "f", "return");
    ASSERT_NOT_NULL(parameter);
    ASSERT_NOT_NULL(returned);
    ASSERT_FALSE(extract_reaches(result, "references.php", parameter->id, "return", returned->id));
    ASSERT_GT(result->file.gap_count, 0);
    cbm_flow_extraction_free(result);
    PASS();
}

TEST(flow_extract_cross_file_ports_keep_exact_ast_occurrences) {
    const char *source = "import { g } from './g.js'; function f(input) { return g(input); }";
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(source, (int)strlen(source), CBM_LANG_JAVASCRIPT, "flow",
                                      "ports.js", &result),
              CBM_STORE_OK);
    ASSERT_EQ(result->file.function_count, 1);
    ASSERT_EQ(result->file.callsite_count, 1);
    const cbm_flow_function_t *function = &result->file.functions[0];
    const cbm_flow_callsite_t *site = &result->file.callsites[0];
    ASSERT_STR_EQ(function->name, "f");
    ASSERT_TRUE(function->positional);
    ASSERT_FALSE(function->lexical_capture);
    ASSERT_EQ(function->parameter_count, 1);
    ASSERT_EQ(site->argument_count, 1);
    ASSERT_TRUE(site->positional);
    ASSERT_EQ(site->start_byte, (int)(strstr(source, "g(input)") - source));
    ASSERT_EQ(site->end_byte - site->start_byte, (int)strlen("g(input)"));
    const cbm_flow_value_t *parameter = extract_function_kind(result, "f", "parameter");
    const cbm_flow_value_t *returned = extract_function_kind(result, "f", "return");
    ASSERT_NOT_NULL(parameter);
    ASSERT_NOT_NULL(returned);
    ASSERT_STR_EQ(function->parameter_value_ids[0], parameter->id);
    ASSERT_STR_EQ(function->return_value_id, returned->id);
    /* A port is not resolution: without an exact resolver witness, the input
     * must not acquire a fabricated imported-call return path. */
    ASSERT_FALSE(extract_reaches(result, "ports.js", parameter->id, "return", returned->id));
    cbm_flow_extraction_free(result);
    PASS();
}

TEST(flow_extract_async_call_does_not_transport_raw_return_value) {
    const char *source =
        "function f(input) { return g(input); } async function g(value) { return value; }";
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(source, (int)strlen(source), CBM_LANG_JAVASCRIPT, "flow",
                                      "async.js", &result),
              CBM_STORE_OK);
    const cbm_flow_value_t *parameter = extract_function_kind(result, "f", "parameter");
    const cbm_flow_value_t *returned = extract_function_kind(result, "f", "return");
    ASSERT_NOT_NULL(parameter);
    ASSERT_NOT_NULL(returned);
    ASSERT_FALSE(extract_reaches(result, "async.js", parameter->id, "return", returned->id));
    bool found = false;
    for (size_t i = 0; i < result->file.function_count; i++)
        if (strcmp(result->file.functions[i].name, "g") == 0) {
            found = true;
            ASSERT_FALSE(result->file.functions[i].positional);
        }
    ASSERT_TRUE(found);
    cbm_flow_extraction_free(result);
    PASS();
}

TEST(flow_extract_decorator_prevents_unproven_original_body_binding) {
    const char *source =
        "@replace\ndef g(value):\n    return value\ndef f(input):\n    return g(input)\n";
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(source, (int)strlen(source), CBM_LANG_PYTHON, "flow",
                                      "decorated.py", &result),
              CBM_STORE_OK);
    const cbm_flow_value_t *parameter = extract_function_kind(result, "f", "parameter");
    const cbm_flow_value_t *returned = extract_function_kind(result, "f", "return");
    ASSERT_NOT_NULL(parameter);
    ASSERT_NOT_NULL(returned);
    ASSERT_FALSE(extract_reaches(result, "decorated.py", parameter->id, "return", returned->id));
    ASSERT_GT(result->file.gap_count, 0);
    cbm_flow_extraction_free(result);
    PASS();
}

TEST(flow_extract_generator_port_requires_iterator_summary) {
    const char *source = "def g(value):\n    yield value\n    return value\n";
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(source, (int)strlen(source), CBM_LANG_PYTHON, "flow",
                                      "generator.py", &result),
              CBM_STORE_OK);
    ASSERT_EQ(result->file.function_count, 1);
    ASSERT_FALSE(result->file.functions[0].positional);
    cbm_flow_extraction_free(result);
    PASS();
}

TEST(flow_extract_short_circuit_does_not_transport_unevaluated_operand) {
    return extract_side_effect_case("function f(input) { return false && input; }");
}

TEST(flow_extract_constant_false_branch_has_no_return_transport) {
    const char *source = "function f(input) { if (false) { return input; } return 0; }";
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(source, (int)strlen(source), CBM_LANG_JAVASCRIPT, "flow",
                                      "constant-branch.js", &result),
              CBM_STORE_OK);
    const cbm_flow_value_t *parameter = extract_function_kind(result, "f", "parameter");
    const cbm_flow_value_t *returned = extract_function_kind(result, "f", "return");
    ASSERT_NOT_NULL(parameter);
    ASSERT_NOT_NULL(returned);
    ASSERT_FALSE(
        extract_reaches(result, "constant-branch.js", parameter->id, "return", returned->id));
    cbm_flow_extraction_free(result);
    PASS();
}

TEST(flow_extract_dynamic_member_read_invalidates_nested_writes) {
    return extract_side_effect_case("function f(input, a) { let x=input; a[x=0]; return x; }");
}

TEST(flow_extract_local_call_invalidates_possible_argument_aliases) {
    return extract_side_effect_case("function f(a) { const child=a.email; clear(child); return "
                                    "a.email.name; } function clear(x) { x.name=0; }");
}

TEST(flow_extract_kotlin_unmodeled_call_shape_is_gap_not_null_node_crash) {
    const char *source = "fun f(input: Int): Int { return g(input) }";
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(source, (int)strlen(source), CBM_LANG_KOTLIN, "flow",
                                      "call-shape.kt", &result),
              CBM_STORE_OK);
    const cbm_flow_value_t *parameter = extract_function_kind(result, "f", "parameter");
    ASSERT_NOT_NULL(parameter);
    ASSERT_GT(result->file.gap_count, 0);
    ASSERT_FALSE(extract_reaches_kind(result, "call-shape.kt", parameter->id, "return"));
    cbm_flow_extraction_free(result);
    PASS();
}

TEST(flow_extract_python_annotation_preserves_lexical_parameter_identity) {
    const char *sources[] = {
        "def flow(value: User) -> User:\n    return value\n",
        "def flow(value: list[User] | None) -> list[User] | None:\n    return value\n",
    };
    for (size_t i = 0; i < sizeof(sources) / sizeof(sources[0]); i++) {
        cbm_flow_extraction_t *result = NULL;
        ASSERT_EQ(cbm_flow_extract_source(sources[i], (int)strlen(sources[i]), CBM_LANG_PYTHON,
                                          "flow", "typed.py", &result),
                  CBM_STORE_OK);
        const cbm_flow_value_t *parameter = extract_function_kind(result, "flow", "parameter");
        ASSERT_NOT_NULL(parameter);
        ASSERT_EQ(parameter->parameter_index, 0);
        ASSERT_TRUE(extract_reaches_kind(result, "typed.py", parameter->id, "return"));
        ASSERT_EQ(result->file.functions[0].parameter_count, 1);
        ASSERT_TRUE(result->file.functions[0].positional);
        cbm_flow_extraction_free(result);
    }
    PASS();
}

static int extract_heap_unproven_case(CBMLanguage language, const char *path, const char *source,
                                      bool expect_write_occurrence) {
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(source, (int)strlen(source), language, "flow", path, &result),
              CBM_STORE_OK);
    const cbm_flow_value_t *parameter = extract_function_kind(result, "f", "parameter");
    const cbm_flow_value_t *returned = extract_function_kind(result, "f", "return");
    ASSERT_NOT_NULL(parameter);
    ASSERT_NOT_NULL(returned);
    ASSERT_FALSE(extract_reaches(result, path, parameter->id, "return", returned->id));
    ASSERT_GT(result->file.gap_count, 0);
    /* A syntactic RHS occurrence remains useful evidence, independently of
     * whether an accessor accepts the write or any heap cell retains it. */
    if (expect_write_occurrence) {
        const cbm_flow_value_t *written = extract_function_kind(result, "f", "field_write");
        ASSERT_NOT_NULL(written);
        ASSERT_TRUE(extract_reaches(result, path, parameter->id, "field_write", written->id));
    }
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_store_upsert_project(store, "flow", "/tmp/flow"), CBM_STORE_OK);
    ASSERT_EQ(cbm_flow_ir_initialize(store), CBM_STORE_OK);
    ASSERT_EQ(cbm_flow_ir_replace_file(store, "flow", path, &result->file), CBM_STORE_OK);
    cbm_flow_trace_options_t options = {.value_id = parameter->id};
    char *json = NULL;
    ASSERT_EQ(cbm_flow_ir_trace(store, "flow", &options, &json), CBM_STORE_OK);
    yyjson_doc *doc = yyjson_read(json, strlen(json), 0);
    ASSERT_NOT_NULL(doc);
    yyjson_val *root = yyjson_doc_get_root(doc);
    ASSERT_FALSE(yyjson_get_bool(yyjson_obj_get(root, "complete")));
    ASSERT_GT(yyjson_arr_size(yyjson_obj_get(root, "gaps")), 0);
    yyjson_doc_free(doc);
    cbm_free(CBM_MEM_CLASS_OTHER, json);
    cbm_store_close(store);
    cbm_flow_extraction_free(result);
    PASS();
}

TEST(flow_extract_parent_field_overwrite_cannot_retain_child_heap_proof) {
    return extract_heap_unproven_case(
        CBM_LANG_JAVASCRIPT, "parent-write.js",
        "function f(input,a){a.address.email=input;a.address=0;return a.address.email;}", true);
}

TEST(flow_extract_distinct_parameters_are_not_proven_disjoint_heap_regions) {
    return extract_heap_unproven_case(
        CBM_LANG_JAVASCRIPT, "parameter-alias.js",
        "function f(input,a,b){a.email=input;b.email=0;return a.email;}", true);
}

TEST(flow_extract_getter_setter_can_reject_written_value) {
    return extract_heap_unproven_case(CBM_LANG_JAVASCRIPT, "accessor.js",
                                      "function f(input,a){a.email=input;return a.email;}", true);
}

TEST(flow_extract_heap_transport_requires_semantic_proof_in_every_family) {
    static const struct {
        CBMLanguage language;
        const char *path, *source;
    } fixtures[] = {
        {CBM_LANG_JAVASCRIPT, "a.js", "function f(input,a){a.email=input;return a.email;}"},
        {CBM_LANG_TYPESCRIPT, "a.ts",
         "function f(input:number,a:any){a.email=input;return a.email;}"},
        {CBM_LANG_TSX, "a.tsx", "function f(input:number,a:any){a.email=input;return a.email;}"},
        {CBM_LANG_PYTHON, "a.py", "def f(input,a):\n    a.email=input\n    return a.email\n"},
        {CBM_LANG_GO, "a.go",
         "package p\ntype User struct { email int }\nfunc f(input int,a *User) int { "
         "a.email=input;return a.email }\n"},
        {CBM_LANG_RUST, "a.rs",
         "struct User {email:i32} fn f(input:i32,a:&mut User)->i32 {a.email=input;return "
         "a.email;}"},
        {CBM_LANG_JAVA, "A.java",
         "class User {int email;} class A {int f(int input,User a){a.email=input;return "
         "a.email;}}"},
        {CBM_LANG_KOTLIN, "a.kt", "fun f(input:Int,a:User):Int {a.email=input;return a.email}"},
        {CBM_LANG_CSHARP, "A.cs",
         "class A {int f(int input,User a){a.email=input;return a.email;}}"},
        {CBM_LANG_PHP, "a.php", "<?php function f($input,$a){$a->email=$input;return $a->email;}"},
        {CBM_LANG_C, "a.c",
         "struct User{int email;};int f(int input,struct User*a){a->email=input;return a->email;}"},
        {CBM_LANG_CPP, "a.cpp",
         "struct User{int email;};int f(int input,User&a){a.email=input;return a.email;}"},
        {CBM_LANG_CUDA, "a.cu",
         "struct User{int email;};int f(int input,User*a){a->email=input;return a->email;}"},
    };
    for (size_t i = 0; i < sizeof(fixtures) / sizeof(fixtures[0]); i++)
        ASSERT_EQ(extract_heap_unproven_case(fixtures[i].language, fixtures[i].path,
                                             fixtures[i].source, false),
                  0);
    PASS();
}

TEST(flow_extract_member_accessors_invalidate_captured_mutable_locals) {
    const char *sources[] = {
        "function f(input){let x=input;const a={get email(){x=0;return 0;}};x=input;a.email;return "
        "x;}",
        "function f(input){let x=input;const a={set email(v){x=0;}};x=input;a.email=1;return x;}",
    };
    for (size_t i = 0; i < sizeof(sources) / sizeof(sources[0]); i++)
        ASSERT_EQ(extract_side_effect_case(sources[i]), 0);
    PASS();
}

TEST(flow_extract_repeated_getter_reads_are_independent_occurrences) {
    const char *source = "function f(a){const first=a.email;const second=a.email;return second;}";
    cbm_flow_extraction_t *result = NULL;
    ASSERT_EQ(cbm_flow_extract_source(source, (int)strlen(source), CBM_LANG_JAVASCRIPT, "flow",
                                      "repeated-getter.js", &result),
              CBM_STORE_OK);
    const cbm_flow_value_t *first = NULL, *second = NULL;
    for (size_t i = 0; i < result->file.value_count; i++) {
        const cbm_flow_value_t *value = &result->file.values[i];
        if (strcmp(value->kind, "field_read") != 0)
            continue;
        if (!first)
            first = value;
        else
            second = value;
    }
    ASSERT_NOT_NULL(first);
    ASSERT_NOT_NULL(second);
    ASSERT_FALSE(extract_reaches_kind(result, "repeated-getter.js", first->id, "return"));
    ASSERT_TRUE(extract_reaches_kind(result, "repeated-getter.js", second->id, "return"));
    ASSERT_GT(result->file.gap_count, 0);
    cbm_flow_extraction_free(result);
    PASS();
}

SUITE(flow_extract) {
    RUN_TEST(flow_extract_real_ast_assignment_parameter_return_per_semantic_language);
    RUN_TEST(flow_extract_overwrite_kills_old_value_and_shadow_preserves_outer_binding);
    RUN_TEST(flow_extract_fields_remain_distinct_and_branch_phi_preserves_alternatives);
    RUN_TEST(flow_extract_comma_write_invalidates_stale_value);
    RUN_TEST(flow_extract_ternary_write_invalidates_stale_value);
    RUN_TEST(flow_extract_direct_eval_invalidates_stale_value);
    RUN_TEST(flow_extract_closure_write_invalidates_stale_value);
    RUN_TEST(flow_extract_top_level_callee_callback_invalidates_caller_lexicals);
    RUN_TEST(flow_extract_top_level_callee_indirect_callback_invalidates_caller_lexicals);
    RUN_TEST(flow_extract_dynamic_scope_rebinding_blocks_original_callee_proof);
    RUN_TEST(flow_extract_js_operator_coercion_invalidates_mutable_lexicals);
    RUN_TEST(flow_extract_unverified_operators_do_not_transport_operands_to_unknown_results);
    RUN_TEST(flow_extract_verified_primitive_operator_results_remain_derived);
    RUN_TEST(flow_extract_python_operator_and_truthiness_effects_are_boundaries);
    RUN_TEST(flow_extract_overloaded_operators_in_typed_families_are_boundaries);
    RUN_TEST(flow_extract_cpp_copy_conversion_assignment_and_scope_lifetime_are_boundaries);
    RUN_TEST(flow_extract_csharp_implicit_conversion_invalidates_mutable_lexicals);
    RUN_TEST(flow_extract_compound_and_user_defined_literals_do_not_hide_effects);
    RUN_TEST(flow_extract_reference_alias_effects_survive_later_reassignments);
    RUN_TEST(flow_extract_string_interpolation_does_not_hide_callback_effects);
    RUN_TEST(flow_extract_releasing_unknown_objects_can_change_other_locals);
    RUN_TEST(flow_extract_finalizer_cannot_leave_a_proven_destination_write);
    RUN_TEST(flow_extract_rust_replacement_drops_the_previous_object);
    RUN_TEST(flow_extract_rust_scope_drop_requires_a_primitive_lifetime);
    RUN_TEST(flow_extract_verified_primitive_operations_preserve_values_and_results);
    RUN_TEST(flow_extract_destructuring_write_invalidates_stale_value);
    RUN_TEST(flow_extract_local_call_heap_write_invalidates_stale_value);
    RUN_TEST(flow_extract_local_call_nested_heap_write_invalidates_stale_value);
    RUN_TEST(flow_extract_dynamic_field_write_invalidates_stale_value);
    RUN_TEST(flow_extract_exact_local_call_ports_do_not_cross_return_sites);
    RUN_TEST(flow_extract_unmodeled_parameter_preserves_formal_positions);
    RUN_TEST(flow_extract_reference_parameter_call_invalidates_caller_storage);
    RUN_TEST(flow_extract_cross_file_ports_keep_exact_ast_occurrences);
    RUN_TEST(flow_extract_async_call_does_not_transport_raw_return_value);
    RUN_TEST(flow_extract_decorator_prevents_unproven_original_body_binding);
    RUN_TEST(flow_extract_generator_port_requires_iterator_summary);
    RUN_TEST(flow_extract_short_circuit_does_not_transport_unevaluated_operand);
    RUN_TEST(flow_extract_constant_false_branch_has_no_return_transport);
    RUN_TEST(flow_extract_dynamic_member_read_invalidates_nested_writes);
    RUN_TEST(flow_extract_local_call_invalidates_possible_argument_aliases);
    RUN_TEST(flow_extract_kotlin_unmodeled_call_shape_is_gap_not_null_node_crash);
    RUN_TEST(flow_extract_python_annotation_preserves_lexical_parameter_identity);
    RUN_TEST(flow_extract_parent_field_overwrite_cannot_retain_child_heap_proof);
    RUN_TEST(flow_extract_distinct_parameters_are_not_proven_disjoint_heap_regions);
    RUN_TEST(flow_extract_getter_setter_can_reject_written_value);
    RUN_TEST(flow_extract_heap_transport_requires_semantic_proof_in_every_family);
    RUN_TEST(flow_extract_member_accessors_invalidate_captured_mutable_locals);
    RUN_TEST(flow_extract_repeated_getter_reads_are_independent_occurrences);
}
