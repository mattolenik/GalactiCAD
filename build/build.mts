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
            bundle: true,
            entryPoints: ["./sdf.mts"],
            minify: isProd,
            outdir: "./dist",
            platform: "neutral",
            plugins: [wgslLoader(), assetBundler(assets)],
            sourcemap: !isProd,
            target: "es2020",
        })
        console.log("🌱🐢")
    } catch {
        /* do nothing — esbuild already nicely writes to stdout for us */
    }
}

await build()

if (isWatch) {
    const location = "."
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
}
