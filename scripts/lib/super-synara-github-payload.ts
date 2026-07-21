// FILE: super-synara-github-payload.ts
// Purpose: Decodes untrusted GitHub API tag and release payloads for release planning.
// Layer: GitHub release boundary

import { assertFullCommitSha } from "./git-sha.ts";
import type { SuperSynaraDraftRelease, SuperSynaraTagRef } from "./super-synara-release-drafter.ts";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: UnknownRecord, field: string, context: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context}.${field} must be a non-empty string.`);
  }
  return value;
}

export function parseSuperSynaraTagObject(
  value: unknown,
  context = "GitHub tag response",
): { readonly sha: string; readonly type: string } {
  if (!isRecord(value) || !isRecord(value.object)) {
    throw new Error(`${context}.object must be an object.`);
  }
  const sha = requiredString(value.object, "sha", `${context}.object`);
  const type = requiredString(value.object, "type", `${context}.object`);
  assertFullCommitSha(`${context}.object.sha`, sha);
  return { sha, type };
}

export function parseSuperSynaraMatchingTagRefs(value: unknown): ReadonlyArray<SuperSynaraTagRef> {
  if (!Array.isArray(value)) {
    throw new Error("GitHub matching-tag response must be an array.");
  }
  return value.map((entry, index) => {
    const context = `GitHub matching-tag response[${index}]`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
    const ref = requiredString(entry, "ref", context);
    if (!ref.startsWith("refs/tags/")) {
      throw new Error(`${context}.ref must use the refs/tags/ namespace.`);
    }
    const object = parseSuperSynaraTagObject(entry, context);
    if (object.type !== "commit") {
      throw new Error(`Super Synara tag ${ref} must point directly to a commit.`);
    }
    return { name: ref.slice("refs/tags/".length), commit: object.sha };
  });
}

function parseRelease(
  entry: unknown,
  pageIndex: number,
  releaseIndex: number,
): SuperSynaraDraftRelease {
  const context = `GitHub releases response[${pageIndex}][${releaseIndex}]`;
  if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
  if (!Number.isSafeInteger(entry.id) || (entry.id as number) <= 0) {
    throw new Error(`${context}.id must be a positive safe integer.`);
  }
  const name = entry.name;
  const body = entry.body;
  if (name !== null && typeof name !== "string") {
    throw new Error(`${context}.name must be a string or null.`);
  }
  if (body !== null && typeof body !== "string") {
    throw new Error(`${context}.body must be a string or null.`);
  }
  if (typeof entry.draft !== "boolean" || typeof entry.prerelease !== "boolean") {
    throw new Error(`${context}.draft and .prerelease must be booleans.`);
  }
  return {
    id: entry.id as number,
    tagName: requiredString(entry, "tag_name", context),
    targetCommitish: requiredString(entry, "target_commitish", context),
    name: name ?? "",
    body: body ?? "",
    draft: entry.draft,
    prerelease: entry.prerelease,
  };
}

export function parseSuperSynaraReleasePages(
  value: unknown,
): ReadonlyArray<SuperSynaraDraftRelease> {
  if (!Array.isArray(value)) {
    throw new Error("GitHub releases response must be an array of pages.");
  }
  return value.flatMap((page, pageIndex) => {
    if (!Array.isArray(page)) {
      throw new Error(`GitHub releases response[${pageIndex}] must be an array.`);
    }
    return page.map((entry, releaseIndex) => parseRelease(entry, pageIndex, releaseIndex));
  });
}
