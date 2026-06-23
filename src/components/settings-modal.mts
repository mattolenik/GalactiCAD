import { VERSION } from "../version.mjs"
import { __fg_color, __tone_1, __tone_2, __tone_3, __tone_accent } from "../style/style.mjs"
import { BaseDialog } from "./base-dialog.mjs"
import type {
    CameraRotationMethod,
    EditorSettings,
    LineNumbersMode,
    RenderWhitespaceMode,
    ThemeMode,
} from "../storage/settings.mjs"

export class SettingsModal extends BaseDialog<void> {
    #initialMode: CameraRotationMethod
    #initialTheme: ThemeMode
    #initialDevToolsEnabled: boolean
    #initialEditorSettings: EditorSettings
    #initialAutoPivot: boolean
    #initialHoverInspect: boolean
    #onCameraModeChange: (method: CameraRotationMethod) => void
    #onThemeChange: (theme: ThemeMode) => void
    #onDevToolsChange: (enabled: boolean) => void
    #onEditorChange: (settings: EditorSettings) => void
    #onAutoPivotChange: (enabled: boolean) => void
    #onHoverInspectChange: (enabled: boolean) => void

    constructor(
        initialMode: CameraRotationMethod,
        initialTheme: ThemeMode,
        initialDevToolsEnabled: boolean,
        initialEditorSettings: EditorSettings,
        onCameraModeChange: (method: CameraRotationMethod) => void,
        onThemeChange: (theme: ThemeMode) => void,
        onDevToolsChange: (enabled: boolean) => void,
        onEditorChange: (settings: EditorSettings) => void,
        initialAutoPivot: boolean,
        initialHoverInspect: boolean,
        onAutoPivotChange: (enabled: boolean) => void,
        onHoverInspectChange: (enabled: boolean) => void
    ) {
        super()
        this.#initialMode = initialMode
        this.#initialTheme = initialTheme
        this.#initialDevToolsEnabled = initialDevToolsEnabled
        this.#initialEditorSettings = initialEditorSettings
        this.#initialAutoPivot = initialAutoPivot
        this.#initialHoverInspect = initialHoverInspect
        this.#onCameraModeChange = onCameraModeChange
        this.#onThemeChange = onThemeChange
        this.#onDevToolsChange = onDevToolsChange
        this.#onEditorChange = onEditorChange
        this.#onAutoPivotChange = onAutoPivotChange
        this.#onHoverInspectChange = onHoverInspectChange
        this.renderContent()
    }

