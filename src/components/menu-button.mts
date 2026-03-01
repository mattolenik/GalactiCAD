import { __fg_color, __tone_2, __tone_3, __tone_accent, __toolbar_height } from "../style/style.mjs"

export interface DocumentExplorerConfig {
    getClosedDocuments: () => string[]
    onOpen: (name: string) => void
    /** Unopened .gcad files in the current folder. null = no folder tracked. */
    getUnopenedFolderFiles?: () => Promise<string[] | null>
    onOpenFolderFile?: (name: string) => void | Promise<void>
    /** Called when user chooses to open a folder (e.g. when no folder is tracked). */
    onOpenFolder?: () => void | Promise<void>
}

export class MenuButton extends HTMLElement {
    #ac = new AbortController()
    #button: HTMLButtonElement
    #menuContainer: HTMLElement
    #items: Array<{ element: HTMLElement; action: () => void }>
    #documentExplorer?: DocumentExplorerConfig

    constructor(items: Array<{ element: HTMLElement; action: () => void }>, documentExplorer?: DocumentExplorerConfig) {
        super()
        this.#items = items
        this.#documentExplorer = documentExplorer

        const shadow = this.attachShadow({ mode: "open" })

        shadow.innerHTML = `
        <style>
            :host {
                position: relative;
                display: inline-block;
                user-select: none;
            }

            button {
                display: inline-block;
                cursor: pointer;
                background: none;
                background: var(${__tone_accent});
                line-height: 0;
                padding: 2px 0 calc(var(${__toolbar_height}) / 2 - 6px) 0;
                height: calc(var(${__toolbar_height}) + 4px);
                width: calc(var(${__toolbar_height}) + 10px);
                border: none;
                color: var(${__fg_color});
                font-size: large;
                transition: background-color 0.2s, color 0.2s;
            }

            button:hover {
                background: color-mix(in srgb, var(${__tone_accent}) 85%, white);
                color: var(${__fg_color});
            }

            .menu {
                position: absolute;
                top: 100%;
                background: var(${__tone_2});
                margin: 0;
                padding: 0;
                list-style: none;
                width: max-content;
                min-width: 180px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                z-index: 100;
                visibility: hidden;
                opacity: 0;
                transition: visibility 0s, opacity 0.2s;
            }

            .menu.visible {
                visibility: visible;
                opacity: 1;
            }

            .menu li {
                padding: 8px 12px;
                cursor: pointer;
                color: rgb(from var(${__fg_color}) r g b / 0.6);
                transition: background-color 0.2s, color 0.2s;
            }

            .menu li:hover {
                color: var(${__fg_color});
                background: var(${__tone_3})
            }

            .menu li.section-header {
                cursor: default;
                font-size: 13px;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                color: rgb(from var(${__fg_color}) r g b / 0.35);
                padding: 6px 12px 4px;
            }

            .menu li.section-header:hover {
                background: none;
                color: rgb(from var(${__fg_color}) r g b / 0.35);
            }

            .menu li.doc-item {
                padding: 6px 12px 6px 20px;
                font-size: 17px;
            }

            .menu li.separator {
                cursor: default;
                height: 1px;
                padding: 0;
                margin: 4px 0;
                background: rgb(from var(${__fg_color}) r g b / 0.12);
            }

            .menu li.separator:hover {
                background: rgb(from var(${__fg_color}) r g b / 0.12);
            }

            .menu li.empty-docs {
                cursor: default;
                padding: 6px 12px 6px 20px;
                font-size: 14px;
                font-style: italic;
                color: rgb(from var(${__fg_color}) r g b / 0.3);
            }

            .menu li.empty-docs:hover {
                background: none;
                color: rgb(from var(${__fg_color}) r g b / 0.3);
            }
        </style>

        <button>⌄</button>
        <ul class="menu"></ul>
        `

        this.#button = shadow.querySelector("button")!
        this.#menuContainer = shadow.querySelector(".menu")!

        this.#button.addEventListener("click", e => this.toggleMenu(e))

        this.renderMenu()
    }

    connectedCallback() {
        this.#ac = new AbortController()
        const { signal } = this.#ac
        document.addEventListener("click", this.#onDocumentClick, { signal })
    }

    disconnectedCallback() {
        this.#ac.abort()
    }

    #onDocumentClick = (e: MouseEvent) => {
        if (!this.contains(e.target as Node)) {
            this.hideMenu()
        }
    }

