import { logWgsl } from "../logging/debug-log.mjs"

type TransformFunc = (text: string) => string

function logGpuCompilationMessages(label: string, code: string, info: GPUCompilationInfo): void {
    const lines = code.split("\n")
    for (const msg of info.messages) {
        const loc = msg.lineNum ? ` (line ${msg.lineNum}:${msg.linePos ?? 0})` : ""
        const head = `${label}${loc}: ${msg.message}`
        if (msg.type === "error") {
            logWgsl("error", head)
            const lineIdx = (msg.lineNum ?? 0) - 1
            if (lineIdx >= 0 && lineIdx < lines.length) {
                const start = Math.max(0, lineIdx - 2)
                const end = Math.min(lines.length, lineIdx + 3)
                for (let i = start; i < end; i++) {
                    const marker = i === lineIdx ? ">>>" : "   "
                    logWgsl("error", `  ${marker} ${i + 1}: ${lines[i]}`)
                }
            }
        } else if (msg.type === "warning") {
            logWgsl("warn", head)
        } else {
            logWgsl("info", head)
        }
    }
}

/**
 * Fetch `GPUShaderModule` compilation messages and log them with dev-log `module: "Wgsl"`.
 * Safe to call for every `createShaderModule` result (including static shaders).
 */
export function scheduleShaderModuleCompilationLogging(module: GPUShaderModule, label: string, code: string): void {
    void (async () => {
        try {
            const info = await module.getCompilationInfo()
            logGpuCompilationMessages(label, code, info)
        } catch (e) {
            const text = e instanceof Error ? e.stack ?? e.message : String(e)
            logWgsl("error", `getCompilationInfo failed for "${label}": ${text}`)
        }
    })()
}

export class ShaderCompiler {
    symbol = `\\/\\/:\\)` // matches this:  //:)
    transforms: TransformFunc[] = []

    constructor(private device: GPUDevice) { }

    replace(directive: string, name: string, replaceString: string): ShaderCompiler {
        this.transforms.push((text: string) => {
            // Use word boundary (\b) to prevent partial matches.
            const pattern = new RegExp(`.*${this.symbol}\\s*${directive}\\s*${name}\\b`, "g")
            return text.replaceAll(pattern, replaceString)
        })
        return this
    }

    compile(code: string, label: string) {
        if (!this.device) {
            throw new Error("WebGPU device unavailable (cannot create shader module)")
        }
        for (const t of this.transforms) {
            code = t(code)
        }
        const module = this.device.createShaderModule({ label, code })
        scheduleShaderModuleCompilationLogging(module, label, code)
        return module
    }
}
