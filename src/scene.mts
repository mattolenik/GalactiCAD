export class SDFShape {
    pos = new Float32Array([0, 0, 0])
}

export class ProperSDF extends SDFShape {}

export class ImproperSDF extends SDFShape {}

export class SDFOperator {}

// // export function union(...shapes: SDFShape[]): SDFShape {}
// export function union(...shapes: SDFShape[]): SDFShape<Union> {}

// export function difference(...shapes: SDFShape[]): SDFShape {}
