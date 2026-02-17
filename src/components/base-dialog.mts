import { __fg_color, __tone_1, __tone_2, __tone_3 } from "../style/style.mjs"

/**
 * Base class for modal dialogs. Provides shared overlay/dialog structure,
 * AbortController lifecycle, show()/close() pattern, and Escape key handling.
 */
export abstract class BaseDialog<T> extends HTMLElement {
    #ac = new AbortController()
    #shadow = this.attachShadow({ mode: "open" })
    #resolve?: (value: T) => void

    /** Access shadow root for subclasses to query elements and attach listeners */
    protected get shadow(): ShadowRoot {
        return this.#shadow
    }

    constructor() {
        super()
        this.#shadow.innerHTML = this.#getBaseStyles() + this.#getBaseMarkup()
    }

    /** Subclasses override to render their dialog content into the dialog container.
     *  Must be called by the subclass constructor after super(). */
    protected abstract renderContent(...args: unknown[]): void

    #getBaseStyles(): string {
        return `
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

            button {
                padding: 0.5em 1em;
                border: none;
                cursor: pointer;
                color: var(${__fg_color});
                background: var(${__tone_1});
                transition: background 0.2s ease;
            }

            button:hover {
                background: var(${__tone_3});
            }
        </style>`
    }

    #getBaseMarkup(): string {
        return `
        <div class="overlay"></div>
        <div class="dialog"></div>`
    }

    /** Get the overlay element for attaching click listeners */
    protected get overlay(): HTMLElement {
        return this.#shadow.querySelector(".overlay")!
    }

    /** Get the dialog container element for appending content */
    protected get dialog(): HTMLElement {
        return this.#shadow.querySelector(".dialog")!
    }

    connectedCallback() {
        this.#ac = new AbortController()
        this.setupEventListeners(this.#ac.signal)
    }

    disconnectedCallback() {
        this.#ac.abort()
    }

    /** Subclasses override to attach their event listeners with { signal } */
    protected abstract setupEventListeners(signal: AbortSignal): void

    /** Close the dialog and resolve the promise. Subclasses call this. */
    protected close(value?: T) {
        this.remove()
        this.#resolve?.(value as T)
        this.#resolve = undefined
    }

    /**
     * Appends to DOM and returns a Promise that resolves when the dialog is closed.
     */
    show(): Promise<T> {
        document.body.appendChild(this)
        return new Promise(resolve => {
            this.#resolve = resolve
        })
    }
}
