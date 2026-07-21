// FILE: cliPublishContract.ts
// Purpose: Verifies that publishable CLI entry bundles contain Synara's patched process runtime.
// Layer: Server build and publish tooling.

import ts from "typescript";

const PATCHED_EFFECT_RUNTIME_ENTRY_FILES = ["index.mjs", "index.cjs"] as const;
const EFFECT_PLATFORM_NODE_EXTERNAL_IMPORT =
  /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']@effect\/platform-node(?:-shared)?(?:\/[^"']*)?["']/u;

export interface RuntimeBundle {
  readonly path: string;
  readonly source: string;
}

function expressionPath(expression: ts.Expression): ReadonlyArray<string> | undefined {
  if (ts.isParenthesizedExpression(expression)) return expressionPath(expression.expression);
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) {
    const parentPath = expressionPath(expression.expression);
    return parentPath === undefined ? undefined : [...parentPath, expression.name.text];
  }
  return undefined;
}

function expressionHasPath(expression: ts.Expression, expected: ReadonlyArray<string>): boolean {
  const actual = expressionPath(expression);
  return actual !== undefined && actual.join(".") === expected.join(".");
}

function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function objectLiteralPropertyNameText(property: ts.ObjectLiteralElementLike): string | undefined {
  return "name" in property ? propertyNameText(property.name) : undefined;
}

function staticBooleanValue(expression: ts.Expression): boolean | undefined {
  if (ts.isParenthesizedExpression(expression)) {
    return staticBooleanValue(expression.expression);
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(expression)) return Number(expression.text) !== 0;
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const operand = staticBooleanValue(expression.operand);
    return operand === undefined ? undefined : !operand;
  }
  return undefined;
}

function statementStopsFollowingExecution(statement: ts.Statement): boolean {
  if (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  ) {
    return true;
  }
  if (ts.isBlock(statement)) {
    return statement.statements.some(statementStopsFollowingExecution);
  }
  if (ts.isIfStatement(statement) && statement.elseStatement !== undefined) {
    return (
      statementStopsFollowingExecution(statement.thenStatement) &&
      statementStopsFollowingExecution(statement.elseStatement)
    );
  }
  return false;
}

type ReachabilityBoundary = ts.Block | ts.CaseClause | ts.SourceFile;

function isNodeReachableWithin(
  node: ts.Node,
  boundary: ReachabilityBoundary,
  crossFunctionBoundaries = false,
): boolean {
  let candidate = node;
  while (candidate !== boundary) {
    const parent = candidate.parent;
    if (parent === undefined) return false;
    if (ts.isFunctionLike(parent) && !crossFunctionBoundaries) return false;

    if (ts.isIfStatement(parent)) {
      const condition = staticBooleanValue(parent.expression);
      if (
        (candidate === parent.thenStatement && condition === false) ||
        (candidate === parent.elseStatement && condition === true)
      ) {
        return false;
      }
    } else if (ts.isConditionalExpression(parent)) {
      const condition = staticBooleanValue(parent.condition);
      if (
        (candidate === parent.whenTrue && condition === false) ||
        (candidate === parent.whenFalse && condition === true)
      ) {
        return false;
      }
    } else if (ts.isBinaryExpression(parent) && candidate === parent.right) {
      const left = staticBooleanValue(parent.left);
      if (
        (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && left === false) ||
        (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken && left === true)
      ) {
        return false;
      }
    } else if (
      (ts.isWhileStatement(parent) || ts.isForStatement(parent)) &&
      candidate === parent.statement &&
      parent.expression !== undefined &&
      staticBooleanValue(parent.expression) === false
    ) {
      return false;
    }

    if (ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isSourceFile(parent)) {
      const statementIndex = parent.statements.findIndex((statement) => statement === candidate);
      if (
        statementIndex >= 0 &&
        parent.statements.slice(0, statementIndex).some(statementStopsFollowingExecution)
      ) {
        return false;
      }
    }
    candidate = parent;
  }
  return true;
}

