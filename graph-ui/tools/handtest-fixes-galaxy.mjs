#!/usr/bin/env node
/*
 * Browser-Pruefung der Galaxy-Korrekturen aus dem Handtest vom 03.10.2026
 * (graph-ui/verification/call-feedback-2026-10-02/KORREKTURPLAN.md, K2, K3,
 * K5, K6, K8, K9, K13).
 *
 *   node tools/handtest-fixes-galaxy.mjs --origin http://127.0.0.1:4371 \
 *        --out /tmp/handtest-galaxy [--only K2,K9] [--project django-demo]
 *
 * Jede Pruefung faehrt genau den Ablauf aus dem Korrekturplan, misst in der
 * laufenden Seite und druckt PASS oder FAIL mit den Messwerten. Die Bilder
 * liegen je Punkt unter <out>/<K>/, daneben eine index.md, die jedes Bild und
 * das, was es zeigt, auffuehrt. Gegen einen Stand ohne die Korrekturen
 * gefahren, sollen die Pruefungen fehlschlagen; das ist der Vorher-Beweis.
 *
 * Es startet keinen Server. Gebraucht wird ein Ursprung mit UI und /rpc, etwa
 * tools/lib/static-proxy.mjs vor einem laufenden Server.
 */

import { chromium } from 'playwright';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    return value === undefined || value.startsWith('--') ? true : value;
};

const ORIGIN = String(arg('origin', 'http://127.0.0.1:4371')).replace(/\/$/, '');
const OUT = resolve(String(arg('out', 'verification/handtest-galaxy')));
const PROFILE = resolve(String(arg('profile', join(OUT, 'profile'))));
const PROJECT = String(arg('project', 'django-demo'));
const ONLY = String(arg('only', 'K9,K2,K3,K13,K6,K5,K8')).split(',');
const VIEWPORT = { width: 1600, height: 1000 };
const ROOT = 'JSONBAgg';
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/* ------------------------------------------------------------------ */
/* Server                                                             */

let rpcId = 1;
async function tool(name, args) {
    const res = await fetch(`${ORIGIN}/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    const text = body?.result?.content?.[0]?.text ?? '';
    try { return JSON.parse(text); } catch { return { raw: text }; }
}

/** Der qualifizierte Name eines Symbols, so wie der Index ihn kennt. */
async function qualifiedName(name) {
    const answer = await tool('query_graph', { project: PROJECT, format: 'json', query: `MATCH (n) WHERE n.name = "${name}" RETURN n.qualified_name ORDER BY n.qualified_name LIMIT 1` });
    return answer?.rows?.[0]?.[0] ?? '';
}

/** Die direkten Beziehungen eines Symbols nach Richtung und Art, als Wahrheit fuer K13. */
async function relationCounts(name) {
    const count = async (pattern) => {
        const answer = await tool('query_graph', { project: PROJECT, format: 'json', query: `MATCH ${pattern} WHERE n.name = "${name}" RETURN type(r) AS type, count(r) AS edges ORDER BY type` });
        return Object.fromEntries((answer?.rows ?? []).map(([type, edges]) => [type, Number(edges)]));
    };
    return { incoming: await count('(a)-[r]->(n)'), outgoing: await count('(n)-[r]->(b)') };
}

/* ------------------------------------------------------------------ */
/* In jede Seite                                                       */

function pageProbe() {
    try { localStorage.setItem('cbm.workspace.setup', 'done'); } catch { /* ohne Speicher geht es auch */ }
    window.__probeErrors = [];
    window.addEventListener('error', (event) => window.__probeErrors.push(String(event.message)));
    window.__probeRpc = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.endsWith('/rpc') && init?.body) {
            try {
                const body = JSON.parse(String(init.body));
                window.__probeRpc.push({ t: Math.round(performance.now()), tool: body?.params?.name, cursor: Boolean(body?.params?.arguments?.cursor), maxRows: body?.params?.arguments?.max_rows ?? null });
            } catch { /* nur Beobachtung */ }
        }
        return nativeFetch(input, init);
    };
}

/* ------------------------------------------------------------------ */
/* Ergebnis                                                            */

const results = [];
const counters = new Map();

function check(id, title, pass, measured) {
    results.push({ id, title, pass: Boolean(pass), measured });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}  ${JSON.stringify(measured)}`);
    return appendFile(join(OUT, id, 'index.md'), `\n**${pass ? 'PASS' : 'FAIL'}** ${title}\n\n\`\`\`json\n${JSON.stringify(measured, null, 2)}\n\`\`\`\n`);
}

