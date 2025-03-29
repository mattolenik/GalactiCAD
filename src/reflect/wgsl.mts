import { Decorated, DecoratorMetadata, getDecoratedProperties } from "./reflect.mjs"

export function bind({ size, offset = 0 }: { size: number; offset?: number }) {
    return function (target: any, propertyKey: string): void {
        console.log(target)
        console.log(target.decoratorMetadata)
        if (target?.decoratorMetadata instanceof DecoratorMetadata) {
            target.decoratorMetadata.set("bind", { size, offset }, target, propertyKey)
        } else {
            throw new Error("the bind decorator can only be applied to properties on classes which have the @uniform decorator")
        }
    }
}

export function uniform<T extends Constructor>(base: T) {
    return class extends base implements Decorated {
        _meta!: DecoratorMetadata
        get decoratorMetadata() {
            this._meta = this._meta ?? new DecoratorMetadata(this)
            return this._meta
        }
        write(queue: GPUQueue, buffer: GPUBuffer) {
            const props = getDecoratedProperties<{ size: number; offset: number }>("bind", this)
            let written = 0
            for (const prop of props) {
                const propValue = Reflect.get(this, prop[0]) as { data: Float32Array }
                if (!(propValue?.data instanceof Float32Array)) {
                    // TODO: use interface instead, or in addition to? Is this even a good pattern of convention here?
                    throw new Error("must provide data property of type Float32Array")
                }
                console.trace("writing prop", prop[0])
                queue.writeBuffer(buffer, written, propValue.data, prop[1]?.offset, prop[1]?.size)
            }
        }
    }
}
