import fs from "node:fs/promises";
import os from "node:os";
import path, { posix, win32 } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isLexicallyContainedPath, resolveRealPathWithinRoot } from "./realPathContainment";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

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

  it("does not alias distinct NFC and NFD sibling roots with POSIX semantics", () => {
    const nfcRoot = "/workspace/Caf\u00e9";
    const nfdRoot = "/workspace/Cafe\u0301";

    expect(isLexicallyContainedPath(nfcRoot, `${nfdRoot}/src/index.ts`, posix)).toBe(false);
    expect(isLexicallyContainedPath(nfdRoot, `${nfcRoot}/src/index.ts`, posix)).toBe(false);
    expect(isLexicallyContainedPath(nfcRoot, `${nfdRoot}-other/index.ts`, posix)).toBe(false);
    expect(isLexicallyContainedPath("/workspace", "/workspace/Cafe\u0301/index.ts", posix)).toBe(
      true,
    );
  });

  it("does not alias distinct NFC and NFD sibling roots with Windows semantics", () => {
    const nfcRoot = "C:\\workspace\\Caf\u00e9";
    const nfdRoot = "C:\\workspace\\Cafe\u0301";

    expect(isLexicallyContainedPath(nfcRoot, `${nfdRoot}\\src\\index.ts`, win32)).toBe(false);
    expect(isLexicallyContainedPath(nfdRoot, `${nfcRoot}\\src\\index.ts`, win32)).toBe(false);
    expect(isLexicallyContainedPath(nfcRoot, `${nfdRoot}-other\\index.ts`, win32)).toBe(false);
    expect(
      isLexicallyContainedPath("C:\\workspace", "C:\\workspace\\Cafe\u0301\\index.ts", win32),
    ).toBe(true);
  });

  it.skipIf(process.platform === "darwin")(
    "rejects a real target under a canonically equivalent sibling root",
    async () => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), "synara-containment-siblings-"));
      temporaryRoots.push(parent);
      const nfcRoot = path.join(parent, "Caf\u00e9");
      const nfdSibling = path.join(parent, "Cafe\u0301");
      const outsideFile = path.join(nfdSibling, "secret.txt");
      await fs.mkdir(nfcRoot);
      await fs.mkdir(nfdSibling);
      await fs.writeFile(outsideFile, "secret");

      await expect(resolveRealPathWithinRoot(nfcRoot, outsideFile)).resolves.toBeNull();
    },
  );

  it("accepts an NFD filename that is structurally inside the real root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-containment-in-root-"));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const inRootFile = path.join(workspaceRoot, "Cafe\u0301.txt");
    await fs.mkdir(workspaceRoot);
    await fs.writeFile(inRootFile, "inside");

    await expect(resolveRealPathWithinRoot(workspaceRoot, inRootFile)).resolves.toBe(
      await fs.realpath(inRootFile),
    );
  });

  it("still rejects a real in-workspace symlink that resolves outside the root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-containment-unicode-"));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const outsideRoot = path.join(root, "outside");
    const outsideFile = path.join(outsideRoot, "secret.txt");
    const linkedOutside = path.join(workspaceRoot, "linked-outside");
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(outsideRoot);
    await fs.writeFile(outsideFile, "secret");
    await fs.symlink(outsideRoot, linkedOutside, process.platform === "win32" ? "junction" : "dir");

    await expect(
      resolveRealPathWithinRoot(workspaceRoot, path.join(linkedOutside, "secret.txt")),
    ).resolves.toBeNull();
  });
});
