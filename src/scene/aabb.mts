/**
 * Axis-Aligned Bounding Box utilities for BVH-accelerated SDF evaluation.
 * AABBs are computed at compile time (TypeScript) and emitted as inline WGSL
 * bounding checks to guard expensive SDF subtree evaluations.
 */

export interface AABB {
    /** Center of the bounding box */
    cx: number; cy: number; cz: number
    /** Half-extents (always >= 0) */
    hx: number; hy: number; hz: number
}

export function aabb(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): AABB {
    return { cx, cy, cz, hx: Math.abs(hx), hy: Math.abs(hy), hz: Math.abs(hz) }
}

/** Expand an AABB uniformly by `amount` in all directions. */
export function aabbExpand(b: AABB, amount: number): AABB {
    return { cx: b.cx, cy: b.cy, cz: b.cz, hx: b.hx + amount, hy: b.hy + amount, hz: b.hz + amount }
}

/** Expand an AABB by different amounts per axis. */
export function aabbExpandVec(b: AABB, ex: number, ey: number, ez: number): AABB {
    return { cx: b.cx, cy: b.cy, cz: b.cz, hx: b.hx + Math.abs(ex), hy: b.hy + Math.abs(ey), hz: b.hz + Math.abs(ez) }
}

/** Compute the union (enclosing) AABB of two AABBs. */
export function aabbUnion(a: AABB, b: AABB): AABB {
    const minX = Math.min(a.cx - a.hx, b.cx - b.hx)
    const maxX = Math.max(a.cx + a.hx, b.cx + b.hx)
    const minY = Math.min(a.cy - a.hy, b.cy - b.hy)
    const maxY = Math.max(a.cy + a.hy, b.cy + b.hy)
    const minZ = Math.min(a.cz - a.hz, b.cz - b.hz)
    const maxZ = Math.max(a.cz + a.hz, b.cz + b.hz)
    return {
        cx: (minX + maxX) * 0.5, cy: (minY + maxY) * 0.5, cz: (minZ + maxZ) * 0.5,
        hx: (maxX - minX) * 0.5, hy: (maxY - minY) * 0.5, hz: (maxZ - minZ) * 0.5,
    }
}

/** Compute the intersection AABB of two AABBs. Returns null if they don't overlap. */
export function aabbIntersect(a: AABB, b: AABB): AABB | null {
    const minX = Math.max(a.cx - a.hx, b.cx - b.hx)
    const maxX = Math.min(a.cx + a.hx, b.cx + b.hx)
    const minY = Math.max(a.cy - a.hy, b.cy - b.hy)
    const maxY = Math.min(a.cy + a.hy, b.cy + b.hy)
    const minZ = Math.max(a.cz - a.hz, b.cz - b.hz)
    const maxZ = Math.min(a.cz + a.hz, b.cz + b.hz)
    if (minX > maxX || minY > maxY || minZ > maxZ) return null
    return {
        cx: (minX + maxX) * 0.5, cy: (minY + maxY) * 0.5, cz: (minZ + maxZ) * 0.5,
        hx: (maxX - minX) * 0.5, hy: (maxY - minY) * 0.5, hz: (maxZ - minZ) * 0.5,
    }
}

/**
 * Transform an AABB by a 3x3 rotation matrix (column-major, 9 values).
 * Uses the standard method of transforming all 8 corners and re-bounding.
 */
export function aabbRotate(b: AABB, m: number[]): AABB {
    // m is column-major 3x3: m[col*3+row]
    // Optimized: new half-extents = |M| * half-extents (absolute value of matrix times half-extents)
    const nhx = Math.abs(m[0]) * b.hx + Math.abs(m[3]) * b.hy + Math.abs(m[6]) * b.hz
    const nhy = Math.abs(m[1]) * b.hx + Math.abs(m[4]) * b.hy + Math.abs(m[7]) * b.hz
    const nhz = Math.abs(m[2]) * b.hx + Math.abs(m[5]) * b.hy + Math.abs(m[8]) * b.hz
    // Transform center
    const ncx = m[0] * b.cx + m[3] * b.cy + m[6] * b.cz
    const ncy = m[1] * b.cx + m[4] * b.cy + m[7] * b.cz
    const ncz = m[2] * b.cx + m[5] * b.cy + m[8] * b.cz
    return { cx: ncx, cy: ncy, cz: ncz, hx: nhx, hy: nhy, hz: nhz }
}

/**
 * Emit a WGSL vec3f literal for the AABB center.
 */
export function aabbCenterWgsl(b: AABB): string {
    const f = (v: number) => v.toFixed(6)
    return `vec3f(${f(b.cx)}, ${f(b.cy)}, ${f(b.cz)})`
}

/**
 * Emit a WGSL vec3f literal for the AABB half-extents.
 */
export function aabbHalfWgsl(b: AABB): string {
    const f = (v: number) => v.toFixed(6)
    return `vec3f(${f(b.hx)}, ${f(b.hy)}, ${f(b.hz)})`
}
