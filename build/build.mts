import chokidar from "chokidar"
import * as esbuild from "esbuild"
import assetBundler from "./asset-bundler.mjs"
import { devServer, liveReload } from "./server.mjs"
import wgslLoader from "./wgsl-loader.mjs"

const assets = ["*.html", "*.css"]
const entryPoints = ["./sdf.mts"]
const outdir = "./dist"

const port = parseInt(process.env.PORT || "6900", 10)
const portLiveReload = parseInt(process.env.PORT_LIVERELOAD || "6909", 10)

async function build() {
    const isProd = !!process.env.PRODUCTION
    try {
        const startTime = performance.now()
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
        const elapsed = performance.now() - startTime
        console.log(`🌱🐢 ${elapsed.toFixed(2)}ms\n`)
    } catch {
        /* do nothing — esbuild already nicely writes to stdout for us */
    }
}

function watch(location: string, onRebuild: () => void) {
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
            await build()
            onRebuild()
        })
}

function log(msg: string) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`)
}

switch (process.argv[2]) {
    case "port":
        console.log(port)
        process.exit()
}

log("Building")
await build()

if (process.argv.includes("-w")) {
    log("Watching for changes")
    let server = devServer(port, "./dist")
    let lrServer = liveReload(portLiveReload)
    let watcher = watch(".", () => lrServer.clients.forEach((client) => client.send("reload")))

    process.on("SIGINT", async () => {
        server.closeAllConnections()
        await watcher.close()
        lrServer.close()
        process.exit(0)
    })
}