function isNodeStaticallyReachable(node: ts.Node): boolean {
  return isNodeReachableWithin(node, node.getSourceFile(), true);
}

type StandardCommandExecutionContainer = ts.Block | ts.CaseClause;

interface ProcessSpawnerPatchProof {
  readonly caseClause: ts.CaseClause;
  readonly container: StandardCommandExecutionContainer;
  readonly statement: ts.Statement;
  readonly effectNamespace: ReadonlyArray<string>;
}

function standardCommandCaseForDirectNode(node: ts.Node): ts.CaseClause | undefined {
  let candidate = node.parent;
  while (candidate !== undefined) {
    if (ts.isFunctionLike(candidate)) return undefined;
    if (ts.isCaseClause(candidate)) {
      return ts.isStringLiteral(candidate.expression) &&
        candidate.expression.text === "StandardCommand"
        ? candidate
        : undefined;
    }
    candidate = candidate.parent;
  }
  return undefined;
}

function directExecutionLocation(
  node: ts.Node,
  caseClause: ts.CaseClause,
): Pick<ProcessSpawnerPatchProof, "container" | "statement"> | undefined {
  let candidate: ts.Node = node;
  while (candidate.parent !== undefined) {
    const parent = candidate.parent;
    if (parent === caseClause) {
      return ts.isStatement(candidate)
        ? { container: caseClause, statement: candidate }
        : undefined;
    }
    if (ts.isBlock(parent)) {
      if (parent.parent !== caseClause || !ts.isStatement(candidate)) return undefined;
      return { container: parent, statement: candidate };
    }
    candidate = parent;
  }
  return undefined;
}

function enclosingAcquireReleaseCall(node: ts.Node): ts.CallExpression | undefined {
  let candidate = node.parent;
  while (candidate !== undefined && !ts.isCaseClause(candidate)) {
    if (
      ts.isCallExpression(candidate) &&
      expressionPath(candidate.expression)?.at(-1) === "acquireRelease"
    ) {
      return candidate;
    }
    candidate = candidate.parent;
  }
  return undefined;
}

interface AcquireReleaseFinalizerProof {
  readonly declaration: ts.FunctionLikeDeclaration;
  readonly body: ts.Block;
}

function acquireReleaseFinalizerProof(
  node: ts.Node,
  acquireRelease: ts.CallExpression,
): AcquireReleaseFinalizerProof | undefined {
  let candidate: ts.Node | undefined = node.parent;
  let finalizer: ts.FunctionLikeDeclaration | undefined;
  while (candidate !== undefined && candidate !== acquireRelease) {
    if (ts.isFunctionLike(candidate)) {
      if (finalizer !== undefined) return undefined;
      finalizer = candidate;
    }
    candidate = candidate.parent;
  }
  if (
    candidate !== acquireRelease ||
    finalizer?.body === undefined ||
    !ts.isBlock(finalizer.body)
  ) {
    return undefined;
  }

  let argumentRoot: ts.Node = finalizer;
  while (argumentRoot.parent !== acquireRelease) {
    if (argumentRoot.parent === undefined) return undefined;
    argumentRoot = argumentRoot.parent;
  }
  return acquireRelease.arguments[1] === argumentRoot
    ? { declaration: finalizer, body: finalizer.body }
    : undefined;
}

function isExactExternalSupervisionFinalizerParameter(
  finalizer: ts.FunctionLikeDeclaration,
): boolean {
  const [parameter] = finalizer.parameters;
  if (
    finalizer.parameters.length !== 1 ||
    parameter === undefined ||
    parameter.dotDotDotToken !== undefined ||
    parameter.initializer !== undefined ||
    !ts.isArrayBindingPattern(parameter.name) ||
    parameter.name.elements.length !== 2
  ) {
    return false;
  }

  const [childProcess, exitSignal] = parameter.name.elements;
  return (
    childProcess !== undefined &&
    !ts.isOmittedExpression(childProcess) &&
    childProcess.dotDotDotToken === undefined &&
    childProcess.propertyName === undefined &&
    childProcess.initializer === undefined &&
    ts.isIdentifier(childProcess.name) &&
    childProcess.name.text === "childProcess" &&
    exitSignal !== undefined &&
    !ts.isOmittedExpression(exitSignal) &&
    exitSignal.dotDotDotToken === undefined &&
    exitSignal.propertyName === undefined &&
    exitSignal.initializer === undefined &&
    ts.isIdentifier(exitSignal.name) &&
    exitSignal.name.text === "exitSignal"
  );
}

