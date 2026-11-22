// Shared test helpers for NewConversationPane (ported from the old
// NewSessionDialog.roles-test-helpers.ts when the dialog became a pane).
//
// The roles are a list right in the pane (RolePickList, "pane" variant). Each
// entry is a row `[data-testid="role-pick-<value>"]` that toggles on click and
// carries a check (aria-label "Picked") while picked. Rows sit in one group
// per machine (`[data-testid="role-pick-group-<hostId>"]`), titled with the
// machine's name only when there is more than one machine.
//
// With one machine a row's value is the bare slug; with several it is
// `${hostId}/${slug}`. Each machine's group starts with "No roles", whose
// value is NO_ROLES_VALUE (`${hostId}/${NO_ROLES_VALUE}` with several).
//
// The list shows what is picked, not the order it was picked in — pick order
// is asserted on the birth request (first pick → `role`, the rest → `roles`).
// pickedRoleValues() therefore reads in list order.
//
// Pane specifics (vs. the dialog): the name is a Name field at the top
// (`new-conversation-name`; the pill always reads "New conversation" / "New
// shell"); starting is the compose box's
// main button ("Start the conversation") or Enter in its textarea; the pane
// reads hostTree / isAdmin / updatePicks / started / close from
// NewConversationHostContext — renderPane() wraps it with vi.fn() spies.

import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type { Host, HostFolder, NewConversationPicks } from "@/types/ui-types";
import { NewConversationPane } from "./NewConversationPane";
import { NewConversationHostContext, type NewConversationHost } from "./new-conversation-context";


/** The "No roles" entry's value (bare, single-host). */
export const NO_ROLES_VALUE = ":no-roles";

const isNoRolesValue = (v: string) =>
  v === NO_ROLES_VALUE || v.endsWith(`/${NO_ROLES_VALUE}`);

function queryList(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="role-pick-list"]');
}

const queryLoadingLine = (list: HTMLElement) =>
  list.querySelector('[data-testid="role-pick-loading"]');

/**
 * The roles list once every machine has answered, or null — absent (shell
 * mode) or still showing its "Loading roles…" line. (Groups that have loaded
 * show and can be picked while that line is up; see rolesLoading.)
 */
export function queryRolesGroup(): HTMLElement | null {
  const list = queryList();
  if (!list) return null;
  if (queryLoadingLine(list)) return null;
  return list;
}

/** The roles list; throws when it is not usable (see queryRolesGroup). */
export function getRolesGroup(): HTMLElement {
  const list = queryRolesGroup();
  if (!list) throw new Error("getRolesGroup: roles list not rendered/loaded");
  return list;
}

/** The list is showing its "Loading roles…" line (some machine hasn't answered). */
export function rolesLoading(): boolean {
  const list = queryList();
  return !!list && !!queryLoadingLine(list);
}

/** Every role row (including "No roles"), in list order. */
export function roleRows(): HTMLElement[] {
  const list = queryList();
  if (!list) return [];
  return Array.from(
    list.querySelectorAll<HTMLElement>(
      '[data-testid^="role-pick-group-"] [data-testid^="role-pick-"]',
    ),
  );
}

const rowValue = (el: HTMLElement) => (el.dataset.testid ?? "").slice("role-pick-".length);

/** The row for a value, or null. */
export function roleRow(value: string): HTMLElement | null {
  return roleRows().find((r) => rowValue(r) === value) ?? null;
}

/**
 * A row is picked when it carries the check — and its button says so to
 * screen readers (aria-pressed); the two must agree.
 */
export function isPicked(row: HTMLElement): boolean {
  const checked = row.querySelector('[aria-label="Picked"]') !== null;
  const btn = row.matches("button") ? row : row.querySelector("button");
  const pressed = btn?.getAttribute("aria-pressed") === "true";
  if (checked !== pressed) {
    throw new Error(`isPicked: check (${checked}) and aria-pressed (${pressed}) disagree`);
  }
  return checked;
}

