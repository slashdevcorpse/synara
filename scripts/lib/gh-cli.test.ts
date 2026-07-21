import { describe, expect, it, vi } from "vitest";

import {
  GH_CLI_TIMEOUT_MS,
  GhCliRequestError,
  GhCliStartError,
  type GhSpawnResult,
  runGh,
} from "./gh-cli.ts";

const result = (overrides: Partial<GhSpawnResult> = {}): GhSpawnResult => ({
  status: 0,
  stderr: "",
  stdout: "ok",
  ...overrides,
});

describe("runGh", () => {
  it("returns stdout for a successful command", () => {
    expect(
      runGh(
        ["api", "rate_limit"],
        {},
        vi.fn(() => result()),
      ),
    ).toBe("ok");
  });

  it("reports a GitHub CLI launch failure", () => {
    const error = new Error("spawn gh ENOENT");
    expect(() =>
      runGh(
        ["api", "rate_limit"],
        {},
        vi.fn(() => result({ error, status: null })),
      ),
    ).toThrow(GhCliStartError);
    expect(() =>
      runGh(
        ["api", "rate_limit"],
        {},
        vi.fn(() => result({ error, status: null })),
      ),
    ).toThrow("gh could not start: spawn gh ENOENT");
  });

  it("bounds GitHub CLI calls and keeps timeout failures retryable", () => {
    const error = Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" });
    const spawn = vi.fn(() => result({ error, status: null }));
    try {
      runGh(["api", "rate_limit"], {}, spawn);
      throw new Error("Expected runGh to throw.");
    } catch (caught) {
      expect(caught).toBeInstanceOf(GhCliRequestError);
      expect((caught as GhCliRequestError).retryable).toBe(true);
      expect((caught as Error).message).toContain(
        `gh api rate_limit timed out after ${GH_CLI_TIMEOUT_MS}ms`,
      );
    }
    expect(spawn).toHaveBeenCalledWith("gh", ["api", "rate_limit"], {
      encoding: "utf8",
      shell: false,
      timeout: GH_CLI_TIMEOUT_MS,
    });
  });

  for (const [stderr, retryable] of [
    ["HTTP 500", true],
    ["HTTP 599", true],
    ["HTTP 600", false],
    ["HTTP 429", true],
    ["connection reset by peer", true],
    ["EOF", true],
    ["i/o timeout", true],
    ["context deadline exceeded", true],
    ["HTTP 403: API rate limit exceeded", true],
    ["HTTP 401", false],
    ["HTTP 403", false],
    ["validation failed", false],
  ] as const) {
    it(`classifies ${stderr} request failures`, () => {
      try {
        runGh(
          ["api", "rate_limit"],
          {},
          vi.fn(() => result({ status: 1, stderr })),
        );
        throw new Error("Expected runGh to throw.");
      } catch (error) {
        expect(error).toBeInstanceOf(GhCliRequestError);
        expect((error as GhCliRequestError).retryable).toBe(retryable);
        expect((error as Error).message).toContain(`gh api rate_limit failed: ${stderr}`);
      }
    });
  }

  it("admits an expected missing ref only when requested", () => {
    const spawn = vi.fn(() => result({ status: 1, stderr: "HTTP 404: Not Found" }));
    expect(runGh(["api", "missing"], { allowNotFound: true }, spawn)).toBe("");
    expect(() => runGh(["api", "missing"], {}, spawn)).toThrow("HTTP 404");
    expect(() =>
      runGh(
        ["api", "missing"],
        { allowNotFound: true },
        vi.fn(() => result({ status: 1, stderr: "Not Found" })),
      ),
    ).toThrow("Not Found");
  });
});
