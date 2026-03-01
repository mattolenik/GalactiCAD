import { readdir } from "fs/promises"
import * as path from "path"
import type { Plugin } from "esbuild"

const SAMPLES_DIR = path.join(process.cwd(), "src/scene/samples")

export async function fileListerPlugin(): Promise<Plugin> {
    const files = await readdir(SAMPLES_DIR)
    const sampleNames = files
        .filter((f) => f.endsWith(".gcad"))
        .sort((a, b) => a.localeCompare(b))

    return {
        name: "file-lister",
        setup(build) {
            build.initialOptions.define = {
                ...build.initialOptions.define,
                __SAMPLE_NAMES__: JSON.stringify(sampleNames),
            }
        },
    }
}