    protected renderContent() {
        const e = this.#initialEditorSettings
        this.dialog.innerHTML = `
        <style>
            .settings-content {
                display: flex;
                flex-direction: column;
                gap: 1em;
                min-width: 320px;
            }
            .tab-bar {
                display: flex;
                gap: 0;
                border-bottom: 1px solid rgb(from var(${__fg_color}) r g b / 0.2);
            }
            .tab-btn {
                padding: 0.5em 1em;
                border: none;
                background: transparent;
                color: var(${__fg_color});
                font: inherit;
                cursor: pointer;
                opacity: 0.7;
                border-bottom: 2px solid transparent;
                margin-bottom: -1px;
            }
            .tab-btn:hover {
                opacity: 1;
            }
            .tab-btn[data-active="true"] {
                opacity: 1;
                border-bottom-color: var(${__tone_accent});
            }
            .tab-panel {
                display: none;
            }
            .tab-panel[data-active="true"] {
                display: flex;
                flex-direction: column;
                gap: 1em;
            }
            .setting-row {
                display: flex;
                align-items: center;
                gap: 0.75em;
            }
            .setting-row label {
                flex-shrink: 0;
                min-width: 7em;
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
            .setting-row input[type="checkbox"] {
                width: 1em;
                height: 1em;
                cursor: pointer;
            }
            .setting-row input[type="number"] {
                flex: 1;
                padding: 0.4em 0.6em;
                background: var(${__tone_2});
                color: var(${__fg_color});
                border: 1px solid rgb(from var(${__fg_color}) r g b / 0.2);
                border-radius: 3px;
                font: inherit;
            }
            .version-info {
                font-size: 0.85em;
                color: var(${__tone_1});
                margin-top: 0.5em;
            }
            .buttons {
                display: flex;
                justify-content: flex-end;
                margin-top: 0.5em;
            }
        </style>
        <div class="settings-content">
            <h2 style="margin: 0 0 0.5em 0; font-size: 1.1em; color: var(${__fg_color});">Settings</h2>
            <div class="tab-bar">
                <button type="button" class="tab-btn" data-tab="general" data-active="true">General</button>
                <button type="button" class="tab-btn" data-tab="editor" data-active="false">Editor</button>
            </div>
            <div class="tab-panel" data-tab="general" data-active="true">
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
                <div class="setting-row">
                    <label for="auto-pivot" title="Orbit around the surface under the cursor instead of a fixed 3D cursor. Cmd/Ctrl+double-click still locks an explicit pivot.">Auto-pivot</label>
                    <input type="checkbox" id="auto-pivot" />
                </div>
                <div class="setting-row">
                    <label for="hover-inspect" title="HoverCam: while orbiting, keep the pivot on the surface under the moving cursor for close-up inspection.">Hover inspect</label>
                    <input type="checkbox" id="hover-inspect" />
                </div>
                <div class="setting-row">
                    <label for="devtools">Developer tools</label>
                    <input type="checkbox" id="devtools" />
                </div>
                <div class="version-info">Version ${VERSION}</div>
            </div>
            <div class="tab-panel" data-tab="editor" data-active="false">
                <div class="setting-row">
                    <label for="line-numbers">Line numbers</label>
                    <select id="line-numbers">
                        <option value="on">On</option>
                        <option value="off">Off</option>
                        <option value="relative">Relative</option>
                    </select>
                </div>
                <div class="setting-row">
                    <label for="word-wrap">Word wrap</label>
                    <input type="checkbox" id="word-wrap" />
                </div>
                <div class="setting-row">
                    <label for="minimap">Minimap</label>
                    <input type="checkbox" id="minimap" />
                </div>
                <div class="setting-row">
                    <label for="font-size">Font size</label>
                    <select id="font-size">
                        ${[12, 14, 16, 18, 20, 22, 24].map(n => `<option value="${n}">${n}</option>`).join("")}
                    </select>
                </div>
                <div class="setting-row">
                    <label for="render-whitespace">Render whitespace</label>
                    <select id="render-whitespace">
                        <option value="none">None</option>
                        <option value="boundary">Boundary</option>
                        <option value="selection">Selection</option>
                        <option value="all">All</option>
                    </select>
                </div>
                <div class="setting-row">
                    <label for="folding">Folding</label>
                    <input type="checkbox" id="folding" />
                </div>
                <div class="setting-row">
                    <label for="tab-size">Tab size</label>
                    <select id="tab-size">
                        <option value="2">2</option>
                        <option value="4">4</option>
                        <option value="6">6</option>
                        <option value="8">8</option>
                    </select>
                </div>
            </div>
            <div class="buttons">
                <button class="close-btn">Close</button>
            </div>
        </div>`

        const themeSelect = this.dialog.querySelector("#theme") as HTMLSelectElement
        themeSelect.value = this.#initialTheme
        const cameraSelect = this.dialog.querySelector("#camera-mode") as HTMLSelectElement
        cameraSelect.value = this.#initialMode
        const devToolsCheckbox = this.dialog.querySelector("#devtools") as HTMLInputElement
        devToolsCheckbox.checked = this.#initialDevToolsEnabled
        const autoPivotCheckbox = this.dialog.querySelector("#auto-pivot") as HTMLInputElement
        autoPivotCheckbox.checked = this.#initialAutoPivot
        const hoverInspectCheckbox = this.dialog.querySelector("#hover-inspect") as HTMLInputElement
        hoverInspectCheckbox.checked = this.#initialHoverInspect

        const lineNumbersSelect = this.dialog.querySelector("#line-numbers") as HTMLSelectElement
        lineNumbersSelect.value = e.lineNumbers
        const wordWrapCheckbox = this.dialog.querySelector("#word-wrap") as HTMLInputElement
        wordWrapCheckbox.checked = e.wordWrap === "on"
        const minimapCheckbox = this.dialog.querySelector("#minimap") as HTMLInputElement
        minimapCheckbox.checked = e.minimap
        const fontSizeSelect = this.dialog.querySelector("#font-size") as HTMLSelectElement
        fontSizeSelect.value = String(e.fontSize)
        const renderWhitespaceSelect = this.dialog.querySelector("#render-whitespace") as HTMLSelectElement
        renderWhitespaceSelect.value = e.renderWhitespace
        const foldingCheckbox = this.dialog.querySelector("#folding") as HTMLInputElement
        foldingCheckbox.checked = e.folding
        const tabSizeSelect = this.dialog.querySelector("#tab-size") as HTMLSelectElement
        tabSizeSelect.value = String(e.tabSize)
    }

