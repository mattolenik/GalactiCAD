import fs from "fs/promises"
import http from "http"
import path from "path"
import WebSocket, { WebSocketServer } from "ws"

export class DevServer {
    httpServer: http.Server
    wsServer: WebSocketServer

    constructor(
        public serveRoot: string,
        public port: number,
        public indexFileName = "index.html",
        log = console.log,
        err = console.error
    ) {
        // Use an ephemeral port for live reload, but, store it in the environment
        // so that upon rebuild (an execve call), the port can be reused, preventing
        // the browser from having to refresh to get the new port.
        const liveReloadPort = parseInt(process.env.LRPORT ?? "0") || ephemeralPort()
        process.env.LRPORT = liveReloadPort.toString()

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

        this.httpServer = httpServer(serveRoot, port, clientScript, indexFileName, log, err)
        this.wsServer = new WebSocketServer({ port: liveReloadPort })
            .on("connection", (ws: WebSocket) => {
                ws.on("error", (error: Error) => {
                    err("WebSocket error: ", error)
                })
            })
            .on("listening", () => {
                log("Live reload on port " + liveReloadPort)
            })
    }

    public command(cmd: string) {
        this.wsServer.clients.forEach(client => client.send(cmd))
    }

    public reload() {
        this.command("reload")
    }

    public close() {
        this.httpServer.closeAllConnections()
        this.wsServer.close()
    }
}

function ephemeralPort() {
    return 49152 + Math.floor(Math.random() * (65535 - 49152))
}

function httpServer(dir: string, port: number, clientScript = "", indexFileName = "index.html", log = console.log, err = console.error) {
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
    log(`Serving at http://localhost:${port}`)

    return http
        .createServer(async (req, res) => {
            log(`${req.method} ${req.url}`)
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
