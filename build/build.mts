import chokidar from "chokidar"
import { EventName } from "chokidar/handler.js"
import * as esbuild from "esbuild"
import { DevServer } from "./devserver.mjs"
import monacoEditorPlugin from "./monaco-plugin.mjs"
import staticBundler from "./static-bundler.mjs"
import wgslLoader from "./wgsl-loader.mjs"

const log = (msg: any) => console.log(`${new Date().toLocaleTimeString(navigator.language, { hour12: false })} ${msg}`)
const err = (msg: any) => console.error(`${new Date().toLocaleTimeString(navigator.language, { hour12: false })} ${msg}`)

const Static = {
    "src/index.html": "/",
    "src/site.webmanifest": "/",
    "src/assets/*": "/assets",
}

const Options = {
    entryPoints: ["./src/app.mts", "./src/components/preview-window.mts"],
    plugins: [wgslLoader(), staticBundler(Static, log), monacoEditorPlugin({ urlPrefix: "/editor" })],
    outDir: "./dist",
    isProd: !!process.env.PRODUCTION,
}

const WatchOptions = {
    ignored: [".DS_Store", ".git", "node_modules", "assets", Options.outDir],
    causesRebuild: [/^build\//, /\.lock$/, /tsconfig\.json$/],
}

const ServerOptions = {
    port: parseInt(process.env.PORT || "6900", 10),
}

async function build() {
    const startTime = performance.now()
    try {
        const results = await esbuild.build({
            bundle: true,
            entryPoints: Options.entryPoints,
            minify: Options.isProd,
            outdir: Options.outDir,
            platform: "browser",
            format: "esm",
            mainFields: ["module", "main"],
            assetNames: "assets/[name]-[hash]",
            loader: {
                ".css": "css",
                ".ttf": "file",
                ".woff": "file",
                ".woff2": "file",
            },
            plugins: Options.plugins,
            sourcemap: !Options.isProd,
            target: "es2023",
        })
        const elapsed = performance.now() - startTime
        log(`🌱🐢 ${elapsed.toFixed(2)}ms`)
        return results.errors.length === 0
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
    return chokidar
        .watch(location, {
            atomic: true,
            cwd: ".",
            followSymlinks: true,
            ignored: WatchOptions.ignored,
            ignoreInitial: true,
            persistent: true,
        })
        .on("all", async (event, fpath) => {
            if (WatchOptions.causesRebuild.some(re => fpath.match(re))) {
                await onRebuild(event, fpath)
            } else {
                await onChange(event, fpath)
            }
        })
}

async function main() {
    switch (process.argv[2]) {
        case "port":
            console.log(ServerOptions.port)
            process.exit()
    }

    log(`PID ${process.pid}`)

    log("Building")
    if (!(await build())) {
        process.exit(1)
    }

    if (process.argv.includes("-w")) {
        log("Watching for changes")
        let server = new DevServer(Options.outDir, ServerOptions.port, "index.html", log, err)
        let watcher = watch(
            ".",
            async (event, path) => {
                log(`Build triggered by ${event}: ${path}`)
                await build()
                server.reload()
            },
            async (event, path) => {
                if (!process.execve) {
                    throw new Error("rebuild only supported on Node v23.11.0 or higher")
                }
                const tsxPath = process.env.TSX ?? "./node_modules/.bin/tsx"
                log(`REBUILD triggered by ${event}: ${path}`)
                // log(`Cleaning ${Options.outDir}`)
                // await rm(Options.outDir, { recursive: true, force: true })
                const args = [tsxPath, "--disable-warning=ExperimentalWarning"].concat(process.argv.slice(1))
                process.execve(tsxPath, args, process.env)
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
