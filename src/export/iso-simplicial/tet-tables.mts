/**
 * Marching tetrahedra tables from docs/reference_impl/isosurf/isosurf/tet_arrays.cpp / tet_arrays.h.
 *
 * Tet corners follow reference tet_edge2vert: standard subdivision of a cube tet.
 * `tetTris[caseId]` lists triangle corner indices into the six tet corners (0..5), -1 unused.
 * `tetTriStrips` mirrors the reference strip table (first element is strip count / sentinel per reference).
 */

export const tetEdge2Vert: ReadonlyArray<readonly [number, number]> = [
    [0, 2],
    [2, 1],
    [0, 1],
    [2, 3],
    [0, 3],
    [1, 3],
] as const

export const tetTrisNum: ReadonlyArray<number> = [0, 1, 1, 2, 1, 2, 2, 1, 1, 2, 2, 1, 2, 1, 1, 0] as const

/** Reference tet_triStrips[16][5]. */
export const tetTriStrips: ReadonlyArray<readonly number[]> = [
    [0, -1, -1, -1, -1],
    [3, 0, 2, 4, -1],
    [3, 2, 1, 5, -1],
    [4, 0, 1, 4, 5],

    [3, 1, 0, 3, -1],
    [4, 3, 1, 4, 2],
    [4, 0, 3, 2, 5],
    [3, 3, 5, 4, -1],

    [3, 3, 4, 5, -1],
    [4, 0, 2, 3, 5],
    [4, 3, 4, 1, 2],
    [3, 1, 3, 0, -1],

    [4, 0, 4, 1, 5],
    [3, 2, 5, 1, -1],
    [3, 0, 4, 2, -1],
    [0, -1, -1, -1, -1],
] as const

/** Reference tet_tris[16][7]; pad to length 7 with -1. */
export const tetTris: ReadonlyArray<readonly number[]> = [
    [-1, -1, -1, -1, -1, -1, -1],
    [0, 2, 4, -1, -1, -1, -1],
    [2, 1, 5, -1, -1, -1, -1],
    [0, 1, 4, 4, 1, 5, -1],

    [1, 0, 3, -1, -1, -1, -1],
    [3, 1, 4, 4, 1, 2, -1],
    [0, 3, 2, 2, 3, 5, -1],
    [3, 5, 4, -1, -1, -1, -1],

    [3, 4, 5, -1, -1, -1, -1],
    [0, 2, 3, 3, 2, 5, -1],
    [3, 4, 1, 1, 4, 2, -1],
    [1, 3, 0, -1, -1, -1, -1],

    [0, 4, 1, 1, 4, 5, -1],
    [2, 5, 1, -1, -1, -1, -1],
    [0, 4, 2, -1, -1, -1, -1],
    [-1, -1, -1, -1, -1, -1, -1],
] as const
