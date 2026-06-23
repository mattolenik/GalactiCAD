/**
 * A virtual trackball controller for 3D rotations using azimuth/elevation.
 * Based on work by @scottshambaugh (MIT). Requires the Quaternion.js library.
 */
// @ts-ignore - quaternion library type definitions have issues
import Quaternion from "quaternion"

export interface TrackballOptions {
    /** The DOM element that will contain the trackball */
    scene: HTMLElement
    /** Optional rect for interaction (e.g. visible area when editor overlays). Uses scene.getBoundingClientRect() when omitted. */
    getInteractionRect?: () => DOMRect
    /** Callback function called when trackball is rotated */
    onDraw?: (this: Trackball, q: Quaternion) => void
    /** Whether to clamp elevation rotation */
    clampElevation?: boolean
    /** Initial rotation quaternion */
    q?: Quaternion
    /** Whether to invert X rotation */
    invertX?: boolean
    /** Whether to invert Y rotation */
    invertY?: boolean
    /** Speed of rotation */
    speed?: number
}

type TrackballOptionsInput =
    | (Partial<TrackballOptions> & { nodeType?: never })
    | { nodeType: unknown; scene?: never }

interface DragState {
    startPosition: [number, number]
    box: DOMRect
}

export class Trackball {
    #q0: Quaternion
    #q: Quaternion
    #azimuth = 0
    #elevation = 0
    #roll = 0
    #azimuth_start = 0
    #elevation_start = 0
    #roll_start = 0
    #drag: DragState | null = null
    #isUpdatePending = false
    #lastMousePosition: { clientX: number; clientY: number } | null = null
    #opts: Required<Omit<TrackballOptions, "scene" | "q" | "getInteractionRect">> & {
        scene: HTMLElement
        getInteractionRect?: () => DOMRect
    }

    /**
     * Constructs a new Trackball instance.
     */
    constructor(opts: TrackballOptionsInput = {}) {
        let resolvedOpts = opts as Partial<TrackballOptions> & {
            nodeType?: unknown
        }
        if (resolvedOpts.nodeType) {
            resolvedOpts = { scene: opts as unknown as HTMLElement }
        }
        if (typeof resolvedOpts.scene === "string") {
            resolvedOpts.scene = document.querySelector(resolvedOpts.scene) ?? undefined
        }

        const {
            scene,
            getInteractionRect,
            onDraw = () => { },
            clampElevation = false,
            q = Quaternion.ONE,
            invertX = false,
            invertY = false,
            speed = 1,
        } = resolvedOpts

        if (!scene) {
            throw new Error("Trackball requires a scene element")
        }
        this.#opts = {
            scene,
            getInteractionRect,
            onDraw,
            clampElevation,
            invertX,
            invertY,
            speed,
        }

        // Core state initialization
        this.#q0 = this.#q = q

        this.#initEventListeners()
        this.#draw()
    }

    /**
     * Rotates the trackball by a given quaternion.
     */
    rotate(quaternion: Quaternion): void {
        if (!this.#drag) {
            this.#q = this.#q0 = this.#q0.mul(quaternion)

            // Calculate azimuth and elevation from the new quaternion
            const euler = this.#q.toEuler("XYZ") // [yaw, pitch, roll]
            this.#elevation = euler[0]
            this.#azimuth = euler[1]
            this.#roll = euler[2]
            this.#azimuth_start = this.#azimuth
            this.#elevation_start = this.#elevation
            this.#roll_start = this.#roll

            this.#draw()
        }
    }

    /**
     * Align internal rotation to an external quaternion (e.g. pinch-twist on the host).
     * Does not clear an active drag; when continuing a 1-finger orbit after a pinch,
     * re-base the azimuth/elevation deltas from the current pointer so it stays coherent.
     */
    applySceneRotation(quaternion: Quaternion): void {
        const v = quaternion.toVector()
        const qn = new Quaternion(v[0], v[1], v[2], v[3]).normalize()
        this.#q = this.#q0 = qn
        const euler = this.#q.toEuler("XYZ")
        this.#elevation = euler[0]
        this.#azimuth = euler[1]
        this.#roll = euler[2]
        this.#azimuth_start = this.#azimuth
        this.#elevation_start = this.#elevation
        this.#roll_start = this.#roll

        if (this.#drag && this.#lastMousePosition) {
            this.#drag.startPosition = [this.#lastMousePosition.clientX, this.#lastMousePosition.clientY]
        }
        this.#draw()
    }

    /**
     * Resets the trackball to its initial state.
     */
    reset(): void {
        this.#drag = null
        this.#q = this.#q0 = new Quaternion(1, 0, 0, 0)
        this.#azimuth = this.#azimuth_start = 0
        this.#elevation = this.#elevation_start = 0
        this.#roll = this.#roll_start = 0
        this.#draw()
    }

    #initEventListeners(): void {
        const scene = this.#opts.scene

        scene.addEventListener("mousedown", this.#handleMouseDown.bind(this))
        document.addEventListener("mousemove", this.#handleMouseMove.bind(this))
        document.addEventListener("mouseup", this.#handleMouseUp.bind(this))

        scene.addEventListener(
            "touchstart",
            (e: TouchEvent) => {
                e.preventDefault()
                if (e.touches.length === 1) {
                    this.#handleMouseDown(e.touches[0])
                }
            },
            { passive: false }
        )

        document.addEventListener(
            "touchmove",
            (e: TouchEvent) => {
                if (e.touches.length === 1) {
                    this.#handleMouseMove(e.touches[0])
                }
            },
            { passive: true }
        )

        document.addEventListener(
            "touchend",
            (e: TouchEvent) => {
                // With two fingers down, lifting one finger fires touchend for that finger while
                // another touch remains — do not end the drag or #draw() stale state until all
                // touches are released (pinch + orbit share the same trackball drag).
                if (e.touches.length > 0) return
                if (e.changedTouches.length < 1) return
                this.#handleMouseUp()
            },
            { passive: true }
        )
    }

    #handleMouseDown(event: MouseEvent | Touch): void {
        // Only respond to left mouse button; right/middle are used for pan
        if (event instanceof MouseEvent && event.button !== 0) return

        const box = this.#opts.getInteractionRect?.() ?? this.#opts.scene.getBoundingClientRect()
        if (!this.#isInBounds(event.clientX, event.clientY, box)) return

        this.#drag = {
            startPosition: [event.clientX, event.clientY],
            box,
        }

        this.#draw()
    }

    #handleMouseMove(event: MouseEvent | Touch): void {
        if (!this.#drag) return

        this.#lastMousePosition = {
            clientX: event.clientX,
            clientY: event.clientY,
        }

        if (!this.#isUpdatePending) {
            this.#isUpdatePending = true
            requestAnimationFrame(this.#update.bind(this))
        }
    }

    #update(): void {
        if (this.#lastMousePosition && this.#drag) {
            const { clientX, clientY } = this.#lastMousePosition

            const box = this.#drag.box
            if (this.#isInBounds(clientX, clientY, box)) {
                this.#updateRotation(clientX, clientY)
                this.#draw()
            }
        }

        this.#isUpdatePending = false
    }

    #updateRotation(clientX: number, clientY: number): void {
        const deltaX = clientX - this.#drag!.startPosition[0]
        const deltaY = clientY - this.#drag!.startPosition[1]
        if (deltaX === 0 && deltaY === 0) return
        this.#updateAzEl(deltaX, deltaY)
    }

    #handleMouseUp(_event?: MouseEvent | Touch): void {
        if (!this.#drag) return

        this.#drag = null
        this.#q0 = this.#q
        this.#lastMousePosition = null
        this.#azimuth_start = this.#azimuth
        this.#elevation_start = this.#elevation
        this.#roll_start = this.#roll
        this.#draw()
    }

    #updateAzEl(deltaX: number, deltaY: number): void {
        const scaleX =
            Math.PI /
            Math.min(this.#drag!.box.width, this.#drag!.box.height)
        const scaleY = scaleX

        const invertedDeltaX = this.#opts.invertX ? -deltaX : deltaX
        const invertedDeltaY = this.#opts.invertY ? -deltaY : deltaY

        this.#azimuth =
            this.#azimuth_start +
            invertedDeltaX * scaleX * this.#opts.speed

        if (this.#opts.clampElevation) {
            this.#elevation = Math.max(
                -Math.PI / 2 + 0.01,
                Math.min(
                    Math.PI / 2 - 0.01,
                    this.#elevation_start +
                    invertedDeltaY * scaleY * this.#opts.speed
                )
            )
        } else {
            this.#elevation =
                this.#elevation_start +
                invertedDeltaY * scaleY * this.#opts.speed
        }

        this.#q = Quaternion.fromEuler(
            this.#elevation,
            this.#azimuth,
            this.#roll,
            "XYZ"
        )
    }

    #isInBounds(x: number, y: number, box: DOMRect): boolean {
        return (
            x >= box.left &&
            x <= box.right &&
            y >= box.top &&
            y <= box.bottom
        )
    }

    #draw(): void {
        this.#opts.onDraw.call(this, this.#q)
    }
}
