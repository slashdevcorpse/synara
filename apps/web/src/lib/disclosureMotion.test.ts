import { describe, expect, it } from "vitest";

import {
  disclosureChevronClassName,
  disclosureContentClassName,
  disclosureShellClassName,
  DISCLOSURE_CHEVRON_MOTION_CLASS,
  DISCLOSURE_COLLAPSIBLE_PANEL_CLASS,
  DISCLOSURE_CONTENT_MOTION_CLASS,
  DISCLOSURE_SHELL_MOTION_CLASS,
  DISCLOSURE_SHELL_CLOSED_CLASS,
  DISCLOSURE_SHELL_OPEN_CLASS,
  DISCLOSURE_TIMING_CLASS,
  DISCLOSURE_WIDTH_MOTION_CLASS,
} from "./disclosureMotion";

describe("disclosureMotion", () => {
  it("maps open state to the shared shell classes", () => {
    expect(disclosureShellClassName(true)).toContain(DISCLOSURE_SHELL_OPEN_CLASS);
    expect(disclosureShellClassName(false)).toContain(DISCLOSURE_SHELL_CLOSED_CLASS);
  });

  it("rotates the chevron when open", () => {
    expect(disclosureChevronClassName(true)).toContain("rotate-90");
    expect(disclosureChevronClassName(false)).not.toContain("rotate-90");
  });

  it("disables interaction on closed content", () => {
    expect(disclosureContentClassName(false)).toContain("pointer-events-none");
    expect(disclosureContentClassName(true)).not.toContain("pointer-events-none");
  });

  it("keeps every disclosure path on the shared 220ms reduced-motion contract", () => {
    expect(DISCLOSURE_TIMING_CLASS).toBe(
      "duration-220 ease-out motion-reduce:transition-none",
    );

    for (const className of [
      DISCLOSURE_SHELL_MOTION_CLASS,
      DISCLOSURE_CONTENT_MOTION_CLASS,
      DISCLOSURE_CHEVRON_MOTION_CLASS,
      DISCLOSURE_COLLAPSIBLE_PANEL_CLASS,
      DISCLOSURE_WIDTH_MOTION_CLASS,
    ]) {
      expect(className).toContain(DISCLOSURE_TIMING_CLASS);
    }
  });
});
