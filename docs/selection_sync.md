# Selection Synchronization: Bidirectional Scene-Code Linking

This document describes the design and implementation of the bidirectional selection synchronization feature that links objects in the SDF preview to their corresponding source code in the Monaco editor.

## Overview

The selection system provides two-way synchronization:

1. **Preview → Editor**: Clicking on a shape in the 3D preview highlights the corresponding function call in the source code
2. **Editor → Preview**: Selecting a function name or clicking its color indicator selects the corresponding object in the preview

This requires a reliable mapping between runtime scene objects and their source code locations.

## Problem Statement

### Why This Is Difficult

The naive approach of matching scene nodes to source code by traversal order fails for several reasons:

1. **Traversal Order Mismatch**: The AST parser walks the code in evaluation order (arguments before function call), but the scene builds nodes in a different order (parent before children in `build()`).

2. **Intermediate Nodes**: Helper functions like `union(a, b, c)` create multiple internal `Union` nodes from a single function call, breaking 1:1 correspondence.

3. **Argument Order Reversal**: The `union()` and `subtract()` helpers use `args.pop()` which processes arguments in reverse order.

### Example of the Problem

For code like:
```javascript
union(
    sphere("0 0 0", {r: 5}),
    box("10 0 0", "5 5 5")
)
```

- **Parser order**: sphere(index 0), box(index 1), union(index 2)
- **Scene build order**: union(ID 0), sphere(ID 1), box(ID 2)

The indices don't match, so the wrong code gets highlighted.

## Solution: Property-Based Matching

Instead of relying on traversal order, we match scene objects to source code by comparing their actual property values.

### Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Source Code   │     │   AST Parser     │     │  Parsed Calls   │
│                 │────▶│ (source-parser)  │────▶│  with values    │
│ sphere("0 0 5", │     │                  │     │  pos, r, size   │
│   {r: 10})      │     └──────────────────┘     └────────┬────────┘
└─────────────────┘                                       │
                                                          │ Match by
┌─────────────────┐     ┌──────────────────┐              │ property
│  Scene Graph    │     │   Scene Nodes    │              │ values
│                 │────▶│  with actual     │◀─────────────┘
│  SceneInfo      │     │  properties      │
└─────────────────┘     └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  ID → Location   │
                        │      Map         │
                        └──────────────────┘
```

### Data Flow

1. **Parse Source Code** → Extract all shape function calls with their argument values
2. **Build Scene** → Create scene nodes with actual property values
3. **Match Nodes** → Compare node properties to parsed arguments
4. **Create Map** → Node ID → Source Location
5. **Highlight** → Use source locations to highlight Monaco editor

## Implementation

### File Structure

```
src/
├── parser/
│   ├── source-parser.mts   # AST parsing and argument extraction
│   └── node-matcher.mts    # Property-based matching logic
├── scene/
│   └── scene.mts           # Scene nodes with getShapeType()
└── app.mts                 # Integration point
```

### 1. Source Parser (`source-parser.mts`)

The parser extracts shape function calls with their parsed argument values.

#### Key Types

```typescript
interface ParsedShapeCall {
    location: SourceLocation    // Exact AST position
    functionName: string        // "sphere", "box", etc.
    pos?: Vec3f                 // Parsed position vector
    size?: Vec3f                // Parsed size (for box)
    r?: number                  // Parsed radius (for sphere)
    d?: number                  // Parsed diameter (alternative)
}

interface SourceLocation {
    startLine: number           // 1-based (Monaco convention)
    startColumn: number         // 1-based
    endLine: number
    endColumn: number
    functionName: string
}
```

#### Argument Parsing

The parser evaluates AST expressions to extract actual values:

```typescript
// Handles string literals like "1 2 3"
case "Literal":
    return (node as any).value

// Handles arrays like [1, 2, 3]
case "ArrayExpression":
    // Recursively evaluate elements

// Handles negative numbers like -5
case "UnaryExpression":
    if (unary.operator === "-") {
        return -this.evaluateExpression(unary.argument)
    }
