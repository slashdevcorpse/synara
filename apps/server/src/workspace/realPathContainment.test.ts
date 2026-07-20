import { win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { isLexicallyContainedPath } from "./realPathContainment";

describe("isLexicallyContainedPath", () => {
  it("accepts same-drive Windows descendants without accepting prefix siblings", () => {
    const workspaceRoot = "C:\\workspace";

    expect(isLexicallyContainedPath(workspaceRoot, "C:\\workspace\\src\\index.ts", win32)).toBe(
      true,
    );
    expect(isLexicallyContainedPath(workspaceRoot, "C:\\workspace-other\\index.ts", win32)).toBe(
      false,
    );
  });

  it("rejects Windows paths on a different drive", () => {
    expect(isLexicallyContainedPath("C:\\workspace", "D:\\workspace\\src\\index.ts", win32)).toBe(
      false,
    );
  });

  it("accepts same-share UNC descendants without accepting prefix siblings", () => {
    const workspaceRoot = "\\\\server\\share\\workspace";

    expect(
      isLexicallyContainedPath(workspaceRoot, "\\\\server\\share\\workspace\\src\\index.ts", win32),
    ).toBe(true);
    expect(
      isLexicallyContainedPath(
        workspaceRoot,
        "\\\\server\\share\\workspace-other\\index.ts",
        win32,
      ),
    ).toBe(false);
  });

  it("rejects UNC paths on a different share or server", () => {
    const workspaceRoot = "\\\\server\\share\\workspace";

    expect(
      isLexicallyContainedPath(
        workspaceRoot,
        "\\\\server\\other-share\\workspace\\index.ts",
        win32,
      ),
    ).toBe(false);
    expect(
      isLexicallyContainedPath(
        workspaceRoot,
        "\\\\backup-server\\share\\workspace\\index.ts",
        win32,
      ),
    ).toBe(false);
  });
});
