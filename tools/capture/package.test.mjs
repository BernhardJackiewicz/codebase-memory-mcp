import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { packageAdapters } from './package.mjs';

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'cbm-adapter-package-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'sources/python'), { recursive: true });
    await writeFile(join(root, 'sources/python/cbm_capture_python.py'), 'print("fixture")\n');
    await writeFile(join(root, 'sources/python/private.env'), 'never package this');
    await writeFile(join(root, 'sources/README.md'), 'Adapter instructions\n');
    await writeFile(join(root, 'LICENSE'), 'Fixture license\n');
    return { root, sourceRoot: join(root, 'sources'), outputDir: join(root, 'output'), licensePath: join(root, 'LICENSE') };
}

test('download bundle is deterministic, portable ZIP and contains only curated sources', async t => {
    const options = await fixture(t);
    const manifest = await packageAdapters(options);
    assert.equal(manifest.schema_version, 1);
    assert.deepEqual(manifest.adapters.map(item => item.profile), ['python']);
    const first = await readFile(join(options.outputDir, 'python.zip'));
    assert.match(manifest.adapters[0].sha256, /^[0-9a-f]{64}$/);
    await packageAdapters(options);
    assert.deepEqual(await readFile(join(options.outputDir, 'python.zip')), first);
    const listing = execFileSync('unzip', ['-Z1', join(options.outputDir, 'python.zip')], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(listing.sort(), ['LICENSE', 'README.md', 'cbm_capture_python.py']);
    assert.match(execFileSync('unzip', ['-t', join(options.outputDir, 'python.zip')], { encoding: 'utf8' }), /No errors detected/);
    assert.equal(await readFile(join(options.outputDir, 'manifest.json'), 'utf8'), JSON.stringify(manifest, null, 2) + '\n');
});

test('packager rejects symlinked sources rather than reading outside the source tree', async t => {
    const options = await fixture(t);
    await rm(join(options.sourceRoot, 'python/cbm_capture_python.py'));
    await writeFile(join(options.root, 'outside.py'), 'private material');
    await symlink(join(options.root, 'outside.py'), join(options.sourceRoot, 'python/cbm_capture_python.py'));
    await assert.rejects(packageAdapters(options), /symlink|regular file/i);
});

test('partial adapters are not offered as downloadable working profiles', async t => {
    const options = await fixture(t);
    await mkdir(join(options.sourceRoot, 'javascript'));
    await writeFile(join(options.sourceRoot, 'javascript/runtime.mjs'), '// incomplete adapter');
    const manifest = await packageAdapters(options);
    assert.deepEqual(manifest.adapters.map(item => item.profile), ['python']);
    assert.deepEqual((await readdir(options.outputDir)).sort(), ['manifest.json', 'python.zip']);
});

test('portable PHP archive includes only hash-pinned parser sources and rejects tampering', async t => {
    const options = await fixture(t);
    const directory = join(options.sourceRoot, 'php');
    await mkdir(join(directory, 'vendor/php-parser/lib'), { recursive: true });
    for (const file of ['overlay.php', 'Instrumenter.php', 'Runtime.php', 'README.md'])
        await writeFile(join(directory, file), 'fixture');
    const source = '<?php // pinned parser';
    const { createHash } = await import('node:crypto');
    await writeFile(join(directory, 'vendor/php-parser/lib/Parser.php'), source);
    await writeFile(join(directory, 'vendor/php-parser/private.env'), 'excluded');
    await writeFile(join(directory, 'vendor/php-parser/PROVENANCE.json'), JSON.stringify({
        files: { 'lib/Parser.php': createHash('sha256').update(source).digest('hex') },
    }));
    const manifest = await packageAdapters(options);
    assert.ok(manifest.adapters.some(item => item.profile === 'php'));
    const listing = execFileSync('unzip', ['-Z1', join(options.outputDir, 'php.zip')], { encoding: 'utf8' });
    assert.match(listing, /vendor\/php-parser\/lib\/Parser.php/);
    assert.match(listing, /ADAPTER.md/);
    assert.doesNotMatch(listing, /private.env/);
    await writeFile(join(directory, 'vendor/php-parser/lib/Parser.php'), 'changed');
    await assert.rejects(packageAdapters(options), /checksum/i);
});
