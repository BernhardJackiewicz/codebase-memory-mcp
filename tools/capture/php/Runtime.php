<?php declare(strict_types=1);
namespace CbmLocalCapture;

final class Frame {
    private array $bindings = [], $sites = [], $primitive = [], $assignments = [];
    public readonly string $invocation;
    public function __construct(public readonly string $path, public readonly string $hash, public readonly string $symbol) {
        $this->invocation = Probe::invocation();
    }
    public function gap(int $line, string $detail): void {
        $this->bindings = []; $this->sites = []; $this->primitive = [];
        Probe::emit($this, 'gap', $line, [], detail: $detail);
    }
    private function scalar(mixed $value): bool { return $value === null || is_string($value) || is_int($value) || is_float($value) || is_bool($value); }
    private function remember(string $site, ?string $id, mixed $value): void { $this->sites[$site] = $id; $this->primitive[$site] = $this->scalar($value); }
    public function parameter(string $name, int $line, mixed $value): void {
        if (!$this->scalar($value)) { $this->gap($line, 'Nonprimitive parameter has no scalar state lineage.'); return; }
        $this->bindings[$name] = Probe::emit($this, 'value', $line, [], $name, $value);
    }
    public function value(string $site, int $line, mixed $value): mixed {
        $this->remember($site, Probe::emit($this, 'value', $line, []), $value); return $value;
    }
    public function read(string $site, string $name, int $line, mixed $value): mixed {
        if (!$this->scalar($value)) $this->gap($line, 'Nonprimitive read may participate in user conversion; scalar assumptions invalidated.');
        $this->remember($site, Probe::emit($this, 'copy', $line, array_filter([$this->bindings[$name] ?? null]), $name, $value), $value); return $value;
    }
    public function prepareAssign(string $site, int $line, mixed $value, string $input, bool $safeOldTarget): mixed {
        if (!$this->scalar($value)) $this->gap($line, 'Nonprimitive assignment has no object-state proof.');
        // Keep only IDs and builtin type facts. No prior object or RHS is retained
        // across STORE, so a destructor still runs at its original release point.
        $this->assignments[$site] = ['input' => $this->sites[$input] ?? null, 'safe' => $safeOldTarget, 'type' => gettype($value)];
        return $value;
    }
    public function assign(string $site, string $name, int $line, mixed $value): mixed {
        $prepared = $this->assignments[$site] ?? ['input' => null, 'safe' => false];
        unset($this->assignments[$site]);
        // This probe runs after the actual STORE. Releasing an object, array or
        // resource may mutate any local, including the assignment target itself.
        if (!$prepared['safe']) $this->gap($line, 'Unknown prior value lifetime during assignment; released state may mutate local bindings.');
        if (($prepared['type'] ?? null) !== gettype($value)) {
            $this->gap($line, 'Assignment coercion changed the builtin value type; RHS transport is not established.');
            $prepared['input'] = null;
        }
        $id = Probe::emit($this, 'copy', $line, array_filter([$prepared['input']]), $name, $value);
        if ($prepared['safe'] && $this->scalar($value)) $this->bindings[$name] = $id;
        // The assignment-expression result remains its own observed occurrence,
        // even when a destructor changes the target. It is not a new binding.
        $this->remember($site, $id, $value);
        return $value;
    }
    public function operation(string $site, int $line, mixed $value, string $left, string $right): mixed {
        if (!($this->primitive[$left] ?? false) || !($this->primitive[$right] ?? false)) {
            $this->gap($line, 'Overloaded or nonprimitive operation has no proven scalar transport.');
            return $this->value($site, $line, $value);
        }
        $this->remember($site, Probe::emit($this, 'transform', $line, array_filter([$this->sites[$left] ?? null, $this->sites[$right] ?? null])), $value);
        return $value;
    }
    public function returned(string $site, int $line, mixed $value, string $input): mixed {
        if (!$this->scalar($value)) $this->gap($line, 'Object return does not establish heap-state lineage.');
        $this->remember($site, Probe::emit($this, 'return', $line, array_filter([$this->sites[$input] ?? null])), $value);
        Probe::flush(); return $value;
    }
    public function opaque(string $site, int $line, mixed $value, string $detail): mixed { $this->gap($line, $detail); return $this->value($site, $line, $value); }
    public function field(string $site, string $path, int $line, mixed $value): mixed {
        $this->gap($line, 'Field/accessor result observed once; prior object or array state is unproven.');
        $this->remember($site, Probe::emit($this, 'field', $line, [], $path, $value), $value); return $value;
    }
}

