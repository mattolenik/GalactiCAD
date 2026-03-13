import { Node } from "../base.mjs"

/**
 * Virtual node representing one cap (top or bottom) of an Extrude.
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

    override build(): void {
        this.scene.add(this)
    }
}
