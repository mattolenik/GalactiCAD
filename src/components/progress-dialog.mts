import { __fg_color, __tone_1, __tone_2, __tone_3 } from "../style/style.mjs"
import { BaseDialog } from "./base-dialog.mjs"

export class CancelledError extends Error {
    constructor(message = "Operation was cancelled") {
        super(message)
        this.name = "CancelledError"
    }
}

export class ProgressDialog extends BaseDialog<boolean> {
    #phaseElement!: HTMLElement
    #progressBarElement!: HTMLElement
    #elapsedElement!: HTMLElement
    #startTime: number
    #cancelled = false

    constructor() {
        super()
        this.#startTime = performance.now()
        this.renderContent()
    }

    protected renderContent() {
        this.dialog.innerHTML = `
        <style>
            .dialog { min-width: 300px; }
            .phase {
                font-size: 1.1em;
                color: var(${__fg_color});
                text-align: center;
            }
            .progress-container {
                width: 100%;
                display: flex;
                flex-direction: column;
                gap: 0.5em;
            }
            .progress-bar {
                width: 100%;
                height: 24px;
                background: var(${__tone_1});
                border-radius: 4px;
                overflow: hidden;
                position: relative;
            }
            .progress-fill {
                height: 100%;
                background: var(${__tone_3});
                transition: width 0.2s ease;
                width: 0%;
            }
            .elapsed {
                font-size: 0.9em;
                color: var(${__fg_color});
                opacity: 0.7;
                text-align: center;
            }
            .buttons { display: flex; gap: 1em; margin-top: 0.5em; }
            button:disabled { opacity: 0.5; cursor: not-allowed; }
        </style>
        <div class="phase"></div>
        <div class="progress-container">
            <div class="progress-bar">
                <div class="progress-fill"></div>
            </div>
            <div class="elapsed"></div>
        </div>
        <div class="buttons">
            <button class="cancel">Cancel</button>
        </div>`
        this.#phaseElement = this.shadow.querySelector(".phase")!
        this.#progressBarElement = this.shadow.querySelector(".progress-fill")!
        this.#elapsedElement = this.shadow.querySelector(".elapsed")!
    }

    protected setupEventListeners(signal: AbortSignal) {
        this.shadow.querySelector(".cancel")!.addEventListener("click", () => this.#cancel(), { signal })
        window.addEventListener("keydown", this.#onKeyDown, { signal })
        this.#updateElapsed()
    }

    #onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && !this.#cancelled) {
            e.preventDefault()
            this.#cancel()
        }
    }

    #cancel() {
        if (this.#cancelled) return
        this.#cancelled = true
        this.close(false)
    }

    #updateElapsed() {
        if (this.#cancelled) return
        const elapsed = (performance.now() - this.#startTime) / 1000
        const seconds = Math.floor(elapsed % 60)
        const minutes = Math.floor(elapsed / 60)
        if (minutes > 0) {
            this.#elapsedElement.textContent = `Elapsed: ${minutes}m ${seconds}s`
        } else {
            this.#elapsedElement.textContent = `Elapsed: ${seconds}s`
        }
        requestAnimationFrame(() => this.#updateElapsed())
    }

    /**
     * Update the progress display
     */
    updateProgress(phase: string, percentage: number) {
        if (this.#cancelled) return
        this.#phaseElement.textContent = phase
        this.#progressBarElement.style.width = `${Math.max(0, Math.min(100, percentage))}%`
    }

    get cancelled(): boolean {
        return this.#cancelled
    }

    /**
     * Mark as complete and close the dialog
     */
    complete() {
        if (this.#cancelled) return
        this.close(true)
    }
}

customElements.define("progress-dialog", ProgressDialog)

declare global {
    interface HTMLElementTagNameMap {
        "progress-dialog": ProgressDialog
    }
}
