package main

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/format"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

//go:embed runtime.go.txt
var runtimeTemplate string

type sourceFile struct {
	path, relative, digest string
	tree                   *ast.File
}
type sourcePackage struct {
	directory, name string
	files           []sourceFile
}

func within(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

// Generate writes only into an empty, external temporary directory. It does
// not invoke go, install modules, execute the project or modify its go.mod.
func Generate(root, output string) (string, error) {
	if root == "" || output == "" {
		return "", errors.New("--root and --out are required")
	}
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", err
	}
	output, err = filepath.Abs(output)
	if err != nil {
		return "", err
	}
	// Resolve the nearest existing ancestor before deciding containment.
	ancestor := output
	for {
		if _, err := os.Lstat(ancestor); err == nil {
			break
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return "", errors.New("output parent unavailable")
		}
		ancestor = parent
	}
	resolved, err := filepath.EvalSymlinks(ancestor)
	if err != nil {
		return "", err
	}
	tail, err := filepath.Rel(ancestor, output)
	if err != nil {
		return "", err
	}
	output = filepath.Join(resolved, tail)
	if within(root, output) {
		return "", errors.New("overlay output must be outside the source root")
	}
	if entries, err := os.ReadDir(output); err == nil && len(entries) != 0 {
		return "", errors.New("overlay output must be empty")
	} else if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	fileset := token.NewFileSet()
	packages := map[string]*sourcePackage{}
	var gaps []string
	fileCount, total := 0, int64(0)
	entries, deadline := 0, time.Now().Add(5*time.Second)
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		entries++
		if entries > 8192 || time.Now().After(deadline) {
			gaps = append(gaps, "Directory/time budget reached; remaining sources are uninstrumented.")
			return fs.SkipAll
		}
		name := entry.Name()
		if entry.IsDir() {
			if path != root && (strings.HasPrefix(name, ".") || name == "vendor" || name == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			gaps = append(gaps, "Skipped symlink: "+path)
			return nil
		}
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() > 4<<20 || total+info.Size() > 32<<20 || fileCount >= 512 {
			gaps = append(gaps, "Source budget: "+path)
			return nil
		}
		opened, err := os.Open(path)
		if err != nil {
			return err
		}
		current, err := opened.Stat()
		if err != nil || !current.Mode().IsRegular() || !os.SameFile(info, current) {
			opened.Close()
			return errors.New("source identity changed before reading")
		}
		source, err := io.ReadAll(io.LimitReader(opened, (4<<20)+1))
		opened.Close()
		if err != nil {
			return err
		}
		if int64(len(source)) != info.Size() {
			return errors.New("source changed while preparing overlay")
		}
		fileCount++
		total += int64(len(source))
		tree, err := parser.ParseFile(fileset, path, source, parser.ParseComments)
		if err != nil {
			gaps = append(gaps, "Parse unavailable: "+path)
			return nil
		}
		if ast.IsGenerated(tree) {
			gaps = append(gaps, "Generated source excluded: "+path)
			return nil
		}
		directory := filepath.Dir(path)
		key := directory + "\x00" + tree.Name.Name
		group := packages[key]
		if group == nil {
			group = &sourcePackage{directory: directory, name: tree.Name.Name}
			packages[key] = group
		}
		relative, _ := filepath.Rel(root, path)
		digest := sha256.Sum256(source)
		group.files = append(group.files, sourceFile{path: path, relative: filepath.ToSlash(relative),
			digest: hex.EncodeToString(digest[:]), tree: tree})
		return nil
	})
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(output, 0700); err != nil {
		return "", err
	}
	replacements := map[string]string{}
	index := 0
	for key, group := range packages {
		sum := sha256.Sum256([]byte(key))
		prefix := "_cbm_" + hex.EncodeToString(sum[:6])
		// No helper may shadow a user identifier, even in a local scope.
		conflict := false
		var trees []*ast.File
		for _, file := range group.files {
			trees = append(trees, file.tree)
			ast.Inspect(file.tree, func(node ast.Node) bool {
				if id, ok := node.(*ast.Ident); ok && strings.HasPrefix(id.Name, prefix) {
					conflict = true
				}
				return true
			})
		}
		if conflict {
			gaps = append(gaps, "Helper identifier collision: "+group.directory)
			continue
		}
		info := &types.Info{Types: map[ast.Expr]types.TypeAndValue{}, Defs: map[*ast.Ident]types.Object{},
			Uses: map[*ast.Ident]types.Object{}, Selections: map[*ast.SelectorExpr]*types.Selection{}}
		config := types.Config{Importer: importer.Default(), Error: func(error) {}}
		// Partial type information is useful; an unproved expression is kept
		// original with a gap. Import failures never trigger module downloads.
		_, _ = config.Check(group.name, fileset, trees, info)
		for _, file := range group.files {
			probe := instrumenter{prefix: prefix, file: file, fileset: fileset, info: info}
			for _, declaration := range file.tree.Decls {
				if function, ok := declaration.(*ast.FuncDecl); ok && function.Body != nil {
					probe.function(function)
				}
			}
			var result bytes.Buffer
			if err := format.Node(&result, fileset, file.tree); err != nil {
				return "", err
			}
			backing := filepath.Join(output, fmt.Sprintf("source-%d.go", index))
			index++
			if err := writeNew(backing, result.Bytes()); err != nil {
				return "", err
			}
			replacements[file.path] = backing
		}
		runtime := strings.ReplaceAll(runtimeTemplate, "PACKAGE", group.name)
		runtime = strings.ReplaceAll(runtime, "PREFIX", prefix)
		formatted, err := format.Source([]byte(runtime))
		if err != nil {
			return "", fmt.Errorf("runtime format: %w", err)
		}
		backing := filepath.Join(output, fmt.Sprintf("runtime-%d.go", index))
		index++
		if err := writeNew(backing, formatted); err != nil {
			return "", err
		}
		virtual := filepath.Join(group.directory, "zz"+prefix+"_capture.go")
		if _, err := os.Lstat(virtual); !os.IsNotExist(err) {
			return "", errors.New("generated helper file collides with an existing source")
		}
		replacements[virtual] = backing
	}
	overlay, err := json.MarshalIndent(struct{ Replace map[string]string }{replacements}, "", "  ")
	if err != nil {
		return "", err
	}
	path := filepath.Join(output, "overlay.json")
	if err := writeNew(path, overlay); err != nil {
		return "", err
	}
	report, _ := json.MarshalIndent(map[string]any{"schema_version": 1, "files": fileCount, "gaps": gaps,
		"scope": "local scalar observations; caller/goroutine context is not correlated"}, "", "  ")
	if err := writeNew(filepath.Join(output, "coverage.json"), report); err != nil {
		return "", err
	}
	return path, nil
}

