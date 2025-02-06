import fs from "fs/promises"
import * as path from "path"
import type { Plugin, PluginBuild } from "esbuild"

// esbuild plugin for loading WGSL files
//
// Usage:  `import fooShader from "./shaders/foo.wgsl";`
//
// where `fooShader` is any arbitrary name of your choosing.
// It will be a string value holding the contents of the shader.
//
// Features:
// * Supports recursive #include in the form of `#include "path/to/file.wgsl"`
//                                        or of `// #include "path/to/file.wgsl"`
//
export default function wgslLoader(includeCommentedLines = true, extensions = ["wgsl"]): Plugin {
    if (extensions.length === 0) {
        throw new Error("must specify at least one file extension for WGSL shaders")
    }
    var extsPattern = extensions.map((e) => `(${e})`).join("|")
    const pattern = new RegExp(`\.${extsPattern}$`, "g")
    return {
        name: "wgsl-loader",
        setup(build: PluginBuild) {
            build.onLoad({ filter: pattern, namespace: "file" }, async (args) => {
                const contents = await load(args.path)
                return { contents, loader: "text" }
            })
        },
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
async function load(filePath: string, visited = new Set<string>()): Promise<string> {
    // Resolve filePath to an absolute path so we track visited files consistently.
    const absPath = path.resolve(filePath)

    // If we’ve already visited this file, skip to prevent infinite recursion
    // from circular includes.
    if (visited.has(absPath)) {
        // You might prefer to throw an error instead. For example:
        // throw new Error(`Circular include detected: ${absPath}`);
        return ""
    }
    visited.add(absPath)

    // Read file contents
    let content: string
    try {
        content = await fs.readFile(absPath, "utf8")
    } catch (err) {
        throw new Error(`Failed to read file "${absPath}": ${err}`)
    }

    // Directory of this file, so #includes can be resolved relative to it.
    const dirOfFile = path.dirname(absPath)

    // Split into lines and process each line
    const lines = content.split(/\r?\n/)
    let result = ""

    // Matches the style of:  //- include "file.ext"
    const pattern = /^\/\/-\s*include\s+"([^"]+)"\s*$/

    for (const line of lines) {
        const includeMatch = line.match(pattern)
        if (includeMatch) {
            // We have an #include line with a relative path
            const includePath = includeMatch[1]
            const nestedFile = path.resolve(dirOfFile, includePath)

            // Recursively load and inline
            const nestedContent = load(nestedFile, visited)
            result += nestedContent + "\n"
        } else {
            // Ordinary line, just copy it
            result += line + "\n"
        }
    }

    return result
}
