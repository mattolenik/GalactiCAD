// Electron entry point.
//
// Serves dist/ via a custom standard+secure protocol so the existing web app
// can be loaded unchanged. The handler injects the COOP/COEP/CORP headers
// that dist/_headers declares for Cloudflare Pages — required for
// crossOriginIsolated and the render worker's SharedArrayBuffer.
//
// Note: Electron 42's `electron/main` subpath does not synthesize named
// exports; namespace import + destructure (matches Electron's own
// default_app) is the supported ESM pattern.

import * as electronMain from "electron/main"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const { app, BrowserWindow, net, protocol } = electronMain

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SCHEME = "app"
const HOST = "galacticad"
const ORIGIN = `${SCHEME}://${HOST}`

// electron/ sits next to dist/site/ in the repo. When packaged, both live
// inside the asar at app.asar/electron/ and app.asar/dist/site/, so the same
// join works in both contexts.
const DIST = path.resolve(__dirname, "..", "dist", "site")

// Must be called before app.whenReady() — privileges are baked at startup.
protocol.registerSchemesAsPrivileged([
    {
        scheme: SCHEME,
        privileges: {
            standard: true, // scheme://host/path parsing + correct relative URLs
            secure: true, // secure context (WebGPU, crossOriginIsolated, ...)
            supportFetchAPI: true, // fetch("/assets/dprint-typescript.wasm") etc.
            corsEnabled: true, // CORS semantics under active COEP
            stream: true, // streamed responses for the 20 MB app.js
        },
    },
])

function isInside(child, parent) {
    const rel = path.relative(parent, child)
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

async function handleAppRequest(request) {
    const url = new URL(request.url)

    let pathname = decodeURIComponent(url.pathname)
    if (pathname === "" || pathname === "/") pathname = "/index.html"

    // path.join normalizes `..` segments; then we still verify containment.
    const filePath = path.join(DIST, pathname)
    if (!isInside(filePath, DIST)) {
        return new Response("Forbidden", { status: 403 })
    }

    // net.fetch on a file:// URL reads transparently from inside an asar
    // archive and infers Content-Type from the extension.
    const upstream = await net.fetch(pathToFileURL(filePath).toString())

    const headers = new Headers(upstream.headers)
    // Mirror dist/_headers so crossOriginIsolated turns on in the renderer.
    headers.set("Cross-Origin-Opener-Policy", "same-origin")
    headers.set("Cross-Origin-Embedder-Policy", "require-corp")
    // Required for every sub-resource under active COEP (require-corp).
    headers.set("Cross-Origin-Resource-Policy", "cross-origin")

    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
    })
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        backgroundColor: "#002b44", // matches the gicon background
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            preload: path.join(__dirname, "preload.cjs"),
        },
    })

    if (process.env.GICAD_SMOKE) {
        win.webContents.on("console-message", (_e, level, message, line, source) => {
            console.log(`SMOKE-CONSOLE[${level}] ${source}:${line} ${message}`)
        })
        win.webContents.on("render-process-gone", (_e, details) =>
            console.log("SMOKE-RENDER-GONE:", details.reason),
        )
        win.webContents.once("did-finish-load", async () => {
            const result = await win.webContents.executeJavaScript(
                "JSON.stringify({coi:self.crossOriginIsolated,sab:typeof SharedArrayBuffer,gpu:!!navigator.gpu,origin:location.origin,scripts:document.scripts.length})",
            )
            console.log("SMOKE:" + result)
            // Give workers + WebGPU init a beat so failures surface in console.
            setTimeout(() => app.quit(), 4000)
        })
    }

    win.loadURL(`${ORIGIN}/index.html`)
}

// Single-instance lock — second launches focus the existing window.
if (!app.requestSingleInstanceLock()) {
    app.quit()
} else {
    app.on("second-instance", () => {
        const [win] = BrowserWindow.getAllWindows()
        if (win) {
            if (win.isMinimized()) win.restore()
            win.focus()
        }
    })

    app.whenReady().then(() => {
        protocol.handle(SCHEME, handleAppRequest)
        createWindow()

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow()
        })
    })

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit()
    })
}
