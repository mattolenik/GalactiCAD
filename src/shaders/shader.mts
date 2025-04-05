export class CompiledShader {
    symbol = `\\/\\/:\\)` // matches this:  //:)
    constructor(public text: string, public label: string) {}
    replace(directive: string, name: string, replaceString: string): CompiledShader {
        const pattern = new RegExp(`.*${this.symbol}\\s*${directive}\\s*${name}`, "g")
        this.text = this.text.replaceAll(pattern, replaceString)
        return this
    }
    createModule(device: GPUDevice) {
        return device.createShaderModule({
            label: this.label,
            code: this.text,
        })
    }
    toString() {
        return this.text
    }
}
