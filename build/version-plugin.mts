import { exec } from "child_process"
import type { Plugin } from "esbuild"

/** Uses the tag pointing to this commit, if any, otherwise use the git hash from: git describe --always --dirty */
async function getVersion(): Promise<string> {
    let ver = await sh("scripts/version")
    return ver[0]
}

async function sh(command: string): Promise<[stdout: string, stderr: string, exitCode: number]> {
    return new Promise((resolve) => {
        exec(command, { encoding: "utf8" }, (error, stdout, stderr) => {
            resolve([stdout.trim(), stderr.trim(), error?.code ?? 0])
        })
    })
}

export async function versionPlugin(): Promise<Plugin> {
    const version = await getVersion()
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
