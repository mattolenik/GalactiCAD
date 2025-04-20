import { PreviewWindow } from "./preview-window.mjs"
import { SDFRenderer } from "./sdf.mjs"

class App {
    preview: PreviewWindow
    editor: HTMLDivElement
    reloadButton: HTMLButtonElement

    constructor(previewWindowID: string, editorContainerID: string, reloadButtonID: string) {
        this.preview = document.getElementById(previewWindowID) as PreviewWindow
        this.editor = document.getElementById(editorContainerID) as HTMLDivElement
        this.reloadButton = document.getElementById(reloadButtonID) as HTMLButtonElement

        new SDFRenderer(this.preview.canvas, fps => this.preview.updateFps(fps))
            .ready()
            .then(renderer => {
                renderer.build(this.preview.textContent!)
                this.reloadButton.onclick = async () => await renderer.build(this.preview.textContent!)
                requestAnimationFrame(time => renderer.update(time))
            })
            .catch(err => console.error(`UNEXPECTED ERROR: ${err}`))
    }
}

export default App
