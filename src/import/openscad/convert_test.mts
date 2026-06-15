import assert from "node:assert/strict"
import test from "node:test"
import { convertOpenScadToGcad } from "./convert.mjs"

function dslOf(src: string): string {
    const { dsl, diagnostics } = convertOpenScadToGcad(src)
    assert.equal(diagnostics.length, 0, `unexpected diagnostics: ${JSON.stringify(diagnostics)}`)
    return dsl
}

test("every import is wrapped in the Z-up→Y-up root transform", () => {
    assert.match(dslOf("cube(1);"), /return rotate\(\[-90, 0, 0\], /)
})

test("cube (corner origin) → box with half-size shift", () => {
    assert.match(dslOf("cube([2,4,6]);"), /box\(\[2, 4, 6\]\)\.shift\(\[1, 2, 3\]\)/)
})

test("cube(center=true) → centered box, no shift", () => {
    const dsl = dslOf("cube([2,2,2], center=true);")
    assert.match(dsl, /box\(\[2, 2, 2\]\)/)
    assert.doesNotMatch(dsl, /\.shift/)
})

test("sphere(d=) → radius is half the diameter", () => {
    assert.match(dslOf("sphere(d=4);"), /sphere\.radius\(2\)/)
})

test("cylinder is centered onto gcad's centered primitive", () => {
    assert.match(dslOf("cylinder(h=10, r=3);"), /cylinder\.radius\(3\)\.height\(10\)\.shift\(\[0, 0, 5\]\)/)
})

test("translate wraps its child", () => {
    assert.match(dslOf("translate([1,0,0]) sphere(2);"), /translate\(\[1, 0, 0\], sphere\.radius\(2\)\)/)
})

test("scalar rotate spins about Z", () => {
    assert.match(dslOf("rotate(45) cube(1);"), /rotate\(\[0, 0, 45\], /)
})

test("difference → subtract(base, ...cutters)", () => {
    assert.match(dslOf("difference(){ cube(10, center=true); sphere(6); }"), /subtract\(box\(\[10, 10, 10\]\), sphere\.radius\(6\)\)/)
})

test("union of multiple children", () => {
    const dsl = dslOf("union(){ cube(1); translate([2,0,0]) cube(1); }")
    assert.match(dsl, /^.*union\(box\(.*\), translate\(\[2, 0, 0\], box\(.*\)\)\)/m)
})

test("variable assignment resolves in expressions", () => {
    assert.match(dslOf("r = 3; sphere(r);"), /sphere\.radius\(3\)/)
})

test("for-loop unrolls into repeated geometry", () => {
    const dsl = dslOf("for (i=[0:2]) translate([i,0,0]) cube(1);")
    assert.equal((dsl.match(/box\(/g) ?? []).length, 3)
})

test("unsupported module is dropped and reported, not fatal", () => {
    const { dsl, diagnostics } = convertOpenScadToGcad("minkowski(){ cube(1); sphere(1); }")
    assert.ok(diagnostics.some(d => /minkowski/i.test(d.message)), "expected a minkowski diagnostic")
    assert.match(dsl, /not fully imported/) // header comment is emitted
})

test("parse errors surface as diagnostics", () => {
    const { diagnostics } = convertOpenScadToGcad("cube([1,2,3")
    assert.ok(diagnostics.some(d => d.severity === "error"))
})
