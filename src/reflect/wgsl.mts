import { Decorated, DecoratorMetadata, getDecoratedPropertyValues, MemoryShareable } from "./reflect.mjs"

export function bind() {
    return function (target: any, propertyKey: string): void {
        if (target?.decoratorMetadata instanceof DecoratorMetadata) {
            target.decoratorMetadata.set("bind", undefined, target, propertyKey)
        } else {
            throw new Error("the bind decorator can only be applied to properties on classes which have the @uniform decorator")
        }
    }
}

export function buffer<T extends Constructor>(base: T) {
    return class extends base implements Decorated {
        private meta!: DecoratorMetadata
        private device!: GPUDevice
        size!: number

        get decoratorMetadata() {
            this.meta = this.meta ?? new DecoratorMetadata(this)
            return this.meta
        }
        init(device: GPUDevice) {
            this.device = device
            const propValues = getDecoratedPropertyValues<MemoryShareable>("bind", this)
            this.size = propValues.map(([_, val]) => val.byteLength).reduce((p, c) => p + c, 0)
        }
        write(buffer: GPUBuffer) {
            if (!this.device) throw new Error("must run init before write")

            const bindProps = getDecoratedPropertyValues<MemoryShareable>("bind", this)
            let written = 0
            for (const [name, propValue] of bindProps) {
                let data: BufferSource | SharedArrayBuffer

                if (propValue instanceof Float32Array) {
                    data = propValue
                } else if (typeof propValue === "number") {
                    data = new Float32Array([propValue as number])
                } else {
                    data = propValue?.data
                }
                if (!(data instanceof Float32Array)) {
                    throw new Error("@bind properties must implement the MemoryShareable interface or be a Float32Array or a number")
                }

                console.trace("writing prop", name)
                this.device.queue.writeBuffer(buffer, written, data)
                written += data.byteLength
            }
        }
    }
}