function externalSupervisionGuardIsFirstStatement(
  guard: ts.IfStatement,
  finalizerBody: ts.Block,
): boolean {
  return guard.parent === finalizerBody && finalizerBody.statements[0] === guard;
}

function directAcquireReleaseChildBinding(
  call: ts.CallExpression,
): ts.VariableDeclaration | undefined {
  const yieldExpression = call.parent;
  if (
    !ts.isYieldExpression(yieldExpression) ||
    yieldExpression.asteriskToken === undefined ||
    yieldExpression.expression !== call
  ) {
    return undefined;
  }
  const declaration = yieldExpression.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== yieldExpression ||
    !ts.isArrayBindingPattern(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return undefined;
  }
  const first = declaration.name.elements[0];
  return first !== undefined &&
    !ts.isOmittedExpression(first) &&
    first.dotDotDotToken === undefined &&
    first.propertyName === undefined &&
    first.initializer === undefined &&
    ts.isIdentifier(first.name) &&
    first.name.text === "childProcess"
    ? declaration
    : undefined;
}

function singleReturnStatement(statement: ts.Statement): ts.ReturnStatement | undefined {
  if (ts.isReturnStatement(statement)) return statement;
  if (ts.isBlock(statement) && statement.statements.length === 1) {
    const [onlyStatement] = statement.statements;
    return onlyStatement !== undefined && ts.isReturnStatement(onlyStatement)
      ? onlyStatement
      : undefined;
  }
  return undefined;
}

function isExternalSupervisionFinalizer(
  node: ts.Node,
  effectNamespace: ReadonlyArray<string>,
): boolean {
  const returnStatement = ts.isIfStatement(node)
    ? singleReturnStatement(node.thenStatement)
    : undefined;
  if (
    !ts.isIfStatement(node) ||
    !ts.isBinaryExpression(node.expression) ||
    node.expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
    !expressionHasPath(node.expression.left, ["cmd", "options", "synaraExternallySupervised"]) ||
    node.expression.right.kind !== ts.SyntaxKind.TrueKeyword ||
    returnStatement === undefined
  ) {
    return false;
  }

  const returnedExpression = returnStatement.expression;
  if (
    returnedExpression === undefined ||
    !ts.isYieldExpression(returnedExpression) ||
    returnedExpression.asteriskToken === undefined ||
    returnedExpression.expression === undefined
  ) {
    return false;
  }

  const yieldedPath = expressionPath(returnedExpression.expression);
  return (
    yieldedPath !== undefined &&
    yieldedPath.length === effectNamespace.length + 1 &&
    yieldedPath.at(-1) === "void" &&
    effectNamespace.every((part, index) => yieldedPath[index] === part)
  );
}

function isExactTerminateProperty(property: ts.ObjectLiteralElementLike): boolean {
  if (
    !ts.isPropertyAssignment(property) ||
    propertyNameText(property.name) !== "synaraTerminateExact" ||
    !ts.isArrowFunction(property.initializer) ||
    property.initializer.parameters.length !== 0 ||
    !ts.isCallExpression(property.initializer.body)
  ) {
    return false;
  }
  return (
    property.initializer.body.arguments.length === 0 &&
    expressionHasPath(property.initializer.body.expression, ["childProcess", "kill"])
  );
}

