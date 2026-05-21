import {
    DEBUG_LOG_MODULES,
    mergeDebugLogModulesFromStorage,
    type DebugLogModulesState,
    type LogModule,
} from "../logging/debug-log.mjs"
import {
    DEVTOOLS_SECTION_LOGS,
    dispatchDevToolsStateChange,
    type DevToolsPersistable,
    type JSONValue,
} from "./dev-tools-protocol.mjs"
import { devToolsBaseShadowCss } from "./dev-tools-styles.mjs"
import "./dev-tools-collapse.mjs"

export class DevToolsLogsSection extends HTMLElement implements DevToolsPersistable {
    readonly devToolsSectionId = DEVTOOLS_SECTION_LOGS
    #debugLogCheckboxes = new Map<LogModule, HTMLInputElement>()
    #applying = false

    onDebugLogModulesChange?: () => void

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")
        style.textContent = devToolsBaseShadowCss()
        shadow.appendChild(style)

        const debugAllRow = document.createElement("div")
        debugAllRow.style.display = "flex"
        debugAllRow.style.gap = "6px"
        debugAllRow.style.flexWrap = "wrap"
        const allOn = document.createElement("button")
        allOn.textContent = "All on"
        const allOff = document.createElement("button")
        allOff.textContent = "All off"
        const persist = () => {
            if (this.#applying) return
            dispatchDevToolsStateChange(this, this.devToolsSectionId)
            this.onDebugLogModulesChange?.()
        }
        const setAll = (on: boolean) => {
            for (const mod of DEBUG_LOG_MODULES) {
                const cb = this.#debugLogCheckboxes.get(mod)
                if (cb) cb.checked = on
            }
            persist()
        }
        allOn.addEventListener("click", () => setAll(true))
        allOff.addEventListener("click", () => setAll(false))
        debugAllRow.append(allOn, allOff)
        shadow.appendChild(debugAllRow)

        const debugLogGrid = document.createElement("div")
        debugLogGrid.className = "debug-log-list"
        shadow.appendChild(debugLogGrid)

        for (const mod of DEBUG_LOG_MODULES) {
            const cb = this.#addCheckbox(debugLogGrid, mod, true)
            this.#debugLogCheckboxes.set(mod, cb)
            cb.addEventListener("change", persist)
        }
    }

    getDevToolsState(): Record<string, JSONValue> {
        const o: Record<string, JSONValue> = {}
        for (const mod of DEBUG_LOG_MODULES) {
            o[mod] = this.#debugLogCheckboxes.get(mod)?.checked === true
        }
        return o
    }

    setDevToolsState(state: Record<string, JSONValue>): void {
        this.#applying = true
        try {
            const merged = mergeDebugLogModulesFromStorage(state)
            for (const mod of DEBUG_LOG_MODULES) {
                const cb = this.#debugLogCheckboxes.get(mod)
                if (cb) cb.checked = merged[mod] !== false
            }
        } finally {
            this.#applying = false
        }
    }

    /** Apply flags from storage (same shape as getDevToolsState). */
    syncFromSettings(state: DebugLogModulesState): void {
        this.setDevToolsState(state as Record<string, JSONValue>)
    }

    #addCheckbox(parent: ParentNode, label: string, checked: boolean): HTMLInputElement {
        const el = document.createElement("label")
        const cb = document.createElement("input")
        cb.type = "checkbox"
        cb.checked = checked
        el.append(cb, label)
        parent.appendChild(el)
        return cb
    }
}

customElements.define("dev-tools-logs-section", DevToolsLogsSection)

declare global {
    interface HTMLElementTagNameMap {
        "dev-tools-logs-section": DevToolsLogsSection
    }
}
