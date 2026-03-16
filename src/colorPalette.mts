/**
 * Color palette for SDF shape coloring.
 * Contains 32 pastel colors that are automatically assigned to shapes by ID.
 * Colors are accessed via: palette[shapeId % PALETTE_SIZE]
 */

import { Vec3f, vec3 } from "./vecmat/vector.mjs"

export const PALETTE_SIZE = 32

export type ShapePaletteTheme = "light" | "dark"

/**
 * Dark palette: 32 pastel colors for dark backgrounds.
 */
export const SHAPE_PALETTE_DARK: Vec3f[] = [
    // Row 1: Soft warm colors
    vec3(1.0, 0.7, 0.7),   // 0: Light coral
    vec3(1.0, 0.75, 0.6),  // 1: Peach
    vec3(1.0, 0.85, 0.6),  // 2: Light yellow
    vec3(0.95, 0.9, 0.6),  // 3: Cream yellow

    // Row 2: Soft greens
    vec3(0.8, 0.95, 0.65), // 4: Light lime
    vec3(0.65, 0.9, 0.65), // 5: Soft green
    vec3(0.6, 0.85, 0.75), // 6: Mint
    vec3(0.65, 0.9, 0.85), // 7: Aqua mint

    // Row 3: Soft blues
    vec3(0.65, 0.8, 0.95), // 8: Light sky blue
    vec3(0.7, 0.75, 0.95), // 9: Periwinkle
    vec3(0.75, 0.7, 0.9),  // 10: Light lavender
    vec3(0.85, 0.75, 0.9), // 11: Soft purple

    // Row 4: Soft pinks and roses
    vec3(0.95, 0.75, 0.85), // 12: Light pink
    vec3(0.95, 0.7, 0.75),  // 13: Salmon pink
    vec3(0.9, 0.65, 0.7),   // 14: Dusty rose
    vec3(0.85, 0.7, 0.75),  // 15: Muted rose

    // Row 5: Pastel oranges and peaches
    vec3(1.0, 0.8, 0.65),   // 16: Apricot
    vec3(0.95, 0.8, 0.7),   // 17: Light peach
    vec3(1.0, 0.75, 0.5),   // 18: Soft orange
    vec3(0.95, 0.7, 0.55),  // 19: Light tangerine

    // Row 6: Teals and seafoam
    vec3(0.6, 0.85, 0.8),   // 20: Seafoam
    vec3(0.55, 0.8, 0.75),  // 21: Light teal
    vec3(0.6, 0.8, 0.85),   // 22: Pale cyan
    vec3(0.65, 0.85, 0.9),  // 23: Ice blue

    // Row 7: Purples and violets
    vec3(0.8, 0.75, 0.9),   // 24: Lilac
    vec3(0.85, 0.7, 0.85),  // 25: Soft violet
    vec3(0.75, 0.7, 0.85),  // 26: Pale violet
    vec3(0.8, 0.75, 0.95),  // 27: Soft periwinkle

    // Row 8: Grays and neutrals (for variety)
    vec3(0.9, 0.9, 0.9),    // 28: Light gray
    vec3(0.85, 0.85, 0.9),  // 29: Cool gray
    vec3(0.9, 0.85, 0.85),  // 30: Warm gray
    vec3(0.92, 0.88, 0.82), // 31: Beige
]

/**
 * Light palette: 32 darker, more saturated colors for light backgrounds.
 */
export const SHAPE_PALETTE_LIGHT: Vec3f[] = [
    vec3(0.9, 0.35, 0.35),   // 0: Coral
    vec3(0.85, 0.45, 0.25),  // 1: Terracotta
    vec3(0.75, 0.55, 0.2),   // 2: Amber
    vec3(0.6, 0.55, 0.2),    // 3: Olive

    vec3(0.35, 0.7, 0.4),    // 4: Forest green
    vec3(0.25, 0.6, 0.4),    // 5: Teal green
    vec3(0.2, 0.55, 0.5),    // 6: Dark teal
    vec3(0.2, 0.5, 0.55),    // 7: Cyan teal

    vec3(0.25, 0.45, 0.75),  // 8: Steel blue
    vec3(0.4, 0.35, 0.7),    // 9: Indigo
    vec3(0.5, 0.35, 0.65),   // 10: Violet
    vec3(0.6, 0.3, 0.6),     // 11: Purple

    vec3(0.8, 0.35, 0.5),    // 12: Rose
    vec3(0.85, 0.3, 0.35),   // 13: Crimson
    vec3(0.7, 0.25, 0.35),   // 14: Burgundy
    vec3(0.6, 0.3, 0.35),    // 15: Muted burgundy

    vec3(0.9, 0.5, 0.2),     // 16: Orange
    vec3(0.85, 0.45, 0.25),  // 17: Burnt sienna
    vec3(0.8, 0.4, 0.15),    // 18: Rust
    vec3(0.75, 0.35, 0.2),   // 19: Copper

    vec3(0.2, 0.5, 0.45),    // 20: Dark seafoam
    vec3(0.15, 0.45, 0.45),  // 21: Dark teal
    vec3(0.2, 0.45, 0.55),   // 22: Slate blue
    vec3(0.25, 0.5, 0.6),    // 23: Steel

    vec3(0.45, 0.35, 0.6),   // 24: Plum
    vec3(0.55, 0.3, 0.55),   // 25: Grape
    vec3(0.4, 0.35, 0.55),   // 26: Dark violet
    vec3(0.5, 0.4, 0.65),    // 27: Lavender

    vec3(0.4, 0.4, 0.45),    // 28: Charcoal
    vec3(0.35, 0.4, 0.5),    // 29: Slate
    vec3(0.5, 0.4, 0.4),     // 30: Warm gray
    vec3(0.5, 0.45, 0.4),    // 31: Taupe
]

/** @deprecated Use getShapePalette("dark") or SHAPE_PALETTE_DARK */
export const DEFAULT_PALETTE = SHAPE_PALETTE_DARK

/**
 * Get the shape palette for the given theme.
 */
export function getShapePalette(theme: ShapePaletteTheme): Vec3f[] {
    return theme === "light" ? SHAPE_PALETTE_LIGHT : SHAPE_PALETTE_DARK
}

/**
 * Get the color for a given shape ID from the default palette.
 * Uses modulo to cycle through the 32 colors.
 */
export function getDefaultColor(shapeId: number, palette: Vec3f[] = SHAPE_PALETTE_DARK): Vec3f {
    return palette[shapeId % PALETTE_SIZE]
}

/**
 * Convert the palette to a Float32Array for GPU upload.
 * Returns a flat array of 96 floats (32 colors × 3 components).
 */
export function paletteToFloat32Array(palette: Vec3f[]): Float32Array {
    const data = new Float32Array(PALETTE_SIZE * 3)
    for (let i = 0; i < Math.min(palette.length, PALETTE_SIZE); i++) {
        data[i * 3] = palette[i].x
        data[i * 3 + 1] = palette[i].y
        data[i * 3 + 2] = palette[i].z
    }
    return data
}