function isStdinCloseProperty(property: ts.ObjectLiteralElementLike): boolean {
  if (
    !ts.isPropertyAssignment(property) ||
    propertyNameText(property.name) !== "synaraCloseStdin" ||
    !ts.isArrowFunction(property.initializer) ||
    property.initializer.parameters.length !== 0 ||
    !ts.isBlock(property.initializer.body)
  ) {
    return false;
  }

  let closesNativeStdin = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 0 &&
      expressionHasPath(node.expression, ["childProcess", "stdin", "end"]) &&
      isNodeReachableWithin(node, property.initializer.body)
    ) {
      closesNativeStdin = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(property.initializer.body);
  return (
    closesNativeStdin &&
    bindingCountWithin(property.initializer.body, "childProcess") === 0 &&
    bindingIsNeverReassigned(property.initializer.body, "childProcess")
  );
}

function bindingNameContainsIdentifier(name: ts.BindingName, identifier: string): boolean {
  if (ts.isIdentifier(name)) return name.text === identifier;
  return name.elements.some(
    (element) =>
      !ts.isOmittedExpression(element) && bindingNameContainsIdentifier(element.name, identifier),
  );
}

function bindingCountWithin(root: ts.Node, identifier: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && bindingNameContainsIdentifier(node.name, identifier)) {
      count += 1;
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === identifier
    ) {
      count += 1;
    }
    if (node !== root && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return count;
}

function directHandleDeclaration(
  spawnerProof: ProcessSpawnerPatchProof,
  returnStatement: ts.ReturnStatement,
): ts.VariableDeclaration | undefined {
  const declarations: ts.VariableDeclaration[] = [];
  let handleBindingCount = 0;
  const visitBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && bindingNameContainsIdentifier(node.name, "handle")) {
      handleBindingCount += 1;
      if (ts.isIdentifier(node.name) && node.name.text === "handle") declarations.push(node);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === "handle"
    ) {
      handleBindingCount += 1;
    }
    if (node !== spawnerProof.container && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visitBindings);
  };
  visitBindings(spawnerProof.container);
  if (handleBindingCount !== 1 || declarations.length !== 1) return undefined;

  const [declaration] = declarations;
  if (
    declaration === undefined ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    declaration.initializer === undefined ||
    !ts.isCallExpression(declaration.initializer) ||
    !ts.isIdentifier(declaration.initializer.expression) ||
    declaration.initializer.expression.text !== "makeHandle"
  ) {
    return undefined;
  }

  let declarationStatement: ts.Node = declaration;
  while (declarationStatement.parent !== spawnerProof.container) {
    if (
      declarationStatement.parent === undefined ||
      ts.isFunctionLike(declarationStatement.parent)
    ) {
      return undefined;
    }
    declarationStatement = declarationStatement.parent;
  }
  const returnContainerStatement = directStatementWithin(returnStatement, spawnerProof.container);
  if (
    !ts.isVariableStatement(declarationStatement) ||
    returnContainerStatement === undefined ||
    spawnerProof.statement.pos >= declarationStatement.pos ||
    declarationStatement.pos >= returnContainerStatement.pos ||
    !isNodeReachableWithin(declaration, spawnerProof.container)
  ) {
    return undefined;
  }

  return declaration;
}

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function assignmentTargetWritesIdentifier(target: ts.Node, identifier: string): boolean {
  if (ts.isParenthesizedExpression(target)) {
    return assignmentTargetWritesIdentifier(target.expression, identifier);
  }
  if (ts.isIdentifier(target)) return target.text === identifier;
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.some((element) => assignmentTargetWritesIdentifier(element, identifier));
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) return property.name.text === identifier;
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetWritesIdentifier(property.initializer, identifier);
      }
      return ts.isSpreadAssignment(property)
        ? assignmentTargetWritesIdentifier(property.expression, identifier)
        : false;
    });
  }
  if (ts.isSpreadElement(target) || ts.isSpreadAssignment(target)) {
    return assignmentTargetWritesIdentifier(target.expression, identifier);
  }
  return false;
}

