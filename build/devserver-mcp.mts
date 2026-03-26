import type { IncomingMessage, ServerResponse } from "http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import * as z from "zod"

function clampLogCount(n: number): number {
    if (!Number.isFinite(n)) return 100
    return Math.min(10_000, Math.max(1, Math.floor(n)))
}

/**
 * Stateless Streamable HTTP MCP: one `McpServer` + transport per POST (see SDK
 * `simpleStatelessStreamableHttp` example).
 */
export function createMcpPostHandler(requestConsoleLogs: (n: number) => Promise<string[] | null>) {
    return async (req: IncomingMessage, res: ServerResponse, parsedBody: unknown) => {
        const server = new McpServer(
            {
                name: "galacticad-devserver",
                version: "0.0.0",
            },
            {
                instructions:
                    "Devserver MCP bridge: fetch recent unified dev log lines (debug-log.mts + mirrored console) from the main thread buffer, " +
                    "including lines forwarded from workers (render, transpile). Returns JSON text: string[] or null if logs could not be retrieved.",
            }
        )

        server.registerTool(
            "get_console_log_lines",
            {
                description:
                    "Fetch the last n unified dev log lines (debug-log.mts when modules are enabled, mirrored console on main/render/transpile workers). " +
                    "Default n is 100. Returns JSON text: string[] or null.",
                inputSchema: {
                    n: z.number().int().min(1).max(10_000).optional().describe("Number of recent log lines to return (default 100)"),
                },
            },
            async (args: { n?: number }) => {
                const n = clampLogCount(args?.n ?? 100)
                const lines = await requestConsoleLogs(n)
                const text = lines === null ? "null" : JSON.stringify(lines)
                return {
                    content: [{ type: "text" as const, text }],
                }
            }
        )

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        })
        await server.connect(transport)
        await transport.handleRequest(req, res, parsedBody)
        res.on("close", () => {
            void transport.close().catch(() => undefined)
            void server.close().catch(() => undefined)
        })
    }
}

/** CORS preflight for MCP clients hitting localhost. */
export function handleMcpOptions(res: ServerResponse) {
    res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, mcp-session-id, accept",
        "Access-Control-Max-Age": "86400",
    })
    res.end()
}

export function mcpMethodNotAllowed(res: ServerResponse, method: string) {
    res.writeHead(405, { "content-type": "application/json", "Access-Control-Allow-Origin": "*" })
    res.end(
        JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32_000, message: `Method not allowed: ${method}` },
            id: null,
        })
    )
}
