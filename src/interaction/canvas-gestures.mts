/**
 * Pointer-event gesture recogniser for the preview canvas: tap, double-tap, long-press.
 *
 * Built on plain Pointer Events (capture phase) rather than browser gestures because
 * (a) CDP-injected touches in the remote viewer (`/_remote`) get no gesture recognition
 * at all — no synthesized `click`, `dblclick` or long-press `contextmenu` — and
 * (b) iOS Safari never fires `dblclick` for touch. Recognising here makes a finger on the
 * device, a finger through the remote viewer, and a pen behave identically.
 *
 * Long-press is reported only for the pointer types in `longPressPointerTypes`
 * (default touch + pen): the mouse keeps its modifier-based affordances (shift-hold).
 */

export type CanvasGestureKind = "tap" | "doubleTap" | "longPress"

export interface CanvasGesture {
    kind: CanvasGestureKind
    clientX: number
    clientY: number
    pointerId: number
    pointerType: string
}

export interface CanvasGestureOptions {
    /** Hold this long (ms) within `slopPx` to count as a long-press. */
    longPressMs?: number
    /** Movement beyond this (px) cancels a tap / long-press. */
    slopPx?: number
    /** A press released within this (ms) is a tap. */
    tapMaxMs?: number
    /** Second tap within this (ms) and `doubleTapPx` of the first → double-tap. */
    doubleTapMs?: number
    doubleTapPx?: number
    /** Pointer types that can long-press (others only tap / double-tap). */
    longPressPointerTypes?: Iterable<string>
}

const DEFAULTS = {
    longPressMs: 400,
    slopPx: 8,
    tapMaxMs: 300,
    doubleTapMs: 350,
    doubleTapPx: 25,
    longPressPointerTypes: ["touch", "pen"],
}

interface Press {
    pointerId: number
    pointerType: string
    x0: number
    y0: number
    x: number
    y: number
    t0: number
    timer: ReturnType<typeof setTimeout> | null
    /** Set once movement / a second pointer / modifiers disqualified tap AND long-press. */
    spoiled: boolean
    /** Long-press already reported for this press (no tap on release). */
    longPressed: boolean
}

export class CanvasGestureRecognizer {
    readonly #el: HTMLElement
    readonly #opts: Required<Omit<CanvasGestureOptions, "longPressPointerTypes">> & { longPressPointerTypes: Set<string> }
    readonly #onGesture: (g: CanvasGesture) => void
    #press: Press | null = null
    #pointersDown = new Set<number>()
    #lastTap: { t: number; x: number; y: number; pointerType: string } | null = null
    readonly #listeners: Array<[keyof HTMLElementEventMap, (e: PointerEvent) => void]> = []

    constructor(el: HTMLElement, onGesture: (g: CanvasGesture) => void, opts: CanvasGestureOptions = {}) {
        this.#el = el
        this.#onGesture = onGesture
        this.#opts = {
            longPressMs: opts.longPressMs ?? DEFAULTS.longPressMs,
            slopPx: opts.slopPx ?? DEFAULTS.slopPx,
            tapMaxMs: opts.tapMaxMs ?? DEFAULTS.tapMaxMs,
            doubleTapMs: opts.doubleTapMs ?? DEFAULTS.doubleTapMs,
            doubleTapPx: opts.doubleTapPx ?? DEFAULTS.doubleTapPx,
            longPressPointerTypes: new Set(opts.longPressPointerTypes ?? DEFAULTS.longPressPointerTypes),
        }
        const add = (type: keyof HTMLElementEventMap, fn: (e: PointerEvent) => void) => {
            el.addEventListener(type, fn as EventListener, { capture: true })
            this.#listeners.push([type, fn])
        }
        add("pointerdown", e => this.#onDown(e))
        add("pointermove", e => this.#onMove(e))
        add("pointerup", e => this.#onUp(e))
        add("pointercancel", e => this.#onCancel(e))
        add("lostpointercapture", e => this.#onCancel(e))
    }

    dispose(): void {
        for (const [type, fn] of this.#listeners) this.#el.removeEventListener(type, fn as EventListener, { capture: true })
        this.#listeners.length = 0
        this.#clearPress()
    }

    /** True while a long-press has been reported and its pointer is still down. */
    get longPressHeld(): boolean {
        return this.#press?.longPressed === true
    }

    #onDown(e: PointerEvent): void {
        this.#pointersDown.add(e.pointerId)
        if (this.#pointersDown.size > 1) {
            // A second pointer (pinch, two-finger anything) spoils the gesture in flight.
            if (this.#press) this.#spoil(this.#press)
            return
        }
        this.#clearPress()
        if (e.button !== 0) return
        const press: Press = {
            pointerId: e.pointerId,
            pointerType: e.pointerType,
            x0: e.clientX,
            y0: e.clientY,
            x: e.clientX,
            y: e.clientY,
            t0: performance.now(),
            timer: null,
            spoiled: e.shiftKey || e.metaKey || e.ctrlKey || e.altKey,
            longPressed: false,
        }
        this.#press = press
        if (!press.spoiled && this.#opts.longPressPointerTypes.has(e.pointerType)) {
            press.timer = setTimeout(() => {
                press.timer = null
                if (this.#press !== press || press.spoiled) return
                press.longPressed = true
                this.#onGesture({ kind: "longPress", clientX: press.x, clientY: press.y, pointerId: press.pointerId, pointerType: press.pointerType })
            }, this.#opts.longPressMs)
        }
    }

    #onMove(e: PointerEvent): void {
        const p = this.#press
        if (!p || e.pointerId !== p.pointerId || p.spoiled || p.longPressed) return
        p.x = e.clientX
        p.y = e.clientY
        if (Math.hypot(p.x - p.x0, p.y - p.y0) > this.#opts.slopPx) this.#spoil(p)
    }

    #onUp(e: PointerEvent): void {
        this.#pointersDown.delete(e.pointerId)
        const p = this.#press
        if (!p || e.pointerId !== p.pointerId) return
        this.#press = null
        if (p.timer !== null) clearTimeout(p.timer)
        if (p.spoiled || p.longPressed) return
        const now = performance.now()
        if (now - p.t0 > this.#opts.tapMaxMs) return
        const last = this.#lastTap
        const nearLast = last !== null && now - last.t <= this.#opts.doubleTapMs && Math.hypot(p.x - last.x, p.y - last.y) <= this.#opts.doubleTapPx
        // The remote viewer (and some compat paths) replay a finger tap as a mouse
        // press/release at the same spot right after it: that is the SAME physical tap
        // seen through a second pointer type, not a second tap. Drop it.
        if (nearLast && last!.pointerType !== p.pointerType) return
        const g = { clientX: p.x, clientY: p.y, pointerId: p.pointerId, pointerType: p.pointerType }
        if (nearLast) {
            this.#lastTap = null
            this.#onGesture({ kind: "doubleTap", ...g })
        } else {
            this.#lastTap = { t: now, x: p.x, y: p.y, pointerType: p.pointerType }
            this.#onGesture({ kind: "tap", ...g })
        }
    }

    #onCancel(e: PointerEvent): void {
        this.#pointersDown.delete(e.pointerId)
        const p = this.#press
        if (!p || e.pointerId !== p.pointerId) return
        this.#clearPress()
    }

    #spoil(p: Press): void {
        p.spoiled = true
        if (p.timer !== null) {
            clearTimeout(p.timer)
            p.timer = null
        }
    }

    #clearPress(): void {
        const p = this.#press
        if (!p) return
        if (p.timer !== null) clearTimeout(p.timer)
        this.#press = null
    }
}
