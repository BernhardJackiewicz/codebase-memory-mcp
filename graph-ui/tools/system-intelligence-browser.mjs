#!/usr/bin/env node
/**
 * Headed acceptance against a freshly indexed, disposable native project.
 * Build the native binary and graph-ui/dist first; no installed daemon, real
 * project index, Git remote or external service is touched by this runner.
 *
 * node tools/system-intelligence-browser.mjs --binary ../build/c/codebase-memory-mcp
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startStaticProxy } from './lib/static-proxy.mjs';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const pause = ms => new Promise(done => setTimeout(done, ms));

// A real, deterministic PDF fixture, using the same classic cross-reference
// form as the native PDF parser tests. No synthetic API response is injected.
function sourceEvidencePdf(pages) {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ];
    for (let index = 0; index < pages.length; index++) {
        const commands = ['BT /F1 12 Tf 72 740 Td 16 TL', ...pages[index].map((line, at) =>
            `${at ? 'T* ' : ''}(${line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj`), 'ET'].join('\n');
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
            `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`);
    }
    let pdf = '%PDF-1.7\n';
    const offsets = [0];
    for (let index = 0; index < objects.length; index++) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
        + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
        + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
}

export function isolatedEnvironment(caller, work) {
    return { ...caller, CBM_CACHE_DIR: join(work, 'cache'), CBM_RUNTIME_DIR: join(work, 'runtime'), CBM_ALLOWED_ROOT: work };
}

export function parseBrowserOptions(args) {
    const options = {
        binary: resolve(toolsDir, '../../build/c/codebase-memory-mcp'),
        dist: resolve(toolsDir, '../dist'),
        fixture: join(toolsDir, 'fixtures/system-intelligence'),
        out: undefined, headless: false, keepTemp: false,
        only: ['docs', 'system', 'regression'], help: false,
    };
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--headless') options.headless = true;
        else if (arg === '--keep-temp') options.keepTemp = true;
        else if (arg === '--help') options.help = true;
        else if (['--binary', '--dist', '--fixture', '--out', '--only'].includes(arg)) {
            const value = args[++i];
            if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
            if (arg === '--only') {
                options.only = value.split(',');
                if (!options.only.length || options.only.some(item => !['docs', 'system', 'field', 'capture', 'runtime', 'adapters', 'regression'].includes(item))) {
                    throw new Error('Unknown acceptance group (choose docs,system,field,capture,runtime,adapters,regression)');
                }
            } else options[arg.slice(2)] = resolve(value);
        } else throw new Error(`Unknown option: ${arg}`);
    }
    return options;
}

/** Camera proof needs movement of the same projected node, not animation. */
export function geometryChanged(before, after, threshold = 3) {
    return before.some(previous => {
        const next = after.find(item => item.id === previous.id);
        return next && ['x', 'y', 'width', 'height'].some(key => Math.abs(previous[key] - next[key]) > threshold);
    });
}

async function eventually(check, message, timeout = 20_000) {
    const until = Date.now() + timeout;
    let lastError;
    while (Date.now() < until) {
        try { if (await check()) return; } catch (error) { lastError = error; }
        await pause(150);
    }
    throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function freePort() {
    const server = net.createServer();
    await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
    const port = server.address().port;
    await new Promise(done => server.close(done));
    return port;
}

async function isPortFree(port) {
    return new Promise(done => {
        const probe = net.createServer();
        probe.once('error', () => done(false));
        probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
    });
}

function command(binary, args, env, timeout = 90_000, input) {
    return new Promise((done, fail) => {
        const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', error => { clearTimeout(timer); fail(error); });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            const result = { code, signal, stdout, stderr };
            if (code !== 0) fail(Object.assign(new Error(`${binary} ${args[0]} exited ${code ?? signal}: ${stderr.slice(-2000)}`), { result }));
            else done(result);
        });
        child.stdin.end(input ?? '');
    });
}

async function closeChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    try { await eventually(() => child.exitCode !== null || child.signalCode !== null, 'MCP child did not exit', 4000); }
    catch {
        child.kill('SIGTERM');
        await eventually(() => child.exitCode !== null || child.signalCode !== null, 'Own MCP child did not stop', 4000);
    }
}

