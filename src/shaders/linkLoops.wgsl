struct Params2 { maxSeg: u32, hashSize: u32, };
@group(0) @binding(0) var<uniform> params: Params2;
@group(0) @binding(1) var<storage, read>           segments:   array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write>     segCount: atomic<u32>;
// ← HEAD is now an array of atomic<i32>
@group(0) @binding(3) var<storage, read_write>     head:       array<atomic<i32>>;
// NEXT remains plain i32
@group(0) @binding(4) var<storage, read_write>     nextIdx:    array<i32>;
// visited can stay as u32
@group(0) @binding(5) var<storage, read_write>     visited:    array<u32>;
// loop buffers
@group(0) @binding(6) var<storage, read_write>     loopSegs:   array<i32>;
@group(0) @binding(7) var<storage, read_write>     loopStarts: array<i32>;
// loopCount is already atomic<u32>
@group(0) @binding(8) var<storage, read_write>     loopCount:  atomic<u32>;


fn hashPt(p: vec2<f32>) -> u32 {
  // simple grid‐quantize + mod hash
  let x = u32(round(p.x)) % params.hashSize;
  let y = u32(round(p.y)) % params.hashSize;
  return (x + y * 73856093u) % params.hashSize;
}

@compute @workgroup_size(256)
fn buildHash(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.x;
  if (id >= params.maxSeg) { return; }
  let p0 = segments[id * 2u + 0u];
  let h0 = hashPt(p0);

  // now head[h0] is atomic<i32>, so this works:
  let old0 = atomicExchange(&head[h0], i32(id));
  nextIdx[id] = old0;
}

@compute @workgroup_size(1)
fn linkAll() {
  // one thread walks all loops
  let total = atomicLoad(&segCount);  // from pass 2
  var outPos = 0;
  for (var start = 0u; start < total; start = start + 1u) {
    if (visited[start] != 0u) { continue; }
    let loopId = atomicAdd(&loopCount, 1u);
    loopStarts[loopId] = outPos;

    var cur = i32(start);
    loop {
      visited[u32(cur)] = 1u;
      loopSegs[u32(outPos)] = cur;
      outPos = outPos + 1;
      // find next segment: match cur’s second endpoint
      let p1 = segments[u32(cur)*2u + 1u];
      let h1 = hashPt(p1);
      var next = atomicLoad(&head[h1]);
      // walk chain until find segment that hasn’t been visited and shares p1
      while (next >= 0) {
        // compare points
        let q0 = segments[u32(next)*2u + 0u];
        let q1 = segments[u32(next)*2u + 1u];
        if (distance(q0, p1) < 1e-3 || distance(q1, p1) < 1e-3) {
          break;
        }
        next = nextIdx[u32(next)];
      }
      if (next < 0 || next == cur) { break; }
      cur = next;
    }
  }
}
