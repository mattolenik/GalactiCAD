import { __fg_color, __preview_bg, __toolbar_height } from "../style/style.mjs"
import { DropdownMenu } from "./dropdown-menu.mjs"

export class ToolbarCheckbox {
    #checkbox: HTMLInputElement
    onChange?: (checked: boolean) => void

    constructor(label: string, checked: boolean, container: HTMLElement) {
        const el = document.createElement("label")
        this.#checkbox = document.createElement("input")
        this.#checkbox.type = "checkbox"
        this.#checkbox.checked = checked
        this.#checkbox.addEventListener("change", () => {
            this.onChange?.(this.#checkbox.checked)
        })
        el.append(this.#checkbox, label)
        container.appendChild(el)
    }

    get checked(): boolean { return this.#checkbox.checked }
    set checked(v: boolean) { this.#checkbox.checked = v }
}

export class ToolbarToggleButton {
    #button: HTMLButtonElement
    #checked: boolean
    onChange?: (checked: boolean) => void

    constructor(icon: string, checked: boolean, container: HTMLElement, alt?: string) {
        this.#checked = checked
        this.#button = document.createElement("button")
        this.#button.innerHTML = icon
        this.#button.classList.add("icon-btn")
        if (alt) {
            this.#button.title = alt
            this.#button.setAttribute("aria-label", alt)
        }
        this.#button.classList.toggle("active", checked)
        this.#button.addEventListener("click", () => {
            this.#checked = !this.#checked
            this.#button.classList.toggle("active", this.#checked)
            this.onChange?.(this.#checked)
        })
        container.appendChild(this.#button)
    }

    get checked(): boolean { return this.#checked }
    set checked(v: boolean) {
        this.#checked = v
        this.#button.classList.toggle("active", v)
    }
}

export class ToolbarButton {
    #button: HTMLButtonElement
    onClick?: () => void

    constructor(label: string, container: HTMLElement, alt?: string) {
        this.#button = document.createElement("button")
        this.#button.textContent = label
        if (alt) {
            this.#button.title = alt
            this.#button.setAttribute("aria-label", alt)
        }
        this.#button.addEventListener("click", () => {
            this.onClick?.()
        })
        container.appendChild(this.#button)
    }

    get label(): string { return this.#button.textContent ?? "" }
    set label(v: string) { this.#button.textContent = v }

    get html(): string { return this.#button.innerHTML }
    set html(v: string) {
        this.#button.innerHTML = v
        this.#button.classList.add("icon-btn")
    }

    get disabled(): boolean { return this.#button.disabled }
    set disabled(v: boolean) { this.#button.disabled = v }

    get active(): boolean { return this.#button.classList.contains("active") }
    set active(v: boolean) {
        this.#button.classList.toggle("active", v)
    }
}

let radioGroupId = 0

type RadioOption<T> = { label: string; value: T; icon?: string }

export class ToolbarRadioGroup<T extends string> {
    #radios: Map<T, HTMLInputElement> = new Map()
    #buttons: Map<T, HTMLButtonElement> = new Map()
    #value: T
    onChange?: (value: T) => void

    constructor(options: RadioOption<T>[], defaultValue: T, container: HTMLElement) {
        const groupName = `tb-radio-${radioGroupId++}`
        this.#value = defaultValue

        const group = document.createElement("div")
        group.classList.add("radio-group")

        const updateActive = () => {
            for (const [val, btn] of this.#buttons) {
                btn.classList.toggle("active", val === this.#value)
            }
        }

        for (const opt of options) {
            const label = document.createElement("label")
            const radio = document.createElement("input")
            radio.type = "radio"
            radio.name = groupName
            radio.value = opt.value
            radio.checked = opt.value === defaultValue
            radio.classList.add("radio-input")
            if (opt.icon) radio.classList.add("visually-hidden")
            radio.addEventListener("change", () => {
                if (radio.checked) {
                    this.#value = opt.value
                    updateActive()
                    this.onChange?.(opt.value)
                }
            })
            this.#radios.set(opt.value, radio)
            label.append(radio)

            if (opt.icon) {
                const button = document.createElement("button")
                button.type = "button"
                button.classList.add("icon-btn")
                button.classList.toggle("active", opt.value === defaultValue)
                button.innerHTML = opt.icon
                button.title = opt.label
                button.setAttribute("aria-label", opt.label)
                label.setAttribute("aria-label", opt.label)
                button.addEventListener("click", (e) => {
                    e.preventDefault()
                    if (radio.checked) return
                    radio.checked = true
                    this.#value = opt.value
                    updateActive()
                    this.onChange?.(opt.value)
                })
                this.#buttons.set(opt.value, button)
                label.appendChild(button)
            } else {
                label.append(opt.label)
            }
            group.appendChild(label)
        }

        container.appendChild(group)
    }

    get value(): T { return this.#value }
    set value(v: T) {
        this.#value = v
        const radio = this.#radios.get(v)
        if (radio) radio.checked = true
        for (const [val, btn] of this.#buttons) {
            btn.classList.toggle("active", val === v)
        }
    }
}

export class Toolbar extends HTMLElement {
    #container: HTMLDivElement

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })

        const style = document.createElement("style")
        style.textContent = `
            :host {
                display: flex;
                align-items: center;
                justify-content: flex-end;
                height: 100%;
                width: 100%;
            }
            .toolbar {
                display: flex;
                align-items: center;
                gap: 6px;
                height: 100%;
                width: 100%;
                box-sizing: border-box;
                background: var(${__preview_bg});
                padding: 0 8px;
                border-radius: 0;
                color: rgb(from var(${__fg_color}) r g b / 0.85);
                font-size: 15px;
                font-family: system-ui, sans-serif;
            }
            label {
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 4px;
                white-space: nowrap;
            }
            input[type="checkbox"] {
                cursor: pointer;
                margin: 0;
            }
            button {
                cursor: pointer;
                background: none;
                border: 1px solid rgb(from var(${__fg_color}) r g b / 0.2);
                border-radius: 3px;
                color: inherit;
                font: inherit;
                padding: 4px 8px;
                min-height: 0;
                height: calc(var(${__toolbar_height}) - 8px);
            }
            button:hover {
                background: rgb(from var(${__fg_color}) r g b / 0.1);
            }
            button:active {
                background: rgb(from var(${__fg_color}) r g b / 0.2);
            }
            button:disabled {
                opacity: 0.4;
                cursor: default;
            }
            button.active {
                background: rgb(from var(${__fg_color}) r g b / 0.22);
                border-color: rgb(from var(${__fg_color}) r g b / 0.45);
                box-shadow: inset 0 1px 3px rgba(0,0,0,0.35);
            }
            button.active:hover {
                background: rgb(from var(${__fg_color}) r g b / 0.3);
            }
            button.icon-btn {
                padding: 5px;
                aspect-ratio: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                line-height: 0;
            }
            button.icon-btn svg {
                display: block;
                flex-shrink: 0;
            }
            .separator {
                width: 1px;
                height: calc(var(${__toolbar_height}) - 12px);
                background: rgb(from var(${__fg_color}) r g b / 0.2);
                flex-shrink: 0;
            }
            .radio-group {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .radio-group label {
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 3px;
            }
            input[type="radio"] {
                cursor: pointer;
                margin: 0;
            }
            input[type="radio"].visually-hidden {
                position: absolute;
                width: 1px;
                height: 1px;
                padding: 0;
                margin: -1px;
                overflow: hidden;
                clip: rect(0, 0, 0, 0);
                white-space: nowrap;
                border: 0;
            }
            .dropdown-btn-wrapper {
                position: relative;
                display: flex;
                align-items: center;
            }
            .dropdown-btn-wrapper .dropdown-chevron {
                font-size: 8px;
                margin-left: 2px;
                opacity: 0.7;
            }
        `
        shadow.appendChild(style)

        this.#container = document.createElement("div")
        this.#container.classList.add("toolbar")
        shadow.appendChild(this.#container)
    }

    addCheckbox(label: string, checked = false): ToolbarCheckbox {
        return new ToolbarCheckbox(label, checked, this.#container)
    }

    addToggleButton(icon: string, alt?: string, checked = false): ToolbarToggleButton {
        return new ToolbarToggleButton(icon, checked, this.#container, alt)
    }

    addButton(label: string, alt?: string): ToolbarButton {
        return new ToolbarButton(label, this.#container, alt)
    }

    addRadioGroup<T extends string>(options: RadioOption<T>[], defaultValue: T): ToolbarRadioGroup<T> {
        return new ToolbarRadioGroup(options, defaultValue, this.#container)
    }

    addSeparator(): void {
        const sep = document.createElement("div")
        sep.classList.add("separator")
        this.#container.appendChild(sep)
    }

    addSpacer(): void {
        const spacer = document.createElement("div")
        spacer.style.flex = "1"
        this.#container.appendChild(spacer)
    }

    addDropdownButton(
        icon: string,
        label: string,
        items: Array<
            | { label: string; shortcut?: string; icon?: string; action: () => void }
            | { type: "separator" }
        >
    ): HTMLElement {
        const wrapper = document.createElement("div")
        wrapper.classList.add("dropdown-btn-wrapper")

        const button = document.createElement("button")
        button.classList.add("icon-btn")
        button.title = label
        button.setAttribute("aria-label", label)
        button.innerHTML = icon + '<span class="dropdown-chevron">▼</span>'
        wrapper.appendChild(button)

        const dropdown = new DropdownMenu()
        wrapper.appendChild(dropdown)

        button.addEventListener("click", (e) => {
            e.stopPropagation()
            if (dropdown.visible) {
                dropdown.hide()
                return
            }
            dropdown.clear()
            for (const item of items) {
                if ("type" in item && item.type === "separator") {
                    dropdown.appendSeparator()
                } else {
                    const actionItem = item as { label: string; shortcut?: string; icon?: string; action: () => void }
                    const displayLabel = actionItem.shortcut ? `${actionItem.label} (${actionItem.shortcut})` : actionItem.label
                    if (actionItem.icon) {
                        dropdown.appendDocItemWithIcon(displayLabel, actionItem.icon, actionItem.action)
                    } else {
                        dropdown.appendDocItem(displayLabel, actionItem.action)
                    }
                }
            }
            dropdown.show(button)
        })

        this.#container.appendChild(wrapper)
        return wrapper
    }
}

customElements.define("view-toolbar", Toolbar)

declare global {
    interface HTMLElementTagNameMap {
        "view-toolbar": Toolbar
    }
}
