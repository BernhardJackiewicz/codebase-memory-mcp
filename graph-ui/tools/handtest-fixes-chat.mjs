#!/usr/bin/env node
/*
 * Browser checks for the chat and local agent items of the hand test of 2026-10-03
 * (graph-ui/verification/call-feedback-2026-10-02/KORREKTURPLAN.md: K1, K4, K7, K10,
 * K11, K12, K14, K15, K16, K17, K24).
 *
 *   node tools/handtest-fixes-chat.mjs --origin http://127.0.0.1:4392 --out /tmp/chat \
 *        --profile /tmp/profile-with-cached-model [--only K14,K7] [--runs 3]
 *
 * One check per item. Each drives the flow the plan describes, measures it in the page
 * (DOM text and boxes, the messages sent to the model worker, the agent lamp) and prints
 * PASS or FAIL with the measured values. Screenshots go to <out>/<K-id>/ with an
 * index.md that names each image; model outputs go to <out>/<K-id>/outputs.json.
 *
 * It starts no server. It needs a running server with the UI and a browser profile in
 * which the local model is cached for this origin (Cache Storage is per origin).
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    return value === undefined || value.startsWith('--') ? true : value;
};
const ORIGIN = String(arg('origin', 'http://127.0.0.1:4392')).replace(/\/$/, '');
const OUT = resolve(String(arg('out', 'verification/handtest-fixes-chat')));
const PROFILE = resolve(String(arg('profile', join(OUT, '..', 'profile'))));
const PROJECT = String(arg('project', 'django-demo'));
const CONTROL = String(arg('control', 'cbm'));
const RUNS = Number(arg('runs', 3));
const ALL = ['K15', 'K16', 'K11', 'K17', 'K14', 'K7', 'K4', 'K1', 'K12', 'K10', 'K24'];
const ONLY = String(arg('only', ALL.join(','))).split(',');
const VIEWPORT = { width: 1600, height: 1000 };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/* ------------------------------------------------------------------ */
/* In every page                                                       */

function pageProbe() {
    try { localStorage.setItem('cbm.workspace.setup', 'done'); } catch { /* without storage it still works */ }
    // Everything sent to the model worker, including workers created later.
    window.__probeWorker = [];
    window.__probeAnswers = [];
    const NativeWorker = window.Worker;
    window.Worker = class ProbeWorker extends NativeWorker {
        constructor(url, options) {
            super(url, options);
            // The model's raw answers, before the chat checks or shortens them.
            this.addEventListener('message', (event) => {
                if (event.data?.kind === 'answer') window.__probeAnswers.push({ t: Math.round(performance.now()), output: event.data.output, stopReason: event.data.stopReason });
            });
        }
        postMessage(message, transfer) {
            try {
                if (message && typeof message === 'object' && typeof message.kind === 'string') {
                    window.__probeWorker.push({ t: Math.round(performance.now()), kind: message.kind, profile: message.generationProfile ?? '',
                        messages: Array.isArray(message.messages) ? message.messages : undefined });
                }
            } catch { /* observation only */ }
            return super.postMessage(message, transfer);
        }
    };
    window.__probeErrors = [];
    window.addEventListener('error', (event) => window.__probeErrors.push(String(event.message)));
}

/* ------------------------------------------------------------------ */
/* Result                                                              */

