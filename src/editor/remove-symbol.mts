/**
 * "Remove symbol" — compute the text edits that surgically delete a gcad DSL
 * construct at a click position, keeping surrounding code intact.
 *
 * This is the pure core behind the editor's right-click → Remove item. Given the
 * current (unwrapped) source and a user-source character offset, it walks the TS
 * AST to the clicked identifier, classifies it, and returns the edits to apply.
 * It never touches the DOM/EditorView, so it is trivially unit-testable.
 *
 * Removal semantics (see the feature plan for the full table):
 *   - leaf primitive head / required first method  → remove the WHOLE expression
 *     (the outermost fluent chain), leaving `let s = ` dangling if it was an
 *     initializer; eliding it from a list if it was an argument.
 *   - n-ary operator / rendering composite head    → same (remove whole call).
 *   - functional unary modifier `rotate(ang, x)`   → unwrap to its last (geometry)
 *     argument's text.
 *   - optional fluent modifier `foo.shift(x)`       → strip just that `.method(...)`.
 *   - variable declaration name                     → remove `let obj = …` and
 *     elide every reference to `obj`.
 *   - variable reference occurrence                 → elide just that occurrence.
 *
 * Where a symbol is used in a custom / non-DSL way, we delete the symbol text and
 * let surrounding code break rather than guessing at a "smart" rewrite.
 */

import * as ts from "typescript"
import { EditorSelection } from "@codemirror/state"
import { parseUserSource, WRAP_PREFIX, WRAP_PREFIX_CHARS, WRAP_SUFFIX } from "../parser/source-parser.mjs"
import {
    COMPOSITE_FUNCTIONS,
    FLUENT_MODIFIER_METHODS,
    MODIFIER_NAMES,
    NAMESPACE_CONSTRUCTOR_FUNCTIONS,
    PRIMITIVE_FUNCTIONS,
} from "../parser/shape-classification.mjs"
import type { CodeEditor } from "./codemirror-editor.mjs"

/** A text edit in USER-source character offsets (into the unwrapped document). */
export interface TextEdit {
    from: number
    to: number
    insert: string
}

export interface RemoveOptions {
    /**
     * A pre-parsed wrapped SourceFile for `src` (e.g. from
     * `SourceParser.getCachedSourceFile(src)`) to avoid a re-parse. Must correspond
     * to `src`; when omitted or null, `src` is parsed fresh.
     */
    sourceFile?: ts.SourceFile | null
    /** Live fluent-method registry (`styleInfo.FluentMethods`) to augment the static whitelist. */
    fluentMethods?: ReadonlySet<string>
}

const W = WRAP_PREFIX_CHARS

/**
 * Compute the edits that remove the DSL symbol at `offset` (a 0-based user-source
 * char offset), or `null` when there is no removable construct there.
 */
export function computeRemoveEdits(src: string, offset: number, opts?: RemoveOptions): TextEdit[] | null {
    const sf = matchingSourceFile(opts?.sourceFile, src) ?? parseUserSource(src)
    const id = findIdentifierAt(sf, offset + W)
    if (!id) return null

    const ctx: Ctx = { sf, src, declaredVars: collectDeclaredVarNames(sf), fluentMethods: opts?.fluentMethods }
    const target = resolveTarget(id, ctx)
    if (!target) return null

    switch (target.kind) {
        case "whole":
            return removeWholeExpression(target.headCall, ctx)
        case "unwrap":
            return unwrapModifier(target.call, ctx)
        case "fluent-strip":
            return [wrapEdit(target.recv.getEnd(), target.thisCall.getEnd(), "")]
        case "var-ref":
            return [elementEdit(target.id, ctx)]
        case "var-decl":
            return removeVariableDeclaration(target.decl, target.nameId, ctx)
    }
}

/** Whether a removable DSL symbol sits at `offset` (drives whether the menu item appears). */
export function canRemoveAt(src: string, offset: number, opts?: RemoveOptions): boolean {
    return computeRemoveEdits(src, offset, opts) !== null
}

// ---------------------------------------------------------------------------
// Editor adapter
// ---------------------------------------------------------------------------

/**
 * Compute + dispatch the removal at `offset` into the editor. Returns true if an
 * edit was applied. Mirrors the dispatch pattern in insert-shape.mts.
 */
