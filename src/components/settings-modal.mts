import { __fg_color, __tone_1, __tone_2, __tone_3 } from "../style/style.mjs"
import { BaseDialog } from "./base-dialog.mjs"
import type { CameraRotationMethod, ThemeMode } from "../storage/settings.mjs"

export class SettingsModal extends BaseDialog<void> {
    #initialMode: CameraRotationMethod
    #initialTheme: ThemeMode
    #onCameraModeChange: (method: CameraRotationMethod) => void
    #onThemeChange: (theme: ThemeMode) => void

    constructor(
        initialMode: CameraRotationMethod,
        initialTheme: ThemeMode,
        onCameraModeChange: (method: CameraRotationMethod) => void,
        onThemeChange: (theme: ThemeMode) => void
    ) {
        super()
        this.#initialMode = initialMode
        this.#initialTheme = initialTheme
        this.#onCameraModeChange = onCameraModeChange
        this.#onThemeChange = onThemeChange
        this.renderContent()
    }

    protected renderContent() {
        this.dialog.innerHTML = `
        <style>
            .settings-content {
                display: flex;
                flex-direction: column;
                gap: 1em;
                min-width: 280px;
            }
            .setting-row {
                display: flex;
                align-items: center;
                gap: 0.75em;
            }
            .setting-row label {
                flex-shrink: 0;
                color: var(${__fg_color});
            }
            .setting-row select {
                flex: 1;
                padding: 0.4em 0.6em;
                background: var(${__tone_2});
                color: var(${__fg_color});
                border: 1px solid rgb(from var(${__fg_color}) r g b / 0.2);
                border-radius: 3px;
                font: inherit;
                cursor: pointer;
            }
            .setting-row select:hover {
                background: var(${__tone_3});
            }
            .buttons {
                display: flex;
                justify-content: flex-end;
                margin-top: 0.5em;
            }
        </style>
        <div class="settings-content">
            <h2 style="margin: 0 0 0.5em 0; font-size: 1.1em; color: var(${__fg_color});">Settings</h2>
            <div class="setting-row">
                <label for="theme">Theme</label>
                <select id="theme">
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                    <option value="auto">Auto (system)</option>
                </select>
            </div>
            <div class="setting-row">
                <label for="camera-mode">Camera mode</label>
                <select id="camera-mode">
                    <option value="rounded_arcball">Rounded Arcball</option>
                    <option value="azel">Azimuth/Elevation</option>
                </select>
            </div>
            <div class="buttons">
                <button class="close-btn">Close</button>
            </div>
        </div>`

        const themeSelect = this.dialog.querySelector("#theme") as HTMLSelectElement
        themeSelect.value = this.#initialTheme
        const cameraSelect = this.dialog.querySelector("#camera-mode") as HTMLSelectElement
        cameraSelect.value = this.#initialMode
    }

    protected setupEventListeners(signal: AbortSignal) {
        this.overlay.addEventListener("click", () => this.close(), { signal })
        this.shadow.querySelector(".close-btn")!.addEventListener("click", () => this.close(), { signal })
        window.addEventListener("keydown", this.#onKeyDown, { signal })

        const themeSelect = this.dialog.querySelector("#theme") as HTMLSelectElement
        themeSelect.addEventListener(
            "change",
            () => {
                const value = themeSelect.value as ThemeMode
                if (value === "light" || value === "dark" || value === "auto") {
                    this.#onThemeChange(value)
                }
            },
            { signal }
        )

        const cameraSelect = this.dialog.querySelector("#camera-mode") as HTMLSelectElement
        cameraSelect.addEventListener(
            "change",
            () => {
                const value = cameraSelect.value as CameraRotationMethod
                if (value === "rounded_arcball" || value === "azel") {
                    this.#onCameraModeChange(value)
                }
            },
            { signal }
        )
    }

    #onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault()
            this.close()
        }
    }
}

customElements.define("settings-modal", SettingsModal)

declare global {
    interface HTMLElementTagNameMap {
        "settings-modal": SettingsModal
    }
}
