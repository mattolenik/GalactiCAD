// CLI: convert an OpenSCAD .scad file to gcad DSL on stdout (diagnostics on stderr).
// Usage: node_modules/.bin/tsx scripts/scad-to-gcad.mts FILE.scad
import { readFileSync } from "node:fs"
import { convertOpenScadToGcad } from "../src/import/openscad/convert.mjs"

const path = process.argv[2]
if (!path) {
    process.stderr.write("usage: scad-to-gcad <file.scad>\n")
    process.exit(2)
}
const { dsl, diagnostics } = convertOpenScadToGcad(readFileSync(path, "utf8"), path)
for (const d of diagnostics) {
    process.stderr.write(`[${d.severity}] ${d.message}${d.line ? ` (${d.line}:${d.col})` : ""}\n`)
}
process.stdout.write(dsl)
