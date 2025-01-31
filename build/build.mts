import chokidar from "chokidar"
import * as esbuild from "esbuild"
import assetBundler from "./asset-bundler.mjs"
import wgslLoader from "./wgsl-loader.mjs"

const assets = ["*.html", "*.css"]
const entryPoints = ["./sdf.mts"]
const outdir = "./dist"

async function build() {
    const isProd = !!process.env.PRODUCTION
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

function watch() {
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
            log(`Build triggered by ${event}: ${path}`)
            await build()
        })
}

log("Building")
await build()

if (process.argv.includes("-w")) {
    log("Watching for changes")
    watch()
}

function log(msg: string) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`)
}
