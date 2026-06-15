// Z-up → Y-up check (plan §5.1). Strongly asymmetric along Z with a cap at the +Z top, so the
// up direction is visually unambiguous. After import the cap must sit on gcad's +Y.
cube([6, 6, 24], center = true);
translate([0, 0, 12]) cube([12, 12, 2], center = true);
