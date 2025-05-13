import type { Plugin, PluginBuild } from "esbuild"
import { mkdir } from "fs/promises"
import { default as fs, default as glob } from "fs/promises"
import * as path from "path"

const pluginName = "static-bundler"

// esbuild plugin for bundling (copying, for now) assets like HTML, CSS, images, etc
export default function staticBundler(content: Record<string, string>, log = console.log): Plugin {
    return {
        name: pluginName,
        setup(build: PluginBuild) {
            build.onStart(async () => {
                if (!build.initialOptions.outdir) {
                    throw new Error(`${pluginName} requires that outdir be set`)
                }

                for (const key in content) {
                    for await (const file of glob.glob(key)) {
                        const stats = await fs.stat(file)
                        const outDir = path.join(build.initialOptions.outdir, content[key])
                        await mkdir(outDir, { recursive: true })
                        const dest = path.join(outDir, path.basename(file))
                        const fileMtimeMs = stats.mtimeMs
                        let destMtimeMs = 0
                        try {
                            destMtimeMs = (await fs.stat(dest)).mtimeMs
                        } catch {}
                        if (fileMtimeMs > destMtimeMs) {
                            fs.copyFile(file, dest).then(() => log(`‣ Copied ${file} to ${dest}`))
                        }
                    }
                }
            })
        },
    }
}
