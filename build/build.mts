import chokidar from "chokidar"
import { EventName } from "chokidar/handler.js"
import { execFile } from "node:child_process"
import * as esbuild from "esbuild"
import fs from "fs/promises"
import nodePath from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Subject } from "rxjs"
import { debounceTime } from "rxjs/operators"
import { DevServer, type RunFileData, AGENT_MODE } from "./devserver.mjs"
import { fileListerPlugin } from "./file-lister.mjs"
import tsLibsPlugin from "./ts-libs-plugin.mjs"
import staticBundler from "./static-bundler.mjs"
import { versionPlugin } from "./version-plugin.mjs"
import wgslLoader from "./wgsl-loader.mjs"

const log = (msg: any) => console.log(`${new Date().toLocaleTimeString(navigator.language, { hour12: false })} ${msg}`)
const err = (msg: any) => console.error(`${new Date().toLocaleTimeString(navigator.language, { hour12: false })} ${msg}`)

const IS_PROD = !!process.env.PRODUCTION

// @typescript/vfs lazily requires node `path`/`fs` in Node-only paths we never hit in
// the browser; the prod minifier folds its obfuscated requires into static ones, so
// alias both to an empty module to keep the bundle resolvable. See node-empty-stub.mjs.
const NODE_EMPTY_STUB = fileURLToPath(new URL("./node-empty-stub.mjs", import.meta.url))

// The editor (CodeMirror 6) bundles as plain ESM into app.js — no worker-bundling
// plugin and no environment shim. The only editor worker is the TypeScript
// language service (ts-worker), a normal esbuild entry point emitted to /editor/.
const Static = {
    "src/index.html": "/",
    "src/index.css": "/",
    "src/site.webmanifest": "/",
    "src/_headers": "/",
    "src/assets/*": "/assets",
    "src/scene/samples/*.gcad": "/assets/samples/",
    "node_modules/@dprint/typescript/plugin.wasm": ["/assets", "dprint-typescript.wasm"] as [string, string],
}
// All generated output lives under ./dist:
//   ./dist/site     — web build (this esbuild output, also what's deployed
//                     to the static host)
//   ./dist/build    — electron-builder buildResources (generated icons)
//   ./dist/release  — electron-builder packaged installers/archives
const DIST_ROOT = "./dist"

const Options = {
    entryPoints: [
        "./src/app.mts",
        "./src/components/preview-window.mts",
        "./src/components/mesh-viewer.mts",
        "./src/render-worker.mts",
        "./src/transpile-worker.mts",
        "./src/editor/ts-worker.mts",
        "./src/export/iso-simplicial/iso-qef-worker.mts",
        "./src/export/sfcc-rs/partition-worker.mts",
    ],
    plugins: [
        await wgslLoader(),
        await versionPlugin(),
        await fileListerPlugin(),
        staticBundler(Static, log),
        tsLibsPlugin(),
    ],
    outDir: `${DIST_ROOT}/site`,
    isProd: IS_PROD,
}

