import { __fg_color, __tone_2, __tone_3 } from "../style/style.mjs"

export class DropdownMenu extends HTMLElement {
    #ac = new AbortController()
    #menuContainer: HTMLUListElement
    #anchor?: HTMLElement

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })

        const style = document.createElement("style")
        style.textContent = `
            :host {
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                display: block;
            }

            .menu {
                position: absolute;
                top: 0;
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
                background: var(${__tone_3});
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

            .menu li.doc-item.doc-item-with-icon {
                display: flex;
                align-items: center;
                gap: 10px;
            }

            .menu li.doc-item .doc-item-icon {
                flex-shrink: 0;
                width: 18px;
                height: 18px;
                opacity: 0.85;
            }

            .menu li.doc-item .doc-item-icon svg {
                width: 100%;
                height: 100%;
                display: block;
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
        // Use composedPath() so we see the real target inside shadow DOM (event.target is retargeted to shadow host)
        const path = e.composedPath() as EventTarget[]
        const isNode = (n: EventTarget): n is Node => n instanceof Node
        if (path.some(n => isNode(n) && (n === this || this.contains(n)))) return
        if (this.#anchor && path.some(n => isNode(n) && (n === this.#anchor || this.#anchor!.contains(n)))) return
        this.hide()
    }

    clear() {
        this.#menuContainer.innerHTML = ""
    }

    appendItem(element: HTMLElement, action: () => void) {
        const li = document.createElement("li")
        li.appendChild(element)
        li.onclick = () => {
            action()
            this.hide()
        }
        this.#menuContainer.appendChild(li)
    }

    appendSeparator(className?: string) {
        const li = document.createElement("li")
        li.classList.add("separator")
        if (className) li.classList.add(className)
        this.#menuContainer.appendChild(li)
    }

    appendSectionHeader(title: string, className?: string) {
        const li = document.createElement("li")
        li.classList.add("section-header")
        if (className) li.classList.add(className)
        li.textContent = title
        this.#menuContainer.appendChild(li)
    }

    appendDocItem(label: string, action: () => void, className?: string) {
        const li = document.createElement("li")
        li.classList.add("doc-item")
        if (className) li.classList.add(className)
        li.textContent = label
        li.onclick = () => {
            action()
            this.hide()
        }
        this.#menuContainer.appendChild(li)
    }

    appendDocItemWithIcon(label: string, iconSvg: string, action: () => void, className?: string) {
        const li = document.createElement("li")
        li.classList.add("doc-item", "doc-item-with-icon")
        if (className) li.classList.add(className)
        const iconSpan = document.createElement("span")
        iconSpan.classList.add("doc-item-icon")
        iconSpan.innerHTML = iconSvg
        const labelSpan = document.createElement("span")
        labelSpan.textContent = label
        li.append(iconSpan, labelSpan)
        li.onclick = () => {
            action()
            this.hide()
        }
        this.#menuContainer.appendChild(li)
    }

    appendEmpty(label: string, className?: string) {
        const li = document.createElement("li")
        li.classList.add("empty-docs")
        if (className) li.classList.add(className)
        li.textContent = label
        this.#menuContainer.appendChild(li)
    }

    show(anchor: HTMLElement) {
        this.#anchor = anchor
        this.#menuContainer.classList.add("visible")

        requestAnimationFrame(() => {
            const buttonRect = anchor.getBoundingClientRect()
            const midpoint = window.innerWidth / 2
            const menuStyle = this.#menuContainer.style

            menuStyle.left = "auto"
            menuStyle.right = "auto"

            if (buttonRect.left + buttonRect.width / 2 > midpoint) {
                menuStyle.right = "0"
            } else {
                menuStyle.left = "0"
            }
        })
    }

    hide() {
        this.#menuContainer.classList.remove("visible")
        this.#anchor = undefined
    }

    get visible(): boolean {
        return this.#menuContainer.classList.contains("visible")
    }

    get menu(): HTMLUListElement {
        return this.#menuContainer
    }
}

customElements.define("dropdown-menu", DropdownMenu)

declare global {
    interface HTMLElementTagNameMap {
        "dropdown-menu": DropdownMenu
    }
}
