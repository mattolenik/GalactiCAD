/** A source string alone cannot identify buffers after an interactive parameter edit. */
export class AcceptanceSourceGuard {
    epoch = 0
    private cleanBody: string | null = null
    invalidate(): void { this.epoch++; this.cleanBody = null }
    buildStarted(): number { this.invalidate(); return this.epoch }
    built(body: string, epochAtStart: number, successful = true): void {
        if (successful && this.epoch === epochAtStart) this.cleanBody = body
    }
    begin(body: string): number {
        if (this.cleanBody !== body) throw new Error("Acceptance GPU source is stale or geometry was edited outside a source build")
        return this.epoch
    }
    check(body: string, epoch: number): void {
        if (this.begin(body) !== epoch) throw new Error("Acceptance GPU geometry changed during sampling")
    }
}
