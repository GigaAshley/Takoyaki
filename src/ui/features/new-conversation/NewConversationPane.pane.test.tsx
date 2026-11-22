// ─── NewConversationPane — what the pane does that the dialog didn't ─────────
//
//   - picks reported up through updatePicks (a typed name, never a suggested one)
//   - seeding from picks when the machine list arrives after the pane
//   - a project's picks narrow the machines to the project's
//   - the compose box's words go along as the birth's `firstMessage`
//   - a failed start keeps the pane, its picks and its words; a retry works
//   - started() payloads for an agent and a shell
//   - renaming in the pill
//   - New role…: back keeps the picks, a created role joins / replaces them,
//     ✕ closes the pane
//   - the pill's ⋯ menu: Close, Move to new tab
//
// Same mock scaffolding as the other NewConversationPane suites; RolesWindow
// is stubbed with buttons for its three outcomes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, waitFor, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
    i18n: { language: "en", changeLanguage: () => Promise.resolve() },
  }),
}));

const mockListIdentities = vi.fn().mockResolvedValue([]);
const mockGetIdentityExistsOnHost = vi.fn().mockResolvedValue(false);
const mockOpenBirthStream = vi.fn();
const mockListRolesForHost = vi.fn();
const mockPickPoolName = vi.fn();

vi.mock("@/api/identities-api", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    listIdentities: (...args: unknown[]) => mockListIdentities(...args),
    getIdentityExistsOnHost: (...args: unknown[]) =>
      mockGetIdentityExistsOnHost(...args),
    openBirthStream: (...args: unknown[]) => mockOpenBirthStream(...args),
    listRolesForHost: (...args: unknown[]) => mockListRolesForHost(...args),
    pickPoolName: (...args: unknown[]) => mockPickPoolName(...args),
  };
});

vi.mock("@/api/voice-api", () => ({
  SAMPLE_PHRASE: "Hi.",
  postSpeak: vi.fn().mockResolvedValue(new Blob(["a"], { type: "audio/mpeg" })),
  postSpeakStream: vi.fn(),
}));
vi.mock("@/features/terminal/session-hue", () => ({
  sessionMatchKey: () => null,
  useSessionIdentity: () => ({ identity: null, identityHue: null }),
}));
const mockRefreshOneIdentity = vi.fn().mockResolvedValue(true);
vi.mock("@/state/identities-store", () => ({
  useIdentities: () => ({ byKey: new Map() }),
  refreshOneIdentity: (...args: unknown[]) => mockRefreshOneIdentity(...args),
}));
vi.mock("@/hooks/use-is-touch-device", () => ({
  useIsTouchDevice: () => false,
}));
vi.mock("@/api/compose-drafts-api", () => ({
  getComposeDraft: vi.fn().mockResolvedValue({ body: "" }),
  putComposeDraft: vi.fn().mockResolvedValue(undefined),
  flushComposeDraftKeepalive: vi.fn(),
}));
vi.mock("@/api/skills-api", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
  createSkill: vi.fn(),
  SkillAlreadyExistsError: class SkillAlreadyExistsError extends Error {},
}));

// The roles window: its outcomes are buttons on the stub.
type StubHost = { id: string; name: string };
type StubProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  start: { view: string; host?: StubHost | null };
  newRoleHop?: {
    onBack: () => void;
    onCreated: (r: { role: string; host: StubHost; description: string }) => void;
  } | null;
};
const rolesWindow = vi.hoisted(() => ({ props: null as StubProps | null }));
vi.mock("@/features/pretty-view/roles-window/RolesWindow", () => ({
  RolesWindow: (props: StubProps) => {
    rolesWindow.props = props;
    if (!props.open) return null;
    return (
      <div data-testid="roles-window-stub">
        <button type="button" data-testid="roles-window-back" onClick={() => props.newRoleHop?.onBack()}>
          Back
        </button>
        <button type="button" data-testid="roles-window-x" onClick={() => props.onOpenChange(false)}>
          ✕
        </button>
      </div>
    );
  },
}));

async function* emptyStream() {
  // nothing
}

