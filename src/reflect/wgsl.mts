import { Decorated, DecoratorMetadata, getDecoratedProperties, MemoryShareable } from "./reflect.mjs"

export function bind() {
    return function (target: any, propertyKey: string): void {
        if (target?.decoratorMetadata instanceof DecoratorMetadata) {
            target.decoratorMetadata.set("bind", undefined, target, propertyKey)
        } else {
            throw new Error("the bind decorator can only be applied to properties on classes which have the @uniform decorator")
        }
    }
}

export function uniform<T extends Constructor>(base: T) {
    return class extends base implements Decorated {
        private meta!: DecoratorMetadata
        get decoratorMetadata() {
            this.meta = this.meta ?? new DecoratorMetadata(this)
            return this.meta
        }
        write(queue: GPUQueue, buffer: GPUBuffer) {
            const props = getDecoratedProperties("bind", this)
            let written = 0
            for (const [name] of props) {
                const propValue = Reflect.get(this, name, this) as any
                const data: Float32Array =
                    propValue instanceof Float32Array
                        ? propValue
                        : typeof propValue === "number"
                        ? new Float32Array([propValue as number])
                        : propValue?.data
                if (!(data instanceof Float32Array)) {
                    throw new Error("@bind properties must implement the MemoryShareable interface or be a Float32Array or a number")
                }
                console.trace("writing prop", name)
                queue.writeBuffer(buffer, written, data)
                written += data.byteLength
            }
        }
    }
}
