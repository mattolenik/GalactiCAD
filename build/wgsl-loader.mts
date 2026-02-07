import type { Plugin, PluginBuild } from "esbuild"
import fs from "fs/promises"
import * as path from "path"
import { create, globals } from 'webgpu'

Object.assign(globalThis, globals)
const navigator = { gpu: create(["backend=null"]) }
const pluginName = "wgsl-loader"


// esbuild plugin for loading WGSL files
//
// Usage:  `import fooShader from "./shaders/foo.wgsl";`
//
// where `fooShader` is any arbitrary name of your choosing.
// It will be a string value holding the contents of the shader.
//
// Features:
// * Supports recursive include in the form of `//:) include "path/to/file.wgsl"`
//                                       or of `//:)include "path/to/file.wgsl"`
//
export default async function wgslLoader(extensions = ["wgsl"]): Promise<Plugin> {
    if (extensions.length === 0) {
        throw new Error("must specify at least one file extension for WGSL shaders")
    }
    var extsPattern = extensions.map(e => `(${e})`).join("|")
    const pattern = new RegExp(`\.${extsPattern}$`, "")

    const adapter = await navigator.gpu.requestAdapter()
    const device = await adapter!.requestDevice()

    return {
        name: pluginName,
        setup: async (build: PluginBuild) => {

            build.onDispose(async () => {
                device.destroy()
            })

            build.onLoad({ filter: pattern, namespace: "file" }, async args => {
                const source = await load(args.path)
                if (!source) {
                    throw new Error(`[${pluginName}] Failed to load shader at "${args.path}"`)
                }
                const code = source.join("\n")
                const results = device.createShaderModule({ code: code })
                const info = await results.getCompilationInfo()

                const formatMessage = (m: GPUCompilationMessage) => {
                    return {
                        text: m.message,
                        location: {
                            file: args.path,
                            line: m.lineNum,
                            column: m.linePos - 1,
                            lineText: source[m.lineNum - 1],
                            length: m.length
                        }
                    }
                }
                const errors = info.messages.filter(m => m.type === "error").map(formatMessage)
                const warnings = info.messages.filter(m => m.type === "warning").map(formatMessage)

                return { pluginName: pluginName, contents: code, loader: "text", errors: errors, warnings: warnings }
            })
        }
    }
}

/**
 * Recursively loads a text file, inlining any lines of the form
 * #include "relative/path.ext"
 *
 * @param filePath Absolute or relative path to the file to load.
 * @param visited The paths already visited
 * @returns The file text with any #include statements inlined.
 */
async function load(filePath: string, visited = new Set<string>()): Promise<string[]> {
    const absPath = path.resolve(filePath)

    if (visited.has(absPath)) {
        return []
    }
    visited.add(absPath)

    let content: string
    try {
        content = await fs.readFile(absPath, "utf8")
    } catch (err) {
        throw new Error(`Failed to read file "${absPath}": ${err}`)
    }

    // Directory of this file, so includes can be resolved relative to it
    const dirOfFile = path.dirname(absPath)

    const lines = content.split(/\r?\n/)
    let result: string[] = []

    // Matches the style of:  //:) include "file.ext"
    const pattern = /^\/\/:\)\s*include\s+"([^"]+)"\s*$/

    for (const line of lines) {
        const includeMatch = line.match(pattern)
        if (includeMatch) {
            const includePath = includeMatch[1]
            const nestedFile = path.resolve(dirOfFile, includePath)

            // Recursively load and inline
            const nestedContent = await load(nestedFile, visited)
            result.push(...nestedContent)
        } else {
            // Ordinary line, just copy it
            result.push(line)
        }
    }

    return result
}
