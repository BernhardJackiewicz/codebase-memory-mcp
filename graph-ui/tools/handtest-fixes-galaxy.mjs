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
/* K8: die dritte Ebene haengt nicht, "−" bricht ab                      */

const scopeState = (page) => page.locator('.atlas-graph-scope-count').first().getAttribute('data-state', { timeout: 1000 }).catch(() => null);
const rpcSince = (page, t0) => page.evaluate((from) => window.__probeRpc.filter((row) => row.t >= from), t0);
const pageNow = (page) => page.evaluate(() => Math.round(performance.now()));
const progressShown = (page) => page.locator('.atlas-graph-render-progress').first().innerText({ timeout: 500 }).catch(() => '');

async function checkK8(page) {
    await section(page, 'K8', 'Expand to layer 3 of JSONBAgg (both directions, all edge types) completes or warns quickly; "−" cancels within 1 s');
    await open(page);
    await select(page, ROOT);
    await settled(page);
    await expand(page);
    await shot(page, 'K8', 'two-layers', `${ROOT} at 2 layers: ${await countText(page)}`);
    const minus = page.getByRole('button', { name: 'Remove graph layer' });
    const expandButton = page.getByRole('button', { name: 'Expand +1' });
    const expandTitle = await expandButton.getAttribute('title');

    // 1. Abbrechen waehrend die dritte Ebene laedt.
    await expandButton.click();
    await wait(400);
    const during = { status: await countText(page), state: await scopeState(page), minusDisabled: await minus.isDisabled(), minusTitle: await minus.getAttribute('title'),
        progress: await progressShown(page) };
    await shot(page, 'K8', 'cancel-loading-400ms', `400 ms into layer 3: "${during.status}", "−" enabled with "${during.minusTitle}"`);
    const c0 = Date.now();
    await minus.click();
    await page.waitForFunction(() => document.querySelector('.atlas-graph-scope-count')?.getAttribute('data-state') !== 'loading'
        && [...document.querySelectorAll('.atlas-graph-exploration span')].some((el) => el.textContent?.trim() === '2 layers'), null, { timeout: 10000 }).catch(() => {});
    const cancelMs = Date.now() - c0;
    await shot(page, 'K8', 'cancel-0ms', `Right after "−": back on 2 layers in ${cancelMs} ms`);
    await wait(250);
    await shot(page, 'K8', 'cancel-250ms', '250 ms after "−"');
    await wait(750);
    const cancelled = { layers: await layerText(page), status: await countText(page), state: await scopeState(page), ms: cancelMs };
    await shot(page, 'K8', 'cancel-1s', `1 s after "−": ${cancelled.layers}, ${cancelled.status}`);
    await check('K8', '"−" cancels a running layer and returns to the previous one within 1 s', during.state === 'loading' && during.minusDisabled === false
        && cancelMs <= 1000 && cancelled.layers === '2 layers' && /^90 nodes · 201 edges/.test(cancelled.status), { expandTitle, during, cancelled });

    // 2. Die dritte Ebene ganz laden.
    await wait(1500);
    const t0 = await pageNow(page);
    const w0 = Date.now();
    await expandButton.click();
    const frames = [];
    for (const [label, at] of [['0ms', 0], ['250ms', 250], ['1s', 1000], ['3s', 3000]]) {
        const elapsed = Date.now() - w0;
        if (at > elapsed) await wait(at - elapsed);
        frames.push({ at: label, status: await countText(page), state: await scopeState(page), progress: await progressShown(page) });
        await shot(page, 'K8', `layer3-${label}`, `${label} after Expand: "${frames.at(-1).status}"${frames.at(-1).progress ? `, overlay "${frames.at(-1).progress}"` : ''}`);
    }
    await page.waitForFunction(() => ['complete', 'partial'].includes(document.querySelector('.atlas-graph-scope-count')?.getAttribute('data-state') ?? ''), null, { timeout: 180000 }).catch(() => {});
    const doneMs = Date.now() - w0;
    const calls = await rpcSince(page, t0);
    const queries = calls.filter((row) => row.tool === 'query_graph');
    await shot(page, 'K8', 'layer3-done', `Layer 3 finished after ${doneMs} ms with ${queries.length} query_graph calls: "${await countText(page)}"`);
    await wait(2000);
    const done = { ms: doneMs, status: await countText(page), state: await scopeState(page),
        title: await page.locator('.atlas-graph-scope-count').first().getAttribute('title').catch(() => null),
        overlayAfter2s: await progressShown(page), queryGraph: queries.length, withCursor: queries.filter((row) => row.cursor).length,
        maxRows: [...new Set(queries.map((row) => row.maxRows))], layers: await layerText(page),
        expandDisabled: await expandButton.isDisabled(), expandTitle: await expandButton.getAttribute('title') };
    await shot(page, 'K8', 'layer3-done-2s', `2 s later: no "Updating view" overlay (${done.overlayAfter2s ? 'still shown' : 'gone'})`);
    await check('K8', 'Layer 3 completes (or stops at the render limit with a partial note) within 30 s in few large requests, and the overlay goes away',
        ['complete', 'partial'].includes(done.state ?? '') && doneMs <= 30000 && done.queryGraph <= 40 && done.overlayAfter2s === '' && done.layers === '3 layers',
        { frames, done });
}

