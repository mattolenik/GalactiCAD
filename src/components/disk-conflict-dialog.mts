import { __fg_color, __tone_1, __tone_2, __tone_3 } from "../style/style.mjs"
import { BaseDialog } from "./base-dialog.mjs"

export type DiskConflictChoice = "keepEdits" | "loadDisk"

export class DiskConflictDialog extends BaseDialog<DiskConflictChoice> {
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
            button.keepEdits { background: var(${__tone_3}); }
            button.loadDisk { background: var(${__tone_1}); }
        </style>
        <div class="message">"${fileName.replace(/"/g, "&quot;")}" has been modified by another program. You have unsaved edits in the browser.</div>
        <div class="buttons">
            <button class="keepEdits">Keep my edits</button>
            <button class="loadDisk">Load disk</button>
        </div>`
    }

    protected setupEventListeners(signal: AbortSignal): void {
        this.overlay.addEventListener("click", () => this.close("loadDisk"), { signal })
        this.shadow.querySelector(".keepEdits")!.addEventListener("click", () => this.close("keepEdits"), { signal })
        this.shadow.querySelector(".loadDisk")!.addEventListener("click", () => this.close("loadDisk"), { signal })
        window.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault()
                this.close("loadDisk")
            }
        }, { signal })
    }
}

customElements.define("disk-conflict-dialog", DiskConflictDialog)

declare global {
    interface HTMLElementTagNameMap {
        "disk-conflict-dialog": DiskConflictDialog
    }
}
