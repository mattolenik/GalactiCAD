//! Scene / node graph.
//!
//! Port target: `src/scene/` (the `Node` base, `primitives/`, `operators/`,
//! transforms). Design: a build-once / read-many `enum` of node variants held in
//! an index-based arena (`Vec<Node>`, children referenced by index) — no
//! `Rc`/`RefCell`, no borrow-checker friction. Constructed from a serialized
//! scene description handed across the WASM boundary.
//!
//! TODO: port incrementally; validate WGSL byte-diff + f64 eval against the TS
//! reference, one node type at a time.
