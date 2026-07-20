// FILE: ProviderIcon.test.tsx
// Purpose: Covers shared provider icon rendering that many chat surfaces reuse.
// Layer: web UI tests
// Depends on: react-dom server rendering and ProviderIcon provider mapping.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderIcon, PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "./ProviderIcon";

describe("ProviderIcon", () => {
  it("renders a distinct accessible Command Code icon and forwards compatible props", () => {
    const markup = renderToStaticMarkup(
      <ProviderIcon
        provider="commandCode"
        aria-hidden={false}
        aria-label="Command Code"
        data-provider-icon="command-code"
        id="command-code-icon"
        tabIndex={-1}
        title="Command Code provider"
      />,
    );

    expect(PROVIDER_ICON_COMPONENT_BY_PROVIDER.commandCode).toBeDefined();
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Command Code"');
    expect(markup).not.toContain("aria-hidden");
    expect(markup).toContain('data-provider-icon="command-code"');
    expect(markup).toContain('id="command-code-icon"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('title="Command Code provider"');
    expect(markup).toContain("agentic-coding");

    const decorativeMarkup = renderToStaticMarkup(
      <ProviderIcon provider="commandCode" aria-label="Ignored while hidden" />,
    );
    expect(decorativeMarkup).toContain('aria-hidden="true"');
    expect(decorativeMarkup).not.toContain("Ignored while hidden");
  });

  it("uses Antigravity branding", () => {
    expect(PROVIDER_ICON_COMPONENT_BY_PROVIDER).not.toHaveProperty("gemini");

    const markup = renderToStaticMarkup(<ProviderIcon provider="antigravity" />);
    expect(markup).toContain('viewBox="0 0 16 15"');
    expect(markup).toContain("#FFE432");
  });

  it("uses the reversed Central icon for opencode in dark mode", () => {
    const markup = renderToStaticMarkup(
      <ProviderIcon provider="opencode" className="size-4 text-muted-foreground" />,
    );

    expect(markup).toContain("dark:hidden");
    expect(markup).toContain("hidden dark:inline-block");
    expect(markup).toContain("dark:text-foreground/90");
    expect(markup).toContain("/central-icons-reversed/opencode.svg");
  });
});
