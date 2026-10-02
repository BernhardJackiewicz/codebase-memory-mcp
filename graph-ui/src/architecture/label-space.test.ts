import { describe, expect, it } from 'vitest';
import { labelEdges, labelInset, labelRect, labelsCollide, type LabelBox } from './label-space';

// The compact Overview and Endpoints label: padding 5px 7px and a 1px border (spatial-architecture.css).
const compact: LabelBox = { width: 100, height: 24, edgeX: 8, edgeY: 6 };
const style = (values: Record<string, string>) => ({ getPropertyValue: (name: string) => values[name] ?? '' });

describe('label space', () => {
    it('reads padding plus border on the thinner side of each axis', () => {
        expect(labelEdges(style({ 'padding-left': '7px', 'padding-right': '9px', 'border-left-width': '1px', 'border-right-width': '1px',
            'padding-top': '5px', 'padding-bottom': '5px', 'border-top-width': '1px', 'border-bottom-width': '0px' }))).toEqual([8, 5]);
        expect(labelEdges(style({}))).toEqual([0, 0]);
    });
    it('lets two neighbours share their padding but never reach into either text', () => {
        const inset = labelInset([compact, compact]);
        expect(inset).toEqual([4, 3]);
        const left = labelRect(100, 50, compact.width, compact.height, inset);
        // The boxes overlap by exactly one label's padding plus border: the neighbour's edge stops where the text begins.
        const touching = labelRect(100 + compact.width - compact.edgeX, 50, compact.width, compact.height, inset);
        expect(labelsCollide(left, touching)).toBe(false);
        expect(labelsCollide(left, labelRect(100 + compact.width - compact.edgeX - 1, 50, compact.width, compact.height, inset))).toBe(true);
        const below = labelRect(100, 50 + compact.height - compact.edgeY, compact.width, compact.height, inset);
        expect(labelsCollide(left, below)).toBe(false);
        expect(labelsCollide(left, labelRect(100, 50 + compact.height - compact.edgeY - 1, compact.width, compact.height, inset))).toBe(true);
    });
    it('takes the thinnest padding when labels differ and keeps a margin around an estimate', () => {
        expect(labelInset([compact, { width: 145, height: 30, edgeX: 13, edgeY: 8 }])).toEqual([4, 3]);
        expect(labelInset([])).toEqual([0, 0]);
        expect(labelRect(100, 50, 80, 38, [-5, 0])).toEqual({ left: 55, right: 145, top: 31, bottom: 69 });
    });
});
