/**
 * Selection styling constants for outline, face shading, and edge highlight.
 * Theme-aware: dark theme uses light colors on dark preview bg; light theme uses dark colors on light bg.
 */

import type { EffectiveTheme } from "./style/theme.mjs"

export const DEFAULT_SELECTION_STYLES = {
    outline: {
        mode: "solid" as const,
        thickness: 3,
        color: [0.9, 0.9, 0.9] as [number, number, number],
        dashSpacing: 10,
        dashLength: 5,
        dotSizeMin: 2,
        dotSpacingMultiplier: 3,
    },
    face: {
        darken: 0.9,
        tint: [0.15, 0.15, 0.15] as [number, number, number],
        dotSpacing: 8,
        dotRadius: 1.5,
        dotDarken: 0.5,
    },
    edge: {
        color: [1, 1, 0] as [number, number, number],
        selectedStrength: 0.8,
        hoverStrength: 0.4,
        lineWidthPx: 4,
        seamLineWidthPx: 6,
        epsilon: 0.02,
    },
} as const

/** Theme-variant selection styles. Uses number for theme-dependent fields (outline color, face darken/tint, edge color). */
export interface SelectionStyles {
    readonly outline: Omit<typeof DEFAULT_SELECTION_STYLES.outline, "color"> & { color: [number, number, number] }
    readonly face: Omit<typeof DEFAULT_SELECTION_STYLES.face, "darken" | "tint"> & { darken: number; tint: [number, number, number] }
    readonly edge: Omit<typeof DEFAULT_SELECTION_STYLES.edge, "color"> & { color: [number, number, number] }
}

/** Selection styles for light theme (preview bg #e8e8e8). Dark theme uses DEFAULT_SELECTION_STYLES. */
const SELECTION_STYLES_LIGHT: SelectionStyles = {
    ...DEFAULT_SELECTION_STYLES,
    outline: { ...DEFAULT_SELECTION_STYLES.outline, color: [0.25, 0.25, 0.25] },
    face: {
        ...DEFAULT_SELECTION_STYLES.face,
        darken: 0.85,
        tint: [0.08, 0.08, 0.08],
    },
    edge: { ...DEFAULT_SELECTION_STYLES.edge, color: [0.7, 0.55, 0.1] },
}

/** Theme-aware selection styles for the preview window. */
export function getSelectionStylesForTheme(theme: EffectiveTheme): SelectionStyles {
    return theme === "light" ? SELECTION_STYLES_LIGHT : DEFAULT_SELECTION_STYLES
}
