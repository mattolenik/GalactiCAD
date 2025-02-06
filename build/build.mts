import chokidar from "chokidar"
import * as esbuild from "esbuild"
import fs from "fs/promises"
import http from "http"
import path from "path"
import WebSocket, { WebSocketServer } from "ws"
import assetBundler from "./asset-bundler.mjs"
import wgslLoader from "./wgsl-loader.mjs"

const assets = ["*.html", "*.css"]
const entryPoints = ["./sdf.mts"]
const outdir = "./dist"

const port = parseInt(process.env.PORT || "6900", 10)
const portLiveReload = parseInt(process.env.PORT_LIVERELOAD || "6909", 10)

switch (process.argv[2]) {
    case "port":
        console.log(port)
        process.exit()

    case "portLiveReload":
        console.log(portLiveReload)
        process.exit()
}

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

function serve(port: number, dir: string, defaultPath = "index.html") {
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
    const clientScript = `
    <script type="module">
        const ws = new WebSocket("ws://localhost:6909");
        ws.addEventListener("message", (event) => {
            if (event.data === "reload") {
                ws.close();
                window.location.reload();
            }
        });
    </script>`
    const defaultContentType = "application/octet-stream"
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
                let data = await fs.readFile(file)
                res.writeHead(200, { "content-type": contentType[path.extname(file)] || defaultContentType })
                if (path.extname(file) === ".html") {
                    const doc = data.toString().replace("</body>", clientScript + "</body>")
                    data = Buffer.from(doc)
                }
                res.write(data)
                res.end()
            } catch (err: any) {
                if (err.code === "ENOENT") {
                    res.writeHead(404, { "content-type": "text/plain" })
                    res.end("404 not found")
                }
                res.writeHead(500, { "content-type": "text/plain" })
                res.end("500 unknown server error")
            }
        })
        .listen(port)
}

function livereload() {
    const wss = new WebSocketServer({ port: portLiveReload })

    return wss.on("connection", (ws: WebSocket) => {
        ws.on("error", (error: Error) => {
            console.error("WebSocket error:", error)
        })
    })
}

log("Building")
await build()

if (process.argv.includes("-w")) {
    log("Watching for changes")
    let server = serve(port, "./dist")
    let lrServer = livereload()
    let watcher = watch(".", () => lrServer.clients.forEach((client) => client.send("reload")))

    process.on("SIGINT", async () => {
        server.closeAllConnections()
        await watcher.close()
        lrServer.close()
        process.exit(0)
    })
}

function log(msg: string) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`)
}
