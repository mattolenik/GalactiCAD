import chokidar from "chokidar"
import * as esbuild from "esbuild"
import assetBundler from "./asset-bundler.mjs"
import { DevServer } from "./server.mjs"
import wgslLoader from "./wgsl-loader.mjs"
import path from "path"

const ASSETS = ["src/**/*.html", "src/**/*.css"]
const ENTRY_POINTS = ["./src/sdf.mts"]
const OUT_DIR = "./dist"
const IS_PROD = !!process.env.PRODUCTION
const BUILD_DIR = "./build"

const port = parseInt(process.env.PORT || "6900", 10)
const liveReloadPort = parseInt(process.env.PORT_LIVERELOAD || "6909", 10)

const log = (msg: any) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`)

async function build() {
    const startTime = performance.now()
    try {
        await esbuild.build({
            bundle: true,
            entryPoints: ENTRY_POINTS,
            minify: IS_PROD,
            outdir: OUT_DIR,
            platform: "neutral",
            plugins: [wgslLoader(), assetBundler(ASSETS, log)],
            sourcemap: !IS_PROD,
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
            ignored: [".DS_Store", ".hg", ".git", OUT_DIR, "node_modules"],
            ignoreInitial: true,
            persistent: true,
        })
        .on("all", async (event, fpath) => {
            // Only rebuild if REBUILD_STATUS is set, which defines the exit code to use
            const retryExitCode = process.env.REBUILD_STATUS
            if (retryExitCode) {
                const relBuildDir = path.basename(path.join(fpath, BUILD_DIR))
                if (fpath.startsWith(relBuildDir) || fpath.endsWith(".lock") || fpath.endsWith("tsconfig.json")) {
                    log(`Rebuild triggered by ${event}: ${fpath} — exiting with status code ${retryExitCode} (retry)`)
                    process.exit(retryExitCode)
                }
            }

            log(`Build triggered by ${event}: ${fpath}`)
            onChange()
        })
}

async function main() {
    switch (process.argv[2]) {
        case "port":
            console.log(port)
            process.exit()
    }

    log(`PID ${process.pid}`)

    log("Building")
    if (!(await build())) {
        process.exit(1)
    }

    if (process.argv.includes("-w")) {
        log("Watching for changes")
        let server = new DevServer(OUT_DIR, port, liveReloadPort)
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
}

main()
