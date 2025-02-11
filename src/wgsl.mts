import "reflect-metadata"

export const Metadata = {
    SIZE: "wgsl:size",
    ALIGN: "wgsl:align",
}

// Decorators for WGSL host-shareable types

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

export function i32(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 4, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 4, target, propertyKey)
}

export function u32(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 4, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 4, target, propertyKey)
}

export function mat2x2f(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 16, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 16, target, propertyKey)
}

export function mat2x3f(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 24, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 24, target, propertyKey)
}

export function mat2x4f(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 32, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 32, target, propertyKey)
}

export function mat3x2f(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 24, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 24, target, propertyKey)
}

export function mat3x3f(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 36, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 36, target, propertyKey)
}

export function mat3x4f(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 48, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 48, target, propertyKey)
}

export function mat4x2f(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 32, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 32, target, propertyKey)
}

export function mat4x3f(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 48, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 48, target, propertyKey)
}

export function mat4x4f(target: any, propertyKey: string) {
    Reflect.defineMetadata(Metadata.SIZE, 64, target, propertyKey)
    Reflect.defineMetadata(Metadata.ALIGN, 64, target, propertyKey)
}

export function array(count: number, elementSize: number) {
    return (target: any, propertyKey: any) => {
        Reflect.defineMetadata(Metadata.SIZE, count * elementSize, target, propertyKey)
        Reflect.defineMetadata(Metadata.ALIGN, count * elementSize, target, propertyKey)
    }
}

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
