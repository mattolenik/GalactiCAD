// Empty stub for the Node built-ins (`path`, `fs`) that @typescript/vfs lazily
// requires in Node-only code paths the browser never executes (we drive it with an
// in-memory `createSystem(fsMap)`, not the disk helpers).
//
// vfs hides those requires behind `require(String.fromCharCode(...))` so bundlers
// don't pick them up — but esbuild's minifier (prod / electron-pack) constant-folds
// the char codes back into `require("path")` / `require("fs")` and then fails to
// resolve a Node built-in for the browser target. Aliasing both to this empty module
// keeps the (uncalled) code resolvable. If it were ever called it'd just see `{}`.
export default {}
