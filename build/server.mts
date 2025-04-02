import fs from "fs/promises"
import http from "http"
import path from "path"
import WebSocket, { WebSocketServer } from "ws"

export class DevServer {
    public ServeRoot: string
    public Port: number
    public LiveReloadPort: number
    public IndexFileName: string

    public Server: http.Server
    public LRServer: WebSocketServer

    constructor(serveRoot: string, port: number, liveReloadPort: number, indexFileName = "index.html") {
        this.ServeRoot = serveRoot
        this.Port = port
        this.LiveReloadPort = liveReloadPort
        this.IndexFileName = indexFileName

        const clientScript = `
        <script type="module">
            const ws = new WebSocket("ws://localhost:${liveReloadPort}");
            ws.addEventListener("message", (event) => {
                if (event.data === "reload") {
                    ws.close();
                    window.location.reload();
                }
            });
        </script>`

        this.Server = httpServer(serveRoot, port, clientScript, indexFileName)
        this.LRServer = new WebSocketServer({ port: liveReloadPort }).on("connection", (ws: WebSocket) => {
            ws.on("error", (error: Error) => {
                console.error("WebSocket error:", error)
            })
        })
    }

    public command(cmd: string) {
        this.LRServer.clients.forEach(client => client.send(cmd))
    }

    public reload() {
        this.command("reload")
    }

    public close() {
        this.Server.closeAllConnections()
        this.LRServer.close()
    }
}

function httpServer(dir: string, port: number, clientScript = "", indexFileName = "index.html") {
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
    console.log(`Serving at http://localhost:${port}`)

    return http
        .createServer(async (req, res) => {
            console.log(`${req.method} ${req.url}`)
            let file = path.normalize(path.join(dir, "." + req.url))
            try {
                const stats = await fs.stat(file)
                if (stats.isDirectory()) {
                    file = path.join(dir, indexFileName)
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
                } else {
                    res.writeHead(500, { "content-type": "text/plain" })
                    res.end("500 unknown server error")
                }
            }
        })
        .listen(port)
}
