import { __fg_color, __tone_1, __tone_3, __tone_accent } from "../style/style.mjs"
import { isFileSystemAccessAvailable } from "../fs/file-picker.mjs"

declare const __SAMPLE_NAMES__: readonly string[]
const SAMPLE_NAMES = __SAMPLE_NAMES__

export interface WelcomeScreenCallbacks {
    onCreateNew: () => void
    onOpenModel: () => void | Promise<void>
    onOpenFolder: () => void | Promise<void>
    onSamplePick: (content: string, suggestedName: string) => void
    getThumbnail?: (src: string) => Promise<ImageData>
    getRecentDocuments?: () => Promise<string[]>
    getDocumentContent?: (name: string) => Promise<string | undefined>
    onOpenRecent?: (name: string) => void | Promise<void>
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
        void this.#initRecentDocuments()
    }

    async #initRecentDocuments(): Promise<void> {
        await this.#renderRecentDocuments()
        await this.#loadRecentThumbnails()
    }

    #getStyles(): string {
        return `
        <style>
            :host {
                display: block;
                position: fixed;
                inset: 0;
                z-index: 9000;
                background: linear-gradient(180deg, #141b26 0%, #0e1319 50%, #0a0e14 100%);
                overflow: hidden;
            }

            .bg-pattern {
                position: absolute;
                inset: 0;
                opacity: 0.35;
                background-image:
                    radial-gradient(1px 1px at 24px 48px, rgba(255,255,255,0.12), transparent),
                    radial-gradient(1px 1px at 72px 96px, rgba(255,255,255,0.08), transparent),
                    radial-gradient(1px 1px at 120px 24px, rgba(255,255,255,0.1), transparent),
                    radial-gradient(1px 1px at 168px 144px, rgba(255,255,255,0.06), transparent),
                    radial-gradient(1px 1px at 216px 72px, rgba(255,255,255,0.09), transparent);
                background-size: 240px 240px;
                animation: drift 80s linear infinite;
            }

            .bg-glow {
                position: absolute;
                top: -20%;
                left: 50%;
                transform: translateX(-50%);
                width: 100%;
                height: 50%;
                background: radial-gradient(ellipse 80% 60% at 50% 0%, rgba(0, 122, 204, 0.08) 0%, transparent 60%);
                pointer-events: none;
            }

            .bg-g {
                position: absolute;
                inset: 0;
                background: url('/assets/g.svg') center/60vmin no-repeat;
                opacity: 0.06;
                pointer-events: none;
            }

            @keyframes drift {
                from { transform: translate(0, 0); }
                to { transform: translate(-120px, -80px); }
            }

            .center {
                position: relative;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 0;
                min-height: 100%;
                max-height: 100%;
                overflow-y: auto;
                padding: 2.5em 2em;
                box-sizing: border-box;
            }

            .main-panel {
                margin-bottom: 2.5em;
            }

            .welcome-layout {
                display: flex;
                flex-direction: row;
                align-items: flex-start;
                gap: 0;
                width: 100%;
                max-width: 920px;
                padding: 0 1em;
            }

            .welcome-actions {
                position: relative;
                padding-right: 3em;
                padding-top: 2.05em;
            }

            .welcome-actions::after {
                content: "";
                position: absolute;
                top: 2.05em;
                right: 0;
                bottom: 0;
                width: 1px;
                background: color-mix(in srgb, var(${__fg_color}) 8%, transparent);
            }

            .samples-browser {
                padding-left: 3em;
            }

            @media (max-width: 720px) {
                .center {
                    padding: 1.5em 1.25em;
                }

                .main-panel {
                    margin-bottom: 2em;
                }

                .welcome-layout {
                    flex-direction: column;
                    align-items: center;
                    gap: 2.5em;
                }

                .welcome-actions {
                    padding-right: 0;
                    padding-top: 0;
                    width: 100%;
                    max-width: 320px;
                    min-width: unset;
                }

                .welcome-actions::after {
                    display: none;
                }

                .samples-browser {
                    padding-left: 0;
                    width: 100%;
                    max-width: 100%;
                }

                .brand {
                    margin-bottom: 0;
                }

                h1 {
                    font-size: 2.25rem;
                }

                .samples-scroll,
                .recent-scroll {
                    overflow: visible;
                }

                .samples-grid,
                .recent-grid {
                    grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
                    width: 100%;
                    max-width: 100%;
                }
            }

            @media (max-width: 400px) {
                .center {
                    padding: 1.25em 1em;
                }

                h1 {
                    font-size: 1.85rem;
                }

                .samples-grid,
                .recent-grid {
                    grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
                    gap: 0.5em;
                }

                .sample-thumb,
                .recent-thumb {
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
                gap: 0.75em;
                min-width: 280px;
            }

            .welcome-actions button {
                margin: 0;
            }

            .brand {
                text-align: center;
                margin-bottom: 0;
            }

            h1 {
                font-family: FiraCode, ui-monospace, monospace;
                font-size: 2.75rem;
                font-weight: 300;
                letter-spacing: 0.1em;
                color: var(${__fg_color});
                margin: 0 0 0.6em;
                text-shadow: 0 0 60px rgba(0, 122, 204, 0.15);
            }

            .tagline {
                font-size: 1rem;
                font-weight: 400;
                color: color-mix(in srgb, var(${__fg_color}) 65%, transparent);
                letter-spacing: 0.03em;
                line-height: 1.5;
                margin: 0 auto;
            }

            button {
                padding: 0.9em 1.4em;
                font-size: 0.95rem;
                border: 1px solid color-mix(in srgb, var(${__fg_color}) 12%, transparent);
                cursor: pointer;
                color: var(${__fg_color});
                background: color-mix(in srgb, var(${__tone_1}) 25%, transparent);
                transition: background 0.2s ease, border-color 0.2s ease, transform 0.12s ease, box-shadow 0.2s ease;
                text-align: left;
                border-radius: 10px;
                backdrop-filter: blur(10px);
            }

            button:hover {
                background: color-mix(in srgb, var(${__tone_3}) 50%, transparent);
                border-color: color-mix(in srgb, var(${__fg_color}) 22%, transparent);
                transform: translateX(2px);
            }

            button:focus-visible {
                outline: 2px solid var(${__tone_accent});
                outline-offset: 2px;
            }

            button.primary {
                background: var(${__tone_accent});
                color: #fff;
                border-color: color-mix(in srgb, var(${__tone_accent}) 85%, white);
                box-shadow: 0 2px 12px color-mix(in srgb, var(${__tone_accent}) 30%, transparent);
            }

            button.primary:hover {
                background: color-mix(in srgb, var(${__tone_accent}) 95%, white);
                border-color: var(${__tone_accent});
                box-shadow: 0 4px 20px color-mix(in srgb, var(${__tone_accent}) 40%, transparent);
            }

            button:disabled {
                opacity: 0.45;
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
                font-size: 0.82rem;
                font-weight: 500;
                color: color-mix(in srgb, var(${__fg_color}) 70%, transparent);
                margin: 0 0 0.85em;
                letter-spacing: 0.05em;
            }

            .samples-scroll {
                overflow: auto;
                padding: 0.25em 0 0.75em;
            }

            .samples-scroll::-webkit-scrollbar {
                height: 6px;
            }

            .samples-scroll::-webkit-scrollbar-track {
                background: color-mix(in srgb, var(${__fg_color}) 6%, transparent);
                border-radius: 3px;
            }

            .samples-scroll::-webkit-scrollbar-thumb {
                background: color-mix(in srgb, var(${__fg_color}) 20%, transparent);
                border-radius: 3px;
            }

            .samples-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
                grid-auto-rows: auto;
                gap: 0.85em;
                width: 100%;
            }

            .sample-item {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 0.4em;
                padding: 0.5em;
                font-size: 0.8rem;
                border: 1px solid color-mix(in srgb, var(${__fg_color}) 10%, transparent);
                cursor: pointer;
                color: var(${__fg_color});
                background: color-mix(in srgb, var(${__tone_1}) 20%, transparent);
                transition: background 0.2s ease, border-color 0.2s ease, transform 0.12s ease, box-shadow 0.2s ease;
                text-align: center;
                border-radius: 8px;
                backdrop-filter: blur(8px);
            }

            .sample-item:hover {
                background: color-mix(in srgb, var(${__tone_3}) 45%, transparent);
                border-color: color-mix(in srgb, var(${__fg_color}) 20%, transparent);
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            }

            .sample-item:focus-visible {
                outline: 2px solid var(${__tone_accent});
                outline-offset: 2px;
            }

            .sample-thumb {
                width: 68px;
                height: 68px;
                background: color-mix(in srgb, var(${__fg_color}) 8%, transparent);
                border-radius: 6px;
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
                font-size: 0.72rem;
                line-height: 1.25;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                max-width: 100%;
                color: color-mix(in srgb, var(${__fg_color}) 90%, transparent);
            }

            .recent-browser {
                margin-bottom: 1.5em;
            }

            .recent-browser:empty {
                display: none;
            }

            .recent-browser h3 {
                font-size: 0.82rem;
                font-weight: 500;
                color: color-mix(in srgb, var(${__fg_color}) 70%, transparent);
                margin: 0 0 0.85em;
                letter-spacing: 0.05em;
            }

            .recent-scroll {
                overflow: auto;
                padding: 0.25em 0 0.75em;
            }

            .recent-scroll::-webkit-scrollbar {
                height: 6px;
            }

            .recent-scroll::-webkit-scrollbar-track {
                background: color-mix(in srgb, var(${__fg_color}) 6%, transparent);
                border-radius: 3px;
            }

            .recent-scroll::-webkit-scrollbar-thumb {
                background: color-mix(in srgb, var(${__fg_color}) 20%, transparent);
                border-radius: 3px;
            }

            .recent-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
                grid-auto-rows: auto;
                gap: 0.85em;
                width: 100%;
            }

            .recent-item {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 0.4em;
                padding: 0.5em;
                font-size: 0.8rem;
                border: 1px solid color-mix(in srgb, var(${__fg_color}) 10%, transparent);
                cursor: pointer;
                color: var(${__fg_color});
                background: color-mix(in srgb, var(${__tone_1}) 20%, transparent);
                transition: background 0.2s ease, border-color 0.2s ease, transform 0.12s ease, box-shadow 0.2s ease;
                text-align: center;
                border-radius: 8px;
                backdrop-filter: blur(8px);
            }

            .recent-item:hover {
                background: color-mix(in srgb, var(${__tone_3}) 45%, transparent);
                border-color: color-mix(in srgb, var(${__fg_color}) 20%, transparent);
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            }

            .recent-item:focus-visible {
                outline: 2px solid var(${__tone_accent});
                outline-offset: 2px;
            }

            .recent-thumb {
                width: 68px;
                height: 68px;
                background: color-mix(in srgb, var(${__fg_color}) 8%, transparent);
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
                flex-shrink: 0;
            }

            .recent-thumb canvas {
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
            }

            .recent-name {
                font-size: 0.72rem;
                line-height: 1.25;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                max-width: 100%;
                color: color-mix(in srgb, var(${__fg_color}) 90%, transparent);
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
                    <div class="recent-browser"></div>
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

    async #renderRecentDocuments(): Promise<void> {
        const getRecent = this.#callbacks.getRecentDocuments
        const onOpen = this.#callbacks.onOpenRecent
        if (!getRecent || !onOpen) return

        const names = await getRecent()
        if (names.length === 0) return

        const browser = this.#samplesBrowser.querySelector(".recent-browser")!
        browser.innerHTML = ""
        const h3 = document.createElement("h3")
        h3.textContent = "Recent"
        browser.appendChild(h3)
        const scroll = document.createElement("div")
        scroll.className = "recent-scroll"
        const grid = document.createElement("div")
        grid.className = "recent-grid"
        scroll.appendChild(grid)
        browser.appendChild(scroll)

        for (const name of names) {
            const item = document.createElement("button")
            item.className = "recent-item"
            item.setAttribute("data-doc-name", name)
            item.onclick = () => void onOpen(name)
            const thumb = document.createElement("div")
            thumb.className = "recent-thumb"
            const nameEl = document.createElement("span")
            nameEl.className = "recent-name"
            nameEl.textContent = name.replace(/\.gcad$/i, "")
            item.appendChild(thumb)
            item.appendChild(nameEl)
            grid.appendChild(item)
        }
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
                .replace(/\.gcad$/i, "")
                .replace(/([a-z])([A-Z])/g, "$1 $2")
                .replace(/[-_]/g, " ")
                .replace(/\b\w/g, (c) => c.toUpperCase())
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

    async #loadRecentThumbnails(): Promise<void> {
        const getThumbnail = this.#callbacks.getThumbnail
        const getContent = this.#callbacks.getDocumentContent
        if (!getThumbnail || !getContent) return

        const items = this.#samplesBrowser.querySelectorAll(".recent-item")
        for (const item of items) {
            const name = item.getAttribute("data-doc-name")
            if (!name) continue
            const thumbDiv = item.querySelector(".recent-thumb")!
            try {
                const content = await getContent(name)
                if (!content) continue
                const imageData = await getThumbnail(content)
                const canvas = document.createElement("canvas")
                canvas.width = imageData.width
                canvas.height = imageData.height
                canvas.getContext("2d")!.putImageData(imageData, 0, 0)
                thumbDiv.innerHTML = ""
                thumbDiv.appendChild(canvas)
            } catch (e) {
                console.warn(`[WelcomeScreen] Failed to load thumbnail for recent ${name}:`, e)
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