function bindingIsNeverReassigned(container: ts.Node, identifier: string): boolean {
  let reassigned = false;
  const visit = (node: ts.Node): void => {
    if (reassigned || (node !== container && ts.isFunctionLike(node))) return;
    if (
      ts.isBinaryExpression(node) &&
      ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
      assignmentTargetWritesIdentifier(node.left, identifier)
    ) {
      reassigned = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      assignmentTargetWritesIdentifier(node.operand, identifier)
    ) {
      reassigned = true;
      return;
    }
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      assignmentTargetWritesIdentifier(node.initializer, identifier)
    ) {
      reassigned = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(container);
  return !reassigned;
}

function isPatchedHandleReturn(node: ts.Node, spawnerProof: ProcessSpawnerPatchProof): boolean {
  if (!ts.isCallExpression(node)) return false;
  const returnStatement = node.parent;
  if (
    !ts.isReturnStatement(returnStatement) ||
    !expressionHasPath(node.expression, ["Object", "assign"]) ||
    node.arguments.length !== 2
  ) {
    return false;
  }

  const [handleArgument, patchArgument] = node.arguments;
  if (
    handleArgument === undefined ||
    patchArgument === undefined ||
    !ts.isIdentifier(handleArgument) ||
    handleArgument.text !== "handle" ||
    !ts.isObjectLiteralExpression(patchArgument)
  ) {
    return false;
  }

  const handleDeclaration = directHandleDeclaration(spawnerProof, returnStatement);
  if (
    handleDeclaration === undefined ||
    !bindingIsNeverReassigned(spawnerProof.container, "handle")
  ) {
    return false;
  }

  if (
    patchArgument.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) ||
        ("name" in property &&
          property.name !== undefined &&
          ts.isComputedPropertyName(property.name)),
    )
  ) {
    return false;
  }
  const terminateProperties = patchArgument.properties.filter(
    (property) => objectLiteralPropertyNameText(property) === "synaraTerminateExact",
  );
  const stdinCloseProperties = patchArgument.properties.filter(
    (property) => objectLiteralPropertyNameText(property) === "synaraCloseStdin",
  );
  return (
    terminateProperties.length === 1 &&
    stdinCloseProperties.length === 1 &&
    terminateProperties[0] !== undefined &&
    stdinCloseProperties[0] !== undefined &&
    isExactTerminateProperty(terminateProperties[0]) &&
    isStdinCloseProperty(stdinCloseProperties[0])
  );
}

function externalSupervisionProof(node: ts.Node): ProcessSpawnerPatchProof | undefined {
  const acquireRelease = enclosingAcquireReleaseCall(node);
  if (acquireRelease === undefined) return undefined;
  const spawnerProof = standardCommandSpawnerProof(acquireRelease);
  if (
    spawnerProof === undefined ||
    !isExternalSupervisionFinalizer(node, spawnerProof.effectNamespace)
  ) {
    return undefined;
  }
  const finalizer = acquireReleaseFinalizerProof(node, acquireRelease);
  if (
    finalizer === undefined ||
    !isExactExternalSupervisionFinalizerParameter(finalizer.declaration) ||
    !isNodeReachableWithin(node, finalizer.body) ||
    !ts.isIfStatement(node) ||
    !externalSupervisionGuardIsFirstStatement(node, finalizer.body)
  ) {
    return undefined;
  }
  return spawnerProof;
}

function standardCommandSpawnerProof(node: ts.Node): ProcessSpawnerPatchProof | undefined {
  if (!ts.isCallExpression(node)) {
    return undefined;
  }
  const callPath = expressionPath(node.expression);
  if (callPath === undefined || callPath.at(-1) !== "acquireRelease" || callPath.length < 2) {
    return undefined;
  }
  const caseClause = standardCommandCaseForDirectNode(node);
  if (caseClause === undefined) return undefined;
  const location = directExecutionLocation(node, caseClause);
  if (
    location === undefined ||
    directAcquireReleaseChildBinding(node) === undefined ||
    bindingCountWithin(location.container, "childProcess") !== 1 ||
    !bindingIsNeverReassigned(location.container, "childProcess") ||
    !isNodeReachableWithin(node, location.container) ||
    !isNodeStaticallyReachable(node)
  ) {
    return undefined;
  }
  return { caseClause, ...location, effectNamespace: callPath.slice(0, -1) };
}

