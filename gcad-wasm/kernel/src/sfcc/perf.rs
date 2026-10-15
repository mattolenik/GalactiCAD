//! Optional diagnostic work counters. Disabled calls disappear in release builds.
//! Indices: winner scalar evaluations, query scalar misses, query raw misses,
//! query hits, exact fallbacks, exact-zero shortcuts, limb heap allocations,
//! maximum limb length, patch preparations, coarse retries, classification hits,
//! retained lattice hits, scalar composition calls, raw composition calls,
//! reference limb allocation sites, boundary projection hits, workspace grows,
//! workspace reuses. Discovery counters 18..30: calls, traversal nodes, cell
//! interval queries, retained supported candidates, point/edge/face queries,
//! split/indeterminate results, peak pending entries, root sign-walk nodes,
//! strict root exclusions, all discovery interval calls. These are work counts, not correctness diagnostics.
#[cfg(feature = "sfcc-profile")]
thread_local! { static COUNTS: std::cell::Cell<[usize;31]> = const { std::cell::Cell::new([0;31]) }; }

#[inline]
pub(crate) fn add(index: usize, amount: usize) {
    #[cfg(feature = "sfcc-profile")]
    COUNTS.with(|c| {
        let mut n = c.get();
        n[index] = n[index].saturating_add(amount);
        c.set(n);
    });
    #[cfg(not(feature = "sfcc-profile"))]
    let _ = (index, amount);
}
#[inline]
pub(crate) fn maximum(index: usize, value: usize) {
    #[cfg(feature = "sfcc-profile")]
    COUNTS.with(|c| {
        let mut n = c.get();
        n[index] = n[index].max(value);
        c.set(n);
    });
    #[cfg(not(feature = "sfcc-profile"))]
    let _ = (index, value);
}
#[cfg(feature = "sfcc-profile")]
pub fn reset() {
    COUNTS.with(|c| c.set([0; 31]));
}
#[cfg(feature = "sfcc-profile")]
pub fn snapshot() -> [usize; 31] {
    COUNTS.with(|c| c.get())
}

// Diagnostic ablations: selection=1, predicates=2, query cache=4,
// prepared patches=8, recovery caches=16. No branch remains in normal builds.
#[cfg(feature = "sfcc-profile")]
thread_local! { static DISABLED: std::cell::Cell<u32> = const { std::cell::Cell::new(0) }; }
#[inline]
pub(crate) fn disabled(bit: u32) -> bool {
    #[cfg(feature = "sfcc-profile")]
    {
        DISABLED.with(|d| d.get() & bit != 0)
    }
    #[cfg(not(feature = "sfcc-profile"))]
    {
        let _ = bit;
        false
    }
}
#[cfg(feature = "sfcc-profile")]
pub fn set_disabled(bits: u32) {
    DISABLED.with(|d| d.set(bits));
}
