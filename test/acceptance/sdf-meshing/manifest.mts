import type { CameraSettings } from "../../../src/storage/settings.mjs"

/** A full-model junction, not a substitute primitive fixture. Source edits need a new reference. */
export function witnessesFor(caseId: string, sourceSha256: string) {
    if (caseId !== "bracket") return []
    if (sourceSha256 !== "10f9049a0e3828edb19274b8137525ce1392916032078161adaafa4d58a99508") throw new Error("Bracket geometric witness source changed; establish a new reference before comparing")
    return [{ id: "dent-rib-corner", position: [-3.2974043758686875, 11.496906301499829, 2.2091193968483966], tolerance: 0.02 }]
}

export const CASES = [
    { id: "bracket", name: "Torture bracket", details: [[-12, 6, 0], [0, 5, 0]], regions: ["Boss/bore junction", "Twisted rib junction"] },
    { id: "housing", name: "Torture housing", details: [[0, 0, 18], [0, 8, 0]], regions: ["Flange and bores", "Tee junction"] },
    { id: "knob", name: "Torture knob", details: [[0, -3, 0], [0, 7, 0]], regions: ["Groove and fin roots", "Crown/socket region"] },
    { id: "mess1", name: "Torture mess 1", details: [[3, 1, 3], [-2, 5, 2]], regions: ["Twisted star", "Lathe/periodic cuts"] },
    { id: "mess2", name: "Torture mess 2", details: [[-6, 1, 5], [3, -2, -4]], regions: ["Twisted ribbon", "Vase/core cuts"] },
] as const

export function viewsFor(camera: CameraSettings, item: typeof CASES[number]) {
    const [w, x, y, z] = camera.rotation
    return [
        { id: "hero", label: "Saved animation camera", camera },
        // Postmultiply by a 180-degree local Y rotation, retaining the framing.
        { id: "reverse", label: "Reverse", camera: { ...camera, rotation: [-y, -z, w, x] as [number, number, number, number] } },
        ...item.details.map((target, i) => ({ id: `detail${i + 1}`, label: item.regions[i], camera: {
            // Pivot alone does not frame a region: the projection centers on translation.
            ...camera, pivot: [...target] as [number, number, number], translation: [...target] as [number, number, number], dollyDistance: (camera.dollyDistance ?? 30) * 0.6,
        } })),
    ]
}
