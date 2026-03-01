import { __fg_color, __tone_accent, __toolbar_height } from "../style/style.mjs"
import { DropdownMenu } from "./dropdown-menu.mjs"

export interface DocumentExplorerConfig {
    getClosedDocuments: () => Promise<string[]>
    onOpen: (name: string) => void | Promise<void>
    /** Unopened .gcad files in the current folder. null = no folder tracked. */
    getUnopenedFolderFiles?: () => Promise<string[] | null>
    onOpenFolderFile?: (name: string) => void | Promise<void>
    /** Called when user chooses to open a folder (e.g. when no folder is tracked). */
    onOpenFolder?: () => void | Promise<void>
    /** Called when user chooses to close the current folder. Only shown when a folder is tracked. */
    onCloseFolder?: () => void | Promise<void>
}

export class MenuButton extends HTMLElement {
    #button: HTMLButtonElement
    #dropdown: DropdownMenu
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
        </style>

        <button>⌄</button>
        `

        this.#button = shadow.querySelector("button")!
        this.#dropdown = new DropdownMenu()
        shadow.appendChild(this.#dropdown)

        this.#button.addEventListener("click", () => this.toggleMenu())

        this.renderMenu()
    }

    renderMenu() {
        this.#dropdown.clear()
        for (const { element, action } of this.#items) {
            this.#dropdown.appendItem(element, action)
        }
    }

    async #renderDocumentExplorer() {
        // Remove any previously rendered explorer section
        const existing = this.#dropdown.menu.querySelectorAll(".explorer-section")
        existing.forEach(el => el.remove())

        if (!this.#documentExplorer) return

        const closed = await this.#documentExplorer.getClosedDocuments()

        this.#dropdown.appendSeparator("explorer-section")
        this.#dropdown.appendSectionHeader("Documents", "explorer-section")

        if (closed.length === 0) {
            this.#dropdown.appendEmpty("No closed documents", "explorer-section")
            return
        }

        for (const name of closed) {
            this.#dropdown.appendDocItem(
                name,
                () => void this.#documentExplorer!.onOpen(name),
                "explorer-section"
            )
        }
    }

    async #renderFolderSection() {
        const folderSep = this.#dropdown.menu.querySelector(".folder-separator")
        const folderHeader = this.#dropdown.menu.querySelector(".folder-header")
        const folderItems = this.#dropdown.menu.querySelectorAll(".folder-item")
        folderSep?.remove()
        folderHeader?.remove()
        folderItems.forEach(el => el.remove())

        const cfg = this.#documentExplorer
        if (!cfg?.getUnopenedFolderFiles) return

        const unopened = await cfg.getUnopenedFolderFiles()

        this.#dropdown.appendSeparator("folder-separator")
        this.#dropdown.appendSectionHeader("Folder", "folder-header")

        if (unopened === null) {
            this.#dropdown.appendDocItem("Open Folder", () => void cfg.onOpenFolder?.(), "folder-item")
            return
        }

        if (cfg.onCloseFolder) {
            this.#dropdown.appendDocItem("Close Folder", () => void cfg.onCloseFolder?.(), "folder-item")
        }

        if (unopened.length === 0) {
            this.#dropdown.appendEmpty("All files open", "folder-item")
            return
        }

        for (const name of unopened) {
            this.#dropdown.appendDocItem(
                name,
                () => void cfg.onOpenFolderFile?.(name),
                "folder-item"
            )
        }
    }

    async toggleMenu() {
        if (this.#dropdown.visible) {
            this.#dropdown.hide()
            return
        }

        await this.#renderDocumentExplorer()
        await this.#renderFolderSection()

        this.#dropdown.show(this.#button)
    }

    hideMenu() {
        this.#dropdown.hide()
    }
}

customElements.define("menu-button", MenuButton)

declare global {
    interface HTMLElementTagNameMap {
        "menu-button": MenuButton
    }
}
