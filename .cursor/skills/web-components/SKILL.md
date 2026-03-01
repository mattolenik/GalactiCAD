---
name: web-components
description: Best practices for building vanilla web components with Shadow DOM and RxJS state management. Use when creating or editing custom HTML elements, managing component state with RxJS Subjects/Observables, wiring up reactive subscriptions, or handling component lifecycle and cleanup.
---

# Web Components

## Class Structure

All components extend `HTMLElement`, use private fields (`#`), and register at the bottom of the file.

```typescript
import { __fg_color, __tone_2 } from "../style/style.mjs"

export class MyComponent extends HTMLElement {
    // Private state first
    #value: string = ""
    #button: HTMLButtonElement

    constructor() {
        super()
        const shadow = this.attachShadow({ mode: "open" })

        // 1. Create and append <style>
        const style = document.createElement("style")
        style.textContent = `
            :host { display: inline-block; position: relative; }
            button { color: var(${__fg_color}); background: var(${__tone_2}); }
        `
        shadow.appendChild(style)

        // 2. Build DOM
        this.#button = document.createElement("button")
        this.#button.textContent = "Click"
        shadow.appendChild(this.#button)

        // 3. Wire events
        this.#button.addEventListener("click", () => this.#handleClick())
    }

    #handleClick() { /* ... */ }
}

customElements.define("my-component", MyComponent)
```

### Key rules

- Always `attachShadow({ mode: "open" })`.
- Use `#` private fields for all internal state and DOM references.
- Constructor does all setup: shadow DOM, styles, DOM tree, event listeners.
- Register with `customElements.define()` at end of file.
- One component per file.

## Lifecycle Methods

### `connectedCallback` / `disconnectedCallback`

Use these for global listeners that must be cleaned up (e.g. `window`, `document`).

**Preferred: AbortController.** Pass `{ signal }` to `addEventListener`; all listeners are removed with one `abort()` call. No need to store function references for removal.

```typescript
#ac = new AbortController()

connectedCallback() {
    this.#ac = new AbortController()
    const { signal } = this.#ac
    window.addEventListener("keydown", this.#onKeyDown, { signal })
    document.addEventListener("scroll", this.#onScroll, { signal })
}

disconnectedCallback() {
    this.#ac.abort()
}

#onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.#close()
}

#onScroll = () => { /* ... */ }
```

**Alternative: Arrow-function properties.** Store stable references so `removeEventListener` can remove them. Use when you have only one or two listeners.

```typescript
connectedCallback() {
    window.addEventListener("keydown", this.#onKeyDown)
}

disconnectedCallback() {
    window.removeEventListener("keydown", this.#onKeyDown)
}

#onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.#close()
}
```

Listeners on elements *inside* the shadow root don't need cleanup -- they're GC'd with the element.

### `observedAttributes` / `attributeChangedCallback`

Declare observed attributes with a static getter. React to changes in the callback.

```typescript
static get observedAttributes() {
    return ["show-overlay"]
}

attributeChangedCallback(name: string, _old: string | null, newVal: string | null) {
    if (name === "show-overlay") {
        this.#overlay.style.visibility = newVal === "true" ? "visible" : "hidden"
    }
}
```

### Getters/setters for property-attribute sync

Expose properties via get/set pairs that keep DOM and internal state in sync.

```typescript
get wireframe(): boolean { return this.#wireframe }
set wireframe(v: boolean) {
    this.#wireframe = v
    this.#wireframeCheckbox.checked = v
    this.setAttribute("wireframe", String(v))
}
```

## Styling

### Design tokens

Import CSS variable names from `src/style/style.mts` and use them in styles.

```typescript
import { __fg_color, __tone_1, __tone_2, __tone_accent } from "../style/style.mjs"
```

Reference them with `var()`:

```css
color: var(--fg-color);
background: var(--tone-2);
accent-color: var(--tone-accent);
```

CSS custom properties inherit through shadow boundaries, so values set on `:root` are available inside every component.

### Style patterns

- Create a `<style>` element, set `textContent`, and append to shadow root.
- Use `:host` for the component's own display/positioning.
- Template literal interpolation for variable names: `` `color: var(${__fg_color})` ``.
- Use `color-mix()` and `rgb(from ...)` for derived colors.
- No `adoptedStyleSheets` -- keep inline `<style>` elements for simplicity.
- Define local overrides on `:host` when a component needs its own token values.

### Example

```typescript
const style = document.createElement("style")
style.textContent = `
    :host {
        ${__fg_color}: whitesmoke;
        ${__tone_accent}: #007acc;
    }
    .panel {
        background: var(${__tone_2});
        color: var(${__fg_color});
    }
`
shadow.appendChild(style)
```

## DOM Construction

Two patterns depending on complexity:

### `createElement` for interactive components

Use when elements need individual event listeners or references.

```typescript
const container = document.createElement("div")
container.classList.add("tabs-container")

const btn = document.createElement("button")
btn.textContent = "Save"
btn.addEventListener("click", () => this.#save())
container.appendChild(btn)

shadow.appendChild(container)
```

### `innerHTML` for static structure

Use for dialog-style components with fixed markup and embedded styles.