/* ------------------------------------------------------------------ */
/* K3: eine Zeile, auch bei offenem Chat                                */

async function toolbarRows(page) {
    return page.evaluate(() => {
        const bar = document.querySelector('.atlas-graph-exploration');
        if (!bar) return null;
        const box = bar.getBoundingClientRect();
        const items = [...bar.children].filter((el) => el.getBoundingClientRect().height > 0);
        const centres = items.map((el) => { const r = el.getBoundingClientRect(); return Math.round((r.top + r.bottom) / 2); });
        const rows = [...new Set(centres.map((centre) => Math.round(centre / 16)))].length;
        const clipped = items.filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === 'ellipsis')
            .map((el) => el.textContent?.trim().slice(0, 40));
        return { width: Math.round(box.width), height: Math.round(box.height), rows, overflow: bar.scrollWidth > bar.clientWidth + 1, clipped,
            items: items.map((el) => `${(el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 18)}:${Math.round(el.getBoundingClientRect().width)}`) };
    });
}

async function checkK3(page) {
    await section(page, 'K3', 'The scoped Galaxy toolbar stays one row at 1600 px, with the chat closed and open');
    await open(page);
    const chatToggle = async (open) => {
        const button = page.getByRole('button', { name: open ? 'Open chat' : 'Hide chat' }).first();
        if (await button.count()) { await button.click(); await wait(1500); }
    };
    const rows = [];
    const measure = async (label, caption) => {
        const value = await toolbarRows(page);
        rows.push({ label, ...value });
        await shot(page, 'K3', label, `${caption}: toolbar ${value?.width} x ${value?.height} px, ${value?.rows} row(s)`);
        await page.locator('.atlas-graph-exploration').first().screenshot({ path: join(OUT, 'K3', `${label}-toolbar.png`) }).catch(() => {});
    };
    await select(page, ROOT);
    await settled(page);
    await measure('closed-root', `Chat closed, ${ROOT} at 1 layer`);
    await chatToggle(true);
    await measure('open-root', `Chat open, ${ROOT} at 1 layer`);
    await expand(page);
    await measure('open-two-layers', 'Chat open, 2 layers');
    const child = await qualifiedName('test_jsonb_agg_jsonfield_order_by');
    await page.evaluate((qn) => globalThis.__atlasGalaxy?.clickNode(qn), child);
    await settled(page);
    await measure('open-long-root', 'Chat open, long root name test_jsonb_agg_jsonfield_order_by');
    const back = page.getByRole('button', { name: 'Back', exact: true });
    // Ohne Zurueck (Stand vor K2) fuehrt die Suche zur selben Lage.
    if (await back.count()) await back.click(); else { await select(page, ROOT); await settled(page); await expand(page); }
    await settled(page);
    await page.getByRole('button', { name: 'Expand +1' }).click();
    await wait(600);
    await measure('open-loading', 'Chat open while layer 3 loads');
    await page.waitForFunction(() => ['complete', 'partial'].includes(document.querySelector('.atlas-graph-scope-count')?.getAttribute('data-state') ?? ''), null, { timeout: 120000 }).catch(() => {});
    await wait(1500);
    await measure('open-partial', 'Chat open, layer 3 stopped at the render limit');
    await chatToggle(false);
    await measure('closed-partial', 'Chat closed again, layer 3 partial');
    const pass = rows.length === 7 && rows.every((row) => row.rows === 1 && row.height < 60 && !row.overflow);
    await check('K3', 'One toolbar row in every state, chat open (bar about 1170 px) and closed (1600 px)', pass, { rows });
}

