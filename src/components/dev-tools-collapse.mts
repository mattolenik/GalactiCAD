import { __fg_color, __tone_1 } from "../style/style.mjs"
import { SettingsManager } from "../storage/settings.mjs"
import { DEFAULT_DEVTOOLS_COLLAPSE_OPEN } from "./dev-tools-protocol.mjs"

/**
 * Collapsible box for grouping related dev tools controls.
 * Light DOM children are slotted into the expandable body.
 *
 * Optional **`collapse-id`** (see `DEVTOOLS_COLLAPSE`): when set, expanded state is
 * restored from and saved to `GlobalSettings.app.devToolsCollapseOpen`.
 */
export class DevToolsCollapse extends HTMLElement {
    static observedAttributes = ["label", "open", "nested", "collapse-id"]

    #details: HTMLDetailsElement
    #summaryEl: HTMLElement
    #applyingStoredOpen = false

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")
        style.textContent = `
            :host {
                display: block;
                align-self: stretch;
                min-width: 0;
                width: 100%;
                box-sizing: border-box;
            }
            :host([hidden]) {
                display: none !important;
            }
            details {
                border: 1px solid var(${__tone_1});
                border-radius: 4px;
                background: rgb(from var(${__fg_color}) r g b / 0.06);
                padding: 4px 8px 6px;
                box-sizing: border-box;
            }
            :host([nested]) details {
                border-color: rgb(from var(${__fg_color}) r g b / 0.12);
                background: rgb(from var(${__fg_color}) r g b / 0.04);
                padding: 3px 6px 5px;
            }
            summary {
                cursor: pointer;
                list-style: none;
                font-size: 11px;
                font-weight: 600;
                letter-spacing: 0.02em;
                color: rgb(from var(${__fg_color}) r g b / 0.9);
                user-select: none;
                display: flex;
                align-items: center;
                gap: 5px;
            }
            summary::-webkit-details-marker {
                display: none;
            }
            .chev {
                display: inline-block;
                font-size: 9px;
                opacity: 0.75;
                transition: transform 0.12s ease;
            }
            details[open] .chev {
                transform: rotate(90deg);
            }
            .body {
                display: flex;
                flex-direction: column;
                align-items: flex-start;
                gap: 6px;
                padding-top: 6px;
            }
            :host([nested]) .body {
                gap: 4px;
                padding-top: 4px;
            }
        `
        const details = document.createElement("details")
        details.open = true
        const summary = document.createElement("summary")
        const chev = document.createElement("span")
        chev.className = "chev"
        chev.textContent = "▸"
        const title = document.createElement("span")
        title.className = "title"
        title.textContent = "Section"
        summary.append(chev, title)

        const body = document.createElement("div")
        body.className = "body"
        const slot = document.createElement("slot")
        body.appendChild(slot)
        details.append(summary, body)

        shadow.append(style, details)
        this.#details = details
        this.#summaryEl = summary

        this.#details.addEventListener("toggle", () => {
            if (this.#applyingStoredOpen) return
            const id = this.getAttribute("collapse-id")
            if (!id) return
            SettingsManager.instance.mergeGlobalDevToolsCollapse(id, this.#details.open)
        })
    }

    attributeChangedCallback(name: string, _old: string | null, newVal: string | null): void {
        if (name === "label") {
            const titleEl = this.#summaryEl.querySelector(".title")
            if (titleEl) titleEl.textContent = newVal ?? "Section"
        }
        if (name === "open" && newVal !== null && !this.getAttribute("collapse-id")) {
            this.#details.open = newVal !== "false"
        }
        if (name === "collapse-id" && this.isConnected) {
            void this.#applyStoredOpenAfterReady()
        }
    }

    connectedCallback(): void {
        this.#syncFromAttributes()
        void this.#applyStoredOpenAfterReady()
    }

    #syncFromAttributes(): void {
        const titleEl = this.#summaryEl.querySelector(".title")
        if (titleEl) titleEl.textContent = this.getAttribute("label") ?? "Section"
        const openAttr = this.getAttribute("open")
        if (openAttr !== null && !this.getAttribute("collapse-id")) {
            this.#details.open = openAttr !== "false"
        }
        this.toggleAttribute("nested", this.hasAttribute("nested"))
    }

    async #applyStoredOpenAfterReady(): Promise<void> {
        const id = this.getAttribute("collapse-id")
        if (!id) return
        await SettingsManager.instance.ready()
        const stored = SettingsManager.instance.getGlobal().app.devToolsCollapseOpen[id]
        const fallback =
            (DEFAULT_DEVTOOLS_COLLAPSE_OPEN as Partial<Record<string, boolean>>)[id] ?? true
        const open = typeof stored === "boolean" ? stored : fallback
        this.#applyingStoredOpen = true
        try {
            this.#details.open = open
        } finally {
            this.#applyingStoredOpen = false
        }
    }
}

customElements.define("dev-tools-collapse", DevToolsCollapse)

declare global {
    interface HTMLElementTagNameMap {
        "dev-tools-collapse": DevToolsCollapse
    }
}
