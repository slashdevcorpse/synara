// FILE: text.test.ts
// Purpose: Verifies the shared count-pluralization helper used across server and web.
// Layer: Shared runtime utility tests
// Depends on: Vitest and text helpers

import { describe, expect, it } from "vitest";
import { pluralize, splitLines } from "./text";

describe("splitLines", () => {
  it("splits LF, CRLF, and mixed line endings", () => {
    expect(splitLines("alpha\nbeta\ngamma")).toEqual(["alpha", "beta", "gamma"]);
    expect(splitLines("alpha\r\nbeta\r\ngamma")).toEqual(["alpha", "beta", "gamma"]);
    expect(splitLines("alpha\r\nbeta\ngamma\r\n")).toEqual(["alpha", "beta", "gamma", ""]);
  });

  it("preserves empty input and a trailing carriage return for incremental consumers", () => {
    expect(splitLines("")).toEqual([""]);
    expect(splitLines("alpha\r")).toEqual(["alpha\r"]);

    const firstPass = splitLines("alpha\r");
    const remainder = firstPass.pop() ?? "";
    const secondPass = splitLines(`${remainder}\nbeta\r\n`);
    const nextRemainder = secondPass.pop() ?? "";

    expect(firstPass).toEqual([]);
    expect(secondPass).toEqual(["alpha", "beta"]);
    expect(nextRemainder).toBe("");
  });
});

describe("pluralize", () => {
  it("returns the singular form for a count of one", () => {
    expect(pluralize(1, "file")).toBe("file");
  });

  it("defaults the plural form to the singular plus 's'", () => {
    expect(pluralize(0, "file")).toBe("files");
    expect(pluralize(2, "file")).toBe("files");
  });

  it("uses an explicit plural for irregular forms", () => {
    expect(pluralize(1, "has", "have")).toBe("has");
    expect(pluralize(3, "has", "have")).toBe("have");
  });

  it("supports a noun-and-verb phrase as singular/plural", () => {
    expect(pluralize(1, "thread is", "threads are")).toBe("thread is");
    expect(pluralize(5, "thread is", "threads are")).toBe("threads are");
  });
});