function directStatementWithin(
  node: ts.Node,
  container: StandardCommandExecutionContainer,
): ts.Statement | undefined {
  let candidate = node;
  while (candidate.parent !== container) {
    const parent = candidate.parent;
    if (parent === undefined || ts.isFunctionLike(parent)) return undefined;
    candidate = parent;
  }
  return ts.isStatement(candidate) ? candidate : undefined;
}

function reachableReturnsAfter(
  spawnerProof: ProcessSpawnerPatchProof,
): ReadonlyArray<ts.ReturnStatement> {
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== spawnerProof.container && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      const statement = directStatementWithin(node, spawnerProof.container);
      if (
        statement !== undefined &&
        spawnerProof.statement.pos < statement.pos &&
        isNodeReachableWithin(node, spawnerProof.container)
      ) {
        returns.push(node);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(spawnerProof.container);
  return returns;
}

function assertPatchedEntryBundle(bundle: RuntimeBundle): void {
  const sourceFile = ts.createSourceFile(
    bundle.path,
    bundle.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & { readonly parseDiagnostics?: ReadonlyArray<ts.Diagnostic> }
  ).parseDiagnostics;
  if (parseDiagnostics !== undefined && parseDiagnostics.length > 0) {
    throw new Error(`Server runtime entry cannot be parsed as JavaScript: ${bundle.path}`);
  }

  const externalSupervisionProofs: ProcessSpawnerPatchProof[] = [];
  const standardCommandSpawnerProofs: ProcessSpawnerPatchProof[] = [];
  const visit = (node: ts.Node): void => {
    const externalProof = externalSupervisionProof(node);
    if (externalProof !== undefined) externalSupervisionProofs.push(externalProof);
    const spawnerProof = standardCommandSpawnerProof(node);
    if (spawnerProof !== undefined) standardCommandSpawnerProofs.push(spawnerProof);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const hasPairedLivePatch =
    standardCommandSpawnerProofs.length > 0 &&
    standardCommandSpawnerProofs.every(
      (spawnerProof) =>
        externalSupervisionProofs.some(
          (externalProof) =>
            externalProof.caseClause === spawnerProof.caseClause &&
            externalProof.container === spawnerProof.container &&
            externalProof.statement === spawnerProof.statement,
        ) &&
        (() => {
          const liveReturns = reachableReturnsAfter(spawnerProof);
          return (
            liveReturns.length > 0 &&
            liveReturns.every(
              (returnStatement) =>
                returnStatement.expression !== undefined &&
                isPatchedHandleReturn(returnStatement.expression, spawnerProof),
            )
          );
        })(),
    );
  if (!hasPairedLivePatch) {
    throw new Error(
      `Server runtime entry does not structurally contain Synara's patched Effect process spawner: ${bundle.path}`,
    );
  }
}

export function assertPatchedEffectProcessSpawnerIsBundled(
  bundles: ReadonlyArray<RuntimeBundle>,
): void {
  const externalImport = bundles.find(({ source }) =>
    EFFECT_PLATFORM_NODE_EXTERNAL_IMPORT.test(source),
  );
  if (externalImport !== undefined) {
    throw new Error(
      `Server runtime bundle still externalizes patched Effect process code: ${externalImport.path}`,
    );
  }

  for (const entryFile of PATCHED_EFFECT_RUNTIME_ENTRY_FILES) {
    const bundle = bundles.find(({ path }) => path === entryFile);
    if (bundle === undefined) {
      throw new Error(`Server runtime is missing the required patched entry bundle: ${entryFile}`);
    }
    assertPatchedEntryBundle(bundle);
  }
}
