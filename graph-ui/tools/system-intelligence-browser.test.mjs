import { describe, expect, it } from 'vitest';
import { isolatedEnvironment, parseBrowserOptions, geometryChanged } from './system-intelligence-browser.mjs';

describe('system intelligence browser acceptance isolation', () => {
    it('keeps the real home and replaces both daemon namespaces without changing caller environment', () => {
        const caller = { HOME: '/Users/person', PATH: '/bin', CBM_CACHE_DIR: '/live/cache', CBM_RUNTIME_DIR: '/live/runtime' };
        const isolated = isolatedEnvironment(caller, '/private/tmp/cbm-proof');
        expect(isolated.HOME).toBe('/Users/person');
        expect(isolated.CBM_CACHE_DIR).toBe('/private/tmp/cbm-proof/cache');
        expect(isolated.CBM_RUNTIME_DIR).toBe('/private/tmp/cbm-proof/runtime');
        expect(isolated.CBM_ALLOWED_ROOT).toBe('/private/tmp/cbm-proof');
        expect(caller.CBM_CACHE_DIR).toBe('/live/cache');
    });
    it('defaults to a visible browser and accepts explicit binary and asset paths', () => {
        const result = parseBrowserOptions(['--binary', '/tmp/new-cbm', '--dist', '/tmp/new-dist', '--out', '/tmp/evidence']);
        expect(result.headless).toBe(false);
        expect(result.binary).toBe('/tmp/new-cbm');
        expect(result.dist).toBe('/tmp/new-dist');
        expect(result.out).toBe('/tmp/evidence');
        expect(result.only).toEqual(['docs', 'system', 'regression']);
        expect(parseBrowserOptions(['--only', 'capture']).only).toEqual(['capture']);
        expect(parseBrowserOptions(['--only', 'field,capture']).only).toEqual(['field', 'capture']);
        expect(parseBrowserOptions(['--only', 'runtime']).only).toEqual(['runtime']);
        expect(parseBrowserOptions(['--only', 'adapters']).only).toEqual(['adapters']);
        expect(() => parseBrowserOptions(['--binary'])).toThrow(/value/i);
        expect(() => parseBrowserOptions(['--origin', 'http://production'])).toThrow(/unknown/i);
    });
    it('requires actual matching label movement rather than a changed screenshot or missing label', () => {
        const before = [{ id: 'node', x: 10, y: 20, width: 90, height: 30 }];
        expect(geometryChanged(before, [{ ...before[0], x: 28 }])).toBe(true);
        expect(geometryChanged(before, [{ ...before[0] }])).toBe(false);
        expect(geometryChanged(before, [])).toBe(false);
        expect(geometryChanged(before, [{ ...before[0], id: 'unrelated', x: 28 }])).toBe(false);
    });
});
