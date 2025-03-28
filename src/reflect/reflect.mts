const globalMetadata = new WeakMap<object, Map<string | symbol, Map<any, any>>>()

export interface Decorated {
    decoratorMetadata: DecoratorMetadata
}

export class DecoratorMetadata {
    constructor(private target: object, private metadata = globalMetadata) {}

    set(metadataKey: any, metadataValue: any, propertyKey: string | symbol): void {
        let targetMetadata = this.metadata.get(this.target)
        if (!targetMetadata) {
            targetMetadata = new Map<string | symbol, Map<any, any>>()
            this.metadata.set(this.target, targetMetadata)
        }
        let propertyMetadata = targetMetadata.get(propertyKey)
        if (!propertyMetadata) {
            propertyMetadata = new Map<any, any>()
            targetMetadata.set(propertyKey, propertyMetadata)
        }
        propertyMetadata.set(metadataKey, metadataValue)
    }

    get<T>(metadataKey: any, target: object = this, propertyKey: string | symbol): T | undefined {
        const targetMetadata = this.metadata.get(target)
        if (targetMetadata) {
            const propertyMetadata = targetMetadata.get(propertyKey)
            if (propertyMetadata) {
                return propertyMetadata.get(metadataKey) as T
            }
        }
        return undefined
    }

    has(metadataKey: any, propertyKey: string | symbol): boolean {
        const targetMetadata = this.metadata.get(this.target)
        if (targetMetadata) {
            const propertyMetadata = targetMetadata.get(propertyKey)
            if (propertyMetadata) {
                return propertyMetadata.has(metadataKey)
            }
        }
        return false
    }
}

export function getDecoratedProperties<TMeta>(decoratorName: string, obj: any): [string, TMeta | undefined][] {
    if (!(obj?.meta instanceof DecoratorMetadata)) {
        throw new Error("this function only works on objects implementing Decorated")
    }
    const meta = obj.meta as DecoratorMetadata
    const propMap = new Map<string, TMeta | undefined>()
    let prototype = Object.getPrototypeOf(obj)
    while (prototype && prototype !== Object.prototype) {
        for (const propName of Object.getOwnPropertyNames(prototype)) {
            if (!propMap.has(propName)) {
                const val = meta.get(decoratorName, prototype, propName) as TMeta | undefined
                propMap.set(propName, val)
            }
        }
        prototype = Object.getPrototypeOf(prototype)
    }
    const props: [string, TMeta | undefined][] = []
    for (const prop of propMap) {
        props.push([prop[0], prop[1]])
    }
    return props
}
