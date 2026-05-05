/** Orbit radius at/above this → full wheel/pinch `zoomSensitivity` (align with camera-controller pan ref). */
const ZOOM_WHEEL_REF = 50
/** Ease zoom deltas when zoomed in: scale = max(floor, min(1, (zoom/ref)^exp)). */
const ZOOM_WHEEL_IN_EXP = 0.58
const ZOOM_WHEEL_SCALE_FLOOR = 0.14

function zoomDeltaScale(zoom: number): number {
    const u = zoom / ZOOM_WHEEL_REF
    return Math.max(ZOOM_WHEEL_SCALE_FLOOR, Math.min(1, Math.pow(u, ZOOM_WHEEL_IN_EXP)))
}

export class PinchZoomController {
    #initialPinchDistance = 0
    #initialPinchAngle = 0
    #initialZoom = 0
    #zoom: number
    #zoomSensitivity = 0.1
    #rotateSensitivity = 1
    #wheelZoomTimer: ReturnType<typeof setTimeout> | null = null

    isZooming = false
    onZoom?: (zoom: number, cursor: { x: number; y: number }) => void
    onRotate?: (angleDelta: number) => void

    #lastCursor: { x: number; y: number } = { x: 0, y: 0 }

    constructor(el: HTMLElement, defaultZoom = 40) {
        this.#zoom = defaultZoom
        el.addEventListener("wheel", this.#onWheel.bind(this), { passive: false })
        el.addEventListener("touchstart", this.#onTouchStart.bind(this), { passive: false })
        el.addEventListener("touchmove", this.#onTouchMove.bind(this), { passive: false })
        el.addEventListener("touchend", this.#onTouchEnd.bind(this), { passive: false })
        el.addEventListener("touchcancel", this.#onTouchEnd.bind(this), { passive: false })
    }

    #onWheel(e: WheelEvent) {
        e.preventDefault()
        this.isZooming = true
        if (this.#wheelZoomTimer !== null) clearTimeout(this.#wheelZoomTimer)
        this.#wheelZoomTimer = setTimeout(() => {
            this.#wheelZoomTimer = null
            this.isZooming = false
        }, 150)
        this.#lastCursor = { x: e.clientX, y: e.clientY }
        const s = zoomDeltaScale(this.#zoom)
        this.#zoom += e.deltaY * this.#zoomSensitivity * s
        this.#emitZoom()
    }

    #lastPinchAngle = 0

    #onTouchStart(e: TouchEvent) {
        if (e.touches.length === 2) {
            e.preventDefault()
            this.#initialPinchDistance = this.#getDistance(e.touches)
            this.#initialPinchAngle = this.#getAngle(e.touches)
            this.#lastPinchAngle = this.#initialPinchAngle
            this.#initialZoom = this.#zoom
        }
    }

    #onTouchMove(e: TouchEvent) {
        if (e.touches.length === 2) {
            this.isZooming = true
            e.preventDefault()
            const currentDistance = this.#getDistance(e.touches)
            const delta = currentDistance - this.#initialPinchDistance
            const s = zoomDeltaScale(this.#zoom)
            this.#zoom = this.#initialZoom - delta * this.#zoomSensitivity * s
            // Use midpoint of two touches as the pinch cursor position
            this.#lastCursor = {
                x: (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2,
                y: (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2,
            }
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
        this.onZoom?.(this.#zoom, this.#lastCursor)
    }

    setZoom(zoom: number, emit = false) {
        this.#zoom = zoom
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