/** Ein Bild, mit dem, was es zeigen soll, in der index.md des Punktes. */
async function shot(page, id, label, caption) {
    const next = (counters.get(id) ?? 0) + 1;
    counters.set(id, next);
    const file = `${String(next).padStart(2, '0')}-${label}.png`;
    await page.screenshot({ path: join(OUT, id, file) });
    await appendFile(join(OUT, id, 'index.md'), `- \`${file}\`: ${caption}\n`);
    return file;
}

async function section(page, id, title) {
    await mkdir(join(OUT, id), { recursive: true });
    await writeFile(join(OUT, id, 'index.md'), `# ${id}: ${title}\n\nOrigin ${ORIGIN}, project ${PROJECT}, viewport ${VIEWPORT.width}x${VIEWPORT.height}.\n\n`);
}

/* ------------------------------------------------------------------ */
/* Bedienung                                                           */

const toolbar = (page) => page.locator('.atlas-graph-exploration').first();
const scopeName = (page) => page.locator('.atlas-graph-scope-name').first().innerText({ timeout: 1000 }).catch(() => '');
const countText = (page) => page.locator('.atlas-graph-scope-count').first().innerText({ timeout: 1000 }).catch(() => '');
const layerText = (page) => toolbar(page).evaluate((bar) => [...bar.querySelectorAll('span')].map((el) => el.textContent?.trim() ?? '')
    .find((text) => /^\d+ layers?$/.test(text)) ?? '').catch(() => '');

