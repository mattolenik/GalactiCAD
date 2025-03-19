import { Vec2f, Vec3f, Vec4f } from "../vecmat/vector.mjs"

export function setFloat(key: string, value: number) {
    localStorage.setItem(key, value.toString())
}

export function getFloat(key: string): number | null {
    const item = localStorage.getItem(key)
    if (item === null) {
        return null
    }
    return parseFloat(item)
}

export function setInt(key: string, value: number) {
    localStorage.setItem(key, value.toFixed(0))
}

export function getInt(key: string): number | null {
    const item = localStorage.getItem(key)
    if (item === null) {
        return null
    }
    return parseInt(item, 10)
}

export function setVec2f(key: string, value: Vec2f) {
    localStorage.setItem(key, value.toStorage())
}

export function getVec2f(key: string): Vec2f | null {
    return Vec2f.fromStorage(localStorage.getItem(key))
}

export function setVec3f(key: string, value: Vec3f) {
    localStorage.setItem(key, value.toStorage())
}

export function getVec3f(key: string): Vec3f | null {
    return Vec3f.fromStorage(localStorage.getItem(key))
}

export function setVec4f(key: string, value: Vec4f) {
    localStorage.setItem(key, value.toStorage())
}

export function getVec4f(key: string): Vec4f | null {
    return Vec4f.fromStorage(localStorage.getItem(key))
}
