// electron-builder afterAllArtifactBuild hook.
//
// The afterSign hook (notarize.cjs) already notarized + stapled the .app, so
// the .app inside the dmg AND the zip both carry offline-verifiable tickets.
//
// A .dmg, however, can only be stapled if the DMG ITSELF has a notarization
// ticket. Notarizing the app inside it is not enough: `stapler` looks up the
// dmg's own hash and Apple's notary service returns "Record not found"
// (CloudKit NOT_FOUND), failing with error 65. So here we submit each .dmg to
// the notary service and then staple it, giving Gatekeeper an offline-
// verifiable container (no network round-trip when the user opens the dmg).
//
// Uses the same keychain credential profile as notarize.cjs; override with
// NOTARYTOOL_PROFILE. Skip entirely with CSC_IDENTITY_AUTO_DISCOVERY=false.
// A failure here throws so a broken pack surfaces immediately rather than
// shipping unstapled dmgs (which `make electron-verify` would later reject).

"use strict"

const { execFile } = require("node:child_process")
const { promisify } = require("node:util")

const exec = promisify(execFile)

const PROFILE = process.env.NOTARYTOOL_PROFILE || "galacticad-notarytool"

module.exports = async function stapleArtifacts(context) {
    if (process.platform !== "darwin") return []
    if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return []

    const dmgs = (context.artifactPaths || []).filter(p => p.endsWith(".dmg"))
    for (const p of dmgs) {
        console.log(`[staple-dmg] notarizing ${p} (profile: ${PROFILE})`)
        const startedAt = Date.now()
        await exec("xcrun", [
            "notarytool", "submit", p,
            "--keychain-profile", PROFILE,
            "--wait",
        ])
        console.log(`[staple-dmg] stapling ${p}`)
        await exec("xcrun", ["stapler", "staple", p])
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
        console.log(`[staple-dmg] stapled ${p} in ${elapsedSec}s`)
    }
    return []
}
