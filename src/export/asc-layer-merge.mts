/** One ASC layer-sweep contribution (positions/normals global within this chunk; triangle indices are local to chunk verts). */
export interface AscLayerSweepMeshChunk {
    positions: number[]
    normals: number[]
    indices: number[]
}

/** Merge triangle chunks in order; rewrites triangle indices with running vertex offset (prefix sum). */
export function mergeAscLayerSweepChunks(parts: readonly AscLayerSweepMeshChunk[]): AscLayerSweepMeshChunk {
    if (parts.length === 0) return { positions: [], normals: [], indices: [] }
    if (parts.length === 1) {
        const p = parts[0]!
        return {
            positions: p.positions.slice(),
            normals: p.normals.slice(),
            indices: p.indices.slice(),
        }
    }
    let vertBase = 0
    const positions: number[] = []
    const normals: number[] = []
    const indices: number[] = []
    for (const p of parts) {
        const nvv = (p.positions.length / 3) | 0
        for (let x = 0; x < p.positions.length; x++) positions.push(p.positions[x]!)
        for (let x = 0; x < p.normals.length; x++) normals.push(p.normals[x]!)
        for (let x = 0; x < p.indices.length; x++) indices.push(p.indices[x]! + vertBase)
        vertBase += nvv
    }
    return { positions, normals, indices }
}

export function appendMergedChunksToOut(out: AscLayerSweepMeshChunk, parts: readonly AscLayerSweepMeshChunk[]): void {
    if (parts.length === 0) return
    const m = mergeAscLayerSweepChunks(parts)
    for (let x = 0; x < m.positions.length; x++) out.positions.push(m.positions[x]!)
    for (let x = 0; x < m.normals.length; x++) out.normals.push(m.normals[x]!)
    for (let x = 0; x < m.indices.length; x++) out.indices.push(m.indices[x]!)
}
