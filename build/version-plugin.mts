import { execSync } from "child_process"
import type { Plugin } from "esbuild"

/** Same logic as Makefile VERSION: tag at HEAD, else git describe --always --dirty */
function getVersion(): string {
    try {
        const tag = execSync("git tag -l --points-at $(git describe --always)", { encoding: "utf8" }).trim()
        if (tag) return tag
        return execSync("git describe --always --dirty", { encoding: "utf8" }).trim()
    } catch {
        return "dev"
    }
}

export function versionPlugin(): Plugin {
    const version = getVersion()
    return {
        name: "version",
        setup(build) {
            build.initialOptions.define = {
                ...build.initialOptions.define,
                __VERSION__: JSON.stringify(version),
            }
        },
    }
}