```typescript
shadow.innerHTML = `
    <style>
        :host { display: block; position: fixed; inset: 0; z-index: 10000; }
        .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); }
        .dialog {
            position: fixed; top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            background: var(${__tone_2}); color: var(${__fg_color});
        }
    </style>
    <div class="overlay"></div>
    <div class="dialog">
        <div class="message">${this.#escapeHtml(message)}</div>
        <div class="buttons"><button class="ok">OK</button></div>
    </div>
`
```

Always escape user content when using `innerHTML`:

```typescript
#escapeHtml(text: string): string {
    const div = document.createElement("div")
    div.textContent = text
    return div.innerHTML
}
```

### Re-rendering

For list-like UI, clear with `innerHTML = ""` and rebuild imperatively.

```typescript
#renderItems() {
    this.#container.innerHTML = ""
    for (const item of this.#items) {
        const el = document.createElement("div")
        el.textContent = item.name
        el.addEventListener("click", () => this.#select(item))
        this.#container.appendChild(el)
    }
}
```

## Events and Communication

### Custom events

Dispatch `CustomEvent` with a `detail` payload for cross-component communication.

```typescript
this.dispatchEvent(new CustomEvent("selectionChanged", { detail: selectedName }))
```

Consumers listen on the element:

```typescript
myComponent.addEventListener("selectionChanged", (e: CustomEvent) => {
    console.log(e.detail)
})
```

### Callback properties

For one-to-one communication, expose optional callback properties.

```typescript
onXrayModeChange?: (enabled: boolean) => void

// In an event handler:
this.onXrayModeChange?.(this.#xrayMode)
```

### Shared singletons

Use `SettingsManager.instance` for persisted state (camera, preview, global). Components read/write through its API.

## Reactive Programming with RxJS

### Debounced persistence with Subject

Use bare `Subject<void>` as a signal, piped through `debounceTime`, for batched writes.

```typescript
import { Subject } from "rxjs"
import { debounceTime } from "rxjs/operators"

#save$ = new Subject<void>()

constructor() {
    this.#save$.pipe(debounceTime(300)).subscribe(() => this.#flush())
}

setValue(v: string) {
    this.#value = v
    this.#save$.next()
}
```

### Wrapping event emitters with fromEventPattern

Wrap non-standard event sources (e.g. Monaco editor) into observables.

```typescript
import { fromEventPattern, Subscription } from "rxjs"
import { bufferTime } from "rxjs/operators"

const change$ = fromEventPattern<SomeEvent>(
    handler => source.onDidChange(handler),
    (_handler, disposable) => (disposable as IDisposable).dispose()
).pipe(bufferTime(1000))

const sub = change$.subscribe(() => this.#persist())
```

### Subscription cleanup

Store subscriptions and unsubscribe when the associated resource is removed.

```typescript
#subscriptions = new Map<string, Subscription>()

#watch(key: string, source: EventSource) {
    this.#subscriptions.get(key)?.unsubscribe()
    const sub = fromEventPattern(/* ... */).subscribe(/* ... */)
    this.#subscriptions.set(key, sub)
}

remove(key: string) {
    this.#subscriptions.get(key)?.unsubscribe()
    this.#subscriptions.delete(key)
}
```

For long-lived singletons (e.g. `SettingsManager`, `App`), subscriptions can remain active for the app lifetime.

### Available operators

The project uses these RxJS imports:

| Import | From | Purpose |
|--------|------|---------|
| `Subject` | `rxjs` | Fire-and-forget signal for debounce triggers |
| `fromEventPattern` | `rxjs` | Wrap non-standard event emitters as observables |
| `Subscription` | `rxjs` | Stored reference for cleanup via `.unsubscribe()` |
| `bufferTime` | `rxjs/operators` | Batch events over a time window |
| `debounceTime` | `rxjs/operators` | Delay emission until quiet period passes |
| `filter` | `rxjs` | Drop empty buffers: `filter(arr => arr.length > 0)` |

## Dialog Pattern

Dialogs are components that append themselves to `document.body` and return a `Promise`.

```typescript
export class ConfirmDialog extends HTMLElement {
    #shadow = this.attachShadow({ mode: "open" })
    #resolve?: (value: boolean) => void

    constructor(message: string) {
        super()
        this.#shadow.innerHTML = `/* styles + markup */`
    }

    #ac = new AbortController()

    connectedCallback() {
        this.#ac = new AbortController()
        const { signal } = this.#ac
        this.#shadow.querySelector(".yes")!.addEventListener("click", () => this.#close(true), { signal })
        this.#shadow.querySelector(".no")!.addEventListener("click", () => this.#close(false), { signal })
        window.addEventListener("keydown", this.#onKeyDown, { signal })
    }

    disconnectedCallback() {
        this.#ac.abort()
    }

    #onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") this.#close(false)
        if (e.key === "Enter") this.#close(true)
    }

    #close(result: boolean) {
        this.remove()
        this.#resolve?.(result)
        this.#resolve = undefined
    }

    show(): Promise<boolean> {
        document.body.appendChild(this)
        return new Promise(resolve => { this.#resolve = resolve })
    }
}

customElements.define("confirm-dialog", ConfirmDialog)
```

Usage: `const confirmed = await new ConfirmDialog("Delete?").show()`

## TypeScript Integration

Extend the global tag name map so `querySelector` and friends return the correct type.

```typescript
declare global {
    interface HTMLElementTagNameMap {
        "my-component": MyComponent
    }
}
```

## Checklist for New Components

1. Extends `HTMLElement`, uses `#` private fields
2. `attachShadow({ mode: "open" })` in constructor
3. `<style>` uses design tokens from `style.mts`
4. `:host` sets display mode and positioning
5. DOM built in constructor (or `innerHTML` for static markup)
6. `customElements.define()` at end of file
7. Global listeners added in `connectedCallback`, removed in `disconnectedCallback` (use `AbortController` with `{ signal }` for cleanup)
8. Arrow-function properties for handler methods when using `removeEventListener` or `AbortController`
9. RxJS subscriptions stored and unsubscribed on teardown
10. Custom events dispatched for parent communication
11. User content escaped when using `innerHTML`
12. `HTMLElementTagNameMap` extended for typed queries
