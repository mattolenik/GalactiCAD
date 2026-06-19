/**
 * The single wiring point for mesh exporters. Imports each self-contained
 * exporter implementation and assembles the kind → exporter lookup the worker
 * dispatches on. Adding an exporter is: write its tuning + impl modules, then
 * add one line here.
 *
 * Worker-only: importing this pulls in the GPU export classes. Main-thread code
 * imports the light `*-tuning.mts` files directly instead.
 */
import type { ExporterKind, MeshExporter } from "./mesh-exporter.mjs"
import { mdcExporter } from "./mdc.mjs"
import { shrecExporter } from "./shrec.mjs"
import { flexicubesExporter } from "./flexicubes.mjs"
import { isoSimplicialExporter } from "./iso-simplicial/iso-exporter.mjs"
import { sfccExporter } from "./sfcc/sfcc-exporter.mjs"
import { sfccRsExporter } from "./sfcc-rs/sfcc-rs-exporter.mjs"

// Tuning types differ per exporter, so the map is heterogeneous; `any` here just
// lets the four concrete `MeshExporter<T>` values share one record type. The
// worker re-normalizes the incoming tuning blob through each exporter anyway.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EXPORTERS: Record<ExporterKind, MeshExporter<any>> = {
    mdc: mdcExporter,
    shrec: shrecExporter,
    isoSimplicial: isoSimplicialExporter,
    flexicubes: flexicubesExporter,
    sfcc: sfccExporter,
    "sfcc-rs": sfccRsExporter,
}

/** Look up the exporter for a kind, falling back to MDC for unknown values. */
export function getExporter(kind: ExporterKind | undefined): MeshExporter<unknown> {
    return EXPORTERS[kind ?? "mdc"] ?? EXPORTERS.mdc
}
