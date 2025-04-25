import { PreviewWindow } from "./preview-window.mjs"
import { SDFRenderer } from "./sdf.mjs"

class App {
    preview: PreviewWindow
    editor: HTMLDivElement
    reloadButton: HTMLButtonElement
    renderer: SDFRenderer

    constructor(previewWindowID: string, editorContainerID: string, reloadButtonID: string) {
        this.preview = document.getElementById(previewWindowID) as PreviewWindow
        this.editor = document.getElementById(editorContainerID) as HTMLDivElement
        this.reloadButton = document.getElementById(reloadButtonID) as HTMLButtonElement

        this.renderer = new SDFRenderer(this.preview.canvas, fps => this.preview.updateFps(fps))
        this.renderer
            .ready()
            .then(async renderer => {
                const sceneSource = "return " + this.preview.textContent!.trim()
                await renderer.build(sceneSource)
                this.reloadButton.onclick = async () => await renderer.build(sceneSource)
                requestAnimationFrame(time => renderer.update(time))
            })
            .catch(err => console.error(`UNEXPECTED ERROR: ${err}`))
    }
}

export default App
