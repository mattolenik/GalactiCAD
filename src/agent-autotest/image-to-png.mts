/** Encode an ImageData to a base64 PNG string via OffscreenCanvas (works on the main thread and in workers). */
export async function imageDataToPngBase64(img: ImageData): Promise<string> {
    const canvas = new OffscreenCanvas(img.width, img.height)
    const ctx = canvas.getContext("2d")
    if (!ctx) {
        throw new Error("2D OffscreenCanvas unavailable")
    }
    ctx.putImageData(img, 0, 0)
    const blob = await canvas.convertToBlob({ type: "image/png" })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let binary = ""
    const chunk = 8192
    for (let i = 0; i < buf.length; i += chunk) {
        binary += String.fromCharCode(...buf.subarray(i, Math.min(i + chunk, buf.length)))
    }
    return btoa(binary)
}
