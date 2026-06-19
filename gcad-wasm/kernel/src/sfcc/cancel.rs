//! Cooperative cancellation for the SFCC export.
//!
//! The export is one long synchronous call, so it can't be interrupted by a message
//! (the worker is blocked inside it). Instead the wasm `export_sfcc` installs a hook
//! that reads a JS-side cancel flag (a `SharedArrayBuffer` the main thread writes when
//! the user clicks Cancel); the long phases poll [`is_cancelled`] and bail out early,
//! and [`crate::sfcc::pipeline::run_sfcc_pipeline`] returns a result flagged `cancelled`.
//!
//! Checkpoints (coarse enough to be free, fine enough to feel responsive): once per
//! octree refinement round, every ~1k leaves during face contouring, and at each phase
//! boundary in the pipeline driver.
//!
//! Thread-local because the serial export path is single-threaded; on every other path
//! (native tests, the partitioned/threaded builds, anything that never installs a hook)
//! `is_cancelled()` is always `false`, so there is zero behavior change.

use std::cell::RefCell;

thread_local! {
    static CANCEL: RefCell<Option<Box<dyn Fn() -> bool>>> = const { RefCell::new(None) };
}

/// Install (`Some`) or clear (`None`) the cancel-check hook for the current thread.
/// Prefer [`CancelGuard`] so the hook is always cleared, even on an early return/panic.
pub fn set_hook(hook: Option<Box<dyn Fn() -> bool>>) {
    CANCEL.with(|c| *c.borrow_mut() = hook);
}

/// Whether cancellation has been requested. `false` when no hook is installed.
#[inline]
pub fn is_cancelled() -> bool {
    CANCEL.with(|c| c.borrow().as_ref().is_some_and(|f| f()))
}

/// Installs a hook on construction and clears it on drop, so a cancel hook can never
/// leak from one export into the next on the same thread.
pub struct CancelGuard;

impl CancelGuard {
    pub fn install(hook: Box<dyn Fn() -> bool>) -> Self {
        set_hook(Some(hook));
        CancelGuard
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        set_hook(None);
    }
}
