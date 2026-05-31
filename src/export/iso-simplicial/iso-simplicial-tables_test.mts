import assert from "node:assert/strict"
import test from "node:test"
import { IsoSimplicialConstants } from "./constants.mjs"
import {
    cubeCornerBits,
    cubeCornerIndex,
    cubeEdge2Orient,
    cubeEdge2Vert,
    cubeFace2Edge,
    cubeFace2Opposite,
    cubeFace2Orient,
    cubeFace2Vert,
    cubeOrient2Edge,
    cubeOrient2Face,
} from "./cube-tables.mjs"
import { extractFaceTable, extractFlipTable, TraversalType } from "./extract-tables.mjs"
import { tetEdge2Vert, tetTris, tetTrisNum, tetTriStrips } from "./tet-tables.mjs"

test("IsoSimplicialConstants matches reference main.cpp defaults", () => {
    assert.equal(IsoSimplicialConstants.oversampleQef, 4)
    assert.equal(IsoSimplicialConstants.dualVertexBorderFraction, 1 / 16)
    assert.equal(IsoSimplicialConstants.depthMin, 4)
    assert.equal(IsoSimplicialConstants.depthMax, 7)
    // Intentional override of reference default (main.cpp FIND_ROOT_DEPTH = 0);
    // bumped to 2 in fce8db4 alongside the QEF eigenvalue threshold change.
    assert.equal(IsoSimplicialConstants.findRootDepth, 2)
    assert.equal(IsoSimplicialConstants.qefRelativeErrorRefineThreshold, 1e-3)
})

test("cube tables: sizes", () => {
    assert.equal(cubeEdge2Vert.length, 12)
    assert.equal(cubeFace2Vert.length, 6)
    assert.equal(cubeFace2Edge.length, 6)
    assert.equal(cubeFace2Orient.length, 6)
    assert.equal(cubeFace2Opposite.length, 6)
    assert.equal(cubeOrient2Face.length, 3)
    assert.equal(cubeOrient2Edge.length, 3)
    assert.equal(cubeEdge2Orient.length, 12)
})

test("cube tables: spot-check cube_edge2vert / cube_face2vert vs reference", () => {
    assert.deepEqual(cubeEdge2Vert[0], [0, 1])
    assert.deepEqual(cubeEdge2Vert[11], [6, 7])
    assert.deepEqual(cubeFace2Vert[0], [0, 1, 3, 2])
    assert.deepEqual(cubeFace2Vert[5], [4, 6, 7, 5])
})

test("cube tables: cube_orient2edge[2] parallel z edges", () => {
    assert.deepEqual([...cubeOrient2Edge[2]], [4, 5, 6, 7])
})

test("cubeCornerIndex matches reference Index bit layout", () => {
    assert.equal(cubeCornerIndex(0, 0, 0), 0)
    assert.equal(cubeCornerIndex(1, 0, 0), 1)
    assert.equal(cubeCornerIndex(0, 1, 0), 2)
    assert.equal(cubeCornerIndex(1, 1, 0), 3)
    assert.equal(cubeCornerIndex(0, 0, 1), 4)
    assert.equal(cubeCornerIndex(1, 1, 1), 7)
    for (let i = 0; i < 8; i++) {
        const [x, y, z] = cubeCornerBits(i)
        assert.equal(cubeCornerIndex(x, y, z), i)
    }
})

test("tet tables: sizes", () => {
    assert.equal(tetEdge2Vert.length, 6)
    assert.equal(tetTrisNum.length, 16)
    assert.equal(tetTris.length, 16)
    assert.equal(tetTriStrips.length, 16)
    for (const row of tetTris) assert.equal(row.length, 7)
    for (const row of tetTriStrips) assert.equal(row.length, 5)
})

test("tet tables: spot-check marching-tet cases vs reference", () => {
    assert.equal(tetTrisNum[0], 0)
    assert.equal(tetTrisNum[15], 0)
    assert.deepEqual([...tetTris[1]], [0, 2, 4, -1, -1, -1, -1])
    assert.deepEqual([...tetTris[3]], [0, 1, 4, 4, 1, 5, -1])
    assert.deepEqual([...tetTris[7]], [3, 5, 4, -1, -1, -1, -1])
    assert.deepEqual([...tetTriStrips[3]], [4, 0, 1, 4, 5])
    assert.deepEqual([...tetEdge2Vert[0]], [0, 2])
    assert.deepEqual([...tetEdge2Vert[5]], [1, 3])
})

test("extract tables: dimensions and sample cells from visitorextract.cpp", () => {
    assert.equal(extractFaceTable.length, 3)
    assert.equal(extractFlipTable.length, 3)
    for (const row of extractFaceTable) assert.equal(row.length, 4)
    for (const row of extractFlipTable) assert.equal(row.length, 4)

    assert.deepEqual(extractFaceTable[0][0], [1, 0])
    assert.deepEqual(extractFaceTable[1][2], [2, 5])
    assert.deepEqual(extractFaceTable[2][3], [3, 4])
    assert.deepEqual([...extractFlipTable[0]], [true, false, false, true])
    assert.deepEqual([...extractFlipTable[1]], [false, true, true, false])
})

test("TraversalType enum matches traverse.h order", () => {
    assert.equal(TraversalType.trav_node, 0)
    assert.equal(TraversalType.trav_face, 1)
    assert.equal(TraversalType.trav_edge, 2)
    assert.equal(TraversalType.trav_vert, 3)
})