```

For sphere arguments:
```typescript
private parseSphereArgs(callNode: CallExpression, parsedCall: ParsedShapeCall): void {
    // First arg: position string or array → Vec3f
    const posValue = this.evaluateExpression(callNode.arguments[0])
    parsedCall.pos = vec3(posValue)
    
    // Second arg: {r?, d?} object
    // Extract r or d from object properties
}
```

### 2. Node Matcher (`node-matcher.mts`)

Matches scene nodes to parsed calls by comparing property values.

#### Matching Logic

```typescript
function matchNodeToCall(node: Node, call: ParsedShapeCall): boolean {
    // Type must match
    if (node.getShapeType() !== call.functionName) {
        return false
    }
    
    if (node instanceof Sphere) {
        // Position must match (with floating-point tolerance)
        if (!vec3ApproxEqual(node.pos, call.pos)) return false
        
        // Radius must match
        const expectedRadius = call.r ?? (call.d / 2)
        if (!approxEqual(node.r, expectedRadius)) return false
        
        return true
    }
    
    if (node instanceof Box) {
        // Position and size must match
        if (!vec3ApproxEqual(node.pos, call.pos)) return false
        if (!vec3ApproxEqual(node.size, call.size)) return false
        
        return true
    }
    
    return false
}
```

#### Floating-Point Comparison

Uses epsilon tolerance for comparing floating-point values:

```typescript
const EPSILON = 1e-6

function approxEqual(a: number, b: number): boolean {
    return Math.abs(a - b) < EPSILON
}

function vec3ApproxEqual(a: Vec3f, b: Vec3f): boolean {
    return approxEqual(a.x, b.x) && 
           approxEqual(a.y, b.y) && 
           approxEqual(a.z, b.z)
}
```

### 3. Scene Nodes (`scene.mts`)

Each node class implements `getShapeType()` for type identification:

```typescript
export class Node {
    getShapeType(): string { return "node" }
}

export class Sphere extends ... {
    override getShapeType(): string { return "sphere" }
}

export class Box extends ... {
    override getShapeType(): string { return "box" }
}

export class Union extends BinaryOperator {
    override getShapeType(): string { return "union" }
}
```

The `SceneInfo` class provides access to all nodes:

```typescript
getAllNodes(): Node[] {
    return Array.from(this.#nodes.values())
}
```

### 4. Integration (`app.mts`)

The `build()` method orchestrates the matching:

```typescript
build() {
    const src = this.editor.getValue()
    
    // 1. Build the scene (executes user code)
    this.renderer.build(src)
    
    // 2. Parse source to extract shape calls with argument values
    const parsedCalls = this.#sourceParser.parseShapeCalls(src)
    
    // 3. Get all nodes from the built scene
    const sceneNodes = this.renderer.getSceneNodes()
    
    // 4. Match nodes to source by property comparison
    this.#sourceLocationMap = matchNodesToSource(sceneNodes, parsedCalls)
}
```

When selection changes:

```typescript
#updateEditorHighlighting() {
    for (const id of selectedIds) {
        const location = this.#sourceLocationMap.get(id)
        if (location) {
            // AST provides exact range - no guessing needed
            highlightRanges.push({
                startLine: location.startLine,
                startColumn: location.startColumn,
                endLine: location.endLine,
                endColumn: location.endColumn
            })
        }
    }
}
```

## Vector String Parsing

User code uses string syntax for vectors:

```javascript
sphere("0 5 -10", {r: 3})
box("1 2 3", "10 10 10")
```

The `Vec3f` class parses these strings:

```typescript
// In vector.mts
function parseVec(v: string): number[] {
    return v.trim()
        .replace(/^[\{\[\(]/, "")    // Remove opening brackets
        .replace(/[\}\]\)]$/, "")    // Remove closing brackets
        .split(/(?:\s*,\s*)|\s+/)    // Split on commas or whitespace
        .map(e => parseFloat(e))
}
```

This allows matching the parsed string `"0 5 -10"` to the scene node's `pos: Vec3f(0, 5, -10)`.

## Advantages

1. **Deterministic**: Matches by actual values, not traversal order
2. **Accurate**: Source locations come directly from AST (exact character positions)
3. **Robust**: Works regardless of code structure, nesting, or formatting
4. **Simple Logic**: No complex order-matching algorithms needed

## Limitations

1. **Primitives Only**: Only `sphere` and `box` can be matched by property values
2. **Unique Values Required**: Two identical spheres (same pos, same radius) cannot be distinguished
3. **Composites Not Matched**: `union`, `subtract`, `group` don't have unique identifying properties

## Color Indicators

The editor displays colored square indicators next to each shape function call. These indicators match the color of the shape in the 3D preview and are clickable for selection.

### Implementation

1. **Palette Colors**: Uses the same 32-color pastel palette as the shader (`colorPalette.mts`)
2. **Color Assignment**: `palette[nodeId % PALETTE_SIZE]` - same formula as the GPU shader
3. **CSS Generation**: Dynamic CSS classes are generated for each palette color
4. **Monaco Decorations**: Uses `before` decorators to insert colored squares before function names
5. **Click Handling**: Clicking on the indicator selects the corresponding object in the preview

### CSS Structure

```css
.shape-color-0 {
    background-color: rgb(255, 179, 179);  /* Light coral */
    border-radius: 1px;
    color: transparent !important;
    font-size: 0.85em;
    margin-right: 2px;
}
/* ... 31 more color classes */
```

### Visual Result

```
██ sphere("0 0 0", {r: 5})      // Coral indicator
██ box("10 0 0", "5 5 5")       // Peach indicator
██ sphere("0 10 0", {r: 3})     // Yellow indicator
```

The color indicators:
- Are always visible (not just when selected)
- Update when the scene builds successfully
- Persist during transient errors while editing
- Match the exact colors shown in the 3D preview
- Are clickable to select the corresponding object

## Bidirectional Selection

### Preview → Editor (Preview Selection)

When clicking on an object in the 3D preview:

1. GPU shader identifies clicked object ID via ray marching
2. `SDFRenderer.onSelectionChange` callback fires
3. `App.#updateEditorHighlighting()` looks up source location from map
4. Monaco decorations highlight the function name

