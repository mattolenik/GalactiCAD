import chokidar from "chokidar"
import { EventName } from "chokidar/handler.js"
import * as esbuild from "esbuild"
import fs from "fs/promises"
import fsSync from "node:fs"
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
// All generated output lives under ./dist:
//   ./dist/site     — web build (this esbuild output, also what's deployed
//                     to the static host)
//   ./dist/build    — electron-builder buildResources (generated icons)
//   ./dist/release  — electron-builder packaged installers/archives
const DIST_ROOT = "./dist"

/**
 * M6b threaded SFCC (rayon-in-wasm): wasm-bindgen-rayon's pool workers self-spawn
 * via `new Worker(new URL("./workerHelpers.js", import.meta.url))`. esbuild inlines
 * that snippet into the render-worker bundle but leaves the URL literal, so the
 * standalone worker file must ALSO be emitted at the SITE ROOT (where the
 * `import.meta.url`-relative resolution from `/render-worker.js` finds it).
 *
 * Built ONLY by `make gcad-wasm-threads` (opt-in nightly path) → `pkg-threads/`;
 * the snippet dir carries a content hash, so glob for it. When `pkg-threads/` is
 * absent (the default single-thread build) this returns null and nothing is
 * emitted — the non-threaded output stays byte-identical. It's bundled in a
 * SEPARATE esbuild call (not the main `entryPoints`) so the main build's outbase
 * (and thus every other worker's output path) is untouched.
 */
function rayonWorkerHelpersEntry(): string | null {
    const snippetsRoot = "./gcad-wasm/wasm/pkg-threads/snippets"
    try {
        for (const d of fsSync.readdirSync(snippetsRoot)) {
            const helper = nodePath.join(snippetsRoot, d, "src", "workerHelpers.js")
            if (fsSync.existsSync(helper)) return helper
        }
    } catch {
        /* pkg-threads/ not built — single-thread default path only. */
    }
    return null
}

const PKG_THREADS_GLUE = "./gcad-wasm/wasm/pkg-threads/gcad_wasm.js"

/**
 * M6b: the threaded SFCC loader (`wasm-loader-threads.mts`) statically imports the
 * `pkg-threads/` artifact, which only exists after the opt-in `make gcad-wasm-threads`
 * nightly build. When it's ABSENT (a normal checkout / `make gcad-wasm`), esbuild
 * can't resolve those imports and the WHOLE build fails — even though nothing on the
 * default path runs the threaded code. This plugin redirects `wasm-loader-threads.mts`
 * to a runtime-throwing stub when `pkg-threads/` is missing, so the default build is
 * unaffected and the `?sfccThreads` flag path fails with a clear "build pkg-threads"
 * error instead of a hard build break.
 */
function threadedLoaderStubPlugin(): esbuild.Plugin {
    return {
        name: "sfcc-threads-loader-stub",
        setup(build) {
            const haveThreads = fsSync.existsSync(PKG_THREADS_GLUE)
            if (haveThreads) return // pkg-threads/ present → resolve the real loader normally.
            build.onResolve({ filter: /wasm-loader-threads(\.mjs|\.mts)?$/ }, args => ({
                path: args.path,
                namespace: "sfcc-threads-stub",
            }))
            build.onLoad({ filter: /.*/, namespace: "sfcc-threads-stub" }, () => ({
                contents:
                    "const MSG = 'gcad-wasm threaded artifact (pkg-threads/) not built — run `make gcad-wasm-threads`';\n" +
                    "export async function ensureThreadedWasmReady() { throw new Error(MSG) }\n" +
                    "export function par_smoke() { throw new Error(MSG) }\n" +
                    "export async function initThreadPool() { throw new Error(MSG) }\n" +
                    "export function version() { throw new Error(MSG) }\n",
                loader: "js",
            }))
        },
    }
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
        threadedLoaderStubPlugin(),
        await wgslLoader(),
        await versionPlugin(),
        await fileListerPlugin(),
        staticBundler(Static, log),
        monacoEditorPlugin({ urlPrefix: "/editor" }),
    ],
    outDir: `${DIST_ROOT}/site`,
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
        // Ignore all of dist/ — site rebuilds, electron-builder buildResources,
        // and release artifacts should never trigger a watch rebuild.
        DIST_ROOT,
    ],
    // Only build-tooling changes (the build script, devserver, esbuild plugins) require a
    // full process restart via re-exec — they're imported once at startup and can't be
    // hot-swapped. Everything else (app source, lockfiles, tsconfig, package.json) goes
    // through a normal esbuild rebuild + browser reload.
    causesRebuild: [/^build\//],
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
            outdir: Options.outDir,
            plugins: Options.plugins,
        })
        // M6b threaded SFCC: emit the rayon pool-worker self-spawn target
        // (`workerHelpers.js`) at the site root in its own build call so the main
        // build's outbase — and every other worker's output path — is untouched.
        // No-op (and zero overhead) unless `pkg-threads/` has been built.
        const rayonHelper = rayonWorkerHelpersEntry()
        if (rayonHelper) {
            await esbuild.build({
                ...SharedEsbuildOptions,
                entryPoints: { workerHelpers: rayonHelper },
                outdir: Options.outDir,
            })
        }
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
        change$.pipe(debounceTime(300)).subscribe(async ({ event, path }) => {
            log(`Build triggered by ${event}: ${path}`)
            await build()
            if (!shouldSuppressLiveReload(path) && !AGENT_MODE) {
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
