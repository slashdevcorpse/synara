// FILE: windowsNpmShim.ts
// Purpose: Parses only canonical npm-generated Windows Node launcher shims.
// Layer: Shared pure runtime utility

const WINDOWS_UNSAFE_PATH_CHARACTER_PATTERN = /[\u0000-\u001f"<>|?*:%!&^]/u;
const WINDOWS_PATH_WHITESPACE_PATTERN = /\s/u;
const WINDOWS_MANIFEST_UNSAFE_PATH_CHARACTER_PATTERN = /[\u0000-\u001f"<>|?*:]/u;

export interface CanonicalWindowsNpmNodeShimTarget {
  readonly relativeTarget: string;
  readonly packageName: string;
  readonly relativePackageRoot: string;
  readonly packageBinTarget: string;
}

function normalizeShimLine(line: string): string {
  return line.trim().replaceAll("\\", "/").replace(/\s+/gu, " ");
}

function linesEqual(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  return (
    actual.length === expected.length &&
    expected.every((line, index) => actual[index]?.toLowerCase() === line.toLowerCase())
  );
}

function canonicalNodeModulesTarget(value: string): string | null {
  const target = value.replaceAll("\\", "/");
  if (
    target !== target.trim() ||
    WINDOWS_PATH_WHITESPACE_PATTERN.test(target) ||
    WINDOWS_UNSAFE_PATH_CHARACTER_PATTERN.test(target) ||
    target.startsWith("/") ||
    target.includes("//")
  ) {
    return null;
  }
  const segments = target.split("/");
  if (
    segments.length < 2 ||
    segments[0]?.toLowerCase() !== "node_modules" ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" "),
    )
  ) {
    return null;
  }
  return segments.join("/");
}

function matchTemplate(
  lines: ReadonlyArray<string>,
  targetLineIndex: number,
  targetPattern: RegExp,
  render: (target: string) => ReadonlyArray<string>,
): string | null {
  const targetMatch = targetPattern.exec(lines[targetLineIndex] ?? "");
  const target = targetMatch?.[1] ? canonicalNodeModulesTarget(targetMatch[1]) : null;
  return target && linesEqual(lines, render(target)) ? target : null;
}

/**
 * Returns the forward-slash relative `node_modules/...` target from one of
 * npm's three canonical Windows Node shim templates. Any extra command,
 * alternate control flow, path traversal, or non-canonical target fails closed.
 */
export function parseCanonicalWindowsNpmNodeShim(contents: string): string | null {
  const lines = contents.split(/\r?\n/u).map(normalizeShimLine).filter(Boolean);

  const directTarget = matchTemplate(
    lines,
    1,
    /^"%~dp0\/node\.exe" "%~dp0\/(node_modules\/[^"]+)" %\*$/iu,
    (target) => ["@echo off", `"%~dp0/node.exe" "%~dp0/${target}" %*`],
  );
  if (directTarget) {
    return directTarget;
  }

  const pathFallbackTarget = matchTemplate(
    lines,
    1,
    /^"%~dp0\/node\.exe" "%~dp0\/(node_modules\/[^"]+)" %\*$/iu,
    (target) => [
      '@if exist "%~dp0/node.exe" (',
      `"%~dp0/node.exe" "%~dp0/${target}" %*`,
      ") else (",
      "@setlocal",
      "@set pathext=%pathext:;.js;=;%",
      `node "%~dp0/${target}" %*`,
      ")",
    ],
  );
  if (pathFallbackTarget) {
    return pathFallbackTarget;
  }

  return matchTemplate(
    lines,
    14,
    /^endlocal & goto #_undefined_# 2>nul \|\| title %comspec% & "%_prog%" "%dp0%\/(node_modules\/[^"]+)" %\*$/iu,
    (target) => [
      "@echo off",
      "goto start",
      ":find_dp0",
      "set dp0=%~dp0",
      "exit /b",
      ":start",
      "setlocal",
      "call :find_dp0",
      'if exist "%dp0%/node.exe" (',
      'set "_prog=%dp0%/node.exe"',
      ") else (",
      'set "_prog=node"',
      "set pathext=%pathext:;.js;=;%",
      ")",
      `endlocal & goto #_undefined_# 2>nul || title %comspec% & "%_prog%" "%dp0%/${target}" %*`,
    ],
  );
}

/**
 * Splits a verified npm shim target into the package identity and package-local
 * bin target needed to prove the shim against that package's manifest.
 */
export function parseCanonicalWindowsNpmNodeShimTarget(
  contents: string,
): CanonicalWindowsNpmNodeShimTarget | null {
  const relativeTarget = parseCanonicalWindowsNpmNodeShim(contents);
  if (!relativeTarget) {
    return null;
  }

  const segments = relativeTarget.split("/");
  const scoped = segments[1]?.startsWith("@") ?? false;
  const packageSegmentCount = scoped ? 3 : 2;
  if (
    segments.length <= packageSegmentCount ||
    (scoped && (!segments[1] || !segments[2])) ||
    (!scoped && !segments[1])
  ) {
    return null;
  }

  const packageName = scoped ? `${segments[1]}/${segments[2]}` : segments[1];
  const packageBinTarget = segments.slice(packageSegmentCount).join("/");
  return {
    relativeTarget,
    packageName,
    relativePackageRoot: segments.slice(0, packageSegmentCount).join("/"),
    packageBinTarget,
  };
}

function normalizeManifestBinTarget(value: string): string | null {
  const target = value.replaceAll("\\", "/");
  if (
    target !== target.trim() ||
    WINDOWS_MANIFEST_UNSAFE_PATH_CHARACTER_PATTERN.test(target) ||
    target.startsWith("/") ||
    target.startsWith("//")
  ) {
    return null;
  }
  const segments = target.split("/").filter((segment) => segment !== ".");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === ".." || segment.endsWith(".") || segment.endsWith(" "),
    )
  ) {
    return null;
  }
  return segments.join("/");
}

function unscopedPackageName(packageName: string): string {
  const separator = packageName.lastIndexOf("/");
  return separator >= 0 ? packageName.slice(separator + 1) : packageName;
}

/**
 * Proves that a parsed canonical shim name resolves to the exact `bin` target
 * declared by the package manifest. String-form `bin` declarations use npm's
 * unscoped package-name alias; object-form declarations must name the shim.
 */
export function windowsNpmPackageManifestDeclaresShimTarget(input: {
  readonly target: CanonicalWindowsNpmNodeShimTarget;
  readonly shimName: string;
  readonly manifestContents: string;
}): boolean {
  let manifest: unknown;
  try {
    manifest = JSON.parse(input.manifestContents);
  } catch {
    return false;
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    !("name" in manifest) ||
    manifest.name !== input.target.packageName ||
    !("bin" in manifest)
  ) {
    return false;
  }

  const shimName = input.shimName.replace(/\.(?:cmd|bat)$/iu, "");
  const bin = manifest.bin;
  let declaredTarget: unknown;
  if (typeof bin === "string") {
    if (shimName.toLowerCase() !== unscopedPackageName(input.target.packageName).toLowerCase()) {
      return false;
    }
    declaredTarget = bin;
  } else if (typeof bin === "object" && bin !== null && !Array.isArray(bin)) {
    const entry = Object.entries(bin).find(
      ([name]) => name.toLowerCase() === shimName.toLowerCase(),
    );
    declaredTarget = entry?.[1];
  }

  return (
    typeof declaredTarget === "string" &&
    normalizeManifestBinTarget(declaredTarget)?.toLowerCase() ===
      input.target.packageBinTarget.toLowerCase()
  );
}
