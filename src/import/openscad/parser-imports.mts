/**
 * Deep imports from `openscad-parser`, deliberately bypassing its package barrel.
 *
 * The barrel (`openscad-parser`) re-exports Node-only IDE modules — `semantic/*`
 * (IncludeResolver, FilenameCompletionProvider), `prelude/PreludeUtil`, `SolutionManager`,
 * and `CodeFile` — that `require("fs"/"os"/"path")`. Importing it makes the browser esbuild
 * bundle fail with "Could not resolve fs/os/path". The lexer/parser/AST themselves are clean,
 * so we import only those by their dist paths.
 *
 * `CodeFile` is intentionally a TYPE-only import (it pulls fs/path for its unused `load()`); we
 * fabricate a structural CodeFile in convert.mts — the lexer only reads `.code`/`.path`/`.filename`.
 *
 * Named exports (the AST classes) resolve identically under esbuild and tsx/Node, so `instanceof`
 * keeps the same class identity the parser uses. The `default` exports do NOT: esbuild unwraps
 * `export default` to its value, while tsx/Node yields the whole `module.exports`
 * (`{ __esModule, default }`). `interopDefault` reconciles the two.
 */

import ParsingHelperDefault from "openscad-parser/dist/ParsingHelper.js"
import TokenTypeDefault from "openscad-parser/dist/TokenType.js"
import AssignmentNodeDefault from "openscad-parser/dist/ast/AssignmentNode.js"

export {
    BinaryOpExpr,
    type Expression,
    FunctionCallExpr,
    GroupingExpr,
    LiteralExpr,
    LookupExpr,
    RangeExpr,
    TernaryExpr,
    UnaryOpExpr,
    VectorExpr,
} from "openscad-parser/dist/ast/expressions.js"
export {
    BlockStmt,
    FunctionDeclarationStmt,
    IfElseStatement,
    IncludeStmt,
    ModuleDeclarationStmt,
    ModuleInstantiationStmt,
    type Statement,
    UseStmt,
} from "openscad-parser/dist/ast/statements.js"
export type { default as CodeFile } from "openscad-parser/dist/CodeFile.js"
export type { default as ScadFile } from "openscad-parser/dist/ast/ScadFile.js"

function interopDefault<T>(mod: T): T {
    const m = mod as { __esModule?: boolean; default?: unknown }
    return (m && m.__esModule === true && "default" in m ? m.default : mod) as T
}

export const ParsingHelper = interopDefault(ParsingHelperDefault)
export const TokenType = interopDefault(TokenTypeDefault)
export const AssignmentNode = interopDefault(AssignmentNodeDefault)
export type AssignmentNode = InstanceType<typeof AssignmentNodeDefault>
