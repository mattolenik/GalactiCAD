import "reflect-metadata"

export const Metadata = {
    SIZE: Symbol("wgsl:size"),
    ALIGN: Symbol("wgsl:align"),
}

// Decorators for WGSL struct layout
export function vec4f(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 16, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 16, target, propertyKey)
}

export function vec3f(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 12, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 12, target, propertyKey)
}

export function vec2f(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 8, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 8, target, propertyKey)
}

export function f32(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 4, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 4, target, propertyKey)
}

// Helper to calculate struct size
export function getStructSize(target: any): number {
    let size = 0
    let maxAlign = 0

    for (const prop of Object.getOwnPropertyNames(target)) {
        const align = Reflect.getMetadata(Metadata.ALIGN, target, prop) || 0
        const fieldSize = Reflect.getMetadata(Metadata.SIZE, target, prop) || 0

        maxAlign = Math.max(maxAlign, align)
        size = Math.ceil(size / align) * align + fieldSize
    }

    return Math.ceil(size / maxAlign) * maxAlign
}
