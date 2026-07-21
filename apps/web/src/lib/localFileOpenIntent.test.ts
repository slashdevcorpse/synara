import { describe, expect, it } from "vitest";

import {
  isProbablyBinaryFileContents,
  localFilePreviewKindForPath,
  parseLocalFileReference,
  resolveActiveWorkspaceFilePath,
  resolveLocalFileOpenIntent,
} from "./localFileOpenIntent";

describe("local file open intent", () => {
  it.each([
    ["docs/README.md", "preview-markdown"],
    ["docs/demo.html", "preview-html"],
    ["assets/screenshot.png", "preview-image"],
    ["docs/spec.pdf", "preview-pdf"],
    ["src/main.ts", "preview-text"],
    ["artifacts/archive.zip", "unsupported-binary"],
  ] as const)("classifies %s as %s", (rawPath, kind) => {
    expect(resolveLocalFileOpenIntent({ rawPath, runtimeRoot: "/repo/worktree" })).toMatchObject({
      kind,
      path: rawPath,
    });
  });

  it("uses an explicit browser intent only for HTML", () => {
    expect(
      resolveLocalFileOpenIntent({
        rawPath: "docs/demo.htm",
        runtimeRoot: "/repo/worktree",
        action: "browser",
      }),
    ).toMatchObject({ kind: "browser-html", path: "docs/demo.htm" });
    expect(
      resolveLocalFileOpenIntent({
        rawPath: "docs/README.md",
        runtimeRoot: "/repo/worktree",
        action: "browser",
      }),
    ).toMatchObject({ kind: "failure", reason: "unsupported-browser-file" });
  });

  it("keeps deliberate modifier opens in the external editor", () => {
    expect(
      resolveLocalFileOpenIntent({
        rawPath: "/outside/project/main.ts:12:4",
        runtimeRoot: "/repo/worktree",
        forceExternalEditor: true,
      }),
    ).toEqual({
      kind: "external-editor",
      path: "/outside/project/main.ts",
      position: { line: 12, column: 4 },
    });
  });

  it("remaps original-project absolute paths into the active worktree", () => {
    expect(
      resolveActiveWorkspaceFilePath({
        rawPath: "C:\\src\\synara\\apps\\web\\index.html:18:2",
        runtimeRoot: "D:\\worktrees\\synara-feature",
        referenceRoot: "c:\\SRC\\SYNARA",
      }),
    ).toEqual({
      kind: "workspace",
      path: "apps/web/index.html",
      absolutePath: "D:\\worktrees\\synara-feature\\apps\\web\\index.html",
      remappedFromReferenceRoot: true,
      position: { line: 18, column: 2 },
    });
  });

  it("resolves relative references against the runtime worktree", () => {
    expect(
      resolveActiveWorkspaceFilePath({
        rawPath: "docs/demo.html:9",
        runtimeRoot: "/repo/.worktrees/feature",
        referenceRoot: "/repo/project",
      }),
    ).toMatchObject({
      kind: "workspace",
      path: "docs/demo.html",
      absolutePath: "/repo/.worktrees/feature/docs/demo.html",
      position: { line: 9 },
    });
  });

  it("resolves absolute references under a POSIX root workspace", () => {
    expect(
      resolveActiveWorkspaceFilePath({
        rawPath: "/docs/demo.html:3",
        runtimeRoot: "/",
      }),
    ).toEqual({
      kind: "workspace",
      path: "docs/demo.html",
      absolutePath: "/docs/demo.html",
      remappedFromReferenceRoot: false,
      position: { line: 3 },
    });
  });

  it("preserves trusted scratch paths and fails closed outside approved roots", () => {
    const scratch = "/tmp/synara-codex-workspaces/thread-1/demo.html";
    expect(resolveActiveWorkspaceFilePath({ rawPath: scratch, runtimeRoot: null })).toMatchObject({
      kind: "scratch",
      path: scratch,
    });
    expect(
      resolveLocalFileOpenIntent({
        rawPath: "/Users/me/Downloads/demo.html",
        runtimeRoot: "/repo/worktree",
        referenceRoot: "/repo/project",
      }),
    ).toMatchObject({ kind: "failure", reason: "outside-workspace" });
  });

  it("allows legacy exact-file previews for local non-HTML files only when requested", () => {
    for (const [rawPath, kind] of [
      ["/Users/me/Downloads/shot.png", "preview-image"],
      ["/Users/me/Downloads/report.pdf", "preview-pdf"],
      ["/Users/me/Downloads/README.md", "preview-markdown"],
      ["/Users/me/Downloads/notes.txt:7", "preview-text"],
    ] as const) {
      expect(
        resolveLocalFileOpenIntent({
          rawPath,
          runtimeRoot: "/repo/worktree",
          allowOutsideWorkspaceFilePreview: true,
        }),
      ).toMatchObject({ kind });
    }
    for (const rawPath of [
      "/Users/me/Downloads/demo.html",
      "\\\\server\\share\\shot.png",
      "//server/share/shot.png",
    ]) {
      expect(
        resolveLocalFileOpenIntent({
          rawPath,
          runtimeRoot: "/repo/worktree",
          allowOutsideWorkspaceFilePreview: true,
        }),
      ).toMatchObject({ kind: "failure", reason: "outside-workspace" });
    }
  });

  it("represents missing files without changing their resolved path", () => {
    expect(
      resolveLocalFileOpenIntent({
        rawPath: "/repo/project/docs/missing.md:4",
        runtimeRoot: "/repo/worktree",
        referenceRoot: "/repo/project",
        exists: false,
      }),
    ).toMatchObject({
      kind: "failure",
      reason: "missing",
      path: "docs/missing.md",
      position: { line: 4 },
    });
  });

  it("parses file positions without confusing Windows drive letters", () => {
    expect(parseLocalFileReference("C:\\repo\\src\\main.ts:20:7")).toEqual({
      path: "C:\\repo\\src\\main.ts",
      position: { line: 20, column: 7 },
    });
  });

  it("detects known and content-sniffed unsupported binaries", () => {
    expect(localFilePreviewKindForPath("artifacts/app.wasm")).toBe("unsupported-binary");
    expect(localFilePreviewKindForPath("notes.unknown")).toBe("text");
    expect(isProbablyBinaryFileContents("plain\ntext\tcontent")).toBe(false);
    expect(isProbablyBinaryFileContents("binary\0payload")).toBe(true);
  });
});
