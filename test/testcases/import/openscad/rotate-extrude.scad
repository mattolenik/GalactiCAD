// rotate_extrude lathe-axis / orientation check. A washer/tube: a 4-wide x 10-tall square offset
// to inner radius 8, revolved about OpenSCAD's Z axis. Expect a ring/tube — inner radius 8, wall
// thickness 4 (outer radius 12), height 10 — correctly oriented after the Z-up->Y-up root xform.
rotate_extrude() translate([8, 0]) square([4, 10]);
