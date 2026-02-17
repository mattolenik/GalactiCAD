import type { BehaviorSubject } from "rxjs"
import { Subscription } from "rxjs"

/**
 * Two-way bind a checkbox to a BehaviorSubject.
 * - Subscribes to source$ and updates checkbox.checked when it emits
 * - On checkbox change, calls source$.next(checkbox.checked)
 * Returns the subscription for cleanup (call .unsubscribe() when removing the binding).
 */
export function connectCheckbox(
    checkbox: HTMLInputElement,
    source$: BehaviorSubject<boolean>
): Subscription {
    const ac = new AbortController()
    const sub = source$.subscribe(v => {
        checkbox.checked = v
    })
    checkbox.addEventListener("change", () => {
        source$.next(checkbox.checked)
    }, { signal: ac.signal })
    sub.add(() => ac.abort())
    return sub
}
