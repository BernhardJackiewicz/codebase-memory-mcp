# PHP 8.1+ development source overlay

The archive includes PHP-Parser 5.4.0 and its BSD license. No Composer command,
dependency install or application execution is performed by the generator.
Use an existing PHP runtime with tokenizer/json/ctype:

```sh
php /path/to/adapter/overlay.php --root /path/to/project --out /path/to/new-overlay
```

Create a PHP capture session in Lens and set the session environment described
in the common README. Start the copied application manually:

```sh
php -d auto_prepend_file=/path/to/new-overlay/.cbm/Runtime.php /path/to/new-overlay/app.php
```

Only the new directory is written. Stop/delete the Lens session and return to the
original launch command to remove instrumentation. CLI and PHP's per-request
development server support `auto_prepend_file`; a custom framework/FPM launch
must explicitly use the copied source and the same prepend file.

The copy is bounded to 2,000 files / 64 MiB and 4 MiB per instrumented source.
It excludes symlinks, dependencies, caches and hidden VCS metadata.
Original `__FILE__`, `__DIR__` and `__LINE__` constants are preserved. Includes
resolved through those original paths execute original code without probes;
such external/module transport is not established by this adapter.

Named functions and methods observe scalar parameters, local binding versions,
copies, supported arithmetic/concatenation, writes and returns. Each invocation
has its own frame. Actual static property and array-field reads are evaluated
once; their prior heap/array state is an explicit gap. Closures, references,
generators, dynamic variables, introspection, static/global locals and unsupported
control constructs remain conservative gaps. Caller argument/return transport
is not yet proven across functions. No value equality creates a link.

Local writes prepare RHS identity, classify the prior target with builtin type
checks after RHS evaluation, execute the original assignment, then commit the
observation. No prior object is retained across the store. Releasing a prior
object, array or resource creates a post-store lifetime gap and invalidates local
binding versions, because a destructor can change any of them. The evaluated
assignment expression remains a separate occurrence; it is not treated as the
target's current binding. A builtin type change during a typed-reference store
also creates a coercion gap instead of claiming an unchanged copy. Fresh scalar
writes and actual scalar field/call results can establish subsequent lineage.

Raw previews require both session opt-in and the same exact `CBM_CAPTURE_FIELDS`
list. They are bounded builtin primitives; no object dump, getter, serializer or
conversion is invoked to obtain a preview. The runtime is memory-only, caps at
10,000 events, sends batches of up to 128, flushes completed value-returning
functions and at request shutdown, and disables delivery after a failed bounded
local HTTP request. Probes add execution overhead and change stack frames;
use development workloads only.

`python3 -m unittest discover -s tools/capture/php -p 'test_*.py'` executes actual
original and copied programs. `verify_native.py --binary PATH --out /tmp/evidence`
checks both preview modes, original source hashes and verified reader content
against an isolated real native receiver.
