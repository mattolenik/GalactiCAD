/**
 * Insert shape declaration at cursor position.
 * Used by the context menu "Insert shape" submenu.
 */

import * as monaco from "monaco-editor"

export function insertShapeDeclaration(
    editor: monaco.editor.IStandaloneCodeEditor,
    varNameBase: string,
    callText: string
): void {
    const model = editor.getModel()
    if (!model) return
    const src = model.getValue()

    const existing = new Set<string>()
    for (const m of src.matchAll(/(?:let|const|var)\s+(\w+)/g)) existing.add(m[1])
    let varName = varNameBase
    for (let i = 2; existing.has(varName); i++) varName = varNameBase + i

    const declaration = `let ${varName} = ${callText}\n`
    const varNameStartCol = 1 + "let ".length
    const varNameEndCol = varNameStartCol + varName.length

    const pos = editor.getPosition()
    const cursorLine = pos?.lineNumber ?? 1
    const insertLine = cursorLine > 1 ? cursorLine - 1 : 1
    const insertCol = 1

    const range = new monaco.Range(insertLine, insertCol, insertLine, insertCol)
    const nameSelection = new monaco.Selection(insertLine, varNameStartCol, insertLine, varNameEndCol)

    editor.executeEdits("insert-shape", [{ range, text: declaration }], [nameSelection])
    editor.focus()
}

export interface ShapeInsertion {
    id: string
    label: string
    varBase: string
    call: string
}

export const SHAPE_INSERTIONS: ShapeInsertion[] = [
    { id: "insertSphere", label: "Sphere", varBase: "newSphere", call: "sphere({ r: 1 })" },
    { id: "insertBox", label: "Box", varBase: "newBox", call: "box([2, 2, 2])" },
    { id: "insertCylinder", label: "Cylinder", varBase: "newCylinder", call: "cylinder({ r: 1, h: 3 })" },
    { id: "insertCone", label: "Cone", varBase: "newCone", call: "cone({ r: 1, h: 2 })" },
    { id: "insertTorus", label: "Torus", varBase: "newTorus", call: "torus({ sr: 0.25, lr: 1 })" },
    { id: "insertThreadedRod", label: "Threaded rod", varBase: "newThreadedRod", call: "threaded_rod.radius(1).height(3).pitch(0.5)" },
    { id: "insertCapsule", label: "Capsule", varBase: "newCapsule", call: "capsule({ r: 0.5, c: 2 })" },
    { id: "insertPlane", label: "Plane", varBase: "newPlane", call: "plane({ n: [0, 1, 0] })" },
    { id: "insertHexPrism", label: "Hex prism", varBase: "newHexPrism", call: "hexprism({ r: 1, h: 2 })" },
    { id: "insertDisc", label: "Disc", varBase: "newDisc", call: "disc({ r: 1.5 })" },
    { id: "insertBlob", label: "Blob", varBase: "newBlob", call: "blob()" },
]
