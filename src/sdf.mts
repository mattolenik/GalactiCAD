/**
 * SDFRenderer - Re-exports from proxy (main thread) and worker-core (GPU in worker).
 * The proxy delegates to the render worker for all GPU work.
 */

export {
    SDFRenderer,
    type SelectionMode,
    type OutlineMode,
    type NodeStub,
    type SerializedNode,
    EdgeKind,
} from "./sdf-proxy.mjs"
