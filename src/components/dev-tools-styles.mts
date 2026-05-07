import { __fg_color, __tone_1, __tone_2 } from "../style/style.mjs"

/** Shared shadow styles for dev tools sections (checkboxes, buttons, lighting rows). */
export function devToolsBaseShadowCss(): string {
    return `
        :host {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 6px;
            align-self: stretch;
            color: rgb(from var(${__fg_color}) r g b / 0.85);
            font-size: 12px;
            font-family: system-ui, sans-serif;
        }
        label {
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        input[type="checkbox"] {
            cursor: pointer;
            margin: 0;
            font-size: 16px;
        }
        button {
            cursor: pointer;
            padding: 2px 8px;
            border: 1px solid var(${__tone_1});
            background: rgb(from var(${__fg_color}) r g b / 0.1);
            color: rgb(from var(${__fg_color}) r g b / 0.85);
            font-size: 12px;
            font-family: system-ui, sans-serif;
            border-radius: 3px;
            transition: background 0.2s ease;
        }
        button:hover {
            background: rgb(from var(${__fg_color}) r g b / 0.2);
        }
        button:active {
            background: rgb(from var(${__fg_color}) r g b / 0.3);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .shade-head {
            font-size: 10px;
            opacity: 0.75;
            margin-top: 6px;
            align-self: stretch;
        }
        .shade-row {
            display: flex;
            align-items: center;
            gap: 6px;
            width: 100%;
        }
        .shade-row label.knob-label {
            flex: 0 0 92px;
            font-size: 11px;
            cursor: default;
        }
        .shade-row input[type="range"] {
            flex: 1;
            min-width: 0;
            margin: 0;
        }
        .shade-val {
            flex: 0 0 44px;
            text-align: right;
            font-variant-numeric: tabular-nums;
            font-size: 11px;
        }
        .lighting-section {
            display: flex;
            flex-direction: column;
            gap: 2px;
            align-self: stretch;
            width: 100%;
        }
        .lighting-section > .shade-head {
            margin-top: 2px;
        }
        .lighting-section[hidden] {
            display: none !important;
        }
        .debug-log-list {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 1px;
            align-self: start;
        }
        .debug-log-list label {
            font-size: 11px;
            display: flex;
            align-items: center;
            gap: 4px;
            width: max-content;
        }
    `
}
