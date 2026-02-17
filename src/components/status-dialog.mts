import { __fg_color, __tone_1, __tone_2, __tone_3 } from "../style/style.mjs"
import { BaseDialog } from "./base-dialog.mjs"

export class StatusDialog extends BaseDialog<void> {
    constructor(message: string, showOkButton = true) {
        super(message, showOkButton)
    }

    /**
     * Update the dialog message and optionally show the OK button
     */
    updateMessage(message: string, showOkButton = true) {
        const messageEl = this.shadow.querySelector(".message")
        const buttonsEl = this.shadow.querySelector(".buttons")
        if (messageEl) {
            messageEl.textContent = message
        }
        if (buttonsEl) {
            ;(buttonsEl as HTMLElement).style.display = showOkButton ? "flex" : "none"
        }
    }

    /**
     * Update the dialog content with HTML (e.g. for tables)
     */
    updateContentHtml(html: string, showOkButton = true) {
        const messageEl = this.shadow.querySelector(".message")
        const buttonsEl = this.shadow.querySelector(".buttons")
        if (messageEl) {
            messageEl.innerHTML = html
        }
        if (buttonsEl) {
            ;(buttonsEl as HTMLElement).style.display = showOkButton ? "flex" : "none"
        }
    }

    protected renderContent(message: string, showOkButton = true) {
        this.dialog.innerHTML = `
        <style>
            .dialog { min-width: 300px; }
            .message {
                font-size: 1.1em;
                color: var(${__fg_color});
                text-align: center;
            }
            .message table {
                text-align: left;
                border-collapse: collapse;
                font-family: monospace;
                font-size: 0.9em;
            }
            .message th, .message td {
                padding: 0.25em 0.75em;
                border: 1px solid var(${__tone_3});
            }
            .buttons { display: flex; gap: 1em; }
            .buttons.hidden { display: none; }
        </style>
        <div class="message">${this.#escapeHtml(message)}</div>
        <div class="buttons" ${showOkButton ? "" : 'style="display: none"'}>
            <button class="ok">OK</button>
        </div>`
    }

    #escapeHtml(text: string): string {
        const div = document.createElement("div")
        div.textContent = text
        return div.innerHTML
    }

    protected setupEventListeners(signal: AbortSignal) {
        const okButton = this.shadow.querySelector(".ok")
        if (okButton) {
            okButton.addEventListener("click", () => this.close(), { signal })
        }
        this.overlay.addEventListener("click", () => {
            const buttonsEl = this.shadow.querySelector(".buttons")
            if (buttonsEl && (buttonsEl as HTMLElement).style.display !== "none") {
                this.close()
            }
        }, { signal })
        window.addEventListener("keydown", this.#onKeyDown, { signal })
    }

    #onKeyDown = (e: KeyboardEvent) => {
        const buttonsEl = this.shadow.querySelector(".buttons")
        if (buttonsEl && (buttonsEl as HTMLElement).style.display !== "none") {
            if (e.key === "Escape" || e.key === "Enter") {
                e.preventDefault()
                this.close()
            }
        }
    }
}

customElements.define("status-dialog", StatusDialog)

declare global {
    interface HTMLElementTagNameMap {
        "status-dialog": StatusDialog
    }
}
