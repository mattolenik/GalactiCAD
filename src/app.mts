import * as monaco from "monaco-editor"
import "monaco-editor-env" // used at runtime, do not remove
import { PreviewWindow } from "./preview-window.mjs"
import { SDFRenderer } from "./sdf.mjs"

class App {
    preview: PreviewWindow
    editor: monaco.editor.IStandaloneCodeEditor
    renderer: SDFRenderer

    constructor(previewWindowID: string, editorContainerID: string) {
        this.preview = document.getElementById(previewWindowID) as PreviewWindow

        this.editor = monaco.editor.create(document.getElementById(editorContainerID) as HTMLDivElement, {
            value: sample,
            language: "javascript",
            automaticLayout: true,
            theme: "vs-dark",
            minimap: { enabled: false },
        })
        this.editor.onDidChangeModelContent(ev => {
            const sceneSource = this.editor.getValue().trim()
            this.renderer.build(sceneSource)
        })

        this.renderer = new SDFRenderer(this.preview.canvas, fps => this.preview.updateFps(fps))
        this.renderer
            .ready()
            .then(renderer => {
                const sceneSource = this.editor.getValue().trim()
                renderer.build(sceneSource)
                requestAnimationFrame(time => renderer.update(time))
            })
            .catch(err => console.error(`UNEXPECTED ERROR: ${err}`))
    }
}

export default App

const sample = `
return group(
    union(1,
            box( [1,-4,4], [30,5,3] ),
            box( [1, 7,4], [30,5,3] ),
            subtract(box( [0,0,0], [10,20,8] ), sphere( [0,0,-10], {r:6} ), box([0,5,30], [5,2,40])),
    )
)
`