### Editor → Preview (Code Selection)

Selection from the editor to the preview is triggered in two ways:

#### 1. Function Name Selection

When the user selects (highlights) exactly a function name in the editor:

```typescript
#handleEditorSelection() {
    const selection = this.editor.getSelection()
    
    // Check if selection exactly matches a function name
    for (const [nodeId, location] of this.#sourceLocationMap.entries()) {
        if (selection matches location exactly) {
            this.renderer.setSelection([nodeId])
            break
        }
    }
}
```

This works when:
- Double-clicking a function name (auto-selects the word)
- Manually selecting the exact text of a function name

#### 2. Color Indicator Click

When the user clicks on or near the color indicator:

```typescript
#handleEditorMouseDown(e: monaco.editor.IEditorMouseEvent) {
    const position = e.target.position
    
    // Find shape at this position
    const nodeId = this.#findNodeIdAtPosition(position.lineNumber, position.column)
    
    // If clicking before/on the function name (where indicator is)
    if (position.column <= location.startColumn) {
        this.renderer.setSelection([nodeId])
    }
}
```

### Preventing Feedback Loops

A flag prevents infinite selection loops between editor and preview:

```typescript
#isUpdatingFromPreview = false

// When preview selection changes:
this.renderer.onSelectionChange = () => {
    this.#isUpdatingFromPreview = true
    this.#updateEditorHighlighting()
    setTimeout(() => { this.#isUpdatingFromPreview = false }, 50)
}

// Editor handlers check the flag:
#handleEditorSelection() {
    if (this.#isUpdatingFromPreview) return
    // ... handle selection
}
```

### SDFRenderer.setSelection()

The renderer exposes a method for programmatic selection:

```typescript
setSelection(ids: number[], notify = false) {
    this.#selectedObjectIds = []
    for (const id of ids) {
        this.#selectedObjectIds[id] = true
    }
    this.#writeSelectionBuffer()

    if (notify && this.onSelectionChange) {
        this.onSelectionChange(this.selectedObjectIds)
    }
}
```

The `notify` parameter defaults to `false` to avoid triggering the callback when selection comes from the editor (preventing loops).

## Future Enhancements

1. **Composite Matching**: Match composites by their child structure
2. **Duplicate Handling**: Use source order as tiebreaker for identical shapes
3. **Multi-select from Editor**: Support shift-click or multi-cursor selection
