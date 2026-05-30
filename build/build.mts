import chokidar from "chokidar"
import { EventName } from "chokidar/handler.js"
import * as esbuild from "esbuild"
import fs from "fs/promises"
import nodePath from "node:path"
import { Subject } from "rxjs"
import { debounceTime } from "rxjs/operators"
import { DevServer, type RunFileData, AGENT_MODE } from "./devserver.mjs"
import { fileListerPlugin } from "./file-lister.mjs"
import monacoEditorPlugin from "./monaco-plugin.mjs"
import staticBundler from "./static-bundler.mjs"
import { versionPlugin } from "./version-plugin.mjs"
import wgslLoader from "./wgsl-loader.mjs"

const log = (msg: any) => console.log(`${new Date().toLocaleTimeString(navigator.language, { hour12: false })} ${msg}`)
const err = (msg: any) => console.error(`${new Date().toLocaleTimeString(navigator.language, { hour12: false })} ${msg}`)

const IS_PROD = !!process.env.PRODUCTION

const VS_DIR = `node_modules/monaco-editor/${IS_PROD ? "min" : "dev"}/vs`

const Static = {
    "src/index.html": "/",
    "src/index.css": "/",
    "src/site.webmanifest": "/",
    "src/_headers": "/",
    "src/assets/*": "/assets",
    "src/scene/samples/*.gcad": "/assets/samples/",
    [`${VS_DIR}/assets/ts.worker*.js`]: "/vs/assets/",
    [`${VS_DIR}/assets/editor`]: "/vs/assets/",
    [`${VS_DIR}/typescript*.js`]: "/vs/",
    [`${VS_DIR}/tsMode*.js`]: "/vs/",
    [`${VS_DIR}/nls*.js`]: "/vs/",
    [`${VS_DIR}/wgsl*.js`]: "/vs/",
    [`${VS_DIR}/monaco*.js`]: "/vs/",
    [`${VS_DIR}/worker*.js`]: "/vs/",
    [`${VS_DIR}/loader*.js`]: "/vs/",
    [`${VS_DIR}/editor*`]: "/vs/",
    [`${VS_DIR}/language/typescript`]: "/vs/language/",
    "node_modules/@dprint/typescript/plugin.wasm": ["/assets", "dprint-typescript.wasm"] as [string, string],
}

const Options = {
    entryPoints: [
        "./src/app.mts",
        "./src/components/preview-window.mts",
        "./src/components/mesh-viewer.mts",
        "./src/render-worker.mts",
        "./src/transpile-worker.mts",
        "./src/export/iso-simplicial/iso-qef-worker.mts",
    ],
    plugins: [
        await wgslLoader(),
        await versionPlugin(),
        await fileListerPlugin(),
        staticBundler(Static, log),
        monacoEditorPlugin({ urlPrefix: "/editor" }),
    ],
    outDir: "./dist",
    isProd: IS_PROD,
}

const WatchOptions = {
    ignored: [
        ".cursor",
        ".github",
        ".DS_Store",
        ".git",
        ".testresults",
        ".agents",
        "AGENTS.md",
        "node_modules",
        "assets",
        /\.devserver.*/,
        Options.outDir,
    ],
    causesRebuild: [/^build\//, /\.lock$/, /tsconfig\.json$/, /package\.json$/],
}

/** Relative paths matching these globs still run `build()` but skip WebSocket live reload. */
const NoRefresh = ["*.gcad"] as const

function shouldSuppressLiveReload(relativePath: string): boolean {
    const norm = relativePath.replace(/\\/g, "/")
    return NoRefresh.some(pat => {
        if (nodePath.matchesGlob(norm, pat)) return true
        // Node `matchesGlob` does not let a lone `*` cross `/`; treat `*.ext` as suffix at any depth.
        if (pat.startsWith("*.") && !pat.includes("/") && pat.indexOf("*", 1) === -1) {
            return norm.endsWith(pat.slice(1))
        }
        return false
    })
}

const ServerOptions = {
    port: parseInt(process.env.PORT || (AGENT_MODE ? "7900" : "6900"), 10),
}

const RUN_FILE = process.env.RUN_FILE ?? ".devserver.run"

async function checkRunFile(): Promise<boolean> {
    try {
        const data = JSON.parse(await fs.readFile(RUN_FILE, "utf8")) as RunFileData
        const { pid, port } = data
        try {
            process.kill(pid, 0)
        } catch {
            return false
        }
        log("An existing server is already running.")
        log(`  PID: ${pid}`)
        log(`  http://localhost:${port}`)
        return true
    } catch {
        return false
    }
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
            mainFields: ["browser", "module", "main"],
            assetNames: "assets/[name]-[hash]",
            loader: {
                ".css": "css",
                ".ttf": "file",
                ".woff": "file",
                ".woff2": "file",
                ".gcad": "text",
                ".svg": "text",
            },
            plugins: Options.plugins,
            sourcemap: !Options.isProd,
            target: "es2024",
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
    onRebuild: (event: EventName, path: string) => Promise<void>,
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
        if (await checkRunFile()) {
            process.exit(0)
        }
        let server: DevServer | null = null
        const shutdown = async (sig: string) => {
            log(`${sig}, shutting down.`)
            setTimeout(() => {
                err("shutdown timed out after 8s, forcing exit")
                process.exit(1)
            }, 8000).unref()
            if (server) {
                try {
                    await server.shutdown()
                } catch (e) {
                    err(e)
                }
                server = null
            }
            try {
                await fs.unlink(RUN_FILE)
            } catch {
                /* no run file */
            }
            process.exit(0)
        }
        process.on("SIGINT", () => {
            void shutdown("SIGINT")
        })
        process.on("SIGTERM", () => {
            void shutdown("SIGTERM")
        })

        server = await DevServer.create(Options.outDir, ServerOptions.port, "index.html", log, err, {
            runFile: RUN_FILE,
            pid: process.pid,
        })
        const change$ = new Subject<{ event: EventName; path: string }>()
        change$.pipe(debounceTime(300)).subscribe(async ({ event, path }) => {
            log(`Build triggered by ${event}: ${path}`)
            await build()
            if (!shouldSuppressLiveReload(path) && !AGENT_MODE) {
                server?.reload()
            }
        })
        let watcher = watch(
            ".",
            async (event, path) => {
                change$.next({ event, path })
            },
            async (event, eventPath) => {
                // A build-system file changed (WatchOptions.causesRebuild: build/**,
                // lockfiles, tsconfig, package.json), so the running build/serve code is
                // stale. We deliberately do NOT auto-restart here. The interactive and agent
                // watchers are separate processes sharing one dist/ dir, so two concurrent
                // rebuilds race on the monaco copy in static-bundler (ENOENT unlinking
                // dist/vs/editor/editor.main.js); a failed rebuild then exits the process and
                // drops the server, surfacing as ERR_CONNECTION_REFUSED in the browser.
                // Instead, keep serving the current build and tell the human to restart so the
                // change applies cleanly. (This previously re-exec'd `make serve`, a target
                // removed in caac0e7, which silently killed the watcher on any build/** edit.)
                log(`⚠️  build-system file changed (${event}: ${eventPath}) — run 'make restart' to apply; keeping current server up`)
            },
        )
    }
}

main()
