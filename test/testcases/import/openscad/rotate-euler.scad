// Multi-axis rotate Euler-ORDER check. OpenSCAD applies rotations as Rz·Ry·Rx (X first, then Y,
// then Z). A strongly asymmetric bar makes the composed orientation unambiguous: if gcad's Euler
// order/convention differs from OpenSCAD, the bar points the wrong way against the reference.
rotate([30, 40, 50]) cube([24, 6, 2], center = true);