import { clearHostRolesCache } from "@/sidebar/host-roles-cache";
import {
  pickedRoleValues,
  pickedRoleSlugs,
  roleOptionValues,
  roleGroupHeaders,
  roleListRows,
  toggleRole,
  toggleNoRoles,
  rolesByHost,
  queryNewRoleRow,
  chooseShell,
  typeName,
  openRename,
  queryNameInput,
  pillLabel,
  nameValue,
  nameErrorText,
  openPillMenu,
  renderPane,
  makeHost,
  startButton,
  composeText,
  typeFirstMessage,
  pressEnterInCompose,
  lastReportedPicks,
  createMockStream,
  TAB_ID,
  NO_ROLES_VALUE,
} from "./NewConversationPane.roles-test-helpers";
import type { HostFolder } from "@/types/ui-types";

const hostA = makeHost("1", "alpha");
const hostB = makeHost("2", "bravo");
const twoHostTree: HostFolder = { name: "root", children: [hostA, hostB] };
const oneHostTree: HostFolder = { name: "root", children: [hostA] };

const role = (name: string) => ({ name, description: "" });

beforeEach(() => {
  clearHostRolesCache();
  vi.clearAllMocks();
  rolesWindow.props = null;
  mockListRolesForHost.mockReset();
  mockPickPoolName.mockReset();
  mockOpenBirthStream.mockReset();
  mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("tina"), role("ops")], 2: [role("tina")] }));
  mockPickPoolName.mockRejectedValue(new Error("no suggestion"));
  mockOpenBirthStream.mockReturnValue(emptyStream());
  mockListIdentities.mockResolvedValue([]);
  mockGetIdentityExistsOnHost.mockResolvedValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: picks reported via updatePicks", () => {
  it("each change after the seed is reported with the tab id: machine + roles, then a typed name", async () => {
    const pane = renderPane({ hostTree: twoHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    // Nothing picked yet: the picks are still the (empty) seed — nothing to report.
    expect(pane.updatePicks).not.toHaveBeenCalled();

    toggleRole("tina", "2");
    await waitFor(() => expect(lastReportedPicks(pane.updatePicks)).toEqual({ hostId: 2, roles: ["tina"] }));
    expect(pane.updatePicks.mock.calls.every((c) => c[0] === TAB_ID)).toBe(true);

    typeName("alicia");
    await waitFor(() =>
      expect(lastReportedPicks(pane.updatePicks)).toEqual({ hostId: 2, roles: ["tina"], name: "alicia" }),
    );

    toggleNoRoles("2");
    await waitFor(() =>
      expect(lastReportedPicks(pane.updatePicks)).toEqual({ hostId: 2, noRoles: true, name: "alicia" }),
    );
  });

  it("a suggested name is never reported; renaming it is", async () => {
    mockPickPoolName.mockResolvedValue({ name: "willow" });
    const pane = renderPane({ hostTree: oneHostTree });
    await waitFor(() => expect(nameValue()).toBe("willow"));
    await waitFor(() => expect(lastReportedPicks(pane.updatePicks)).toEqual({ hostId: 1, noRoles: true }));
    expect(pane.updatePicks.mock.calls.some((c) => "name" in c[1])).toBe(false);
    typeName("willow-two");
    await waitFor(() => expect(lastReportedPicks(pane.updatePicks)?.name).toBe("willow-two"));
  });

  // The seed is never reported back half-done: no `{}` on the way in.
  it("after the seed the tab holds the seed; a later change is reported once", async () => {
    const seed = { hostId: 1, roles: ["tina"] };
    const pane = renderPane({ hostTree: twoHostTree, picks: seed });
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/tina"]));
    await new Promise((r) => setTimeout(r, 20));
    expect(lastReportedPicks(pane.updatePicks) ?? seed).toEqual(seed);
    expect(pane.updatePicks.mock.calls.map((c) => c[1])).not.toContainEqual({});
    const before = pane.updatePicks.mock.calls.length;
    toggleRole("ops");
    await waitFor(() => expect(pane.updatePicks).toHaveBeenCalledTimes(before + 1));
    expect(lastReportedPicks(pane.updatePicks)).toEqual({ hostId: 1, roles: ["tina", "ops"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(pane.updatePicks).toHaveBeenCalledTimes(before + 1);
  });

  it("a shell's picks: shell, machine and folder (no agent fields)", async () => {
    const pane = renderPane({ hostTree: twoHostTree, isAdmin: true });
    chooseShell();
    fireEvent.click(screen.getByText("bravo"));
    fireEvent.change(screen.getByLabelText(/^path$/i), { target: { value: "/srv/app" } });
    await waitFor(() =>
      expect(lastReportedPicks(pane.updatePicks)).toEqual({ shell: true, hostId: 2, path: "/srv/app" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: seeding when the machine list arrives after mount", () => {
  it("picks waiting for a machine list seed once it arrives; nothing is reported before", async () => {
    const pane = renderPane({ hostTree: null, picks: { hostId: 2, roles: ["tina"], name: "alicia" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(pane.updatePicks).not.toHaveBeenCalled();
    expect(roleListRows()).toEqual([]);

    pane.setHostTree(twoHostTree);
    await waitFor(() => expect(pickedRoleValues()).toEqual(["2/tina"]));
    expect(nameValue()).toBe("alicia");
    // The picks it ended up with are the seed.
    await new Promise((r) => setTimeout(r, 20));
    const seed = { hostId: 2, roles: ["tina"], name: "alicia" };
    expect(lastReportedPicks(pane.updatePicks) ?? seed).toEqual(seed);
    expect(pane.updatePicks.mock.calls.map((c) => c[1])).not.toContainEqual({});
  });

  it("an empty list first, then the real one: still seeds", async () => {
    const pane = renderPane({ hostTree: { name: "root", children: [] }, picks: { hostId: 2, noRoles: true } });
    pane.setHostTree(twoHostTree);
    await waitFor(() => expect(pickedRoleValues()).toEqual([`2/${NO_ROLES_VALUE}`]));
  });

  it("a seeded machine that never turns up leaves the pane unpicked", async () => {
    renderPane({ hostTree: twoHostTree, picks: { hostId: 9, roles: ["tina"] } });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    expect(pickedRoleValues()).toEqual([]);
    expect(startButton().disabled).toBe(true);
  });

  it("a seeded shell waits for admin status (it arrives after the machines) and keeps its picks", async () => {
    const pane = renderPane({
      hostTree: twoHostTree,
      isAdmin: false,
      adminKnown: false,
      picks: { shell: true, hostId: 2, path: "/srv" },
    });
    await new Promise((r) => setTimeout(r, 20));
    // Nothing reported while it waits — the shell picks stay as they are.
    expect(pane.updatePicks).not.toHaveBeenCalled();
    pane.setIsAdmin(true);
    await waitFor(() => expect(pillLabel()).toBe("New shell"));
    await waitFor(() => expect(startButton().disabled).toBe(false));
    expect((screen.getByLabelText(/^path$/i) as HTMLInputElement).value).toBe("/srv");
    await new Promise((r) => setTimeout(r, 20));
    for (const call of pane.updatePicks.mock.calls) expect(call[1]).toMatchObject({ shell: true, hostId: 2 });
  });

  it("a seeded shell (admin) picks its machine and folder", async () => {
    const pane = renderPane({ hostTree: null, isAdmin: true, picks: { shell: true, hostId: 2, path: "/srv" } });
    pane.setHostTree(twoHostTree);
    await waitFor(() => expect(startButton().disabled).toBe(false));
    expect(pillLabel()).toBe("New shell");
    expect((screen.getByLabelText(/^path$/i) as HTMLInputElement).value).toBe("/srv");
    fireEvent.click(startButton());
    expect(pane.started).toHaveBeenCalledWith(TAB_ID, {
      kind: "shell",
      host: expect.objectContaining({ id: "2" }),
      sessionName: undefined,
      path: "/srv",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: a project's picks", () => {
  it("narrow the machines to the project's: one machine's roles, no headings, \"No roles\" preselected; birth goes there with the project", async () => {
    mockOpenBirthStream.mockReturnValueOnce(
      createMockStream([{ type: "ended", ok: true, sessionName: "alicia" }]),
    );
    const pane = renderPane({
      hostTree: twoHostTree,
      picks: { project: { slug: "ops", hostId: 2 }, hostId: 2 },
    });
    await waitFor(() => expect(roleOptionValues()).toEqual(["tina"]));
    expect(roleGroupHeaders()).toEqual([]);
    expect(mockListRolesForHost.mock.calls.map((c) => c[0])).toEqual([2]);
    await waitFor(() => expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]));
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(startButton());
    await waitFor(() => expect(pane.started).toHaveBeenCalledTimes(1));
    expect(mockOpenBirthStream.mock.calls[0][0]).toMatchObject({ hostId: 2, project: "ops" });
    expect(pane.started.mock.calls[0][1]).toEqual({
      kind: "agent",
      host: expect.objectContaining({ id: "2" }),
      name: "alicia",
      project: "ops",
    });
  });

  it("the project stays in the reported picks", async () => {
    const pane = renderPane({ hostTree: twoHostTree, picks: { project: { slug: "ops", hostId: 2 }, hostId: 2 } });
    await waitFor(() => expect(roleOptionValues()).toEqual(["tina"]));
    toggleRole("tina");
    await waitFor(() =>
      expect(lastReportedPicks(pane.updatePicks)).toEqual({
        hostId: 2,
        roles: ["tina"],
        project: { slug: "ops", hostId: 2 },
      }),
    );
  });

  it("a project whose machine isn't in the list leaves every machine offered", async () => {
    renderPane({ hostTree: twoHostTree, picks: { project: { slug: "ops", hostId: 7 } } });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    expect(roleGroupHeaders()).toEqual(["alpha", "bravo"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: the first message", () => {
  async function ready() {
    const pane = renderPane({ hostTree: oneHostTree });
    await waitFor(() => expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]));
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    return pane;
  }

  it("typed words go in the birth request as firstMessage (main button)", async () => {
    await ready();
    typeFirstMessage("Tidy up the logs please");
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    expect(mockOpenBirthStream.mock.calls[0][0]).toMatchObject({ firstMessage: "Tidy up the logs please" });
  });

  it("…and with Enter, trimmed", async () => {
    await ready();
    typeFirstMessage("  hello there  ");
    pressEnterInCompose();
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    expect((mockOpenBirthStream.mock.calls[0][0] as Record<string, unknown>).firstMessage).toBe("hello there");
  });

  it("nothing typed → no firstMessage key at all", async () => {
    await ready();
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    expect("firstMessage" in (mockOpenBirthStream.mock.calls[0][0] as Record<string, unknown>)).toBe(false);
  });

  it("the compose box's placeholder follows the picks and the name", async () => {
    await ready();
    expect(composeText().placeholder).toBe("What should Alicia do first? (optional)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: a failed start", () => {
  it("keeps the pane, its picks, its name and its words; a retry starts it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockOpenBirthStream
      .mockReturnValueOnce(createMockStream([{ type: "ended", ok: false, reason: "boom" }]))
      .mockReturnValueOnce(createMockStream([{ type: "ended", ok: true, sessionName: "alicia" }]));
    const pane = renderPane({ hostTree: twoHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    toggleRole("tina", "1");
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    typeFirstMessage("Do the thing");
    fireEvent.click(startButton());

    await waitFor(() => expect(screen.getByTestId("new-conversation-failure")).toBeTruthy());
    expect(pane.started).not.toHaveBeenCalled();
    expect(pane.close).not.toHaveBeenCalled();
    expect(pickedRoleValues()).toEqual(["1/tina"]);
    expect(nameValue()).toBe("alicia");
    expect(composeText().value).toBe("Do the thing");
    await waitFor(() => expect(startButton().disabled).toBe(false));

    fireEvent.click(startButton());
    await waitFor(() => expect(pane.started).toHaveBeenCalledTimes(1));
    expect(mockOpenBirthStream).toHaveBeenCalledTimes(2);
    expect(mockOpenBirthStream.mock.calls[1][0]).toMatchObject({
      hostId: 1,
      role: "tina",
      displayName: "alicia",
      firstMessage: "Do the thing",
    });
    expect(pane.started.mock.calls[0][1]).toMatchObject({ kind: "agent", name: "alicia" });
  });

  it("the failure line goes once the picks change", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([{ type: "ended", ok: false }]));
    renderPane({ hostTree: twoHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    toggleRole("tina", "1");
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(startButton());
    await waitFor(() => expect(screen.getByTestId("new-conversation-failure")).toBeTruthy());
    toggleRole("ops");
    await waitFor(() => expect(screen.queryByTestId("new-conversation-failure")).toBeNull());
  });

  it("a collision check doesn't report on the folder a birth made (no name error mid-start)", async () => {
    // getIdentityExistsOnHost would say "exists" once the birth made it.
    mockGetIdentityExistsOnHost.mockResolvedValue(false);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    async function* slowOk() {
      await gate;
      yield { type: "ended", ok: true, sessionName: "alicia" };
    }
    mockOpenBirthStream.mockReturnValueOnce(slowOk());
    const pane = renderPane({ hostTree: oneHostTree });
    await waitFor(() => expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]));
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    mockGetIdentityExistsOnHost.mockResolvedValue(true);
    fireEvent.click(startButton());
    await new Promise((r) => setTimeout(r, 400));
    expect(nameErrorText()).toBeNull();
    release();
    await waitFor(() => expect(pane.started).toHaveBeenCalledTimes(1));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: started()", () => {
  it("agent: started(tabId, {kind:'agent', host, name, project: null}) after the newborn is fetched", async () => {
    mockOpenBirthStream.mockReturnValueOnce(
      createMockStream([{ type: "ended", ok: true, identityId: "alicia-x", sessionName: "alicia-x" }]),
    );
    const pane = renderPane({ hostTree: twoHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    toggleRole("tina", "2");
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(startButton());
    await waitFor(() => expect(pane.started).toHaveBeenCalledTimes(1));
    expect(pane.started).toHaveBeenCalledWith(TAB_ID, {
      kind: "agent",
      host: expect.objectContaining({ id: "2", name: "bravo" }),
      name: "alicia-x",
      project: null,
    });
    expect(mockRefreshOneIdentity).toHaveBeenCalledWith("alicia-x", 2);
  });

  it("agent with no session name in the ended event falls back to the identity id", async () => {
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([{ type: "ended", ok: true, identityId: "alicia-y" }]));
    const pane = renderPane({ hostTree: oneHostTree });
    await waitFor(() => expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]));
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(startButton());
    await waitFor(() => expect(pane.started).toHaveBeenCalledTimes(1));
    expect(pane.started.mock.calls[0][1].name).toBe("alicia-y");
  });

  it("shell: started(tabId, {kind:'shell', host, sessionName, path}); no birth", () => {
    const pane = renderPane({ hostTree: twoHostTree, isAdmin: true });
    chooseShell();
    fireEvent.click(screen.getByText("alpha"));
    fireEvent.change(screen.getByLabelText(/^name \(optional\)$/i), { target: { value: "work" } });
    fireEvent.change(screen.getByLabelText(/^path$/i), { target: { value: "C:\\Users\\me" } });
    fireEvent.click(startButton());
    expect(pane.started).toHaveBeenCalledWith(TAB_ID, {
      kind: "shell",
      host: expect.objectContaining({ id: "1" }),
      sessionName: "work",
      path: "C:/Users/me",
    });
    expect(mockOpenBirthStream).not.toHaveBeenCalled();
  });

  it("shell: Enter in the path field starts it too", () => {
    const pane = renderPane({ hostTree: oneHostTree, isAdmin: true });
    chooseShell();
    fireEvent.keyDown(screen.getByLabelText(/^path$/i), { key: "Enter" });
    expect(pane.started).toHaveBeenCalledTimes(1);
    expect(pane.started.mock.calls[0][1]).toMatchObject({ kind: "shell", path: "~" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: the Name field", () => {
  it("holds the suggestion; typing replaces it", async () => {
    mockPickPoolName.mockResolvedValue({ name: "willow" });
    renderPane({ hostTree: oneHostTree });
    await waitFor(() => expect(nameValue()).toBe("willow"));
    expect(screen.getByText("Suggested — change it if you like.")).toBeTruthy();
    typeName("juniper");
    expect(nameValue()).toBe("juniper");
    expect(screen.queryByText("Suggested — change it if you like.")).toBeNull();
  });

  it("the pill always names the kind of thing, and clicking it goes to the Name field", async () => {
    mockPickPoolName.mockResolvedValue({ name: "willow" });
    renderPane({ hostTree: oneHostTree });
    await waitFor(() => expect(nameValue()).toBe("willow"));
    expect(pillLabel()).toBe("New conversation");
    fireEvent.click(screen.getByTestId("pv-task-pill-open"));
    expect(document.activeElement).toBe(queryNameInput());
  });

  it("is there before a machine is picked, asking for a role first", async () => {
    renderPane({ hostTree: twoHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    expect(queryNameInput()!.placeholder).toBe("Pick a role first");
    toggleRole("tina", "1");
    await waitFor(() => expect(queryNameInput()!.placeholder).toBe("e.g. alicia"));
  });

  it("isn't there for a shell", async () => {
    renderPane({ hostTree: twoHostTree, isAdmin: true });
    chooseShell();
    await waitFor(() => expect(queryNameInput()).toBeNull());
    expect(pillLabel()).toBe("New shell");
  });

  it("an over-long name shows its error and blocks Start", async () => {
    renderPane({ hostTree: oneHostTree });
    await waitFor(() => expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]));
    // maxLength caps typing, but a change event can still carry more.
    typeName("a".repeat(81));
    expect(nameErrorText()).toBe("Name must be 80 characters or fewer");
    expect(startButton().disabled).toBe(true);
  });

  it("the first picked role's picture is the pill's picture", async () => {
    renderPane({ hostTree: twoHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    expect(screen.getByTestId("new-conversation-pill-empty")).toBeTruthy();
    toggleRole("tina", "1");
    await waitFor(() => expect(screen.queryByTestId("new-conversation-pill-empty")).toBeNull());
    const img = screen.getByTestId("pv-task-pill").querySelector("img");
    expect(img!.getAttribute("src")).toMatch(/tina/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: New role…", () => {
  it("back keeps the picks", async () => {
    const pane = renderPane({ hostTree: twoHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    toggleRole("tina", "1");
    toggleRole("ops");
    typeName("alicia");
    fireEvent.click(queryNewRoleRow()!);
    expect(screen.getByTestId("roles-window-stub")).toBeTruthy();
    expect(rolesWindow.props!.start).toEqual({ view: "new", host: expect.objectContaining({ id: "1" }) });
    fireEvent.click(screen.getByTestId("roles-window-back"));
    expect(screen.queryByTestId("roles-window-stub")).toBeNull();
    expect(pickedRoleSlugs()).toEqual(["tina", "ops"]);
    expect(nameValue()).toBe("alicia");
    expect(pane.close).not.toHaveBeenCalled();
  });

  it("a role created on the same machine is added to the picks (last), once its machine's fresh list lands", async () => {
    renderPane({ hostTree: twoHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    toggleRole("tina", "1");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/tina"]));
    fireEvent.click(queryNewRoleRow()!);
    // The machine now has the new role.
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("tina"), role("ops"), role("scribe")], 2: [role("tina")] }));
    act(() => rolesWindow.props!.newRoleHop!.onCreated({ role: "scribe", host: hostA, description: "" }));
    expect(screen.queryByTestId("roles-window-stub")).toBeNull();
    await waitFor(() => expect(roleOptionValues()).toContain("1/scribe"));
    expect(pickedRoleSlugs()).toEqual(["tina", "scribe"]);
    expect(mockListRolesForHost.mock.calls.filter((c) => c[0] === 1)).toHaveLength(2);
  });

  it("a role created on another machine replaces the picks (and the machine)", async () => {
    const pane = renderPane({ hostTree: twoHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    toggleRole("tina", "1");
    toggleRole("ops");
    fireEvent.click(queryNewRoleRow()!);
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("tina"), role("ops")], 2: [role("tina"), role("scribe")] }));
    act(() => rolesWindow.props!.newRoleHop!.onCreated({ role: "scribe", host: hostB, description: "" }));
    await waitFor(() => expect(pickedRoleValues()).toEqual(["2/scribe"]));
    await waitFor(() => expect(lastReportedPicks(pane.updatePicks)).toEqual({ hostId: 2, roles: ["scribe"] }));
  });

  it("a role created with nothing picked picks it on its machine (over the one-machine \"No roles\" default)", async () => {
    renderPane({ hostTree: oneHostTree });
    await waitFor(() => expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]));
    fireEvent.click(queryNewRoleRow()!);
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("tina"), role("ops"), role("scribe")] }));
    act(() => rolesWindow.props!.newRoleHop!.onCreated({ role: "scribe", host: hostA, description: "" }));
    await waitFor(() => expect(pickedRoleValues()).toEqual(["scribe"]));
  });

  it("closing the roles window with ✕ closes the pane", async () => {
    const pane = renderPane({ hostTree: twoHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    fireEvent.click(queryNewRoleRow()!);
    fireEvent.click(screen.getByTestId("roles-window-x"));
    expect(pane.close).toHaveBeenCalledWith(TAB_ID);
    expect(screen.queryByTestId("roles-window-stub")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: the pill's ⋯ menu", () => {
  it("Close calls close(tabId)", async () => {
    const pane = renderPane({ hostTree: twoHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    openPillMenu();
    fireEvent.click(await screen.findByTestId("new-conversation-menu-close"));
    expect(pane.close).toHaveBeenCalledWith(TAB_ID);
  });

  it("Move to new tab opens the picks in a new tab and closes this pane — unless the popup is blocked", async () => {
    const open = vi.spyOn(window, "open").mockReturnValueOnce(null);
    const pane = renderPane({ hostTree: twoHostTree, picks: { hostId: 1, roles: ["tina"] } });
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/tina"]));
    openPillMenu();
    fireEvent.click(await screen.findByTestId("new-conversation-menu-move-new-window"));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][1]).toBe("_blank");
    expect(String(open.mock.calls[0][0]).startsWith("#")).toBe(true);
    // Blocked → the pane stays.
    expect(pane.close).not.toHaveBeenCalled();

    open.mockReturnValueOnce({} as Window);
    openPillMenu();
    fireEvent.click(await screen.findByTestId("new-conversation-menu-move-new-window"));
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1][0]).toBe(open.mock.calls[0][0]);
    expect(pane.close).toHaveBeenCalledWith(TAB_ID);
    open.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: kept while it's being created", () => {
  it("tells the content area it's starting, then that it's done", async () => {
    mockOpenBirthStream.mockReturnValueOnce(
      createMockStream([{ type: "ended", ok: true, identityId: "alicia-x", sessionName: "alicia-x" }]),
    );
    const pane = renderPane({ hostTree: twoHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    toggleRole("tina", "2");
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(startButton());
    await waitFor(() => expect(pane.setStarting).toHaveBeenCalledWith(TAB_ID, true));
    await waitFor(() => expect(pane.started).toHaveBeenCalledTimes(1));
  });

  it("a failure while it's out of sight says so where the user is", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kit = await import("@/components/kit");
    const alertSpy = vi.spyOn(kit, "kitAlert").mockResolvedValue(undefined as never);
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([{ type: "ended", ok: false, reason: "boom" }]));
    const pane = renderPane({ hostTree: twoHostTree, isVisible: false });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    toggleRole("tina", "1");
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(startButton());
    await waitFor(() => expect(screen.getByTestId("new-conversation-failure")).toBeTruthy());
    expect(alertSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't create the agent" }));
    // No longer starting — nothing keeps the out-of-sight pane now.
    expect(pane.setStarting).toHaveBeenLastCalledWith(TAB_ID, false);
  });

  it("a failure on screen shows only the line in the pane", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kit = await import("@/components/kit");
    const alertSpy = vi.spyOn(kit, "kitAlert").mockResolvedValue(undefined as never);
    alertSpy.mockClear();
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([{ type: "ended", ok: false, reason: "boom" }]));
    renderPane({ hostTree: twoHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    toggleRole("tina", "1");
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(startButton());
    await waitFor(() => expect(screen.getByTestId("new-conversation-failure")).toBeTruthy());
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
