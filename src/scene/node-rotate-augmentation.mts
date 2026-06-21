import type { Vec3 } from "../vecmat/vector.mjs"
import type { Rotate } from "./operators/rotate.mjs"

export {}

declare module "./base.mjs" {
    interface Node {
        /** Euler angles in degrees [rx, ry, rz] — same as `rotate(rot, this)`. */
        rotate(rot: Vec3): Rotate
        /** Euler angles in degrees — same as `rotate([rx, ry, rz], this)`. */
        rotate(rx: number, ry: number, rz: number): Rotate
    }
}
