import { SIZEOF_VERTEX } from "./mdc.mjs"

export async function exportStlAscii(solidName: string, handle: FileSystemFileHandle, verts: Float32Array<ArrayBuffer>, tris: Uint32Array<ArrayBuffer>) {
    const stride = SIZEOF_VERTEX / 4 // floats per vertex
    const lines: string[] = []
    lines.push(`solid ${solidName}`)

    const vpos = (vidx: number) => {
        const base = vidx * stride
        return [verts![base]!, verts![base + 1]!, verts![base + 2]!] as const
    }
    const sub = (a: readonly [number, number, number], b: readonly [number, number, number]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]] as const
    const cross = (a: readonly [number, number, number], b: readonly [number, number, number]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] as const
    const norm = (a: readonly [number, number, number]) => Math.hypot(a[0], a[1], a[2])
    const normalize = (a: readonly [number, number, number]) => {
        const n = norm(a)
        if (!isFinite(n) || n === 0) return [0, 0, 0] as const
        return [a[0] / n, a[1] / n, a[2] / n] as const
    }
    const f3 = (n: number) => (Math.abs(n) < 1e-12 ? "0" : n.toString())

    for (let i = 0; i < tris.length; i += 3) {
        const i0 = tris[i]!
        const i1 = tris[i + 1]!
        const i2 = tris[i + 2]!

        const p0 = vpos(i0)
        const p1 = vpos(i1)
        const p2 = vpos(i2)

        const nrm = normalize(cross(sub(p1, p0), sub(p2, p0)))

        lines.push(`  facet normal ${f3(nrm[0])} ${f3(nrm[1])} ${f3(nrm[2])}`)
        lines.push(`    outer loop`)
        lines.push(`      vertex ${f3(p0[0])} ${f3(p0[1])} ${f3(p0[2])}`)
        lines.push(`      vertex ${f3(p1[0])} ${f3(p1[1])} ${f3(p1[2])}`)
        lines.push(`      vertex ${f3(p2[0])} ${f3(p2[1])} ${f3(p2[2])}`)
        lines.push(`    endloop`)
        lines.push(`  endfacet`)
    }

    lines.push(`endsolid ${solidName}`)
    const stlText = lines.join("\n") + "\n"
    const stlBytes = new TextEncoder().encode(stlText)
    const writable = await handle.createWritable()
    await writable.write(stlBytes.buffer)
    await writable.close()
}

export async function exportStlBinary(solidName: string, handle: FileSystemFileHandle, verts: Float32Array<ArrayBuffer>, tris: Uint32Array<ArrayBuffer>) {
    const stride = SIZEOF_VERTEX / 4 // floats per vertex

    const triCount = Math.floor(tris.length / 3)
    const totalBytes = 80 + 4 + triCount * 50
    const buf = new ArrayBuffer(totalBytes)
    const dv = new DataView(buf)

    // 80-byte header (arbitrary text, padded with zeros)
    {
        const header = new Uint8Array(buf, 0, 80)
        header.fill(0)
        const headerText = `galacticad ${solidName}`.slice(0, 80)
        const headerBytes = new TextEncoder().encode(headerText)
        header.set(headerBytes.slice(0, 80))
    }

    // Triangle count (u32 LE)
    dv.setUint32(80, triCount >>> 0, true)

    const vpos = (vidx: number) => {
        const base = vidx * stride
        return [verts![base]!, verts![base + 1]!, verts![base + 2]!] as const
    }
    const sub = (a: readonly [number, number, number], b: readonly [number, number, number]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]] as const
    const cross = (a: readonly [number, number, number], b: readonly [number, number, number]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] as const
    const norm = (a: readonly [number, number, number]) => Math.hypot(a[0], a[1], a[2])
    const normalize = (a: readonly [number, number, number]) => {
        const n = norm(a)
        if (!isFinite(n) || n === 0) return [0, 0, 0] as const
        return [a[0] / n, a[1] / n, a[2] / n] as const
    }

    let off = 84
    for (let i = 0; i < triCount * 3; i += 3) {
        const i0 = tris[i]!
        const i1 = tris[i + 1]!
        const i2 = tris[i + 2]!

        const p0 = vpos(i0)
        const p1 = vpos(i1)
        const p2 = vpos(i2)

        const nrm = normalize(cross(sub(p1, p0), sub(p2, p0)))

        // normal (3 * f32), vertices (9 * f32), attribute byte count (u16)
        dv.setFloat32(off + 0, nrm[0], true)
        dv.setFloat32(off + 4, nrm[1], true)
        dv.setFloat32(off + 8, nrm[2], true)

        dv.setFloat32(off + 12, p0[0], true)
        dv.setFloat32(off + 16, p0[1], true)
        dv.setFloat32(off + 20, p0[2], true)

        dv.setFloat32(off + 24, p1[0], true)
        dv.setFloat32(off + 28, p1[1], true)
        dv.setFloat32(off + 32, p1[2], true)

        dv.setFloat32(off + 36, p2[0], true)
        dv.setFloat32(off + 40, p2[1], true)
        dv.setFloat32(off + 44, p2[2], true)

        dv.setUint16(off + 48, 0, true)
        off += 50
    }

    const writable = await handle.createWritable()
    await writable.write(buf)
    await writable.close()
}
