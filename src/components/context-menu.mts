import { __fg_color, __tone_2, __tone_3 } from "../style/style.mjs"

export interface ContextMenuItem {
    label: string
    /** Leaf action. Omit when `children` is set (the item becomes a submenu parent). */
    action?: () => void
    /** When present, the item opens a hover flyout submenu instead of running an action. */
    children?: ContextMenuItem[]
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

            /* Single rounded button (polygon "Edit" affordance) rather than a list. */
            .menu.as-button {
                background: transparent;
                box-shadow: none;
                min-width: 0;
                width: max-content;
            }

            .edit-button {
                pointer-events: auto;
                /* Subtle top-left corner lighting: bright top/left edges, faint dark bottom/right. */
                border: 1px solid;
                border-color: rgba(255, 255, 255, 0.5) rgba(0, 0, 0, 0.12) rgba(0, 0, 0, 0.12) rgba(255, 255, 255, 0.5);
                border-radius: 7px;
                /* Larger label, trimmed padding so the button keeps the same footprint. */
                padding: 3px 11px;
                font: inherit;
                font-size: 16px;
                font-weight: 600;
                line-height: 1.4;
                cursor: pointer;
                white-space: nowrap;
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
                transition: filter 0.15s, box-shadow 0.1s, transform 0.05s;
            }

            .edit-button:hover {
                filter: brightness(1.06);
            }

            /* Press the button down for a tactile, physical click. */
            .edit-button:active {
                transform: translateY(1px);
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
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

            .menu li.has-submenu {
                position: relative;
            }

            .menu li.has-submenu::after {
                content: "▸";
                float: right;
                margin-left: 12px;
                opacity: 0.7;
            }

            .submenu {
                position: absolute;
                left: 100%;
                top: 0;
                margin: 0;
                padding: 0;
                list-style: none;
                background: var(${__tone_2});
                min-width: 160px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                display: none;
            }

            .menu li.has-submenu:hover > .submenu {
                display: block;
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
        this.#menuContainer.classList.remove("as-button")
        this.#menuContainer.innerHTML = ""
        for (const item of items) {
            this.#menuContainer.appendChild(this.#buildItem(item))
        }
    }

    /**
     * Render the popup as a single rounded button instead of a list — used for the
     * polygon "Edit" affordance. `background`/`color` tint it (e.g. the shape's color
     * for the fill, the editor background for the label).
     */
    setButton(label: string, action: () => void, colors: { background: string; color: string }) {
        this.#menuContainer.classList.add("as-button")
        this.#menuContainer.innerHTML = ""
        const button = document.createElement("button")
        button.className = "edit-button"
        button.textContent = label
        // Set the base color only — the CSS border supplies the top-left corner lighting.
        button.style.backgroundColor = colors.background
        button.style.color = colors.color
        button.onclick = () => {
            action()
            this.hide()
        }
        this.#menuContainer.appendChild(button)
    }

    /** Build a menu `<li>` for an item; items with `children` render a hover flyout submenu. */
    #buildItem(item: ContextMenuItem): HTMLLIElement {
        const li = document.createElement("li")
        const label = document.createElement("span")
        label.textContent = item.label
        li.appendChild(label)
        if (item.children && item.children.length > 0) {
            li.classList.add("has-submenu")
            const submenu = document.createElement("ul")
            submenu.classList.add("submenu")
            for (const child of item.children) submenu.appendChild(this.#buildItem(child))
            li.appendChild(submenu)
        } else {
            li.onclick = () => {
                item.action?.()
                this.hide()
            }
        }
        return li
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

    /**
     * Show the menu pinned above a target rect: left edge aligned with `anchor.left`,
     * bottom edge sitting `gap` px above `anchor.top`. Drops below the anchor when
     * there isn't room above; clamps to the viewport. onPositioned runs after layout.
     */
    showAboveAnchor(anchor: DOMRect, onPositioned?: () => void) {
        const gap = 6
        // Provisional placement so the menu can be measured at its final size.
        this.#menuContainer.style.left = `${anchor.left}px`
        this.#menuContainer.style.top = `${anchor.top}px`
        this.#menuContainer.classList.add("visible")

        requestAnimationFrame(() => {
            const rect = this.#menuContainer.getBoundingClientRect()
            const vw = window.innerWidth
            const vh = window.innerHeight

            let left = anchor.left
            let top = anchor.top - gap - rect.height
            if (top < 0) top = anchor.bottom + gap
            if (left + rect.width > vw) left = vw - rect.width
            if (left < 0) left = 0
            if (top + rect.height > vh) top = vh - rect.height

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
