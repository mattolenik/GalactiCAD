/**
 * Static tables from VisitorExtract::on_edge in
 * docs/reference_impl/isosurf/isosurf/visitorextract.cpp.
 *
 * `orient` matches `traverse_*` edge orientation passed to `on_edge` (0 = x-edge, 1 = y, 2 = z).
 * Index `i` is the quadrant index 0..3 from the four leaf nodes around the edge.
 */

/** [orient][i^3][0|1] → cube face index for averaging / opposite lookup. */
export const extractFaceTable: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
    [
        [1, 0],
        [4, 0],
        [1, 5],
        [4, 5],
    ],
    [
        [2, 0],
        [3, 0],
        [2, 5],
        [3, 5],
    ],
    [
        [2, 1],
        [3, 1],
        [2, 4],
        [3, 4],
    ],
] as const

/** Whether to swap (node, face) vs (face, node) when building tet corners p[2],p[3]. */
export const extractFlipTable: ReadonlyArray<readonly boolean[]> = [
    [true, false, false, true],
    [false, true, true, false],
    [true, false, false, true],
] as const

/** Matches traverse.h TraversalType ordering (for explicit TS port of recursion). */
export enum TraversalType {
    trav_node = 0,
    trav_face = 1,
    trav_edge = 2,
    trav_vert = 3,
}
