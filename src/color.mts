import { Vec3f, vec3 } from "./vecmat/vector.mjs"

export function hexToRgb(hex: string): Vec3f {
    // Remove the hash if it exists
    hex = hex.replace("#", "")

    // Handle shorthand hex codes (e.g., #abc)
    if (hex.length === 3) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
    }

    // Convert hex to RGB
    return vec3(parseInt(hex.substring(0, 2), 16) / 255, parseInt(hex.substring(2, 4), 16) / 255, parseInt(hex.substring(4, 6), 16) / 255)
}
