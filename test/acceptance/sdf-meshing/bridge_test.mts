import assert from "node:assert/strict"
import { test } from "node:test"
import { BrowserBridge } from "../../../build/devserver-bridge.mjs"

test("retained captures stay on their original browser when another tab becomes ready", async () => {
    const bridge = new BrowserBridge()
    const delivered: string[] = []
    const socket = (name: string) => ({ readyState: 1, send: (raw: string) => {
        const message = JSON.parse(raw)
        delivered.push(name)
        queueMicrotask(() => bridge.handleClientMessage(Buffer.from(JSON.stringify({ type: "agentRenderResult", id: message.id, capture: { captureId: "capture" } }))))
    } })
    const a = socket("a"), b = socket("b")
    bridge.setWsServer({ clients: new Set([a, b]) } as any)
    const ready = (s: unknown) => bridge.handleClientMessage(Buffer.from('{"type":"agentBridgeReady"}'), s as any)
    ready(a)
    const request = (action: string) => bridge.requestAgentRender({ kind: "meshAcceptance", captureId: "capture", action }, 100)
    assert.ok((await request("prepare"))?.capture)
    ready(b)
    assert.ok((await request("export"))?.capture)
    assert.deepEqual(delivered, ["a", "a"])
    a.readyState = 3
    assert.match((await request("view"))?.error ?? "", /disconnected/)
    assert.deepEqual(delivered, ["a", "a"])
})

test("a blocked browser RPC times out in the server and releases the request queue", async () => {
    const bridge = new BrowserBridge()
    const s = { readyState: 1, send() {} }
    bridge.setWsServer({ clients: new Set([s]) } as any)
    assert.equal(await bridge.requestAgentRender({ kind: "meshAcceptance", captureId: "blocked", action: "prepare" }, 10), null)
    const next = await bridge.requestAgentRender({ kind: "meshAcceptance", captureId: "other", action: "prepare" }, 10)
    assert.match(next?.error ?? "", /owns this browser/)
})
