import { describe, expect, it } from "vitest";

import { DISCLOSURE_TIMING_CLASS } from "~/lib/disclosureMotion";
import { APP_TOOLTIP_SURFACE_CLASS_NAME } from "./chat/composerPickerStyles";
import {
  SIDEBAR_HOVER_CARD_POPUP_PROPS,
  SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME,
  SIDEBAR_HOVER_CARD_TRIGGER_PROPS,
} from "./sidebarHoverCardStyles";

describe("sidebarHoverCardStyles", () => {
  it("keeps thread and project cards on the shared chrome, width, and motion contract", () => {
    expect(SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME).toContain(APP_TOOLTIP_SURFACE_CLASS_NAME);
    expect(SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME).toContain("w-[16rem]");
    expect(SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME).toContain(DISCLOSURE_TIMING_CLASS);
  });

  it("opens and closes without a trigger delay", () => {
    expect(SIDEBAR_HOVER_CARD_TRIGGER_PROPS).toEqual({
      delay: 0,
      closeDelay: 0,
    });
  });

  it("preserves the shared right-side placement", () => {
    expect(SIDEBAR_HOVER_CARD_POPUP_PROPS).toEqual({
      side: "right",
      align: "start",
      sideOffset: -2,
      positionerClassName: "z-[100]",
    });
  });
});
