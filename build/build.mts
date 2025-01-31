import * as esbuild from "esbuild"
import { wgslLoader } from "./wgsl-loader.mjs"
import { assetBundler } from "./asset-bundler.mjs"
import chokidar from "chokidar"

const isProd = !!process.env.PRODUCTION

const isWatch = process.argv.includes("-w")

const assets = ["sdf.html"]

async function build() {
    try {
        await esbuild.build({
            plugins: [wgslLoader(), assetBundler(assets)],
            outdir: "./dist",
            entryPoints: ["./sdf.mts"],
            bundle: true,
            platform: "neutral",
            target: "es2020",
            sourcemap: !isProd,
            minify: isProd,
        })
        console.log("🌱🐢")
    } catch {}
}

if (isWatch) {
    const location = "."
    await build()
    chokidar
        .watch(location, {
            atomic: true,
            cwd: ".",
            followSymlinks: true,
            ignored: [".git", "dist", "node_modules"],
            ignoreInitial: true,
            persistent: true,
        })
        .on("all", async (event, path) => {
            console.log(`Rebuild triggered by ${event}: ${path}`)
            await build()
        })
} else {
    await build()
}