export function removeSymbolAt(editor: CodeEditor, offset: number, opts?: RemoveOptions): boolean {
    return removeSymbolsAt(editor, [offset], opts)
}

/**
 * Compute + dispatch the removal of the symbols at each of `offsets` in ONE
 * transaction. All edits are computed against the original document, then
 * overlapping ranges are merged so CodeMirror receives a non-overlapping set.
 * Used to delete one or more objects selected in the SDF preview. Returns true
 * if anything was removed.
 */
export function removeSymbolsAt(editor: CodeEditor, offsets: number[], opts?: RemoveOptions): boolean {
    const view = editor.view
    const src = view.state.doc.toString()
    const all: TextEdit[] = []
    for (const offset of offsets) {
        const edits = computeRemoveEdits(src, offset, opts)
        if (edits) all.push(...edits)
    }
    if (all.length === 0) return false
    const merged = mergeEdits(all)
    view.dispatch({
        changes: merged,
        selection: EditorSelection.cursor(merged[0].from),
    })
    editor.focus()
    return true
}

/** Sort edits and merge any overlapping ranges (deletions dominate; inserts concatenate). */
export function mergeEdits(edits: TextEdit[]): TextEdit[] {
    const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to)
    const out: TextEdit[] = []
    for (const e of sorted) {
        const last = out[out.length - 1]
        if (last && e.from < last.to) {
            last.to = Math.max(last.to, e.to)
            last.insert += e.insert
        } else {
            out.push({ ...e })
        }
    }
    return out
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

interface Ctx {
    sf: ts.SourceFile
    src: string
    declaredVars: Set<string>
    fluentMethods?: ReadonlySet<string>
}

type Target =
    | { kind: "whole"; headCall: ts.CallExpression }
    | { kind: "unwrap"; call: ts.CallExpression }
    | { kind: "fluent-strip"; recv: ts.Expression; thisCall: ts.CallExpression }
    | { kind: "var-ref"; id: ts.Identifier }
    | { kind: "var-decl"; decl: ts.VariableDeclaration; nameId: ts.Identifier }

function resolveTarget(id: ts.Identifier, ctx: Ctx): Target | null {
    const p = id.parent
    const name = id.text

    // (1) Call head: NAME(...)
    if (ts.isCallExpression(p) && p.expression === id) {
        if (PRIMITIVE_FUNCTIONS.has(name) || COMPOSITE_FUNCTIONS.has(name)) {
            return { kind: "whole", headCall: p }
        }
        if (MODIFIER_NAMES.has(name)) return { kind: "unwrap", call: p }
        return null // unknown / custom function head
    }

    // (2) Method or property name: recv.NAME
    if (ts.isPropertyAccessExpression(p) && p.name === id) {
        if (!(ts.isCallExpression(p.parent) && p.parent.expression === p)) {
            return null // a plain property read, not a called DSL method
        }
        const thisCall = p.parent
        const recv = p.expression
        // Required constructor method: receiver is a bare namespace-constructor object
        // (`sphere.radius(…)`, `extrude.profile(…)`, …).
        if (ts.isIdentifier(recv) && NAMESPACE_CONSTRUCTOR_FUNCTIONS.has(recv.text)) {
            return { kind: "whole", headCall: thisCall }
        }
        // Otherwise an optional fluent modifier — only if we recognize the method.
        if (isRecognizedMethod(name, ctx)) return { kind: "fluent-strip", recv, thisCall }
        return null
    }

    // (3) Receiver identifier: NAME.something
    if (ts.isPropertyAccessExpression(p) && p.expression === id) {
        if (NAMESPACE_CONSTRUCTOR_FUNCTIONS.has(name)) {
            const outerCall = ts.isCallExpression(p.parent) && p.parent.expression === p ? p.parent : null
            return outerCall ? { kind: "whole", headCall: outerCall } : null
        }
        if (ctx.declaredVars.has(name)) return { kind: "var-ref", id }
        return null
    }

    // (4) Variable declaration name: let NAME = …
    if (ts.isVariableDeclaration(p) && p.name === id) {
        return { kind: "var-decl", decl: p, nameId: id }
    }

    // (5) Bare identifier reference elsewhere (argument, array element, initializer…)
    if (ctx.declaredVars.has(name)) return { kind: "var-ref", id }

    return null
}

