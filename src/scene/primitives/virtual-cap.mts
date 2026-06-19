import { Node } from "../base.mjs"

/**
 * Virtual node representing one cap (top or bottom) of an Extrude or ThreadedRod.
 * Holds no geometry; used only to allocate a distinct ID for the outline/selection system
 * so top and bottom caps can be selected independently.
 */
export class VirtualCapNode extends Node {
    readonly isTop: boolean

    constructor(isTop: boolean) {
        super()
        this.isTop = isTop
    }

    override getShapeType(): string {
        return "virtualCap"
    }

    // Holds no geometry; isolation walks up to the owning extrude / threaded rod.
    override get isIsolatable(): boolean {
        return false
    }

    override build(): void {
        this.scene.add(this)
    }

    override appendStructuralFingerprint(parts: string[]): void {
        parts.push(`${this.getShapeType()}:${this.structuralBvhSlot()}:${this.isTop ? "top" : "bot"}`)
    }
}
