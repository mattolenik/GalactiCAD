import fs from "fs/promises"
import http from "http"
import path from "path"
import WebSocket, { WebSocketServer } from "ws"

export function devServer(port: number, dir: string, defaultPath = "index.html") {
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

export function liveReload(port: number) {
    const wss = new WebSocketServer({ port })

    return wss.on("connection", (ws: WebSocket) => {
        ws.on("error", (error: Error) => {
            console.error("WebSocket error:", error)
        })
    })
}
