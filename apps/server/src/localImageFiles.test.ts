import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  LOCAL_PREVIEW_GRANT_TTL_MS,
  LocalPreviewGrantError,
  createLocalPreviewGrant,
  openResolvedLocalPreviewFile,
  resolveAllowedLocalPreviewFile,
  resolveLocalPreviewGrantRealPath,
  resolveLocalPreviewGrantResource,
} from "./localImageFiles.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function supportsFileSymlinks(targetPath: string, directory: string): boolean {
  const probePath = path.join(directory, `.symlink-probe-${crypto.randomUUID()}`);
  try {
    symlinkSync(targetPath, probePath, "file");
    rmSync(probePath, { force: true });
    return true;
  } catch {
    rmSync(probePath, { force: true });
    return false;
  }
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveAllowedLocalPreviewFile", () => {
  it("allows images inside the current workspace", async () => {
    const workspace = makeTempDir("synara-image-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const imagePath = path.join(workspace, "preview.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: workspace,
    });

    assert.equal(result?.path, realpathSync.native(imagePath));
    assert.equal(result?.fileName, "preview.png");
  });

  it("allows images inside Codex generated_images without a cwd", async () => {
    const codexHome = makeTempDir("synara-codex-home-");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const imageDir = path.join(codexHome, "generated_images", "provider-thread");
      const imagePath = path.join(imageDir, "call.png");
      mkdirSync(imageDir, { recursive: true });
      writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
      });

      assert.equal(result?.path, realpathSync.native(imagePath));
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it("allows images written to the SYNARA_HOME codex-home-overlay generated_images root", async () => {
    // Codex app-server is launched with CODEX_HOME pointing at a Synara overlay
    // directory (see resolveSynaraCodexHomeOverlayPath). Generated images therefore
    // live under <SYNARA_HOME>/codex-home-overlay/generated_images/<thread>/<call>.png,
    // which sits outside both the user's `~/.codex` source home and any workspace
    // root. The allowlist must still serve them.
    //
    // We anchor the fake homes inside the worktree (process.cwd() resolves to
    // apps/server/ when vitest runs) so neither path falls under os.tmpdir(); that
    // way only the overlay candidate can satisfy the allowlist.
    const fakeRoot = path.join(process.cwd(), `.test-codex-overlay-${process.pid}-${Date.now()}`);
    const sourceHome = path.join(fakeRoot, "source", ".codex");
    const synaraHome = path.join(fakeRoot, "synara", "runtime");
    const overlayImageDir = path.join(
      synaraHome,
      "codex-home-overlay",
      "generated_images",
      "thread-overlay",
    );
    const imagePath = path.join(overlayImageDir, "call.png");
    mkdirSync(overlayImageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const previousSynaraHome = process.env.SYNARA_HOME;
    process.env.SYNARA_HOME = synaraHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePath: sourceHome,
      });

      assert.equal(result?.path, realpathSync.native(imagePath));
    } finally {
      if (previousSynaraHome === undefined) {
        delete process.env.SYNARA_HOME;
      } else {
        process.env.SYNARA_HOME = previousSynaraHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("allows PDFs inside the current workspace", async () => {
    const workspace = makeTempDir("synara-pdf-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const pdfPath = path.join(workspace, "docs", "spec.pdf");
    mkdirSync(path.dirname(pdfPath), { recursive: true });
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pdfPath,
      cwd: workspace,
    });

    assert.equal(result?.path, realpathSync.native(pdfPath));
    assert.equal(result?.fileName, "spec.pdf");
    assert.equal(result?.sizeBytes, 8);
  });

  it("allows PDFs inside a per-thread scratch workspace without a cwd", async () => {
    // Sessions that start before a project workspace exists run in
    // <tmpdir>/synara-codex-workspaces/<threadId>; files agents create there
    // are workspace-equivalent, so documents must be servable from that root.
    const scratchRoot = path.join(os.tmpdir(), "synara-codex-workspaces");
    const threadDir = path.join(scratchRoot, `test-thread-${process.pid}-${Date.now()}`);
    const pdfPath = path.join(threadDir, "viewer-test.pdf");
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: pdfPath,
        cwd: null,
      });

      assert.equal(result?.path, realpathSync.native(pdfPath));
      assert.equal(result?.fileName, "viewer-test.pdf");
      assert.equal(result?.sizeBytes, 8);
    } finally {
      // Remove only the per-thread dir — the shared scratch root may belong
      // to a live server.
      rmSync(threadDir, { recursive: true, force: true });
    }
  });

  it("rejects PDFs outside the workspace even under the temp-dir image roots", async () => {
    // Temp/generated-image roots exist for agent-produced images in chat
    // markdown; documents must only ever be served from the workspace.
    const tempDir = makeTempDir("synara-pdf-outside-");
    const pdfPath = path.join(tempDir, "leak.pdf");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pdfPath,
      cwd: null,
    });

    assert.equal(result, null);
  });

  it("still allows images under the temp-dir roots without a workspace", async () => {
    const tempDir = makeTempDir("synara-image-tmp-root-");
    const imagePath = path.join(tempDir, "clip.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: null,
    });

    assert.equal(result?.path, realpathSync.native(imagePath));
  });

  it("rejects unsupported paths", async () => {
    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: "/etc/hosts",
      cwd: null,
    });

    assert.equal(result, null);
  });
});

