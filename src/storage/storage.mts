/** Interface for objects that can serialize themselves to/from a string. */
export interface Storable {
    toStorage(): string
    loadStorage(s: string): void
}
