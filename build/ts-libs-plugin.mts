import fs from "fs"
import path from "path"
import { createRequire } from "module"
import type { Plugin } from "esbuild"
import * as ts from "typescript"
import { knownLibFilesForCompilerOptions } from "@typescript/vfs"

const require = createRequire(import.meta.url)

/**
 * Bundles the TypeScript `lib.*.d.ts` files the CAD language service needs into a
 * virtual `ts-libs` module, so the in-browser @typescript/vfs environment type-checks
 * fully OFFLINE — no runtime CDN fetch (the alternative, `createDefaultMapFromCDN`,
 * would flag every built-in as an error when offline).
 *
 * The exported value is a `Record<"/lib.xxx.d.ts", string>` keyed the same way
 * @typescript/vfs keys its fsMap (leading slash), ready to spread into the fsMap.
 */
export function tsLibsPlugin(): Plugin {
    // Must match the compiler options used in src/editor/ts-environment.mts so the
    // bundled lib set matches what the language service actually requests.
    const compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ESNext,
        lib: ["esnext"],
    }

    return {
        name: "ts-libs",
        setup(build) {
            const NS = "ts-libs"
            build.onResolve({ filter: /^ts-libs$/ }, () => ({ path: NS, namespace: NS }))
            build.onLoad({ filter: /.*/, namespace: NS }, () => {
                const libDir = path.dirname(require.resolve("typescript"))
                const names = new Set(knownLibFilesForCompilerOptions(compilerOptions, ts))
                // Hedge: include the target's default lib file too, in case the host
                // requests it directly (getDefaultLibFileName).
                names.add(ts.getDefaultLibFileName(compilerOptions))
                const map: Record<string, string> = {}
                for (const name of names) {
                    const file = path.join(libDir, name)
                    if (fs.existsSync(file)) map["/" + name] = fs.readFileSync(file, "utf8")
                }
                return { contents: `export default ${JSON.stringify(map)}`, loader: "js" }
            })
        },
    }
}

export default tsLibsPlugin
