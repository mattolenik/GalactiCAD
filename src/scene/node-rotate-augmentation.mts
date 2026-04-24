import type { Vec3 } from "../vecmat/vector.mjs"
import type { Rotate } from "./operators/rotate.mjs"

export {}

declare module "./base.mjs" {
    interface Node {
        /** Euler angles in degrees [rx, ry, rz] — same as `rotate(rot, this)`. */
        rotate(rot: Vec3): Rotate
    }
}
