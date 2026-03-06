/**
 * Transpile CAD source (TypeScript/JavaScript) to executable JavaScript using esbuild-wasm.
 * Used by the render worker for scene builds. TypeScript remains in the main thread for
 * SourceParser (AST-based source matching).
 */

import * as esbuild from "esbuild-wasm"
import { WRAP_PREFIX, WRAP_SUFFIX } from "./parser/source-parser.mjs"

const WASM_URL = "/assets/esbuild.wasm"

let initPromise: Promise<void> | null = null

async function ensureInitialized(): Promise<void> {
    if (!initPromise) {
        initPromise = esbuild.initialize({ wasmURL: WASM_URL })
    }
    await initPromise
}

/**
 * Transpile CAD source to JavaScript body suitable for new Function(...).
 * Wraps source in function _() { ... }, transpiles, and appends "return _();".
 * @throws Error with first diagnostic message on syntax/compile errors
 */
export async function transpileCadSource(src: string): Promise<string> {
    await ensureInitialized()
    const wrapped = WRAP_PREFIX + src + WRAP_SUFFIX
    try {
        const result = await esbuild.transform(wrapped, {
            loader: "ts",
            target: "esnext",
        })
        return result.code + "\nreturn _();"
    } catch (err) {
        const failure = err as { errors?: Array<{ text: string }> }
        if (failure.errors && failure.errors.length > 0) {
            throw new Error(failure.errors[0].text)
        }
        throw err
    }
}
