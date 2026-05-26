// Preload runs in an isolated world with limited Node access. The app is a
// pure web app (File System Access API is native to Chromium, no native
// bridge needed), so this is intentionally minimal — kept around as the
// single place to expose IPC if anything ever does need it.
//
// Preload scripts are loaded as CJS regardless of "type": "module" in the
// app's package.json (Electron requires this).
"use strict"
