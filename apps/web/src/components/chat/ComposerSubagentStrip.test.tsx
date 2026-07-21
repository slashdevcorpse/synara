import { ThreadId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerSubagentStrip } from "./ComposerSubagentStrip";
import type { ComposerSubagentStripItem } from "./ComposerSubagentStrip.logic";

function item(
  key: string,
  statusKind: "completed" | "failed" | "stopped",
): ComposerSubagentStripItem {
  return {
    kind: "subagent",
    key,
    threadId: ThreadId.makeUnsafe(key),
    providerThreadId: key,
    primaryLabel: key,
    fullLabel: key,
    role: null,
    modelLabel: "GPT-5.6",
    statusLabel: statusKind,
    statusKind,
    isActive: false,
    isViewed: false,
    isBackground: false,
    accentColor: "#fff",
  };
}

describe("ComposerSubagentStrip", () => {
  it.each([
    [["completed", "completed"], "2 subagents completed"],
    [["failed", "failed"], "2 subagents failed"],
    [["completed", "failed"], "2 subagents settled · 1 completed · 1 failed"],
  ] as const)(
    "renders a compact settled summary for %j with expandable details",
    (statuses, summary) => {
      const markup = renderToStaticMarkup(
        <ComposerSubagentStrip
          items={statuses.map((status, index) => item(`child-${index + 1}`, status))}
          compact
          onCompactChange={vi.fn()}
          onOpenThread={vi.fn()}
        />,
      );

      expect(markup).toContain(summary);
      expect(markup).toContain('aria-expanded="false"');
      expect(markup).toContain('aria-label="Expand subagent strip"');
      expect(markup).toContain("child-1");
      expect(markup).toContain("child-2");
    },
  );
});
