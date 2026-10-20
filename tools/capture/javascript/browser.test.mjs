import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startBrowserOverlay } from './browser.mjs';

const require = createRequire(new URL('../../../graph-ui/package.json', import.meta.url));
const { chromium } = require('playwright');

it('preserves real browser document mode, head attributes and layout while inserting bootstrap before app modules', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cbm-browser-doctype-'));
    const body = '<body><div id="box" style="width:100px;padding:10px;border:5px solid"></div>'
        + '<script id="application" type="module" src="/app.mjs"></script></body>';
    const fixtures = [
        '<!DOCTYPE html><html lang="en"><head id="original" data-mark="a>b"><title>Review</title></head>' + body + '</html>',
        '\uFEFF \n<!-- <head data-fake="yes"> -->\n<!dOcTyPe html>\n<html lang="de"><head id="original"><title>Review</title></head>' + body + '</html>',
        '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><html><head id="original"><title>Review</title></head>' + body + '</html>',
        '<!DOCTYPE html><html lang="fr"><title>Implicit head</title>' + body + '</html>',
        '<html lang="en"><head id="original"><title>Intentional quirks</title></head>' + body + '</html>',
    ];
    const application = 'window.applicationReady=true;';
    for (let i = 0; i < fixtures.length; i++) await writeFile(path.join(root, `${i}.html`), fixtures[i]);
    await writeFile(path.join(root, 'app.mjs'), application);
    const original = createServer((request, response) => {
        const index = /^\/(\d+)\.html$/.exec(request.url);
        if (index && fixtures[Number(index[1])] !== undefined)
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fixtures[Number(index[1])]);
        else if (request.url === '/app.mjs')
            response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(application);
        else response.writeHead(404).end();
    });
    await new Promise(resolve => original.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${original.address().port}`;
    const overlay = await startBrowserOverlay({ root, endpoint: `${origin}/v1/cbm/lineage?session=test`,
        token: 'local-test-only', port: 0 });
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        for (let i = 0; i < fixtures.length; i++) {
            const snapshot = async url => {
                await page.goto(url);
                await page.waitForFunction(() => window.applicationReady === true);
                return page.evaluate(() => ({
                    mode: document.compatMode, headId: document.head.id,
                    headMark: document.head.getAttribute('data-mark'), language: document.documentElement.lang,
                    title: document.title, width: document.getElementById('box').getBoundingClientRect().width,
                    doctype: document.doctype && [document.doctype.name, document.doctype.publicId, document.doctype.systemId],
                }));
            };
            const expected = await snapshot(`${origin}/${i}.html`);
            const actual = await snapshot(`${overlay.origin}/${i}.html`);
            assert.deepEqual(actual, expected, `Document ${i} changed browser parsing/layout semantics`);
            assert.equal(await page.evaluate(() => {
                const bootstrap = document.querySelector('script[src="/__cbm_capture/bootstrap.mjs"]');
                const application = document.getElementById('application');
                return bootstrap?.parentElement === document.head
                    && Boolean(bootstrap.compareDocumentPosition(application) & Node.DOCUMENT_POSITION_FOLLOWING);
            }), true);
            assert.equal(await readFile(path.join(root, `${i}.html`), 'utf8'), fixtures[i]);
        }
    } finally {
        await browser.close();
        await overlay.close();
        await new Promise(resolve => original.close(resolve));
        await rm(root, { recursive: true, force: true });
    }
});