    renderMenu() {
        this.#menuContainer.innerHTML = ""
        for (const { element, action } of this.#items) {
            const li = document.createElement("li")
            li.appendChild(element)
            li.onclick = () => {
                action()
                this.hideMenu()
            }
            this.#menuContainer.appendChild(li)
        }
    }

    #renderDocumentExplorer() {
        // Remove any previously rendered explorer section
        const existing = this.#menuContainer.querySelectorAll(".explorer-section")
        existing.forEach(el => el.remove())

        if (!this.#documentExplorer) return

        const closed = this.#documentExplorer.getClosedDocuments()

        const sep = document.createElement("li")
        sep.classList.add("separator", "explorer-section")
        this.#menuContainer.appendChild(sep)

        const header = document.createElement("li")
        header.classList.add("section-header", "explorer-section")
        header.textContent = "Documents"
        this.#menuContainer.appendChild(header)

        if (closed.length === 0) {
            const empty = document.createElement("li")
            empty.classList.add("empty-docs", "explorer-section")
            empty.textContent = "No closed documents"
            this.#menuContainer.appendChild(empty)
            return
        }

        for (const name of closed) {
            const li = document.createElement("li")
            li.classList.add("doc-item", "explorer-section")
            li.textContent = name
            li.onclick = () => {
                this.#documentExplorer!.onOpen(name)
                this.hideMenu()
            }
            this.#menuContainer.appendChild(li)
        }
    }

    async #renderFolderSection() {
        const folderSep = this.#menuContainer.querySelector(".folder-separator")
        const folderHeader = this.#menuContainer.querySelector(".folder-header")
        const folderItems = this.#menuContainer.querySelectorAll(".folder-item")
        folderSep?.remove()
        folderHeader?.remove()
        folderItems.forEach(el => el.remove())

        const cfg = this.#documentExplorer
        if (!cfg?.getUnopenedFolderFiles) return

        const unopened = await cfg.getUnopenedFolderFiles()

        const sep = document.createElement("li")
        sep.classList.add("separator", "folder-separator")
        this.#menuContainer.appendChild(sep)

        const header = document.createElement("li")
        header.classList.add("section-header", "folder-header")
        header.textContent = "Folder"
        this.#menuContainer.appendChild(header)

        if (unopened === null) {
            const li = document.createElement("li")
            li.classList.add("doc-item", "folder-item")
            li.textContent = "Open Folder"
            li.onclick = () => {
                void cfg.onOpenFolder?.()
                this.hideMenu()
            }
            this.#menuContainer.appendChild(li)
            return
        }

        if (unopened.length === 0) {
            const empty = document.createElement("li")
            empty.classList.add("empty-docs", "folder-item")
            empty.textContent = "All files open"
            this.#menuContainer.appendChild(empty)
            return
        }

        for (const name of unopened) {
            const li = document.createElement("li")
            li.classList.add("doc-item", "folder-item")
            li.textContent = name
            li.onclick = () => {
                void cfg.onOpenFolderFile?.(name)
                this.hideMenu()
            }
            this.#menuContainer.appendChild(li)
        }
    }

    async toggleMenu(e: MouseEvent) {
        if (this.#menuContainer.classList.contains("visible")) {
            this.hideMenu()
            return
        }

        this.#renderDocumentExplorer()
        await this.#renderFolderSection()

        const menuStyle = this.#menuContainer.style
        this.#menuContainer.classList.add("visible")

        requestAnimationFrame(() => {
            const buttonRect = this.#button.getBoundingClientRect()
            const midpoint = window.innerWidth / 2

            // Reset both edges
            menuStyle.left = "auto"
            menuStyle.right = "auto"

            if (buttonRect.left + buttonRect.width / 2 > midpoint) {
                // Align menu's right edge with button's right edge
                menuStyle.right = "0"
            } else {
                // Align menu's left edge with button's left edge
                menuStyle.left = "0"
            }
        })
    }

    hideMenu() {
        this.#menuContainer.classList.remove("visible")
    }
}

customElements.define("menu-button", MenuButton)

declare global {
    interface HTMLElementTagNameMap {
        "menu-button": MenuButton
    }
}
