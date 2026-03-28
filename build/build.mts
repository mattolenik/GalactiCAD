import { execSync } from "child_process"
import chokidar from "chokidar"
import { EventName } from "chokidar/handler.js"
import * as esbuild from "esbuild"
import fs from "fs/promises"
import { Subject } from "rxjs"
import { debounceTime } from "rxjs/operators"
import { DevServer } from "./devserver.mjs"
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
    [`${VS_DIR}/editor*.js`]: "/vs/",
    [`${VS_DIR}/language/typescript`]: "/vs/language/",
    "node_modules/@dprint/typescript/plugin.wasm": ["/assets", "dprint-typescript.wasm"] as [string, string],
}

const Options = {
    entryPoints: ["./src/app.mts", "./src/components/preview-window.mts", "./src/components/mesh-viewer.mts", "./src/render-worker.mts", "./src/transpile-worker.mts"],
    plugins: [await wgslLoader(), await versionPlugin(), await fileListerPlugin(), staticBundler(Static, log), monacoEditorPlugin({ urlPrefix: "/editor" })],
    outDir: "./dist",
    isProd: IS_PROD,
}

const WatchOptions = {
    ignored: [".cursor", ".github", ".DS_Store", ".git", "node_modules", "assets", /.devserver.*/, Options.outDir],
    causesRebuild: [/^build\//, /\.lock$/, /tsconfig\.json$/, /package\.json$/],
}

const ServerOptions = {
    port: parseInt(process.env.PORT || "6900", 10),
}

const RUN_FILE = process.env.RUN_FILE ?? ".devserver.run"

interface RunFileData {
    pid: number
    port: number
}

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

async function writeRunFile(data: RunFileData): Promise<void> {
    await fs.writeFile(RUN_FILE, JSON.stringify(data, null, 2))
}

const CURSOR_MCP_JSON = ".cursor/mcp.json"

/** Point Cursor MCP config at this devserver's bound port (same moment as `.devserver.run`). */
async function syncCursorMcpJson(port: number): Promise<void> {
    const url = `http://localhost:${port}/mcp`
    let doc: Record<string, unknown>
    try {
        doc = JSON.parse(await fs.readFile(CURSOR_MCP_JSON, "utf8")) as Record<string, unknown>
    } catch {
        doc = { mcpServers: {} }
    }
    const servers = (doc.mcpServers as Record<string, unknown> | undefined) ?? {}
    const key = "galacticad-devserver"
    const prev = servers[key]
    const prevEntry =
        typeof prev === "object" && prev !== null && !Array.isArray(prev)
            ? (prev as Record<string, unknown>)
            : {}
    servers[key] = { ...prevEntry, url }
    doc.mcpServers = servers
    await fs.mkdir(".cursor", { recursive: true })
    await fs.writeFile(CURSOR_MCP_JSON, `${JSON.stringify(doc, null, 4)}\n`)
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
        if (await checkRunFile()) {
            process.exit(0)
        }
        let server = await DevServer.create(Options.outDir, ServerOptions.port, "index.html", log, err)
        await writeRunFile({ pid: process.pid, port: server.port })
        try {
            await syncCursorMcpJson(server.port)
        } catch (e) {
            err(`Could not update ${CURSOR_MCP_JSON}: ${e}`)
        }
        const change$ = new Subject<{ event: EventName; path: string }>()
        change$
            .pipe(debounceTime(300))
            .subscribe(async ({ event, path }) => {
                log(`Build triggered by ${event}: ${path}`)
                await build()
                server.reload()
            })
        let watcher = watch(
            ".",
            async (event, path) => {
                change$.next({ event, path })
            },
            async (event, eventPath) => {
                if (!process.execve) {
                    throw new Error("rebuild only supported on Node v23.11.0 or higher")
                }
                // const tsxPath = process.env.TSX ?? "./node_modules/.bin/tsx"
                log(`REBUILD triggered by ${event}: ${eventPath}`)
                const makePath = execSync("which make", { encoding: "utf8" }).trim()
                const args = [makePath, "serve"]
                log(`Restarting build with ${args.join(" ")}`)
                process.execve(makePath, args, process.env)
                // log(`Cleaning ${Options.outDir}`)
                // await rm(Options.outDir, { recursive: true, force: true })
                // const args = [tsxPath, "--disable-warning=ExperimentalWarning"].concat(process.argv.slice(1))
                // process.execve(tsxPath, args, process.env)
            }
        )

        process.on("SIGINT", () => { log("SIGINT, shutting down."); process.exit(0) })
        process.on("SIGTERM", () => { log("SIGTERM, shutting down."); process.exit(0) })
    }
}

main()
