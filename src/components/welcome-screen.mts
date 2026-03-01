import { __fg_color, __tone_1, __tone_2, __tone_3, __tone_accent } from "../style/style.mjs"
import { isFileSystemAccessAvailable } from "../fs/file-picker.mjs"

declare const __SAMPLE_NAMES__: readonly string[]
const SAMPLE_NAMES = __SAMPLE_NAMES__

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
                background: linear-gradient(165deg, #1a2332 0%, #0d1520 40%, #0a0f18 100%);
                overflow: hidden;
            }

            .bg-pattern {
                position: absolute;
                inset: 0;
                opacity: 0.4;
                background-image:
                    radial-gradient(1.5px 1.5px at 20px 30px, rgba(255,255,255,0.15), transparent),
                    radial-gradient(1.5px 1.5px at 40px 70px, rgba(255,255,255,0.1), transparent),
                    radial-gradient(1.5px 1.5px at 50px 160px, rgba(255,255,255,0.12), transparent),
                    radial-gradient(1.5px 1.5px at 90px 40px, rgba(255,255,255,0.08), transparent),
                    radial-gradient(1.5px 1.5px at 130px 80px, rgba(255,255,255,0.1), transparent);
                background-size: 200px 200px;
                animation: drift 60s linear infinite;
            }

            .bg-glow {
                position: absolute;
                top: -30%;
                left: 50%;
                transform: translateX(-50%);
                width: 80%;
                height: 60%;
                background: radial-gradient(ellipse, rgba(0, 122, 204, 0.12) 0%, transparent 70%);
                pointer-events: none;
            }

            .bg-g {
                position: absolute;
                inset: 0;
                background: url('/assets/g.svg') center/75vmin no-repeat;
                opacity: 0.1;
                pointer-events: none;
            }

            @keyframes drift {
                from { transform: translate(0, 0); }
                to { transform: translate(-100px, -100px); }
            }

            .center {
                position: relative;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 100%;
                padding: 2em;
            }

            .brand {
                text-align: center;
                margin-bottom: 2.5em;
            }

            h1 {
                font-family: FiraCode, ui-monospace, monospace;
                font-size: 2.5rem;
                font-weight: 300;
                letter-spacing: 0.08em;
                color: var(${__fg_color});
                margin: 0 0 0.35em;
                text-shadow: 0 0 40px rgba(0, 122, 204, 0.2);
            }

            .tagline {
                font-size: 0.95rem;
                font-weight: 400;
                color: color-mix(in srgb, var(${__fg_color}) 70%, transparent);
                letter-spacing: 0.04em;
                max-width: 300px;
            }

            .actions {
                display: flex;
                flex-direction: column;
                gap: 0.65em;
                min-width: 260px;
            }

            button {
                padding: 0.85em 1.5em;
                font-size: 1rem;
                border: 1px solid color-mix(in srgb, var(${__fg_color}) 15%, transparent);
                cursor: pointer;
                color: var(${__fg_color});
                background: color-mix(in srgb, var(${__tone_1}) 40%, transparent);
                transition: background 0.2s ease, border-color 0.2s ease, transform 0.15s ease;
                text-align: left;
                border-radius: 8px;
                backdrop-filter: blur(8px);
            }

            button:hover {
                background: color-mix(in srgb, var(${__tone_3}) 60%, transparent);
                border-color: color-mix(in srgb, var(${__fg_color}) 25%, transparent);
                transform: translateX(4px);
            }

            button.primary {
                background: var(${__tone_accent});
                border-color: color-mix(in srgb, var(${__tone_accent}) 80%, white);
                box-shadow: 0 4px 20px color-mix(in srgb, var(${__tone_accent}) 35%, transparent);
            }

            button.primary:hover {
                background: color-mix(in srgb, var(${__tone_accent}) 90%, white);
                border-color: var(${__tone_accent});
                box-shadow: 0 6px 28px color-mix(in srgb, var(${__tone_accent}) 45%, transparent);
            }

            button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
                transform: none;
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
        <div class="bg-pattern" aria-hidden="true"></div>
        <div class="bg-g" aria-hidden="true"></div>
        <div class="bg-glow" aria-hidden="true"></div>
        <div class="center">
            <div class="main-panel"></div>
            <div class="samples-panel"></div>
        </div>`
    }

    #renderMainPanel(): void {
        this.#mainPanel.innerHTML = ""
        const brand = document.createElement("div")
        brand.className = "brand"
        const h1 = document.createElement("h1")
        h1.textContent = "GalactiCAD"
        brand.appendChild(h1)
        const tagline = document.createElement("p")
        tagline.className = "tagline"
        tagline.textContent = "True hybrid code-as-CAD, powered by SDFs and built for FDM 3D printing"
        brand.appendChild(tagline)
        this.#mainPanel.appendChild(brand)

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
