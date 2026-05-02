/**
 * Combinable bit flags for spatial directions (use | to combine, & to test).
 * Single-bit sequence: TOP, BOTTOM, LEFT, RIGHT, FRONT, BACK (0x1 … 0x20).
 * Y-up cylinders and threaded rods use TOP (+Y) and BOTTOM (−Y) for rim chamfer/fillet.
 */
export const TOP = 0x1
export const BOTTOM = 0x2
export const LEFT = 0x4
export const RIGHT = 0x8
export const FRONT = 0x10
export const BACK = 0x20

/** One direction bit from {@link TOP} … {@link BACK}. */
export type DirectionFlag = typeof TOP | typeof BOTTOM | typeof LEFT | typeof RIGHT | typeof FRONT | typeof BACK

/** Bitfield: combine {@link DirectionFlag} values with bitwise OR. */
export type DirectionIndicator = number
