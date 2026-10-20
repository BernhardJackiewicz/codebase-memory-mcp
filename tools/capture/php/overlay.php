<?php declare(strict_types=1);
// Build a bounded source overlay. Never executes the target application.
spl_autoload_register(static function (string $class): void {
    if (str_starts_with($class, 'PhpParser\\')) {
        $path = __DIR__ . '/vendor/php-parser/lib/' . str_replace('\\', '/', $class) . '.php';
        if (is_file($path)) require $path;
    }
});
require __DIR__ . '/Instrumenter.php';
try {
    if ($argc !== 5 || $argv[1] !== '--root' || $argv[3] !== '--out')
        throw new RuntimeException('Usage: php overlay.php --root PROJECT --out NEW_DIRECTORY');
    $root = realpath($argv[2]);
    $parent = realpath(dirname($argv[4]));
    $output = $parent === false ? false : $parent . '/' . basename($argv[4]);
    if (!$root || !is_dir($root) || !$output || file_exists($output) || is_link($output) ||
        $output === $root || str_starts_with($output, $root . '/'))
        throw new RuntimeException('Use an existing project and a new output directory outside it.');
    if (file_exists($root . '/.cbm')) throw new RuntimeException('Reserved .cbm path already exists in the project.');
    $files = []; $gaps = []; $bytes = 0;
    $walk = function (string $directory) use (&$walk, &$files, &$gaps, &$bytes, $root): void {
        foreach (scandir($directory) ?: [] as $name) {
            if ($name === '.' || $name === '..') continue;
            $path = $directory . '/' . $name;
            if (is_link($path)) { $gaps[] = 'Symlink excluded: ' . substr($path, strlen($root) + 1); continue; }
            if (is_dir($path)) {
                if (!in_array($name, ['.git', 'vendor', 'node_modules', '.venv', 'cache', '.cbm'], true)) $walk($path);
            } elseif (is_file($path)) {
                $bytes += filesize($path);
                if (count($files) >= 2000 || $bytes > 64 * 1024 * 1024) throw new RuntimeException('Overlay exceeds 2,000 files / 64 MiB.');
                $files[] = $path;
            }
        }
    };
    $walk($root);
    $parser = (new PhpParser\ParserFactory())->createForHostVersion();
    $printer = new PhpParser\PrettyPrinter\Standard();
    mkdir($output, 0700);
    foreach ($files as $path) {
        $relative = substr($path, strlen($root) + 1);
        $destination = $output . '/' . $relative;
        if (!is_dir(dirname($destination))) mkdir(dirname($destination), 0700, true);
        $source = file_get_contents($path);
        if (str_ends_with(strtolower($path), '.php') && strlen($source) <= 4 * 1024 * 1024) {
            $nodes = $parser->parse($source) ?? [];
            $transformer = new CbmPhpInstrumenter($relative, hash('sha256', $source), $path);
            $source = $printer->prettyPrintFile($transformer->file($nodes)) . "\n";
        } elseif (str_ends_with(strtolower($path), '.php')) $gaps[] = 'Source exceeds 4 MiB: ' . $relative;
        file_put_contents($destination, $source);
    }
    mkdir($output . '/.cbm', 0700);
    copy(__DIR__ . '/Runtime.php', $output . '/.cbm/Runtime.php');
    file_put_contents($output . '/.cbm/manifest.json', json_encode(['schema_version' => 1, 'root' => $root, 'files' => count($files), 'gaps' => $gaps], JSON_PRETTY_PRINT) . "\n");
    echo json_encode(['root' => $output, 'files' => count($files), 'gaps' => $gaps,
        'instructions' => 'Start PHP manually with -d auto_prepend_file=' . $output . '/.cbm/Runtime.php and the copied entry point.']), "\n";
} catch (Throwable $error) {
    fwrite(STDERR, $error->getMessage() . "\n"); exit(1);
}
