import { __fg_color, __tone_1, __tone_2, __tone_3 } from "../style/style.mjs"

export class CancelledError extends Error {
    constructor(message = "Operation was cancelled") {
        super(message)
        this.name = "CancelledError"
    }
}

export class ProgressDialog extends HTMLElement {
    #ac = new AbortController()
    #shadow = this.attachShadow({ mode: "open" })
    #resolve?: (value: boolean) => void
    #startTime: number
    #phaseElement: HTMLElement
    #progressBarElement: HTMLElement
    #elapsedElement: HTMLElement
    #cancelled = false

    constructor() {
        super()
        this.#startTime = performance.now()
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
                min-width: 300px;
                max-width: 90vw;
                background: var(${__tone_2});
            }

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

            .buttons {
                display: flex;
                gap: 1em;
                margin-top: 0.5em;
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

            button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
        </style>

        <div class="overlay"></div>
        <div class="dialog">
            <div class="phase"></div>
            <div class="progress-container">
                <div class="progress-bar">
                    <div class="progress-fill"></div>
                </div>
                <div class="elapsed"></div>
            </div>
            <div class="buttons">
                <button class="cancel">Cancel</button>
            </div>
        </div>`

        this.#phaseElement = this.#shadow.querySelector(".phase")!
        this.#progressBarElement = this.#shadow.querySelector(".progress-fill")!
        this.#elapsedElement = this.#shadow.querySelector(".elapsed")!
    }

    connectedCallback() {
        this.#ac = new AbortController()
        const { signal } = this.#ac
        this.#shadow.querySelector(".cancel")!.addEventListener("click", () => this.#cancel(), { signal })
        window.addEventListener("keydown", this.#onKeyDown, { signal })
        this.#updateElapsed()
    }

    disconnectedCallback() {
        this.#ac.abort()
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
        this.remove()
        this.#resolve?.(false)
        this.#resolve = undefined
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
     * @param phase - Current phase name (e.g., "Pass 1: Cell Classification")
     * @param percentage - Progress percentage (0-100)
     */
    updateProgress(phase: string, percentage: number) {
        if (this.#cancelled) return
        this.#phaseElement.textContent = phase
        this.#progressBarElement.style.width = `${Math.max(0, Math.min(100, percentage))}%`
    }

    /**
     * Check if the dialog has been cancelled
     */
    get cancelled(): boolean {
        return this.#cancelled
    }

    /**
     * Appends to DOM and returns a Promise that resolves to true (completed) or false (cancelled).
     */
    show(): Promise<boolean> {
        document.body.appendChild(this)
        return new Promise(resolve => {
            this.#resolve = resolve
        })
    }

    /**
     * Mark as complete and close the dialog
     */
    complete() {
        if (this.#cancelled) return
        this.remove()
        this.#resolve?.(true)
        this.#resolve = undefined
    }
}

customElements.define("progress-dialog", ProgressDialog)

declare global {
    interface HTMLElementTagNameMap {
        "progress-dialog": ProgressDialog
    }
}
