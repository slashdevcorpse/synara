import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ProjectCreateLocalFilePreviewGrantInput,
  ProjectCreateLocalFilePreviewGrantResult,
} from "./project";

describe("local preview grant contracts", () => {
  it("keeps legacy path-only grant requests compatible", () => {
    expect(
      Schema.decodeUnknownSync(ProjectCreateLocalFilePreviewGrantInput)({
        path: "C:\\Users\\dev\\Downloads\\spec.pdf",
      }),
    ).toEqual({ path: "C:\\Users\\dev\\Downloads\\spec.pdf" });
  });

  it("accepts scoped directory grants with an explicit purpose", () => {
    expect(
      Schema.decodeUnknownSync(ProjectCreateLocalFilePreviewGrantInput)({
        path: "demos/index.html",
        cwd: "C:\\repo",
        scope: "directory",
        purpose: "browser",
      }),
    ).toEqual({
      path: "demos/index.html",
      cwd: "C:\\repo",
      scope: "directory",
      purpose: "browser",
    });
  });

  it("rejects unknown grant scopes and purposes", () => {
    expect(() =>
      Schema.decodeUnknownSync(ProjectCreateLocalFilePreviewGrantInput)({
        path: "index.html",
        scope: "workspace",
        purpose: "unsafe",
      }),
    ).toThrow();
  });

  it("accepts the stable URL only as an additive result field", () => {
    expect(
      Schema.decodeUnknownSync(ProjectCreateLocalFilePreviewGrantResult)({
        grant: "grant-id",
        expiresAt: "2026-07-20T12:00:00.000Z",
        urlPath: "/api/local-preview/grant-id/demo%20file.html",
      }),
    ).toEqual({
      grant: "grant-id",
      expiresAt: "2026-07-20T12:00:00.000Z",
      urlPath: "/api/local-preview/grant-id/demo%20file.html",
    });
  });
});