/** A row is disabled while the pane is busy (starting). */
export function isRowDisabled(row: HTMLElement): boolean {
  if (row.dataset.disabled === "true") return true;
  const btn = row.matches("button") ? (row as HTMLButtonElement) : row.querySelector("button");
  return !!btn && (btn as HTMLButtonElement).disabled;
}

/**
 * Role values in list order (bare slugs single-host, `${hostId}/${slug}`
 * multi-host). "No roles" entries are left out.
 */
export function roleOptionValues(): string[] {
  return roleRows().map(rowValue).filter((v) => !isNoRolesValue(v));
}

/** Toggle the "No roles" entry — the lone one, or `hostId`'s with several hosts. */
export function toggleNoRoles(hostId?: string): void {
  const want = hostId === undefined ? NO_ROLES_VALUE : `${hostId}/${NO_ROLES_VALUE}`;
  const row = roleRow(want);
  if (!row) throw new Error(`toggleNoRoles: no "${want}" row`);
  fireEvent.click(row);
}

/** Picked values, in list order. */
export function pickedRoleValues(): string[] {
  return roleRows().filter(isPicked).map(rowValue);
}

/**
 * Toggle the role `slug` via its row. Matches a row whose value is `slug`
 * (single host) or ends with `/${slug}` (several). Pass `hostId` to pick that
 * host's copy when the same role is on several hosts.
 */
export function toggleRole(slug: string, hostId?: string): void {
  const matches = roleRows().filter((r) => {
    const v = rowValue(r);
    if (hostId !== undefined) return v === `${hostId}/${slug}`;
    return v === slug || v.endsWith(`/${slug}`);
  });
  if (matches.length === 0) {
    throw new Error(
      `toggleRole: no role row "${slug}"${hostId ? ` on host ${hostId}` : ""} (have: ${roleOptionValues().join(", ") || "none"})`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `toggleRole: role "${slug}" is on several hosts (${matches.map(rowValue).join(", ")}) — pass a hostId`,
    );
  }
  fireEvent.click(matches[0]);
}

/** Picked role slugs with any `${hostId}/` prefix stripped, in list order. */
export function pickedRoleSlugs(): string[] {
  return pickedRoleValues().map((v) => v.slice(v.indexOf("/") + 1));
}

/** A row's name (its label, without the description). */
export function rowLabel(row: HTMLElement): string {
  return row.querySelector(".k-row-label")?.textContent ?? "";
}

/** A row's one-line description, or null when it has none. */
export function rowDescription(row: HTMLElement): string | null {
  return row.querySelector(".k-row-desc")?.textContent ?? null;
}

/** Names of the picked rows, in list order. */
export function pickedRoleLabels(): string[] {
  return roleRows().filter(isPicked).map(rowLabel);
}

/** Machine headings in the roles list, in list order. */
export function roleGroupHeaders(): string[] {
  const list = queryList();
  if (!list) return [];
  return Array.from(list.querySelectorAll<HTMLElement>(".k-group-title")).map(
    (el) => el.textContent ?? "",
  );
}

/**
 * The list as rows in DOM order: `# <host>` for a heading, the row's value
 * otherwise. Pins grouping + ordering in one assert.
 */
export function roleListRows(): string[] {
  const list = queryList();
  if (!list) return [];
  return Array.from(
    list.querySelectorAll<HTMLElement>(
      '[data-testid^="role-pick-group-"] .k-group-title, [data-testid^="role-pick-group-"] [data-testid^="role-pick-"]',
    ),
  ).map((el) => (el.classList.contains("k-group-title") ? `# ${el.textContent ?? ""}` : rowValue(el)));
}

/** The "New role…" row, or null. */
export function queryNewRoleRow(): HTMLElement | null {
  return screen.queryByTestId("role-pick-new-role");
}

