/** TypeScript compiler AST overlay; the input file is never written. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
let ts;
try { ts = require('./vendor/typescript.cjs'); }
catch { ts = require('../../../graph-ui/node_modules/typescript/lib/typescript.js'); }

export function instrument(source, { filePath, runtimeUrl }) {
    if (Buffer.byteLength(source) > 4 * 1024 * 1024) throw Error('Capture source exceeds 4 MiB.');
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ESNext, true,
        /\.tsx$/.test(filePath) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(filePath) ? ts.ScriptKind.TS
            : /\.jsx$/.test(filePath) ? ts.ScriptKind.JSX : ts.ScriptKind.JS);
    if (sf.parseDiagnostics.length) throw Error('Capture overlay cannot parse this source.');
    const host = {
        getSourceFile: name => name === filePath ? sf : undefined, getDefaultLibFileName: () => '',
        writeFile() {}, getCurrentDirectory: () => '', getDirectories: () => [], fileExists: name => name === filePath,
        readFile: name => name === filePath ? source : undefined, getCanonicalFileName: name => name,
        useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    };
    const checker = ts.createProgram([filePath], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
    const f = ts.factory, rt = f.createUniqueName('__cbmRuntime'), get = f.createUniqueName('__cbmGetRuntime');
    const str = value => f.createStringLiteral(String(value));
    const num = value => f.createNumericLiteral(value);
    const arr = values => f.createArrayLiteralExpression(values);
    const undef = () => f.createVoidZero();
    const key = node => `${node.kind}:${node.getStart(sf)}`;
    const line = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const memberCall = (owner, method, args) => f.createCallExpression(f.createPropertyAccessExpression(owner, method), undefined, args);
    const fnId = node => `${filePath}:${node.getStart(sf)}:${sourceHash}`;
    const owner = node => {
        while (node && !ts.isSourceFile(node) && !ts.isFunctionLike(node)) node = node.parent;
        return node;
    };
    function binding(identifier, context) {
        const symbol = checker.getSymbolAtLocation(identifier), declaration = symbol?.valueDeclaration;
        if (!declaration || owner(declaration) !== context.owner
            || !(ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))) return undefined;
        return `b:${declaration.getStart(sf)}`;
    }
    const call = (context, method, args) => memberCall(context.frame, method, args);
    const gap = (context, node, detail) => f.createExpressionStatement(call(context, 'gap', [num(line(node)), str(detail)]));
    const observe = (context, node, value, operation, inputs = [], path) => call(context, 'observe',
        [str(key(node)), num(line(node)), value, arr(inputs.map(child => str(key(child)))), str(operation), ...(path ? [str(path)] : [])]);
    const opaque = (context, node, detail, path, operation) => call(context, 'opaque',
        [str(key(node)), num(line(node)), node, str(detail), path ? str(path) : undef(), str(operation ?? 'value')]);
    function expression(node, context) {
        if (ts.isIdentifier(node)) {
            const id = binding(node, context);
            if (id) return call(context, 'read', [str(key(node)), num(line(node)), str(id), node, str(node.text)]);
            return opaque(context, node, 'External or captured binding has no local scalar identity.');
        }
        if (ts.isNumericLiteral(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
            || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind))
            return observe(context, node, node, 'value');
        if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
            || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))
            return observe(context, node, expression(node.expression, context), 'copy', [node.expression]);
        if (ts.isBinaryExpression(node)) {
            const op = node.operatorToken.kind;
            if (op === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
                if (ts.isArrowFunction(node.right) || ts.isFunctionExpression(node.right) || ts.isClassExpression(node.right))
                    return opaque(context, node, 'Function/class assignment preserves inferred name; binding transport is not modeled.');
                const id = binding(node.left, context);
                if (id) return f.createAssignment(node.left, call(context, 'assign', [
                    str(key(node)), num(line(node)), str(id), str(key(node.right)), expression(node.right, context), str(node.left.text),
                ]));
            }
            if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
                ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.LessThanToken,
                ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
                ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
                ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
                ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
                ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
                ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken].includes(op))
                return observe(context, node, f.updateBinaryExpression(node, expression(node.left, context), node.operatorToken,
                    expression(node.right, context)), 'transform', [node.left, node.right]);
            return opaque(context, node, 'Short-circuit, compound assignment or control expression is outside scalar probe coverage.');
        }
        if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
            ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.TildeToken].includes(node.operator))
            return observe(context, node, f.updatePrefixUnaryExpression(node, expression(node.operand, context)), 'transform', [node.operand]);
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && !node.questionDotToken
            && node.expression.text !== 'eval' && !node.arguments.some(ts.isSpreadElement)) {
            return call(context, 'invoke', [str(key(node)), num(line(node)), node.expression,
                arr(node.arguments.map(arg => expression(arg, context))), arr(node.arguments.map(arg => str(key(arg))))]);
        }
        if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
            const text = node.getText(sf);
            const path = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(text) ? text : undefined;
            return opaque(context, node, 'Field/accessor result observed once; prior heap state transport is not proven.', path, 'field');
        }
        return opaque(context, node, 'Opaque expression, method call, heap mutation or suspended execution has no proven value transport.');
    }
    function frameStatement(context, node, parameters) {
        const props = { file_path: filePath, source_hash: sourceHash, symbol: context.symbol, function_id: fnId(node) };
        const meta = f.createObjectLiteralExpression([...Object.entries(props).map(([k, v]) => f.createPropertyAssignment(k, str(v))),
            f.createPropertyAssignment('line', num(line(node)))]);
        return f.createVariableStatement(undefined, f.createVariableDeclarationList([
            f.createVariableDeclaration(context.frame, undefined, undefined, memberCall(rt, 'frame', [meta,
                arr(parameters.map(parameter => arr([str(`b:${parameter.getStart(sf)}`), str(parameter.name.text), parameter.name])))])),
        ], ts.NodeFlags.Const));
    }
    function functionSupported(node) {
        if (node.asteriskToken || node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.AsyncKeyword)
            || node.parameters.some(p => !ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken)) return false;
        let unsafe = false;
        const scan = child => {
            if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'eval') unsafe = true;
            if (child.kind === ts.SyntaxKind.WithStatement) unsafe = true;
            ts.forEachChild(child, scan);
        };
        scan(node.body); return !unsafe;
    }
    function functionDeclaration(node, parent) {
        if (!node.body || !node.name) return node;
        const context = { frame: f.createUniqueName('__cbmFrame'), owner: node,
            symbol: parent.symbol === '<module>' ? node.name.text : `${parent.symbol}.${node.name.text}` };
        const supported = functionSupported(node);
        const statements = supported ? body(node.body.statements, context) : [...node.body.statements];
        const entry = frameStatement(context, node, supported ? node.parameters : []);
        const block = f.updateBlock(node.body, prependAfterDirectives(statements, [entry,
            ...(!supported ? [gap(context, node, 'Async, suspended, dynamic-scope or complex-parameter function body is outside scalar probe coverage.')] : [])]));
        return f.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name,
            node.typeParameters, node.parameters, node.type, block);
    }
    function functionExpression(node, parent, name) {
        const context = { frame: f.createUniqueName('__cbmFrame'), owner: node,
            symbol: parent.symbol === '<module>' ? name : `${parent.symbol}.${name}` };
        const supported = functionSupported(node);
        let statements;
        if (!ts.isBlock(node.body)) {
            const returning = call(context, 'returning', [str(key(node.body)), num(line(node.body)),
                supported ? expression(node.body, context) : node.body, supported ? str(key(node.body)) : undef()]);
            statements = [f.createReturnStatement(returning)];
        } else statements = supported ? body(node.body.statements, context) : [...node.body.statements];
        const block = f.createBlock(prependAfterDirectives(statements, [frameStatement(context, node, supported ? node.parameters : []),
            ...(!supported ? [gap(context, node, 'Async, suspended, dynamic-scope or complex-parameter function body is outside scalar probe coverage.')] : [])]), true);
        return ts.isArrowFunction(node)
            ? f.updateArrowFunction(node, node.modifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken, block)
            : f.updateFunctionExpression(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, block);
    }
    function statement(node, context) {
        if (ts.isFunctionDeclaration(node)) return functionDeclaration(node, context);
        if (ts.isBlock(node)) return f.updateBlock(node, body(node.statements, context));
        if (ts.isVariableStatement(node)) {
            if (node.declarationList.declarations.some(decl => !ts.isIdentifier(decl.name)))
                return [gap(context, node, 'Destructured binding is outside scalar probe coverage.'), node];
            const after = [];
            const declarations = node.declarationList.declarations.map(decl => {
                if (!decl.initializer) return decl;
                if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                    if (functionSupported(decl.initializer)) after.push(f.createExpressionStatement(memberCall(rt, 'track',
                        [decl.name, str(fnId(decl.initializer))])));
                    return f.updateVariableDeclaration(decl, decl.name, decl.exclamationToken, decl.type,
                        functionExpression(decl.initializer, context, decl.name.text));
                }
                if (ts.isClassExpression(decl.initializer)) {
                    after.push(gap(context, decl, 'Class initializer preserves inferred name; heap identity is not modeled.'));
                    return decl;
                }
                const id = binding(decl.name, context);
                return f.updateVariableDeclaration(decl, decl.name, decl.exclamationToken, decl.type,
                    call(context, 'assign', [str(key(decl)), num(line(decl)), str(id), str(key(decl.initializer)),
                        expression(decl.initializer, context), str(decl.name.text)]));
            });
            return [f.updateVariableStatement(node, node.modifiers, f.updateVariableDeclarationList(node.declarationList, declarations)), ...after];
        }
        if (ts.isReturnStatement(node)) return f.updateReturnStatement(node, call(context, 'returning',
            [str(key(node)), num(line(node)), node.expression ? expression(node.expression, context) : undef(),
                node.expression ? str(key(node.expression)) : undef()]));
        if (ts.isExpressionStatement(node)) {
            if (ts.isStringLiteral(node.expression)) return node;
            return f.updateExpressionStatement(node, expression(node.expression, context));
        }
        if (ts.isIfStatement(node)) return f.updateIfStatement(node, expression(node.expression, context),
            single(node.thenStatement, context), node.elseStatement ? single(node.elseStatement, context) : undefined);
        if (ts.isThrowStatement(node)) return f.updateThrowStatement(node, expression(node.expression, context));
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isInterfaceDeclaration(node)
            || ts.isTypeAliasDeclaration(node) || ts.isEmptyStatement(node)) return node;
        // Preserve loops, try/finally, switch, classes, decorators and abrupt completion
        // as original statements. Invalidating identities prevents false stale links.
        return [gap(context, node, 'Statement control/heap semantics are outside scalar probe coverage.'), node,
            gap(context, node, 'Uninstrumented statement completed; local identities are unknown.')];
    }
    const single = (node, context) => { const result = statement(node, context); return Array.isArray(result) ? f.createBlock(result, true) : result; };
    const prependAfterDirectives = (statements, prefix) => {
        let count = 0;
        while (count < statements.length && ts.isExpressionStatement(statements[count]) && ts.isStringLiteral(statements[count].expression)) count++;
        return [...statements.slice(0, count), ...prefix, ...statements.slice(count)];
    };
    function body(statements, context) {
        const tracks = statements.filter(node => ts.isFunctionDeclaration(node) && node.body && node.name && functionSupported(node))
            .map(node => f.createExpressionStatement(memberCall(rt, 'track', [node.name, str(fnId(node))])));
        return prependAfterDirectives(statements.flatMap(node => statement(node, context)), tracks);
    }
    const context = { frame: f.createUniqueName('__cbmFrame'), owner: sf, symbol: '<module>' };
    const importStatement = f.createImportDeclaration(undefined, f.createImportClause(false, undefined,
        f.createNamedImports([f.createImportSpecifier(false, f.createIdentifier('getRuntime'), get)])), str(runtimeUrl));
    const rtDeclaration = f.createVariableStatement(undefined, f.createVariableDeclarationList([
        f.createVariableDeclaration(rt, undefined, undefined, f.createCallExpression(get, undefined, [])),
    ], ts.NodeFlags.Const));
    const transformed = f.updateSourceFile(sf, prependAfterDirectives(body(sf.statements, context),
        [importStatement, rtDeclaration, frameStatement(context, sf, [])]));
    const printed = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(transformed);
    const output = ts.transpileModule(printed, { fileName: filePath, compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
        sourceMap: false, inlineSourceMap: false, removeComments: false,
    } });
    return { code: output.outputText, sourceHash, compilerVersion: ts.version };
}
