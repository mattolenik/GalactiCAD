import chokidar from "chokidar"
import * as esbuild from "esbuild"
import http from "http"
import assetBundler from "./asset-bundler.mjs"
import wgslLoader from "./wgsl-loader.mjs"
import path from "path"
import fs from "fs/promises"
import { createReadStream } from "fs"

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

function watch(location: string) {
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
        })
}

function serve(dir: string, port: number) {
    const contentType: Record<string, string> = {
        ".css": "text/css",
        ".gif": "image/gif",
        ".html": "text/html",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".js": "text/javascript",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
    }
    const defaultContentType = "application/octet-stream"
    const defaultPath = "index.html"
    console.log(`Serving at http://localhost:${port}`)
    return http
        .createServer(async (req, res) => {
            console.log(`${req.method} ${req.url}`)
            let file = path.normalize(path.join(dir, "." + req.url))
            try {
                const stats = await fs.stat(file)
                if (stats.isDirectory()) {
                    file = defaultPath
                }
                const data = await fs.readFile(file)
                res.writeHead(200, { "content-type": contentType[path.extname(file) || defaultContentType] })
                res.write(data)
                createReadStream(file).pipe(res)
            } catch (err: any) {
                if (err.code === "ENOENT") {
                    res.writeHead(404, { "content-type": "text/plain" })
                    res.end("404 not found")
                    return
                }
                res.writeHead(500, { "content-type": "text/plain" })
                res.end("500 unknown server error")
                return
            }
        })
        .listen(port)
}

log("Building")
await build()

if (process.argv.includes("-w")) {
    log("Watching for changes")
    let server = serve("./dist", 6900)
    let watcher = watch(".")

    process.on("SIGINT", async () => {
        server.closeAllConnections()
        await watcher.close()
        process.exit(0)
    })
}

function log(msg: string) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`)
}