func writeNew(path string, contents []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = file.Write(contents)
	closeError := file.Close()
	if err != nil {
		return err
	}
	return closeError
}

type instrumenter struct {
	prefix  string
	file    sourceFile
	fileset *token.FileSet
	info    *types.Info
	fn      *ast.FuncDecl
	frame   string
}

func stringNode(value string) ast.Expr {
	return &ast.BasicLit{Kind: token.STRING, Value: strconv.Quote(value)}
}
func numberNode(value int) ast.Expr {
	return &ast.BasicLit{Kind: token.INT, Value: strconv.Itoa(value)}
}
func (p *instrumenter) line(node ast.Node) int { return p.fileset.Position(node.Pos()).Line }
func (p *instrumenter) site(node ast.Node) string {
	return strconv.Itoa(p.fileset.Position(node.Pos()).Offset)
}
func (p *instrumenter) invoke(name string, arguments ...ast.Expr) ast.Expr {
	return &ast.CallExpr{Fun: ast.NewIdent(p.prefix + name), Args: arguments}
}

// Explicit generic types preserve contextual constants and named scalar
// types. Inferring T from a wrapped `1+2` would silently default to int.
func (p *instrumenter) typed(name string, original ast.Expr, arguments ...ast.Expr) ast.Expr {
	typeName := types.TypeString(p.info.TypeOf(original), func(pkg *types.Package) string {
		if pkg.Name() == p.file.tree.Name.Name {
			return ""
		}
		for _, spec := range p.file.tree.Imports {
			path, _ := strconv.Unquote(spec.Path.Value)
			if path == pkg.Path() && spec.Name != nil {
				if spec.Name.Name == "." {
					return ""
				}
				return spec.Name.Name
			}
		}
		return pkg.Name()
	})
	syntax, err := parser.ParseExpr(typeName)
	if err != nil {
		return original
	} // A type without legal source syntax is not wrapped.
	return &ast.CallExpr{Fun: &ast.IndexExpr{X: ast.NewIdent(p.prefix + name), Index: syntax}, Args: arguments}
}
func (p *instrumenter) method(name string, arguments ...ast.Expr) ast.Stmt {
	return &ast.ExprStmt{X: &ast.CallExpr{Fun: &ast.SelectorExpr{X: ast.NewIdent(p.frame), Sel: ast.NewIdent(name)}, Args: arguments}}
}
func (p *instrumenter) gap(node ast.Node, detail string) ast.Stmt {
	return p.method("Gap", numberNode(p.line(node)), stringNode(detail))
}
func (p *instrumenter) binding(id *ast.Ident) (string, bool) {
	if id == nil || id.Name == "_" || id.Obj == nil || id.Obj.Kind != ast.Var {
		return "", false
	}
	position := id.Obj.Pos()
	if position < p.fn.Type.Pos() || position >= p.fn.End() {
		return "", false
	}
	return strconv.Itoa(p.fileset.Position(position).Offset), true
}
func (p *instrumenter) scalar(expression ast.Expr) bool {
	t := p.info.TypeOf(expression)
	if t == nil {
		return false
	}
	basic, ok := t.Underlying().(*types.Basic)
	return ok && basic.Info()&types.IsUntyped == 0 && basic.Info()&(types.IsBoolean|types.IsNumeric|types.IsString) != 0 &&
		basic.Kind() != types.UnsafePointer
}
func (p *instrumenter) function(fn *ast.FuncDecl) {
	p.fn, p.frame = fn, p.prefix+"_frame"
	line := p.line(fn)
	start := &ast.AssignStmt{Lhs: []ast.Expr{ast.NewIdent(p.frame)}, Tok: token.DEFINE,
		Rhs: []ast.Expr{p.invoke("Frame", stringNode(p.file.relative), stringNode(p.file.digest), stringNode(fn.Name.Name), numberNode(line))}}
	done := &ast.DeferStmt{Call: &ast.CallExpr{Fun: &ast.SelectorExpr{X: ast.NewIdent(p.frame), Sel: ast.NewIdent("Done")}}}
	prefix := []ast.Stmt{start, done, p.gap(fn, "Go caller/goroutine context is uncorrelated; no cross-invocation field transport is claimed.")}
	unsupported := fn.Type.TypeParams != nil
	if fn.Type.Results != nil {
		if len(fn.Type.Results.List) != 1 || len(fn.Type.Results.List[0].Names) != 0 {
			unsupported = true
		}
	}
	ast.Inspect(fn.Body, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.FuncLit, *ast.GoStmt, *ast.DeferStmt:
			unsupported = true
			return false
		case *ast.UnaryExpr:
			if n.Op == token.AND {
				unsupported = true
			}
		}
		return true
	})
	if unsupported {
		prefix = append(prefix, p.gap(fn, "Unsupported closure, deferred/named return, address-taking or goroutine body executes unchanged."))
		fn.Body.List = append(prefix, fn.Body.List...)
		return
	}
	if fn.Type.Params != nil {
		for _, parameter := range fn.Type.Params.List {
			for _, id := range parameter.Names {
				if key, ok := p.binding(id); ok && p.scalar(id) {
					prefix = append(prefix, p.method("Param", stringNode(key), stringNode(id.Name), numberNode(p.line(id)), ast.NewIdent(id.Name)))
				} else {
					prefix = append(prefix, p.gap(parameter, "Non-scalar parameter has no binding transport summary."))
				}
			}
		}
	}
	fn.Body.List = append(prefix, p.statements(fn.Body.List)...)
}

