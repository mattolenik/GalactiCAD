type TransformFunc = (text: string) => string

export class ShaderCompiler {
    symbol = `\\/\\/:\\)` // matches this:  //:)
    transforms: TransformFunc[] = []

    constructor(private device: GPUDevice) {}

    replace(directive: string, name: string, replaceString: string): ShaderCompiler {
        this.transforms.push((text: string) => {
            const pattern = new RegExp(`.*${this.symbol}\\s*${directive}\\s*${name}`, "g")
            return text.replaceAll(pattern, replaceString)
        })
        return this
    }

    compile(code: string, label: string) {
        for (const t of this.transforms) {
            code = t(code)
        }
        console.log(label, "\n", code)
        return this.device.createShaderModule({ label, code })
    }
}
