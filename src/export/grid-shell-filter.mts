import type { MeshData } from "./export.mjs"

const VERTEX_STRIDE_F32 = 8

function coord(verts: Float32Array, vertexIndex: number, axis: 0 | 1 | 2): number {
    return verts[vertexIndex * VERTEX_STRIDE_F32 + axis]!
}

function allOnPlane(verts: Float32Array, i0: number, i1: number, i2: number, axis: 0 | 1 | 2, plane: number, eps: number): boolean {
    return (
        Math.abs(coord(verts, i0, axis) - plane) <= eps &&
        Math.abs(coord(verts, i1, axis) - plane) <= eps &&
        Math.abs(coord(verts, i2, axis) - plane) <= eps
    )
}

/** Remove triangles that lie exactly on the scalar sampling box faces. */
export function stripSamplingGridShellTriangles(
    mesh: MeshData,
    gridOffsetX: number,
    gridOffsetY: number,
    gridOffsetZ: number,
    gridDimX: number,
    gridDimY: number,
    gridDimZ: number,
    voxelSize: number,
): MeshData {
    const { verts, tris } = mesh
    if (tris.length === 0) return mesh

    const minX = gridOffsetX
    const minY = gridOffsetY
    const minZ = gridOffsetZ
    const maxX = gridOffsetX + (gridDimX - 1) * voxelSize
    const maxY = gridOffsetY + (gridDimY - 1) * voxelSize
    const maxZ = gridOffsetZ + (gridDimZ - 1) * voxelSize
    const eps = Math.max(1e-6, Math.abs(voxelSize) * 1e-4)

    const kept: number[] = []
    for (let t = 0; t < tris.length; t += 3) {
        const i0 = tris[t]!
        const i1 = tris[t + 1]!
        const i2 = tris[t + 2]!
        const onShell =
            allOnPlane(verts, i0, i1, i2, 0, minX, eps) ||
            allOnPlane(verts, i0, i1, i2, 0, maxX, eps) ||
            allOnPlane(verts, i0, i1, i2, 1, minY, eps) ||
            allOnPlane(verts, i0, i1, i2, 1, maxY, eps) ||
            allOnPlane(verts, i0, i1, i2, 2, minZ, eps) ||
            allOnPlane(verts, i0, i1, i2, 2, maxZ, eps)
        if (!onShell) kept.push(i0, i1, i2)
    }

    return { verts, tris: new Uint32Array(kept) }
}
