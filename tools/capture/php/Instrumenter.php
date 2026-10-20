<?php declare(strict_types=1);
use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Stmt;
use PhpParser\Node\Scalar;

final class CbmPhpInstrumenter {
    private ?string $frame = null;
    private PhpParser\NodeFinder $finder;
    private array $coverage = [];
    public function __construct(private string $path, private string $hash, private string $original) {
        $this->finder = new PhpParser\NodeFinder();
    }
    private function text(string $value): Scalar\String_ { return new Scalar\String_($value); }
    private function number(int $value): Scalar\Int_ { return new Scalar\Int_($value); }
    private function site(Node $node): string { return $node->getType() . ':' . $node->getStartFilePos(); }
    private function call(string $method, array $arguments): Expr\MethodCall {
        return new Expr\MethodCall(new Expr\Variable($this->frame), $method, array_map(fn($arg) => new Node\Arg($arg), $arguments));
    }
    private function gap(Node $node, string $detail): Stmt\Expression {
        return new Stmt\Expression($this->call('gap', [$this->number($node->getStartLine()), $this->text($detail)]));
    }
    public function file(array $nodes): array {
        $traverser = new PhpParser\NodeTraverser(new class($this->original) extends PhpParser\NodeVisitorAbstract {
            public function __construct(private string $original) {}
            public function enterNode(Node $node) {
                if ($node instanceof Scalar\MagicConst\File) return new Scalar\String_($this->original, $node->getAttributes());
                if ($node instanceof Scalar\MagicConst\Dir) return new Scalar\String_(dirname($this->original), $node->getAttributes());
                if ($node instanceof Scalar\MagicConst\Line) return new Scalar\Int_($node->getStartLine(), $node->getAttributes());
                return null;
            }
        });
        $nodes = $this->declarations($traverser->traverse($nodes));
        if ($this->coverage) {
            $statements = array_map(fn($item) => new Stmt\Expression(new Expr\StaticCall(
                new Node\Name\FullyQualified('CbmLocalCapture\\Probe'), 'coverage',
                array_map(fn($arg) => new Node\Arg($arg), [$this->text($this->path), $this->text($this->hash),
                    $this->text($item[0]), $this->number($item[1])]))), $this->coverage);
            foreach ($nodes as $node) {
                if ($node instanceof Stmt\Namespace_) {
                    $node->stmts = array_merge($statements, $node->stmts);
                    return $nodes;
                }
            }
            $index = 0;
            while (isset($nodes[$index]) && $nodes[$index] instanceof Stmt\Declare_) $index++;
            array_splice($nodes, $index, 0, $statements);
        }
        return $nodes;
    }
    private function declarations(array $nodes): array {
        foreach ($nodes as $node) {
            if ($node instanceof Stmt\Function_ || $node instanceof Stmt\ClassMethod) $this->function($node);
            else foreach ($node->getSubNodeNames() as $name) {
                if (is_array($node->$name) && $node->$name && reset($node->$name) instanceof Node) $node->$name = $this->declarations($node->$name);
                elseif ($node->$name instanceof Node) $this->declarations([$node->$name]);
            }
        }
        return $nodes;
    }
    private function function(Stmt\Function_|Stmt\ClassMethod $node): void {
        if ($node->stmts === null) return;
        $previous = $this->frame;
        $this->frame = '_cbm_' . substr($this->hash, 0, 10) . '_' . $node->getStartFilePos();
        while ($this->finder->findFirst($node->stmts, fn(Node $child) => $child instanceof Expr\Variable && $child->name === $this->frame)) $this->frame .= 'x';
        $entry = new Stmt\Expression(new Expr\Assign(new Expr\Variable($this->frame), new Expr\New_(
            new Node\Name\FullyQualified('CbmLocalCapture\\Frame'), array_map(fn($arg) => new Node\Arg($arg),
                [$this->text($this->path), $this->text($this->hash), $this->text($node->name->toString())]))));
        $unsafe = $node->byRef || array_filter($node->params, fn($parameter) => $parameter->byRef || $parameter->variadic) ||
            $this->finder->findFirst($node->stmts, function (Node $child): bool {
                if ($child instanceof Expr\Closure || $child instanceof Expr\ArrowFunction || $child instanceof Expr\AssignRef ||
                    $child instanceof Expr\Yield_ || $child instanceof Expr\YieldFrom || $child instanceof Stmt\Global_ || $child instanceof Stmt\Static_ ||
                    $child instanceof Expr\Eval_ || $child instanceof Expr\Variable && !is_string($child->name)) return true;
                return $child instanceof Expr\FuncCall && (!($child->name instanceof Node\Name) ||
                    in_array(strtolower($child->name->toString()), ['get_defined_vars', 'extract', 'compact', 'parse_str', 'debug_backtrace', 'func_get_args'], true));
            });
        if ($unsafe) {
            $this->coverage[] = [$node->name->toString(), $node->getStartLine()];
            $this->frame = $previous;
            return;
        }
        $prefix = [$entry, $this->gap($node, $unsafe ? 'References, closures, generators or dynamic scope execute unchanged.' : 'Caller argument transport is not established by this intraprocedural adapter.')];
        if (!$unsafe) foreach ($node->params as $parameter) {
            if (is_string($parameter->var->name)) $prefix[] = new Stmt\Expression($this->call('parameter',
                [$this->text($parameter->var->name), $this->number($parameter->getStartLine()), $parameter->var]));
        }
        $node->stmts = array_merge($prefix, $unsafe ? $node->stmts : $this->statements($node->stmts));
        $this->frame = $previous;
    }
    private function statements(array $statements): array {
        $result = [];
        foreach ($statements as $node) {
            if ($node instanceof Stmt\Expression) $node->expr = $this->expression($node->expr);
            elseif ($node instanceof Stmt\Return_) {
                if ($node->expr !== null) {
                    $original = $node->expr;
                    $node->expr = $this->call('returned', [$this->text($this->site($node)), $this->number($node->getStartLine()),
                        $this->expression($original), $this->text($this->site($original))]);
                }
            } elseif ($node instanceof Stmt\If_) {
                $node->cond = $this->expression($node->cond); $node->stmts = $this->statements($node->stmts);
                foreach ($node->elseifs as $elseif) { $elseif->cond = $this->expression($elseif->cond); $elseif->stmts = $this->statements($elseif->stmts); }
                if ($node->else) $node->else->stmts = $this->statements($node->else->stmts);
            } elseif ($node instanceof Stmt\While_ || $node instanceof Stmt\Do_) {
                $node->cond = $this->expression($node->cond); $node->stmts = $this->statements($node->stmts);
            } elseif (!($node instanceof Stmt\Break_ || $node instanceof Stmt\Continue_ || $node instanceof Stmt\Nop))
                $result[] = $this->gap($node, $node->getType() . ' executes unchanged without scalar transfer rules.');
            $result[] = $node;
        }
        return $result;
    }
    private function access(Expr $node): ?string {
        if ($node instanceof Expr\Variable && is_string($node->name)) return $node->name;
        if ($node instanceof Expr\PropertyFetch && $node->name instanceof Node\Identifier && ($base = $this->access($node->var)) !== null)
            return $base . '.' . $node->name->toString();
        if ($node instanceof Expr\ArrayDimFetch && ($base = $this->access($node->var)) !== null) {
            if ($node->dim instanceof Scalar\String_) return preg_match('/^[a-zA-Z_][a-zA-Z0-9_]*$/D', $node->dim->value)
                ? $base . '.' . $node->dim->value : $base . '[' . json_encode($node->dim->value, JSON_UNESCAPED_UNICODE) . ']';
            if ($node->dim instanceof Scalar\Int_) return $base . '[' . $node->dim->value . ']';
        }
        return null;
    }
    private function expression(Expr $node): Expr {
        $site = $this->text($this->site($node)); $line = $this->number($node->getStartLine());
        if ($node instanceof Expr\Variable && is_string($node->name)) return $this->call('read', [$site, $this->text($node->name), $line, $node]);
        if ($node instanceof Scalar\String_ || $node instanceof Scalar\Int_ || $node instanceof Scalar\Float_ ||
            $node instanceof Expr\ConstFetch && in_array(strtolower($node->name->toString()), ['true', 'false', 'null'], true))
            return $this->call('value', [$site, $line, $node]);
        if ($node instanceof Expr\Assign && $node->var instanceof Expr\Variable && is_string($node->var->name)) {
            $original = $node->expr;
            $name = $node->var->name;
            $oldTarget = fn() => new Expr\BinaryOp\Coalesce(new Expr\Variable($name), new Expr\ConstFetch(new Node\Name('null')));
            $safeOldTarget = new Expr\BinaryOp\BooleanOr(
                new Expr\FuncCall(new Node\Name\FullyQualified('is_scalar'), [new Node\Arg($oldTarget())]),
                new Expr\FuncCall(new Node\Name\FullyQualified('is_null'), [new Node\Arg($oldTarget())]));
            // Arguments evaluate RHS before classifying the actual old target.
            // Only a boolean enters prepareAssign; no old object crosses STORE.
            $node->expr = $this->call('prepareAssign', [$site, $line, $this->expression($original),
                $this->text($this->site($original)), $safeOldTarget]);
            return $this->call('assign', [$site, $this->text($name), $line, $node]);
        }
        if ($node instanceof Expr\PropertyFetch || $node instanceof Expr\ArrayDimFetch) {
            $path = $this->access($node);
            if ($path !== null) return $this->call('field', [$site, $this->text($path), $line, $node]);
        }
        if ($node instanceof Expr\BinaryOp\Plus || $node instanceof Expr\BinaryOp\Minus || $node instanceof Expr\BinaryOp\Mul ||
            $node instanceof Expr\BinaryOp\Div || $node instanceof Expr\BinaryOp\Mod || $node instanceof Expr\BinaryOp\Concat) {
            $left = $this->site($node->left); $right = $this->site($node->right);
            $node->left = $this->expression($node->left); $node->right = $this->expression($node->right);
            return $this->call('operation', [$site, $line, $node, $this->text($left), $this->text($right)]);
        }
        return $this->call('opaque', [$site, $line, $node, $this->text($node->getType() . ' has no established scalar transfer rule.')]);
    }
}
