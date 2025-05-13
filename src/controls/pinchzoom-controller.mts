export class PinchZoomController {
    #initialPinchDistance = 0
    #initialZoom = 0
    #zoom = 100
    #zoomSensitivity = 0.1
    isZooming = false

    onZoom?: (zoom: number) => void

    constructor(el: HTMLElement) {
        el.addEventListener("wheel", this.#onWheel.bind(this), { passive: false })
        el.addEventListener("touchstart", this.#onTouchStart.bind(this), { passive: false })
        el.addEventListener("touchmove", this.#onTouchMove.bind(this), { passive: false })
        el.addEventListener("touchend", this.#onTouchEnd.bind(this), { passive: false })
        el.addEventListener("touchcancel", this.#onTouchEnd.bind(this), { passive: false })
    }

    #onWheel(e: WheelEvent) {
        e.preventDefault()
        this.#zoom += e.deltaY * this.#zoomSensitivity
        this.#emitZoom()
    }

    #onTouchStart(e: TouchEvent) {
        if (e.touches.length === 2) {
            e.preventDefault()
            this.#initialPinchDistance = this.#getDistance(e.touches)
            this.#initialZoom = this.#zoom
            this.isZooming = true
        }
    }

    #onTouchMove(e: TouchEvent) {
        if (e.touches.length === 2 && this.#initialPinchDistance > 0) {
            e.preventDefault()
            const currentDistance = this.#getDistance(e.touches)
            const delta = currentDistance - this.#initialPinchDistance
            this.#zoom = this.#initialZoom - delta * this.#zoomSensitivity
            this.#emitZoom()
        }
    }

    #onTouchEnd(e: TouchEvent) {
        if (e.touches.length < 2) {
            this.#initialPinchDistance = 0
        }
        this.isZooming = false
    }

    #emitZoom() {
        this.onZoom?.(this.#zoom)
    }

    #getDistance(touches: TouchList): number {
        const [t1, t2] = touches
        const dx = t1.clientX - t2.clientX
        const dy = t1.clientY - t2.clientY
        return Math.hypot(dx, dy)
    }
}
