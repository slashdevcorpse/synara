// FILE: desktop.e2e.ts
// Purpose: Production-boundary Electron journeys shared by Windows and Linux CI.

import * as FS from "node:fs";
import * as Http from "node:http";
import * as Path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, type DesktopHarness } from "./desktop.fixture";

const PROJECT_NAME = "workspace";
const APPROVAL_MARKER_FILENAME = "e2e-approval-command-output.txt";

async function addAndSelectProject(desktop: DesktopHarness): Promise<void> {
  const { page, workspaceDir } = desktop;
  const projectsSectionLabel = page.getByText("Projects", { exact: true }).last();
  await expect(projectsSectionLabel).toBeVisible({ timeout: 60_000 });
  await projectsSectionLabel.hover();
  const addProjectButton = page.getByRole("button", { name: "Add project", exact: true }).first();
  await expect(addProjectButton).toBeVisible({ timeout: 60_000 });
  await addProjectButton.click({ trial: true });
  await addProjectButton.click();
  await page.getByRole("button", { name: "Type path", exact: true }).click();
  const projectPathInput = page.getByRole("textbox", { name: "Project path" });
  await projectPathInput.fill(workspaceDir);
  await projectPathInput.press("Enter");

  await expect(page.getByText(PROJECT_NAME, { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("composer-editor")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => new URL(page.url()).pathname).not.toBe("/");
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const editor = page.getByTestId("composer-editor");
  await expect(editor).toBeVisible();
  await editor.fill(prompt);
  const sendButton = page.getByRole("button", { name: "Send message", exact: true });
  await expect(sendButton).toBeEnabled({ timeout: 30_000 });
  await sendButton.click();
}

async function expectAssistantText(page: Page, text: string): Promise<void> {
  await expect(page.getByText(text, { exact: true }).last()).toBeVisible({ timeout: 30_000 });
}

function requestMethods(entries: readonly Record<string, unknown>[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.direction !== "in" || !entry.payload || typeof entry.payload !== "object") return [];
    const method = (entry.payload as { method?: unknown }).method;
    return typeof method === "string" ? [method] : [];
  });
}

function notificationMethods(entries: readonly Record<string, unknown>[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.direction !== "out" || !entry.payload || typeof entry.payload !== "object") return [];
    const method = (entry.payload as { method?: unknown }).method;
    return typeof method === "string" ? [method] : [];
  });
}

function latestRequestParam(
  entries: readonly Record<string, unknown>[],
  method: string,
  param: string,
): unknown {
  const matching = entries.filter((entry) => {
    if (entry.direction !== "in" || !entry.payload || typeof entry.payload !== "object") return false;
    return (entry.payload as { method?: unknown }).method === method;
  });
  const payload = matching.at(-1)?.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const params = (payload as { params?: unknown }).params;
  return params && typeof params === "object"
    ? (params as Record<string, unknown>)[param]
    : undefined;
}

function latestProtocolProvider(
  entries: readonly Record<string, unknown>[],
  method: string,
): unknown {
  return entries
    .filter((entry) => {
      if (entry.direction !== "in" || !entry.payload || typeof entry.payload !== "object") {
        return false;
      }
      return (entry.payload as { method?: unknown }).method === method;
    })
    .at(-1)?.provider;
}

