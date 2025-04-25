import * as monaco from "monaco-editor"
import "monaco-editor-env" // used at runtime, do not remove
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

        monaco.editor.create(this.editor, {
            value: ["function x() {", '\tconsole.log("Hello world!");', "}"].join("\n"),
            language: "javascript",
        })
        this.renderer = new SDFRenderer(this.preview.canvas, fps => this.preview.updateFps(fps))
        this.renderer
            .ready()
            .then(renderer => {
                const sceneSource = "return " + this.preview.textContent!.trim()
                renderer.build(sceneSource)
                requestAnimationFrame(time => renderer.update(time))
                this.reloadButton.onclick = () => renderer.build(sceneSource)
            })
            .catch(err => console.error(`UNEXPECTED ERROR: ${err}`))
    }
}

export default App
