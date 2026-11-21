// A "type a name" dialog opened from a menu item (Rename…, New project…, …)
// opens with its text field focused and the old text selected, whichever way
// the menu was opened — the menu closing must not take focus back.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RowKebabMenu, useRowKebabContextMenu } from "./RowKebabMenu";
import { kitPrompt, __resetKitDialogsForTests } from "@/components/kit";

if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const items = [
  {
    label: "Rename…",
    onClick: () => void kitPrompt({ title: "Rename conversation", defaultValue: "Old title" }),
  },
];

function Surface() {
  const ctx = useRowKebabContextMenu(items);
  return (
    <div data-testid="surface" tabIndex={0} onContextMenu={ctx.onContextMenu}>
      row
      <RowKebabMenu items={items} />
      {ctx.menu}
    </div>
  );
}

afterEach(() => __resetKitDialogsForTests());

async function expectPromptFocused() {
  const input = (await screen.findByTestId("kit-prompt-input")) as HTMLInputElement;
  // Past the menu's close focus handling and the dialog's select-all.
  await new Promise((r) => setTimeout(r, 100));
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe("Old title".length);
}

describe("a prompt opened from a menu keeps focus", () => {
  it("from the ⋮ button", async () => {
    render(<Surface />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("row-kebab-trigger"));
    await user.click(screen.getByRole("menuitem", { name: "Rename…" }));
    await expectPromptFocused();
  });

  it("from the ⋮ button with the keyboard", async () => {
    render(<Surface />);
    const user = userEvent.setup();
    screen.getByTestId("row-kebab-trigger").focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menuitem", { name: "Rename…" });
    await user.keyboard("{Enter}");
    await expectPromptFocused();
  });

  it("from a right-click", async () => {
    render(<Surface />);
    const user = userEvent.setup();
    await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("surface") });
    await new Promise((r) => setTimeout(r, 500)); // past the menu's open-settle window
    await user.click(screen.getByRole("menuitem", { name: "Rename…" }));
    await expectPromptFocused();
  });
});