const results = [];
const modelRequests = [];
const images = new Map();
function check(id, title, pass, measured) {
    results.push({ id, title, pass: Boolean(pass), measured });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}  ${JSON.stringify(measured)}`);
}
async function shot(page, id, label, proves, options = {}) {
    await mkdir(join(OUT, id), { recursive: true });
    const list = images.get(id) ?? [];
    const file = `${String(list.length + 1).padStart(2, '0')}-${label}.png`;
    await page.screenshot({ path: join(OUT, id, file), ...options });
    list.push({ file, proves }); images.set(id, list);
    return file;
}
async function save(id, name, value) {
    await mkdir(join(OUT, id), { recursive: true });
    await writeFile(join(OUT, id, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

/* ------------------------------------------------------------------ */
/* Page helpers                                                        */

async function freshHistory(page) {
    // A page of this origin without the app, so the chat history database is not open.
    await page.goto(`${ORIGIN}/probe-blank`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => new Promise((done) => { const request = indexedDB.deleteDatabase('cbm-browser-chat-history'); request.onsuccess = request.onerror = request.onblocked = () => done(); }));
}
async function open(page, project, workspace) {
    await page.goto(`${ORIGIN}/?project=${encodeURIComponent(project)}&workspace=${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.atlas-shell', { timeout: 30000 });
    await wait(1500);
}
const agentLabel = (page) => page.locator('.atlas-browser-ai-action').first().getAttribute('aria-label').catch(() => '');
async function agentActive(page, timeout = 300000) {
    return page.waitForFunction(() => /Agent active/.test(document.querySelector('.atlas-browser-ai-action')?.getAttribute('aria-label') ?? ''), null, { timeout })
        .then(() => true).catch(() => false);
}
async function openConfig(page) {
    if (!(await page.locator('dialog.cbm-agent-settings').count())) await page.locator('.atlas-browser-ai-action').first().click();
    await page.locator('dialog.cbm-agent-settings').waitFor({ timeout: 10000 });
    await wait(400);
}
async function closeConfig(page) {
    if (await page.locator('dialog.cbm-agent-settings').count()) await page.getByRole('button', { name: 'Close agent configuration' }).click();
    await wait(300);
}
async function loadModel(page) {
    if (/Agent active/.test(await agentLabel(page) ?? '')) return true;
    await openConfig(page);
    const load = page.locator('dialog.cbm-agent-settings button').filter({ hasText: /^(Load model|Download & load|Reload model)/ });
    if (await load.count()) await load.first().click();
    const ok = await agentActive(page);
    await closeConfig(page);
    return ok;
}
async function openChat(page) {
    const toggle = page.getByRole('button', { name: 'Open chat' });
    if (await toggle.count()) { await toggle.first().click(); await wait(800); }
}
/** Switch workspace by its tab: no reload, so the loaded model stays. */
async function tab(page, workspace) {
    await page.locator(`[data-workspace-tab="${workspace}"]`).first().click();
    await wait(1500);
}
async function galaxyReady(page) {
    await page.waitForFunction(() => (globalThis.__atlasGalaxy?.nodes ?? 0) > 0, null, { timeout: 60000 }).catch(() => {});
    await wait(1000);
}
async function select(page, name) {
    const input = page.getByRole('searchbox', { name: 'Find a graph node' }).first();
    await input.click();
    await input.fill('');
    await input.type(name, { delay: 25 });
    const choice = page.locator('.atlas-galaxy-search-results button', { has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).first();
    await choice.waitFor({ timeout: 20000 });
    await choice.click();
}
async function scopeSettled(page, timeout = 30000) {
    await page.waitForFunction(() => {
        const text = document.querySelector('.atlas-graph-exploration')?.textContent ?? '';
        return /\d+ nodes? · \d+ edges?/.test(text) && !/Loading relationships|Checking index/.test(text);
    }, null, { timeout }).catch(() => {});
    await wait(1200);
}
/** Until the automatic explanation has finished (its "Explain again" button is back). */
async function explanationDone(page, timeout = 180000) {
    await page.waitForFunction(() => {
        const section = document.querySelector('.cbm-chat-explanation');
        return Boolean(section?.querySelector('.cbm-chat-retry')) && !/Explaining selection|Preparing explanation|adding one sentence/.test(section.textContent ?? '');
    }, null, { timeout }).catch(() => {});
    await wait(400);
}
async function explanationText(page) {
    return (await page.locator('.cbm-chat-explanation').innerText().catch(() => '')).replace(/\n?Explain again\s*$/, '').trim();
}
async function ask(page, question, timeout = 240000) {
    const before = await page.locator('.cbm-chat-turn').count();
    const prompt = page.locator('#cbm-chat-prompt');
    await prompt.click();
    await prompt.fill(question);
    await prompt.press('Enter');
    await page.waitForFunction((count) => document.querySelectorAll('.cbm-chat-turn').length > count, before, { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector('.cbm-chat-send[aria-label="Stop"]') && !/Thinking…/.test(document.querySelector('.cbm-chat-turn:last-of-type')?.textContent ?? ''), null, { timeout }).catch(() => {});
    await wait(600);
    return page.locator('.cbm-chat-turn').last().innerText().catch(() => '');
}
const workerMessages = (page) => page.evaluate(() => window.__probeWorker.slice());
const markWorker = (page) => page.evaluate(() => window.__probeWorker.length);
const sentSince = async (page, mark, kind = 'chat') => (await workerMessages(page)).slice(mark).filter((entry) => entry.kind === kind);
const promptText = (entry) => (entry?.messages ?? []).map((message) => `[${message.role}] ${message.content}`).join('\n\n');
async function clickExplainAgain(page) {
    const button = page.locator('.cbm-chat-explanation .cbm-chat-retry');
    await button.click();
    await wait(800);
    await explanationDone(page);
}
async function newConversation(page) {
    const button = page.locator('.cbm-chat-header .cbm-chat-new');
    if (!(await button.count())) return;
    page.once('dialog', (dialog) => { void dialog.accept(); });
    await button.click();
    await wait(600);
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */

/** Galaxy with JSONBAgg selected; returns the worker mark from just before the selection. */
async function galaxyWithJsonb(page) {
    await open(page, PROJECT, 'galaxy');
    await galaxyReady(page);
    await loadModel(page);
    await openChat(page);
    const mark = await markWorker(page);
    await select(page, 'JSONBAgg');
    await scopeSettled(page);
    return mark;
}
const answersSince = async (page, from) => (await page.evaluate(() => window.__probeAnswers.slice())).filter((entry) => entry.t >= from);
const now = (page) => page.evaluate(() => Math.round(performance.now()));

async function k15(page) {
    await galaxyWithJsonb(page);
    await explanationDone(page);
    const toggle = page.locator('.cbm-chat-explanation .cbm-chat-response-source > summary');
    await shot(page, 'K15', 'before-expand', 'The explanation with its collapsed Source toggle.');
    await toggle.click();
    await wait(500);
    const blocks = await page.evaluate(() => [...document.querySelectorAll('.cbm-chat-explanation .cbm-chat-source-content pre')].map((pre) => ({
        scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth, whiteSpace: getComputedStyle(pre).whiteSpace, text: pre.textContent.slice(0, 80) })));
    const panel = await page.locator('.cbm-chat-explanation .cbm-chat-source-content').boundingBox();
    await shot(page, 'K15', 'after-expand', 'The expanded Source block: every fact and code line wraps inside the panel, nothing is cut at the right edge.');
    if (panel) await shot(page, 'K15', 'after-expand-crop', 'Crop of the expanded Source block.', { clip: { x: panel.x - 8, y: panel.y - 8, width: panel.width + 16, height: Math.min(panel.height + 16, 700) } });
    // The facts of the hand test (17:45): long caller lists and paths, here under a listed answer.
    await ask(page, 'Who calls JSONBAgg?');
    const turn = page.locator('.cbm-chat-turn').last();
    await turn.locator('.cbm-chat-response-source > summary').click();
    await wait(500);
    const facts = await turn.evaluate((element) => [...element.querySelectorAll('.cbm-chat-source-content pre')].map((pre) => ({
        scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth, whiteSpace: getComputedStyle(pre).whiteSpace, text: pre.textContent.slice(0, 80) })));
    const factsBox = await turn.locator('.cbm-chat-source-content').boundingBox();
    if (factsBox) await shot(page, 'K15', 'facts-expanded-crop', 'The expanded Source of a listed answer: the long CALLS/TESTS lines and paths wrap, "test_empty_result_set" and "django/contrib/postgres/..." are complete.',
        { clip: { x: factsBox.x - 8, y: Math.max(0, factsBox.y - 8), width: factsBox.width + 16, height: Math.min(factsBox.height + 16, 700) } });
    const all = [...blocks, ...facts];
    const clipped = all.filter((block) => block.scrollWidth > block.clientWidth + 1);
    check('K15', 'Expanded Source blocks wrap long lines (no horizontal overflow)', blocks.length > 0 && facts.length > 0 && clipped.length === 0 && all.every((block) => block.whiteSpace === 'pre-wrap'),
        { explanationBlocks: blocks.length, factBlocks: facts.length, clipped, whiteSpace: [...new Set(all.map((block) => block.whiteSpace))], factsStart: facts.map((block) => block.text) });
}

async function k16(page) {
    await galaxyWithJsonb(page);
    await explanationDone(page);
    const mark = await markWorker(page);
    const last = () => page.locator('.cbm-chat-turn').last();
    const buttons = async () => (await last().locator('button.cbm-chat-retry').allInnerTexts()).map((text) => text.trim());
    const typo = await ask(page, 'wer ruf jsonbagg auf');
    await shot(page, 'K16', 'typo-listed', '"wer ruf jsonbagg auf" is answered with the listed callers from the graph.');
    const shortTypo = await ask(page, 'wer rft jsonbagg auf');
    const suggestion = await ask(page, 'jsonbagg aufrufe?');
    const germanButtons = await buttons();
    await shot(page, 'K16', 'suggestion', '"jsonbagg aufrufe?" gets "Meintest du: Aufrufer von JSONBAgg?" with the German choices "Liste anzeigen" and "Modell fragen".');
    const box = await last().boundingBox();
    if (box) await shot(page, 'K16', 'suggestion-crop', 'Crop of the German suggestion and its German buttons.', { clip: { x: box.x - 8, y: Math.max(0, box.y - 8), width: box.width + 16, height: Math.min(box.height + 16, 500) } });
    await last().getByRole('button', { name: 'Liste anzeigen' }).click();
    await wait(600);
    const listed = await last().innerText();
    const listedButtons = await buttons();
    await shot(page, 'K16', 'suggestion-listed', 'After "Liste anzeigen" the suggestion is replaced by the complete listed answer; its button reads "Modell fragen".');
    // The direction is read after the whole selection phrase: "this class call" asks what it calls.
    const direction = await ask(page, 'Does this class call super?');
    const englishButtons = await buttons();
    await shot(page, 'K16', 'direction', '"Does this class call super?" is offered as "what JSONBAgg calls", with the English choices.');
    const modelCalls = await sentSince(page, mark);
    // A real word one edit from "ruft" is not corrected: "Luft" goes to the model, not to a suggestion.
    const luftMark = await markWorker(page);
    const luft = await ask(page, 'Hat diese Klasse Luft?');
    const luftCalls = await sentSince(page, luftMark);
    await shot(page, 'K16', 'luft-to-model', '"Hat diese Klasse Luft?" is not read as a call question: the model answers it.');
    const callers = ['test_default_argument', 'test_empty_result_set', 'test_jsonb_agg', 'test_values_list'];
    check('K16', 'Typo caller questions are listed; uncertain ones are suggested in the right direction and language; no model call', /Aufrufer von JSONBAgg im geladenen Graphen/.test(typo)
        && callers.every((name) => typo.includes(name)) && /Aufrufer von JSONBAgg im geladenen Graphen/.test(shortTypo) && /Meintest du: Aufrufer von JSONBAgg\?/.test(suggestion)
        && JSON.stringify(germanButtons) === JSON.stringify(['Liste anzeigen', 'Modell fragen']) && /Aufrufer von JSONBAgg im geladenen Graphen/.test(listed)
        && JSON.stringify(listedButtons) === JSON.stringify(['Modell fragen']) && /Did you mean: what JSONBAgg calls\?/.test(direction)
        && JSON.stringify(englishButtons) === JSON.stringify(['Show the list', 'Ask the model']) && modelCalls.length === 0 && luftCalls.length === 1 && !/Meintest du|Did you mean/.test(luft),
    { typoAnswerStart: typo.slice(0, 120), shortTypo: shortTypo.slice(0, 120), suggestion: suggestion.slice(0, 200), germanButtons, afterShowList: listed.slice(0, 120), listedButtons,
        direction: direction.slice(0, 200), englishButtons, modelCallsBeforeLuft: modelCalls.length, luftModelCalls: luftCalls.length, luft: luft.slice(0, 200) });
}

async function k11(page) {
    await open(page, PROJECT, 'galaxy');
    await galaxyReady(page);
    await loadModel(page);
    await openChat(page);
    await shot(page, 'K11', 'all-graph-before', 'Galaxy shows the whole graph (All graph); nothing is selected.');
    const mark = await markWorker(page);
    const german = await ask(page, 'was kannst du mir über den code sagen');
    const english = await ask(page, 'test');
    await shot(page, 'K11', 'after-questions', 'Both questions get the chat\'s own reply saying what to select; the model was not asked.');
    const sent = (await workerMessages(page)).slice(mark).filter((entry) => entry.kind === 'chat' || entry.kind === 'count');
    check('K11', 'Without context the model is not called and the reply says what to select (de/en)', sent.length === 0
        && /Wähle einen Knoten in Galaxy oder einen Teil in Architecture, oder öffne eine Datei in Explore/.test(german) && /Select a node in Galaxy or a part in Architecture, or open a file in Explore/.test(english),
    { workerMessages: sent.length, german: german.slice(0, 220), english: english.slice(0, 200) });
}

async function openWorkflowFile(page) {
    await open(page, PROJECT, 'explore');
    for (const path of ['.github', '.github/workflows']) {
        const row = page.locator(`.atlas-tree-row[data-path="${path}"]`).first();
        await row.waitFor({ timeout: 30000 });
        for (let attempt = 0; attempt < 4 && (await row.getAttribute('data-expanded')) !== 'true'; attempt++) { await row.click(); await wait(1200); }
    }
    const file = page.locator('.atlas-tree-row[data-path=".github/workflows/new_contributor_pr.yml"]').first();
    await file.waitFor({ timeout: 30000 });
    await file.click();
    await page.waitForFunction(() => /New contributor message/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
    await wait(2500);
}

async function k17(page) {
    await openWorkflowFile(page);
    await loadModel(page);
    await openChat(page);
    await explanationDone(page);
    const exploreAnswer = await ask(page, 'was kannst du mir über dieses aktuelle File sagen');
    await shot(page, 'K17', 'explore-answer', 'A question about the YAML workflow in Explore and its answer.');
    await tab(page, 'galaxy');
    await galaxyReady(page);
    await select(page, 'JSONBAgg');
    await scopeSettled(page);
    await explanationDone(page);
    let mark = await markWorker(page);
    const galaxyAnswer = await ask(page, 'What does JSONBAgg do?');
    const [request] = await sentSince(page, mark);
    const text = promptText(request);
    await shot(page, 'K17', 'galaxy-answer', 'In Galaxy a divider marks the new topic JSONBAgg; New conversation sits in the chat header.');
    const header = await page.locator('.cbm-chat-header').innerText();
    const header1 = await page.locator('.cbm-chat-header .cbm-chat-new').boundingBox();
    if (header1) await shot(page, 'K17', 'header-crop', 'Crop of the chat header with the New conversation button.', { clip: { x: header1.x - 260, y: header1.y - 14, width: header1.width + 320, height: header1.height + 28 } });
    const assistantTurns = (request?.messages ?? []).filter((message) => message.role === 'assistant').length;
    // Back to the same workflow file: its earlier answer is not sent again, as the divider says (review finding).
    await tab(page, 'explore');
    await page.waitForFunction(() => /New contributor message/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
    await explanationDone(page);
    mark = await markWorker(page);
    const returnAnswer = await ask(page, 'Und was noch?');
    const [back] = await sentSince(page, mark);
    const backText = promptText(back);
    const divider = await page.locator('.cbm-chat-topic-break').allInnerTexts();
    await shot(page, 'K17', 'explore-return', 'Back in Explore on the same file: a divider "New topic: .github/workflows/new_contributor_pr.yml"; the earlier answer is not in the prompt.');
    const dividerBox = await page.locator('.cbm-chat-topic-break').last().boundingBox();
    if (dividerBox) await shot(page, 'K17', 'explore-return-crop', 'Crop of the divider above the returned question.', { clip: { x: dividerBox.x - 8, y: Math.max(0, dividerBox.y - 8), width: dividerBox.width + 16, height: 220 } });
    const backAssistant = (back?.messages ?? []).filter((message) => message.role === 'assistant').length;
    const backUsers = (back?.messages ?? []).filter((message) => message.role === 'user').map((message) => message.content.split('\n').at(-1));
    check('K17', 'Earlier answers about another file are not resent, also not on the way back; topic breaks and New conversation visible', Boolean(request) && !/was kannst du mir über dieses aktuelle File/.test(text)
        && !text.includes(exploreAnswer.slice(-60).trim()) && assistantTurns === 0 && /New conversation/.test(header) && divider.some((item) => /New topic: JSONBAgg/.test(item))
        && Boolean(back) && backAssistant === 0 && !/was kannst du mir über dieses aktuelle File/.test(backText) && !backText.includes(exploreAnswer.slice(-60).trim())
        && JSON.stringify(backUsers) === JSON.stringify(['Und was noch?']) && divider.some((item) => /New topic: \.github\/workflows\/new_contributor_pr\.yml\. Earlier messages are not sent/.test(item)),
    { assistantMessagesInPrompt: assistantTurns, flake8InPrompt: /flake8/i.test(text), exploreQuestionInPrompt: /aktuelle File/.test(text), header, divider, galaxyAnswer: galaxyAnswer.slice(0, 200),
        returnPrompt: { assistantMessages: backAssistant, userMessages: backUsers, earlierExploreAnswerInPrompt: backText.includes(exploreAnswer.slice(-60).trim()) }, returnAnswer: returnAnswer.slice(0, 200) });
    await save('K17', 'prompt-galaxy.txt', text);
    await save('K17', 'prompt-explore-return.txt', backText);
}

async function setAutomatic(page, on) {
    await openConfig(page);
    const box = page.getByLabel('Explain selections automatically');
    if (on) await box.check(); else await box.uncheck();
    await closeConfig(page);
}

async function k14(page) {
    const mark = await galaxyWithJsonb(page);
    await explanationDone(page);
    const [request] = (await sentSince(page, mark)).filter((entry) => entry.profile === 'automatic-explanation');
    const text = promptText(request);
    await page.locator('.cbm-chat-explanation .cbm-chat-response-source > summary').click();
    await wait(400);
    const disclosure = await page.locator('.cbm-chat-explanation .cbm-chat-source-content').innerText().catch(() => '');
    await shot(page, 'K14', 'explanation-source', 'The JSONBAgg explanation with its Source disclosure open: the class source (lines 50-54) is there and "Source unavailable" is gone.');
    const card = await explanationText(page);
    await save('K14', 'prompt-jsonbagg.txt', text);
    // Automatic explanations off: a listed answer reads the source itself, and "Ask the model" sends it (review finding).
    await open(page, PROJECT, 'galaxy');
    await galaxyReady(page);
    await loadModel(page);
    await setAutomatic(page, false);
    await openChat(page);
    await select(page, 'JSONBAgg');
    await scopeSettled(page);
    const offMark = await markWorker(page);
    await ask(page, 'Who calls JSONBAgg?');
    const automaticRuns = (await sentSince(page, offMark)).length;
    const turn = page.locator('.cbm-chat-turn').last();
    await turn.locator('.cbm-chat-response-source > summary').click();
    await wait(500);
    const listedSource = await turn.locator('.cbm-chat-source-content').innerText().catch(() => '');
    await shot(page, 'K14', 'listed-source-automatic-off', 'Automatic explanations off: the listed answer "Who calls JSONBAgg?" shows the class source in its Source disclosure, no "Source unavailable".');
    const askMark = await markWorker(page);
    await turn.getByRole('button', { name: 'Ask the model' }).click();
    await page.waitForFunction(() => !document.querySelector('.cbm-chat-send[aria-label="Stop"]') && !/Thinking…/.test(document.querySelector('.cbm-chat-turn:last-of-type')?.textContent ?? ''), null, { timeout: 240000 }).catch(() => {});
    await wait(800);
    const [asked] = await sentSince(page, askMark);
    const askedText = promptText(asked);
    const answer = await page.locator('.cbm-chat-turn').last().innerText().catch(() => '');
    await shot(page, 'K14', 'ask-model-with-source', 'After "Ask the model" on the listed answer: the model answered from a prompt that carries the class source.');
    await setAutomatic(page, true);
    await save('K14', 'prompt-ask-model.txt', askedText);
    check('K14', 'Galaxy explanation and a listed answer with automatic explanations off carry the selected symbol source; no "Source unavailable"', /class JSONBAgg\(OrderableAggMixin, Aggregate\)/.test(text) && /function = "JSONB_AGG"/.test(text)
        && !/Source unavailable/.test(text + disclosure) && /class JSONBAgg\(OrderableAggMixin, Aggregate\)/.test(disclosure)
        && automaticRuns === 0 && /class JSONBAgg\(OrderableAggMixin, Aggregate\)/.test(listedSource) && !/Source unavailable/.test(listedSource)
        && /function = "JSONB_AGG"/.test(askedText) && !/Source unavailable/.test(askedText),
    { sourceInPrompt: /class JSONBAgg/.test(text), sourceUnavailable: /Source unavailable/.test(text + disclosure), card,
        automaticOff: { modelMessagesForListedAnswer: automaticRuns, listedSourceStart: listedSource.slice(0, 260), askPromptHasSource: /function = "JSONB_AGG"/.test(askedText),
            askPromptSourceUnavailable: /Source unavailable/.test(askedText), answer: answer.replace(/\s+/g, ' ').slice(0, 260) } });
}

async function setTrace(page, direction, onlyType) {
    await page.locator('select[aria-label="Trace direction"]').selectOption(direction);
    await scopeSettled(page);
    if (onlyType) {
        const summary = page.locator('summary', { hasText: /^Edge types/ }).first();
        await summary.click();
        await wait(400);
        await page.getByRole('button', { name: `Only ${onlyType}`, exact: true }).click();
        await wait(400);
        await summary.click().catch(() => {});
        await scopeSettled(page);
    }
}

async function k7(page) {
    const outputs = [];
    // Galaxy, incoming and CALLS only: the case of the hand test at 17:20.
    await galaxyWithJsonb(page);
    await explanationDone(page);
    let mark = await markWorker(page), from = await now(page);
    await setTrace(page, 'inbound', 'CALLS');
    await explanationDone(page);
    let [request] = (await sentSince(page, mark)).filter((entry) => entry.profile === 'automatic-explanation');
    let card = await explanationText(page);
    outputs.push({ selection: 'JSONBAgg incoming CALLS', card, model: (await answersSince(page, from))[0]?.output, prompt: promptText(request) });
    await shot(page, 'K7', 'galaxy-incoming-calls', 'JSONBAgg, incoming, CALLS only: listed facts, at most one model sentence, no "list of integers / list of strings".');
    const galaxyOk = Boolean(request) && /Incoming relationships: 11 from 11 symbols \(CALLS 11\)/.test(card) && !/list of (?:integers|strings)|output is/i.test(card)
        && /Never state types, parameters, inputs, outputs/.test(promptText(request)) && /class JSONBAgg\(OrderableAggMixin, Aggregate\)/.test(promptText(request));
    // Architecture, Overview: the django area (hand test 17:53).
    await tab(page, 'architecture');
    await openChat(page);
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await wait(5000);
    await page.getByText(/Browse map/).first().click();
    await wait(600);
    mark = await markWorker(page); from = await now(page);
    await page.locator('button', { hasText: /^djangoarea/ }).first().click();
    await wait(1500);
    await explanationDone(page);
    [request] = (await sentSince(page, mark)).filter((entry) => entry.profile === 'automatic-explanation');
    card = await explanationText(page);
    outputs.push({ selection: 'Architecture overview django area', card, model: (await answersSince(page, from))[0]?.output, prompt: promptText(request) });
    await shot(page, 'K7', 'architecture-area', 'Architecture overview, django area: readable facts (files, lines, languages, hotspots, connections), no "Finding a line number" list.');
    // Without source the listed facts are the explanation; the model is not asked to guess.
    const areaOk = !request && /Selected source area: django/.test(card) && /Connections /.test(card) && !/Selected\.|members\[\d+\]|startLine|Finding a|Visible operations/.test(card)
        && /not generated by the model/.test(card);
    // Architecture, Behavior: main of manage.py-tpl.
    mark = await markWorker(page); from = await now(page);
    await page.getByRole('button', { name: 'Behavior' }).click();
    await wait(6000);
    await explanationDone(page);
    [request] = (await sentSince(page, mark)).filter((entry) => entry.profile === 'automatic-explanation');
    card = await explanationText(page);
    outputs.push({ selection: 'Architecture behavior', card, model: (await answersSince(page, from))[0]?.output, prompt: promptText(request) });
    await shot(page, 'K7', 'architecture-behavior', 'Architecture Behavior: the starting operation, its call sites with the functions they reach (os.environ.setdefault, execute_from_command_line), no invented operations.');
    const behaviorOk = /Starting operation: main/.test(card) && (!request || /def main\(\)/.test(promptText(request))) && !/Finding a|Visible operations/.test(card)
        && /line 9 calls os\.environ\.setdefault/.test(card) && /line 18 calls execute_from_command_line/.test(card);
    await save('K7', 'outputs.json', outputs);
    check('K7', 'Automatic explanations rest on listed facts (Galaxy incoming CALLS, Architecture area, Behavior)', galaxyOk && areaOk && behaviorOk,
        { galaxyOk, areaOk, behaviorOk, cards: outputs.map((item) => `${item.selection}: ${item.card.replace(/\s+/g, ' ').slice(0, 400)}`) });
}

async function k4(page) {
    const outputs = [];
    await galaxyWithJsonb(page);
    for (const name of ['JSONBAgg', 'BaseCommand']) {
        let mark = await markWorker(page), from = await now(page);
        if (name !== 'JSONBAgg') { await select(page, name); await scopeSettled(page); }
        for (let run = 0; run < RUNS; run++) {
            if (run === 0) await explanationDone(page); else { mark = await markWorker(page); from = await now(page); await clickExplainAgain(page); }
            const [request] = (await sentSince(page, mark)).filter((entry) => entry.profile === 'automatic-explanation');
            const [raw] = await answersSince(page, from);
            outputs.push({ name, run: run + 1, card: await explanationText(page), model: raw?.output, promptHasNumberedIds: /\[(?:graph|source)-\d+\]/.test(promptText(request)), modelCalled: Boolean(request) });
        }
        await shot(page, 'K4', `explanation-${name}`, `The automatic explanation of ${name} after ${RUNS} runs: no "Graph 1/2/3".`);
    }
    await save('K4', 'outputs.json', outputs);
    const echoes = outputs.filter((item) => /\bgraph[\s-]*\d\b/i.test(item.card));
    check('K4', `No "Graph 1/2/3" in ${outputs.length} real explanations of JSONBAgg and BaseCommand; prompt without [graph-N]`, echoes.length === 0 && outputs.every((item) => !item.promptHasNumberedIds),
        { runs: outputs.length, echoes: echoes.length, modelRuns: outputs.filter((item) => item.modelCalled).length, cards: outputs.map((item) => `${item.name}#${item.run}: ${item.card.replace(/\s+/g, ' ').slice(-220)}`) });
}

async function setOutputLimit(page, value) {
    await openConfig(page);
    const field = page.locator('#cbm-chat-output-tokens');
    await field.fill(String(value));
    await field.press('Enter');
    await wait(300);
    await closeConfig(page);
}

async function k1(page) {
    await galaxyWithJsonb(page);
    await explanationDone(page);
    await setOutputLimit(page, 48);
    await ask(page, 'Explain this class in detail, line by line.');
    const note = page.locator('.cbm-chat-turn').last().locator('details.cbm-chat-limit-note');
    const summary = await note.locator('summary').innerText().catch(() => '');
    await shot(page, 'K1', 'note-collapsed', 'Under the cut answer: "Token limit reached: the answer was cut short".');
    await note.locator('summary').click();
    await wait(400);
    const expanded = await note.innerText().catch(() => '');
    await shot(page, 'K1', 'note-expanded', 'The expanded note: the limits the answer ran into, Change the output limit, the larger models with download size.');
    await note.getByRole('button', { name: 'Change the output limit' }).click();
    await wait(700);
    const focus = await page.evaluate(() => ({ id: document.activeElement?.id ?? '', dialog: Boolean(document.querySelector('dialog.cbm-agent-settings[open]')) }));
    await shot(page, 'K1', 'config-output-focused', 'The button opens the agent configuration with the Output field focused.');
    await page.locator('#cbm-chat-output-tokens').fill('512');
    await page.locator('#cbm-chat-output-tokens').press('Enter');
    await closeConfig(page);
    check('K1', 'Cut answer explains the token limit, opens the configuration at Output and lists larger models', summary === 'Token limit reached: the answer was cut short'
        && /all 48 output tokens/.test(expanded) && /2,048 tokens/.test(expanded) && /Qwen3 0\.6B · 579 MB download/.test(expanded) && /LFM2\.5 1\.2B · 764 MB download/.test(expanded)
        && /Qwen3\.5 2B · 1\.40 GB download/.test(expanded) && focus.dialog && focus.id === 'cbm-chat-output-tokens', { summary, expanded, focus });
}

async function k12(page) {
    const outputs = [];
    await openWorkflowFile(page);
    await loadModel(page);
    await openChat(page);
    let mark = await markWorker(page);
    const from = await now(page);
    await explanationDone(page);
    const [automatic] = (await sentSince(page, mark)).filter((entry) => entry.profile === 'automatic-explanation');
    outputs.push({ kind: 'automatic', card: await explanationText(page), model: (await answersSince(page, from))[0]?.output, prompt: promptText(automatic) });
    await shot(page, 'K12', 'automatic', 'Explore with the workflow open: the automatic explanation lists name, trigger, the one job and the action, read from the file, above the model text.');
    const questions = ['was kannst du mir über dieses aktuelle File sagen', 'Wie viele Jobs gibt es in dieser Datei?', 'Welche Jobs gibt es in dieser Datei?', 'What does this file do?', 'How many jobs does this workflow have?'];
    const runs = Math.max(RUNS, questions.length);
    for (let run = 0; run < runs; run++) {
        mark = await markWorker(page);
        const answer = await ask(page, questions[run % questions.length]);
        const [request] = await sentSince(page, mark);
        outputs.push({ kind: 'question', run: run + 1, question: questions[run % questions.length], answer, prompt: promptText(request) });
        if (run === 0) await shot(page, 'K12', 'question-answer', 'The answer to "was kannst du mir über dieses aktuelle File sagen" for the YAML workflow.');
        if (run === 1) await shot(page, 'K12', 'jobs-count', 'The answer to "Wie viele Jobs gibt es in dieser Datei?": the prompt carries the counted facts (1 job: build).');
        await newConversation(page);
    }
    await save('K12', 'outputs.json', outputs);
    const asked = outputs.filter((item) => item.kind === 'question');
    // The open file is in the system section of the request, named as a workflow, with its counted facts, and its JSON record is gone.
    const fileInPrompt = asked.every((item) => /--- BEGIN EXACT SOURCE TEXT ---\nname: New contributor message/.test(item.prompt)
        && /The current file is a GitHub Actions workflow \(YAML configuration, not program code\)\./.test(item.prompt) && !/"status":"ready"/.test(item.prompt));
    const factsInPrompt = asked.every((item) => /Facts read from the file \(counted, not guessed\):/.test(item.prompt) && /1 job: `build`/.test(item.prompt))
        && /Facts read from the file \(counted, not guessed\):/.test(outputs[0].prompt);
    const card = outputs[0].card;
    const factsInCard = /1 job: build \("Hello new contributor", runs on ubuntu-latest, 1 step\)/.test(card) && /Trigger: pull_request_target \(types: opened\)/.test(card)
        && /Facts read from the file/.test(card);
    const invented = asked.filter((item) => /flake8|python|\bpip\b|\.py\b/i.test(item.answer));
    const counts = asked.filter((item) => /Wie viele|How many/.test(item.question)).map((item) => item.answer.replace(/^You\s+[^\n]*\n+Agent\s+(?:ⓘ Source\s+)?/, '').replace(/\s+/g, ' ').slice(0, 200));
    const wrongCount = counts.filter((answer) => /\b(?:[2-9]|zwei|drei|vier|two|three|four)\s+(?:jobs?|Jobs?)\b/i.test(answer));
    check('K12', 'The open YAML file and its counted facts are in the prompt and the card; answers invent no flake8/Python and no wrong job count', fileInPrompt && factsInPrompt && factsInCard
        && invented.length === 0 && wrongCount.length === 0,
    { fileInPrompt, factsInPrompt, factsInCard, invented: invented.length, wrongCount: wrongCount.length, counts, automatic: card.replace(/\s+/g, ' ').slice(0, 420),
        answers: asked.map((item) => `${item.question} => ${item.answer.replace(/\s+/g, ' ').slice(0, 260)}`) });
}

async function k10(page) {
    await open(page, PROJECT, 'galaxy');
    await galaxyReady(page);
    const loaded = await loadModel(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.atlas-shell');
    await wait(2500);
    const lampAfterReload = await agentLabel(page);
    await openConfig(page);
    await wait(800);
    const buttons = await page.locator('dialog.cbm-agent-settings .cbm-chat-model-actions button').allInnerTexts();
    const option = await page.locator('#cbm-chat-model option:checked').innerText().catch(() => '');
    const cache = await page.evaluate(async () => { const name = (await caches.keys()).find((key) => key.startsWith('cbm-browser-ai-qwen25')); return name ? (await (await caches.open(name)).keys()).length : 0; });
    await shot(page, 'K10', 'config-after-reload', 'After a reload the configuration says "Cached" and offers "Load model (cached, no download)".');
    // Optional automatic loading, off by default.
    const autoLoad = page.getByLabel('Load the chosen model on start when it is cached');
    const autoDefault = await autoLoad.isChecked().catch(() => null);
    await autoLoad.check();
    await closeConfig(page);
    const requestsBefore = modelRequests.length;
    const t0 = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.atlas-shell');
    await shot(page, 'K10', 'auto-load-0ms', 'Right after the reload with automatic loading on: the lamp is loading, no click.');
    const active = await agentActive(page, 120000);
    const seconds = (Date.now() - t0) / 1000;
    await shot(page, 'K10', 'auto-load-active', 'The agent is active again without any click.');
    const network = modelRequests.length - requestsBefore;
    await openConfig(page);
    await page.getByLabel('Load the chosen model on start when it is cached').uncheck();
    await closeConfig(page);
    check('K10', 'After reload: cached state shown, no download offered; optional automatic loading works (default off)', loaded && /Load model \(cached, no download\)/.test(buttons.join(' '))
        && !/Download & load/.test(buttons.join(' ')) && /Cached/.test(option) && autoDefault === false && active && network === 0,
    { lampAfterReload, buttons, option, cacheEntries: cache, autoDefault, autoLoadActiveAfterSeconds: active ? seconds : null, modelNetworkRequests: network });
}

async function k24(page) {
    await open(page, PROJECT, 'galaxy');
    await galaxyReady(page);
    const loaded = await loadModel(page);
    await shot(page, 'K24', 'before-switch', `${PROJECT} with the agent active (green lamp).`);
    const requestsBefore = modelRequests.length;
    await page.locator('.atlas-project-switcher summary').first().click();
    await page.locator('.atlas-project-picker button', { has: page.locator('.atlas-project-result-name', { hasText: new RegExp(`^${CONTROL}`) }) }).first().click();
    const t0 = Date.now();
    await page.waitForURL(new RegExp(`project=${CONTROL}`), { timeout: 30000 });
    await page.waitForSelector('.atlas-shell');
    const frames = [];
    for (const at of [0, 250, 1000, 3000]) {
        const delay = at - (Date.now() - t0);
        if (delay > 0) await wait(delay);
        frames.push({ at, label: await agentLabel(page), file: await shot(page, 'K24', `after-switch-${at}ms`, `${at} ms after the switch to ${CONTROL}: the agent lamp state.`) });
    }
    const active = await agentActive(page, 120000);
    const seconds = (Date.now() - t0) / 1000;
    await shot(page, 'K24', 'after-switch-active', `${CONTROL} with the agent active again, without a click.`);
    const project = await page.locator('.atlas-project-switcher summary').first().getAttribute('aria-label');
    // Back, so later runs start in the main project.
    await open(page, PROJECT, 'galaxy');
    const downloads = modelRequests.length - requestsBefore;
    check('K24', 'The agent stays loaded across a project switch (reloads from cache by itself)', loaded && active && /cbm/.test(project ?? '') && downloads === 0,
        { project, frames: frames.map(({ at, label }) => ({ at, label })), activeAfterSeconds: active ? seconds : null, modelRequests: downloads });
}

/* ------------------------------------------------------------------ */

const CHECKS = { K15: k15, K16: k16, K11: k11, K17: k17, K14: k14, K7: k7, K4: k4, K1: k1, K12: k12, K10: k10, K24: k24 };
await mkdir(OUT, { recursive: true });
const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false, viewport: VIEWPORT, deviceScaleFactor: 2, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});
await context.addInitScript(pageProbe);
// Model downloads, from the page or its workers: a cached load makes none.
context.on('request', (request) => { if (/huggingface\.co|hf\.co/.test(request.url())) modelRequests.push(request.url()); });
const page = context.pages()[0] ?? await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => { pageErrors.push(error.message); console.error(`[pageerror] ${error.message}`); });
for (const id of ALL.filter((item) => ONLY.includes(item))) {
    try {
        await freshHistory(page);
        await CHECKS[id](page);
    } catch (error) {
        check(id, 'aborted', false, String(error?.message ?? error).split('\n')[0]);
        await shot(page, id, 'aborted', 'State when the check aborted.').catch(() => {});
    }
    const list = images.get(id) ?? [];
    const result = results.filter((item) => item.id === id);
    await save(id, 'index.md', [`# ${id}`, '', ...result.map((item) => `${item.pass ? 'PASS' : 'FAIL'} - ${item.title}\n\n\`\`\`json\n${JSON.stringify(item.measured, null, 2)}\n\`\`\``), '',
        '| Image | What it shows |', '|---|---|', ...list.map((item) => `| [${item.file}](${item.file}) | ${item.proves} |`), ''].join('\n'));
}
await context.close();
await writeFile(join(OUT, 'report.json'), JSON.stringify({ origin: ORIGIN, project: PROJECT, results, pageErrors }, null, 2));
const passed = results.filter((item) => item.pass).length;
console.log(`${passed}/${results.length} passed${pageErrors.length ? `; ${pageErrors.length} page errors` : ''}`);
if (passed !== results.length) process.exitCode = 1;
