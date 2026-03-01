import { __fg_color, __tone_1, __tone_2, __tone_3 } from "../style/style.mjs"
import { BaseDialog } from "./base-dialog.mjs"

export type UnsavedCloseChoice = "save" | "dontSave" | "cancel"

export class UnsavedCloseDialog extends BaseDialog<UnsavedCloseChoice> {
    constructor(mode: "single" | "batch", fileName?: string, count?: number) {
        super()
        this.renderContent(mode, fileName, count)
    }

    protected renderContent(mode: "single" | "batch", fileName?: string, count?: number): void {
        const message =
            mode === "single"
                ? `Save "${(fileName ?? "").replace(/"/g, "&quot;")}" to disk before closing? Your work is saved in the browser — you can save later.`
                : `You have unsaved changes in ${count ?? 0} files. Save to disk before closing? Your work is saved in the browser — you can save later.`

        const saveLabel = mode === "single" ? "Save" : "Save All"

        this.dialog.innerHTML = `
        <style>
            .message { margin-bottom: 1em; text-align: center; }
            .buttons { display: flex; flex-wrap: wrap; gap: 0.75em; justify-content: center; }
            button { padding: 0.5em 1em; }
            button.save { background: var(${__tone_3}); }
            button.dontSave { background: var(${__tone_1}); }
            button.cancel { background: var(${__tone_2}); }
        </style>
        <div class="message">${message}</div>
        <div class="buttons">
            <button class="save">${saveLabel}</button>
            <button class="dontSave">Don't Save</button>
            <button class="cancel">Cancel</button>
        </div>`
    }

    protected setupEventListeners(signal: AbortSignal): void {
        this.overlay.addEventListener("click", () => this.close("cancel"), { signal })
        this.shadow.querySelector(".save")!.addEventListener("click", () => this.close("save"), { signal })
        this.shadow.querySelector(".dontSave")!.addEventListener("click", () => this.close("dontSave"), { signal })
        this.shadow.querySelector(".cancel")!.addEventListener("click", () => this.close("cancel"), { signal })
        window.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault()
                this.close("cancel")
            }
        }, { signal })
    }
}

customElements.define("unsaved-close-dialog", UnsavedCloseDialog)

declare global {
    interface HTMLElementTagNameMap {
        "unsaved-close-dialog": UnsavedCloseDialog
    }
}
