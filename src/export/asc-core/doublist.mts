/** Node for `AscDoublyList` (padis / highrices). */
export interface AscListLink {
    next: AscListLink | null
    previous: AscListLink | null
}

/** Doubly linked list (asc `DoublyList`). */
export class AscDoublyList<T extends AscListLink = AscListLink> {
    head: T | null = null
    last: T | null = null
    private curr: T | null = null

    clearAndDispose(): void {
        let n = this.head
        while (n) {
            const nx = n.next as T | null
            n.next = null
            n.previous = null
            n = nx
        }
        this.head = this.last = this.curr = null
    }

    first(): T | null {
        this.curr = this.head
        return this.curr
    }

    next(): T | null {
        this.curr = (this.curr?.next ?? null) as T | null
        return this.curr
    }

    append(input: T): void {
        input.previous = null
        input.next = null
        if (this.last === null) {
            this.last = this.head = input
        } else {
            this.last.next = input
            input.previous = this.last
            this.last = input as T
        }
    }

    remove(input: T): void {
        if (input === this.head) this.head = input.next as T | null
        else (input.previous as T).next = input.next
        if (input === this.last) this.last = input.previous as T | null
        else (input.next as T).previous = input.previous
        input.previous = null
        input.next = null
    }
}
