/**
 * Golden-path E2E — start a new conversation from the shell.
 *
 * Flow: seedFullAuth → shell paints → click pv-header-new-agent-button →
 *   a new-conversation pane opens in the content area (a conversation that
 *   hasn't started yet) → pick "No roles" → type a name in its Name field → type a
 *   first message → press the compose box's Start → the pane turns into the
 *   new conversation, and its row appears in the sidebar.
 *
 * Creates a real (roleless) agent on the target instance — archive it
 * afterwards.
 *
 * Requires: the test user has at least one machine that can host agents.
 *
 * Selector strategy: testids for the pane's parts, accessible names for the
 * compose box's Start. If UI changes and selectors drift, tune here — the
 * shape (pencil → pane → pick → name → start → assert) IS the golden path.
 */
import { test, expect } from "@playwright/test";
import { readCreds, seedFullAuth } from "./helpers/auth";

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? "https://term.example.com";

test.use({ trace: "retain-on-failure" });

test("golden: start a new conversation — pencil → pane → No roles → name → Start", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await seedFullAuth(context, BASE_URL, readCreds());
  const page = await context.newPage();

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toBeVisible();

  // 1. The pencil opens the pane (no dialog).
  const newAgentBtn = page.locator('[data-testid="pv-header-new-agent-button"]');
  await expect(newAgentBtn).toBeVisible({ timeout: 15_000 });
  await newAgentBtn.click();
  const pane = page.locator('[data-testid="new-conversation-pane"]');
  await expect(pane).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 2. "No roles" on the first machine.
  const noRoles = pane.locator('[data-testid^="role-pick-"][data-testid$=":no-roles"]').first();
  await expect(noRoles).toBeVisible({ timeout: 15_000 });
  await noRoles.click();

  // 3. Name it.
  const name = `e2e-golden-${Date.now().toString(36)}`;
  const nameInput = pane.locator('[data-testid="new-conversation-name"]');
  await nameInput.fill(name);
  await nameInput.blur();
  await expect(nameInput).toHaveValue(name);

  // 4. A first message, then Start.
  await pane.locator("textarea").fill("Say hello in one short line.");
  const start = pane.getByRole("button", { name: "Start the conversation" });
  await expect(start).toBeEnabled({ timeout: 10_000 });
  await start.click();

  // 5. The pane turns into the conversation; its row appears. Generous
  //    timeout — the backend has to bring the agent up.
  await expect(pane).toHaveCount(0, { timeout: 90_000 });
  const newRow = page.getByText(new RegExp(name, "i")).first();
  await expect(newRow).toBeVisible({ timeout: 30_000 });

  await context.close();
});
