/** Reference dolly distance — aligns with camera-controller `DOLLY_REF`. */
const DOLLY_WHEEL_REF = 50
/** Ease wheel deltas when close (small dolly): scale = max(floor, min(1, (dolly/ref)^exp)). */
const DOLLY_WHEEL_IN_EXP = 0.58
const DOLLY_WHEEL_SCALE_FLOOR = 0.14

function dollyDeltaScale(dolly: number): number {
    const u = dolly / DOLLY_WHEEL_REF
    return Math.max(DOLLY_WHEEL_SCALE_FLOOR, Math.min(1, Math.pow(u, DOLLY_WHEEL_IN_EXP)))
}

export class PinchZoomController {
    #initialPinchDistance = 0
    #initialPinchAngle = 0
    #initialDolly = 0
    #dollyDistance: number
    #zoomSensitivity = 0.1
    #rotateSensitivity = 1
    #wheelZoomTimer: ReturnType<typeof setTimeout> | null = null

    /** When set, wheel / pinch-zoom only applies when the cursor lies in this screen rect. */
    #getInteractionRect?: () => DOMRect

    isZooming = false
    /** Emits updated dolly distance (wheel/pinch). */
    onZoom?: (dollyDistance: number, cursor: { x: number; y: number }) => void
    onRotate?: (angleDelta: number) => void

    #lastCursor: { x: number; y: number } = { x: 0, y: 0 }

    constructor(el: HTMLElement, initialDollyDistance = 50, getInteractionRect?: () => DOMRect) {
        this.#dollyDistance = initialDollyDistance
        this.#getInteractionRect = getInteractionRect
        el.addEventListener("wheel", this.#onWheel.bind(this), { passive: false })
        el.addEventListener("touchstart", this.#onTouchStart.bind(this), { passive: false })
        el.addEventListener("touchmove", this.#onTouchMove.bind(this), { passive: false })
        el.addEventListener("touchend", this.#onTouchEnd.bind(this), { passive: false })
        el.addEventListener("touchcancel", this.#onTouchEnd.bind(this), { passive: false })
    }

    #isInsideInteraction(clientX: number, clientY: number): boolean {
        const q = this.#getInteractionRect
        if (!q) return true
        const r = q()
        return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
    }

    #onWheel(e: WheelEvent) {
        if (!this.#isInsideInteraction(e.clientX, e.clientY)) return
        e.preventDefault()
        this.isZooming = true
        if (this.#wheelZoomTimer !== null) clearTimeout(this.#wheelZoomTimer)
        this.#wheelZoomTimer = setTimeout(() => {
            this.#wheelZoomTimer = null
            this.isZooming = false
        }, 150)
        this.#lastCursor = { x: e.clientX, y: e.clientY }
        const s = dollyDeltaScale(this.#dollyDistance)
        this.#dollyDistance += e.deltaY * this.#zoomSensitivity * s
        this.#emitZoom()
    }

    #lastPinchAngle = 0

    #onTouchStart(e: TouchEvent) {
        if (e.touches.length === 2) {
            const mx = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2
            const my = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2
            if (!this.#isInsideInteraction(mx, my)) return
            e.preventDefault()
            this.#initialPinchDistance = this.#getDistance(e.touches)
            this.#initialPinchAngle = this.#getAngle(e.touches)
            this.#lastPinchAngle = this.#initialPinchAngle
            this.#initialDolly = this.#dollyDistance
        }
    }

    #onTouchMove(e: TouchEvent) {
        if (e.touches.length === 2) {
            const mx = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2
            const my = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2
            if (!this.#isInsideInteraction(mx, my)) return
            this.isZooming = true
            e.preventDefault()
            const currentDistance = this.#getDistance(e.touches)
            const delta = currentDistance - this.#initialPinchDistance
            const s = dollyDeltaScale(this.#dollyDistance)
            this.#dollyDistance = this.#initialDolly - delta * this.#zoomSensitivity * s
            // Use midpoint of two touches as the pinch cursor position
            this.#lastCursor = { x: mx, y: my }
            this.#emitZoom()

            const currentAngle = this.#getAngle(e.touches)
            let angleDelta = currentAngle - this.#lastPinchAngle
            if (angleDelta > Math.PI) angleDelta -= 2 * Math.PI
            if (angleDelta < -Math.PI) angleDelta += 2 * Math.PI
            this.#lastPinchAngle = currentAngle
            this.onRotate?.(angleDelta * this.#rotateSensitivity)
        }
    }

    #onTouchEnd(e: TouchEvent) {
        if (e.touches.length < 2) {
            this.#initialPinchDistance = 0
            this.#initialPinchAngle = 0
            this.#lastPinchAngle = 0
            this.isZooming = false
        }
    }

    #emitZoom() {
        this.onZoom?.(this.#dollyDistance, this.#lastCursor)
    }

    setDollyDistance(dollyDistance: number, emit = false) {
        this.#dollyDistance = dollyDistance
        if (emit) {
            this.#emitZoom()
        }
    }

    #getDistance(touches: TouchList): number {
        const [t1, t2] = this.#sortedTouches(touches)
        const dx = t1.clientX - t2.clientX
        const dy = t1.clientY - t2.clientY
        return Math.hypot(dx, dy)
    }

    #getAngle(touches: TouchList): number {
        const [t1, t2] = this.#sortedTouches(touches)
        return Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX)
    }

    /** Sort by identifier for consistent angle/distance across touch events */
    #sortedTouches(touches: TouchList): [Touch, Touch] {
        const [a, b] = touches
        return a.identifier <= b.identifier ? [a, b] : [b, a]
    }
}
