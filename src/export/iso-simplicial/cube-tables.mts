/**
 * Cube topology tables from docs/reference_impl/isosurf/isosurf/cube_arrays.cpp / cube_arrays.h.
 *
 * Corner indexing matches reference `Index`: bit0 = x, bit1 = y, bit2 = z
 * → vertex i at (i & 1, (i >> 1) & 1, (i >> 2) & 1) in unit-cell coordinates.
 */

/** 12 undirected edges: endpoints are cube corner indices 0..7. */
export const cubeEdge2Vert: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
    [4, 5],
    [4, 6],
    [5, 7],
    [6, 7],
] as const

/** Per-edge dominant axis: 0 = x, 1 = y, 2 = z (see cube_edge2orient in reference). */
export const cubeEdge2Orient: ReadonlyArray<number> = [0, 1, 1, 0, 2, 2, 2, 2, 0, 1, 1, 0] as const

/** Six faces as four corner indices each (counter-clockwise in reference layout). */
export const cubeFace2Vert: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 1, 3, 2],
    [0, 4, 5, 1],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
    [2, 3, 7, 6],
    [4, 6, 7, 5],
] as const

/** For each face, the four bounding edge indices (see cube_face2edge). */
export const cubeFace2Edge: ReadonlyArray<readonly [number, number, number, number]> = [
    [1, 0, 2, 3],
    [0, 4, 8, 5],
    [4, 1, 6, 9],
    [2, 5, 10, 7],
    [6, 3, 7, 11],
    [8, 9, 11, 10],
] as const

/** Per-face dominant normal axis (0=x, 1=y, 2=z). */
export const cubeFace2Orient: ReadonlyArray<number> = [2, 1, 0, 0, 1, 2] as const

/** Opposite face index for each face. */
export const cubeFace2Opposite: ReadonlyArray<number> = [5, 4, 3, 2, 1, 0] as const

/** For axis orient 0,1,2: the two face indices whose normals align with that axis (±). */
export const cubeOrient2Face: ReadonlyArray<readonly [number, number]> = [
    [2, 3],
    [1, 4],
    [0, 5],
] as const

/** For axis orient 0,1,2: the four edge indices parallel to that axis. */
export const cubeOrient2Edge: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 3, 8, 11],
    [1, 2, 9, 10],
    [4, 5, 6, 7],
] as const

/** Reference `Index`: x + 2*y + 4*z as corner index 0..7. */
export function cubeCornerIndex(x: 0 | 1, y: 0 | 1, z: 0 | 1): number {
    return x | (y << 1) | (z << 2)
}

/** Inverse of cubeCornerIndex: unpack bits to (x,y,z). */
export function cubeCornerBits(i: number): readonly [0 | 1, 0 | 1, 0 | 1] {
    return [(i & 1) as 0 | 1, ((i >> 1) & 1) as 0 | 1, ((i >> 2) & 1) as 0 | 1]
}
