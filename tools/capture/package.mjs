#!/usr/bin/env node
/** Deterministic local adapter downloads. Uses only curated, existing files. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const groups = [
    { profiles: ['python'], directory: 'python', archive: 'python.zip', files: ['cbm_capture_python.py'] },
    { profiles: ['node', 'browser'], directory: 'javascript', archive: 'javascript.zip',
        files: ['instrument.mjs', 'runtime.mjs', 'register.mjs', 'loader.mjs', 'browser.mjs'], typescript: true },
    { profiles: ['go'], directory: 'go', archive: 'go.zip',
        files: ['go.mod', 'main.go', 'overlay.go', 'runtime.go.txt', 'README.md'] },
    { profiles: ['dotnet'], directory: 'dotnet', archive: 'dotnet.zip',
        files: ['CaptureTool.csproj', 'Program.cs', 'Runtime.cs', 'NuGet.Config'] },
    { profiles: ['jvm'], directory: 'jvm', archive: 'jvm.zip',
        files: ['build.py', 'src/cbm/capture/Agent.java', 'src/cbm/capture/Probe.java', 'JVM-README.md',
            'vendor/asm-9.9.jar', 'vendor/asm-tree-9.9.jar', 'vendor/asm-commons-9.9.jar', 'vendor/ASM-LICENSE.txt', 'vendor/NOTICE.json'] },
    { profiles: ['rust'], directory: 'rust', archive: 'rust.zip',
        files: ['cbm_capture_rust.py', 'instrument.rs', 'runtime.rs', 'Cargo.toml', 'README.md', 'vendor/manifest.json'], manifest: 'rust' },
    { profiles: ['php'], directory: 'php', archive: 'php.zip',
        files: ['overlay.php', 'Instrumenter.php', 'Runtime.php', 'README.md', 'vendor/php-parser/PROVENANCE.json'], manifest: 'php' },
    { profiles: ['native'], directory: 'native', archive: 'native.zip',
        files: ['instrument.py', 'build.py', 'launch.py', 'runtime.h.txt', 'runtime.c.txt', 'README.md'] },
];
const crcTable = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}
function zip(entries) {
    const files = [], directory = [];
    let offset = 0;
    for (const [name, bytes] of [...entries].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
        if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid bundle filename');
        const filename = Buffer.from(name), compressed = deflateRawSync(bytes), crc = crc32(bytes);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
        local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
        files.push(local, filename, compressed);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14);
        central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24);
        central.writeUInt16LE(filename.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
        directory.push(central, filename);
        offset += local.length + filename.length + compressed.length;
    }
    const central = Buffer.concat(directory), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...files, central, end]);
}
async function regular(path) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Adapter source must be a regular file: ${path}`);
    if (info.size > 16 * 1024 * 1024) throw new Error(`Adapter source exceeds packaging budget: ${path}`);
    return readFile(path);
}
async function curated(directory, relative) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..'))
        throw new Error('Invalid curated source path');
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index++) {
        const info = await lstat(join(directory, ...parts.slice(0, index)));
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Curated source parent cannot be a symlink');
    }
    return regular(join(directory, relative));
}
async function exists(path) {
    try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function atomic(path, content) {
    const temp = path + '.tmp';
    await writeFile(temp, content, { mode: 0o644 });
    await rename(temp, path);
}
export async function packageAdapters({ sourceRoot = here, outputDir = resolve(here, '../../graph-ui/public/capture-adapters'),
    licensePath = resolve(here, '../../LICENSE'), typescriptRoot = resolve(here, '../../graph-ui/node_modules/typescript') } = {}) {
    await mkdir(outputDir, { recursive: true });
    const info = await lstat(outputDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Adapter output must be a real directory');
    const common = [['LICENSE', await regular(licensePath)], ['README.md', await regular(join(sourceRoot, 'README.md'))]];
    const adapters = [];
    for (const group of groups) {
        const files = group.files.map(file => join(sourceRoot, group.directory, file));
        if (!(await Promise.all(files.map(exists))).every(Boolean)) {
            if (await exists(join(outputDir, group.archive))) await unlink(join(outputDir, group.archive));
            continue;
        }
        const directory = await lstat(join(sourceRoot, group.directory));
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Adapter directory cannot be a symlink');
        const entries = [...common];
        const sourceDirectory = join(sourceRoot, group.directory);
        for (const file of group.files) entries.push([file === 'README.md' ? 'ADAPTER.md' : file, await curated(sourceDirectory, file)]);
        if (group.manifest) {
            let pinned;
            if (group.manifest === 'php') {
                const metadata = JSON.parse(await curated(sourceDirectory, 'vendor/php-parser/PROVENANCE.json'));
                pinned = Object.entries(metadata.files ?? {}).map(([path, sha256]) => ({ path: `vendor/php-parser/${path}`, sha256 }));
            } else {
                const metadata = JSON.parse(await curated(sourceDirectory, 'vendor/manifest.json'));
                pinned = metadata.packages.flatMap(pkg => pkg.files.map(file => ({ ...file, path: `vendor/${file.path}` })));
            }
            if (!pinned.length || pinned.length > 1000) throw new Error('Invalid vendor manifest size');
            for (const file of pinned) {
                const bytes = await curated(sourceDirectory, file.path);
                if (!/^[a-f0-9]{64}$/.test(file.sha256) || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
                    throw new Error(`Vendor source checksum mismatch: ${file.path}`);
                entries.push([file.path, bytes]);
            }
        }
        if (group.typescript) {
            entries.push(['vendor/typescript.cjs', await regular(join(typescriptRoot, 'lib/typescript.js'))]);
            entries.push(['vendor/TYPESCRIPT-LICENSE.txt', await regular(join(typescriptRoot, 'LICENSE.txt'))]);
            entries.push(['vendor/TYPESCRIPT-NOTICES.txt', await regular(join(typescriptRoot, 'ThirdPartyNoticeText.txt'))]);
        }
        if (entries.reduce((sum, [, bytes]) => sum + bytes.length, 0) > 32 * 1024 * 1024) throw new Error('Adapter archive exceeds packaging budget');
        const archive = zip(entries);
        await atomic(join(outputDir, group.archive), archive);
        const sha256 = createHash('sha256').update(archive).digest('hex');
        for (const profile of group.profiles) adapters.push({ profile, archive: `/capture-adapters/${group.archive}`, sha256, size: archive.length });
    }
    const manifest = { schema_version: 1, adapters };
    await atomic(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    const args = process.argv.slice(2);
    if (args.length && (args[0] !== '--out' || args.length !== 2)) throw new Error('Usage: node tools/capture/package.mjs [--out DIRECTORY]');
    await packageAdapters(args.length ? { outputDir: resolve(args[1]) } : {});
}