type RoleStub = {
  name: string;
  description: string;
  displayName?: string | null;
  instanceWide?: boolean;
  avatar?: string;
};

/**
 * A listRolesForHost mock implementation answering per host, keyed by the
 * numeric host id the pane passes (parseInt of Host.id — fixtures must use
 * numeric-string ids like "1" for this to tell hosts apart). A value can be
 * a role list (resolves), an Error (rejects), or a Promise (e.g. from
 * deferred(), to hold a host in its loading state). Unlisted hosts answer [].
 */
export function rolesByHost(
  map: Record<number, RoleStub[] | Error | Promise<RoleStub[]>>,
): (hostId: number) => Promise<RoleStub[]> {
  return (hostId: number) => {
    const v = map[hostId];
    if (v === undefined) return Promise.resolve([]);
    if (v instanceof Error) return Promise.reject(v);
    if (v instanceof Promise) return v;
    return Promise.resolve(v);
  };
}

/** A promise plus its resolve/reject, for holding a host's roles request open. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The admin-only Agent / Shell switch, or null. */
export function queryModeSwitch(): HTMLElement | null {
  return screen.queryByTestId("new-session-identity-mode");
}

/** Switch the admin-only Agent / Shell control to Shell. */
export function chooseShell(): void {
  fireEvent.click(screen.getByTestId("new-session-mode-shell"));
}

/** Switch the admin-only Agent / Shell control back to Agent. */
export function chooseAgent(): void {
  fireEvent.click(screen.getByTestId("new-session-mode-agent"));
}

/** Whether the Shell segment is the pressed one. */
export function shellChosen(): boolean {
  return screen.getByTestId("new-session-mode-shell").getAttribute("aria-pressed") === "true";
}


// ─── The pane ────────────────────────────────────────────────────────────────

export function makeHost(id: string, name: string, overrides: Partial<Host> = {}): Host {
  return {
    id,
    name,
    username: "user",
    ip: "10.0.0.1",
    port: 22,
    folder: "",
    online: true,
    cpu: null,
    ram: null,
    lastAccess: "",
    authType: "password",
    enableTerminal: true,
    enableTunnel: false,
    serverTunnels: [],
    enableFileManager: false,
    enableDocker: false,
    quickActions: [],
    enableSsh: true,
    enableRdp: false,
    // Can host agents — agent mode only offers such machines.
    canHostAgents: true,
    enableVnc: false,
    enableTelnet: false,
    sshPort: 22,
    rdpPort: 3389,
    vncPort: 5900,
    telnetPort: 23,
    ...overrides,
  } as Host;
}

export const TAB_ID = "tab-new-1";

export type PaneSpies = {
  setStarting: ReturnType<typeof vi.fn>;
  updatePicks: ReturnType<typeof vi.fn>;
  started: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

/**
 * Render the pane inside its host context. `setHostTree` / `setIsAdmin`
 * re-render the same mounted pane with a new context value (the machine list
 * arriving or changing while it is open).
 */
export function renderPane(
  opts: {
    hostTree?: HostFolder | null;
    isAdmin?: boolean;
    picks?: NewConversationPicks;
    tabId?: string;
    isVisible?: boolean;
    /** Has isAdmin been answered yet (default yes). */
    adminKnown?: boolean;
  } = {},
) {
  const spies: PaneSpies = { setStarting: vi.fn(), updatePicks: vi.fn(), started: vi.fn(), close: vi.fn() };
  const isVisible = opts.isVisible ?? true;
  const tabId = opts.tabId ?? TAB_ID;
  const picks = opts.picks ?? {};
  let hostTree = opts.hostTree ?? null;
  let isAdmin = opts.isAdmin ?? true;
  let adminKnown = opts.adminKnown ?? true;
  const tree = () => {
    const value: NewConversationHost = {
      hostTree,
      isAdmin,
      adminKnown,
      setStarting: spies.setStarting as unknown as NewConversationHost["setStarting"],
      updatePicks: spies.updatePicks as unknown as NewConversationHost["updatePicks"],
      started: spies.started as unknown as NewConversationHost["started"],
      close: spies.close as unknown as NewConversationHost["close"],
    };
    return createElement(
      NewConversationHostContext.Provider,
      { value },
      createElement(NewConversationPane, { tabId, picks, isVisible }),
    );
  };
  const utils = render(tree());
  return {
    ...utils,
    ...spies,
    setHostTree(next: HostFolder | null) {
      hostTree = next;
      utils.rerender(tree());
    },
    setIsAdmin(next: boolean) {
      isAdmin = next;
      adminKnown = true;
      utils.rerender(tree());
    },
  };
}

/** The picks last reported through updatePicks, or null when none were. */
export function lastReportedPicks(updatePicks: ReturnType<typeof vi.fn>): NewConversationPicks | null {
  const calls = updatePicks.mock.calls;
  return calls.length === 0 ? null : (calls[calls.length - 1][1] as NewConversationPicks);
}

/** The compose box's main button — it starts the conversation. */
export function startButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^start(ing)? the conversation$/i }) as HTMLButtonElement;
}

