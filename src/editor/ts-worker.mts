/**
 * Web Worker hosting the CAD TypeScript language-service environment.
 *
 * Running the @typescript/vfs environment here keeps type-checking, completion,
 * and hover off the main thread (no input jank on large documents), and keeps the
 * `typescript` compiler + the lib.*.d.ts payload out of app.js. The main-thread
 * client (ts-language.mts) talks to this worker over comlink via the
 * @valtown/codemirror-ts `*Worker` extensions.
 *
 * `createWorker` returns the `WorkerShape` RPC surface (initialize / updateFile /
 * getLints / getAutocompletion / getHover); we expose it with comlink.
 */

import * as Comlink from "comlink"
import { createWorker } from "@valtown/codemirror-ts/worker"
import { createCadTsEnvironment } from "./ts-environment.mjs"

Comlink.expose(createWorker(() => createCadTsEnvironment()))