describe("local preview grants", () => {
  it("keeps path-only grants exact-file and backward compatible", async () => {
    const externalRoot = makeTempDir("synara-exact-preview-grant-");
    const filePath = path.join(externalRoot, "spec.pdf");
    writeFileSync(filePath, Buffer.from("%PDF-1.4"));
    const nowMs = Date.parse("2026-07-20T12:00:00.000Z");

    const result = await createLocalPreviewGrant({ requestedPath: filePath, nowMs });

    assert.equal(result.urlPath, undefined);
    assert.equal(result.expiresAt, new Date(nowMs + LOCAL_PREVIEW_GRANT_TTL_MS).toISOString());
    assert.equal(
      resolveLocalPreviewGrantRealPath({ token: result.grant, nowMs }),
      realpathSync.native(filePath),
    );
  });

  it("mints a directory grant for a relative HTML entry inside the active workspace", async () => {
    const workspace = makeTempDir("synara-directory-preview-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const siteDir = path.join(workspace, "demo");
    const entryPath = path.join(siteDir, "demo file.html");
    const assetPath = path.join(siteDir, "assets", "app.js");
    mkdirSync(path.dirname(assetPath), { recursive: true });
    writeFileSync(entryPath, "<!doctype html>");
    writeFileSync(assetPath, "console.log('ok')");

    const result = await createLocalPreviewGrant({
      requestedPath: path.join("demo", "demo file.html"),
      cwd: workspace,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "preview",
    });

    assert.equal(
      result.urlPath,
      `/api/local-preview/${encodeURIComponent(result.grant)}/demo%20file.html`,
    );
    assert.equal(
      resolveLocalPreviewGrantRealPath({ token: result.grant }),
      realpathSync.native(entryPath),
    );
    assert.notEqual(
      resolveLocalPreviewGrantRealPath({ token: result.grant }),
      realpathSync.native(assetPath),
    );

    const asset = await resolveLocalPreviewGrantResource({
      token: result.grant,
      encodedRelativePath: "assets/app.js",
    });
    assert.equal(asset?.path, realpathSync.native(assetPath));
    assert.equal(asset?.purpose, "preview");
  });

  it("mints an absolute HTML directory grant inside an approved scratch workspace", async () => {
    const threadDir = path.join(
      os.tmpdir(),
      "synara-codex-workspaces",
      `preview-thread-${process.pid}-${Date.now()}`,
    );
    const entryPath = path.join(threadDir, "index.htm");
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(entryPath, "<!doctype html>");
    try {
      const result = await createLocalPreviewGrant({
        requestedPath: entryPath,
        scope: "directory",
        purpose: "preview",
      });

      assert.match(result.urlPath ?? "", /\/api\/local-preview\/[a-f0-9-]+\/index\.htm$/);
      assert.equal(
        resolveLocalPreviewGrantRealPath({ token: result.grant }),
        realpathSync.native(entryPath),
      );
    } finally {
      rmSync(threadDir, { recursive: true, force: true });
    }
  });

  it("mints an absolute entry without cwd when it matches a server-known workspace root", async () => {
    const workspace = makeTempDir("synara-directory-preview-known-absolute-");
    const entryPath = path.join(workspace, "index.html");
    writeFileSync(entryPath, "<!doctype html>");

    const result = await createLocalPreviewGrant({
      requestedPath: entryPath,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "browser",
    });

    assert.equal(
      resolveLocalPreviewGrantRealPath({ token: result.grant }),
      realpathSync.native(entryPath),
    );
  });

  it("requires cwd for relative directory entries", async () => {
    await assert.rejects(
      createLocalPreviewGrant({
        requestedPath: "demo/index.html",
        scope: "directory",
        purpose: "preview",
      }),
      (error: unknown) => error instanceof LocalPreviewGrantError && error.code === "cwd-required",
    );
  });

  it("requires an explicit purpose for directory grants", async () => {
    const workspace = makeTempDir("synara-directory-preview-purpose-");
    const entryPath = path.join(workspace, "index.html");
    writeFileSync(entryPath, "<!doctype html>");

    await assert.rejects(
      createLocalPreviewGrant({
        requestedPath: entryPath,
        cwd: workspace,
        allowedWorkspaceRoots: [workspace],
        scope: "directory",
      }),
      (error: unknown) =>
        error instanceof LocalPreviewGrantError && error.code === "purpose-required",
    );
  });

  it("rejects non-HTML entries, directories, missing files, and paths outside the workspace", async () => {
    const workspace = makeTempDir("synara-directory-preview-rejections-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const directoryPath = path.join(workspace, "site.html");
    const textPath = path.join(workspace, "notes.txt");
    const outsideRoot = makeTempDir("synara-directory-preview-outside-");
    const outsideHtml = path.join(outsideRoot, "outside.html");
    mkdirSync(directoryPath);
    writeFileSync(textPath, "not html");
    writeFileSync(outsideHtml, "<!doctype html>");

    const grant = (requestedPath: string) =>
      createLocalPreviewGrant({
        requestedPath,
        cwd: workspace,
        allowedWorkspaceRoots: [workspace],
        scope: "directory",
        purpose: "preview",
      });

    await assert.rejects(grant(textPath), (error: unknown) =>
      Boolean(error instanceof LocalPreviewGrantError && error.code === "unsupported-entry"),
    );
    await assert.rejects(grant(directoryPath), (error: unknown) =>
      Boolean(error instanceof LocalPreviewGrantError && error.code === "not-file"),
    );
    await assert.rejects(grant(path.join(workspace, "missing.html")), (error: unknown) =>
      Boolean(error instanceof LocalPreviewGrantError && error.code === "not-found"),
    );
    await assert.rejects(grant(outsideHtml), (error: unknown) =>
      Boolean(error instanceof LocalPreviewGrantError && error.code === "outside-root"),
    );
  });

  it("rejects UNC and Windows device directory grants before filesystem access", async () => {
    const workspace = makeTempDir("synara-directory-preview-network-");

    for (const requestedPath of [
      "\\\\server\\share\\index.html",
      "\\\\?\\C:\\workspace\\index.html",
      "\\\\.\\C:\\workspace\\index.html",
    ]) {
      await assert.rejects(
        createLocalPreviewGrant({
          requestedPath,
          cwd: workspace,
          allowedWorkspaceRoots: [workspace],
          scope: "directory",
          purpose: "browser",
        }),
        (error: unknown) =>
          error instanceof LocalPreviewGrantError && error.code === "network-path",
      );
    }
  });

  it("rejects a renderer-supplied cwd that is not a known project or worktree root", async () => {
    const knownWorkspace = makeTempDir("synara-directory-preview-known-root-");
    const untrustedWorkspace = makeTempDir("synara-directory-preview-untrusted-root-");
    const entryPath = path.join(untrustedWorkspace, "index.html");
    writeFileSync(entryPath, "<!doctype html>");

    await assert.rejects(
      createLocalPreviewGrant({
        requestedPath: entryPath,
        cwd: untrustedWorkspace,
        allowedWorkspaceRoots: [knownWorkspace],
        scope: "directory",
        purpose: "browser",
      }),
      (error: unknown) =>
        error instanceof LocalPreviewGrantError && error.code === "untrusted-workspace",
    );
    await assert.rejects(
      createLocalPreviewGrant({
        requestedPath: entryPath,
        scope: "directory",
        purpose: "browser",
      }),
      (error: unknown) => error instanceof LocalPreviewGrantError && error.code === "outside-root",
    );
  });

  it("keeps an entry inside the canonical active cwd even when a broader project is known", async () => {
    const projectRoot = makeTempDir("synara-directory-preview-project-root-");
    const activeCwd = path.join(projectRoot, "active");
    const siblingDir = path.join(projectRoot, "sibling");
    const siblingEntry = path.join(siblingDir, "index.html");
    mkdirSync(activeCwd);
    mkdirSync(siblingDir);
    writeFileSync(siblingEntry, "<!doctype html>");

    await assert.rejects(
      createLocalPreviewGrant({
        requestedPath: siblingEntry,
        cwd: activeCwd,
        allowedWorkspaceRoots: [projectRoot],
        scope: "directory",
        purpose: "preview",
      }),
      (error: unknown) => error instanceof LocalPreviewGrantError && error.code === "outside-root",
    );
  });

  it("expires directory capabilities and rejects wrong tokens", async () => {
    const workspace = makeTempDir("synara-directory-preview-expiry-");
    const entryPath = path.join(workspace, "index.html");
    writeFileSync(entryPath, "<!doctype html>");
    const nowMs = Date.parse("2026-07-20T12:00:00.000Z");
    const result = await createLocalPreviewGrant({
      requestedPath: entryPath,
      cwd: workspace,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "preview",
      nowMs,
    });

    assert.equal(
      await resolveLocalPreviewGrantResource({
        token: "wrong-token",
        encodedRelativePath: "index.html",
        nowMs,
      }),
      null,
    );
    assert.equal(
      await resolveLocalPreviewGrantResource({
        token: result.grant,
        encodedRelativePath: "index.html",
        nowMs: nowMs + LOCAL_PREVIEW_GRANT_TTL_MS,
      }),
      null,
    );
    assert.equal(
      resolveLocalPreviewGrantRealPath({
        token: result.grant,
        nowMs: nowMs + LOCAL_PREVIEW_GRANT_TTL_MS,
      }),
      null,
    );
  });

  it("rejects literal, encoded, absolute, backslash, and null traversal forms", async () => {
    const workspace = makeTempDir("synara-directory-preview-traversal-");
    const entryPath = path.join(workspace, "index.html");
    writeFileSync(entryPath, "<!doctype html>");
    const result = await createLocalPreviewGrant({
      requestedPath: entryPath,
      cwd: workspace,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "preview",
    });

    for (const encodedRelativePath of [
      "../secret.js",
      "assets/./app.js",
      "assets/%2e%2e/secret.js",
      "%2Fetc/passwd.html",
      "C%3A/Windows/index.html",
      "assets%5Capp.js",
      "assets/%00app.js",
    ]) {
      assert.equal(
        await resolveLocalPreviewGrantResource({
          token: result.grant,
          encodedRelativePath,
        }),
        null,
        encodedRelativePath,
      );
    }
  });

  it("rejects unsupported assets while serving current images and PDFs", async () => {
    const workspace = makeTempDir("synara-directory-preview-assets-");
    const entryPath = path.join(workspace, "index.html");
    const imagePath = path.join(workspace, "hero.png");
    const pdfPath = path.join(workspace, "spec.pdf");
    const binaryPath = path.join(workspace, "payload.bin");
    writeFileSync(entryPath, "<!doctype html>");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));
    writeFileSync(binaryPath, Buffer.from([0, 1, 2]));
    const result = await createLocalPreviewGrant({
      requestedPath: entryPath,
      cwd: workspace,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "browser",
    });

    assert.equal(
      (
        await resolveLocalPreviewGrantResource({
          token: result.grant,
          encodedRelativePath: "hero.png",
        })
      )?.path,
      realpathSync.native(imagePath),
    );
    assert.equal(
      (
        await resolveLocalPreviewGrantResource({
          token: result.grant,
          encodedRelativePath: "spec.pdf",
        })
      )?.path,
      realpathSync.native(pdfPath),
    );
    assert.equal(
      await resolveLocalPreviewGrantResource({
        token: result.grant,
        encodedRelativePath: "payload.bin",
      }),
      null,
    );
  });

  it("rejects an HTML entry symlink that escapes the workspace when supported", async () => {
    const workspace = makeTempDir("synara-directory-preview-entry-link-");
    const outsideRoot = makeTempDir("synara-directory-preview-entry-target-");
    const outsideHtml = path.join(outsideRoot, "outside.html");
    const entryLink = path.join(workspace, "index.html");
    writeFileSync(outsideHtml, "<!doctype html>");
    try {
      symlinkSync(outsideHtml, entryLink, "file");
    } catch {
      return;
    }

    await assert.rejects(
      createLocalPreviewGrant({
        requestedPath: entryLink,
        cwd: workspace,
        allowedWorkspaceRoots: [workspace],
        scope: "directory",
        purpose: "preview",
      }),
      (error: unknown) =>
        error instanceof LocalPreviewGrantError && error.code === "symlink-escape",
    );
  });

  it("rejects an asset symlink into a similarly-prefixed sibling directory", async () => {
    const workspace = makeTempDir("synara-directory-preview-prefix-");
    const siteDir = path.join(workspace, "site");
    const siblingDir = path.join(workspace, "site-private");
    const entryPath = path.join(siteDir, "index.html");
    const secretPath = path.join(siblingDir, "secret.js");
    const linkPath = path.join(siteDir, "secret.js");
    mkdirSync(siteDir);
    mkdirSync(siblingDir);
    writeFileSync(entryPath, "<!doctype html>");
    writeFileSync(secretPath, "globalThis.secret = true");
    try {
      symlinkSync(secretPath, linkPath, "file");
    } catch {
      return;
    }
    const result = await createLocalPreviewGrant({
      requestedPath: entryPath,
      cwd: workspace,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "preview",
    });

    assert.equal(
      await resolveLocalPreviewGrantResource({
        token: result.grant,
        encodedRelativePath: "secret.js",
      }),
      null,
    );
  });

  it("rejects a final file replaced by an outside symlink after validation", async () => {
    const workspace = makeTempDir("synara-directory-preview-open-race-");
    const outsideRoot = makeTempDir("synara-directory-preview-open-race-outside-");
    const entryPath = path.join(workspace, "index.html");
    const assetPath = path.join(workspace, "app.js");
    const originalAssetPath = path.join(workspace, "app.original.js");
    const outsidePath = path.join(outsideRoot, "secret.js");
    writeFileSync(entryPath, "<!doctype html>");
    writeFileSync(assetPath, "globalThis.safe = true;");
    writeFileSync(outsidePath, "globalThis.secret = true;");
    if (!supportsFileSymlinks(outsidePath, workspace)) {
      return;
    }

    const grant = await createLocalPreviewGrant({
      requestedPath: entryPath,
      cwd: workspace,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "browser",
    });
    const resolved = await resolveLocalPreviewGrantResource({
      token: grant.grant,
      encodedRelativePath: "app.js",
    });
    assert.ok(resolved);

    renameSync(assetPath, originalAssetPath);
    symlinkSync(outsidePath, assetPath, "file");

    assert.equal(await openResolvedLocalPreviewFile(resolved), null);
  });

  it("streams the verified descriptor after the final file path is replaced", async () => {
    const workspace = makeTempDir("synara-directory-preview-stream-race-");
    const outsideRoot = makeTempDir("synara-directory-preview-stream-race-outside-");
    const entryPath = path.join(workspace, "index.html");
    const assetPath = path.join(workspace, "app.js");
    const originalAssetPath = path.join(workspace, "app.original.js");
    const outsidePath = path.join(outsideRoot, "secret.js");
    const safeBytes = Buffer.from("globalThis.safe = true;");
    writeFileSync(entryPath, "<!doctype html>");
    writeFileSync(assetPath, safeBytes);
    writeFileSync(outsidePath, "globalThis.secret = true;");
    if (!supportsFileSymlinks(outsidePath, workspace)) {
      return;
    }

    const grant = await createLocalPreviewGrant({
      requestedPath: entryPath,
      cwd: workspace,
      allowedWorkspaceRoots: [workspace],
      scope: "directory",
      purpose: "browser",
    });
    const resolved = await resolveLocalPreviewGrantResource({
      token: grant.grant,
      encodedRelativePath: "app.js",
    });
    assert.ok(resolved);
    const opened = await openResolvedLocalPreviewFile(resolved);
    assert.ok(opened);

    renameSync(assetPath, originalAssetPath);
    symlinkSync(outsidePath, assetPath, "file");

    const chunks: Buffer[] = [];
    for await (const chunk of opened.readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    assert.deepEqual(Buffer.concat(chunks), safeBytes);
    assert.equal(opened.sizeBytes, safeBytes.byteLength);
  });
});
