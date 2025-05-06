import { __toolbar_height, __tone_1, __fg_color, __tone_3, __tone_2 } from "../style/style.mjs"

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
          --corner: 6px;
        }

        button {
          display: inline-block;
          cursor: pointer;
          background: none;
          background: var(${__tone_2});
          margin-top: 4px;
          line-height: 0;
          padding-bottom: 10px;
          height: calc(var(${__toolbar_height}) - 4px);
          width: calc(var(${__toolbar_height}) - 4px);
          border: 1px solid var(${__tone_3});
          border-radius: var(--corner);
          color: var(${__fg_color});
          font-size: large;
          transition: background-color 0.2s;
        }
        
        button:hover {
          background: var(${__tone_3});
          border: 1px solid var(${__tone_1});
        }

        .menu {
          position: absolute;
          top: 100%;
          border: 1px solid var(${__tone_3});
          background: var(${__tone_2});
          padding: 0;
          margin: 0;
          list-style: none;
          width: max-content;
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
          border-radius: var(--corner);
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
          transition: background-color 0.2s;
        }

        .menu li:hover {
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
