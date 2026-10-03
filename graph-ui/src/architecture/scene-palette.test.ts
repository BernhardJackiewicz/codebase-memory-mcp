import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCENE_PALETTE, scenePaletteStyle } from './scene-palette';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, name), 'utf8');
/** Every file that draws or styles an Architecture scene: Overview, Routes, Hotspots, System structure, Behavior. */
const SCENE_FILES = ['ArchitectureScene.tsx', 'SystemArchitectureScene.tsx', 'architecture-scene.css', 'spatial-architecture.css',
    'system-architecture.css', 'behavior-journey.css', 'container-map.css'];
/** The blue-grey scheme System structure and Behavior had next to the green Overview (Korrekturplan K19). */
const BLUE_GREY = ['#0b1118', '#1c3440', '#15242e', '#536977', '#6e8a98', '#91a6b4', '#27333e', '#0e1925', '#111923', '#14212e',
    '#101820', '#0b1219', '#080f17', '#0b1525', '#12252d', '#080f14', '#101b23', '#638db3', '#719ec5', '#8ca5bc', '#9bb5ca', '#b6c7d5'];
const rgb = (hex: string) => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));

describe('architecture scene palette', () => {
    it('leaves no blue-grey scene colour in any Architecture scene', () => {
        const found = SCENE_FILES.flatMap(name => BLUE_GREY.filter(color => read(name).toLowerCase().includes(color)).map(color => `${name}: ${color}`));
        expect(found).toEqual([]);
    });
    it('draws every scene surface in the green of the IDE', () => {
        for (const key of ['background', 'gridMajor', 'gridMinor', 'plate', 'plateEdge', 'body', 'node', 'panel', 'panelRaised', 'line', 'label', 'labelBorder', 'labelSelected', 'code'] as const) {
            const [red, green, blue] = rgb(SCENE_PALETTE[key]);
            expect(green, key).toBeGreaterThanOrEqual(blue);
            expect(green, key).toBeGreaterThanOrEqual(red);
        }
    });
    it('hands the same values to the DOM labels as CSS variables, so there is one table', () => {
        const style = scenePaletteStyle() as Record<string, string>;
        expect(style['--arch-background']).toBe(SCENE_PALETTE.background);
        expect(style['--arch-label-border']).toBe(SCENE_PALETTE.labelBorder);
        expect(Object.keys(style)).toHaveLength(Object.keys(SCENE_PALETTE).length);
    });
    it('uses the palette in both WebGL scenes and the variables in every scene stylesheet', () => {
        for (const name of ['ArchitectureScene.tsx', 'SystemArchitectureScene.tsx']) expect(read(name), name).toContain('SCENE_PALETTE.background');
        for (const name of ['architecture-scene.css', 'spatial-architecture.css', 'system-architecture.css', 'behavior-journey.css', 'container-map.css']) {
            expect(read(name), name).toContain('var(--arch-');
        }
    });
});
