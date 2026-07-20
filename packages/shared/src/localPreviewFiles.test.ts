import { describe, expect, it } from "vitest";

import {
  isSupportedLocalHtmlPath,
  isSupportedLocalImagePath,
  isSupportedLocalPreviewAssetPath,
  isSupportedLocalPreviewFilePath,
  localPreviewContentTypeForPath,
  lowerCaseExtensionOf,
} from "./localPreviewFiles";

describe("local preview file policy", () => {
  it("keeps legacy image/PDF preview detection narrow", () => {
    expect(isSupportedLocalImagePath("hero.PNG")).toBe(true);
    expect(isSupportedLocalPreviewFilePath("guide.pdf")).toBe(true);
    expect(isSupportedLocalPreviewFilePath("index.html")).toBe(false);
    expect(isSupportedLocalPreviewFilePath("app.js")).toBe(false);
  });

  it("recognizes HTML entries and the conservative directory asset allowlist", () => {
    expect(isSupportedLocalHtmlPath("index.HTML")).toBe(true);
    expect(isSupportedLocalHtmlPath("legacy.htm")).toBe(true);

    for (const filePath of [
      "index.html",
      "styles/site.css",
      "scripts/app.js",
      "scripts/module.mjs",
      "pkg/module.wasm",
      "fonts/inter.woff2",
      "data/fixture.json",
      "media/clip.mp4",
      "media/voice.mp3",
      "images/hero.webp",
      "docs/spec.pdf",
    ]) {
      expect(isSupportedLocalPreviewAssetPath(filePath), filePath).toBe(true);
    }
  });

  it("rejects unknown executable and binary extensions", () => {
    for (const filePath of [
      "README",
      "notes.txt",
      "archive.zip",
      "payload.exe",
      "library.dll",
      "module.node",
    ]) {
      expect(isSupportedLocalPreviewAssetPath(filePath), filePath).toBe(false);
      expect(localPreviewContentTypeForPath(filePath), filePath).toBeNull();
    }
  });

  it("provides explicit MIME types for executable and text assets", () => {
    expect(localPreviewContentTypeForPath("index.html")).toBe("text/html; charset=utf-8");
    expect(localPreviewContentTypeForPath("theme.css")).toBe("text/css; charset=utf-8");
    expect(localPreviewContentTypeForPath("app.js")).toBe("text/javascript; charset=utf-8");
    expect(localPreviewContentTypeForPath("app.mjs")).toBe("text/javascript; charset=utf-8");
    expect(localPreviewContentTypeForPath("app.wasm")).toBe("application/wasm");
    expect(localPreviewContentTypeForPath("data.json")).toBe("application/json; charset=utf-8");
  });

  it("provides explicit MIME types for existing image/PDF and common asset support", () => {
    expect(localPreviewContentTypeForPath("hero.svg")).toBe("image/svg+xml");
    expect(localPreviewContentTypeForPath("photo.JPEG")).toBe("image/jpeg");
    expect(localPreviewContentTypeForPath("spec.pdf")).toBe("application/pdf");
    expect(localPreviewContentTypeForPath("font.woff2")).toBe("font/woff2");
    expect(localPreviewContentTypeForPath("movie.webm")).toBe("video/webm");
  });

  it("extracts only the final lower-case extension", () => {
    expect(lowerCaseExtensionOf("folder.with.dots/file.CSS")).toBe(".css");
    expect(lowerCaseExtensionOf("extensionless")).toBeNull();
  });
});
