/**
 * Selection styling constants for outline, face shading, and edge highlight.
 * Centralized for future theming support.
 */

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

export type SelectionStyles = typeof DEFAULT_SELECTION_STYLES
