export function clamp(x: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, x))
}

export function clampAngle(rad: number): number {
    return Math.atan2(Math.sin(rad), Math.cos(rad))
}