async function main() {
    const options = parseBrowserOptions(process.argv.slice(2));
    if (options.help) {
        console.log('Usage: node tools/system-intelligence-browser.mjs [--binary PATH] [--dist PATH] [--fixture PATH] [--out PATH] [--only docs,system,field,capture,runtime,adapters,regression] [--headless] [--keep-temp]');
        return;
    }
    await Promise.all([access(options.binary), access(join(options.dist, 'index.html')), access(join(options.fixture, 'README.md'))]);
    // macOS TMPDIR is too deep for the daemon's Unix socket (sun_path=104).
    const work = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'cbm-browser-'));
    const output = options.out ?? await mkdtemp(join(tmpdir(), 'cbm-system-browser-evidence-'));
    const env = isolatedEnvironment(process.env, work);
    await Promise.all([mkdir(env.CBM_CACHE_DIR, { mode: 0o700 }), mkdir(env.CBM_RUNTIME_DIR, { mode: 0o700 }), mkdir(output, { recursive: true })]);
    const repoPath = join(work, 'fixture');
    const project = `system-intelligence-${Date.now()}`;
    const report = {
        started: new Date().toISOString(), headed: !options.headless, binary: options.binary, dist: options.dist,
        binarySha256: createHash('sha256').update(await readFile(options.binary)).digest('hex'),
        frontendIndexSha256: createHash('sha256').update(await readFile(join(options.dist, 'index.html'))).digest('hex'),
        project, repoPath, isolation: { cache: env.CBM_CACHE_DIR, runtime: env.CBM_RUNTIME_DIR, homePreserved: env.HOME === process.env.HOME },
        cases: [], screenshots: [], camera: [], console: [], pageErrors: [], requests: [], expectedApiFailures: [], failedRequests: [], externalRequests: [], nativeLog: [],
    };
    let browser, context, page, proxy, nativeChild, nativePort, proxyPort;
    let failed = false;
    const screenshot = async name => {
        const filename = `${name}.png`;
        await page.screenshot({ path: join(output, filename), fullPage: true, animations: 'disabled' });
        report.screenshots.push(filename);
    };
    const run = async (name, action) => {
        const started = Date.now();
        try {
            await action();
            report.cases.push({ name, status: 'passed', durationMs: Date.now() - started });
            console.log(`PASS ${name}`);
        } catch (error) {
            failed = true;
            report.cases.push({ name, status: 'failed', durationMs: Date.now() - started, error: String(error.stack ?? error) });
            if (page && !page.isClosed()) await screenshot(`failure-${name.replaceAll(/[^a-z0-9]+/gi, '-')}`).catch(() => {});
            console.error(`FAIL ${name}: ${error.message}`);
        }
        await writeFile(join(output, 'report-in-progress.json'), `${JSON.stringify(report, null, 2)}\n`);
    };
    const workspace = async name => {
        const close = page.getByRole('button', { name: 'Close source evidence', exact: true });
        if (await close.isVisible()) await close.click();
        await page.locator(`[data-workspace-tab="${name}"]`).click();
        await eventually(async () => await page.locator('.atlas-shell').getAttribute('data-workspace') === name, `Workspace ${name} not active`);
    };
    const architecture = async view => {
        await workspace('architecture');
        await page.locator(`.atlas-arch-tab[data-view="${view}"]`).click();
    };
    const closeEvidence = async () => {
        await page.getByRole('button', { name: 'Close source evidence', exact: true }).click();
    };
    const verifyEvidenceSource = async expected => {
        const drawer = page.getByRole('dialog', { name: 'Source evidence' });
        await drawer.locator('.source-evidence-lines').waitFor();
        const text = await drawer.locator('.source-evidence-lines').innerText();
        assert(text.trim().length > 0, 'Native source drawer returned no source text');
        if (expected) assert.match(text, expected);
        assert.equal(await drawer.getByRole('alert').count(), 0, 'Source evidence was not verified');
    };
    const labels = () => page.locator('[data-testid="system-graph"] .system-scene-node-label').evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect();
        return { id: node.getAttribute('data-node-id'), x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    const cameraGesture = async (name, gesture) => {
        const scene = page.locator('[data-testid="system-graph"] [data-testid="system-scene"]');
        await scene.scrollIntoViewIfNeeded();
        await eventually(async () => (await labels()).length > 0, 'No projected nodes to prove camera movement');
        await pause(250);
        const before = await labels();
        await screenshot(`${name}-before`);
        await gesture(await scene.boundingBox());
        await eventually(async () => geometryChanged(before, await labels()), `${name}: projected nodes did not move`);
        const after = await labels();
        report.camera.push({ name, before, after });
        await screenshot(`${name}-after`);
    };
    const drag = async (box, button = 'left') => {
        assert(box, 'Camera canvas must have bounds');
        // Use a clear strip above the node labels; act on the actual canvas.
        await page.mouse.move(box.x + box.width * .72, box.y + 48);
        await page.mouse.down({ button });
        await page.mouse.move(box.x + box.width * .72 + 100, box.y + 110, { steps: 18 });
        await page.mouse.up({ button });
    };
    try {
        await cp(options.fixture, repoPath, { recursive: true });
        if (options.only.includes('docs')) {
            // The selected section starts below the fold in a document that has
            // not been visited through a hash link. Merely finding its DOM node
            // would also pass when the reader never navigates to the section.
            const paragraphs = Array.from({ length: 48 }, (_, index) =>
                `Context paragraph ${index + 1} records source evidence before the later section.\n\n`).join('');
            await writeFile(join(repoPath, 'docs/section-navigation.md'),
                `# Section navigation\n\n## Introduction\n\n${paragraphs}## Late evidence\n\nThe selected section must receive focus and become visible.\n\n`
                + Array.from({ length: 18 }, (_, index) => `Later context paragraph ${index + 1}.\n\n`).join(''));
            await writeFile(join(repoPath, 'docs/capture-guide.pdf'), sourceEvidencePdf([
                ['Local capture guide', ...Array.from({ length: 35 }, (_, index) => `Documentation context ${index + 1}.`)],
                ['Source evidence on the second page.', 'The users endpoint is implemented in src/users.ts.'],
                ['Additional source context.', 'The diagram is in docs/components.mmd.'],
            ]));
        }
        // A real indexed source exceeds the native candidate bound. No RPC mocks.
        let laterOccurrenceByte;
        if (options.only.includes('field')) {
            const prefix = Array.from({ length: 100 }, (_, index) =>
                `export function early${index}(input: number) { const output = input + 1; return output; }\n`).join('');
            const target = 'export function laterOccurrence(input: number) { return input; }\n';
            laterOccurrenceByte = Buffer.byteLength(prefix + target.slice(0, target.indexOf('input')));
            await writeFile(join(repoPath, 'src/candidate-limit.ts'), prefix + target);
            // Explicit local dependency opt-in; these source bytes are authored fixtures, never downloaded.
            env.CBM_FLOW_DEPENDENCIES = 'cbm-proof-dependency';
            const dependency = join(repoPath, 'node_modules/cbm-proof-dependency');
            await mkdir(dependency, { recursive: true });
            await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'cbm-proof-dependency',
                version: '1.2.3', type: 'module', exports: { '.': './index.js' } }));
            await writeFile(join(dependency, 'index.js'), 'export function identity(value) { return value; }\n');
            await writeFile(join(repoPath, 'src/package-flow.js'), "import { identity as selected } from 'cbm-proof-dependency';\n"
                + 'export function dependencyRoundTrip(input) { return selected(input); }\n');
        }
        report.version = (await command(options.binary, ['--version'], env)).stdout.trim();
        const indexed = await command(options.binary, ['cli', 'index_repository'], env, 120_000,
            `${JSON.stringify({ repo_path: repoPath, name: project, mode: 'full' })}\n`);
        report.index = indexed;
        const parsedIndex = JSON.parse(indexed.stdout.trim().split('\n').at(-1));
        assert(parsedIndex.status === 'indexed' || parsedIndex.nodes !== undefined, 'Native fixture indexing must succeed');
        nativePort = await freePort();
        nativeChild = spawn(options.binary, ['--ui=true', `--port=${nativePort}`], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        nativeChild.stdout.on('data', chunk => report.nativeLog.push({ stream: 'stdout', text: chunk.toString() }));
        nativeChild.stderr.on('data', chunk => report.nativeLog.push({ stream: 'stderr', text: chunk.toString() }));
        let nativeError;
        nativeChild.on('error', error => { nativeError = error; });
        nativeChild.stdin.on('error', error => { nativeError = error; });
        nativeChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
            protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'system-intelligence-browser', version: '1' },
        } })}\n`);
        await eventually(async () => {
            if (nativeError) throw nativeError;
            if (report.nativeLog.some(item => item.text.includes('built without UI support'))) {
                throw new Error('Native binary lacks UI support; build cbm-with-ui before this acceptance');
            }
            assert(nativeChild.exitCode === null, `Native server exited ${nativeChild.exitCode}`);
            const response = await fetch(`http://127.0.0.1:${nativePort}/`, { signal: AbortSignal.timeout(1500) });
            await response.arrayBuffer();
            return response.ok;
        }, 'Native UI did not become ready', 30_000);
        proxyPort = await freePort();
        proxy = await startStaticProxy({ distDir: options.dist, upstreamPort: nativePort, port: proxyPort });
        const origin = `http://127.0.0.1:${proxyPort}`;
        report.origin = origin;
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: options.headless, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
        context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
            report.externalRequests.push({ method: route.request().method(), url: url.href });
            return route.abort('blockedbyclient');
        });
        page = await context.newPage();
        page.setDefaultTimeout(15_000);
        page.on('console', message => report.console.push({ type: message.type(), text: message.text(), url: message.location().url }));
        page.on('pageerror', error => report.pageErrors.push(String(error.stack ?? error)));
        page.on('response', response => {
            const url = new URL(response.url());
            if (url.pathname.startsWith('/api') || url.pathname === '/rpc') report.requests.push({ method: response.request().method(), path: url.pathname + url.search, status: response.status() });
        });
        page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
        await page.goto(origin, { waitUntil: 'domcontentloaded' });
        const welcome = page.getByRole('button', { name: 'Start exploring', exact: true });
        await eventually(async () => await welcome.isVisible() || await page.locator('.atlas-shell').isVisible(), 'Lens did not render');
        if (await welcome.isVisible()) await welcome.click();
        await eventually(async () => (await page.locator('.atlas-header').innerText()).includes(project), 'Fixture project was not selected', 30_000);
        await screenshot('00-initial');

        if (options.only.includes('docs')) {
            await run('Docs catalog search and safe relative section navigation', async () => {
                await workspace('docs');
                await page.getByRole('tab', { name: 'Documents', exact: true }).click();
                await page.getByLabel('Find documentation', { exact: true }).fill('README');
                await page.locator('.docs-catalog').getByRole('button', { name: 'Search', exact: true }).click();
                const readme = page.locator('.docs-document-list button').filter({ hasText: 'README.md' }).first();
                await readme.click();
                await page.locator('.docs-reader').getByRole('heading', { name: 'Users system', exact: true }).waitFor();
                await screenshot('docs-readme');
                await page.setViewportSize({ width: 1024, height: 900 });
                await screenshot('docs-readme-1024');
                await page.setViewportSize({ width: 1600, height: 1000 });
                await page.locator('.docs-reader').getByRole('link', { name: 'architecture notes', exact: true }).click();
                await page.locator('.docs-reader [data-document-anchor="storage"]').waitFor();
                assert.match(await page.locator('.docs-document-heading').innerText(), /architecture\.md/i);
                await screenshot('docs-relative-storage');
                const history = page.getByRole('navigation', { name: 'Document history', exact: true });
                await history.getByRole('button', { name: 'Back', exact: true }).click();
                await page.locator('.docs-reader').getByRole('heading', { name: 'Users system', exact: true }).waitFor();
                await history.getByRole('button', { name: 'Forward', exact: true }).click();
                await page.locator('.docs-reader [data-document-anchor="storage"]').waitFor();
                const sections = page.locator('.docs-connections section').filter({ has: page.getByRole('heading', { name: 'Sections', exact: true }) });
                await sections.getByRole('button', { name: /Storage/ }).click();
                await eventually(() => page.locator('.docs-reader [data-document-anchor="storage"]').evaluate(
                    element => document.activeElement === element), 'Selected Storage section did not receive focus');
            });
            await run('Docs section selection focuses and reveals an unvisited below-fold section', async () => {
                await page.getByLabel('Find documentation', { exact: true }).fill('section-navigation');
                await page.locator('.docs-catalog').getByRole('button', { name: 'Search', exact: true }).click();
                await page.locator('.docs-document-list button').filter({ hasText: 'section-navigation.md' }).first().click();
                const heading = page.locator('.docs-reader').getByRole('heading', { name: 'Late evidence', exact: true });
                await heading.waitFor();
                const reader = page.locator('.docs-reading');
                await reader.evaluate(element => { element.scrollTop = 0; });
                const initial = await reader.evaluate(element => element.scrollTop);
                const before = await heading.boundingBox(), bounds = await reader.boundingBox();
                assert(before && bounds && before.y > bounds.y + bounds.height,
                    'Section navigation fixture must place its target below the reader viewport');
                await screenshot('docs-section-before');
                const sections = page.locator('.docs-connections section').filter({ has: page.getByRole('heading', { name: 'Sections', exact: true }) });
                await sections.getByRole('button', { name: /Late evidence/ }).click();
                await eventually(() => heading.evaluate(element => document.activeElement === element),
                    'Selected below-fold section did not receive focus');
                const after = await heading.boundingBox(), toolbar = await page.locator('.docs-reader-toolbar').boundingBox();
                assert(after && toolbar && after.y >= toolbar.y + toolbar.height - 1
                    && after.y + after.height <= bounds.y + bounds.height,
                'Selected section must be visible below the sticky reader toolbar');
                assert(await reader.evaluate(element => element.scrollTop) > initial + 200,
                    'Section selection did not scroll the reader to the selected source section');
                await screenshot('docs-section-after');
                await page.getByLabel('Find documentation', { exact: true }).fill('README');
                await page.locator('.docs-catalog').getByRole('button', { name: 'Search', exact: true }).click();
            });
            await run('PDF extracted pages and System graph sources preserve page and generation', async () => {
                await page.getByLabel('Find documentation', { exact: true }).fill('capture-guide');
                await page.locator('.docs-catalog').getByRole('button', { name: 'Search', exact: true }).click();
                await page.locator('.docs-document-list button').filter({ hasText: 'capture-guide.pdf' }).first().click();
                const pageTwo = () => page.locator('.docs-reader [data-document-anchor="page-2"]');
                await pageTwo().waitFor();
                assert.match(await page.locator('.docs-reader').innerText(), /Source evidence on the second page/);
                assert(!(await page.locator('.docs-reader').innerText()).includes('%PDF-'));
                const sections = page.locator('.docs-connections section').filter({ has: page.getByRole('heading', { name: 'Sections', exact: true }) });
                await sections.getByRole('button', { name: /page 2/i }).click();
                await eventually(() => pageTwo().evaluate(element => document.activeElement === element),
                    'PDF page section did not focus its extracted page');
                await screenshot('docs-pdf-page-2');

                const selectPdfPage = async () => {
                    await architecture('structure');
                    const graph = page.getByTestId('system-graph');
                    await graph.getByRole('searchbox', { name: 'Filter system graph' }).fill('capture-guide.pdf');
                    const catalog = graph.locator('details.system-graph-catalog');
                    if (await catalog.getAttribute('open') === null) await catalog.locator('summary').click();
                    const entity = graph.locator('[data-catalog-entity]').filter({ hasText: 'capture-guide.pdf' }).filter({ hasText: /page 2/i });
                    await entity.first().waitFor();
                    assert.equal(await entity.count(), 1, 'Native PDF page 2 must be an unambiguous indexed entity');
                    await entity.click();
                    return graph;
                };
                const entityGraph = await selectPdfPage();
                await entityGraph.locator('.system-inspector [data-source-node]').click();
                await eventually(() => pageTwo().evaluate(element => document.activeElement === element),
                    'System graph PDF entity did not open the exact extracted page');
                assert.equal(await page.getByRole('dialog', { name: 'Source evidence' }).count(), 0,
                    'PDF source must never be sent to the binary code-source drawer');

                const witnessGraph = await selectPdfPage();
                await witnessGraph.getByRole('searchbox', { name: 'Filter system graph' }).fill('');
                await witnessGraph.locator('[data-inspect-relation]').filter({ hasText: 'MENTIONS' }).first().click();
                const witness = witnessGraph.locator('[data-witness]').filter({ hasText: 'capture-guide.pdf' }).first();
                await witness.waitFor();
                assert.match(await witness.innerText(), /page 2/);
                await screenshot('system-pdf-page-witness');
                await witness.click();
                await eventually(() => pageTwo().evaluate(element => document.activeElement === element),
                    'System graph PDF witness did not open the exact extracted page');
                assert.equal(await page.getByRole('dialog', { name: 'Source evidence' }).count(), 0);
                await screenshot('docs-pdf-from-system-witness');
                await page.getByLabel('Find documentation', { exact: true }).fill('README');
                await page.locator('.docs-catalog').getByRole('button', { name: 'Search', exact: true }).click();
            });
            await run('Docs recorded SVG graph zoom pan node and edge interaction', async () => {
                await workspace('docs');
                await page.getByRole('tab', { name: 'Documents', exact: true }).click();
                await page.locator('.docs-document-list button').filter({ hasText: 'README.md' }).first().click();
                await page.locator('.docs-reader').getByRole('heading', { name: 'Users system', exact: true }).waitFor();
                const graph = page.getByRole('region', { name: 'Documentation graph', exact: true });
                const svg = graph.locator('svg');
                await svg.waitFor();
                const group = svg.locator(':scope > g');
                const before = await group.getAttribute('transform');
                await svg.hover({ position: { x: 8, y: 8 } });
                await page.mouse.wheel(0, -180);
                await eventually(async () => await group.getAttribute('transform') !== before, 'Docs wheel did not zoom SVG');
                const zoomed = await group.getAttribute('transform');
                const box = await svg.boundingBox();
                await page.mouse.move(box.x + 8, box.y + 8);
                await page.mouse.down();
                await page.mouse.move(box.x + 28, box.y + 44, { steps: 8 });
                await page.mouse.up();
                assert.notEqual(await group.getAttribute('transform'), zoomed, 'Docs drag must pan SVG');
                await graph.getByRole('button', { name: 'Fit', exact: true }).click();
                const edge = svg.locator('[data-document-edge]').first();
                await edge.focus();
                await screenshot('docs-edge-description');
                await page.keyboard.press('Enter');
                await eventually(() => page.locator('.docs-relation:focus').count(), 'Graph edge did not focus its evidence row');
                const node = svg.locator('[data-graph-node][data-current="false"]').first();
                await node.click();
                await eventually(async () => await page.locator('.docs-reader').isVisible() || await page.getByRole('dialog', { name: 'Source evidence' }).isVisible(), 'Graph node did not navigate to indexed evidence');
                if (await page.getByRole('button', { name: 'Close source evidence', exact: true }).isVisible()) await closeEvidence();
                await screenshot('docs-graph-interaction');
            });
            await run('Docs relative code link opens indexed source', async () => {
                await workspace('docs');
                await page.getByRole('tab', { name: 'Documents', exact: true }).click();
                await page.locator('.docs-document-list button').filter({ hasText: 'README.md' }).first().click();
                await page.locator('.docs-reader').getByRole('link', { name: 'users endpoint', exact: true }).click();
                await page.getByRole('dialog', { name: 'Source evidence' }).waitFor();
                assert.match(await page.locator('.source-evidence-location').innerText(), /users\.ts/);
                await verifyEvidenceSource(/createUser/);
                await screenshot('docs-linked-code-source');
                await closeEvidence();
            });
            await run('Docs filters and retained ADR draft saved to native project', async () => {
                await workspace('docs');
                await page.getByLabel('Find documentation', { exact: true }).fill('');
                await page.locator('.docs-catalog').getByRole('button', { name: 'Search', exact: true }).click();
                await page.getByLabel('Document type', { exact: true }).selectOption('diagram');
                await eventually(async () => (await page.locator('.docs-document-list').innerText()).includes('components.mmd'), 'Native diagram did not appear in catalog');
                await page.locator('.docs-document-list button').filter({ hasText: 'components.mmd' }).first().click();
                await eventually(async () => (await page.locator('.docs-reader').innerText()).includes('flowchart'), 'Diagram source was not shown');
                await screenshot('docs-diagram');
                await page.getByRole('tab', { name: 'Architecture decisions', exact: true }).click();
                const adr = page.locator('.adr-workspace:visible');
                await adr.getByRole('button', { name: /^(Edit|Create decision record)$/ }).click();
                const draft = '# Browser acceptance decision\n\n## Context\n\nKeep source evidence local.\n\n## Decision\n\nUse the indexed graph.\n';
                await adr.getByRole('textbox', { name: 'Decision record Markdown', exact: true }).fill(draft);
                await page.getByRole('tab', { name: 'Documents', exact: true }).click();
                await page.getByRole('tab', { name: 'Architecture decisions', exact: true }).click();
                assert.equal(await adr.getByRole('textbox', { name: 'Decision record Markdown', exact: true }).inputValue(), draft);
                await adr.getByRole('button', { name: 'Save', exact: true }).click();
                await adr.locator('.adr-document').getByRole('heading', { name: 'Browser acceptance decision' }).waitFor();
                const saved = await page.request.get(`${origin}/api/adr?project=${encodeURIComponent(project)}`);
                assert(saved.ok(), 'Native ADR endpoint failed');
                assert.equal((await saved.json()).content, draft);
                await screenshot('docs-adr-saved');
            });
        }

        if (options.only.includes('system')) {
            await run('System graph genuine 3D default orbit zoom and 2D pan', async () => {
                await architecture('structure');
                const graph = page.getByTestId('system-graph');
                await graph.locator('[data-camera="3d"][aria-pressed="true"]').waitFor();
                await graph.locator('[data-testid="system-scene"][data-projection="3d"] canvas').waitFor();
                await cameraGesture('system-3d-orbit', box => drag(box));
                await graph.getByRole('button', { name: 'Fit graph', exact: true }).click();
                await cameraGesture('system-3d-pan', box => drag(box, 'right'));
                await graph.getByRole('button', { name: 'Fit graph', exact: true }).click();
                await cameraGesture('system-3d-zoom', async box => { await page.mouse.move(box.x + box.width * .7, box.y + 45); await page.mouse.wheel(0, -350); });
                await graph.locator('.system-scene-node-label').first().click();
                await graph.getByRole('complementary', { name: 'System graph evidence' }).getByRole('button', { name: 'Clear selection', exact: true }).waitFor();
                await graph.locator('[data-camera="2d"]').click();
                await graph.locator('[data-testid="system-scene"][data-projection="plan"]').waitFor();
                await cameraGesture('system-2d-pan', box => drag(box));
                await graph.getByRole('button', { name: 'Fit graph', exact: true }).click();
                await cameraGesture('system-2d-zoom', async box => { await page.mouse.move(box.x + box.width * .7, box.y + 45); await page.mouse.wheel(0, 300); });
            });
            await run('System graph layers search group drill and indexed source witnesses', async () => {
                await architecture('structure');
                const graph = page.getByTestId('system-graph');
                for (const layer of ['communication', 'data', 'deployment', 'documentation', 'dependency', 'other']) {
                    const button = graph.locator(`[data-layer="${layer}"]`);
                    const initial = await button.getAttribute('aria-pressed');
                    await button.click();
                    assert.notEqual(await button.getAttribute('aria-pressed'), initial);
                    await button.click();
                    assert.equal(await button.getAttribute('aria-pressed'), initial);
                }
                const input = graph.getByRole('searchbox', { name: 'Filter system graph' });
                await input.fill('a-name-that-does-not-exist-in-the-fixture');
                await graph.getByText('No entities match these filters.', { exact: true }).waitFor();
                await input.fill('');
                const catalog = graph.locator('details.system-graph-catalog');
                if (await catalog.getAttribute('open') === null) await catalog.locator('summary').click();
                await graph.locator('[data-aggregate-kind="code"]').click();
                await graph.locator('[data-action="drill-group"]').click();
                await eventually(async () => await graph.getAttribute('data-focus-kind') === 'code', 'Code group was not drilled');
                await screenshot('system-code-drill');
                // Selecting an actual indexed function and a returned edge drives evidence.
                // The field candidate-limit fixture adds 100 functions. Use
                // the real catalog filter instead of assuming this function
                // is rendered on the first bounded page of the Code group.
                await input.fill('createUser');
                const entry = graph.locator('[data-catalog-entity]').filter({ hasText: 'createUser' }).first();
                await entry.click();
                await input.fill('');
                const inspector = graph.getByRole('complementary', { name: 'System graph evidence' });
                await inspector.locator('[data-source-node]').first().click();
                await page.getByRole('dialog', { name: 'Source evidence' }).waitFor();
                assert.match(await page.locator('.source-evidence-location').innerText(), /users\.ts/);
                await verifyEvidenceSource(/createUser/);
                await screenshot('system-entity-source');
                await closeEvidence();
                await inspector.locator('[data-inspect-relation]').first().click();
                await inspector.locator('[data-witness]').first().click();
                await page.getByRole('dialog', { name: 'Source evidence' }).waitFor();
                await verifyEvidenceSource();
                await screenshot('system-relation-witness');
                await closeEvidence();
                await graph.getByRole('navigation', { name: 'System graph location' }).getByRole('button', { name: 'System graph', exact: true }).click();
                await eventually(async () => await graph.getAttribute('data-focus-kind') === '', 'Graph overview did not return');
                const coverage = graph.locator('.system-graph-coverage');
                if (await coverage.getAttribute('open') === null) await coverage.locator('summary').click();
                assert.match(await coverage.innerText(), /field|value/i);
                await graph.getByRole('button', { name: 'Refresh graph', exact: true }).click();
                await graph.locator('[data-camera="2d"]').waitFor();
                await screenshot('system-coverage-and-overview');
            });
        }

        if (options.only.includes('capture')) {
            // A controlled emitter exercises the real receiver. This is not an
            // assertion that any automatic language instrumentation is present.
            const emit = async (created, originHeader, preview) => {
                const source = await readFile(join(repoPath, 'src/users.ts'));
                const sourceHash = createHash('sha256').update(source).digest('hex');
                const script = `
                    let text = ''; for await (const chunk of process.stdin) text += chunk;
                    const args = JSON.parse(text);
                    const source = {file_path:'src/users.ts',line:7,source_hash:args.hash};
                    const common = {invocation_id:'capture-fixture',source,access_path:'profile.email'};
                    const events = [
                        {...common,sequence:1,operation:'value',value_id:'email-1',inputs:[],preview:args.preview},
                        {...common,sequence:2,operation:'transform',value_id:'email-2',inputs:['email-1'],preview:args.preview},
                        {...common,sequence:3,operation:'db_bind',value_id:'email-3',inputs:['email-2'],access_path:'private.other',preview:'never-allow-this-field'},
                        {...common,sequence:4,operation:'field',value_id:'email-4',inputs:[],source:{...source,source_hash:'stale-fixture-hash'}},
                    ];
                    const headers = {'Content-Type':'application/json',Authorization:'Bearer '+args.token,
                        ...(args.origin ? {Origin:args.origin} : {})};
                    const lineage = await fetch(args.base+args.lineage,{method:'POST',headers,
                        body:JSON.stringify({schema_version:1,producer:{id:'acceptance-emitter',language:'typescript'},events})});
                    if (!lineage.ok) throw new Error('Native lineage receiver status '+lineage.status);
                    const spans = await fetch(args.base+args.traces,{method:'POST',headers,
                        body:JSON.stringify({resourceSpans:[{scopeSpans:[{spans:[{
                            traceId:'0102030405060708090a0b0c0d0e0f10',spanId:'0102030405060708',
                            name:'never-copy-unapproved-span-payload'
                        }]}]}]})});
                    if (!spans.ok) throw new Error('Native span receiver status '+spans.status);
                    console.log('Controlled emitter delivered 4 lineage events and 1 call span');
                `;
                await command(process.execPath, ['--input-type=module', '-e', script], env, 15_000, JSON.stringify({
                    base: origin, token: created.token, hash: sourceHash,
                    lineage: created.lineage_url, traces: created.traces_url, origin: originHeader, preview,
                }));
            };
            const openCapture = async () => {
                await architecture('structure');
                const details = page.locator('.system-graph-capture');
                if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
                const panel = page.getByTestId('capture-panel');
                await panel.waitFor();
                await eventually(async () => !(await panel.innerText()).includes('Loading local sessions'), 'Capture sessions did not load');
                return panel;
            };
            const startCapture = async panel => {
                const response = page.waitForResponse(value => value.request().method() === 'POST'
                    && new URL(value.url()).pathname === '/api/capture/sessions');
                await panel.locator('[data-capture-start]').click();
                const result = await response;
                assert.equal(result.status(), 201);
                const created = await result.json();
                assert.equal(await panel.getByLabel('Capture session token', { exact: true }).inputValue(), created.token);
                assert.equal(await panel.getByLabel('Capture session token', { exact: true }).getAttribute('type'), 'password');
                return created;
            };
            const finishCapture = async (panel, id, scenario) => {
                await panel.locator('[data-capture-stop]').click();
                await eventually(async () => (await panel.locator('[data-capture-session-detail]').innerText()).includes('stopped'),
                    'Capture did not stop');
                assert.equal(await panel.getByLabel('Capture session token', { exact: true }).count(), 0);
                assert.equal(await panel.locator('[data-capture-event]').count(), 5, 'Stopping lost review events');
                await screenshot(`capture-${scenario}-stopped-review`);
                await panel.locator('[data-capture-delete]').click();
                await eventually(async () => await panel.locator(`[data-capture-session="${id}"]`).count() === 0,
                    'Deleted capture is still listed');
                assert.equal(await panel.locator('[data-capture-event]').count(), 0);
            };
            await run('Capture real receiver metadata source lineage and stop review', async () => {
                const panel = await openCapture();
                const profiles = panel.getByLabel('Capture runtime profile');
                assert.equal(await profiles.locator('option').count(), 9);
                assert(!/cuda/i.test(await profiles.innerText()));
                for (const value of ['browser', 'python', 'jvm', 'dotnet', 'go', 'rust', 'php', 'native', 'node'])
                    await profiles.selectOption(value);
                assert.equal(await panel.locator('[data-capture-values]').isChecked(), false);
                const created = await startCapture(panel);
                await emit(created, '', 'unapproved-fixture-value');
                await eventually(async () => await panel.locator('[data-capture-event]').count() === 5,
                    'Real capture events were not polled');
                await panel.locator('[data-capture-event="2"]').click();
                const evidence = panel.getByRole('complementary', { name: 'Observed event evidence' });
                assert.match(await evidence.innerText(), /2 explicit input links/);
                assert(!/unapproved-fixture-value|never-allow-this-field|never-copy-unapproved-span-payload/.test(await panel.innerText()));
                await screenshot('capture-metadata-lineage');
                await evidence.locator('[data-capture-source]').click();
                await panel.locator('[data-verified-source]').waitFor();
                assert.match(await panel.locator('[data-verified-source]').innerText(), /createUser/);
                assert.match(await panel.getByRole('region', { name: 'Verified source evidence' }).innerText(), /Source hash and index generation verified/);
                const sourceBounds = await panel.locator('[data-verified-source]').boundingBox();
                assert(sourceBounds && sourceBounds.y < 950 && sourceBounds.y + sourceBounds.height > 64, 'Capture verified source was left outside the visible workspace');
                await screenshot('capture-matched-source');
                await panel.locator('[data-source-evidence-close]').click();
                await panel.locator('[data-capture-event="4"]').click();
                assert.equal(await evidence.locator('[data-capture-source-status]').innerText(), 'stale');
                assert.equal(await evidence.locator('[data-capture-source]').isDisabled(), true);
                await screenshot('capture-stale-source');
                await panel.locator('[data-capture-event="5"]').click();
                assert.match(await evidence.innerText(), /0 explicit input links/);
                await screenshot('capture-span-no-field-link');
                await finishCapture(panel, created.session.id, 'metadata');
            });
            await run('Capture exact raw test field opt-in and browser origin configuration', async () => {
                const panel = await openCapture();
                await panel.getByLabel('Capture runtime profile').selectOption('browser');
                await panel.getByLabel('Allowed capture origin').fill('http://localhost:3000');
                await panel.locator('[data-capture-values]').check();
                assert.equal(await panel.locator('[data-capture-start]').isDisabled(), true);
                await panel.getByLabel('Allowed test field paths').fill('profile.*');
                assert.equal(await panel.locator('[data-capture-start]').isDisabled(), true);
                await panel.getByLabel('Allowed test field paths').fill('profile.email');
                const created = await startCapture(panel);
                await emit(created, 'http://localhost:3000', 'sample@example.test');
                await eventually(async () => await panel.locator('[data-capture-event]').count() === 5,
                    'Opt-in capture events were not polled');
                await panel.locator('[data-capture-event="2"]').click();
                assert.match(await panel.locator('.capture-preview').innerText(), /sample@example.test/);
                await screenshot('capture-allowed-test-preview');
                await panel.locator('[data-capture-event="3"]').click();
                assert.equal(await panel.locator('.capture-preview').count(), 0);
                assert(!(await panel.innerText()).includes('never-allow-this-field'));
                await finishCapture(panel, created.session.id, 'preview');
                assert.equal(await panel.getByRole('alert').count(), 0);
                await screenshot('capture-deleted');
            });
        }

        if (options.only.includes('field')) {
            const traceReply = async action => {
                const response = page.waitForResponse(value => {
                    if (new URL(value.url()).pathname !== '/rpc' || value.request().method() !== 'POST') return false;
                    try { return value.request().postDataJSON()?.params?.name === 'trace_field'; } catch { return false; }
                });
                await action();
                const reply = await response, envelope = await reply.json();
                assert.equal(reply.status(), 200);
                assert(!envelope.result?.isError, envelope.result?.content?.[0]?.text ?? 'trace_field failed');
                return JSON.parse(envelope.result.content[0].text);
            };
            await run('Field flow real occurrences direction certainty and hash-bound source', async () => {
                await architecture('structure');
                const graph = page.getByTestId('system-graph');
                await graph.getByRole('searchbox', { name: 'Filter system graph' }).fill('readEmail');
                const catalog = graph.locator('details.system-graph-catalog');
                if (await catalog.getAttribute('open') === null) await catalog.locator('summary').click();
                await graph.locator('[data-catalog-entity]').filter({ hasText: 'readEmail' }).first().click();
                await graph.locator('[data-system-trace-field]').click();
                const flow = page.getByTestId('field-flow');
                await flow.waitFor();
                assert.equal(await flow.locator('[data-field-file]').inputValue(), 'src/field-flow.ts');
                assert.equal(await flow.locator('[data-field-path]').count(), 0);
                const candidates = await traceReply(() => flow.locator('[data-field-submit]').click());
                assert.equal(candidates.status, 'selection_required');
                assert.equal(candidates.paths.length, 0);
                await flow.getByText('Choose a source occurrence', { exact: true }).waitFor();
                await screenshot('field-occurrence-selection');
                const seed = candidates.values.find(value => value.access_path.length === 1 && value.access_path[0] === 'email');
                assert(seed, 'The actual index has no distinct email-field occurrence');
                const seedButton = flow.locator('[data-field-candidate]').filter({ hasText: '["email"]' }).first();
                while (!(await seedButton.count())) {
                    const more = flow.getByRole('button', { name: 'More occurrences', exact: true });
                    assert(await more.count(), 'Email occurrence is not accessible in candidate pagination');
                    await more.click();
                }
                const selectedId = await seedButton.getAttribute('data-field-candidate');
                const downstream = await traceReply(() => seedButton.click());
                assert(downstream.links.length > 0, 'The indexed email field has no supported downstream dependencies');
                assert(downstream.paths.some(path => path.values[0] === selectedId), 'The displayed path did not start at the chosen occurrence');
                assert(downstream.values.every(value => value.ref.generation === downstream.generation));
                await flow.locator('[data-field-path]').first().waitFor();
                assert.equal(await flow.locator('[data-field-certainty]').count() > 0, true);
                assert.match(await flow.innerText(), /Static dependence does not establish observed execution/);
                await screenshot('field-downstream-evidence');
                await flow.locator('[data-field-source]').click();
                await flow.locator('[data-verified-source]').waitFor();
                assert.match(await flow.locator('[data-verified-source]').innerText(), /input\.email/);
                const sourceBounds = await flow.locator('[data-verified-source]').boundingBox();
                assert(sourceBounds && sourceBounds.y >= 64 && sourceBounds.y + sourceBounds.height <= 980, 'Field verified source was left outside the visible workspace');
                await screenshot('field-verified-source');
                await flow.locator('[data-source-evidence-close]').click();
                const upstream = await traceReply(() => flow.locator('[data-field-direction="backward"]').click());
                assert(upstream.paths.every(path => path.direction === 'backward'));
                assert.equal(await flow.locator('[data-field-direction="backward"]').getAttribute('aria-pressed'), 'true');
                await screenshot('field-upstream-evidence');
                // An annotation does not prove a primitive value: coercion could
                // execute user code, so the unknown result must stop this slice.
                await traceReply(() => flow.locator('[data-field-direction="forward"]').click());
                const all = await traceReply(() => flow.locator('[data-field-submit]').click());
                const selectOccurrence = async id => {
                    const buttons = flow.locator('[data-field-candidate]');
                    while (!(await buttons.evaluateAll((nodes, valueId) => nodes.some(node => node.getAttribute('data-field-candidate') === valueId), id))) {
                        const more = flow.getByRole('button', { name: 'More occurrences', exact: true });
                        assert(await more.count(), 'Transform occurrence is not accessible');
                        await more.click();
                    }
                    const occurrenceIndex = await buttons.evaluateAll((nodes, valueId) => nodes.findIndex(node => node.getAttribute('data-field-candidate') === valueId), id);
                    return traceReply(() => buttons.nth(occurrenceIndex).click());
                };
                const unknownSeed = all.values.find(value => /decorate/.test(value.symbol) && value.kind === 'parameter' && value.parameter_index === 0);
                assert(unknownSeed, 'No unknown operator source occurrence was indexed');
                const unknown = await selectOccurrence(unknownSeed.id);
                assert(!unknown.links.some(link => link.certainty === 'derived'), 'Unknown coercion was presented as derived transport');
                assert(!unknown.values.some(value => value.symbol === unknownSeed.symbol && value.kind === 'return'), 'Unknown operator transported its input to the return');
                assert(unknown.gaps.some(gap => gap.code === 'unknown_flow'), 'Unknown operator boundary was not reported');
                await flow.locator('[data-field-gap="unknown_flow"]').first().scrollIntoViewIfNeeded();
                await screenshot('field-unknown-operator-gap');

                // Proven primitive operands still produce a derived dependence,
                // not an assertion that the input and output raw values are equal.
                const primitive = await traceReply(() => flow.locator('[data-field-submit]').click());
                const derivedSeed = primitive.values.find(value => /primitiveTransform/.test(value.symbol) && value.kind === 'literal');
                assert(derivedSeed, 'No verified primitive source occurrence was indexed');
                const derived = await selectOccurrence(derivedSeed.id);
                assert(derived.links.some(link => link.certainty === 'derived'), 'Transform lost its derived certainty');
                assert(derived.values.some(value => value.symbol === derivedSeed.symbol && value.kind === 'return'), 'Verified primitive transform did not reach its return');
                await flow.locator('[data-field-certainty="derived"]').first().waitFor();
                await screenshot('field-derived-transform');
            });
            await run('Field flow rejects changed source bytes without rendering false evidence', async () => {
                const flow = page.getByTestId('field-flow'), path = join(repoPath, 'src/field-flow.ts');
                const original = await readFile(path);
                try {
                    await writeFile(path, Buffer.concat([original, Buffer.from('\n// changed after index for stale-source acceptance\n')]));
                    const staleResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/source-evidence');
                    await flow.locator('[data-field-source]').click();
                    const stale = await staleResponse, staleUrl = new URL(stale.url());
                    assert.equal(stale.status(), 409, 'Changed bytes must fail the matching-source check');
                    report.expectedApiFailures.push({ path: staleUrl.pathname + staleUrl.search, status: 409 });
                    await flow.getByRole('region', { name: 'Verified source evidence' }).getByRole('alert').waitFor();
                    assert.equal(await flow.locator('[data-verified-source]').count(), 0);
                    const errorBounds = await flow.getByRole('region', { name: 'Verified source evidence' }).getByRole('alert').boundingBox();
                    assert(errorBounds && errorBounds.y >= 64 && errorBounds.y + errorBounds.height <= 980, 'Stale source diagnostic was outside the visible workspace');
                    await screenshot('field-stale-source');
                    await flow.locator('[data-source-evidence-close]').click();
                } finally { await writeFile(path, original); }
            });
            await run('Field candidate limit can reach a later function through exact source selectors', async () => {
                const flow = page.getByTestId('field-flow');
                await flow.locator('[data-field-file]').fill('src/candidate-limit.ts');
                const capped = await traceReply(() => flow.locator('[data-field-submit]').click());
                assert.equal(capped.status, 'selection_required');
                assert.equal(capped.values.length, 200);
                assert(capped.gaps.some(gap => gap.code === 'candidate_limit'));
                await flow.locator('[data-field-candidate-bound]').waitFor();
                assert.match(await flow.locator('[data-field-candidate-bound]').innerText(), /byte offset of the value occurrence/);
                await screenshot('field-candidate-bound');
                await flow.locator('[data-field-narrow]').click();
                assert(await flow.locator('[data-field-symbol]').evaluate(element => element === document.activeElement));
                await flow.locator('[data-field-byte]').fill(String(laterOccurrenceByte));
                const later = await traceReply(() => flow.locator('[data-field-submit]').click());
                const seed = later.values.find(value => value.source.start_byte === laterOccurrenceByte);
                assert(seed && /laterOccurrence/.test(seed.symbol), 'Exact byte selector did not reach the omitted function');
                assert(later.paths.length > 0);
                assert(!later.gaps.some(gap => gap.code === 'candidate_limit'));
                // Use the exact symbol returned by the native index, without deriving it from a graph ID.
                await flow.locator('[data-field-symbol]').fill(seed.symbol);
                const exact = await traceReply(() => flow.locator('[data-field-submit]').click());
                assert(exact.values.some(value => value.id === seed.id));
                await flow.locator('[data-field-source]').click();
                await flow.locator('[data-verified-source]').waitFor();
                assert.match(await flow.locator('[data-verified-source]').innerText(), /laterOccurrence/);
                await screenshot('field-later-exact-occurrence');
                await flow.locator('[data-source-evidence-close]').click();
            });
            await run('Field package import export provenance and verified dependency source', async () => {
                const flow = page.getByTestId('field-flow');
                await flow.locator('[data-field-file]').fill('src/package-flow.js');
                await flow.locator('[data-field-symbol]').fill('');
                await flow.locator('[data-field-byte]').fill('');
                const candidates = await traceReply(() => flow.locator('[data-field-submit]').click());
                const seed = candidates.values.find(value => value.kind === 'parameter' && value.parameter_index === 0);
                assert(seed, 'Application parameter was not indexed');
                await flow.locator(`[data-field-candidate="${seed.id}"]`).waitFor();
                const result = await traceReply(() => flow.locator(`[data-field-candidate="${seed.id}"]`).click());
                const witness = result.links.find(link => link.kind === 'argument' && link.resolution?.proof_kind === 'package_export');
                assert(witness, 'Actual application import was not bound to a dependency export');
                const dependency = result.values.find(value => value.id === witness.target && value.package);
                assert(dependency, 'Resolved dependency parameter has no package identity');
                const manifest = await readFile(join(repoPath, 'node_modules/cbm-proof-dependency/package.json'));
                const body = await readFile(join(repoPath, 'node_modules/cbm-proof-dependency/index.js'));
                assert.equal(dependency.package.manifest_hash, createHash('sha256').update(manifest).digest('hex'));
                assert.equal(dependency.source.source_hash, createHash('sha256').update(body).digest('hex'));
                await flow.locator(`[data-field-value="${dependency.id}"]`).first().click();
                await flow.locator('[data-field-resolution]').first().waitFor();
                assert.match(await flow.locator('[data-field-package]').first().innerText(), /npm:cbm-proof-dependency/);
                const evidence = await flow.locator('[data-field-resolution]').first().innerText();
                for (const text of ['npm_esm_named_export', 'selected', 'identity', '1.2.3',
                    'node_modules/cbm-proof-dependency/package.json', dependency.package.manifest_hash, dependency.source.source_hash])
                    assert(evidence.includes(text), `Missing native resolver provenance: ${text}`);
                assert(!evidence.includes('Graph nodes'), 'Package proof must not invent graph declaration nodes');
                await flow.locator('[data-field-resolution]').first().scrollIntoViewIfNeeded();
                await screenshot('field-package-import-export-proof');
                await flow.locator('[data-field-source]').click();
                await flow.locator('[data-verified-source]').waitFor();
                assert.match(await flow.locator('[data-verified-source]').innerText(), /function identity\(value\)/);
                await screenshot('field-package-verified-source');
                await flow.locator('[data-source-evidence-close]').click();
            });
        }

        if (options.only.includes('adapters')) {
            const manifestReply = await page.request.get(`${origin}/capture-adapters/manifest.json`);
            assert.equal(manifestReply.status(), 200);
            const manifest = await manifestReply.json();
            for (const profile of ['python', 'node', 'browser', 'go', 'dotnet', 'jvm', 'rust', 'php', 'native'])
                assert(manifest.adapters.some(adapter => adapter.profile === profile), `${profile} must be included in this acceptance build`);
            await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
            for (const adapter of manifest.adapters) await run(`Bundled ${adapter.profile} ZIP download and manual start setup`, async () => {
                await architecture('structure');
                const details = page.locator('.system-graph-capture');
                if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
                const panel = page.getByTestId('capture-panel');
                await eventually(async () => !(await panel.innerText()).includes('Loading local sessions'), 'Capture did not load');
                await panel.getByLabel('Capture runtime profile').selectOption(adapter.profile);
                if (adapter.profile === 'browser') await panel.getByLabel('Allowed capture origin').fill('http://127.0.0.1:4319');
                await panel.locator('[data-capture-values]').uncheck();
                const response = page.waitForResponse(value => value.request().method() === 'POST'
                    && new URL(value.url()).pathname === '/api/capture/sessions');
                await panel.locator('[data-capture-start]').click();
                const createdReply = await response;
                assert.equal(createdReply.status(), 201);
                const created = await createdReply.json();
                const link = panel.locator('[data-capture-download]');
                await link.waitFor();
                assert.equal(await link.getAttribute('href'), adapter.archive);
                const downloadEvent = page.waitForEvent('download');
                await link.click();
                const download = await downloadEvent, destination = join(work, `setup-${adapter.profile}.zip`);
                await download.saveAs(destination);
                assert.equal(await download.failure(), null);
                const archive = await readFile(destination);
                assert.equal(archive.length, adapter.size);
                assert.equal(createHash('sha256').update(archive).digest('hex'), adapter.sha256);
                await command('/usr/bin/unzip', ['-tq', destination], env);
                const commands = await panel.locator('[data-capture-launch-command]').innerText();
                assert(commands.includes('read -r -s CBM_CAPTURE_TOKEN'));
                assert(!commands.includes(created.token));
                assert(commands.includes('export CBM_CAPTURE_VALUES=0'));
                assert(commands.includes(new URL(created.lineage_url, origin).href));
                await command('/bin/bash', ['-n'], env, 5000, commands);
                await command('/bin/zsh', ['-n'], env, 5000, commands);
                assert((await panel.locator('[data-capture-adapter-prerequisites]').innerText()).length > 20);
                assert((await panel.locator('[data-capture-adapter-limits]').innerText()).length > 20);
                await panel.locator('[data-capture-copy-launch]').click();
                assert.equal(await page.evaluate(() => navigator.clipboard.readText()), commands);
                const events = await page.request.get(`${origin}/api/capture/events?id=${created.session.id}&after=0`);
                assert.equal((await events.json()).events.length, 0, 'Setup interactions must not start an application or emit fabricated events');
                await panel.locator('[data-capture-launch-command]').scrollIntoViewIfNeeded();
                await screenshot(`adapter-${adapter.profile}-manual-setup`);
                report.adapterSetups ??= [];
                report.adapterSetups.push({ profile: adapter.profile, archiveSha256: adapter.sha256, downloadClick: true, shellSyntax: ['bash', 'zsh'], applicationAutoStarted: false });
                await panel.locator('[data-capture-stop]').click();
                await eventually(async () => (await panel.locator('[data-capture-session-detail]').innerText()).includes('stopped'), 'Capture did not stop');
                assert.equal(await panel.locator('[data-capture-launch-command]').count(), 0);
                await panel.locator('[data-capture-delete]').click();
                await eventually(async () => await panel.locator(`[data-capture-session="${created.session.id}"]`).count() === 0, 'Capture was not deleted');
            });
        }

        if (options.only.includes('runtime')) {
            for (const profile of ['node', 'browser']) await run(`Real ${profile} adapter native receiver source and observed UI`, async () => {
                await architecture('structure');
                const details = page.locator('.system-graph-capture');
                if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
                const panel = page.getByTestId('capture-panel');
                await eventually(async () => !(await panel.innerText()).includes('Loading local sessions'), 'Capture did not load');
                await panel.getByLabel('Capture runtime profile').selectOption(profile);
                const overlayPort = profile === 'browser' ? await freePort() : undefined;
                if (profile === 'browser') {
                    await panel.getByLabel('Allowed capture origin').fill(`http://127.0.0.1:${overlayPort}`);
                    await panel.locator('[data-capture-values]').check();
                    await panel.getByLabel('Allowed test field paths').fill('output');
                }
                const response = page.waitForResponse(value => value.request().method() === 'POST'
                    && new URL(value.url()).pathname === '/api/capture/sessions');
                await panel.locator('[data-capture-start]').click();
                const createdResponse = await response;
                assert.equal(createdResponse.status(), 201);
                const created = await createdResponse.json();
                await panel.locator('[data-capture-download]').waitFor();
                const download = await page.request.get(new URL(await panel.locator('[data-capture-download]').getAttribute('href'), origin).href);
                assert.equal(download.status(), 200);
                const archive = await download.body();
                assert.equal(archive.readUInt32LE(0), 0x04034b50, 'Adapter download must be a ZIP');
                const extracted = join(work, `downloaded-${profile}`), archivePath = join(work, `${profile}.zip`);
                await writeFile(archivePath, archive); await mkdir(extracted);
                await command('/usr/bin/unzip', ['-q', archivePath, '-d', extracted], env);
                assert(!(await panel.locator('[data-capture-launch-command]').innerText()).includes(created.token));
                await panel.locator('[data-capture-launch-command]').scrollIntoViewIfNeeded();
                await screenshot(`runtime-${profile}-manual-setup`);
                const sourcePath = join(repoPath, 'src/runtime-capture.ts'), before = await readFile(sourcePath);
                const endpoint = new URL(created.lineage_url, origin).href;
                if (profile === 'node') {
                    const launched = await command(process.execPath, ['--import', join(extracted, 'register.mjs'),
                        '--input-type=module', '-e', `import {run} from ${JSON.stringify(pathToFileURL(sourcePath).href)}; if(run("node-example")!=="node-example!") throw Error("Changed result");`],
                        { ...env, CBM_CAPTURE_ROOT: repoPath, CBM_CAPTURE_ENDPOINT: endpoint, CBM_CAPTURE_TOKEN: created.token,
                            CBM_CAPTURE_VALUES: '0', CBM_CAPTURE_FIELDS: '[]' }, 20_000);
                    assert.equal(launched.code, 0);
                } else {
                    const { startBrowserOverlay } = await import(pathToFileURL(join(extracted, 'browser.mjs')).href);
                    const overlay = await startBrowserOverlay({ root: repoPath, endpoint, token: created.token,
                        valuesEnabled: true, allowedFields: ['output'], port: overlayPort });
                    const application = await browser.newContext();
                    const appErrors = [];
                    try {
                        await application.route('**/*', route => {
                            const url = new URL(route.request().url());
                            if ([overlay.origin, origin].includes(url.origin) || url.protocol === 'data:') return route.continue();
                            appErrors.push(`Unexpected app request ${url.href}`); return route.abort();
                        });
                        const app = await application.newPage();
                        app.on('pageerror', error => appErrors.push(error.message));
                        app.on('console', message => { if (message.type() === 'error') appErrors.push(message.text()); });
                        await app.goto(overlay.origin + '/runtime.html');
                        assert.deepEqual(await app.evaluate(() => ({
                            mode: document.compatMode, doctype: document.doctype?.name, title: document.title,
                        })), { mode: 'CSS1Compat', doctype: 'html', title: 'Local capture fixture' },
                        'The downloaded browser adapter must preserve the application document mode and head');
                        await eventually(async () => await app.locator('#result').innerText() === 'browser-example!', 'Browser adapter changed the application result');
                        await eventually(async () => {
                            const result = await page.request.get(`${origin}/api/capture/events?id=${created.session.id}&after=0`);
                            return (await result.json()).events.length > 5;
                        }, 'Browser adapter did not deliver actual events');
                        assert.deepEqual(appErrors, []);
                    } finally { await application.close(); await overlay.close(); }
                }
                assert.deepEqual(await readFile(sourcePath), before, 'Runtime adapter modified source bytes');
                const eventReply = await page.request.get(`${origin}/api/capture/events?id=${created.session.id}&after=0`);
                const received = await eventReply.json();
                assert(received.events.length > 5);
                assert(received.events.every(event => event.source_status === 'matched'));
                assert(received.events.some(event => event.operation === 'transform' && event.inputs.length === 2));
                const called = received.events.find(event => event.operation === 'call' && event.inputs.length === 1);
                assert(called, 'Actual invocation return must reach the caller');
                assert(received.events.every(event => event.source.source_hash === createHash('sha256').update(before).digest('hex')));
                if (profile === 'node') assert(received.events.every(event => !('preview' in event)));
                else {
                    assert(received.events.some(event => event.access_path === 'output' && event.preview?.includes('browser-example!')));
                    assert(received.events.every(event => !('preview' in event) || event.access_path === 'output'));
                }
                await eventually(async () => await panel.locator('[data-capture-event]').count() === received.events.length, 'Actual probes did not reach Lens');
                await panel.locator(`[data-capture-event="${called.id}"]`).click();
                const evidence = panel.getByRole('complementary', { name: 'Observed event evidence' });
                assert.match(await evidence.innerText(), /explicit input links/);
                await evidence.locator('[data-capture-source]').click();
                await panel.locator('[data-verified-source]').waitFor();
                assert.match(await panel.locator('[data-verified-source]').innerText(), /decorate/);
                await screenshot(`runtime-${profile}-verified-source`);
                await panel.locator('[data-source-evidence-close]').click();
                if (profile === 'browser') {
                    const preview = received.events.find(event => event.access_path === 'output' && event.preview);
                    await panel.locator(`[data-capture-event="${preview.id}"]`).click();
                    await panel.locator('.capture-preview').scrollIntoViewIfNeeded();
                    await screenshot('runtime-browser-exact-test-preview');
                }
                report.runtimeAdapters ??= [];
                report.runtimeAdapters.push({ profile, downloadedArchiveExecuted: true, archiveSha256: createHash('sha256').update(archive).digest('hex'),
                    sourceUnchanged: true, events: received.events.length,
                    inputLinks: received.events.reduce((count, event) => count + event.inputs.length, 0),
                    matchedSources: received.events.filter(event => event.source_status === 'matched').length,
                    previewFields: [...new Set(received.events.filter(event => 'preview' in event).map(event => event.access_path))] });
                await panel.locator('[data-capture-stop]').click();
                await eventually(async () => (await panel.locator('[data-capture-session-detail]').innerText()).includes('stopped'), 'Capture did not stop');
                assert.equal(await panel.locator('[data-capture-event]').count(), received.events.length);
                await panel.locator('[data-capture-delete]').click();
                await eventually(async () => await panel.locator(`[data-capture-session="${created.session.id}"]`).count() === 0, 'Capture was not deleted');
            });
        }

        if (options.only.includes('regression')) {
            const waitArchitectureScene = async (testId = 'architecture-scene') => {
                const scene = page.getByTestId('atlas-architecture').getByTestId(testId);
                await scene.locator('canvas').waitFor();
                await scene.scrollIntoViewIfNeeded();
                // The canvas element exists before React Three Fiber has drawn
                // its first scene. Projected HTML labels require that renderer;
                // also require one inside the visible canvas, not only in the DOM.
                const selector = testId === 'architecture-scene' ? '.architecture-node-label:not(.is-hidden)' : '.system-scene-node-label';
                await eventually(() => scene.locator(selector).evaluateAll(nodes =>
                    nodes.some(node => {
                        const label = node.getBoundingClientRect();
                        const canvas = node.closest('.architecture-scene, .system-scene').getBoundingClientRect();
                        return label.width > 0 && label.height > 0
                            && label.right > Math.max(canvas.left, 0) && label.left < Math.min(canvas.right, innerWidth)
                            && label.bottom > Math.max(canvas.top, 64) && label.top < Math.min(canvas.bottom, innerHeight);
                    })), 'Architecture canvas did not project a visible source node');
            };
            for (const [name, action] of [
                ['Explore', async () => { await workspace('explore'); await page.getByTestId('atlas-reader').waitFor(); }],
                ['Galaxy', async () => { await workspace('galaxy'); await page.getByTestId('atlas-galaxy').locator('canvas').waitFor(); }],
                ['Architecture overview', async () => { await architecture('overview'); await waitArchitectureScene(); }],
                ['Architecture Routes Services', async () => {
                    await architecture('routes'); await page.locator('.container-map').waitFor();
                    const details = page.locator('.container-map .spatial-map-details');
                    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
                    await page.locator('.container-service-list button').first().click();
                }],
                ['Architecture Routes Endpoints', async () => { await architecture('routes'); await page.locator('.container-mode').getByRole('button', { name: 'Endpoints', exact: true }).click(); await waitArchitectureScene(); }],
                ['Architecture Behavior', async () => { await architecture('behavior'); await waitArchitectureScene('system-scene'); }],
                ['Coverage', async () => {
                    await workspace('coverage');
                    const panel = page.getByTestId('diagnostics-panel');
                    await panel.getByRole('button', { name: 'Run local diagnosis', exact: true }).click();
                    await panel.getByRole('textbox', { name: 'Editable local diagnostic report', exact: true }).waitFor();
                    assert.equal(await panel.getByRole('alert').count(), 0, 'Native coverage diagnosis failed');
                }],
                ['System monitor', async () => {
                    await workspace('system');
                    const monitor = page.getByTestId('system-workspace');
                    await monitor.waitFor();
                    for (const id of ['configuration', 'indexes', 'logs', 'overview']) {
                        await monitor.locator(`#system-tab-${id}`).click();
                        await monitor.locator(`#system-panel-${id}`).waitFor();
                    }
                }],
            ]) await run(`Regression ${name}`, async () => {
                await action();
                await screenshot(`regression-${name.toLowerCase().replaceAll(' ', '-')}`);
            });
        }
        await run('Runtime console and native requests', async () => {
            assert.deepEqual(report.pageErrors, [], 'Browser JS errors');
            assert.deepEqual(report.externalRequests, [], 'Unexpected external network request');
            const errors = report.console.filter(item => item.type === 'error' && !report.expectedApiFailures.some(expected => {
                if (!item.url || !/Failed to load resource/.test(item.text) || !item.text.includes(String(expected.status))) return false;
                const url = new URL(item.url);
                return url.pathname + url.search === expected.path;
            }));
            assert.deepEqual(errors, [], 'Browser console errors');
            assert.deepEqual(report.requests.filter(item => item.status >= 400).map(({ path, status }) => ({ path, status })),
                report.expectedApiFailures, 'Unexpected native API failures');
            assert.deepEqual(proxy.log.errors, [], 'Static proxy errors');
        });
    } catch (error) {
        failed = true;
        report.setupError = String(error.stack ?? error);
        console.error(report.setupError);
    } finally {
        report.proxy = proxy?.log;
        await browser?.close().catch(error => { failed = true; report.browserCleanupError = String(error); });
        await proxy?.close().catch(error => { failed = true; report.proxyCleanupError = String(error); });
        await closeChild(nativeChild).catch(error => { failed = true; report.childCleanupError = String(error); });
        try {
            report.daemonStop = await command(options.binary, ['daemon', 'stop'], env, 15_000);
            if (nativePort) await eventually(() => isPortFree(nativePort), 'Own native server still listens after daemon stop', 8000);
            if (proxyPort) assert(await isPortFree(proxyPort), 'Own proxy port was not released');
            report.portsReleased = true;
        } catch (error) {
            failed = true;
            report.cleanupError = String(error.stack ?? error);
        }
        if (!options.keepTemp && report.portsReleased) {
            try { await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
            catch (error) { failed = true; report.tempCleanupError = String(error); }
        }
        report.finished = new Date().toISOString();
        report.status = failed ? 'failed' : 'passed';
        await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
        console.log(`Browser acceptance ${report.status}. Evidence: ${output}`);
        if (failed) process.exitCode = 1;
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
