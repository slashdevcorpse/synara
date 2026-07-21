import { afterEach, describe, expect, it } from "vitest";

import {
  buildLocalImageUrl,
  buildLocalPreviewCapabilityUrl,
  isLocalImageMarkdownSrc,
  localImageFileName,
} from "./localImageUrls";

describe("local image URL helpers", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("detects local markdown image paths", () => {
    expect(isLocalImageMarkdownSrc("/Users/me/.codex/generated_images/thread/call.png")).toBe(true);
    expect(isLocalImageMarkdownSrc("./preview.webp")).toBe(true);
    expect(
      isLocalImageMarkdownSrc("C:\\Users\\me\\codex\\generated_images\\thread\\call.png"),
    ).toBe(true);
    expect(isLocalImageMarkdownSrc("D:/codex/generated_images/thread/call.png")).toBe(true);
    expect(isLocalImageMarkdownSrc("https://example.com/image.png")).toBe(false);
    expect(isLocalImageMarkdownSrc("/Users/me/file.txt")).toBe(false);
  });

  it("builds preview and download routes (no window context)", () => {
    expect(
      buildLocalImageUrl({
        src: "/Users/me/.codex/generated_images/thread/call.png",
        cwd: "/Users/me/project",
      }),
    ).toBe(
      "/api/local-image?path=%2FUsers%2Fme%2F.codex%2Fgenerated_images%2Fthread%2Fcall.png&cwd=%2FUsers%2Fme%2Fproject",
    );

    expect(
      buildLocalImageUrl({
        src: "/tmp/generated image.png",
        cwd: undefined,
        download: true,
      }),
    ).toBe("/api/local-image?path=%2Ftmp%2Fgenerated+image.png&download=1");
  });

  it("includes local preview grants when present", () => {
    expect(
      buildLocalImageUrl({
        src: "/Users/me/Downloads/shot.png",
        cwd: undefined,
        grant: "grant-token",
      }),
    ).toBe("/api/local-image?path=%2FUsers%2Fme%2FDownloads%2Fshot.png&grant=grant-token");
  });

  it("forwards the desktop bridge legacy token so <img> requests stay authenticated", () => {
    (globalThis as unknown as { window: object }).window = {
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:51204/?token=secret-token-123" },
      location: { origin: "app://synara/" },
    };
    const url = buildLocalImageUrl({
      src: "/Users/me/.codex/generated_images/thread/call.png",
      cwd: "/Users/me/project",
      download: true,
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("http://127.0.0.1:51204");
    expect(parsed.pathname).toBe("/api/local-image");
    expect(parsed.searchParams.get("path")).toBe(
      "/Users/me/.codex/generated_images/thread/call.png",
    );
    expect(parsed.searchParams.get("cwd")).toBe("/Users/me/project");
    expect(parsed.searchParams.get("download")).toBe("1");
    expect(parsed.searchParams.get("token")).toBe("secret-token-123");
  });

  it("resolves capability URLs without forwarding the startup token", () => {
    (globalThis as unknown as { window: object }).window = {
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:51204/?token=startup-secret" },
      location: { origin: "app://synara/" },
    };

    const parsed = new URL(
      buildLocalPreviewCapabilityUrl("/api/local-preview/grant-id/demo%20file.html"),
    );
    expect(parsed.origin).toBe("http://127.0.0.1:51204");
    expect(parsed.pathname).toBe("/api/local-preview/grant-id/demo%20file.html");
    expect(parsed.searchParams.has("token")).toBe(false);
  });

  it("rejects off-origin and path-traversing capability values", () => {
    (globalThis as unknown as { window: object }).window = {
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:51204/?token=startup-secret" },
      location: { origin: "app://synara/" },
    };

    expect(() =>
      buildLocalPreviewCapabilityUrl("https://attacker.invalid/api/local-preview/grant/demo.html"),
    ).toThrow("Invalid local preview capability path.");
    expect(() =>
      buildLocalPreviewCapabilityUrl("//attacker.invalid/api/local-preview/grant/demo.html"),
    ).toThrow("Invalid local preview capability path.");
    expect(() =>
      buildLocalPreviewCapabilityUrl("/api/local-preview/grant/../../outside.html"),
    ).toThrow("Invalid local preview capability path.");
  });

  it("derives display file names", () => {
    expect(localImageFileName("/tmp/generated%20image.png")).toBe("generated image.png");
  });
});
