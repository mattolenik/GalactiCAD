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
        return this.device.createShaderModule({ label, code })
    }
}
