import * as esbuild from "esbuild"
import { wgslLoader } from "./wgsl-loader.mjs"

const isProd = !!process.env.PRODUCTION

await esbuild.build({
    plugins: [wgslLoader()],
    outdir: "./dist",
    entryPoints: ["./sdf.mts"],
    bundle: true,
    platform: "neutral",
    target: "es2020",
    sourcemap: !isProd,
    minify: isProd,
})
