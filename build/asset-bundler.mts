import type { Plugin, PluginBuild } from "esbuild"
import { default as fs, default as glob } from "fs/promises"
import * as path from "path"

const pluginName = "asset-bundler"

// esbuild plugin for bundling (copying, for now) assets like HTML, CSS, images, etc
export default function assetBundler(filesOrGlobs: string[] | string): Plugin {
    return {
        name: pluginName,
        setup(build: PluginBuild) {
            build.onStart(async () => {
                if (!build.initialOptions.outdir) {
                    throw new Error(`${pluginName} requires that outdir be set`)
                }

                for await (const file of glob.glob(filesOrGlobs)) {
                    const stats = await fs.stat(file)
                    const dest = path.join(build.initialOptions.outdir, path.basename(file))
                    const fileMtimeMs = stats.mtimeMs
                    let destMtimeMs = 0
                    try {
                        destMtimeMs = (await fs.stat(dest)).mtimeMs
                    } catch {}
                    if (fileMtimeMs > destMtimeMs) {
                        fs.copyFile(file, dest).then(() => console.log(`           ‣ Copied ${file} to ${dest}`))
                    }
                }
            })
        },
    }
}
