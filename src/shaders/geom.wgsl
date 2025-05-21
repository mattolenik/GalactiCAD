
// Return true if the 2D point p lies strictly inside triangle a–b–c.
fn pointInTriangle(
  p: vec2<f32>,
  a: vec2<f32>,
  b: vec2<f32>,
  c: vec2<f32>
) -> bool {
  let v0 = c - a;
  let v1 = b - a;
  let v2 = p - a;
  let d00 = dot(v0,v0);
  let d01 = dot(v0,v1);
  let d11 = dot(v1,v1);
  let d20 = dot(v2,v0);
  let d21 = dot(v2,v1);
  let denom = d00 * d11 - d01 * d01;
  if (denom == 0.0) { return false; }
  let inv = 1.0 / denom;
  let u = ( d11 * d20 - d01 * d21 ) * inv;
  let v = ( d00 * d21 - d01 * d20 ) * inv;
  return (u > 0.0) && (v > 0.0) && (u + v < 1.0);
}

// Return true if vertex i’s corner is convex (CCW winding)
fn isConvex(i: u32) -> bool {
  let pi = prevArr[i];
  let ni = nextArr[i];
  let Pp = loopVerts[startOff + pi];
  let Pc = loopVerts[startOff + i];
  let Pn = loopVerts[startOff + ni];
  let cross = (Pn.x - Pc.x) * (Pp.y - Pc.y)
            - (Pn.y - Pc.y) * (Pp.x - Pc.x);
  return cross > 0.0;
}

// Return true if no other loop vertex lies inside the triangle (pi, i, ni)
fn noOtherInside(i: u32, n: u32) -> bool {
  let pi = prevArr[i];
  let ni = nextArr[i];
  let A  = loopVerts[startOff + pi];
  let B  = loopVerts[startOff + i];
  let C  = loopVerts[startOff + ni];

  // walk the linked list of vertices
  var j = nextArr[i];
  loop {
    if (j == i) { break; }
    if (j != pi && j != ni) {
      let Pj = loopVerts[startOff + j];
      if (pointInTriangle(Pj, A, B, C)) {
        return false;
      }
    }
    j = nextArr[j];
  }
  return true;
}
