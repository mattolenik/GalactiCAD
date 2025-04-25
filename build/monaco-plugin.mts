import path from "path"
import { build as esbuildBuild, Plugin } from "esbuild"
import { createRequire } from "module"
const require = createRequire(import.meta.url)

export interface MonacoEditorPluginOptions {
    /**
     * URL prefix for workers, e.g. "/editor"
     */
    urlPrefix?: string
}

// Define the default Monaco worker entry points using require.resolve.
const defaultWorkers: Record<string, string> = {
    "editor.worker": require.resolve("monaco-editor/esm/vs/editor/editor.worker"),
    "json.worker": require.resolve("monaco-editor/esm/vs/language/json/json.worker"),
    "css.worker": require.resolve("monaco-editor/esm/vs/language/css/css.worker"),
    "html.worker": require.resolve("monaco-editor/esm/vs/language/html/html.worker"),
    "ts.worker": require.resolve("monaco-editor/esm/vs/language/typescript/ts.worker"),
}

export function monacoEditorPlugin(options: MonacoEditorPluginOptions = {}): Plugin {
    const urlPrefix = options.urlPrefix ?? "/"
    // This object will map worker names to their output URLs.
    const workerFiles: Record<string, string> = {}

    return {
        name: "monaco-editor",
        async setup(build) {
            const outdir = build.initialOptions.outdir
            if (!outdir) {
                throw new Error("monacoEditorPlugin: build.outdir must be specified.")
            }

            // 1. Pre-build the Monaco worker files in parallel.
            await Promise.all(
                Object.entries(defaultWorkers).map(async ([workerName, entryPoint]) => {
                    const workerPath = path.join(urlPrefix, workerName + ".js")
                    const outfile = path.join(outdir, workerPath)
                    await esbuildBuild({
                        entryPoints: [entryPoint],
                        bundle: true,
                        minify: build.initialOptions.minify,
                        target: build.initialOptions.target,
                        outfile,
                        format: "esm",
                    })
                    // Record the emitted worker file URL.
                    workerFiles[workerName] = workerPath
                })
            )

            // 2. Inject a virtual module for Monaco's runtime environment.
            const virtualModuleId = "monaco-editor-env"
            const resolvedVirtualModuleId = "\0" + virtualModuleId

            build.onResolve({ filter: new RegExp(`^${virtualModuleId}$`) }, () => {
                return { path: resolvedVirtualModuleId, namespace: "monaco-env" }
            })

            build.onLoad({ filter: /.*/, namespace: "monaco-env" }, () => {
                const contents = `
                if (typeof self === 'undefined') {
                    throw new Error('Monaco Editor requires a browser environment.');
                }
                self.MonacoEnvironment = self.MonacoEnvironment ?? {};
                self.MonacoEnvironment.getWorkerUrl = function(moduleId, label) {
                    if (label === 'json') {
                        return '${workerFiles["json.worker"]}';
                    }
                    if (label === 'css' || label === 'scss' || label === 'less') {
                        return '${workerFiles["css.worker"]}';
                    }
                    if (label === 'html' || label === 'handlebars' || label === 'razor') {
                        return '${workerFiles["html.worker"]}';
                    }
                    if (label === 'typescript' || label === 'javascript') {
                        return '${workerFiles["ts.worker"]}';
                    }
                    return '${workerFiles["editor.worker"]}';
                };
                export default self.MonacoEnvironment;
                `
                return { contents, loader: "ts" }
            })
        },
    }
}

export default monacoEditorPlugin