const WatchOptions = {
    ignored: [
        ".cursor",
        ".browsers",
        ".github",
        ".DS_Store",
        ".git",
        ".testresults",
        ".agents",
        "AGENTS.md",
        "node_modules",
        "assets",
        /\.devserver.*/,
        // Ignore all of dist/ — site rebuilds, electron-builder buildResources,
        // and release artifacts should never trigger a watch rebuild.
        DIST_ROOT,
        // gcad-wasm build OUTPUTS (all gitignored). A gcad-wasm *source* change makes the
        // change handler spawn `make gcad-wasm`, which writes cargo artifacts to target/ and
        // the wasm-pack bundle to wasm/pkg/. Watching those would loop/thrash, so ignore
        // them; the .rs/Cargo source change is what drives the rebuild + reload.
        (p: string) => /(^|\/)gcad-wasm\/(target|wasm\/pkg)(\/|$)/.test(p.replace(/\\/g, "/")),
    ],
    // Only build-tooling changes (the build script, devserver, esbuild plugins) require a
    // full process restart via re-exec — they're imported once at startup and can't be
    // hot-swapped. Everything else (app source, lockfiles, tsconfig, package.json) goes
    // through a normal esbuild rebuild + browser reload.
    causesRebuild: [/^build\//],
}

/**
 * gcad-wasm (Rust) kernel sources whose change requires recompiling the wasm artifact before
 * esbuild re-bundles it — `.rs` files plus the Cargo manifests/lockfile under `gcad-wasm/`.
 * The generated `wasm/pkg{,-threads}/` and `target/` outputs are watch-ignored (see above), so
 * only true source edits reach here.
 */
function isGcadWasmSource(relativePath: string): boolean {
    const p = relativePath.replace(/\\/g, "/")
    if (!p.startsWith("gcad-wasm/")) return false
    return /\.rs$/.test(p) || /(^|\/)Cargo\.(toml|lock)$/.test(p)
}

const execFileAsync = promisify(execFile)

/**
 * Incrementally recompile the gcad-wasm Rust kernel via `make gcad-wasm` (stamp-tracked, so it
 * only re-runs wasm-pack when sources are newer). Serialized through a single chain so two
 * overlapping build cycles never run wasm-pack into the shared `pkg/` at once. Best-effort: a
 * Rust compile error is logged and the build proceeds with the previous wasm so the reload
 * still surfaces the current state.
 */
let gcadWasmRebuildChain: Promise<void> = Promise.resolve()
function rebuildGcadWasm(): Promise<void> {
    const run = async () => {
        const startTime = performance.now()
        log("🦀 Recompiling gcad-wasm (Rust kernel)…")
        try {
            await execFileAsync("make", ["gcad-wasm"], { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 })
            log(`🦀 gcad-wasm rebuilt in ${(performance.now() - startTime).toFixed(0)}ms`)
        } catch (e) {
            const stderr = e && typeof e === "object" && "stderr" in e ? String((e as { stderr?: unknown }).stderr ?? "") : ""
            err(`🦀 gcad-wasm rebuild FAILED — keeping previous wasm:\n${stderr || (e instanceof Error ? e.message : String(e))}`)
        }
    }
    gcadWasmRebuildChain = gcadWasmRebuildChain.then(run, run)
    return gcadWasmRebuildChain
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

/**
 * The default dev-server port encodes the git-workspace suffix so parallel worktrees get
 * stable, distinct, predictable ports. Base is 7900 (agent) / 6900 (interactive); a trailing
 * number on the project-root folder name is added to it: `foo` / `foo0` → base+0, `foo1` →
 * base+1, `foo2` → base+2, … Set the PORT env var to override this entirely.
 */
function defaultPort(): number {
    const base = AGENT_MODE ? 7900 : 6900
    const folder = nodePath.basename(process.cwd())
    const suffix = folder.match(/(\d+)$/)
    return base + (suffix ? parseInt(suffix[1], 10) : 0)
}

const ServerOptions = {
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : defaultPort(),
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

const SharedEsbuildOptions = {
    bundle: true,
    minify: IS_PROD,
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
        // gcad-wasm SFCC kernel binary (sfcc-rs exporter): emit as a
        // hashed asset; the import yields the served URL passed to init.
        ".wasm": "file",
    },
    sourcemap: !IS_PROD,
    target: "es2024",
} as const satisfies Partial<esbuild.BuildOptions>

async function build() {
    const startTime = performance.now()
    try {
        const results = await esbuild.build({
            ...SharedEsbuildOptions,
            entryPoints: Options.entryPoints,
            minify: Options.isProd,
            // Prod: strip console/debugger calls and drop esbuild's per-file license-comment
            // blocks. Both are no-ops in dev (where we keep logging + sourcemaps).
            drop: Options.isProd ? (["console", "debugger"] as ("console" | "debugger")[]) : [],
            legalComments: "none",
            outdir: Options.outDir,
            platform: "browser",
            format: "esm",
            // Factor code shared across entry points (notably the ~3.5 MB TypeScript
            // compiler used by app.js, transpile-worker, and ts-worker) into shared
            // chunks instead of inlining a copy in each. All entries + workers are ESM
            // module workers, so they can import the chunks. Chunks land at the outdir
            // root, so the import.meta.url-relative worker URLs still resolve.
            splitting: true,
            alias: { path: NODE_EMPTY_STUB, fs: NODE_EMPTY_STUB },
            mainFields: ["browser", "module", "main"],
            assetNames: "assets/[name]-[hash]",
            // Loader map comes from SharedEsbuildOptions (spread above), which includes
            // the `.wasm` → file loader the sfcc-rs exporter needs; no inline override.
            plugins: Options.plugins,
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

        try {
            server = await DevServer.create(Options.outDir, ServerOptions.port, "index.html", log, err, {
                runFile: RUN_FILE,
                pid: process.pid,
            })
        } catch (e) {
            // The detailed "port in use" report (PID + command line) was already printed by the
            // devserver; surface a concise reason and exit non-zero rather than crash with a stack.
            err(e instanceof Error ? e.message : String(e))
            process.exit(1)
        }
        const change$ = new Subject<{ event: EventName; path: string }>()
        // Set when any change in the current (debounced) batch touched a gcad-wasm Rust source,
        // so the build cycle recompiles the wasm and the overlay can say so. Read+reset per build.
        let pendingGcadWasmRebuild = false
        change$.pipe(debounceTime(300)).subscribe(async ({ event, path }) => {
            const gcadWasm = pendingGcadWasmRebuild
            pendingGcadWasmRebuild = false
            log(`Build triggered by ${event}: ${path}${gcadWasm ? " (gcad-wasm recompile)" : ""}`)
            // Only the changes that will end in a live reload get the build overlay; .gcad edits
            // (NoRefresh) and the agent server rebuild silently with no reload, so no overlay.
            const willReload = !shouldSuppressLiveReload(path) && !AGENT_MODE
            // Signal BEFORE the (slower, Rust) rebuild so the overlay is up for its whole duration.
            if (willReload) server?.signalBuildStart(gcadWasm)
            // The interactive server owns the incremental Rust→wasm rebuild so editing a kernel
            // source hot-reloads. Skipped in agent mode so two side-by-side servers don't run
            // wasm-pack into the shared pkg/ at once. esbuild (below) then bundles the fresh wasm.
            if (gcadWasm && !AGENT_MODE) await rebuildGcadWasm()
            await build()
            if (willReload) {
                server?.reload()
            }
        })
        // Guards onRebuild against re-entrancy: chokidar can emit several events for one
        // save, and onRebuild is NOT debounced, so without this two concurrent shutdown()
        // calls race and hang the process before it ever re-execs. Never reset — execve
        // replaces the process image, so the flag dies with it.
        let restarting = false
        let watcher = watch(
            ".",
            async (event, path) => {
                if (isGcadWasmSource(path)) pendingGcadWasmRebuild = true
                change$.next({ event, path })
            },
            async (event, eventPath) => {
                if (restarting) return
                restarting = true
                if (!process.execve) {
                    throw new Error("rebuild only supported on Node v23.11.0 or higher")
                }
                // A file under build/ changed (WatchOptions.causesRebuild). esbuild plugins
                // and the devserver are imported once at startup, so only a process restart
                // applies the change.
                // Shut the server down cleanly (release the listen socket + remove the run
                // file), then re-exec THIS process from its own argv + execArgv, inheriting
                // process.env so PORT / RUN_FILE / AGENT etc. carry over and it rebinds the
                // same port. (This previously re-exec'd `make serve`, a target that was
                // removed — so any build/** edit killed the watcher instead of restarting.)
                log(`REBUILD triggered by ${event}: ${eventPath} — restarting devserver`)
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
                    // No run file to clear. execve preserves our PID, so a leftover run file
                    // would make the re-exec'd checkRunFile() think a server is already up.
                }
                const args = [process.execPath, ...process.execArgv, ...process.argv.slice(1)]
                log(`Re-exec: ${args.join(" ")}`)
                process.execve(process.execPath, args, process.env)
            },
        )
    }
}

main()