final class Probe {
    private static int $sequence = 0, $invocations = 0;
    private static array $queue = [], $fields = [];
    private static ?array $endpoint = null;
    private static string $token = '', $producer = '';
    private static bool $values = false, $disabled = false, $initialized = false;
    public static function invocation(): string { return 'i' . ++self::$invocations; }
    public static function coverage(string $path, string $hash, string $symbol, int $line): void {
        self::emit(new Frame($path, $hash, $symbol), 'gap', $line, [], detail: 'References, closures, generators or dynamic scope execute unchanged without injected locals.');
    }
    private static function init(): void {
        if (self::$initialized) return;
        self::$initialized = true;
        self::$producer = 'php-' . bin2hex(random_bytes(12));
        $parsed = parse_url(getenv('CBM_CAPTURE_ENDPOINT') ?: '');
        $token = getenv('CBM_CAPTURE_TOKEN') ?: '';
        if (is_array($parsed) && ($parsed['scheme'] ?? '') === 'http' &&
            in_array($parsed['host'] ?? '', ['localhost', '127.0.0.1', '[::1]'], true) &&
            ($parsed['path'] ?? '') === '/v1/cbm/lineage' && !isset($parsed['user']) && !isset($parsed['pass']) && !isset($parsed['fragment']) &&
            $token !== '' && strlen($token) <= 256 && !str_contains($token, "\r") && !str_contains($token, "\n")) {
            self::$endpoint = $parsed; self::$token = $token;
        }
        self::$values = getenv('CBM_CAPTURE_VALUES') === '1';
        $fields = json_decode(getenv('CBM_CAPTURE_FIELDS') ?: '[]', true);
        if (is_array($fields) && array_is_list($fields) && count($fields) <= 64)
            foreach ($fields as $field) if (is_string($field) && strlen($field) > 0 && strlen($field) <= 200 && !str_contains($field, '*') && !preg_match('/[\x00-\x1f]/', $field)) self::$fields[$field] = true;
        register_shutdown_function([self::class, 'flush']);
    }
    public static function emit(Frame $frame, string $operation, int $line, array $inputs, ?string $access = null, mixed $value = null, ?string $detail = null): ?string {
        self::init();
        if (self::$disabled || self::$endpoint === null || self::$sequence >= 10000) return null;
        $sequence = ++self::$sequence; $id = 'v' . $sequence;
        $source = ['file_path' => $frame->path, 'source_hash' => $frame->hash, 'line' => max(1, $line)];
        if (strlen($frame->symbol) <= 1024) $source['symbol'] = $frame->symbol;
        $event = ['sequence' => $sequence, 'value_id' => $id, 'invocation_id' => $frame->invocation,
                  'operation' => $operation, 'inputs' => array_values(array_unique($inputs)), 'source' => $source];
        if ($access !== null && strlen($access) > 0 && strlen($access) <= 200) $event['access_path'] = $access;
        if ($detail !== null) $event['detail'] = $detail;
        if ($sequence === 10000) {
            $event['operation'] = 'gap'; $event['inputs'] = []; $event['detail'] = 'Producer event budget reached; subsequent execution is unobserved.';
        } elseif (self::$values && isset($event['access_path'], self::$fields[$access])) {
            if ($value === null || is_bool($value) || is_int($value) && abs($value) <= 9007199254740991 || is_float($value) && is_finite($value)) $event['preview'] = $value;
            elseif (is_string($value)) {
                $text = substr($value, 0, 256);
                // Cut only incomplete UTF-8 tails; never invoke user converters.
                while ($text !== '' && !preg_match('//u', $text)) $text = substr($text, 0, -1);
                $event['preview'] = $text;
            }
        }
        self::$queue[] = $event;
        if (count(self::$queue) >= 128) self::send();
        return $sequence < 10000 ? $id : null;
    }
    private static function send(): void {
        if (!self::$queue || self::$disabled || self::$endpoint === null) return;
        $batch = array_splice(self::$queue, 0, 128);
        $body = json_encode(['schema_version' => 1, 'producer' => ['id' => self::$producer, 'language' => 'php'], 'events' => $batch], JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
        $host = self::$endpoint['host'] === 'localhost' ? '127.0.0.1' : self::$endpoint['host'];
        $port = self::$endpoint['port'] ?? 80;
        $path = '/v1/cbm/lineage' . (isset(self::$endpoint['query']) ? '?' . self::$endpoint['query'] : '');
        $socket = @stream_socket_client('tcp://' . $host . ':' . $port, $errno, $error, .25);
        if (!$socket) { self::$disabled = true; return; }
        stream_set_timeout($socket, 0, 250000);
        $data = "POST $path HTTP/1.1\r\nHost: $host:$port\r\nAuthorization: Bearer " . self::$token .
                "\r\nContent-Type: application/json\r\nContent-Length: " . strlen($body) . "\r\nConnection: close\r\n\r\n" . $body;
        $sent = 0; $started = microtime(true);
        while ($sent < strlen($data) && microtime(true) - $started < .3) {
            $count = @fwrite($socket, substr($data, $sent)); if (!$count) break; $sent += $count;
        }
        $status = @fgets($socket, 256) ?: ''; fclose($socket);
        if ($sent !== strlen($data) || !preg_match('/^HTTP\/1\.[01] 2\d\d /', $status)) self::$disabled = true;
    }
    public static function flush(): void {
        $started = microtime(true);
        while (self::$queue && !self::$disabled && microtime(true) - $started < 1) self::send();
        self::$queue = [];
    }
}
