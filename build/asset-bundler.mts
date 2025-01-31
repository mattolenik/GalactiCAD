import type { Plugin, PluginBuild } from "esbuild"
import fs from "fs/promises"
import * as path from "path"

// esbuild plugin for bundling (copying, for now) assets like HTML, CSS, etc
export function assetBundler(files: string[]): Plugin {
    return {
        name: "asset-bundler",
        setup(build: PluginBuild) {
            build.onStart(async () => {
                if (!build.initialOptions.outdir) {
                    throw new Error("asset-bundler requires that outdir be set")
                }
                for (const file of files) {
                    const stats = await fs.stat(file)
                    const dest = path.join(build.initialOptions.outdir, path.basename(file))
                    const fileMtimeMs = stats.mtimeMs
                    let destMtimeMs = 0
                    try {
                        destMtimeMs = (await fs.stat(dest)).mtimeMs
                    } catch {}
                    if (fileMtimeMs > destMtimeMs) {
                        fs.copyFile(file, dest).then(() => console.log(`  ‣ Copied ${file} to ${dest}`))
                    }
                }
            })
        },
    }
}
