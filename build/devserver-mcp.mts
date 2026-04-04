import type { IncomingMessage, ServerResponse } from "http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import * as z from "zod"

function clampLogCount(n: number): number {
    if (!Number.isFinite(n)) return 20
    return Math.min(10_000, Math.max(1, Math.floor(n)))
}

const logLevelsSchema = z.enum(["warn-error", "all"])

export type DevServerConsoleLogQuery = { n: number; levels: z.infer<typeof logLevelsSchema> }

/**
 * Stateless Streamable HTTP MCP: one `McpServer` + transport per POST (see SDK
 * `simpleStatelessStreamableHttp` example).
 */
export function createMcpPostHandler(
    requestConsoleLogs: (query: DevServerConsoleLogQuery) => Promise<string[] | null>,
) {
    return async (req: IncomingMessage, res: ServerResponse, parsedBody: unknown) => {
        const server = new McpServer(
            {
                name: "galacticad-devserver",
                version: "0.0.0",
            },
            {
                instructions:
                    "Devserver MCP: fetch unified dev log lines from the browser ring buffer (debug-log.mts + mirrored console on main/render/transpile workers). " +
                    "Default: up to 20 lines, warn and error only, newest first, duplicate full lines collapsed. " +
                    "Optional levels=all includes every line with a parseable [timestamp] [level] prefix. " +
                    "Returns JSON text: string[] or null if no tab connected / timeout / bridge error.",
            }
        )

        server.registerTool(
            "get_console_log_lines",
            {
                description:
                    "Fetch up to n unified dev log lines (newest first). Default n=20, levels=warn-error (only warn/error by the second [bracket] token). " +
                    "Duplicate lines (exact string) are always omitted. Use levels=all for all severities. JSON text: string[] or null.",
                inputSchema: {
                    n: z.number().int().min(1).max(10_000).optional().describe("Max lines after filter and dedupe (default 20)"),
                    levels: logLevelsSchema
                        .optional()
                        .describe('warn-error (default) or all lines with a [ts] [level] prefix'),
                },
            },
            async (args: { n?: number; levels?: z.infer<typeof logLevelsSchema> }) => {
                const n = clampLogCount(args?.n ?? 20)
                const levels = args?.levels ?? "warn-error"
                const lines = await requestConsoleLogs({ n, levels })
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
