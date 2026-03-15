import type { Plugin, PluginBuild } from "esbuild"
import { mkdir } from "fs/promises"
import { default as fs, default as glob } from "fs/promises"
import * as path from "path"

const pluginName = "static-bundler"

// Content value: string = dest dir; [string, string] = [destDir, destFileName]
type StaticValue = string | [string, string]

// esbuild plugin for bundling (copying, for now) assets like HTML, CSS, images, etc
export default function staticBundler(content: Record<string, StaticValue>, log = console.log, onlyCopyIfNewer = true): Plugin {
    return {
        name: pluginName,
        setup(build: PluginBuild) {
            build.onStart(async () => {
                if (!build.initialOptions.outdir) {
                    throw new Error(`${pluginName} requires that outdir be specified`)
                }
                const outdir = build.initialOptions.outdir

                for (const key in content) {
                    const val = content[key]
                    const [destDir, destFileName] = Array.isArray(val) ? val : [val, null]
                    const outDir = path.join(outdir, destDir)
                    await mkdir(outDir, { recursive: true })

                    for await (const file of glob.glob(key)) {
                        const stats = await fs.stat(file)
                        const dest = path.join(outDir, destFileName ?? path.basename(file))
                        const fileMtimeMs = stats.mtimeMs

                        if (stats.isDirectory()) {
                            await mkdir(path.dirname(dest), { recursive: true })
                            await fs.cp(file, dest, { recursive: true })
                            log(`‣ Copied ${file} → ${dest}`)
                        } else if (stats.isFile()) {
                            if (onlyCopyIfNewer) {
                                let destMtimeMs = 0
                                try {
                                    destMtimeMs = (await fs.stat(dest)).mtimeMs
                                } catch { }
                                if (fileMtimeMs <= destMtimeMs) continue
                            }
                            await mkdir(path.dirname(dest), { recursive: true })
                            await fs.copyFile(file, dest)
                            log(`‣ Copied ${file} → ${dest}`)
                        }
                    }
                }
            })
        },
    }
}
