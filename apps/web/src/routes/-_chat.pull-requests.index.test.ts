// FILE: -_chat.pull-requests.index.test.ts
// Purpose: Focused regression tests for pull-request detail retention.

import type { ProjectId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveRenderedPullRequestInput,
  retainActivePullRequestInput,
} from "./_chat.pull-requests.index";

describe("resolveRenderedPullRequestInput", () => {
  const previous = {
    projectId: "project-a" as ProjectId,
    repository: "owner/repository",
    number: 41,
  } as const;
  const selected = {
    projectId: "project-b" as ProjectId,
    repository: "owner/other-repository",
    number: 42,
  } as const;

  it("renders a newly selected pull request instead of the retained one", () => {
    expect(resolveRenderedPullRequestInput(selected, previous)).toBe(selected);
  });

  it("retains the previous pull request only after the live selection closes", () => {
    expect(resolveRenderedPullRequestInput(null, previous)).toBe(previous);
  });

  it("captures an active switch before a subsequent close", () => {
    const retainedAfterSwitch = retainActivePullRequestInput(selected, previous);

    expect(retainedAfterSwitch).toBe(selected);
    expect(retainActivePullRequestInput(null, retainedAfterSwitch)).toBe(selected);
  });

  it("keeps retained identity when the active selection is unchanged", () => {
    expect(retainActivePullRequestInput({ ...previous }, previous)).toBe(previous);
  });
});