async function startLocalPageServer(): Promise<{
  readonly origin: string;
  readonly close: () => Promise<void>;
}> {
  const server = Http.createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      "<!doctype html><html><head><title>Synara E2E Local Page</title></head><body><main>E2E_LOCAL_BROWSER_OK</main></body></html>",
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The local browser fixture did not bind a TCP port.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

test("creates and selects a project, then sends and renders an assistant response", async ({
  desktop,
}) => {
  await addAndSelectProject(desktop);

  await expect(desktop.page.getByTestId("new-thread-button")).toBeVisible();
  await expect(desktop.page.getByTestId("composer-editor")).toBeEditable();
  const modelPicker = desktop.page.getByRole("button", { name: "GPT-5.5", exact: true });
  await expect(modelPicker).toBeVisible();
  await expect(modelPicker).toContainText("GPT-5.5");
  await modelPicker.click();
  const codexProvider = desktop.page.getByRole("menuitem", { name: "Codex", exact: true });
  await expect(codexProvider).toBeVisible({ timeout: 30_000 });
  await expect(codexProvider).toBeEnabled();
  await codexProvider.hover();
  const e2eModel = desktop.page.getByRole("menuitemradio", {
    name: "GPT-5.3 Codex",
    exact: true,
  });
  await expect(e2eModel).toBeVisible();
  await e2eModel.click();
  const selectedModelPicker = desktop.page.getByRole("button", {
    name: "GPT-5.3 Codex",
    exact: true,
  });
  await expect(selectedModelPicker).toBeVisible();
  await selectedModelPicker.click();
  await expect(codexProvider).toBeEnabled();
  await codexProvider.hover();
  await expect(e2eModel).toBeChecked();
  await desktop.page.keyboard.press("Escape");
  await sendPrompt(desktop.page, "E2E_BASIC_SEND");
  await expectAssistantText(desktop.page, "E2E_ASSISTANT_REPLY");
  await expect
    .poll(async () => requestMethods(await desktop.readProtocolLog()))
    .toContain("turn/start");
  await expect
    .poll(async () => latestRequestParam(await desktop.readProtocolLog(), "turn/start", "model"))
    .toBe("gpt-5.3-codex");
  await expect
    .poll(async () => latestProtocolProvider(await desktop.readProtocolLog(), "turn/start"))
    .toBe("codex");
});

test("surfaces and resolves a command approval", async ({ desktop }) => {
  await addAndSelectProject(desktop);

  await sendPrompt(desktop.page, "E2E_APPROVAL");
  const approveOnce = desktop.page.getByRole("button", { name: /Approve once/u });
  await expect(approveOnce).toBeVisible({ timeout: 30_000 });
  await approveOnce.click();
  await expectAssistantText(desktop.page, "E2E_APPROVAL_ACCEPTED");
  const workSummary = desktop.page.getByRole("button", { name: /^Worked for /u }).last();
  await expect(workSummary).toBeVisible({ timeout: 30_000 });
  await workSummary.click();
  const commandRow = desktop.page
    .getByRole("button", { name: /^Ran /u })
    .filter({ hasText: APPROVAL_MARKER_FILENAME })
    .last();
  await expect(commandRow).toBeVisible({ timeout: 30_000 });
  await commandRow.click();
  await expect(
    desktop.page.getByText("E2E_APPROVAL_COMMAND_OUTPUT", { exact: true }),
  ).toBeVisible();
  const approvalMarkerPath = Path.join(desktop.workspaceDir, APPROVAL_MARKER_FILENAME);
  await expect.poll(() => FS.existsSync(approvalMarkerPath)).toBe(true);
  await expect
    .poll(() => FS.promises.readFile(approvalMarkerPath, "utf8"))
    .toBe("E2E_APPROVAL_COMMAND_OUTPUT\n");
  await expect
    .poll(async () => JSON.stringify(await desktop.readProtocolLog()))
    .toContain('"decision":"accept"');
});

test("interrupts an active provider turn", async ({ desktop }) => {
  await addAndSelectProject(desktop);

  await sendPrompt(desktop.page, "E2E_INTERRUPT");
  const stopButton = desktop.page.getByRole("button", { name: "Stop generation", exact: true });
  await expect(stopButton).toBeVisible({ timeout: 30_000 });
  await expectAssistantText(desktop.page, "E2E_INTERRUPT_RUNNING");
  await stopButton.click();
  await expect(stopButton).toBeHidden({ timeout: 30_000 });
  await expect
    .poll(async () => requestMethods(await desktop.readProtocolLog()))
    .toContain("turn/interrupt");
  await expect
    .poll(async () => notificationMethods(await desktop.readProtocolLog()))
    .toContain("turn/aborted");
  await sendPrompt(desktop.page, "E2E_RECOVERY_SEND");
  await expectAssistantText(desktop.page, "E2E_ASSISTANT_REPLY");
});

test("runs a real terminal and renders echoed output", async ({ desktop }) => {
  await addAndSelectProject(desktop);

  await desktop.page.getByRole("button", { name: "workspace", exact: true }).hover();
  const createTerminal = desktop.page.getByRole("button", {
    name: "Create new terminal thread in workspace",
    exact: true,
  });
  await expect(createTerminal).toBeVisible();
  await createTerminal.click();
  const terminalInput = desktop.page
    .getByRole("textbox", { name: "Terminal input", exact: true })
    .last();
  await expect(terminalInput).toBeVisible({ timeout: 30_000 });
  await terminalInput.focus();
  await desktop.page.keyboard.type('node -e "console.log(\'E2E_TERMINAL_\'+(6*7))"');
  await desktop.page.keyboard.press("Enter");
  await desktop.page.keyboard.press("Control+f");
  const findInput = desktop.page.getByRole("textbox", { name: "Find", exact: true });
  await expect(findInput).toBeVisible();
  const noResults = desktop.page.getByText("No results", { exact: true });
  await findInput.fill("E2E_TERMINAL_OUTPUT_THAT_DOES_NOT_EXIST");
  await expect(noResults).toBeVisible({ timeout: 30_000 });
  await findInput.fill("E2E_TERMINAL_42");
  await expect(noResults).toBeHidden({ timeout: 30_000 });
});

test("opens a workspace file in source and rendered preview modes", async ({ desktop }) => {
  const markdownPath = Path.join(desktop.workspaceDir, "e2e-preview.md");
  await FS.promises.writeFile(
    markdownPath,
    "# E2E Preview Heading\n\nE2E_SOURCE_AND_PREVIEW_OK\n",
    "utf8",
  );
  await addAndSelectProject(desktop);

  await desktop.page.getByRole("button", { name: "Toggle environment panel" }).click();
  await desktop.page.getByRole("button", { name: "Editor view", exact: true }).click();
  await desktop.page.getByRole("button", { name: "Search files", exact: true }).click();
  const searchInput = desktop.page.getByRole("textbox", { name: "Search files" });
  await searchInput.fill("e2e-preview.md");
  const result = desktop.page.getByRole("button", { name: /e2e-preview\.md/u });
  await expect(result).toBeVisible({ timeout: 30_000 });
  await result.click();

  const markdownView = desktop.page.getByRole("radiogroup", { name: "Markdown view" });
  await expect(markdownView.getByRole("radio", { name: "Source" })).toBeChecked();
  await expect(desktop.page.locator(".editor-file-viewer")).toContainText(
    "# E2E Preview Heading",
  );
  await markdownView.getByRole("radio", { name: "Preview" }).click();
  await expect(markdownView.getByRole("radio", { name: "Preview" })).toBeChecked();
  await expect(
    desktop.page.getByRole("heading", { name: "E2E Preview Heading", exact: true }),
  ).toBeVisible();
  await expect(desktop.page.locator(".editor-markdown-preview__body")).toContainText(
    "E2E_SOURCE_AND_PREVIEW_OK",
  );
});

test("loads a localhost page in the real desktop browser pane", async ({ desktop }) => {
  const localPage = await startLocalPageServer();
  try {
    await addAndSelectProject(desktop);
    await desktop.page.keyboard.press("Control+Shift+B");
    const addressInput = desktop.page.getByPlaceholder("Search or enter a URL");
    await expect(addressInput).toBeVisible({ timeout: 30_000 });
    await addressInput.fill(localPage.origin);
    await addressInput.press("Enter");
    await expect(addressInput).toHaveValue(new RegExp(`^${localPage.origin.replaceAll(".", "\\.")}`));
    await expect
      .poll(
        async () =>
          desktop.electronApp.evaluate(async ({ webContents }, expectedOrigin) => {
            const browserContents = webContents
              .getAllWebContents()
              .find((contents) => contents.getURL().startsWith(expectedOrigin));
            if (!browserContents) return null;
            return browserContents.executeJavaScript("document.body.innerText", true) as Promise<string>;
          }, localPage.origin),
        { timeout: 30_000 },
      )
      .toContain("E2E_LOCAL_BROWSER_OK");
  } finally {
    await localPage.close();
  }
});

test("persists conversation state and resumes the provider after desktop restart", async ({
  desktop,
}) => {
  await addAndSelectProject(desktop);
  await sendPrompt(desktop.page, "E2E_PERSISTENCE_SETUP");
  await expectAssistantText(desktop.page, "E2E_ASSISTANT_REPLY");

  const restartProtocolBaseline = (await desktop.readProtocolLog()).length;
  await desktop.restart();
  await expect(desktop.page.getByText("E2E_PERSISTENCE_SETUP", { exact: true }).last()).toBeVisible({
    timeout: 30_000,
  });
  await expectAssistantText(desktop.page, "E2E_ASSISTANT_REPLY");
  await sendPrompt(desktop.page, "E2E_AFTER_RECOVERY");
  await expectAssistantText(desktop.page, "E2E_RECOVERY_REPLY");
  await expect
    .poll(async () =>
      requestMethods((await desktop.readProtocolLog()).slice(restartProtocolBaseline)),
    )
    .toContain("thread/resume");
});