    #getEditorSettingsFromForm(): EditorSettings {
        const lineNumbers = (this.dialog.querySelector("#line-numbers") as HTMLSelectElement)
            .value as LineNumbersMode
        const wordWrap = (this.dialog.querySelector("#word-wrap") as HTMLInputElement).checked ? "on" : "off"
        const minimap = (this.dialog.querySelector("#minimap") as HTMLInputElement).checked
        const fontSize = parseInt((this.dialog.querySelector("#font-size") as HTMLSelectElement).value, 10)
        const renderWhitespace = (this.dialog.querySelector("#render-whitespace") as HTMLSelectElement)
            .value as RenderWhitespaceMode
        const folding = (this.dialog.querySelector("#folding") as HTMLInputElement).checked
        const tabSize = parseInt((this.dialog.querySelector("#tab-size") as HTMLSelectElement).value, 10)
        return {
            lineNumbers,
            wordWrap,
            minimap,
            fontSize: Math.max(12, Math.min(24, fontSize)),
            renderWhitespace,
            folding,
            tabSize: Math.max(2, Math.min(8, tabSize)),
        }
    }

    #emitEditorChange() {
        this.#onEditorChange(this.#getEditorSettingsFromForm())
    }

    protected setupEventListeners(signal: AbortSignal) {
        this.overlay.addEventListener("click", () => this.close(), { signal })
        this.shadow.querySelector(".close-btn")!.addEventListener("click", () => this.close(), { signal })
        window.addEventListener("keydown", this.#onKeyDown, { signal })

        this.shadow.querySelectorAll(".tab-btn").forEach(btn => {
            btn.addEventListener(
                "click",
                () => {
                    const tab = (btn as HTMLElement).dataset.tab!
                    this.shadow.querySelectorAll(".tab-btn").forEach(b => b.setAttribute("data-active", "false"))
                    this.shadow.querySelectorAll(".tab-panel").forEach(p => p.setAttribute("data-active", "false"))
                    btn.setAttribute("data-active", "true")
                    this.shadow.querySelector(`.tab-panel[data-tab="${tab}"]`)!.setAttribute("data-active", "true")
                },
                { signal }
            )
        })

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

        const devToolsCheckbox = this.dialog.querySelector("#devtools") as HTMLInputElement
        devToolsCheckbox.addEventListener(
            "change",
            () => this.#onDevToolsChange(devToolsCheckbox.checked),
            { signal }
        )

        const autoPivotCheckbox = this.dialog.querySelector("#auto-pivot") as HTMLInputElement
        autoPivotCheckbox.addEventListener("change", () => this.#onAutoPivotChange(autoPivotCheckbox.checked), { signal })

        const hoverInspectCheckbox = this.dialog.querySelector("#hover-inspect") as HTMLInputElement
        hoverInspectCheckbox.addEventListener("change", () => this.#onHoverInspectChange(hoverInspectCheckbox.checked), { signal })

        const editorInputs = [
            "#line-numbers",
            "#word-wrap",
            "#minimap",
            "#font-size",
            "#render-whitespace",
            "#folding",
            "#tab-size",
        ]
        editorInputs.forEach(sel => {
            const el = this.dialog.querySelector(sel)
            if (el) {
                el.addEventListener("change", () => this.#emitEditorChange(), { signal })
            }
        })
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