/* ------------------------------------------------------------------ */
/* K13: Selection details aus dem geladenen Ausschnitt                  */

const typeList = (counts) => Object.entries(counts).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([type, n]) => `${type} ${n}`).join(' · ');

async function checkK13(page) {
    await section(page, 'K13', 'Selection details lists the relationships of the loaded scope; "Next lines" at the end of a file says so');
    const truth = await relationCounts(ROOT);
    const total = (counts) => Object.values(counts).reduce((sum, n) => sum + n, 0);
    await open(page);
    await select(page, ROOT);
    await settled(page);
    const details = page.locator('.atlas-galaxy-selection-details').first();
    await details.locator('> summary').click();
    await wait(700);
    const summaries = await details.locator('summary').allInnerTexts();
    const source = await details.locator('.selection-context-source').innerText().catch(() => '');
    await shot(page, 'K13', 'details-root', `Selection details for ${ROOT}: ${summaries.filter((text) => /relationships/.test(text)).join(' | ')}`);
    await details.screenshot({ path: join(OUT, 'K13', 'details-root-panel.png') }).catch(() => {});
    const wantIn = `Incoming relationships · ${total(truth.incoming)} (${typeList(truth.incoming)})`;
    const wantOut = `Outgoing relationships · ${total(truth.outgoing)} (${typeList(truth.outgoing)})`;
    await check('K13', `Selection details of ${ROOT} match the index: incoming and outgoing by type, from the loaded scope`,
        summaries.includes(wantIn) && summaries.includes(wantOut) && /loaded Galaxy scope/.test(source), { truth, wantIn, wantOut, summaries, source });

    // Eine Auswahl hinter dem Deckel des Schnappschusses (tests/ liegt hinter 20.000 Knoten).
    const child = await qualifiedName('test_jsonb_agg_jsonfield_order_by');
    const childTruth = await relationCounts('test_jsonb_agg_jsonfield_order_by');
    await page.evaluate((qn) => globalThis.__atlasGalaxy?.clickNode(qn), child);
    await settled(page);
    await wait(800);
    const childText = await details.innerText().catch(() => '');
    const childSummaries = await details.locator('summary').allInnerTexts();
    await shot(page, 'K13', 'details-test-behind-cap', `Selection details for a test behind the snapshot cap: ${childSummaries.filter((text) => /relationships/.test(text)).join(' | ')}`);
    const childOut = `Outgoing relationships · ${total(childTruth.outgoing)} (${typeList(childTruth.outgoing)})`;
    await check('K13', 'A selected test outside the capped snapshot still shows its relationships from the scope', childSummaries.includes(childOut)
        && !/absent from this bounded index snapshot/.test(childText), { childTruth, childOut, childSummaries });

    // "Read source evidence": general.py endet in Zeile 65 (dazu die leere Zeile 66).
    await page.getByRole('button', { name: 'Back', exact: true }).click().catch(() => {});
    await settled(page);
    await wait(800);
    await details.getByRole('button', { name: 'Read source evidence' }).click();
    await page.waitForSelector('nav[aria-label="Source pages"]', { timeout: 20000 }).catch(() => {});
    await wait(500);
    const pager = page.locator('nav[aria-label="Source pages"]').first();
    const pagerText = await pager.innerText().catch(() => '');
    const next = pager.getByRole('button', { name: 'Next lines' });
    const nextState = { disabled: await next.isDisabled().catch(() => null), title: await next.getAttribute('title').catch(() => null) };
    const lines = await page.locator('.source-evidence-lines code > span').count();
    await page.locator('.source-evidence-lines').evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => {});
    await wait(300);
    await shot(page, 'K13', 'source-evidence-end', `Source evidence for general.py scrolled to the end: "${pagerText.replace(/\s+/g, ' ')}"`);
    await check('K13', '"Next lines" is disabled at the real end of general.py and says so', /end of file/.test(pagerText) && nextState.disabled === true
        && /end of this file/.test(nextState.title ?? ''), { pagerText, nextState, renderedLines: lines });
    await page.keyboard.press('Escape');
}

/* ------------------------------------------------------------------ */

const CHECKS = { K9: checkK9, K2: checkK2, K8: checkK8, K3: checkK3, K13: checkK13 };

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
