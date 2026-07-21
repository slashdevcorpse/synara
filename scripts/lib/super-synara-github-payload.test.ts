import { describe, expect, it } from "vitest";

import {
  parseSuperSynaraMatchingTagRefs,
  parseSuperSynaraReleasePages,
  parseSuperSynaraTagObject,
} from "./super-synara-github-payload.ts";

const sha = "a".repeat(40);
const release = {
  id: 17,
  tag_name: "super-v0.5.5-super.8",
  target_commitish: sha,
  name: null,
  body: null,
  draft: true,
  prerelease: true,
};

describe("Super Synara GitHub payload decoding", () => {
  it("decodes direct matching tag refs", () => {
    expect(
      parseSuperSynaraMatchingTagRefs([
        { ref: "refs/tags/super-v0.5.5-super.7", object: { sha, type: "commit" } },
      ]),
    ).toEqual([{ name: "super-v0.5.5-super.7", commit: sha }]);
  });

  it.each([
    ["non-array tags", {}, "must be an array"],
    ["missing ref", [{ object: { sha, type: "commit" } }], ".ref must be"],
    ["wrong namespace", [{ ref: "heads/main", object: { sha, type: "commit" } }], "refs/tags/"],
    ["missing object", [{ ref: "refs/tags/example" }], ".object must be an object"],
    [
      "invalid sha",
      [{ ref: "refs/tags/example", object: { sha: "bad", type: "commit" } }],
      "full 40-character",
    ],
    [
      "annotated tag",
      [{ ref: "refs/tags/example", object: { sha, type: "tag" } }],
      "directly to a commit",
    ],
  ])("rejects %s", (_label, value, message) => {
    expect(() => parseSuperSynaraMatchingTagRefs(value)).toThrow(message as string);
  });

  it("decodes and flattens release pages after validating nullable fields", () => {
    expect(
      parseSuperSynaraReleasePages([[release], [{ ...release, id: 18, name: "name" }]]),
    ).toEqual([
      {
        id: 17,
        tagName: release.tag_name,
        targetCommitish: sha,
        name: "",
        body: "",
        draft: true,
        prerelease: true,
      },
      {
        id: 18,
        tagName: release.tag_name,
        targetCommitish: sha,
        name: "name",
        body: "",
        draft: true,
        prerelease: true,
      },
    ]);
  });

  it.each([
    ["non-array pages", {}, "array of pages"],
    ["non-array page", [{}], "response[0] must be an array"],
    ["unsafe id", [[{ ...release, id: Number.MAX_SAFE_INTEGER + 1 }]], "positive safe integer"],
    ["invalid name", [[{ ...release, name: 4 }]], ".name must be"],
    ["invalid body", [[{ ...release, body: false }]], ".body must be"],
    ["invalid booleans", [[{ ...release, draft: "true" }]], "must be booleans"],
    ["missing tag", [[{ ...release, tag_name: "" }]], ".tag_name must be"],
  ])("rejects %s", (_label, value, message) => {
    expect(() => parseSuperSynaraReleasePages(value)).toThrow(message as string);
  });

  it("decodes a single tag response", () => {
    expect(parseSuperSynaraTagObject({ object: { sha, type: "commit" } })).toEqual({
      sha,
      type: "commit",
    });
  });
});