function isRecognizedMethod(name: string, ctx: Ctx): boolean {
    return FLUENT_MODIFIER_METHODS.has(name) || MODIFIER_NAMES.has(name) || (ctx.fluentMethods?.has(name) ?? false)
}

// ---------------------------------------------------------------------------
// Edit builders (whole-expression, unwrap, list elision)
// ---------------------------------------------------------------------------

/** Remove the outermost fluent chain that `headCall` heads (eliding from a list if applicable). */
function removeWholeExpression(headCall: ts.CallExpression, ctx: Ctx): TextEdit[] {
    const outer = climbFluentChain(headCall, ctx)
    return [elementEdit(outer, ctx)]
}

/** Replace a functional unary modifier call with the source text of its last (geometry) argument. */
function unwrapModifier(call: ts.CallExpression, ctx: Ctx): TextEdit[] {
    if (call.arguments.length === 0) return removeWholeExpression(call, ctx)
    const lastArg = call.arguments[call.arguments.length - 1]
    const childText = ctx.src.slice(lastArg.getStart(ctx.sf) - W, lastArg.getEnd() - W)
    return [wrapEdit(call.getStart(ctx.sf), call.getEnd(), childText)]
}

/**
 * Ascend from `node` while it is the callee receiver of a chained method call,
 * so `sphere.radius(2).shift(x)` climbs from the `.radius(2)` call up to the whole
 * chain. Stops automatically at any statement/assignment/argument boundary.
 */
function climbFluentChain(node: ts.Node, _ctx: Ctx): ts.Node {
    let cur: ts.Node = node
    while (
        ts.isPropertyAccessExpression(cur.parent) &&
        cur.parent.expression === cur &&
        ts.isCallExpression(cur.parent.parent) &&
        cur.parent.parent.expression === cur.parent
    ) {
        cur = cur.parent.parent
    }
    return cur
}

/**
 * Edit that deletes `node`. If `node` is a direct element of a call-argument list
 * or array literal, one adjacent comma is consumed to keep the list well-formed;
 * otherwise the node's own range is deleted (leaving surrounding text to break).
 */
function elementEdit(node: ts.Node, ctx: Ctx): TextEdit {
    const arr = elementListOf(node)
    if (arr) return wrapEditRange(elisionRange(node, arr, ctx.sf))
    return wrapEdit(node.getStart(ctx.sf), node.getEnd(), "")
}

/** The argument/element NodeArray that `node` is a direct member of, or null. */
function elementListOf(node: ts.Node): ts.NodeArray<ts.Node> | null {
    const p = node.parent
    if (ts.isCallExpression(p) && p.arguments.indexOf(node as ts.Expression) >= 0) return p.arguments
    if (ts.isArrayLiteralExpression(p) && p.elements.indexOf(node as ts.Expression) >= 0) return p.elements
    return null
}

/** Wrapped-offset range removing `node` from its list, consuming one adjacent comma. */
function elisionRange(node: ts.Node, arr: ts.NodeArray<ts.Node>, sf: ts.SourceFile): { from: number; to: number } {
    const start = node.getStart(sf)
    const end = node.getEnd()
    const i = arr.indexOf(node)
    if (arr.length <= 1) return { from: start, to: end }
    if (i < arr.length - 1) return { from: start, to: arr[i + 1].getStart(sf) } // consume trailing comma + ws
    return { from: arr[i - 1].getEnd(), to: end } // last element: consume preceding comma
}

// ---------------------------------------------------------------------------
// Variable declaration removal + reference cascade
// ---------------------------------------------------------------------------

/**
 * Remove a `let NAME = …` declaration and elide every reference to NAME.
 * With no real lexical scope analysis (name matching is global), a same-named
 * binding in another scope would also have its references elided — acceptable
 * under the "let it break / one undo fixes it" philosophy; other declaration
 * *names* are protected from deletion, so only their references are at risk.
 */
