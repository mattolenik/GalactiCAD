/**
 * CodeMirror 6 editor wrapper for GalactiCAD — the single `EditorView` that
 * replaces Monaco's `IStandaloneCodeEditor`.
 *
 * Multi-document model: there is exactly ONE `EditorView`. Each open tab owns an
 * immutable `EditorState` (created via {@link CodeEditor.createState}); switching
 * tabs swaps it in with {@link CodeEditor.setState}. This mirrors Monaco's
 * one-editor / many-`ITextModel` arrangement, but document ownership stays in
 * `DocumentTabs`.
 *
 * Reconfigurable editor options (line numbers, wrap, whitespace, folding, tab
 * size, font size, theme) live in {@link Compartment}s. Because each state is
 * created with the current option values AND {@link CodeEditor.setState}
 * re-applies them on every swap, options stay consistent across tabs regardless
 * of when a tab was opened.
 *
 * Forward hooks for later migration steps: a `language` compartment (so the TS
 * language service can extend the base JS/TS support) and a `decorations`
 * compartment (for the ported shape/selection decorations).
 */

import {
    Compartment,
    EditorSelection,
    EditorState,
    type Extension,
} from "@codemirror/state"
import {
    crosshairCursor,
    drawSelection,
    dropCursor,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    highlightWhitespace,
    keymap,
    lineNumbers,
    rectangularSelection,
    type ViewUpdate,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands"
import {
    bracketMatching,
    codeFolding,
    foldGutter,
    foldKeymap,
    indentOnInput,
    indentUnit,
} from "@codemirror/language"
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete"
import { searchKeymap } from "@codemirror/search"
import { lintKeymap } from "@codemirror/lint"
import { javascript } from "@codemirror/lang-javascript"
import type { EditorSettings } from "../storage/settings.mjs"
import { editorThemeExtension, type ThemeName } from "./codemirror-theme.mjs"

/** 1-based line/column position (matches Monaco + SettingsManager conventions). */
export interface LineCol {
    line: number
    column: number
}

/** 1-based selection range, ordered start ≤ end (matches SettingsManager). */
export interface LineColSelection {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
}

// ── Option → extension builders ─────────────────────────────────────────────
// "relative" line numbers are mapped to "on" for now (CM6 needs a custom
// formatter; tracked for the theme-polish step).
const lineNumbersExt = (mode: EditorSettings["lineNumbers"]): Extension =>
    mode === "off" ? [] : lineNumbers()
const wrapExt = (w: EditorSettings["wordWrap"]): Extension => (w === "on" ? EditorView.lineWrapping : [])
const whitespaceExt = (mode: EditorSettings["renderWhitespace"]): Extension =>
    mode === "none" ? [] : highlightWhitespace()
const foldExt = (on: boolean): Extension => (on ? [codeFolding(), foldGutter()] : [])
const tabExt = (n: number): Extension => [EditorState.tabSize.of(n), indentUnit.of(" ".repeat(n))]
const fontExt = (px: number): Extension => EditorView.theme({ "&": { fontSize: `${px}px` } })

export class CodeEditor {
    readonly view: EditorView

    // Reconfigurable option compartments.
    #cLineNumbers = new Compartment()
    #cWrap = new Compartment()
    #cWhitespace = new Compartment()
    #cFold = new Compartment()
    #cTab = new Compartment()
    #cFont = new Compartment()
    #cTheme = new Compartment()
    // Forward hooks for later migration steps.
    #cLanguage = new Compartment()
    #cDecorations = new Compartment()

    /** Current language-service extension (TS service); reapplied on every setState. */
    #languageServiceExt: Extension = []

    /** Current option values, used so newly-created and swapped-in states match. */
    #opts: EditorSettings
    #theme: ThemeName
    /** Narrow-screen override forcing line numbers off regardless of #opts. */
    #lineNumbersForcedOff = false

    #updateListeners = new Set<(u: ViewUpdate) => void>()

    constructor(parent: HTMLElement, opts: EditorSettings, theme: ThemeName) {
        this.#opts = { ...opts }
        this.#theme = theme
        this.view = new EditorView({
            parent,
            state: this.createState(""),
        })
    }

    /** The base extension set shared by every document state. */
    #baseExtensions(): Extension {
        return [
            // Compartmented options (current values; re-applied on setState).
            this.#cLineNumbers.of(lineNumbersExt(this.#effectiveLineNumbers())),
            this.#cWrap.of(wrapExt(this.#opts.wordWrap)),
            this.#cWhitespace.of(whitespaceExt(this.#opts.renderWhitespace)),
            this.#cFold.of(foldExt(this.#opts.folding)),
            this.#cTab.of(tabExt(this.#opts.tabSize)),
            this.#cFont.of(fontExt(this.#opts.fontSize)),
            this.#cTheme.of(editorThemeExtension(this.#theme)),
            // Always-on TS/JS grammar (Lezer highlighting, indent, brackets). The
            // language-service compartment layers completion/hover/lint on top.
            javascript({ typescript: true }),
            this.#cLanguage.of(this.#languageServiceExt),
            this.#cDecorations.of([]),

            // Core editing behavior.
            history(),
            highlightActiveLine(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            drawSelection(),
            dropCursor(),
            rectangularSelection(),
            crosshairCursor(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            autocompletion(),
            EditorState.allowMultipleSelections.of(true),
            EditorView.updateListener.of(u => {
                for (const l of this.#updateListeners) l(u)
            }),
            keymap.of([
                indentWithTab,
                ...closeBracketsKeymap,
                ...defaultKeymap,
                ...searchKeymap,
                ...historyKeymap,
                ...foldKeymap,
                ...completionKeymap,
                ...lintKeymap,
            ]),
        ]
    }

    #effectiveLineNumbers(): EditorSettings["lineNumbers"] {
        return this.#lineNumbersForcedOff ? "off" : this.#opts.lineNumbers
    }

    /** Effects that reconfigure all option compartments to the current values. */
    #optionEffects() {
        return [
            this.#cLineNumbers.reconfigure(lineNumbersExt(this.#effectiveLineNumbers())),
            this.#cWrap.reconfigure(wrapExt(this.#opts.wordWrap)),
            this.#cWhitespace.reconfigure(whitespaceExt(this.#opts.renderWhitespace)),
            this.#cFold.reconfigure(foldExt(this.#opts.folding)),
            this.#cTab.reconfigure(tabExt(this.#opts.tabSize)),
            this.#cFont.reconfigure(fontExt(this.#opts.fontSize)),
            this.#cTheme.reconfigure(editorThemeExtension(this.#theme)),
            this.#cLanguage.reconfigure(this.#languageServiceExt),
        ]
    }

    // ── Document state lifecycle ────────────────────────────────────────────

    /** Build a fresh per-document state with the full shared extension set. */
    createState(content: string): EditorState {
        return EditorState.create({ doc: content, extensions: this.#baseExtensions() })
    }

    /** Swap the active document state in, re-applying current options/theme. */
    setState(state: EditorState): void {
        this.view.setState(state)
        this.view.dispatch({ effects: this.#optionEffects() })
    }

    /** Clear the editor to an empty document (last tab closed). */
    clear(): void {
        this.setState(this.createState(""))
    }

    /** Current active document text. */
    getValue(): string {
        return this.view.state.doc.toString()
    }

    /** Replace the entire active document (revert / external reload). */
    setValue(content: string): void {
        this.view.dispatch({
            changes: { from: 0, to: this.view.state.doc.length, insert: content },
        })
    }

    // ── Options / theme ─────────────────────────────────────────────────────

    /** Apply a (partial) settings update to the live editor and future states. */
    setOptions(opts: Partial<EditorSettings>): void {
        this.#opts = { ...this.#opts, ...opts }
        this.view.dispatch({ effects: this.#optionEffects() })
    }

    /** Narrow-screen override: force line numbers off without touching settings. */
    setLineNumbersForcedOff(forced: boolean): void {
        if (this.#lineNumbersForcedOff === forced) return
        this.#lineNumbersForcedOff = forced
        this.view.dispatch({
            effects: this.#cLineNumbers.reconfigure(lineNumbersExt(this.#effectiveLineNumbers())),
        })
    }

    setTheme(theme: ThemeName): void {
        if (this.#theme === theme) return
        this.#theme = theme
        this.view.dispatch({ effects: this.#cTheme.reconfigure(editorThemeExtension(theme)) })
    }

    // ── Forward hooks (filled in by later migration steps) ──────────────────

    /** Replace the language-service extension (completion/hover/lint). Persists
     *  across tab swaps because setState re-applies it via #optionEffects. */
    setLanguageExtension(ext: Extension): void {
        this.#languageServiceExt = ext
        this.view.dispatch({ effects: this.#cLanguage.reconfigure(ext) })
    }

    /** Replace the decorations extension (decorations step). */
    setDecorationsExtension(ext: Extension): void {
        this.view.dispatch({ effects: this.#cDecorations.reconfigure(ext) })
    }

    // ── Selection / position helpers (1-based line/col) ─────────────────────

    #lineColToOffset(line: number, column: number): number {
        const doc = this.view.state.doc
        const ln = Math.min(Math.max(1, line), doc.lines)
        const l = doc.line(ln)
        return l.from + Math.min(Math.max(0, column - 1), l.length)
    }

    #offsetToLineCol(offset: number): LineCol {
        const l = this.view.state.doc.lineAt(offset)
        return { line: l.number, column: offset - l.from + 1 }
    }

    /** Current cursor (head) as a 1-based line/column. */
    getCursor(): LineCol | null {
        return this.getSelectionLineCol()?.pos ?? null
    }

    /** Current cursor (head) and ordered selection range, or null if no document. */
    getSelectionLineCol(): { pos: LineCol; sel: LineColSelection } | null {
        const r = this.view.state.selection.main
        const head = this.#offsetToLineCol(r.head)
        const from = this.#offsetToLineCol(r.from)
        const to = this.#offsetToLineCol(r.to)
        return {
            pos: head,
            sel: { startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column },
        }
    }

    /** Restore an ordered selection range, clamped to the current document. */
    setSelectionLineCol(sel: LineColSelection): void {
        const from = this.#lineColToOffset(sel.startLine, sel.startColumn)
        const to = this.#lineColToOffset(sel.endLine, sel.endColumn)
        this.view.dispatch({ selection: EditorSelection.range(from, to) })
    }

    /** Scroll a line to the vertical center, but only if it is outside the viewport. */
    revealLineCenterIfOutside(line: number): void {
        const doc = this.view.state.doc
        const ln = Math.min(Math.max(1, line), doc.lines)
        const offset = doc.line(ln).from
        const { from, to } = this.view.viewport
        if (offset >= from && offset <= to) return
        this.view.dispatch({ effects: EditorView.scrollIntoView(offset, { y: "center" }) })
    }

    // ── Misc ────────────────────────────────────────────────────────────────

    /** Register an update listener (content + selection changes). Returns an unsubscribe. */
    onUpdate(cb: (u: ViewUpdate) => void): () => void {
        this.#updateListeners.add(cb)
        return () => this.#updateListeners.delete(cb)
    }

    focus(): void {
        this.view.focus()
    }

    /** Monaco-compat no-op: CodeMirror reflows to its container automatically. */
    layout(): void {
        this.view.requestMeasure()
    }

    undo(): void {
        undo(this.view)
    }

    redo(): void {
        redo(this.view)
    }

    /** The editor's root DOM node (for attaching custom listeners / context menus). */
    get dom(): HTMLElement {
        return this.view.dom
    }

    destroy(): void {
        this.view.destroy()
    }
}
