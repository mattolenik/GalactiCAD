import ts from "typescript"

// === In-memory source code ===
const sourceText = `
class MyNumber {
  // Static mapping: operator symbols -> method names.
  static __operators = { "+": "add", "-": "negate" };

  constructor(private value: number) {}
  add(rhs: any): MyNumber {
    return new MyNumber(this.value + (rhs instanceof MyNumber ? rhs.value : rhs));
  }
  negate(): MyNumber {
    return new MyNumber(-this.value);
  }
}

const a = new MyNumber(10);
const b = new MyNumber(20);
const c = a + b;       // should transform to: a.add(b)
const d = a + b + c;   // should transform to: a.add(b).add(c)
const e = -a;          // should transform to: a.negate()
`

// === Compiler options ===
const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    incremental: true,
}

// In-memory source file name.
const sourceFileName = "inmemory.ts"

// === Create a custom compiler host using in-memory buffers ===
const compilerHost = ts.createCompilerHost(compilerOptions)
compilerHost.getSourceFile = (fileName, languageVersion) => {
    if (fileName === sourceFileName) {
        return ts.createSourceFile(fileName, sourceText, languageVersion, true)
    }
    const text = ts.sys.readFile(fileName)
    return text !== undefined ? ts.createSourceFile(fileName, text, languageVersion, true) : undefined
}
compilerHost.writeFile = (fileName, contents) => {
    console.log(`Emitted ${fileName}:\n${contents}`)
}

/**
 * Helper: Peel off call-expression wrappers.
 *
 * If an expression is a call expression whose function is a property access,
 * we repeatedly peel off the call to get at the base expression.
 */
function peelExpression(expr: ts.Expression): ts.Expression {
    while (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
        expr = expr.expression.expression
    }
    return expr
}

/**
 * Helper: Extract operator mapping from a class declaration via its static __operators property.
 * We now look for the static member in the classSymbol's exports.
 */
function getOperatorMappingFromClass(classDecl: ts.ClassDeclaration, typeChecker: ts.TypeChecker): Map<string, string> {
    const mapping = new Map<string, string>()
    if (!classDecl.name) return mapping
    const classSymbol = typeChecker.getSymbolAtLocation(classDecl.name)
    if (!classSymbol) return mapping

    // Static members are stored in exports.
    const staticMember = classSymbol.exports?.get("__operators" as ts.__String) || classSymbol.exports?.get("___operators" as ts.__String) // sometimes extra underscore may appear
    if (!staticMember) return mapping

    for (const decl of staticMember.getDeclarations() || []) {
        if (
            (ts.isPropertyDeclaration(decl) || ts.isPropertyAssignment(decl)) &&
            decl.initializer &&
            ts.isObjectLiteralExpression(decl.initializer)
        ) {
            const objLit = decl.initializer
            for (const prop of objLit.properties) {
                if (ts.isPropertyAssignment(prop)) {
                    let key: string | undefined
                    if (ts.isIdentifier(prop.name)) {
                        key = prop.name.text
                    } else if (ts.isStringLiteral(prop.name)) {
                        key = prop.name.text
                    }
                    if (key && ts.isStringLiteral(prop.initializer)) {
                        mapping.set(key, prop.initializer.text)
                    }
                }
            }
        }
    }
    return mapping
}

/**
 * Helper: For a given expression, retrieve the operator function name
 * from its class's static __operators property.
 * We "peel" the expression to get to the base object.
 */
function getOperatorFunctionForExpression(expression: ts.Expression, operator: string, typeChecker: ts.TypeChecker): string | undefined {
    // Peel off any call wrappers (from previous transformations)
    const baseExpr = peelExpression(expression)
    const exprType = typeChecker.getTypeAtLocation(baseExpr)
    const symbol = exprType.getSymbol() || exprType.aliasSymbol
    if (!symbol) return undefined
    const declarations = symbol.getDeclarations()
    if (!declarations) return undefined

    for (const decl of declarations) {
        let classDecl: ts.ClassDeclaration | undefined
        if (ts.isClassDeclaration(decl)) {
            classDecl = decl
        } else if (decl.parent && ts.isClassDeclaration(decl.parent)) {
            classDecl = decl.parent
        }
        if (classDecl) {
            const mapping = getOperatorMappingFromClass(classDecl, typeChecker)
            if (mapping.has(operator)) {
                return mapping.get(operator)
            }
        }
    }
    return undefined
}

/**
 * Custom Operator Transformer.
 * Transforms prefix unary expressions (e.g. -a) into a.negate()
 * and binary expressions (e.g. a + b) into a.add(b), using the static __operators mapping.
 */
function customOperatorTransformer(program: ts.Program): ts.TransformerFactory<ts.SourceFile> {
    const typeChecker = program.getTypeChecker()
    return (context: ts.TransformationContext) => {
        const visitor: ts.Visitor = (node: ts.Node): ts.Node => {
            // Recursively visit children first.
            node = ts.visitEachChild(node, visitor, context)

            // Transform prefix unary expressions (e.g. -a -> a.negate())
            if (ts.isPrefixUnaryExpression(node)) {
                const opStr = ts.tokenToString(node.operator)
                if (opStr) {
                    const funcName = getOperatorFunctionForExpression(node.operand, opStr, typeChecker)
                    if (funcName) {
                        return ts.factory.createCallExpression(
                            ts.factory.createPropertyAccessExpression(node.operand, ts.factory.createIdentifier(funcName)),
                            undefined,
                            [] // Unary operator: no additional arguments.
                        )
                    }
                }
            }

            // Transform binary expressions (e.g. a + b -> a.add(b))
            if (ts.isBinaryExpression(node)) {
                const opStr = ts.tokenToString(node.operatorToken.kind)
                if (opStr) {
                    const funcName = getOperatorFunctionForExpression(node.left, opStr, typeChecker)
                    if (funcName) {
                        return ts.factory.createCallExpression(
                            ts.factory.createPropertyAccessExpression(node.left, ts.factory.createIdentifier(funcName)),
                            undefined,
                            [node.right]
                        )
                    }
                }
            }
            return node
        }
        return (node: ts.SourceFile) => ts.visitNode(node, visitor) as ts.SourceFile
    }
}

const startTime = performance.now()
const program = ts.createProgram([sourceFileName], compilerOptions, compilerHost)
const sourceFile = program.getSourceFile(sourceFileName)

const { emitSkipped, diagnostics } = program.emit(sourceFile, undefined, undefined, false, { before: [customOperatorTransformer(program)] })

if (emitSkipped) {
    console.error("Emit skipped due to diagnostics:")
    diagnostics.forEach((d) => {
        console.error(ts.flattenDiagnosticMessageText(d.messageText, "\n"))
    })
} else {
    console.log("Transformation complete. Check the emitted output above.")
}

// const sourceFile = program.getSourceFile(sourceFileName)
// if (sourceFile) {
//     const transformationResult = ts.transform(sourceFile, [customOperatorTransformer(program)])
//     const transformedSourceFile = transformationResult.transformed[0] as ts.SourceFile

//     // Create a printer and print the transformed AST back to a string.
//     const printer = ts.createPrinter()
//     const outputText = printer.printFile(transformedSourceFile)

//     console.log("Emitted TypeScript:\n" + outputText)

//     transformationResult.dispose()
// } else {
//     console.error("Source file not found.")
// }

const elapsed = performance.now() - startTime
console.log(`${elapsed.toFixed(2)}ms\n`)
