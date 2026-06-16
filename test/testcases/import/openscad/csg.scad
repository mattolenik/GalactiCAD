// CSG core: union + difference + intersection, transforms, and a for-loop.
difference() {
    union() {
        cube([20, 20, 6], center = true);
        translate([0, 0, 3]) cylinder(h = 8, r = 6, center = true);
    }
    for (a = [-1, 1])
        translate([a * 7, 0, 0]) cylinder(h = 20, r = 1.5, center = true);
}
