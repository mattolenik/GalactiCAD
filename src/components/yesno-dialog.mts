import { __fg_color, __tone_1, __tone_2, __tone_3, __tone_accent } from "../style/style.mjs"

export class YesNoDialog extends HTMLElement {
    #shadow = this.attachShadow({ mode: "open" })
    #resolve?: (value: boolean) => void
    #content: HTMLElement

    constructor(messageOrElement: string | HTMLElement) {
        super()

        // Accept string or HTMLElement
        this.#content =
            typeof messageOrElement === "string"
                ? Object.assign(document.createElement("span"), { textContent: messageOrElement })
                : messageOrElement

        this.#render()
    }

    #render() {
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
                max-width: 90vw;
                max-height: 90vh;
                overflow: auto;
                background: var(${__tone_2});
            }

            .buttons {
                display: flex;
                gap: 2em;
            }

            button {
                padding: 0.5em 1em;
                border: none;
                cursor: pointer;
                color: var(${__fg_color});
            }

            button.yes {
                background: var(${__tone_3});
            }

            button.no {
                background: var(${__tone_1});
                transition: background 0.2s ease;
            }

            button.no.flash {
                background: var(${__tone_3}) !important;
            }
        </style>

        <div class="overlay"></div>
        <div class="dialog">
            <div class="message"></div>
            <div class="buttons">
                <button class="yes">Yes</button>
                <button class="no">No</button>
            </div>
        </div>`
        const messageContainer = this.#shadow.querySelector(".message")!
        messageContainer.appendChild(this.#content)
    }

    connectedCallback() {
        this.#shadow.querySelector(".overlay")!.addEventListener("click", () => this.#rejectWithFlash())
        this.#shadow.querySelector(".no")!.addEventListener("click", () => this.#close(false))
        this.#shadow.querySelector(".yes")!.addEventListener("click", () => this.#close(true))
        window.addEventListener("keydown", this.#onKeyDown)
    }

    disconnectedCallback() {
        window.removeEventListener("keydown", this.#onKeyDown)
    }

    #onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault()
            this.#rejectWithFlash()
        }
    }

    #close(value: boolean) {
        this.remove()
        this.#resolve?.(value)
        this.#resolve = undefined
    }

    #rejectWithFlash() {
        const noBtn = this.#shadow.querySelector(".no") as HTMLButtonElement
        noBtn.classList.add("flash")
        setTimeout(() => {
            noBtn.classList.remove("flash")
            this.#close(false)
        }, 200)
    }

    /**
     * Appends to DOM and returns a Promise that resolves to true (yes) or false (no).
     */
    show(): Promise<boolean> {
        document.body.appendChild(this)
        return new Promise(resolve => {
            this.#resolve = resolve
        })
    }
}

customElements.define("yes-no-dialog", YesNoDialog)
