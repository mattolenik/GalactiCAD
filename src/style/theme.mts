/**
 * Theme resolution and CSS variable palettes for light/dark mode.
 */

import type { ThemeMode } from "../storage/settings.mjs"
import {
    __active_bg,
    __bg_color,
    __bg_color_dark,
    __editor_panel_bg,
    __error_bg,
    __fg_color,
    __preview_bg,
    __resize_handle_active,
    __resize_handle_base,
    __resize_handle_hover,
    __tone_0,
    __tone_1,
    __tone_2,
    __tone_3,
    __tone_accent,
    __toolbar_height,
    __welcome_bg_end,
    __welcome_bg_mid,
    __welcome_bg_start,
} from "./style.mjs"

export type EffectiveTheme = "light" | "dark"

export const THEME_PALETTES: Record<EffectiveTheme, Record<string, string>> = {
    dark: {
        [__fg_color]: "whitesmoke",
        [__bg_color]: "#333",
        [__bg_color_dark]: "#222",
        [__preview_bg]: "#1a1a1a",
        [__tone_0]: "#EEE",
        [__tone_1]: "#888",
        [__tone_2]: "#444",
        [__tone_3]: "#666",
        [__tone_accent]: "#007acc",
        [__active_bg]: "rgba(30, 30, 30, 0.82)",
        [__editor_panel_bg]: "rgba(30, 30, 30, 0.82)",
        [__resize_handle_base]: "rgba(255, 255, 255, 0.08)",
        [__resize_handle_hover]: "rgba(255, 255, 255, 0.32)",
        [__resize_handle_active]: "rgba(255, 255, 255, 0.5)",
        [__welcome_bg_start]: "#141b26",
        [__welcome_bg_mid]: "#0e1319",
        [__welcome_bg_end]: "#0a0e14",
        [__error_bg]: "rgba(180, 60, 60, 0.2)",
        [__toolbar_height]: "36px",
    },
    light: {
        [__fg_color]: "#1e1e1e",
        [__bg_color]: "#f3f3f3",
        [__bg_color_dark]: "#e8e8e8",
        [__preview_bg]: "#e8e8e8",
        [__tone_0]: "#333",
        [__tone_1]: "#666",
        [__tone_2]: "#ddd",
        [__tone_3]: "#bbb",
        [__tone_accent]: "#007acc",
        [__active_bg]: "rgba(248, 248, 248, 0.95)",
        [__editor_panel_bg]: "rgba(248, 248, 248, 0.95)",
        [__resize_handle_base]: "rgba(0, 0, 0, 0.08)",
        [__resize_handle_hover]: "rgba(0, 0, 0, 0.2)",
        [__resize_handle_active]: "rgba(0, 0, 0, 0.35)",
        [__welcome_bg_start]: "#e8e8e8",
        [__welcome_bg_mid]: "#e0e0e0",
        [__welcome_bg_end]: "#d8d8d8",
        [__error_bg]: "rgba(220, 80, 80, 0.15)",
        [__toolbar_height]: "36px",
    },
}

/**
 * Resolve the effective theme (light or dark) from a ThemeMode.
 * For "auto", uses prefers-color-scheme; defaults to dark if unavailable.
 */
export function resolveEffectiveTheme(mode: ThemeMode): EffectiveTheme {
    if (mode === "light") return "light"
    if (mode === "dark") return "dark"
    try {
        const m = window.matchMedia("(prefers-color-scheme: dark)")
        return m.matches ? "dark" : "light"
    } catch {
        return "dark"
    }
}

/**
 * Subscribe to theme changes. When mode is "auto", listens to prefers-color-scheme.
 * Returns an unsubscribe function.
 */
export function subscribeToThemeChanges(mode: ThemeMode, callback: (effective: EffectiveTheme) => void): () => void {
    if (mode !== "auto") {
        callback(resolveEffectiveTheme(mode))
        return () => {}
    }
    callback(resolveEffectiveTheme(mode))
    try {
        const m = window.matchMedia("(prefers-color-scheme: dark)")
        const handler = () => callback(m.matches ? "dark" : "light")
        m.addEventListener("change", handler)
        return () => m.removeEventListener("change", handler)
    } catch {
        return () => {}
    }
}
