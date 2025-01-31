import chokidar from "chokidar"
import * as esbuild from "esbuild"
import { assetBundler } from "./asset-bundler.mjs"
import { wgslLoader } from "./wgsl-loader.mjs"

const isProd = !!process.env.PRODUCTION
const ts = () => new Date().toLocaleTimeString()

const assets = ["*.html", "*.css"]
const entryPoints = ["./sdf.mts"]
const outdir = "./dist"

async function build() {
    try {
        await esbuild.build({
            bundle: true,
            entryPoints: entryPoints,
            minify: isProd,
            outdir: outdir,
            platform: "neutral",
            plugins: [wgslLoader(), assetBundler(assets)],
            sourcemap: !isProd,
            target: "es2020",
        })
        console.log("🌱🐢\n")
    } catch {
        /* do nothing — esbuild already nicely writes to stdout for us */
    }
}

console.log(`[${ts()}] Building`)
await build()

const isWatch = process.argv.includes("-w")
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
            console.log(`[${ts()}] Build triggered by ${event}: ${path}`)
            await build()
        })
}
