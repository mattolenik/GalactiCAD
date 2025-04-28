import * as monaco from "monaco-editor"
import "monaco-editor-env" // used at runtime, do not remove
import { PreviewWindow } from "./preview-window.mjs"
import { SDFRenderer } from "./sdf.mjs"
import { fromEventPattern, bufferTime, filter } from "rxjs"

class App {
    preview: PreviewWindow
    editor: monaco.editor.IStandaloneCodeEditor
    renderer: SDFRenderer
    log: HTMLDivElement

    constructor(previewWindowID: string, editorContainerID: string, logID: string) {
        this.preview = document.getElementById(previewWindowID) as PreviewWindow
        this.log = document.getElementById(logID) as HTMLDivElement

        this.editor = monaco.editor.create(document.getElementById(editorContainerID) as HTMLDivElement, {
            value: sample,
            language: "javascript",
            automaticLayout: true,
            theme: "vs-dark",
            minimap: { enabled: false },
        })

        this.renderer = new SDFRenderer(this.preview.canvas, fps => this.preview.updateFps(fps))
        this.renderer
            .ready()
            .then(renderer => {
                const sceneSource = this.editor.getValue().trim()
                this.renderer.build(sceneSource)
                renderer.startLoop()
            })
            .catch(err => console.error(`UNEXPECTED ERROR: ${err}`))

        const change$ = fromEventPattern<monaco.editor.IModelContentChangedEvent>(
            h => this.editor.onDidChangeModelContent(h),
            (_, disp) => disp.dispose()
        )

        change$
            .pipe(
                bufferTime(100),
                filter(arr => arr.length > 0)
            )
            .subscribe(events => {
                try {
                    this.renderer.build(this.editor.getValue())
                    this.log.innerText = ""
                } catch (err) {
                    this.log.innerText = `${err}`
                }
                // events is an array of all change events in the last 100ms
                console.log(`Batched ${events.length} changes`)
            })
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