function removeVariableDeclaration(decl: ts.VariableDeclaration, nameId: ts.Identifier, ctx: Ctx): TextEdit[] {
    const { sf } = ctx
    const edits: TextEdit[] = []

    // 1) Remove the declarator (or the whole statement if it is the only declarator).
    const list = decl.parent
    if (ts.isVariableDeclarationList(list) && list.declarations.length > 1) {
        edits.push(wrapEditRange(elisionRange(decl, list.declarations, sf)))
    } else {
        const stmt = ts.isVariableDeclarationList(list) ? list.parent : decl
        const range = expandToFullLine(sf, stmt.getStart(sf), stmt.getEnd())
        edits.push(wrapEditRange(range))
    }

    // 2) Elide every reference to the name, skipping the declarator being removed.
    const name = nameId.text
    const declStart = decl.getStart(sf)
    const declEnd = decl.getEnd()
    forEachIdentifier(sf, ref => {
        if (ref.text !== name) return
        if (ref.getStart(sf) >= declStart && ref.getEnd() <= declEnd) return // inside removed declarator
        if (!isReferenceUse(ref)) return
        edits.push(elementEdit(ref, ctx))
    })

    return edits.sort((a, b) => a.from - b.from)
}

/**
 * Whether `id` is a value *reference* to a binding (as opposed to a member name,
 * object-literal key, or a binding/declaration name — which must not be deleted).
 */
function isReferenceUse(id: ts.Identifier): boolean {
    const p = id.parent
    // `foo.NAME` — member access name (but keep `NAME.foo` receivers).
    if (ts.isPropertyAccessExpression(p) && p.name === id) return false
    // `{ NAME: … }` and shorthand `{ NAME }` keys.
    if (ts.isPropertyAssignment(p) && p.name === id) return false
    if (ts.isShorthandPropertyAssignment(p) && p.name === id) return false
    // Declaration / binding names.
    if (ts.isVariableDeclaration(p) && p.name === id) return false
    if (ts.isParameter(p) && p.name === id) return false
    if (ts.isBindingElement(p) && p.name === id) return false
    if (ts.isFunctionDeclaration(p) && p.name === id) return false
    return true
}

// ---------------------------------------------------------------------------
// AST / text helpers
// ---------------------------------------------------------------------------

/** Innermost identifier whose span contains `tsOffset` (wrapped-space offset), or null. */
function findIdentifierAt(sf: ts.SourceFile, tsOffset: number): ts.Identifier | null {
    let found: ts.Node | null = null
    const visit = (node: ts.Node): void => {
        const start = node.getStart(sf)
        const end = node.getEnd()
        if (tsOffset < start || tsOffset > end) return
        found = node
        node.forEachChild(visit)
    }
    sf.forEachChild(visit)
    return found && ts.isIdentifier(found) ? found : null
}

/** Names bound by any `let/const/var` declaration in the file. */
function collectDeclaredVarNames(sf: ts.SourceFile): Set<string> {
    const names = new Set<string>()
    const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) names.add(node.name.text)
        node.forEachChild(visit)
    }
    sf.forEachChild(visit)
    return names
}

function forEachIdentifier(sf: ts.SourceFile, fn: (id: ts.Identifier) => void): void {
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) fn(node)
        node.forEachChild(visit)
    }
    sf.forEachChild(visit)
}

/**
 * Expand a wrapped-space range to swallow the whole line: leading same-line
 * indentation and one trailing newline, so removing a statement leaves no blank line.
 */
function expandToFullLine(sf: ts.SourceFile, from: number, to: number): { from: number; to: number } {
    const text = sf.text
    let f = from
    while (f > 0 && (text[f - 1] === " " || text[f - 1] === "\t")) f--
    let t = to
    while (t < text.length && (text[t] === " " || text[t] === "\t")) t++
    if (text[t] === "\r") t++
    if (text[t] === "\n") t++
    return { from: f, to: t }
}

/** Return `sf` only if it is the wrapped parse of `src` (else null → re-parse). */
function matchingSourceFile(sf: ts.SourceFile | null | undefined, src: string): ts.SourceFile | null {
    if (!sf) return null
    return sf.getFullText() === WRAP_PREFIX + src + WRAP_SUFFIX ? sf : null
}

/** Build a user-offset TextEdit from wrapped-space endpoints. */
function wrapEdit(wrappedFrom: number, wrappedTo: number, insert: string): TextEdit {
    return { from: wrappedFrom - W, to: wrappedTo - W, insert }
}

function wrapEditRange(range: { from: number; to: number }, insert = ""): TextEdit {
    return wrapEdit(range.from, range.to, insert)
}
