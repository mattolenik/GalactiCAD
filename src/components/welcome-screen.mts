import { __fg_color, __tone_1, __tone_2, __tone_3, __tone_accent } from "../style/style.mjs"
import { isFileSystemAccessAvailable } from "../fs/file-picker.mjs"

declare const __SAMPLE_NAMES__: readonly string[]
const SAMPLE_NAMES = __SAMPLE_NAMES__

export interface WelcomeScreenCallbacks {
    onCreateNew: () => void
    onOpenModel: () => void | Promise<void>
    onOpenFolder: () => void | Promise<void>
    onSamplePick: (content: string, suggestedName: string) => void
    getThumbnail?: (src: string) => Promise<ImageData>
}

export class WelcomeScreen extends HTMLElement {
    #callbacks: WelcomeScreenCallbacks
    #mainPanel: HTMLElement
    #samplesBrowser: HTMLElement
    #shadow: ShadowRoot

    constructor(callbacks: WelcomeScreenCallbacks) {
        super()
        this.#callbacks = callbacks
        this.#shadow = this.attachShadow({ mode: "open" })
        this.#shadow.innerHTML = this.#getStyles() + this.#getMarkup()
        this.#mainPanel = this.#shadow.querySelector(".main-panel")!
        this.#samplesBrowser = this.#shadow.querySelector(".samples-browser")!
        this.#renderMainPanel()
        this.#renderSamplesGrid()
        this.#loadThumbnails()
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
                gap: 0.5em;
                min-height: 100%;
                max-height: 100%;
                overflow-y: auto;
                padding: 2em;
                box-sizing: border-box;
            }

            .welcome-layout {
                display: flex;
                flex-direction: row;
                align-items: stretch;
                gap: 3em;
                width: 100%;
                max-width: 760px;
            }

            @media (max-width: 640px) {
                .center {
                    padding: 1.25em;
                }

                .welcome-layout {
                    flex-direction: column;
                    align-items: center;
                    gap: 2em;
                }

                .brand {
                    margin-bottom: 1.5em;
                }

                h1 {
                    font-size: 2rem;
                }

                .welcome-actions {
                    width: 100%;
                    max-width: 280px;
                }

                .actions {
                    min-width: unset;
                }

                .samples-browser {
                    width: 100%;
                    max-width: 100%;
                }

                .samples-scroll {
                    overflow-x: visible;
                    overflow-y: visible;
                }

                .samples-grid {
                    grid-template-rows: unset;
                    grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
                    grid-auto-flow: row;
                    width: 100%;
                    max-width: 100%;
                }
            }

            @media (max-width: 380px) {
                .center {
                    padding: 1em;
                }

                h1 {
                    font-size: 1.65rem;
                }

                .samples-grid {
                    grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));
                    gap: 0.4em;
                }

                .sample-thumb {
                    width: 56px;
                    height: 56px;
                }

                .sample-name {
                    font-size: 0.7rem;
                }
            }

            .welcome-actions {
                display: flex;
                flex-direction: column;
                flex-shrink: 0;
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
                gap: 1em;
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
                transform: translateX(3px);
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

            .samples-browser {
                flex: 1;
                min-width: 0;
                display: flex;
                flex-direction: column;
            }

            .samples-browser h3 {
                font-size: 0.95rem;
                font-weight: 400;
                color: var(${__fg_color});
                margin: 0 0 0.5em;
            }

            .samples-scroll {
                overflow-x: auto;
                overflow-y: hidden;
                padding-bottom: 0.5em;
            }

            .samples-scroll::-webkit-scrollbar {
                height: 6px;
            }

            .samples-scroll::-webkit-scrollbar-track {
                background: color-mix(in srgb, var(${__fg_color}) 8%, transparent);
                border-radius: 3px;
            }

            .samples-scroll::-webkit-scrollbar-thumb {
                background: color-mix(in srgb, var(${__fg_color}) 25%, transparent);
                border-radius: 3px;
            }

            .samples-grid {
                display: grid;
                grid-template-rows: 1fr 1fr;
                grid-auto-columns: 90px;
                grid-auto-flow: column;
                gap: 0.65em;
                width: max-content;
            }

            .sample-item {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 0.25em;
                padding: 0.4em;
                font-size: 0.8rem;
                border: 1px solid color-mix(in srgb, var(${__fg_color}) 15%, transparent);
                cursor: pointer;
                color: var(${__fg_color});
                background: color-mix(in srgb, var(${__tone_1}) 40%, transparent);
                transition: background 0.2s ease, border-color 0.2s ease, transform 0.1s ease;
                text-align: center;
                border-radius: 6px;
                backdrop-filter: blur(8px);
            }

            .sample-item:hover {
                background: color-mix(in srgb, var(${__tone_3}) 60%, transparent);
                border-color: color-mix(in srgb, var(${__fg_color}) 25%, transparent);
                transform: scale(1.02);
            }

            .sample-thumb {
                width: 64px;
                height: 64px;
                background: color-mix(in srgb, var(${__fg_color}) 10%, transparent);
                border-radius: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
                flex-shrink: 0;
            }

            .sample-thumb canvas {
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
            }

            .sample-name {
                font-size: 0.75rem;
                line-height: 1.2;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                max-width: 100%;
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
            <div class="welcome-layout">
                <div class="welcome-actions"></div>
                <div class="samples-browser">
                    <h3>Samples</h3>
                    <div class="samples-scroll">
                        <div class="samples-grid"></div>
                    </div>
                </div>
            </div>
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

        const actions = this.#shadow.querySelector(".welcome-actions")!

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
    }

    #renderSamplesGrid(): void {
        const grid = this.#samplesBrowser.querySelector(".samples-grid")!
        grid.innerHTML = ""
        for (const name of SAMPLE_NAMES) {
            const item = document.createElement("button")
            item.className = "sample-item"
            item.onclick = () => this.#loadSample(name)
            const thumb = document.createElement("div")
            thumb.className = "sample-thumb"
            const nameEl = document.createElement("span")
            nameEl.className = "sample-name"
            nameEl.textContent = name
            item.appendChild(thumb)
            item.appendChild(nameEl)
            grid.appendChild(item)
        }
    }

    async #loadThumbnails(): Promise<void> {
        const getThumbnail = this.#callbacks.getThumbnail
        if (!getThumbnail) return
        const grid = this.#samplesBrowser.querySelector(".samples-grid")!
        const items = grid.querySelectorAll(".sample-item")
        for (let i = 0; i < SAMPLE_NAMES.length && i < items.length; i++) {
            const name = SAMPLE_NAMES[i]
            const item = items[i]
            const thumbDiv = item.querySelector(".sample-thumb")!
            try {
                const res = await fetch(`/assets/samples/${name}`)
                if (!res.ok) continue
                const content = await res.text()
                const imageData = await getThumbnail(content)
                const canvas = document.createElement("canvas")
                canvas.width = imageData.width
                canvas.height = imageData.height
                canvas.getContext("2d")!.putImageData(imageData, 0, 0)
                thumbDiv.innerHTML = ""
                thumbDiv.appendChild(canvas)
            } catch (e) {
                console.warn(`[WelcomeScreen] Failed to load thumbnail for ${name}:`, e)
            }
        }
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