/** The compose box's textarea. */
export function composeText(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>("textarea.pv-compose-text");
  if (!el) throw new Error("composeText: no compose textarea");
  return el;
}

/** Type into the compose box. */
export function typeFirstMessage(text: string): void {
  fireEvent.change(composeText(), { target: { value: text } });
}

/** Press Enter in the compose box (starts, like the main button). */
export function pressEnterInCompose(): void {
  fireEvent.keyDown(composeText(), { key: "Enter" });
}

/** The pill's text: "New conversation" / "New shell". */
export function pillLabel(): string {
  return screen.getByTestId("pv-task-pill-label").textContent ?? "";
}

/** The Name field (agent mode), or null when it isn't there (a shell). */
export function queryNameInput(): HTMLInputElement | null {
  return screen.queryByTestId("new-conversation-name") as HTMLInputElement | null;
}

/** The Name field's current value ("" when there's no field). */
export function nameValue(): string {
  return queryNameInput()?.value ?? "";
}

/** Kept for the ported suites: the name as the field holds it. */
export function pillName(): string {
  return nameValue();
}

/** The Name field (throws when there is none). */
export function openRename(): HTMLInputElement {
  const input = queryNameInput();
  if (!input) throw new Error("openRename: no Name field (shell mode?)");
  return input;
}

/** Type a name: change, then blur (what fires the clash check). */
export function typeName(value: string): void {
  const input = openRename();
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

/** The name error line's text, or null. */
export function nameErrorText(): string | null {
  return screen.queryByTestId("new-conversation-name-error")?.textContent ?? null;
}

/** The pill's ⋯ menu — Radix opens on a primary-button pointerdown. */
export function openPillMenu(): void {
  const trigger = screen.getByTestId("pv-task-pill-kebab-trigger");
  act(() => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  });
}

// ─── Birth streams ──────────────────────────────────────────────────────────

type StreamEvent = {
  type: string;
  n?: number;
  phase?: string;
  reason?: string;
  ok?: boolean;
  failedStep?: number;
  identityId?: string;
  sessionName?: string;
};

/**
 * A mock birth stream that emits the given events then ends, with a tick
 * between events so React can flush intermediate states.
 */
export async function* createMockStream(events: StreamEvent[]) {
  for (const evt of events) {
    await Promise.resolve();
    yield evt;
  }
}

/** A birth stream that never ends until `release()` — the pane stays starting. */
export function hangingStream(): { stream: AsyncGenerator<never>; release: () => void } {
  let release!: () => void;
  const done = new Promise<void>((res) => {
    release = res;
  });
  async function* gen(): AsyncGenerator<never> {
    await done;
  }
  return { stream: gen(), release };
}
