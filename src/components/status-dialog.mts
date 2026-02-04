import { __fg_color, __tone_1, __tone_2, __tone_3 } from "../style/style.mjs"

export class StatusDialog extends HTMLElement {
    #shadow = this.attachShadow({ mode: "open" })
    #resolve?: () => void

    constructor(message: string) {
        super()
        this.#render(message)
    }

    #render(message: string) {
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

            .buttons {
                display: flex;
                gap: 1em;
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
            <div class="buttons">
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
        this.#shadow.querySelector(".ok")!.addEventListener("click", () => this.#close())
        this.#shadow.querySelector(".overlay")!.addEventListener("click", () => this.#close())
        window.addEventListener("keydown", this.#onKeyDown)
    }

    disconnectedCallback() {
        window.removeEventListener("keydown", this.#onKeyDown)
    }

    #onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" || e.key === "Enter") {
            e.preventDefault()
            this.#close()
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
