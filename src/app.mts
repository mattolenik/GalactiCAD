import { PreviewWindow } from "./preview-window.mjs"
import { SDFRenderer } from "./sdf.mjs"

class App {
    preview: PreviewWindow
    editor: HTMLDivElement
    fpsCounter: HTMLSpanElement

    constructor(previewWindowID: string, editorContainerID: string, fpsCounterID: string, reloadButtonID: string) {
        this.preview = document.getElementById(previewWindowID) as PreviewWindow
        this.editor = document.getElementById(editorContainerID) as HTMLDivElement
        this.fpsCounter = document.getElementById(fpsCounterID) as HTMLSpanElement

        console.log("CANVAS", this.preview.attributes)
        new SDFRenderer(this.preview.canvas, this.fpsCounter)
            .ready()
            .then(renderer => {
                renderer.testScene()
                requestAnimationFrame(time => renderer.update(time))
                ;(document.getElementById(reloadButtonID) as HTMLButtonElement).onclick = async () => await renderer.testScene()
            })
            .catch(err => console.error(`UNEXPECTED ERROR: ${err}`))
    }
}

export default App
