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

function hasAncestor(node: ts.Node, predicate: (candidate: ts.Node) => boolean): boolean {
  let candidate = node.parent;
  while (candidate !== undefined) {
    if (predicate(candidate)) return true;
    candidate = candidate.parent;
  }
  return false;
}

function belongsToStandardCommandCase(node: ts.Node): boolean {
  return hasAncestor(
    node,
    (candidate) =>
      ts.isCaseClause(candidate) &&
      ts.isStringLiteral(candidate.expression) &&
      candidate.expression.text === "StandardCommand",
  );
}

function belongsToAcquireRelease(node: ts.Node): boolean {
  return hasAncestor(node, (candidate) => {
    if (!ts.isCallExpression(candidate)) return false;
    const path = expressionPath(candidate.expression);
    return path?.at(-1) === "acquireRelease";
  });
}

function isExternalSupervisionFinalizer(node: ts.Node): boolean {
  if (
    !ts.isIfStatement(node) ||
    !belongsToStandardCommandCase(node) ||
    !belongsToAcquireRelease(node) ||
    !ts.isBinaryExpression(node.expression) ||
    node.expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
    !expressionHasPath(node.expression.left, ["cmd", "options", "synaraExternallySupervised"]) ||
    node.expression.right.kind !== ts.SyntaxKind.TrueKeyword ||
    !ts.isReturnStatement(node.thenStatement)
  ) {
    return false;
  }

  const returnedExpression = node.thenStatement.expression;
  if (
    returnedExpression === undefined ||
    !ts.isYieldExpression(returnedExpression) ||
    returnedExpression.asteriskToken === undefined ||
    returnedExpression.expression === undefined
  ) {
    return false;
  }

  const yieldedPath = expressionPath(returnedExpression.expression);
  return yieldedPath?.at(-1) === "void";
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
      expressionHasPath(node.expression, ["childProcess", "stdin", "end"])
    ) {
      closesNativeStdin = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(property.initializer.body);
  return closesNativeStdin;
}

function isPatchedHandleReturn(node: ts.Node): boolean {
  if (
    !ts.isCallExpression(node) ||
    !ts.isReturnStatement(node.parent) ||
    !belongsToStandardCommandCase(node) ||
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

  return (
    patchArgument.properties.some(isExactTerminateProperty) &&
    patchArgument.properties.some(isStdinCloseProperty)
  );
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

  let hasExternalSupervisionFinalizer = false;
  let hasPatchedHandleReturn = false;
  const visit = (node: ts.Node): void => {
    if (isExternalSupervisionFinalizer(node)) hasExternalSupervisionFinalizer = true;
    if (isPatchedHandleReturn(node)) hasPatchedHandleReturn = true;
    if (!hasExternalSupervisionFinalizer || !hasPatchedHandleReturn) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!hasExternalSupervisionFinalizer || !hasPatchedHandleReturn) {
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

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}
