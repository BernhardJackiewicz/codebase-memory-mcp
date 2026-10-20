using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using static Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

internal static class Program
{
    private static string CanonicalDirectory(string path, int depth = 0)
    {
        if (depth > 32) throw new ArgumentException("Directory link depth exceeds the overlay boundary limit.");
        path = Path.GetFullPath(path);
        if (!Directory.Exists(path)) throw new ArgumentException("Directory must already exist.");
        var root = Path.GetPathRoot(path)!;
        var current = root;
        foreach (var part in path[root.Length..].Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, part);
            var info = new DirectoryInfo(current);
            if (info.LinkTarget is not null)
                current = CanonicalDirectory(info.ResolveLinkTarget(returnFinalTarget: true)?.FullName ??
                    throw new ArgumentException("Unresolved directory link."), depth + 1);
        }
        return Path.GetFullPath(current);
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 4 || args[0] != "--root" || args[2] != "--out")
                throw new ArgumentException("Usage: CaptureTool --root PROJECT --out NEW_TEMP_DIRECTORY");
            var root = CanonicalDirectory(args[1]);
            var requested = Path.GetFullPath(args[3]);
            var output = Path.Combine(CanonicalDirectory(Path.GetDirectoryName(requested)!), Path.GetFileName(requested));
            var comparison = OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            if (File.Exists(output) || Directory.Exists(output) || new DirectoryInfo(output).LinkTarget is not null ||
                output.Equals(root, comparison) || output.StartsWith(root + Path.DirectorySeparatorChar, comparison))
                throw new ArgumentException("Use an existing project and a new output directory outside it.");
            var excluded = new HashSet<string> { ".git", "bin", "obj", "node_modules", ".venv", "packages" };
            var files = new List<string>();
            var gaps = new List<string>();
            long bytes = 0;
            void Walk(string directory)
            {
                foreach (var item in Directory.EnumerateFileSystemEntries(directory).Order(StringComparer.Ordinal))
                {
                    var attributes = File.GetAttributes(item);
                    if ((attributes & FileAttributes.ReparsePoint) != 0) { gaps.Add("Symlink excluded: " + Path.GetRelativePath(root, item)); continue; }
                    if ((attributes & FileAttributes.Directory) != 0) { if (!excluded.Contains(Path.GetFileName(item))) Walk(item); continue; }
                    bytes += new FileInfo(item).Length;
                    if (files.Count >= 2000 || bytes > 64 * 1024 * 1024) throw new ArgumentException("Overlay exceeds 2,000 files / 64 MiB. Choose a smaller project root.");
                    files.Add(item);
                }
            }
            Walk(root);
            var sources = files.Where(file => file.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)).ToArray();
            if (sources.Length == 0 || !files.Any(file => file.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)))
                throw new ArgumentException("Root must include C# sources and a project file.");
            // Parse, hash and copy the same immutable bytes. Editing the project
            // while the overlay is prepared must never relabel older code with a
            // newer source hash.
            var snapshots = sources.ToDictionary(file => file, File.ReadAllBytes);
            var trees = snapshots.Where(snapshot => snapshot.Value.Length <= 4 * 1024 * 1024).Select(snapshot =>
            {
                using var reader = new StreamReader(new MemoryStream(snapshot.Value), Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
                return CSharpSyntaxTree.ParseText(reader.ReadToEnd(), new CSharpParseOptions(LanguageVersion.Latest), snapshot.Key);
            }).ToArray();
            foreach (var snapshot in snapshots.Where(snapshot => snapshot.Value.Length > 4 * 1024 * 1024))
                gaps.Add("Source too large for probes: " + Path.GetRelativePath(root, snapshot.Key));
            var trusted = ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
            var references = trusted.Select(file => MetadataReference.CreateFromFile(file));
            var compilation = CSharpCompilation.Create("CaptureSourceAnalysis", trees, references,
                new CSharpCompilationOptions(OutputKind.ConsoleApplication, allowUnsafe: true));
            Directory.CreateDirectory(output);
            foreach (var file in files)
            {
                var destination = Path.Combine(output, Path.GetRelativePath(root, file));
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                if (snapshots.TryGetValue(file, out var snapshot)) File.WriteAllBytes(destination, snapshot);
                else File.Copy(file, destination);
            }
            foreach (var tree in trees)
            {
                var relative = Path.GetRelativePath(root, tree.FilePath).Replace(Path.DirectorySeparatorChar, '/');
                var raw = snapshots[tree.FilePath];
                var digest = Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant();
                var rewriter = new Probes(compilation.GetSemanticModel(tree), relative, digest);
                var rewritten = rewriter.Visit(tree.GetRoot())!;
                File.WriteAllText(Path.Combine(output, relative), rewritten.NormalizeWhitespace().ToFullString(), new UTF8Encoding(false));
            }
            var runtimePath = Path.Combine(AppContext.BaseDirectory, "Runtime.cs");
            if (!File.Exists(runtimePath)) throw new FileNotFoundException("Runtime.cs must accompany CaptureTool.");
            foreach (var project in files.Where(file => file.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)))
            {
                var destination = Path.Combine(output, Path.GetRelativePath(root, project));
                var runtime = Path.Combine(Path.GetDirectoryName(destination)!, "__CbmCaptureRuntime.cs");
                if (File.Exists(runtime)) throw new ArgumentException("Reserved runtime filename already exists in the project.");
                File.Copy(runtimePath, runtime);
                var xml = XDocument.Load(destination, LoadOptions.PreserveWhitespace);
                var ns = xml.Root!.Name.Namespace;
                xml.Root.Add(new XElement(ns + "ItemGroup",
                    new XElement(ns + "Compile", new XAttribute("Remove", "__CbmCaptureRuntime.cs")),
                    new XElement(ns + "Compile", new XAttribute("Include", "__CbmCaptureRuntime.cs"))));
                xml.Save(destination);
            }
            File.WriteAllText(Path.Combine(output, "cbm-capture-overlay.json"), JsonSerializer.Serialize(new { schema_version = 1, root, files = sources.Length, gaps }, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine(JsonSerializer.Serialize(new { root = output, files = sources.Length, gaps, instructions = "Start the copied project manually with dotnet run and the capture session environment." }));
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}

internal sealed class Probes : CSharpSyntaxRewriter
{
    private readonly SemanticModel model;
    private readonly string path, hash;
    private string? frame;
    private const string Runtime = "global::CbmLocalCapture.Probe";
    internal Probes(SemanticModel model, string path, string hash) { this.model = model; this.path = path; this.hash = hash; }
    private static string Quote(string value) => JsonSerializer.Serialize(value);
    private static ExpressionSyntax Text(string value) => ParseExpression(Quote(value));
    private int Line(SyntaxNode node) => node.SyntaxTree.GetLineSpan(node.Span).StartLinePosition.Line + 1;
    private static string Site(SyntaxNode node) => node.Kind() + ":" + node.SpanStart;
    private static string Binding(ISymbol symbol) => symbol.Name + ":" + (symbol.DeclaringSyntaxReferences.FirstOrDefault()?.Span.Start.ToString() ?? "external");
    private ITypeSymbol? Type(ExpressionSyntax node) => model.GetTypeInfo(node).Type ?? model.GetTypeInfo(node).ConvertedType;
    private static bool Scalar(ITypeSymbol? type) => type?.SpecialType is SpecialType.System_String or SpecialType.System_Boolean or SpecialType.System_Char or
        SpecialType.System_Byte or SpecialType.System_SByte or SpecialType.System_Int16 or SpecialType.System_UInt16 or SpecialType.System_Int32 or SpecialType.System_UInt32 or
        SpecialType.System_Int64 or SpecialType.System_UInt64 or SpecialType.System_Single or SpecialType.System_Double or SpecialType.System_Decimal;
    private static string TypeName(ITypeSymbol type) => type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat.WithMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.EscapeKeywordIdentifiers | SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier));
    private ExpressionSyntax Call(string name, ITypeSymbol type, params ExpressionSyntax[] arguments) => InvocationExpression(
        ParseExpression(Runtime + "." + name + (type.IsAnonymousType ? "" : "<" + TypeName(type) + ">")), ArgumentList(SeparatedList(arguments.Select(Argument))));
    private ExpressionSyntax F => IdentifierName(frame!);
    private static ExpressionSyntax Number(int value) => ParseExpression(value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    private StatementSyntax Gap(SyntaxNode node, string detail) => ParseStatement(frame + ".Gap(" + Line(node) + ", " + Quote(detail) + ");");
    private ExpressionSyntax Opaque(ExpressionSyntax node, string detail) => Type(node) is ITypeSymbol type &&
        type.SpecialType != SpecialType.System_Void && !type.IsRefLikeType && type.TypeKind is not (TypeKind.Pointer or TypeKind.Error or TypeKind.Dynamic)
        ? Call("Opaque", type, F, Text(Site(node)), Number(Line(node)), node, Text(detail)) : node;
    private ExpressionSyntax VisitValue(ExpressionSyntax node) => (ExpressionSyntax)Visit(node)!;

    public override SyntaxNode? VisitCompilationUnit(CompilationUnitSyntax node)
    {
        var globals = node.Members.OfType<GlobalStatementSyntax>().ToArray();
        if (globals.Length == 0) return base.VisitCompilationUnit(node);
        frame = "_cbm_capture_top_" + hash[..10];
        while (node.DescendantTokens().Any(token => token.ValueText == frame)) frame += "x";
        var entry = GlobalStatement(ParseStatement("using var " + frame + " = " + Runtime + ".Enter(" +
            Quote(path) + ", " + Quote(hash) + ", \"Main\", " + Line(globals[0]) + ");"));
        var unsupported = globals.SelectMany(statement => statement.DescendantNodes()).Any(child =>
            child is AwaitExpressionSyntax or AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax or RefExpressionSyntax);
        var members = new List<MemberDeclarationSyntax> { entry,
            GlobalStatement(GapOnly(globals[0], unsupported ? "Top-level async, closure or by-reference code executes unchanged." : "Caller argument transport is not established by this intraprocedural adapter.")) };
        foreach (var member in node.Members)
        {
            if (member is GlobalStatementSyntax statement)
                members.Add(unsupported ? member : (MemberDeclarationSyntax)Visit(statement)!);
            else
            {
                var previous = frame; frame = null;
                members.Add((MemberDeclarationSyntax)Visit(member)!);
                frame = previous;
            }
        }
        frame = null;
        return node.WithMembers(List(members));
    }

    public override SyntaxNode? VisitMethodDeclaration(MethodDeclarationSyntax node)
    {
        if (node.Body is null && node.ExpressionBody is null) return node;
        var previous = frame;
        frame = "_cbm_capture_" + hash[..10] + "_" + node.SpanStart;
        while (node.DescendantTokens().Any(token => token.ValueText == frame)) frame += "x";
        var entry = ParseStatement("using var " + frame + " = " + Runtime + ".Enter(" + Quote(path) + ", " + Quote(hash) + ", " + Quote(node.Identifier.ValueText) + ", " + Line(node) + ");");
        var statements = new List<StatementSyntax> { entry };
        var unsafeBody = node.Modifiers.Any(SyntaxKind.AsyncKeyword) || node.ParameterList.Parameters.Any(parameter => parameter.Modifiers.Any(SyntaxKind.RefKeyword) || parameter.Modifiers.Any(SyntaxKind.OutKeyword) || parameter.Modifiers.Any(SyntaxKind.InKeyword)) ||
            node.DescendantNodes().Any(child => child is YieldStatementSyntax or RefExpressionSyntax or AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax ||
                child is ExpressionSyntax expression && Type(expression) is ITypeSymbol type && (type.IsRefLikeType || type.TypeKind is TypeKind.Pointer or TypeKind.Dynamic));
        var body = node.Body ?? Block(model.GetDeclaredSymbol(node)?.ReturnsVoid == true ? ExpressionStatement(node.ExpressionBody!.Expression) : ReturnStatement(node.ExpressionBody!.Expression));
        if (unsafeBody)
        {
            statements.Add(Gap(node, "Async, iterator, closure or by-reference body executes unchanged without scalar probes."));
            statements.AddRange(body.Statements);
        }
        else
        {
            foreach (var parameter in node.ParameterList.Parameters)
            {
                var symbol = model.GetDeclaredSymbol(parameter);
                if (symbol is not null && Scalar(symbol.Type))
                    statements.Add(ExpressionStatement(Call("Parameter", symbol.Type, F, Text(Binding(symbol)), Text(symbol.Name), Number(Line(parameter)), IdentifierName(parameter.Identifier))));
            }
            statements.Add(GapOnly(node, "Caller argument transport is not established by this intraprocedural adapter."));
            foreach (var statement in body.Statements) statements.Add((StatementSyntax)Visit(statement)!);
        }
        frame = previous;
        return node.WithBody(body.WithStatements(List(statements))).WithExpressionBody(null).WithSemicolonToken(default);
    }
    private StatementSyntax GapOnly(SyntaxNode node, string detail) => ParseStatement(frame + ".Notice(" + Line(node) + ", " + Quote(detail) + ");");
    public override SyntaxNode? VisitAttributeList(AttributeListSyntax node) => node;
    public override SyntaxNode? VisitLocalFunctionStatement(LocalFunctionStatementSyntax node) => node;
    public override SyntaxNode? VisitSimpleLambdaExpression(SimpleLambdaExpressionSyntax node) => node;
    public override SyntaxNode? VisitParenthesizedLambdaExpression(ParenthesizedLambdaExpressionSyntax node) => node;
    public override SyntaxNode? VisitAccessorDeclaration(AccessorDeclarationSyntax node) => node;
    public override SyntaxNode? VisitConstructorDeclaration(ConstructorDeclarationSyntax node) => node;
    public override SyntaxNode? VisitConstantPattern(ConstantPatternSyntax node) => node;
    public override SyntaxNode? VisitRelationalPattern(RelationalPatternSyntax node) => node;
    public override SyntaxNode? VisitSwitchExpression(SwitchExpressionSyntax node) => frame is null ? node : Opaque(node, "Switch expression executes unchanged; chosen arm lineage is unproven.");
    public override SyntaxNode? VisitParenthesizedExpression(ParenthesizedExpressionSyntax node) =>
        frame is null || !Scalar(Type(node)) ? node : Call("Forward", Type(node)!, F, Text(Site(node)), Number(Line(node)),
            node.WithExpression(VisitValue(node.Expression)), Text(Site(node.Expression)));

    public override SyntaxNode? VisitLiteralExpression(LiteralExpressionSyntax node)
    {
        if (frame is null || !Scalar(Type(node))) return node;
        return Call("Value", Type(node)!, F, Text(Site(node)), Number(Line(node)), node);
    }
    public override SyntaxNode? VisitIdentifierName(IdentifierNameSyntax node)
    {
        if (frame is null || !Scalar(Type(node))) return node;
        var symbol = model.GetSymbolInfo(node).Symbol;
        if (symbol is not ILocalSymbol && symbol is not IParameterSymbol) return node;
        if (symbol is ILocalSymbol local && local.IsConst) return node;
        return Call("Read", Type(node)!, F, Text(Site(node)), Text(Binding(symbol)), Text(symbol.Name), Number(Line(node)), node);
    }
    public override SyntaxNode? VisitLocalDeclarationStatement(LocalDeclarationStatementSyntax node)
    {
        if (frame is null || node.Modifiers.Any(SyntaxKind.ConstKeyword)) return node;
        return base.VisitLocalDeclarationStatement(node);
    }
    public override SyntaxNode? VisitVariableDeclarator(VariableDeclaratorSyntax node)
    {
        if (frame is null || node.Initializer is null || model.GetDeclaredSymbol(node) is not ILocalSymbol symbol) return node;
        var original = node.Initializer.Value;
        if (!Scalar(symbol.Type)) return node.WithInitializer(node.Initializer.WithValue(Opaque(original, "Object initializer may change scalar state; prior binding versions invalidated.")));
        return node.WithInitializer(node.Initializer.WithValue(Call("Write", symbol.Type, F, Text(Site(node)), Text(Binding(symbol)), Text(symbol.Name), Number(Line(node)), VisitValue(original), Text(Site(original)))));
    }
    public override SyntaxNode? VisitAssignmentExpression(AssignmentExpressionSyntax node)
    {
        if (frame is null) return node;
        var symbol = model.GetSymbolInfo(node.Left).Symbol;
        if (node.IsKind(SyntaxKind.SimpleAssignmentExpression) && node.Left is IdentifierNameSyntax && symbol is ILocalSymbol or IParameterSymbol && Scalar(Type(node.Left)))
            return node.WithRight(Call("Write", Type(node.Left)!, F, Text(Site(node)), Text(Binding(symbol!)), Text(symbol!.Name), Number(Line(node)), VisitValue(node.Right), Text(Site(node.Right))));
        return Opaque(node, "Compound or heap write invalidates local state assumptions.");
    }
    public override SyntaxNode? VisitReturnStatement(ReturnStatementSyntax node)
    {
        if (frame is null || node.Expression is null || !Scalar(Type(node.Expression))) return node;
        return node.WithExpression(Call("Returned", Type(node.Expression)!, F, Text(Site(node)), Number(Line(node)), VisitValue(node.Expression), Text(Site(node.Expression))));
    }
    public override SyntaxNode? VisitBinaryExpression(BinaryExpressionSyntax node)
    {
        if (frame is null) return node;
        if (node.IsKind(SyntaxKind.LogicalAndExpression) || node.IsKind(SyntaxKind.LogicalOrExpression) || node.IsKind(SyntaxKind.CoalesceExpression) ||
            !Scalar(Type(node.Left)) || !Scalar(Type(node.Right)) || model.GetSymbolInfo(node).Symbol is IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator })
            return Opaque(node, "Short-circuit, overloaded or unresolved operation has no scalar transfer rule.");
        if (!Scalar(Type(node))) return node;
        return Call("Operation", Type(node)!, F, Text(Site(node)), Number(Line(node)), node.WithLeft(VisitValue(node.Left)).WithRight(VisitValue(node.Right)), Text(Site(node.Left)), Text(Site(node.Right)));
    }
    public override SyntaxNode? VisitPrefixUnaryExpression(PrefixUnaryExpressionSyntax node) => frame is null ? node : Opaque(node, "Unary operation has no scalar transfer rule.");
    public override SyntaxNode? VisitPostfixUnaryExpression(PostfixUnaryExpressionSyntax node) => frame is null ? node : Opaque(node, "Increment/decrement invalidates prior binding versions.");
    public override SyntaxNode? VisitConditionalExpression(ConditionalExpressionSyntax node) => frame is null ? node : Opaque(node, "Conditional expression preserves evaluation order without inferred lineage.");
    public override SyntaxNode? VisitInvocationExpression(InvocationExpressionSyntax node)
    {
        if (frame is null || node.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" }) return node;
        return Opaque(node, "Call result observed; argument/return or external side-effect transport is unproven.");
    }
    public override SyntaxNode? VisitExpressionStatement(ExpressionStatementSyntax node)
    {
        if (frame is not null && node.Expression is InvocationExpressionSyntax && !Scalar(Type(node.Expression)))
            return Block(Gap(node, "Void/opaque call may mutate visible state."), node);
        return base.VisitExpressionStatement(node);
    }
    private static string? Access(ExpressionSyntax node) => node switch
    {
        IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
        MemberAccessExpressionSyntax member when Access(member.Expression) is string path => path + "." + member.Name.Identifier.ValueText,
        _ => null
    };
    public override SyntaxNode? VisitMemberAccessExpression(MemberAccessExpressionSyntax node)
    {
        if (frame is null || !Scalar(Type(node)) || Access(node) is not string access) return node;
        return Call("Field", Type(node)!, F, Text(Site(node)), Text(access), Number(Line(node)), node);
    }
    public override SyntaxNode? VisitElementAccessExpression(ElementAccessExpressionSyntax node) => frame is null ? node : Opaque(node, "Indexed field identity is not resolved.");
    public override SyntaxNode? VisitSwitchStatement(SwitchStatementSyntax node) => frame is null ? node : Block(Gap(node, "Switch body executes without scalar probes."), node);
    public override SyntaxNode? VisitCatchClause(CatchClauseSyntax node)
    {
        if (frame is null) return node;
        var visited = (CatchClauseSyntax)base.VisitCatchClause(node)!;
        return visited.WithBlock(visited.Block.WithStatements(visited.Block.Statements.Insert(0, Gap(node, "Exception boundary invalidates partially evaluated expression state."))));
    }
    public override SyntaxNode? VisitFinallyClause(FinallyClauseSyntax node)
    {
        if (frame is null) return node;
        var visited = (FinallyClauseSyntax)base.VisitFinallyClause(node)!;
        return visited.WithBlock(visited.Block.WithStatements(visited.Block.Statements.Insert(0, Gap(node, "Finally boundary invalidates interrupted expression state."))));
    }
}
