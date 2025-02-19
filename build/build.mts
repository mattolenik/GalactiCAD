import chokidar from "chokidar"
import * as esbuild from "esbuild"
import assetBundler from "./asset-bundler.mjs"
import { DevServer } from "./server.mjs"
import wgslLoader from "./wgsl-loader.mjs"

const assets = ["src/**/*.html", "src/**/*.css"]
const entryPoints = ["./src/sdf.mts"]
const outdir = "./dist"

const port = parseInt(process.env.PORT || "6900", 10)
const liveReloadPort = parseInt(process.env.PORT_LIVERELOAD || "6909", 10)

const log = (msg: any) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`)

async function build() {
    const isProd = !!process.env.PRODUCTION
    const startTime = performance.now()
    try {
        await esbuild.build({
            bundle: true,
            entryPoints: entryPoints,
            minify: isProd,
            outdir: outdir,
            platform: "neutral",
            plugins: [wgslLoader(), assetBundler(assets, log)],
            sourcemap: !isProd,
            target: "es2023",
        })
        const elapsed = performance.now() - startTime
        log(`🌱🐢 ${elapsed.toFixed(2)}ms`)
        return true
    } catch (e) {
        const elapsed = performance.now() - startTime
        console.log(e)
        log(`❌🐢 ${elapsed.toFixed(2)}ms`)
        return false
    }
}

function watch(location: string, onChange: () => Promise<void>) {
    return chokidar
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
            onChange()
        })
}

switch (process.argv[2]) {
    case "port":
        console.log(port)
        process.exit()
}

log("Building")
if (!(await build())) {
    process.exit(1)
}

if (process.argv.includes("-w")) {
    log("Watching for changes")
    let server = new DevServer(outdir, port, liveReloadPort)
    let watcher = watch(".", async () => {
        await build()
        server.reload()
    })

    const shutdown = async () => {
        await watcher.close()
        server.close()
        process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
}
