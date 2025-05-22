import { __fg_color, __tone_2, __tone_3, __toolbar_height } from "../style/style.mjs"

export class MenuButton extends HTMLElement {
    #button: HTMLButtonElement
    #menuContainer: HTMLElement
    #items: Array<{ element: HTMLElement; action: () => void }>

    constructor(items: Array<{ element: HTMLElement; action: () => void }>) {
        super()
        this.#items = items

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
                background: var(${__tone_2});
                line-height: 0;
                padding: 0 0 calc(var(${__toolbar_height}) / 2 - 4px) 0;
                height: calc(var(${__toolbar_height}) + 4px);
                width: calc(var(${__toolbar_height}) + 10px);
                border: none;
                color: rgb(from var(${__fg_color}) r g b / 0.6);
                font-size: large;
                transition: background-color 0.2s, color 0.2s;
            }

            button:hover {
                background: var(${__tone_3});
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
        </style>

        <button>⌄</button>
        <ul class="menu"></ul>
        `

        this.#button = shadow.querySelector("button")!
        this.#menuContainer = shadow.querySelector(".menu")!

        this.#button.addEventListener("click", e => this.toggleMenu(e))

        document.addEventListener("click", e => {
            if (!this.contains(e.target as Node)) {
                this.hideMenu()
            }
        })

        this.renderMenu()
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
    toggleMenu(e: MouseEvent) {
        if (this.#menuContainer.classList.contains("visible")) {
            this.hideMenu()
            return
        }

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
