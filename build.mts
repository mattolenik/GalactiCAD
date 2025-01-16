import { webglPlugin } from "esbuild-plugin-webgl"
import * as esbuild from "esbuild"

const isProd = !!process.env.PRODUCTION

await esbuild.build({
    plugins: [webglPlugin()],
    outdir: "./dist",
    entryPoints: ["./sdf.mts"],
    bundle: true,
    platform: "neutral",
    target: "es2020",
    sourcemap: !isProd,
    minify: isProd,
})
