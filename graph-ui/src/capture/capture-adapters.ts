import type { CaptureSession } from './capture-source';
export interface CaptureAdapter { profile: string; archive: string; sha256: string; size: number }
export type AdapterLoader = (signal: AbortSignal) => Promise<CaptureAdapter[]>;
export function readAdapterManifest(input: unknown): CaptureAdapter[] {
    const manifest = input as { schema_version?: unknown; adapters?: unknown };
    if (!manifest || manifest.schema_version !== 1 || !Array.isArray(manifest.adapters)
        || manifest.adapters.some(item => !item || typeof item.profile !== 'string' || !item.profile
            || typeof item.archive !== 'string' || !/^\/capture-adapters\/[a-z0-9-]+\.zip$/.test(item.archive)
            || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
            || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 32 * 1024 * 1024)
        || new Set(manifest.adapters.map(item => item.profile)).size !== manifest.adapters.length)
        throw new Error('The local adapter download manifest is invalid.');
    return manifest.adapters as CaptureAdapter[];
}
export const loadAdapters: AdapterLoader = async signal => {
    const response = await fetch('/capture-adapters/manifest.json', { signal, credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('This build does not provide a local adapter download manifest.');
    return readAdapterManifest(await response.json());
};
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
export const ADAPTER_DETAILS: Record<string, { prerequisites: string; limits: string }> = {
    node: { prerequisites: 'Node 20.6+ with native ESM (.mjs, module .js, .ts).',
        limits: 'CommonJS and framework build pipelines are not instrumented. Suspended flow and heap provenance remain gaps.' },
    browser: { prerequisites: 'Node 20.6+ and a browser, serving an existing native ESM development page.',
        limits: 'The exact overlay origin must be allowed by this session. Existing bundler servers are not instrumented.' },
    python: { prerequisites: 'An existing Python 3.9+ installation.',
        limits: 'Only scoped local imports are transformed. Dynamic scope, suspended caller transport and prior heap state remain gaps.' },
    go: { prerequisites: 'An existing Go 1.20+ toolchain and already cached application dependencies.',
        limits: 'Temporary Go build overlay; original files stay unchanged. Caller/goroutine transport, generics and prior heap state remain gaps.' },
    dotnet: { prerequisites: 'An existing .NET 10 SDK; the adapter uses its bundled Roslyn compiler. Application dependencies must already be cached.',
        limits: 'Temporary C# source overlay. Async/iterator bodies, references, overloaded operators and interprocedural transport remain gaps.' },
    jvm: { prerequisites: 'Python 3.9+ and an existing JDK 17+. Kotlin additionally needs an existing local compiler library directory.',
        limits: 'Temporary compiled sources and removable Java agent. Mixed-language frameworks, generated sources, named modules and suspended/indirect calls need separate support.' },
    rust: { prerequisites: 'macOS/Linux, Python 3.9+, Rust/Cargo 1.69+ and cached application dependencies. Parser sources are included.',
        limits: 'Offline temporary Cargo overlay with compiler-checked primitive values. Ownership/borrows, call transport, generics and source-position-sensitive macros remain gaps.' },
    php: { prerequisites: 'PHP 8.1+ with tokenizer, json and ctype. The parser is included; no Composer installation is needed.',
        limits: 'Temporary source copy with auto_prepend_file. Original-path includes, closures, references and caller transport remain gaps; framework/FPM launches need explicit configuration.' },
    native: { prerequisites: 'macOS/Linux, Python 3 and an existing Clang C/C++ compiler.',
        limits: 'Temporary Clang VFS overlay for integral/bool locals and field observations. Pointers, references, volatile/floating values, callbacks, templates, constexpr and unproven call/control chains remain gaps.' },
};
export function adapterCommands(session: CaptureSession, endpoint: string, origin?: string): string | undefined {
    if (!ADAPTER_DETAILS[session.profile]) return undefined;
    let browserPort = '';
    if (session.profile === 'browser') {
        try {
            const url = new URL(origin ?? '');
            if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== origin) return undefined;
            browserPort = url.port;
        } catch { return undefined; }
    }
    const common = [
        '# Replace these paths with the project and extracted adapter directories.',
        "export CBM_CAPTURE_ROOT='/absolute/path/to/project'",
        "export CBM_CAPTURE_ADAPTER='/absolute/path/to/adapter'",
        ...(['go', 'dotnet', 'jvm', 'php', 'native'].includes(session.profile) ? [
            '# Choose a new directory outside the project; its parent must exist.',
            "export CBM_CAPTURE_OVERLAY='/absolute/path/to/new-temporary-overlay'",
        ] : []),
        `export CBM_CAPTURE_ENDPOINT=${quote(endpoint)}`,
        '# Paste the session token at the hidden prompt, then press Return.',
        'read -r -s CBM_CAPTURE_TOKEN', 'export CBM_CAPTURE_TOKEN',
        `export CBM_CAPTURE_VALUES=${session.values_enabled ? '1' : '0'}`,
        `export CBM_CAPTURE_FIELDS=${quote(JSON.stringify(session.values_enabled ? session.allowed_fields : []))}`,
    ];
    if (session.profile === 'node') common.push('node --import "$CBM_CAPTURE_ADAPTER/register.mjs" "$CBM_CAPTURE_ROOT/app.mjs"');
    if (session.profile === 'python') common.push('python3 "$CBM_CAPTURE_ADAPTER/cbm_capture_python.py" --root "$CBM_CAPTURE_ROOT" --script "$CBM_CAPTURE_ROOT/app.py"');
    if (session.profile === 'browser') {
        common.push(`export CBM_CAPTURE_BROWSER_PORT=${quote(browserPort)}`, 'node "$CBM_CAPTURE_ADAPTER/browser.mjs"');
    }
    if (session.profile === 'go') common.push(
        '(cd "$CBM_CAPTURE_ADAPTER" && GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go run . --root "$CBM_CAPTURE_ROOT" --out "$CBM_CAPTURE_OVERLAY")',
        '(cd "$CBM_CAPTURE_ROOT" && GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go run -overlay "$CBM_CAPTURE_OVERLAY/overlay.json" .)');
    if (session.profile === 'dotnet') common.push(
        'dotnet restore "$CBM_CAPTURE_ADAPTER/CaptureTool.csproj" --configfile "$CBM_CAPTURE_ADAPTER/NuGet.Config"',
        'dotnet build "$CBM_CAPTURE_ADAPTER/CaptureTool.csproj" --no-restore',
        'dotnet "$CBM_CAPTURE_ADAPTER/bin/Debug/net10.0/CaptureTool.dll" --root "$CBM_CAPTURE_ROOT" --out "$CBM_CAPTURE_OVERLAY"',
        '# Replace YourProject.csproj with the copied application project.',
        'dotnet restore "$CBM_CAPTURE_OVERLAY/YourProject.csproj" --configfile "$CBM_CAPTURE_ADAPTER/NuGet.Config"',
        'dotnet run --no-restore --project "$CBM_CAPTURE_OVERLAY/YourProject.csproj"');
    if (session.profile === 'jvm') common.push(
        '# For Kotlin: set CBM_KOTLIN_LIB to the local compiler lib directory and use --language kotlin.',
        'python3 "$CBM_CAPTURE_ADAPTER/build.py" --root "$CBM_CAPTURE_ROOT" --output "$CBM_CAPTURE_OVERLAY" --language java',
        `CBM_CAPTURE_CLASSPATH="$(python3 -c 'import json,os; print(json.load(open(os.environ["CBM_CAPTURE_OVERLAY"]+"/overlay.json"))["classpath"])')"`,
        '# Replace your.package.Main with the actual main class (Kotlin often uses MainKt).',
        'java "-javaagent:$CBM_CAPTURE_OVERLAY/cbm-capture-agent.jar=$CBM_CAPTURE_OVERLAY/sources.cbm" -cp "$CBM_CAPTURE_CLASSPATH" your.package.Main');
    if (session.profile === 'rust') common.push(
        '# Add --bin name for a workspace with multiple binaries; application arguments follow --.',
        'python3 "$CBM_CAPTURE_ADAPTER/cbm_capture_rust.py" --root "$CBM_CAPTURE_ROOT" --manifest Cargo.toml');
    if (session.profile === 'php') common.push(
        'php "$CBM_CAPTURE_ADAPTER/overlay.php" --root "$CBM_CAPTURE_ROOT" --out "$CBM_CAPTURE_OVERLAY"',
        '# Replace app.php with the copied application entry point.',
        'php -d "auto_prepend_file=$CBM_CAPTURE_OVERLAY/.cbm/Runtime.php" "$CBM_CAPTURE_OVERLAY/app.php"');
    if (session.profile === 'native') common.push(
        '# Replace main.cpp and compiler flags with the selected development translation unit.',
        '# For C, use --source main.c --compiler clang -- -std=c11.',
        'python3 "$CBM_CAPTURE_ADAPTER/instrument.py" --root "$CBM_CAPTURE_ROOT" --source main.cpp --out "$CBM_CAPTURE_OVERLAY" --compiler clang++ -- -std=c++17',
        'python3 "$CBM_CAPTURE_ADAPTER/build.py" --manifest "$CBM_CAPTURE_OVERLAY/capture.json" --output "$CBM_CAPTURE_OVERLAY/program"',
        'python3 "$CBM_CAPTURE_ADAPTER/launch.py" -- "$CBM_CAPTURE_OVERLAY/program"');
    return common.join('\n');
}
