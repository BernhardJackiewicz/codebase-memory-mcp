/** Screen space in canvas pixels. */
export interface LabelRect { left: number; right: number; top: number; bottom: number }
/** A label laid out in the DOM: its size, and the padding plus border between its edge and its text. */
export interface LabelBox { width: number; height: number; edgeX: number; edgeY: number }

/** The padding plus border of a laid-out label on its thinner side, per axis. */
export function labelEdges(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): [number, number] {
    const side = (name: string) => (parseFloat(style.getPropertyValue(`padding-${name}`)) || 0)
        + (parseFloat(style.getPropertyValue(`border-${name}-width`)) || 0);
    return [Math.min(side('left'), side('right')), Math.min(side('top'), side('bottom'))];
}

/**
 * How far a measured label may reach under a neighbour: half of the thinnest
 * padding plus border among the labels, so two neighbours together never
 * reach the text of either.
 */
export function labelInset(boxes: Iterable<LabelBox>): [number, number] {
    let x = Infinity, y = Infinity;
    for (const box of boxes) { x = Math.min(x, box.edgeX); y = Math.min(y, box.edgeY); }
    return [Number.isFinite(x) ? x / 2 : 0, Number.isFinite(y) ? y / 2 : 0];
}

/** The space a label centred at (x, y) claims; a negative inset keeps a margin around an estimate. */
export function labelRect(x: number, y: number, width: number, height: number, [insetX, insetY]: [number, number]): LabelRect {
    return { left: x - width / 2 + insetX, right: x + width / 2 - insetX, top: y - height / 2 + insetY, bottom: y + height / 2 - insetY };
}

export const labelsCollide = (a: LabelRect, b: LabelRect): boolean =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
