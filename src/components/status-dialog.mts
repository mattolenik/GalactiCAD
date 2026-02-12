import { __fg_color, __tone_1, __tone_2, __tone_3 } from "../style/style.mjs"

export class StatusDialog extends HTMLElement {
    #ac = new AbortController()
    #shadow = this.attachShadow({ mode: "open" })
    #resolve?: () => void

    constructor(message: string, showOkButton = true) {
        super()
        this.#render(message, showOkButton)
    }

    /**
     * Update the dialog message and optionally show the OK button
     */
    updateMessage(message: string, showOkButton = true) {
        const messageEl = this.#shadow.querySelector(".message")
        const buttonsEl = this.#shadow.querySelector(".buttons")
        if (messageEl) {
            messageEl.textContent = message
        }
        if (buttonsEl) {
            buttonsEl.style.display = showOkButton ? "flex" : "none"
        }
    }

    /**
     * Update the dialog content with HTML (e.g. for tables)
     */
    updateContentHtml(html: string, showOkButton = true) {
        const messageEl = this.#shadow.querySelector(".message")
        const buttonsEl = this.#shadow.querySelector(".buttons")
        if (messageEl) {
            messageEl.innerHTML = html
        }
        if (buttonsEl) {
            buttonsEl.style.display = showOkButton ? "flex" : "none"
        }
    }

    #render(message: string, showOkButton = true) {
        this.#shadow.innerHTML = `
        <style>
            :host {
                display: block;
                position: fixed;
                inset: 0;
                z-index: 10000;
            }

            .overlay {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.5);
            }

            .dialog {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                padding: 1.5em;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 1em;
                z-index: 10001;
                min-width: 300px;
                max-width: 90vw;
                background: var(${__tone_2});
            }

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

            .buttons {
                display: flex;
                gap: 1em;
            }

            .buttons.hidden {
                display: none;
            }

            button {
                padding: 0.5em 1.5em;
                border: none;
                cursor: pointer;
                color: var(${__fg_color});
                background: var(${__tone_1});
                transition: background 0.2s ease;
            }

            button:hover {
                background: var(${__tone_3});
            }
        </style>

        <div class="overlay"></div>
        <div class="dialog">
            <div class="message">${this.#escapeHtml(message)}</div>
            <div class="buttons" ${showOkButton ? '' : 'style="display: none"'}>
                <button class="ok">OK</button>
            </div>
        </div>`
    }

    #escapeHtml(text: string): string {
        const div = document.createElement("div")
        div.textContent = text
        return div.innerHTML
    }

    connectedCallback() {
        this.#ac = new AbortController()
        const { signal } = this.#ac
        const okButton = this.#shadow.querySelector(".ok")
        if (okButton) {
            okButton.addEventListener("click", () => this.#close(), { signal })
        }
        this.#shadow.querySelector(".overlay")!.addEventListener("click", () => {
            // Only allow closing via overlay if OK button is visible
            const buttonsEl = this.#shadow.querySelector(".buttons")
            if (buttonsEl && buttonsEl.style.display !== "none") {
                this.#close()
            }
        }, { signal })
        window.addEventListener("keydown", this.#onKeyDown, { signal })
    }

    disconnectedCallback() {
        this.#ac.abort()
    }

    #onKeyDown = (e: KeyboardEvent) => {
        // Only allow closing via keyboard if OK button is visible
        const buttonsEl = this.#shadow.querySelector(".buttons")
        if (buttonsEl && buttonsEl.style.display !== "none") {
            if (e.key === "Escape" || e.key === "Enter") {
                e.preventDefault()
                this.#close()
            }
        }
    }

    #close() {
        this.remove()
        this.#resolve?.()
        this.#resolve = undefined
    }

    /**
     * Appends to DOM and returns a Promise that resolves when dismissed.
     */
    show(): Promise<void> {
        document.body.appendChild(this)
        return new Promise(resolve => {
            this.#resolve = resolve
        })
    }
}

customElements.define("status-dialog", StatusDialog)

declare global {
    interface HTMLElementTagNameMap {
        "status-dialog": StatusDialog
    }
}
