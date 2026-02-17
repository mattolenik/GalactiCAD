import { __fg_color, __tone_1, __tone_2, __tone_3 } from "../style/style.mjs"
import { BaseDialog } from "./base-dialog.mjs"

export class YesNoDialog extends BaseDialog<boolean> {
    #content!: HTMLElement

    constructor(messageOrElement: string | HTMLElement) {
        super(messageOrElement)
    }

    protected renderContent(messageOrElement: string | HTMLElement) {
        this.#content =
            typeof messageOrElement === "string"
                ? Object.assign(document.createElement("span"), { textContent: messageOrElement })
                : messageOrElement
        this.dialog.innerHTML = `
        <style>
            .buttons { display: flex; gap: 2em; }
            button.yes { background: var(${__tone_3}); }
            button.no { background: var(${__tone_1}); }
            button.no.flash { background: var(${__tone_3}) !important; }
        </style>
        <div class="message"></div>
        <div class="buttons">
            <button class="yes">Yes</button>
            <button class="no">No</button>
        </div>`
        this.dialog.querySelector(".message")!.appendChild(this.#content)
    }

    protected setupEventListeners(signal: AbortSignal) {
        this.overlay.addEventListener("click", () => this.#rejectWithFlash(), { signal })
        this.shadow.querySelector(".no")!.addEventListener("click", () => this.close(false), { signal })
        this.shadow.querySelector(".yes")!.addEventListener("click", () => this.close(true), { signal })
        window.addEventListener("keydown", this.#onKeyDown, { signal })
    }

    #onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault()
            this.#rejectWithFlash()
        }
    }

    #rejectWithFlash() {
        const noBtn = this.shadow.querySelector(".no") as HTMLButtonElement
        noBtn.classList.add("flash")
        setTimeout(() => {
            noBtn.classList.remove("flash")
            this.close(false)
        }, 200)
    }
}

customElements.define("yes-no-dialog", YesNoDialog)

declare global {
    interface HTMLElementTagNameMap {
        "yes-no-dialog": YesNoDialog
    }
}
