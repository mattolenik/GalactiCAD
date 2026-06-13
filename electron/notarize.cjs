// electron-builder afterSign hook.
//
// Submits the just-signed .app to Apple's notary service via @electron/notarize
// using a keychain-stored credential profile (no Apple ID / app-specific
// password in env), then staples the returned ticket to the .app.
//
// After a successful submission, fetches the notary log (Apple recommends
// always inspecting it, even on Accepted submissions — warnings about
// signing or bundle structure surface here).
//
// One-time setup on each developer machine:
//
//     xcrun notarytool store-credentials galacticad-notarytool \
//         --apple-id "you@example.com" \
//         --team-id  "ABCD123456" \
//         --password "abcd-efgh-ijkl-mnop"   # app-specific password
//
// Override the profile name with NOTARYTOOL_PROFILE if needed.
// Set CSC_IDENTITY_AUTO_DISCOVERY=false to skip signing + notarization
// entirely (unsigned local dev build).

"use strict"

const { notarize } = require("@electron/notarize")
const { execFile } = require("node:child_process")
const { promisify } = require("node:util")
const path = require("node:path")

const exec = promisify(execFile)

const PROFILE = process.env.NOTARYTOOL_PROFILE || "galacticad-notarytool"

module.exports = async function notarizing(context) {
    const { electronPlatformName, appOutDir, packager } = context
    if (electronPlatformName !== "darwin") return
    if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") {
        console.log("[notarize] CSC_IDENTITY_AUTO_DISCOVERY=false; skipping")
        return
    }

    const appName = packager.appInfo.productFilename
    const appPath = path.join(appOutDir, `${appName}.app`)

    console.log(`[notarize] submitting ${appPath} (profile: ${PROFILE})`)
    const startedAt = Date.now()
    await notarize({
        tool: "notarytool",
        appPath,
        keychainProfile: PROFILE,
    })
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
    console.log(`[notarize] accepted + stapled in ${elapsedSec}s`)

    // Apple: "Always check the log file, even if notarization succeeds,
    // because it might contain warnings that you can fix prior to your next
    // submission." (notarizing-macos-software-before-distribution)
    await printLatestLog()
}

async function printLatestLog() {
    let id
    try {
        const { stdout } = await exec("xcrun", [
            "notarytool",
            "history",
            "--keychain-profile",
            PROFILE,
            "--output-format",
            "json",
        ])
        id = JSON.parse(stdout)?.history?.[0]?.id
    } catch (e) {
        console.log(`[notarize] could not read submission history: ${e.message.trim()}`)
        return
    }
    if (!id) {
        console.log("[notarize] no submission id in history; skipping log fetch")
        return
    }

    let log
    try {
        const { stdout } = await exec("xcrun", [
            "notarytool",
            "log",
            id,
            "--keychain-profile",
            PROFILE,
        ])
        log = JSON.parse(stdout)
    } catch (e) {
        console.log(`[notarize] could not fetch log for ${id}: ${e.message.trim()}`)
        return
    }

    const issues = Array.isArray(log.issues) ? log.issues : []
    if (issues.length === 0) {
        console.log(`[notarize] log clean for submission ${id}`)
        return
    }
    console.log(`[notarize] submission ${id}: ${issues.length} issue(s) in log:`)
    for (const i of issues) {
        const loc = i.path ? ` ${i.path}` : ""
        console.log(`  [${i.severity}]${loc} ${i.message}`)
    }
}
