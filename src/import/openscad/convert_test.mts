import assert from "node:assert/strict"
import test from "node:test"
import { convertOpenScadToGcad } from "./convert.mjs"
import { gatherIncludeSources } from "./include-gather.mjs"

function dslOf(src: string): string {
    const { dsl, diagnostics } = convertOpenScadToGcad(src)
    assert.equal(diagnostics.length, 0, `unexpected diagnostics: ${JSON.stringify(diagnostics)}`)
    return dsl
}

test("every import is wrapped in the Z-up→Y-up root transform", () => {
    assert.match(dslOf("cube(1);"), /return rotate\(\[-90, 0, 0\], /)
})

test("cube (corner origin) → box with half-size shift", () => {
    assert.match(dslOf("cube([2,4,6]);"), /box\(\[1, 2, 3\]\)\.shift\(\[1, 2, 3\]\)/) // gcad box = half-extents
})

test("cube(center=true) → centered box, no shift", () => {
    const dsl = dslOf("cube([2,2,2], center=true);")
    assert.match(dsl, /box\(\[1, 1, 1\]\)/) // half-extents
    assert.doesNotMatch(dsl, /\.shift/)
})

test("sphere(d=) → radius is half the diameter", () => {
    assert.match(dslOf("sphere(d=4);"), /sphere\.radius\(2\)/)
})

test("cylinder is centered onto gcad's centered primitive", () => {
    assert.match(dslOf("cylinder(h=10, r=3);"), /cylinder\.radius\(3\)\.height\(5\)\.shift\(\[0, 0, 5\]\)/) // half-height
})

test("translate wraps its child", () => {
    assert.match(dslOf("translate([1,0,0]) sphere(2);"), /translate\(\[1, 0, 0\], sphere\.radius\(2\)\)/)
})

test("scalar rotate spins about Z", () => {
    assert.match(dslOf("rotate(45) cube(1);"), /rotate\(\[0, 0, 45\], /)
})

test("rotate Euler angles pass through unchanged (gcad shares OpenSCAD's convention)", () => {
    // gcad's rotate matches OpenSCAD's (Rz·Ry·Rx); verified numerically + via the oracle's Z-up
    // baseline. So a multi-axis rotate imports verbatim — no Euler re-mapping.
    assert.match(dslOf("rotate([30,40,50]) cube([24,6,2], center=true);"), /rotate\(\[30, 40, 50\], box/)
})

test("difference → subtract(base, ...cutters)", () => {
    assert.match(dslOf("difference(){ cube(10, center=true); sphere(6); }"), /subtract\(box\(\[5, 5, 5\]\), sphere\.radius\(6\)\)/)
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

test("user module: declaration + call with a passed parameter", () => {
    assert.match(dslOf("module post(h){ cylinder(h=h, r=2); } post(10);"), /cylinder\.radius\(2\)\.height\(5\)/)
})

test("user module: default parameter value", () => {
    assert.match(dslOf("module b(s=4){ cube(s); } b();"), /box\(\[2, 2, 2\]\)\.shift\(\[2, 2, 2\]\)/)
})

test("user module: named arguments bind by name regardless of order", () => {
    assert.match(dslOf("module foo(a,b){ translate([a,0,0]) cube(b); } foo(b=2, a=4);"), /translate\(\[4, 0, 0\], box\(\[1, 1, 1\]\)/)
})

test("user module: forward reference (call before definition)", () => {
    assert.match(dslOf("ball(); module ball(){ sphere(3); }"), /sphere\.radius\(3\)/)
})

test("children(): single child is spliced into the module body", () => {
    assert.match(dslOf("module m(){ children(); } m() sphere(3);"), /sphere\.radius\(3\)/)
})

test("children(): used twice → child geometry appears twice", () => {
    const dsl = dslOf("module two(){ children(); translate([5,0,0]) children(); } two() cube(1);")
    assert.equal((dsl.match(/box\(/g) ?? []).length, 2)
})

test("user function: expression body", () => {
    assert.match(dslOf("function sq(x) = x*x; sphere(sq(3));"), /sphere\.radius\(9\)/)
})

test("user function: recursion terminates and computes", () => {
    assert.match(dslOf("function fact(n) = n<=1 ? 1 : n*fact(n-1); sphere(fact(4));"), /sphere\.radius\(24\)/)
})

test("infinite recursion is depth-guarded, not a hang or crash", () => {
    const { diagnostics } = convertOpenScadToGcad("module r(){ r(); } r();")
    assert.ok(diagnostics.some(d => /recursion limit/i.test(d.message)), "expected a recursion-limit diagnostic")
})

test("include: inlines the file's modules and geometry", () => {
    const lib = "module widget(){ sphere(3); }"
    const { dsl, diagnostics } = convertOpenScadToGcad("include <lib.scad>\n widget();", "main.scad", new Map([["lib.scad", lib]]))
    assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics))
    assert.match(dsl, /sphere\.radius\(3\)/)
})

test("include: brings the file's top-level variables", () => {
    const { dsl } = convertOpenScadToGcad("include <c.scad>\n sphere(R);", "main.scad", new Map([["c.scad", "R = 5;"]]))
    assert.match(dsl, /sphere\.radius\(5\)/)
})

test("use: brings definitions only, not the file's top-level geometry", () => {
    const lib = "module w(){ cube(2); } sphere(99);"
    const { dsl } = convertOpenScadToGcad("use <lib.scad>\n w();", "main.scad", new Map([["lib.scad", lib]]))
    assert.match(dsl, /box\(\[1, 1, 1\]\)/) // cube(2) → half-extents
    assert.doesNotMatch(dsl, /sphere\.radius\(99\)/)
})

test("include: forward reference (call before the include line) resolves", () => {
    const { dsl } = convertOpenScadToGcad("widget(); include <lib.scad>", "main.scad", new Map([["lib.scad", "module widget(){ sphere(3); }"]]))
    assert.match(dsl, /sphere\.radius\(3\)/)
})

test("unresolved include is a diagnostic, not fatal", () => {
    const { dsl, diagnostics } = convertOpenScadToGcad("include <missing.scad>\n cube(1);", "main.scad")
    assert.ok(diagnostics.some(d => /could not resolve include <missing\.scad>/.test(d.message)))
    assert.match(dsl, /box\(/) // the cube still imports
})

test("gatherIncludeSources walks the transitive include graph", async () => {
    const files: Record<string, string> = {
        "a.scad": "include <b.scad>\n module fromA(){ cube(1); }",
        "b.scad": "module fromB(){ sphere(1); }",
    }
    const sources = await gatherIncludeSources("include <a.scad>", path => Promise.resolve(files[path] ?? null))
    assert.deepEqual([...sources.keys()].sort(), ["a.scad", "b.scad"])
})

test("gatherIncludeSources skips unresolved refs (resolver returns null)", async () => {
    const sources = await gatherIncludeSources("use <nope.scad>", () => Promise.resolve(null))
    assert.equal(sources.size, 0)
})

test("expr: element-wise vector addition", () => {
    assert.match(dslOf("translate([1,2,3] + [10,0,0]) sphere(1);"), /translate\(\[11, 2, 3\], sphere\.radius\(1\)\)/)
})

test("expr: scalar × vector", () => {
    assert.match(dslOf("translate(2 * [1,2,3]) sphere(1);"), /translate\(\[2, 4, 6\], /)
})

test("expr: vector ÷ scalar", () => {
    assert.match(dslOf("translate([2,4,6] / 2) sphere(1);"), /translate\(\[1, 2, 3\], /)
})

test("expr: dot product (vector × vector)", () => {
    assert.match(dslOf("sphere([1,2,3] * [4,5,6]);"), /sphere\.radius\(32\)/) // 4+10+18
})

test("expr: matrix × vector", () => {
    // diagonal scaling matrix × [1,1,1] = [2,3,1]; observed directly through translate
    assert.match(dslOf("translate([[2,0,0],[0,3,0],[0,0,1]] * [1,1,1]) sphere(1);"), /translate\(\[2, 3, 1\], sphere\.radius\(1\)\)/)
})

test("expr: len() of a list and a string", () => {
    assert.match(dslOf("cube([len([1,2,3,4]), len(\"ab\"), 1]);"), /box\(\[2, 1, 0.5\]\)/) // cube([4,2,1]) → half-extents
})

test("expr: concat() flattens one level", () => {
    assert.match(dslOf("cube(concat([2,2],[2]));"), /box\(\[1, 1, 1\]\)\.shift\(\[1, 1, 1\]\)/)
})

test("expr: norm() of a vector", () => {
    assert.match(dslOf("sphere(norm([3,4]));"), /sphere\.radius\(5\)/)
})

test("expr: min/max accept a single list argument", () => {
    assert.match(dslOf("cube([max([1,5,2]), min(3,1,2), 1]);"), /box\(\[2.5, 0.5, 0.5\]\)/) // cube([5,1,1]) → half-extents
})

test("expr: is_undef on an undefined name does NOT emit an undefined-variable diagnostic", () => {
    const { dsl, diagnostics } = convertOpenScadToGcad("r = is_undef(foo) ? 5 : 1; sphere(r);")
    assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics))
    assert.match(dsl, /sphere\.radius\(5\)/)
})

test("expr: undef propagates through arithmetic without a diagnostic", () => {
    const { dsl, diagnostics } = convertOpenScadToGcad("y = undef; v = y * 2; sphere(is_undef(v) ? 9 : 1);")
    assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics))
    assert.match(dsl, /sphere\.radius\(9\)/)
})

test("expr: member lookup (.x/.y/.z)", () => {
    assert.match(dslOf("v=[1,2,3]; translate([v.x, v.y, v.z]) sphere(1);"), /translate\(\[1, 2, 3\], sphere\.radius\(1\)\)/)
})

test("expr: array index v[i]", () => {
    assert.match(dslOf("v=[5,6,7]; sphere(v[1]);"), /sphere\.radius\(6\)/)
})

test("expr: out-of-range index is undef, graceful (no diagnostic)", () => {
    const { dsl, diagnostics } = convertOpenScadToGcad("v=[1,2]; sphere(v[5]);")
    assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics))
    assert.match(dsl, /sphere\.radius\(1\)/) // undef radius falls back to default 1
})

test("comprehension: for builds a list consumed by a statement-level for", () => {
    const dsl = dslOf("for (x = [for (i=[0:3]) i*2]) translate([x,0,0]) cube(1);")
    assert.equal((dsl.match(/box\(/g) ?? []).length, 4)
    assert.match(dsl, /translate\(\[6, 0, 0\]/)
})

test("comprehension: each spreads a sublist", () => {
    assert.match(dslOf("v = [each [1,2,3], 4]; sphere(v[3]);"), /sphere\.radius\(4\)/)
})

test("comprehension: if filters elements", () => {
    assert.match(dslOf("cube(len([for (i=[0:4]) if (i % 2 == 0) i]));"), /box\(\[1.5, 1.5, 1.5\]\)/) // [0,2,4] → len 3 → cube(3) → half
})

test("comprehension: let binds within the comprehension", () => {
    assert.match(dslOf("v = [for (i=[0:1]) let(j = i + 10) j]; sphere(v[1]);"), /sphere\.radius\(11\)/)
})

test("comprehension: nested for is a cartesian product", () => {
    // 3 × 2 = 6 elements
    assert.match(dslOf("cube(len([for (i=[0:2], j=[0:1]) i]));"), /box\(\[3, 3, 3\]\)/) // len 6 → cube(6) → half
})

test("linear_extrude circle → cylinder (idiom, not centered)", () => {
    assert.match(dslOf("linear_extrude(10) circle(3);"), /cylinder\.radius\(3\)\.height\(5\)\.shift\(\[0, 0, 5\]\)/)
})

test("linear_extrude(center=true) → no z-shift", () => {
    const dsl = dslOf("linear_extrude(10, center=true) circle(3);")
    assert.match(dsl, /cylinder\.radius\(3\)\.height\(5\)/)
    assert.doesNotMatch(dsl, /shift/)
})

test("linear_extrude square → box (idiom)", () => {
    assert.match(dslOf("linear_extrude(4) square([2,3]);"), /box\(\[1, 1.5, 2\]\)\.shift\(\[1, 1.5, 2\]\)/)
})

test("linear_extrude polygon → extrude.profile", () => {
    assert.match(
        dslOf("linear_extrude(5) polygon([[0,0],[10,0],[5,8]]);"),
        /extrude\.profile\(polygon2d\(\[0, 0\], \[10, 0\], \[5, 8\]\)\)\.height\(2\.5\)\.shift\(\[0, 0, 2\.5\]\)/,
    )
})

test("linear_extrude twist on a square → extrude with .twist", () => {
    assert.match(dslOf("linear_extrude(10, twist=90) square([2,2], center=true);"), /\.height\(5\)\.twist\(90\)/)
})

test("linear_extrude distributes over a 2D difference (ring)", () => {
    assert.match(dslOf("linear_extrude(4) difference(){ circle(5); circle(3); }"), /subtract\(cylinder\.radius\(5\).*cylinder\.radius\(3\)/)
})

test("linear_extrude pushes through a 2D translate", () => {
    assert.match(dslOf("linear_extrude(4) translate([2,0]) square(1);"), /translate\(\[2, 0, 0\], box\(\[0.5, 0.5, 2\]\)/)
})

test("rotate_extrude polygon → lathe.profile", () => {
    assert.match(dslOf("rotate_extrude() polygon([[2,0],[4,0],[3,5]]);"), /lathe\.profile\(polygon2d\(\[2, 0\], \[4, 0\], \[3, 5\]\)\)/)
})

test("bare 2D geometry (no extrude) is flagged", () => {
    const { diagnostics } = convertOpenScadToGcad("circle(5);")
    assert.ok(diagnostics.some(d => /2D geometry must be extruded/.test(d.message)))
})

test("text() is stubbed as a 10×10×10 cube placeholder (with a diagnostic)", () => {
    const { dsl, diagnostics } = convertOpenScadToGcad("text(\"hi\");")
    assert.match(dsl, /box\(\[5, 5, 5\]\)\.shift\(\[5, 5, 5\]\)/) // cube([10,10,10]) → half-extents
    assert.ok(diagnostics.some(d => /text\(\) not supported/.test(d.message)))
})

test("linear_extrude(text()) keeps the cube stub (not dropped by the extrude)", () => {
    const { dsl } = convertOpenScadToGcad("linear_extrude(5) text(\"hi\");")
    assert.match(dsl, /box\(\[5, 5, 5\]\)\.shift\(\[5, 5, 5\]\)/)
})
