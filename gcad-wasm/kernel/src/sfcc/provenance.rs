//! Semantic fingerprints for immutable field expressions and patch domains.
//! These are build-local wire identities, not persistent CAD object IDs. Both
//! worker endpoints run the same kernel; protocol versions gate representation
//! changes. Dense curve IDs are only indices within a matching fingerprint.
use std::{
    collections::HashMap,
    fmt::{self, Write},
};

pub(crate) struct IdentityHash(pub u64);
impl Default for IdentityHash {
    fn default() -> Self {
        Self(0xcbf29ce484222325)
    }
}
impl Write for IdentityHash {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        for byte in s.bytes() {
            self.0 = (self.0 ^ byte as u64).wrapping_mul(0x100000001b3);
        }
        Ok(())
    }
}
impl IdentityHash {
    pub fn include(&mut self, value: impl fmt::Debug) {
        write!(self, "{value:?};").unwrap();
    }
}

/// Memoize shared source trees while hashing a feature set. Pointer addresses
/// are cache keys only and never enter the semantic fingerprint.
#[derive(Default)]
pub(crate) struct IdentityContext {
    pub roots: HashMap<usize, u64>,
}
