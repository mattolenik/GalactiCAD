type TransformFunc = (text: string) => string

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
        for (const t of this.transforms) {
            code = t(code)
        }
        // Debug: check for problematic patterns
        if (code.includes("var any")) {
            console.error(`[Shader Debug] ${label}: Found 'var any' in compiled code!`)
            const lines = code.split('\n')
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes("var any")) {
                    console.error(`  Line ${i + 1}: ${lines[i]}`)
                }
            }
        }
        if (label === "Export") {
            // Debug: verify sceneSDF injection
            const hasSceneSDF = code.includes("fn sceneSDF")
            const stillHasPlaceholder = code.includes("insert sceneSDF")
            console.log(`[Shader Debug] ${label}: sceneSDF defined=${hasSceneSDF}, placeholder remaining=${stillHasPlaceholder}`)
            if (stillHasPlaceholder) {
                console.error("[Shader Debug] sceneSDF injection FAILED!")
            }
        }
        const module = this.device.createShaderModule({ label, code })
        module.getCompilationInfo().then(info => {
            for (const msg of info.messages) {
                const loc = msg.lineNum ? ` (line ${msg.lineNum}:${msg.linePos})` : ""
                const logFn = msg.type === "error" ? console.error : msg.type === "warning" ? console.warn : console.log
                logFn(`[WGSL ${msg.type}] ${label}${loc}: ${msg.message}`)
                if (msg.type === "error") {
                    const lines = code.split("\n")
                    const lineIdx = msg.lineNum - 1
                    const start = Math.max(0, lineIdx - 2)
                    const end = Math.min(lines.length, lineIdx + 3)
                    for (let i = start; i < end; i++) {
                        const marker = i === lineIdx ? ">>>" : "   "
                        console.error(`  ${marker} ${i + 1}: ${lines[i]}`)
                    }
                }
            }
        })
        return module
    }
}
