import streamSliceWGSL from "../shaders/streamSlice.wgsl"
import linkLoopsWGSL from "../shaders/linkLoops.wgsl"
import sideWallWGSL from "../shaders/sidewall.wgsl"
import capWGSL from "../shaders/cap.wgsl"
import { ShaderCompiler } from "../shaders/shader.mjs"

export interface ExportOptions {
    /** Number of Z-slices */
    sliceCount: number
    /** 2D slice resolution (cells per axis) */
    width: number
    height: number
    /** Distance between adjacent X/Y samples */
    cellSize: number
    /** Distance between Z-slices */
    zStep: number
    /** Hash table size for loop-linking */
    hashSize: number
}

export async function exportSDFToSTLGPU(
    device: GPUDevice,
    opts: ExportOptions,
    /** WGSL code string defining `fn sceneSDF(p: vec3<f32>) -> f32 { … }` */
    sc: ShaderCompiler,
    sceneArgs: GPUBuffer,
    handle: FileSystemFileHandle
): Promise<void> {
    const sliceModule = sc.compile(streamSliceWGSL, "streamSlice")
    const linkModule = sc.compile(linkLoopsWGSL, "linkLoops")
    const sideModule = sc.compile(sideWallWGSL, "sidewall")
    const capModule = sc.compile(capWGSL, "sidewall")

    const slicePipeline = await device.createComputePipelineAsync({
        layout: "auto",
        label: "sliceCompute",
        compute: { module: sliceModule, entryPoint: "main" },
    })
    const linkHashPipeline = await device.createComputePipelineAsync({
        layout: "auto",
        label: "linkHashCompute",
        compute: { module: linkModule, entryPoint: "buildHash" },
    })
    const linkLoopPipeline = await device.createComputePipelineAsync({
        layout: "auto",
        label: "linkLoopCompute",
        compute: { module: linkModule, entryPoint: "linkAll" },
    })
    const sidePipeline = await device.createComputePipelineAsync({
        layout: "auto",
        label: "sidewallCompute",
        compute: { module: sideModule, entryPoint: "main" },
    })
    const capPipeline = await device.createComputePipelineAsync({
        layout: "auto",
        label: "capCompute",
        compute: { module: capModule, entryPoint: "main" },
    })

    // 2) Allocate GPUBuffers for intermediate data
    const maxSegments = (opts.width - 1) * (opts.height - 1)
    const maxPoints = maxSegments * 2

    const segmentsBuf = device.createBuffer({
        size: maxPoints * 8, // vec2<f32> = 8 bytes
        label: "segments",
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })

    const segCountBuf = device.createBuffer({
        size: 4,
        label: "segCount",
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })
    const sceneBuf = device.createBuffer({
        size: sceneArgs.size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        label: "scene",
    })

    const headBuf = device.createBuffer({
        size: opts.hashSize * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        label: "head",
    })

    const loopCountBuf = device.createBuffer({
        label: "loopCount",
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    })
    const loopVertsBufs = [0, 1].map((_, i) =>
        device.createBuffer({
            label: `loopVert[${i}]`,
            size: maxPoints * 8,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        })
    )
    const loopStartsBufs = [0, 1].map((_, i) =>
        device.createBuffer({
            size: (maxPoints + 1) * 4,
            label: `loopStart[${i}]`,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        })
    )

    const trianglesBuf = device.createBuffer({
        size: maxSegments * 72, // 2 tris per segment * 3 verts * 12 bytes
        label: "triangles",
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })
    const triCountBuf = device.createBuffer({
        size: 4,
        label: "triCount",
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })

    // Uniform buffers
    const sliceUniform = device.createBuffer({ label: "sliceUniform", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const linkUniform = device.createBuffer({ label: "linkUniform", size: 12, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const sideUniform = device.createBuffer({ label: "sideUniform", size: 24, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const capUniform = device.createBuffer({ label: "capUniform", size: 12, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })

    const stream = await handle.createWritable()
    await stream.write(new Uint8Array(80))
    await stream.write(new Uint8Array(4)) // placeholder for tri-count

    let totalTris = 0
    const loopCounts: [number, number] = [0, 0]
    const loopStartsArrays: [Uint32Array, Uint32Array] = [new Uint32Array(0), new Uint32Array(0)]

    // 4) Main slicing & polygonization loop
    for (let sliceIdx = 0; sliceIdx < opts.sliceCount; sliceIdx++) {
        const cur = sliceIdx & 1
        const prev = cur ^ 1

        // --- A) Streaming slice → segments (marching‐squares) ---
        device.queue.writeBuffer(segCountBuf, 0, new Uint32Array([0]))

        const sliceEnc = device.createCommandEncoder({ label: "slice" })
        sliceEnc.copyBufferToBuffer(sceneArgs, 0, sceneBuf, 0, sceneArgs.size)

        for (let y = 0; y < opts.height - 1; y++) {
            // pack uniforms: [ width, cellSize, z, y ] as f32
            const dv = new DataView(new ArrayBuffer(16))
            dv.setFloat32(0, opts.width, true)
            dv.setFloat32(4, opts.cellSize, true)
            dv.setFloat32(8, sliceIdx * opts.zStep, true)
            dv.setFloat32(12, y, true)
            device.queue.writeBuffer(sliceUniform, 0, dv.buffer)

            const pass = sliceEnc.beginComputePass()
            pass.setPipeline(slicePipeline)
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: slicePipeline.getBindGroupLayout(0),
                    label: "slice",
                    entries: [
                        { binding: 0, resource: { buffer: sliceUniform } },
                        { binding: 1, resource: { buffer: segmentsBuf } },
                        { binding: 2, resource: { buffer: segCountBuf } },
                        { binding: 3, resource: { buffer: sceneBuf } },
                    ],
                })
            )
            pass.dispatchWorkgroups(Math.ceil(opts.width / 256))
            pass.end()
        }
        device.queue.submit([sliceEnc.finish()])

        const segCountReadBuf = device.createBuffer({
            size: segCountBuf.size,
            label: "segCountRead",
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        {
            const ce = device.createCommandEncoder({ label: "segCountReadBuf" })
            ce.copyBufferToBuffer(segCountBuf, 0, segCountReadBuf, 0, segCountBuf.size)
            device.queue.submit([ce.finish()])
        }
        await segCountReadBuf.mapAsync(GPUMapMode.READ)
        const segCount = new Uint32Array(segCountReadBuf.getMappedRange())[0]
        segCountReadBuf.unmap()
        console.log(segCount)

        const nextBuf = device.createBuffer({
            label: "next",
            size: segCount,
            usage: GPUBufferUsage.STORAGE,
        })
        const visitedBuf = device.createBuffer({
            size: segCount,
            label: "visited",
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        })

        // --- B) Link segments into loops on GPU ---
        // reset hash table & visited flags & loopCount
        device.queue.writeBuffer(headBuf, 0, new Int32Array(segCount).fill(-1))
        device.queue.writeBuffer(visitedBuf, 0, new Uint32Array(segCount).fill(0))
        device.queue.writeBuffer(linkUniform, 0, new Uint32Array([maxSegments, opts.hashSize]))

        const linkEnc = device.createCommandEncoder({ label: "link" })
        const linkBG = device.createBindGroup({
            layout: linkHashPipeline.getBindGroupLayout(0),
            label: "link",
            entries: [
                { binding: 0, resource: { buffer: linkUniform } },
                { binding: 1, resource: { buffer: segmentsBuf } },
                { binding: 3, resource: { buffer: headBuf } },
                { binding: 4, resource: { buffer: nextBuf } },
            ],
        })
        const linkLoopBG = device.createBindGroup({
            layout: linkLoopPipeline.getBindGroupLayout(0),
            label: "linkLoop",
            entries: [
                { binding: 0, resource: { buffer: linkUniform } },
                { binding: 1, resource: { buffer: segmentsBuf } },
                { binding: 2, resource: { buffer: segCountBuf } },
                { binding: 3, resource: { buffer: headBuf } },
                { binding: 4, resource: { buffer: nextBuf } },
                { binding: 5, resource: { buffer: visitedBuf } },
                { binding: 6, resource: { buffer: loopVertsBufs[cur] } },
                { binding: 7, resource: { buffer: loopStartsBufs[cur] } },
                { binding: 8, resource: { buffer: loopCountBuf } },
            ],
        })
        // build hash‐chains
        let passH = linkEnc.beginComputePass()
        passH.setPipeline(linkHashPipeline)
        passH.setBindGroup(0, linkBG)
        passH.dispatchWorkgroups(Math.ceil(maxSegments / 256))
        passH.end()
        // walk loops
        let passL = linkEnc.beginComputePass()
        passL.setPipeline(linkLoopPipeline)
        passL.setBindGroup(0, linkLoopBG)
        passL.dispatchWorkgroups(1)
        passL.end()
        device.queue.submit([linkEnc.finish()])

        {
            const loopCountReadBuf = device.createBuffer({
                size: loopCountBuf.size,
                label: loopCountBuf.label + "_read",
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })
            const ce = device.createCommandEncoder({ label: "loopCountReadBuf" })
            ce.copyBufferToBuffer(loopCountBuf, 0, loopCountReadBuf, 0, loopCountBuf.size)
            device.queue.submit([ce.finish()])
            // read back loopCount + loopStarts into CPU
            await loopCountReadBuf.mapAsync(GPUMapMode.READ)
            loopCounts[cur] = new Uint32Array(loopCountReadBuf.getMappedRange())[0]
            loopCountReadBuf.unmap()
        }

        {
            const count = loopCounts[cur] + 1
            const staging = device.createBuffer({
                label: `staging${count}`,
                size: count * 4,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })
            const cp = device.createCommandEncoder({ label: "loopStartsReadBuf" })
            cp.copyBufferToBuffer(loopStartsBufs[cur], 0, staging, 0, count * 4)
            device.queue.submit([cp.finish()])

            await staging.mapAsync(GPUMapMode.READ)
            loopStartsArrays[cur] = new Uint32Array(staging.getMappedRange()).slice()
            staging.unmap()
        }

        // --- C) Generate side‐walls & caps into trianglesBuf ---
        device.queue.writeBuffer(triCountBuf, 0, new Uint32Array([0]))
        const scEnc = device.createCommandEncoder({ label: "sidewallsAndCaps" })

        // Side‐wall between prev & cur (if not first slice)
        if (sliceIdx > 0) {
            const prevCount = loopCounts[prev]
            const dvS = new DataView(new ArrayBuffer(24))
            dvS.setUint32(0, loopStartsArrays[prev][0], true)
            dvS.setUint32(4, prevCount, true)
            dvS.setUint32(8, loopStartsArrays[cur][0], true)
            dvS.setUint32(12, loopCounts[cur], true)
            dvS.setFloat32(16, (sliceIdx - 1) * opts.zStep, true)
            dvS.setFloat32(20, sliceIdx * opts.zStep, true)
            device.queue.writeBuffer(sideUniform, 0, dvS.buffer)

            const passS = scEnc.beginComputePass()
            passS.setPipeline(sidePipeline)
            passS.setBindGroup(
                0,
                device.createBindGroup({
                    layout: sidePipeline.getBindGroupLayout(0),
                    label: "sidewall",
                    entries: [
                        { binding: 0, resource: { buffer: sideUniform } },
                        { binding: 1, resource: { buffer: loopStartsBufs[cur] } },
                        { binding: 2, resource: { buffer: loopVertsBufs[cur] } },
                        { binding: 3, resource: { buffer: trianglesBuf } },
                        { binding: 4, resource: { buffer: triCountBuf } },
                    ],
                })
            )
            passS.dispatchWorkgroups(Math.ceil(prevCount / 256))
            passS.end()
        }

        // Cap top/bottom of the volume at this slice
        if (sliceIdx === 0 || sliceIdx === opts.sliceCount - 1) {
            const dvC = new DataView(new ArrayBuffer(8))
            dvC.setUint32(0, loopCounts[cur], true)
            dvC.setUint32(4, sliceIdx === 0 ? 1 : 0, true)
            device.queue.writeBuffer(capUniform, 0, dvC.buffer)

            const passC = scEnc.beginComputePass()
            passC.setPipeline(capPipeline)
            passC.setBindGroup(
                0,
                device.createBindGroup({
                    layout: capPipeline.getBindGroupLayout(0),
                    label: "cap",
                    entries: [
                        { binding: 0, resource: { buffer: capUniform } },
                        { binding: 1, resource: { buffer: loopStartsBufs[cur] } },
                        { binding: 2, resource: { buffer: loopVertsBufs[cur] } },
                        { binding: 3, resource: { buffer: trianglesBuf } },
                        { binding: 4, resource: { buffer: triCountBuf } },
                    ],
                })
            )
            passC.dispatchWorkgroups(loopCounts[cur])
            passC.end()
        }

        device.queue.submit([scEnc.finish()])

        // --- D) Read back triangles and write to STL file ---
        // helper: read triCount & trianglesBuf → Float32Array
        async function readBack(): Promise<Float32Array> {
            const triCountReadBuf = device.createBuffer({
                label: "triCountRead",
                size: triCountBuf.size,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })
            {
                const ce = device.createCommandEncoder({ label: "triCountReadBuf" })
                ce.copyBufferToBuffer(triCountBuf, 0, triCountReadBuf, 0, triCountBuf.size)
                device.queue.submit([ce.finish()])
            }
            await triCountReadBuf.mapAsync(GPUMapMode.READ)
            const count = new Uint32Array(triCountReadBuf.getMappedRange())[0]
            triCountReadBuf.unmap()
            if (count === 0) return new Float32Array(0)
            const byteLen = count * 3 /*verts*/ * 3 /*floats*/ * 4
            const staging = device.createBuffer({
                label: "trianglesRead",
                size: byteLen,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })
            const cp2 = device.createCommandEncoder({ label: "trianglesReadBuf" })
            cp2.copyBufferToBuffer(trianglesBuf, 0, staging, 0, byteLen)
            device.queue.submit([cp2.finish()])
            await staging.mapAsync(GPUMapMode.READ)
            const arr = new Float32Array(staging.getMappedRange().slice(0))
            staging.unmap()
            return arr
        }

        const tris = await readBack()
        const triCount = tris.length / 9
        if (triCount > 0) {
            totalTris += triCount
            const chunk = new ArrayBuffer(triCount * 50)
            const dvCh = new DataView(chunk)
            for (let t = 0; t < triCount; t++) {
                const baseF = t * 9
                const baseB = t * 50
                // zero normal
                dvCh.setFloat32(baseB + 0, 0, true)
                dvCh.setFloat32(baseB + 4, 0, true)
                dvCh.setFloat32(baseB + 8, 0, true)
                // vertices
                for (let v = 0; v < 3; v++) {
                    const fx = tris[baseF + v * 3 + 0]
                    const fy = tris[baseF + v * 3 + 1]
                    const fz = tris[baseF + v * 3 + 2]
                    const off = baseB + 12 + v * 12
                    dvCh.setFloat32(off + 0, fx, true)
                    dvCh.setFloat32(off + 4, fy, true)
                    dvCh.setFloat32(off + 8, fz, true)
                }
                dvCh.setUint16(baseB + 48, 0, true)
            }
            await stream.write(new Uint8Array(chunk))
        }
    }

    // 5) Overwrite triangle-count placeholder and close
    await stream.seek(80)
    await stream.write(new Uint32Array([totalTris]))
    await stream.close()
}
