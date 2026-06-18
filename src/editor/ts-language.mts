/**
 * CodeMirror 6 language-service integration for the CAD DSL: completion, hover,
 * and type-error diagnostics from a @typescript/vfs environment running in a Web
 * Worker (ts-worker.mts), via @valtown/codemirror-ts's `*Worker` extensions and
 * comlink. This replaces the IntelliSense Monaco's ts.worker gave us, off-thread.
 *
 * Document syncing is driven by the caller (CodeEditor.onUpdate) rather than the
 * library's `tsSyncWorker`: that helper shares one "first load" flag across all
 * states, so with one editor + many tab states it would only sync the first
 * document (and the post-setState tab-switch update has docChanged=false). Driving
 * `worker.updateFile` from the always-on update listener handles typing AND tab
 * switches, keeping a single vfs path.
 *
 * The completion source is registered as JS/TS language data so it composes with
 * the base `javascript()` grammar + `autocompletion()` already in CodeEditor.
 */

import type { Extension } from "@codemirror/state"
import { EditorView, hoverTooltip } from "@codemirror/view"
import { javascriptLanguage } from "@codemirror/lang-javascript"
import { tsAutocompleteWorker, tsFacetWorker, tsLinterWorker } from "@valtown/codemirror-ts"
import type { WorkerShape } from "@valtown/codemirror-ts/worker"
import * as Comlink from "comlink"
import { CAD_DOC_PATH, DIAGNOSTIC_CODES_TO_IGNORE } from "./ts-shared.mjs"
import { SHAPE_ICON_CLASS } from "../highlighting/cad-highlighter.mjs"

/** Minimal quick-info renderer (mirrors @valtown/codemirror-ts's defaultRenderer,
 *  which isn't exported from the package root). */
interface QuickInfoLike {
    quickInfo?: { displayParts?: { kind: string; text: string }[] }
}
function renderHoverTooltip(info: QuickInfoLike): { dom: HTMLElement } {
    const div = document.createElement("div")
    for (const part of info.quickInfo?.displayParts ?? []) {
        const span = div.appendChild(document.createElement("span"))
        span.className = `quick-info-${part.kind}`
        span.innerText = part.text
    }
    return { dom: div }
}

export interface CadTsLanguage {
    extension: Extension
    /** Push the active document's text into the worker. Call on every editor update. */
    sync(content: string): void
    /** Resolves once the worker's TS environment is initialized (libs + CAD types loaded). */
    whenReady: Promise<void>
}

export function createCadTsLanguageExtension(): CadTsLanguage {
    // Output path mirrors the bundled entry (build.mts) relative to app.js's root.
    const workerUrl = new URL("./editor/ts-worker.js", import.meta.url)
    const worker = Comlink.wrap(new Worker(workerUrl, { type: "module", name: "ts-language" })) as unknown as WorkerShape
    const whenReady = Promise.resolve(worker.initialize())

    let lastSynced: string | null = null
    const sync = (content: string): void => {
        if (content === lastSynced) return
        lastSynced = content
        // The vfs host treats an empty file as missing (TS6053); keep ≥1 char.
        const code = content.length ? content : " "
        void whenReady.then(() => worker.updateFile({ path: CAD_DOC_PATH, code }))
    }

    // The shape-icon widgets sit at the same offset as the function name, so the
    // TS hover would otherwise fire when hovering an icon. Track whether the pointer
    // is over an icon and suppress the definition tooltip there — the icon's only
    // popup is the custom "Edit polygon" menu (app.mts).
    let pointerOverShapeIcon = false
    const trackIconHover = EditorView.domEventHandlers({
        mousemove(e) {
            const t = e.target as HTMLElement | null
            pointerOverShapeIcon = !!t?.closest?.("." + SHAPE_ICON_CLASS)
            return false
        },
        mouseleave() {
            pointerOverShapeIcon = false
            return false
        },
    })

    // Reimplements @valtown/codemirror-ts's tsHoverWorker with the icon guard.
    const tsHover = hoverTooltip(async (view, pos) => {
        if (pointerOverShapeIcon) return null
        const config = view.state.facet(tsFacetWorker)
        if (!config) return null
        const hoverData = await config.worker.getHover({ path: config.path, pos })
        if (!hoverData) return null
        return {
            pos: hoverData.start,
            end: hoverData.end,
            create: () => renderHoverTooltip(hoverData as QuickInfoLike),
        }
    })

    const extension: Extension = [
        tsFacetWorker.of({ worker, path: CAD_DOC_PATH }),
        tsLinterWorker({ diagnosticCodesToIgnore: DIAGNOSTIC_CODES_TO_IGNORE }),
        javascriptLanguage.data.of({ autocomplete: tsAutocompleteWorker() }),
        trackIconHover,
        tsHover,
    ]
    return { extension, sync, whenReady }
}
