import * as ts from "typescript"

// === In-memory source code ===
const sourceText = `
interface CustomOperator {
  op(operator: string): any;
  op(operator: string, rhs: any): any;
}

class MyNumber implements CustomOperator {
  constructor(private value: number) {}
  op(operator: string, rhs?: any): any {
    if (operator === "+") {
      return this.value + (rhs instanceof MyNumber ? rhs.value : rhs);
    } else if (operator === "-") {
      return -this.value;
    }
  }
}

const a: MyNumber = new MyNumber(10);
const b: MyNumber = new MyNumber(20);
const c = a + b; // should transform to: a.op("+", b)
const d = -a;    // should transform to: a.op("-")
`

// === Compiler options ===
const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    // No decorators needed here
}

// Name of our in-memory source file.
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

// Redirect output to the console.
compilerHost.writeFile = (fileName, contents) => {
    console.log(`Emitted ${fileName}:\n${contents}`)
}

// === Helper: Retrieve the type for the CustomOperator interface. ===
function getCustomOperatorInterfaceType(program: ts.Program, sourceFile: ts.SourceFile): ts.Type | undefined {
    const typeChecker = program.getTypeChecker()
    // Get all interfaces in scope
    const symbols = typeChecker.getSymbolsInScope(sourceFile, ts.SymbolFlags.Interface)
    const customOperatorSymbol = symbols.find((s) => s.getName() === "CustomOperator")
    if (customOperatorSymbol) {
        return typeChecker.getDeclaredTypeOfSymbol(customOperatorSymbol)
    }
    return undefined
}

// === Custom Operator Transformer ===
function customOperatorTransformer(program: ts.Program): ts.TransformerFactory<ts.SourceFile> {
    const typeChecker = program.getTypeChecker()

    // Retrieve the CustomOperator interface type from the program.
    const sourceFile = program.getSourceFile(sourceFileName)
    if (!sourceFile) {
        throw new Error("Source file not found")
    }

    const customOperatorType = getCustomOperatorInterfaceType(program, sourceFile)
    if (!customOperatorType) {
        console.error("CustomOperator interface not found in scope.")
        return (context) => (node) => node
    }

    // Helper: Check whether an expression’s type supports CustomOperator.
    const supportsOperatorForExpression = (expression: ts.Expression) => {
        const exprType = typeChecker.getTypeAtLocation(expression)
        return typeChecker.isTypeAssignableTo(exprType, customOperatorType)
    }

    return (context: ts.TransformationContext) => {
        const visitor: ts.Visitor = (node: ts.Node): ts.Node => {
            // First, recursively visit children.
            node = ts.visitEachChild(node, visitor, context)

            // Then, if this node is an operator expression, transform it.
            // For prefix unary expressions (e.g. -a -> a.op("-", ))
            if (ts.isPrefixUnaryExpression(node)) {
                const opStr = ts.tokenToString(node.operator)
                if (opStr && supportsOperatorForExpression(node.operand)) {
                    return ts.factory.createCallExpression(
                        ts.factory.createPropertyAccessExpression(node.operand, ts.factory.createIdentifier("op")),
                        undefined,
                        [ts.factory.createStringLiteral(opStr)]
                    )
                }
            }
            // For binary expressions (e.g. a + b -> a.op("+", b))
            if (ts.isBinaryExpression(node)) {
                const opStr = ts.tokenToString(node.operatorToken.kind)
                if (opStr && supportsOperatorForExpression(node.left)) {
                    return ts.factory.createCallExpression(
                        ts.factory.createPropertyAccessExpression(node.left, ts.factory.createIdentifier("op")),
                        undefined,
                        [ts.factory.createStringLiteral(opStr), node.right]
                    )
                }
            }
            return node
        }

        return (node: ts.SourceFile) => ts.visitNode(node, visitor) as ts.SourceFile
    }
}

// === Create a Program and apply the transformer ===
const program = ts.createProgram([sourceFileName], compilerOptions, compilerHost)

const { emitSkipped, diagnostics } = program.emit(undefined, undefined, undefined, false, { before: [customOperatorTransformer(program)] })

if (emitSkipped) {
    console.error("Emit skipped due to diagnostics:")
    diagnostics.forEach((d) => {
        console.error(ts.flattenDiagnosticMessageText(d.messageText, "\n"))
    })
} else {
    console.log("Transformation complete. Check the emitted output above.")
}
