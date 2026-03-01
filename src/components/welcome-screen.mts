import { __fg_color, __tone_1, __tone_2, __tone_3, __tone_accent } from "../style/style.mjs"
import { isFileSystemAccessAvailable } from "../fs/file-picker.mjs"

const SAMPLE_NAMES = [
    "arcane.gcad",
    "car.gcad",
    "extrude_loft.gcad",
    "mechwarrior.gcad",
    "mechwarrior2.gcad",
    "newops.gcad",
    "newops2.gcad",
    "rocket.gcad",
    "shuttle.gcad",
    "submersible.gcad",
    "submersible2.gcad",
    "submersible3.gcad",
    "thehomer.gcad",
]

export interface WelcomeScreenCallbacks {
    onCreateNew: () => void
    onOpenModel: () => void | Promise<void>
    onOpenFolder: () => void | Promise<void>
    onSamplePick: (content: string, suggestedName: string) => void
}

export class WelcomeScreen extends HTMLElement {
    #callbacks: WelcomeScreenCallbacks
    #mainPanel: HTMLElement
    #samplesPanel: HTMLElement
    #shadow: ShadowRoot

    constructor(callbacks: WelcomeScreenCallbacks) {
        super()
        this.#callbacks = callbacks
        this.#shadow = this.attachShadow({ mode: "open" })
        this.#shadow.innerHTML = this.#getStyles() + this.#getMarkup()
        this.#mainPanel = this.#shadow.querySelector(".main-panel")!
        this.#samplesPanel = this.#shadow.querySelector(".samples-panel")!
        this.#samplesPanel.hidden = true
        this.#renderMainPanel()
        this.#renderSamplesList()
    }

    #getStyles(): string {
        return `
        <style>
            :host {
                display: block;
                position: fixed;
                inset: 0;
                z-index: 9000;
                background: var(${__tone_2});
            }

            .center {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 100%;
                padding: 2em;
            }

            h1 {
                font-size: 2rem;
                font-weight: 300;
                color: var(${__fg_color});
                margin-bottom: 2em;
            }

            .actions {
                display: flex;
                flex-direction: column;
                gap: 0.75em;
                min-width: 220px;
            }

            button {
                padding: 0.75em 1.5em;
                font-size: 1rem;
                border: none;
                cursor: pointer;
                color: var(${__fg_color});
                background: var(${__tone_1});
                transition: background 0.2s ease;
                text-align: left;
                border-radius: 4px;
            }

            button:hover {
                background: var(${__tone_3});
            }

            button.primary {
                background: var(${__tone_accent});
            }

            button.primary:hover {
                background: color-mix(in srgb, var(${__tone_accent}) 85%, white);
            }

            button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            .samples-panel {
                width: 100%;
                max-width: 400px;
            }

            .samples-panel h2 {
                font-size: 1.25rem;
                font-weight: 400;
                color: var(${__fg_color});
                margin-bottom: 1em;
            }

            .samples-list {
                display: flex;
                flex-direction: column;
                gap: 0.5em;
                max-height: 60vh;
                overflow-y: auto;
            }

            .samples-list button {
                padding: 0.5em 1em;
                font-size: 0.95rem;
            }

            .back {
                margin-bottom: 1em;
                padding: 0.5em 1em;
                font-size: 0.9rem;
            }
        </style>`
    }

    #getMarkup(): string {
        return `
        <div class="center">
            <div class="main-panel"></div>
            <div class="samples-panel"></div>
        </div>`
    }

    #renderMainPanel(): void {
        this.#mainPanel.innerHTML = ""
        const h1 = document.createElement("h1")
        h1.textContent = "GalactiCAD"
        this.#mainPanel.appendChild(h1)

        const actions = document.createElement("div")
        actions.className = "actions"

        const createNew = document.createElement("button")
        createNew.className = "primary"
        createNew.textContent = "Create New Model"
        createNew.onclick = () => this.#callbacks.onCreateNew()
        actions.appendChild(createNew)

        const openModel = document.createElement("button")
        openModel.textContent = "Open Model"
        openModel.disabled = !isFileSystemAccessAvailable()
        openModel.onclick = () => void this.#callbacks.onOpenModel()
        actions.appendChild(openModel)

        const openFolder = document.createElement("button")
        openFolder.textContent = "Open Folder"
        openFolder.disabled = !isFileSystemAccessAvailable()
        openFolder.onclick = () => void this.#callbacks.onOpenFolder()
        actions.appendChild(openFolder)

        const browseSamples = document.createElement("button")
        browseSamples.textContent = "Browse Samples"
        browseSamples.onclick = () => this.#showSamples()
        actions.appendChild(browseSamples)

        this.#mainPanel.appendChild(actions)
    }

    #renderSamplesList(): void {
        this.#samplesPanel.innerHTML = ""
        const back = document.createElement("button")
        back.className = "back"
        back.textContent = "← Back"
        back.onclick = () => this.#hideSamples()
        this.#samplesPanel.appendChild(back)

        const h2 = document.createElement("h2")
        h2.textContent = "Samples"
        this.#samplesPanel.appendChild(h2)

        const list = document.createElement("div")
        list.className = "samples-list"
        for (const name of SAMPLE_NAMES) {
            const btn = document.createElement("button")
            btn.textContent = name
            btn.onclick = () => this.#loadSample(name)
            list.appendChild(btn)
        }
        this.#samplesPanel.appendChild(list)
    }

    #showSamples(): void {
        this.#mainPanel.hidden = true
        this.#samplesPanel.hidden = false
    }

    #hideSamples(): void {
        this.#mainPanel.hidden = false
        this.#samplesPanel.hidden = true
    }

    async #loadSample(name: string): Promise<void> {
        try {
            const res = await fetch(`/assets/samples/${name}`)
            if (!res.ok) throw new Error(`Failed to load ${name}`)
            const content = await res.text()
            const suggestedName = name.replace(/\.gcad$/, "")
            this.#callbacks.onSamplePick(content, suggestedName)
        } catch (err) {
            console.error(`[WelcomeScreen] Failed to load sample ${name}:`, err)
            alert(`Could not load sample: ${name}`)
        }
    }
}

customElements.define("welcome-screen", WelcomeScreen)

declare global {
    interface HTMLElementTagNameMap {
        "welcome-screen": WelcomeScreen
    }
}
