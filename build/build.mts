import chokidar from "chokidar"
import * as esbuild from "esbuild"
import assetBundler from "./asset-bundler.mjs"
import { DevServer } from "./server.mjs"
import wgslLoader from "./wgsl-loader.mjs"
import { EventName } from "chokidar/handler.js"

const ASSETS = ["src/**/*.html", "src/**/*.css"]
const ENTRY_POINTS = ["./src/sdf.mts"]
const OUT_DIR = "./dist"
const IS_PROD = !!process.env.PRODUCTION

const TSX_PATH = process.env.TSX ?? "./node_modules/.bin/tsx"

const watchIgnorePatterns = [".DS_Store", ".hg", ".git", OUT_DIR, "node_modules"]
const rebuildPatterns = [/^build\//, /\.lock$/, /tsconfig\.json$/]

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

function watch(
    location: string,
    onChange: (event: EventName, path: string) => Promise<void>,
    onRebuild: (event: EventName, path: string) => Promise<void>
) {
    const isRebuildPath = (p: string) => rebuildPatterns.map(re => !!p.match(re)).reduce((p, c) => p || c, false)

    return chokidar
        .watch(location, {
            atomic: true,
            cwd: ".",
            followSymlinks: true,
            ignored: watchIgnorePatterns,
            ignoreInitial: true,
            persistent: true,
        })
        .on("all", async (event, fpath) => {
            if (isRebuildPath(fpath)) {
                await onRebuild(event, fpath)
            } else {
                await onChange(event, fpath)
            }
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
        let watcher = watch(
            ".",
            async (event, path) => {
                log(`Build triggered by ${event}: ${path}`)
                await build()
                server.reload()
            },
            async (event, path) => {
                const args = [TSX_PATH, "--disable-warning=ExperimentalWarning"]
                args.push(...process.argv.slice(1))
                log(`REBUILD triggered by ${event}: ${path}`)
                // must cast to any as the current @types/node does not have a definition for execve (added in node v23.11.0)
                ;(process as any).execve(TSX_PATH, args, process.env)
            }
        )

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
