// Rotate-convention check (plan §5). A long bar rotated about Z; mismatched Euler order/sign
// shows up immediately against the OpenSCAD reference render.
rotate([0, 0, 30]) cube([20, 4, 4], center = true);
