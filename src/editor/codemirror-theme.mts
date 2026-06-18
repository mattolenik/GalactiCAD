/**
 * CodeMirror 6 theme + syntax-highlight definitions for GalactiCAD.
 *
 * Ports the two Monaco `IStandaloneThemeData` themes (see the former themes.mts):
 *   - editor chrome colors  → `EditorView.theme`
 *   - token colors          → `HighlightStyle` over @lezer/highlight tags
 *
 * Token mapping is approximate vs Monaco's TextMate scopes (full-fidelity tuning
 * is deferred to the "Formatting + theme polish" migration step); the dimmed
 * parentheses from the dark theme's `delimiter.parenthesis.ts` rule are preserved.
 */

import { EditorView } from "@codemirror/view"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { tags as t } from "@lezer/highlight"
import type { Extension } from "@codemirror/state"

const FONT_STACK = '"FiraCode", "Fira Code", ui-monospace, "SF Mono", Menlo, monospace'

/** Shared editor chrome styling that does not depend on light/dark. Font family + ligatures. */
const baseTheme = EditorView.theme({
    "&": {
        height: "100%",
        fontFamily: FONT_STACK,
        fontVariationSettings: "normal",
    },
    ".cm-scroller": {
        fontFamily: FONT_STACK,
        fontFeatureSettings: '"liga" 1, "calt" 1',
        lineHeight: "1.5",
    },
    ".cm-content": { fontVariantLigatures: "contextual" },
})

// ── Dark (ports GALACTICAD_DARK_THEME, base "vs-dark") ──────────────────────
const darkChrome = EditorView.theme(
    {
        "&": { color: "#d4d4d4", backgroundColor: "#1e1e1e" },
        ".cm-content": { caretColor: "#aeafad" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#aeafad" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
            backgroundColor: "#264f78",
        },
        ".cm-activeLine": { backgroundColor: "#3a3a3ecc" },
        ".cm-activeLineGutter": { backgroundColor: "#3a3a3ecc" },
        ".cm-gutters": { backgroundColor: "#1e1e1e", color: "#858585", border: "none" },
        ".cm-foldPlaceholder": { backgroundColor: "#3a3a3e", border: "none", color: "#888" },
    },
    { dark: true },
)

const darkHighlight = HighlightStyle.define([
    { tag: t.comment, color: "#6a9955" },
    { tag: [t.string, t.special(t.string)], color: "#ce9178" },
    { tag: [t.number, t.bool, t.null], color: "#b5cea8" },
    { tag: t.keyword, color: "#569cd6" },
    { tag: [t.operator, t.operatorKeyword], color: "#d4d4d4" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#dcdcaa" },
    { tag: [t.typeName, t.className, t.namespace], color: "#4ec9b0" },
    { tag: [t.variableName, t.propertyName], color: "#9cdcfe" },
    { tag: [t.definition(t.variableName)], color: "#9cdcfe" },
    { tag: t.constant(t.variableName), color: "#4fc1ff" },
    // Echoes the Monaco `delimiter.parenthesis.ts → #555555` rule.
    { tag: [t.paren, t.brace, t.squareBracket], color: "#555555" },
    { tag: t.invalid, color: "#f44747" },
])

// ── Light (ports GALACTICAD_LIGHT_THEME, base "vs") ─────────────────────────
const lightChrome = EditorView.theme(
    {
        "&": { color: "#000000", backgroundColor: "#F1F1F1" },
        ".cm-content": { caretColor: "#000000" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#000000" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
            backgroundColor: "#B0B0FF",
        },
        ".cm-activeLine": { backgroundColor: "#00000026" },
        ".cm-activeLineGutter": { backgroundColor: "#00000026" },
        ".cm-gutters": { backgroundColor: "#F1F1F1", color: "#999999", border: "none" },
        ".cm-foldPlaceholder": { backgroundColor: "#e0e0e0", border: "none", color: "#666" },
    },
    { dark: false },
)

const lightHighlight = HighlightStyle.define([
    { tag: t.comment, color: "#406040" },
    { tag: [t.string, t.special(t.string)], color: "#c03030" },
    { tag: [t.character], color: "#800000" },
    { tag: [t.number, t.bool, t.null], color: "#0080a0" },
    { tag: [t.keyword, t.operator, t.operatorKeyword], color: "#2060a0" },
    { tag: [t.namespace], color: "#0080ff" },
    { tag: [t.typeName, t.className], color: "#8000c0" },
    { tag: [t.definitionKeyword, t.modifier], color: "#a08000" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#800000" },
    { tag: t.invalid, color: "#c03030" },
])

// HighlightStyle must be wrapped with syntaxHighlighting() to take effect.
const darkHighlightExt = syntaxHighlighting(darkHighlight)
const lightHighlightExt = syntaxHighlighting(lightHighlight)

export type ThemeName = "dark" | "light"

/** Full theme extension (chrome + syntax highlighting) for the given mode. */
export function editorThemeExtension(name: ThemeName): Extension {
    return name === "dark"
        ? [baseTheme, darkChrome, darkHighlightExt]
        : [baseTheme, lightChrome, lightHighlightExt]
}