// A returned site is an evaluated scalar occurrence, never a variable name
// inferred from equal values. Calls remain opaque and invalidate old bindings.
func (p *instrumenter) expression(expression ast.Expr) (ast.Expr, string) {
	site, line := p.site(expression), p.line(expression)
	if !p.scalar(expression) {
		return expression, ""
	}
	frame, at, ln := ast.NewIdent(p.frame), stringNode(site), numberNode(line)
	switch e := expression.(type) {
	case *ast.Ident:
		if key, ok := p.binding(e); ok {
			return p.typed("Read", expression, frame, at, ln, stringNode(key), stringNode(e.Name), e), site
		}
	case *ast.BinaryExpr:
		if e.Op == token.LAND || e.Op == token.LOR {
			break
		}
		left, lsite := p.expression(e.X)
		right, rsite := p.expression(e.Y)
		e.X, e.Y = left, right
		return p.typed("Transform", expression, frame, at, ln, e, stringNode(lsite), stringNode(rsite)), site
	case *ast.UnaryExpr:
		if e.Op == token.ADD || e.Op == token.SUB || e.Op == token.NOT || e.Op == token.XOR {
			value, input := p.expression(e.X)
			e.X = value
			return p.typed("Transform", expression, frame, at, ln, e, stringNode(input)), site
		}
	case *ast.ParenExpr:
		value, input := p.expression(e.X)
		e.X = value
		return e, input
	case *ast.SelectorExpr:
		if selection := p.info.Selections[e]; selection != nil && selection.Kind() == types.FieldVal {
			return p.typed("Field", expression, frame, at, ln, stringNode(e.Sel.Name), e), site
		}
	case *ast.CallExpr:
		return p.typed("Opaque", expression, frame, at, ln, e), site
	case *ast.BasicLit:
		return e, "" // Keep contextual constant typing exactly unchanged.
	}
	return p.typed("Opaque", expression, frame, at, ln, expression), site
}

