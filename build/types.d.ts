declare module "*.wgsl" {
    const value: string
    export default value
}
declare module "*.svg" {
    const value: string
    export default value
}
declare module "*.wasm" {
    // esbuild `file` loader → a served URL string for the binary.
    const value: string
    export default value
}