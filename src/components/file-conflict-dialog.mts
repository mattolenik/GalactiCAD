import { __fg_color, __tone_1, __tone_2, __tone_3 } from "../style/style.mjs"
import { BaseDialog } from "./base-dialog.mjs"

export type FileConflictChoice = "overwrite" | "revert" | "cancel"

export class FileConflictDialog extends BaseDialog<FileConflictChoice> {
    constructor(fileName: string) {
        super()
        this.renderContent(fileName)
    }

    protected renderContent(fileName: string): void {
        this.dialog.innerHTML = `
        <style>
            .message { margin-bottom: 1em; text-align: center; }
            .buttons { display: flex; flex-wrap: wrap; gap: 0.75em; justify-content: center; }
            button { padding: 0.5em 1em; }
            button.overwrite { background: var(${__tone_3}); }
            button.revert { background: var(${__tone_1}); }
            button.cancel { background: var(${__tone_2}); }
        </style>
        <div class="message">"${fileName.replace(/"/g, "&quot;")}" has been modified externally. How would you like to proceed?</div>
        <div class="buttons">
            <button class="overwrite">Overwrite disk</button>
            <button class="revert">Revert to disk</button>
            <button class="cancel">Cancel</button>
        </div>`
    }

    protected setupEventListeners(signal: AbortSignal): void {
        this.overlay.addEventListener("click", () => this.close("cancel"), { signal })
        this.shadow.querySelector(".overwrite")!.addEventListener("click", () => this.close("overwrite"), { signal })
        this.shadow.querySelector(".revert")!.addEventListener("click", () => this.close("revert"), { signal })
        this.shadow.querySelector(".cancel")!.addEventListener("click", () => this.close("cancel"), { signal })
        window.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault()
                this.close("cancel")
            }
        }, { signal })
    }
}

customElements.define("file-conflict-dialog", FileConflictDialog)

declare global {
    interface HTMLElementTagNameMap {
        "file-conflict-dialog": FileConflictDialog
    }
}
