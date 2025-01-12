import { webglPlugin } from "esbuild-plugin-webgl";
import * as esbuild from "esbuild";

await esbuild.build({
    plugins: [webglPlugin()],
    outdir: "./dist",
    entryPoints: ["./sdf.mts"],
    bundle: true,
    platform: "neutral",
    target: "es2020",
    sourcemap: true,
    minify: false,
});