func (p *instrumenter) statements(statements []ast.Stmt) []ast.Stmt {
	var output []ast.Stmt
	for _, statement := range statements {
		output = append(output, p.statement(statement)...)
	}
	return output
}
func (p *instrumenter) statement(statement ast.Stmt) []ast.Stmt {
	switch s := statement.(type) {
	case *ast.BlockStmt:
		s.List = p.statements(s.List)
		return []ast.Stmt{s}
	case *ast.AssignStmt:
		if len(s.Lhs) == 1 && len(s.Rhs) == 1 {
			if id, ok := s.Lhs[0].(*ast.Ident); ok && p.scalar(id) {
				if key, local := p.binding(id); local {
					expression, input := p.expression(s.Rhs[0])
					s.Rhs[0] = expression
					operation := "Assign"
					if s.Tok != token.DEFINE && s.Tok != token.ASSIGN {
						operation = "Compound"
					}
					return []ast.Stmt{s, p.method(operation, stringNode(key), stringNode(id.Name),
						numberNode(p.line(s)), ast.NewIdent(id.Name), stringNode(input))}
				}
			}
		}
	case *ast.DeclStmt:
		if declaration, ok := s.Decl.(*ast.GenDecl); ok && declaration.Tok == token.VAR && len(declaration.Specs) == 1 {
			if spec, ok := declaration.Specs[0].(*ast.ValueSpec); ok && len(spec.Names) == 1 && len(spec.Values) <= 1 && p.scalar(spec.Names[0]) {
				id := spec.Names[0]
				if key, local := p.binding(id); local {
					input := ""
					if len(spec.Values) == 1 {
						spec.Values[0], input = p.expression(spec.Values[0])
					}
					return []ast.Stmt{s, p.method("Assign", stringNode(key), stringNode(id.Name), numberNode(p.line(s)), ast.NewIdent(id.Name), stringNode(input))}
				}
			}
		}
	case *ast.IncDecStmt:
		if id, ok := s.X.(*ast.Ident); ok && p.scalar(id) {
			if key, local := p.binding(id); local {
				return []ast.Stmt{s, p.method("Compound", stringNode(key), stringNode(id.Name), numberNode(p.line(s)), ast.NewIdent(id.Name), stringNode(""))}
			}
		}
	case *ast.ReturnStmt:
		if len(s.Results) == 1 && p.scalar(s.Results[0]) {
			original := s.Results[0]
			expression, input := p.expression(original)
			s.Results[0] = p.typed("Return", original, ast.NewIdent(p.frame), numberNode(p.line(s)), expression, stringNode(input))
			return []ast.Stmt{s}
		}
		if len(s.Results) == 0 {
			return []ast.Stmt{s}
		}
	case *ast.IfStmt:
		if s.Init == nil {
			s.Cond, _ = p.expression(s.Cond)
			s.Body.List = p.statements(s.Body.List)
			if s.Else != nil {
				s.Else = &ast.BlockStmt{List: p.statement(s.Else)}
			}
			return []ast.Stmt{s}
		}
	case *ast.ForStmt:
		s.Body.List = append([]ast.Stmt{p.gap(s, "Loop-control storage has no per-iteration binding summary.")}, p.statements(s.Body.List)...)
		return []ast.Stmt{p.gap(s, "Loop header executes unchanged."), s,
			p.gap(s, "Uninstrumented loop post/condition may have changed storage.")}
	case *ast.RangeStmt:
		s.Body.List = append([]ast.Stmt{p.gap(s, "Range storage has no per-iteration binding summary.")}, p.statements(s.Body.List)...)
		return []ast.Stmt{p.gap(s, "Range header executes unchanged."), s,
			p.gap(s, "Range iteration storage is invalidated after exit.")}
	case *ast.BranchStmt, *ast.EmptyStmt:
		return []ast.Stmt{s}
	}
	return []ast.Stmt{p.gap(statement, "Unsupported statement or call executes unchanged; previous storage transport is invalidated."), statement}
}
