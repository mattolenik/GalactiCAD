import type { Plugin, PluginBuild } from "esbuild"
import * as esbuild from "esbuild"
import fs from "node:fs"

const isProd = !!process.env.PRODUCTION

// Load GL shaders as text
const glslPlugin: () => Plugin = () => ({
    name: "glsl-loader",
    setup(build: PluginBuild) {
        build.onLoad({ filter: /\.(glsl)|(vert)|(frag)$/, namespace: "file" }, (args) => {
            const contents = fs.readFileSync(args.path, "utf8")
            return { contents, loader: "text" }
        })
    },
})

await esbuild.build({
    plugins: [glslPlugin()],
    outdir: "./dist",
    entryPoints: ["./sdf.mts"],
    bundle: true,
    platform: "neutral",
    target: "es2020",
    sourcemap: !isProd,
    minify: isProd,
})
