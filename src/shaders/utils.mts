// Compiles the provided WGSL shader source and logs any compilation messages.
export async function compileShader(device: GPUDevice, source: string): Promise<GPUShaderModule> {
    const module = device.createShaderModule({ code: source })
    const info = await module.getCompilationInfo()
    for (let msg of info.messages) {
        const message = `${msg.type.toUpperCase()}: ${msg.message} at ${msg.lineNum}:${msg.linePos}`
        if (msg.type === "error") {
            console.error(message)
        } else {
            console.warn(message)
        }
    }
    return module
}