async function open(page) {
    await page.goto(`${ORIGIN}/?project=${encodeURIComponent(PROJECT)}&workspace=galaxy`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.atlas-shell', { timeout: 30000 });
    await page.waitForFunction(() => (globalThis.__atlasGalaxy?.nodes ?? 0) > 0 && globalThis.__atlasGalaxyFit !== undefined, null, { timeout: 60000 });
    await wait(1200);
}

async function select(page, name) {
    const input = page.getByRole('searchbox', { name: 'Find a graph node' }).first();
    await input.click();
    await input.fill('');
    await input.type(name, { delay: 20 });
    const choice = page.locator('.atlas-galaxy-search-results button', { has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).first();
    await choice.waitFor({ timeout: 20000 });
    await choice.click();
}

/** Bis die Statuszeile einen fertigen Ausschnitt meldet. */
async function settled(page, timeout = 30000) {
    const started = Date.now();
    const ok = await page.waitForFunction(() => {
        const text = document.querySelector('.atlas-graph-scope-count')?.textContent ?? '';
        return /\d[\d,.]* nodes? · \d[\d,.]* edges?/.test(text) && !/Loading|Checking/.test(text);
    }, null, { timeout }).then(() => true).catch(() => false);
    await wait(900);
    return { ok, ms: Date.now() - started };
}

async function expand(page) {
    await page.getByRole('button', { name: 'Expand +1' }).click();
    return settled(page, 60000);
}

const canvasBox = (page) => page.locator('.atlas-galaxy canvas').first().boundingBox();

/* ------------------------------------------------------------------ */
/* K9: ein Klick ins Leere verlaesst den Ausschnitt nicht               */

async function checkK9(page) {
    await section(page, 'K9', 'A click on empty canvas keeps the scope; only All graph, Escape or Back leave it');
    await open(page);
    await select(page, ROOT);
    await settled(page);
    await expand(page);
    const before = { scope: await scopeName(page), layers: await layerText(page), count: await countText(page) };
    await shot(page, 'K9', 'before-click', `${ROOT} at ${before.layers}, ${before.count}: the scope before the click on empty canvas`);
    const box = await canvasBox(page);
    const root = await page.locator('[data-testid="atlas-galaxy-root-marker"] i').first().boundingBox().catch(() => null);
    // Wie im Handtest: knapp neben einen Knoten, und einmal in eine leere Ecke.
    const spots = [
        root ? { label: 'beside-root', x: root.x + root.width / 2 + 34, y: root.y + root.height / 2 - 30 } : null,
        { label: 'empty-corner', x: box.x + 60, y: box.y + box.height - 60 },
    ].filter(Boolean);
    const after = [];
    for (const spot of spots) {
        await page.mouse.click(spot.x, spot.y);
        await shot(page, 'K9', `${spot.label}-0ms`, `0 ms after a click at ${spot.label} (${Math.round(spot.x)}, ${Math.round(spot.y)})`);
        await wait(250);
        await shot(page, 'K9', `${spot.label}-250ms`, '250 ms after the click');
        await wait(750);
        await shot(page, 'K9', `${spot.label}-1s`, '1 s after the click: scope, layers and toolbar unchanged');
        await wait(2000);
        await shot(page, 'K9', `${spot.label}-3s`, '3 s after the click');
        after.push({ spot: spot.label, scope: await scopeName(page), layers: await layerText(page), count: await countText(page),
            headline: await page.locator('[data-testid="atlas-galaxy-headline"]').innerText().catch(() => '') });
    }
    const kept = after.every((row) => row.scope === before.scope && row.layers === before.layers && row.count === before.count);
    await check('K9', 'Clicks on empty canvas keep scope, layers and counts', kept, { before, after });

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.press('Escape');
    await wait(1500);
    const escaped = { scope: await scopeName(page), headline: await page.locator('[data-testid="atlas-galaxy-headline"]').innerText().catch(() => '') };
    await shot(page, 'K9', 'escape', `After Escape: back on the whole graph (${escaped.headline})`);
    await page.keyboard.press('Alt+ArrowLeft');
    const back = await settled(page);
    const restored = { scope: await scopeName(page), layers: await layerText(page), count: await countText(page), ms: back.ms };
    await shot(page, 'K9', 'alt-left', `After Alt+Left: ${restored.scope} at ${restored.layers} again`);
    await check('K9', 'Escape leaves the scope, Back (Alt+Left) returns to it', escaped.scope === '' && restored.scope === before.scope && restored.layers === before.layers,
        { escaped, restored });
}

/* ------------------------------------------------------------------ */
/* K2: Zurueck und Vor                                                  */

async function checkK2(page) {
    await section(page, 'K2', 'Back and Forward through the visited scopes, bounded, with a recent list');
    await open(page);
    const backButton = page.getByRole('button', { name: 'Back', exact: true });
    const forwardButton = page.getByRole('button', { name: 'Forward', exact: true });
    const state = async () => ({ scope: await scopeName(page), layers: await layerText(page), count: await countText(page),
        back: await backButton.getAttribute('title', { timeout: 1000 }).catch(() => null),
        backDisabled: await backButton.isDisabled({ timeout: 1000 }).catch(() => null),
        forward: await forwardButton.getAttribute('title', { timeout: 1000 }).catch(() => null),
        forwardDisabled: await forwardButton.isDisabled({ timeout: 1000 }).catch(() => null),
        history: await page.evaluate(() => { const h = globalThis.__atlasGalaxy?.history; return h ? { index: h.index, entries: h.entries.length } : null; }) });
    const steps = [];
    await select(page, ROOT);
    await settled(page);
    steps.push({ step: `select ${ROOT}`, ...await state() });
    await shot(page, 'K2', 'select-root', `${ROOT} selected from the whole graph: Back names "All graph"`);
    await expand(page);
    steps.push({ step: 'expand', ...await state() });
    const child = await qualifiedName('test_jsonb_agg_jsonfield_order_by');
    await page.evaluate((qn) => globalThis.__atlasGalaxy?.clickNode(qn), child);
    await settled(page);
    steps.push({ step: 'click test_jsonb_agg_jsonfield_order_by', ...await state() });
    await shot(page, 'K2', 'new-root', 'A click on a test made it the new root; Back names the previous scope');
    await page.locator('.atlas-graph-history').screenshot({ path: join(OUT, 'K2', 'history-buttons.png') }).catch(() => {});

    if (await backButton.count() === 0) {
        await check('K2', 'Back and Forward buttons exist in the scoped toolbar', false, { steps });
        return;
    }
    const t0 = Date.now();
    await backButton.click();
    await shot(page, 'K2', 'back-0ms', '0 ms after Back');
    await wait(250);
    await shot(page, 'K2', 'back-250ms', '250 ms after Back');
    const backOne = await settled(page);
    steps.push({ step: 'Back', ms: Date.now() - t0, settledOk: backOne.ok, ...await state() });
    await shot(page, 'K2', 'back-1', `After Back: ${ROOT} at 2 layers again, Forward names the test`);
    await backButton.click();
    await settled(page);
    steps.push({ step: 'Back', ...await state() });
    await backButton.click();
    await wait(1500);
    steps.push({ step: 'Back', ...await state() });
    await shot(page, 'K2', 'back-all-graph', 'Third Back: the whole graph, Back disabled, Forward enabled');
    await forwardButton.click();
    await settled(page);
    steps.push({ step: 'Forward', ...await state() });
    await page.keyboard.press('Alt+ArrowRight');
    await settled(page);
    steps.push({ step: 'Alt+Right', ...await state() });
    await page.keyboard.press('Alt+ArrowRight');
    await settled(page);
    steps.push({ step: 'Alt+Right', ...await state() });
    await shot(page, 'K2', 'forward-end', 'Forward twice by keyboard: back at the test root, Forward disabled');

    const recent = page.locator('details.atlas-graph-recent');
    let recentNames = [];
    if (await recent.count()) {
        await recent.locator('summary').click();
        await wait(300);
        recentNames = await recent.locator('li button strong').allInnerTexts();
        await shot(page, 'K2', 'recent-open', `Recent list: ${recentNames.join(', ')}`);
        await recent.locator('li button', { has: page.locator('strong', { hasText: new RegExp(`^${ROOT}$`) }) }).first().click();
        await settled(page);
        steps.push({ step: `Recent ${ROOT}`, ...await state() });
        await shot(page, 'K2', 'recent-jump', `Jump from the recent list: ${ROOT} with its last depth, Forward dropped`);
    }
    // Begrenzt: viele Schritte, und der Verlauf haelt hoechstens 25 Eintraege.
    for (let i = 0; i < 30; i += 1) {
        await page.getByRole('button', { name: i % 2 ? 'Expand +1' : 'Remove graph layer' }).click({ timeout: 3000 }).catch(() => {});
        await settled(page, 10000);
    }
    await settled(page);
    let backs = 0;
    for (; backs < 40 && !(await backButton.isDisabled()); backs += 1) { await backButton.click(); await wait(60); }
    await settled(page);
    steps.push({ step: `Back until disabled (${backs} steps)`, ...await state() });
    const at = (index) => steps[index] ?? {};
    const pass = at(0).back?.startsWith('Back to All graph') && at(2).back?.startsWith(`Back to ${ROOT} · 2 layers`)
        && at(3).scope === ROOT && at(3).layers === '2 layers' && at(3).forward?.startsWith('Forward to test_jsonb_agg_jsonfield_order_by')
        && at(4).layers === '1 layer' && at(5).scope === '' && at(5).backDisabled === true && at(6).scope === ROOT
        && at(8).scope === 'test_jsonb_agg_jsonfield_order_by' && at(8).forwardDisabled === true
        && recentNames.slice(0, 2).join() === `test_jsonb_agg_jsonfield_order_by,${ROOT}` && at(9).scope === ROOT && at(9).forwardDisabled === true
        && backs <= 24 && (at(10).history?.entries ?? 99) <= 25;
    await check('K2', 'Back/Forward/Alt+arrows/Recent restore root, depth and direction; history stays bounded', pass, { steps, recentNames, backsUntilStart: backs });
}

/* ------------------------------------------------------------------ */

const CHECKS = { K9: checkK9, K2: checkK2 };

await mkdir(OUT, { recursive: true });
const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false, viewport: VIEWPORT, deviceScaleFactor: 2,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});
await context.addInitScript(pageProbe);
const page = context.pages()[0] ?? await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => { pageErrors.push(error.message); console.error(`[pageerror] ${error.message}`); });
for (const id of ONLY) {
    const run = CHECKS[id];
    if (!run) continue;
    try { await run(page); } catch (error) {
        console.error(`[${id}] ABORT ${error?.stack ?? error}`);
        await check(id, 'check ran to completion', false, { error: String(error?.message ?? error).split('\n')[0] }).catch(() => {});
    }
}
await context.close();
const passed = results.filter((row) => row.pass).length;
await writeFile(join(OUT, 'report.json'), JSON.stringify({ origin: ORIGIN, project: PROJECT, passed, total: results.length, results, pageErrors }, null, 2));
console.log(`${passed}/${results.length} PASS${pageErrors.length ? `, page errors: ${pageErrors.length}` : ''}`);
if (passed !== results.length) process.exitCode = 1;
