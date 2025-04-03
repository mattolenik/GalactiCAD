import { Vec2f, Vec3f, Vec4f } from "../vecmat/vector.mjs"

export interface Storable {
    toStorage(): string
    loadStorage(s: string): void
}

export function setFloat(key: string, value: number) {
    localStorage.setItem(key, value.toString())
}

export function getFloat(key: string): number | undefined {
    const item = localStorage.getItem(key)
    if (item === null) {
        return undefined
    }
    return parseFloat(item)
}

export function setInt(key: string, value: number) {
    localStorage.setItem(key, value.toFixed(0))
}

export function getInt(key: string): number | undefined {
    const item = localStorage.getItem(key)
    if (item === null) {
        return undefined
    }
    return parseInt(item, 10)
}

export function setVec2f(key: string, value: Vec2f) {
    localStorage.setItem(key, value.toStorage())
}

export function getVec2f(key: string): Vec2f {
    return new Vec2f(localStorage.getItem(key))
}

export function setVec3f(key: string, value: Vec3f) {
    localStorage.setItem(key, value.toStorage())
}

export function getVec3f(key: string): Vec3f {
    return new Vec3f(localStorage.getItem(key))
}

export function setVec4f(key: string, value: Vec4f) {
    localStorage.setItem(key, value.toStorage())
}

export function getVec4f(key: string): Vec4f {
    return new Vec4f(localStorage.getItem(key))
}
