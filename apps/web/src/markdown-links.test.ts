import { describe, expect, it } from "vitest";

import { resolveMarkdownFileLinkTarget, rewriteMarkdownFileUriHref } from "./markdown-links";

describe("rewriteMarkdownFileUriHref", () => {
  it("rewrites file uri hrefs into direct path hrefs", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/src/main.ts#L42")).toBe(
      "/Users/julius/project/src/main.ts#L42",
    );
  });

  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });

  it("preserves file URL hosts as Windows UNC paths", () => {
    expect(rewriteMarkdownFileUriHref("file://build-server/share/demo%20site/index.html#L8")).toBe(
      "\\\\build-server\\share\\demo%20site\\index.html#L8",
    );
  });

  it("preserves drive letters in two-slash Windows file URLs", () => {
    expect(rewriteMarkdownFileUriHref("file://C:/repo/demo.html#L3")).toBe("C:/repo/demo.html#L3");
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative links against Windows worktree roots", () => {
    expect(resolveMarkdownFileLinkTarget("docs/demo.html:9", "D:\\worktrees\\feature")).toBe(
      "D:\\worktrees\\feature\\docs\\demo.html:9",
    );
  });

  it("resolves UNC file URLs without dropping the server name", () => {
    expect(resolveMarkdownFileLinkTarget("file://build-server/share/demo.html#L5")).toBe(
      "\\\\build-server\\share\\demo.html:5",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });
});
