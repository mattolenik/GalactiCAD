import { __fg_color, __tone_2, __tone_3 } from "../style/style.mjs"

export interface ContextMenuItem {
    label: string
    action: () => void
}

export class ContextMenu extends HTMLElement {
    #ac = new AbortController()
    #menuContainer: HTMLUListElement
    /** Called when the menu is hidden (from any cause). Use for cleanup. */
    onHide?: () => void

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })

        const style = document.createElement("style")
        style.textContent = `
            :host {
                position: fixed;
                inset: 0;
                pointer-events: none;
                z-index: 1000;
            }

            .menu {
                position: fixed;
                pointer-events: auto;
                background: var(${__tone_2});
                margin: 0;
                padding: 0;
                list-style: none;
                width: max-content;
                min-width: 160px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
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
                background: var(${__tone_3});
            }
        `
        shadow.appendChild(style)

        this.#menuContainer = document.createElement("ul")
        this.#menuContainer.classList.add("menu")
        shadow.appendChild(this.#menuContainer)
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
        const path = e.composedPath() as EventTarget[]
        const isNode = (n: EventTarget): n is Node => n instanceof Node
        if (path.some(n => isNode(n) && (n === this || this.contains(n)))) return
        this.hide()
    }

    setItems(items: ContextMenuItem[]) {
        this.#menuContainer.innerHTML = ""
        for (const item of items) {
            const li = document.createElement("li")
            li.textContent = item.label
            li.onclick = () => {
                item.action()
                this.hide()
            }
            this.#menuContainer.appendChild(li)
        }
    }

    /**
     * Show at position. onPositioned is called after layout (e.g. to set up safe-zone mousemove).
     */
    showAt(clientX: number, clientY: number, onPositioned?: () => void) {
        const offset = 12
        let left = clientX + offset
        let top = clientY + offset

        this.#menuContainer.style.left = `${left}px`
        this.#menuContainer.style.top = `${top}px`
        this.#menuContainer.classList.add("visible")

        requestAnimationFrame(() => {
            const rect = this.#menuContainer.getBoundingClientRect()
            const vw = window.innerWidth
            const vh = window.innerHeight

            if (left + rect.width > vw) left = clientX - rect.width - offset
            if (top + rect.height > vh) top = clientY - rect.height - offset
            if (left < 0) left = offset
            if (top < 0) top = offset

            this.#menuContainer.style.left = `${left}px`
            this.#menuContainer.style.top = `${top}px`
            onPositioned?.()
        })
    }

    hide() {
        this.#menuContainer.classList.remove("visible")
        this.onHide?.()
        this.onHide = undefined
    }

    get visible(): boolean {
        return this.#menuContainer.classList.contains("visible")
    }

    /** Bounding rect of the menu (after positioning). Call after showAt's layout is complete. */
    getMenuRect(): DOMRect {
        return this.#menuContainer.getBoundingClientRect()
    }
}

customElements.define("context-menu", ContextMenu)

declare global {
    interface HTMLElementTagNameMap {
        "context-menu": ContextMenu
    }
}
