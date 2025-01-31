import fs from "fs/promises"
import * as path from "path"
import type { Plugin, PluginBuild } from "esbuild"

// esbuild plugin for bundling (copying, for now) assets like HTML, CSS, etc
export function assetBundler(files: string[]): Plugin {
    return {
        name: "asset-bundler",
        setup(build: PluginBuild) {
            build.onStart(() => {
                if (!build.initialOptions.outdir) {
                    throw new Error("asset-bundler requires that outdir be set")
                }
                for (const file of files) {
                    const dest = path.join(build.initialOptions.outdir, path.basename(file))
                    fs.copyFile(file, dest).then(() => console.log(`  ‣ Copied ${file} to ${dest}`))
                }
            })
        },
    }
}
