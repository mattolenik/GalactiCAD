// electron-builder afterAllArtifactBuild hook.
//
// The afterSign hook already stapled the .app (so the .app inside the dmg
// AND inside the zip both have offline-verifiable tickets). This hook
// additionally staples the .dmg containers themselves — Apple's docs list
// disk images as a valid stapling target, and stapling here means
// Gatekeeper validates the dmg without needing to make a network round-trip
// to look the ticket up online.

"use strict"

const { execFile } = require("node:child_process")
const { promisify } = require("node:util")

const exec = promisify(execFile)

module.exports = async function stapleArtifacts(context) {
    if (process.platform !== "darwin") return []
    if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return []

    const dmgs = (context.artifactPaths || []).filter(p => p.endsWith(".dmg"))
    for (const p of dmgs) {
        try {
            console.log(`[staple-dmg] stapling ${p}`)
            await exec("xcrun", ["stapler", "staple", p])
        } catch (e) {
            console.log(`[staple-dmg] failed for ${p}: ${e.message.trim()}`)
        }
    }
    return []
}
