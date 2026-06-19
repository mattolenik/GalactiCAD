/**
 * FeatureGraph **chain grouping** — collapse the alive-edge soup into selectable
 * 1D features: maximal connected chains of edges, split at corner vertices, at
 * graph junctions (degree ≠ 2), and at owner-node boundaries.
 *
 * Why: curves are heavily subdivided into many tiny edge segments, so a click
 * must select the whole connected run, not one segment. An open chain is a
 * **polyline**; a closed loop with no split vertex is a **ring**.
 *
 * Index discipline: chains reference edges by their *alive-edge instance index*
 * (the `s` from {@link enumerateAliveEdges}), which is exactly the overlay's GPU
 * instance index. `edgeInstanceToChain[s]` therefore maps a hit instance to its
 * chain, and `FgChain.edgeInstanceIndices` enumerates every instance to recolor
 * when the chain is hovered/selected.
 */

import {
    FG_FLAG_CORNER,
    enumerateAliveEdges,
    type FeatureGraphCpu,
} from "../scene/feature-graph-buffer.mjs"

export const enum FgChainKind {
    Polyline = 0,
    Ring = 1,
}

export interface FgChain {
    /** Stable-within-this-grouping id (index into {@link FgChainGrouping.chains}). */
    id: number
    kind: FgChainKind
    /** Alive-edge instance indices (overlay instance indices) in walk order. */
    edgeInstanceIndices: number[]
    /** Ordered FG vertex indices along the chain (start..end; rings omit the duplicate close). */
    vertexIndices: number[]
    /** Scene-node id that owns every edge in the chain (chains never cross owners). */
    ownerNodeId: number
}

export interface FgChainGrouping {
    chains: FgChain[]
    /** Alive-edge instance index → chain id, or -1 if unassigned. Length = alive-edge count. */
    edgeInstanceToChain: Int32Array
}

/**
 * Group all alive edges of `cpu` into polyline/ring chains. Pure; compute once
 * per FeatureGraph build.
 */
export function groupChains(cpu: FeatureGraphCpu): FgChainGrouping {
    const aliveEdges = enumerateAliveEdges(cpu)
    const nInst = aliveEdges.length
    const edgeInstanceToChain = new Int32Array(nInst).fill(-1)
    const chains: FgChain[] = []
    if (nInst === 0) return { chains, edgeInstanceToChain }

    // Per-instance endpoints + owner, and vertex → incident-instance adjacency.
    const endA = new Int32Array(nInst)
    const endB = new Int32Array(nInst)
    const owner = new Int32Array(nInst)
    const adj = new Map<number, number[]>()
    const pushAdj = (v: number, s: number) => {
        const a = adj.get(v)
        if (a) a.push(s)
        else adj.set(v, [s])
    }
    for (let s = 0; s < nInst; s++) {
        const e = aliveEdges[s]!
        const a = cpu.edgeEndpoints[e * 2]!
        const b = cpu.edgeEndpoints[e * 2 + 1]!
        endA[s] = a
        endB[s] = b
        owner[s] = cpu.edgeOwnerNodeId[e] ?? 0
        pushAdj(a, s)
        pushAdj(b, s)
    }

    const isCorner = (v: number) => (cpu.vertexFlags[v]! & FG_FLAG_CORNER) !== 0
    // A vertex is a split point (chain boundary) when it's a corner, a junction
    // (degree ≠ 2), or where two differently-owned edges meet.
    const isSplit = (v: number): boolean => {
        const inc = adj.get(v)
        if (!inc) return true
        if (isCorner(v)) return true
        if (inc.length !== 2) return true
        return owner[inc[0]!] !== owner[inc[1]!]
    }
    const other = (s: number, v: number) => (endA[s] === v ? endB[s] : endA[s])
    const visited = new Uint8Array(nInst)

    const beginChain = (kind: FgChainKind, ownerId: number): FgChain => {
        const c: FgChain = { id: chains.length, kind, edgeInstanceIndices: [], vertexIndices: [], ownerNodeId: ownerId }
        chains.push(c)
        return c
    }

    // Pass 1 — open chains (polylines): start at every split vertex and walk
    // through degree-2, same-owner, non-corner vertices until the next split.
    for (const [start, inc] of adj) {
        if (!isSplit(start)) continue
        for (const s0 of inc) {
            if (visited[s0]) continue
            const c = beginChain(FgChainKind.Polyline, owner[s0]!)
            c.vertexIndices.push(start)
            let v = start
            let s = s0
            for (;;) {
                visited[s] = 1
                edgeInstanceToChain[s] = c.id
                c.edgeInstanceIndices.push(s)
                const w = other(s, v)
                c.vertexIndices.push(w)
                if (isSplit(w)) break
                const wInc = adj.get(w)!
                const next = wInc[0] === s ? wInc[1]! : wInc[0]!
                if (visited[next]) break // safety against malformed adjacency
                v = w
                s = next
            }
        }
    }

    // Pass 2 — remaining edges form rings (closed loops with no split vertex).
    for (let s0 = 0; s0 < nInst; s0++) {
        if (visited[s0]) continue
        const c = beginChain(FgChainKind.Ring, owner[s0]!)
        let v = endA[s0]
        c.vertexIndices.push(v)
        let s = s0
        for (;;) {
            visited[s] = 1
            edgeInstanceToChain[s] = c.id
            c.edgeInstanceIndices.push(s)
            const w = other(s, v)
            const wInc = adj.get(w)!
            const next = wInc[0] === s ? wInc[1]! : wInc[0]!
            if (next === s0 || visited[next]) break // looped back to start
            c.vertexIndices.push(w)
            v = w
            s = next
        }
    }

    return { chains, edgeInstanceToChain }
}
