// ─── NewConversationPane roles coverage (ported from NewSessionDialog.role-dropdown.test.tsx)
//
// Covers the Roles part of the new-conversation pane in agent mode:
//   - Every machine that can host agents is asked for its roles at mount
//   - Start is blocked until "No roles" or a role is picked
//   - Zero roles is a normal choice ("No roles")
//   - The roles are absent in the admin-only Shell mode
//   - The birth request carries the picked roles, in pick order
//   - "New role…" opens the roles window on the picked role's machine
//
// One host → bare-slug values and no headings; several → one group per host
// (alphabetical, case-insensitive), values `${hostId}/${slug}`. The picked
// role decides the host; a role from a different host replaces the earlier
// picks.
//
// Pane vs dialog: the name is set in the pill, which only renames once a
// machine is picked — so tests name the agent after picking a role; the
// "Pick a role first" hint moved from the name field to the compose box's
// placeholder; the roles search box is always there when there are roles
// (RolePickList's pane variant; the dialog showed it past eight).
//
// Dropped from the dialog suite: "New role… absent without onNewRole" (the
// pane always offers it) and Test 26 (role state resets on modal close — a
// pane resets by unmounting).
//
// Fixture host ids are numeric strings ("1", "2"): the pane passes
// parseInt(host.id) to listRolesForHost, and rolesByHost() keys on that.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, waitFor, screen, act } from "@testing-library/react";

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
// Suggested names are covered by task-input.test.tsx; reject silently here.
const mockPickPoolName = vi.fn().mockRejectedValue(
  new Error("pickPoolName not exercised in role-dropdown.test.tsx"),
);

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
vi.mock("@/state/identities-store", () => ({
  useIdentities: () => ({ byKey: new Map() }),
  refreshOneIdentity: vi.fn().mockResolvedValue(true),
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

// The roles window is stubbed; its props are what "New role…" handed over.
type StubProps = {
  open: boolean;
  start: { view: string; host?: { id: string } | null };
  newRoleHop?: { onBack: () => void } | null;
};
const rolesWindow = vi.hoisted(() => ({ props: null as StubProps | null }));
vi.mock("@/features/pretty-view/roles-window/RolesWindow", () => ({
  RolesWindow: (props: StubProps) => {
    rolesWindow.props = props;
    return props.open ? <div data-testid="roles-window-stub" /> : null;
  },
}));

// Empty stream helper — used by tests that start the conversation only to
// capture the birth request.
async function* emptyStream() {
  // nothing — resolves immediately
}

import { clearHostRolesCache } from "@/sidebar/host-roles-cache";
import {
  queryRolesGroup,
  roleOptionValues,
  pickedRoleValues,
  pickedRoleSlugs,
  pickedRoleLabels,
  roleGroupHeaders,
  roleListRows,
  roleRow,
  rowLabel,
  rowDescription,
  rolesLoading,
  toggleRole,
  rolesByHost,
  deferred,
  toggleNoRoles,
  queryNewRoleRow,
  chooseShell,
  chooseAgent,
  typeName,
  renderPane,
  makeHost,
  startButton,
  composeText,
  pillLabel,
  nameValue,
  lastReportedPicks,
  NO_ROLES_VALUE,
} from "./NewConversationPane.roles-test-helpers";
import type { HostFolder, NewConversationPicks } from "@/types/ui-types";

const twoHostTree: HostFolder = {
  name: "root",
  children: [
    makeHost("1", "alpha", { username: "root", ip: "10.0.0.1" }),
    makeHost("2", "bravo", { username: "root", ip: "10.0.0.2" }),
  ],
};

const oneHostTree: HostFolder = {
  name: "root",
  children: [makeHost("1", "alpha", { username: "root", ip: "10.0.0.1" })],
};

// Tree order deliberately NOT alphabetical (and mixed case) so grouping
// order is observable; the RDP host is not pickable and must not be asked.
const mixedTree: HostFolder = {
  name: "root",
  children: [
    makeHost("1", "zulu"),
    { name: "f", children: [makeHost("2", "Alpha"), makeHost("3", "mike")] } as HostFolder,
    makeHost("4", "rdp-box", { enableRdp: true }),
  ],
};

const role = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: "",
  ...extra,
});

// Defaults to isAdmin=true (the admin surface is a superset); agent mode is
// the default either way, so the roles list shows on mount.
function renderDefault(overrides: { hostTree?: HostFolder; isAdmin?: boolean; picks?: NewConversationPicks } = {}) {
  return renderPane({ hostTree: twoHostTree, isAdmin: true, ...overrides });
}

/** Name the agent (in the pill — a machine must be picked). */
function typeCustomName(name = "alicia") {
  typeName(name);
}

const createBtn = startButton;

beforeEach(() => {
  vi.clearAllMocks();
  clearHostRolesCache();
  rolesWindow.props = null;
  // Default: no roles returned (individual tests override)
  mockListRolesForHost.mockResolvedValue([]);
  mockListIdentities.mockResolvedValue([]);
  mockGetIdentityExistsOnHost.mockResolvedValue(false);
  mockPickPoolName.mockRejectedValue(
    new Error("pickPoolName not exercised in role-dropdown.test.tsx"),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("NewConversationPane roles: Test 20 — mount fetches roles from every host", () => {
  it("Test 20: agent mode → listRolesForHost called once per non-RDP host; no host list; picking does not refetch", async () => {
    mockListRolesForHost.mockImplementation(
      rolesByHost({ 1: [role("zed")], 2: [role("ay"), role("bee")], 3: [role("em")] }),
    );
    renderDefault({ hostTree: mixedTree });
    await waitFor(() => expect(mockListRolesForHost).toHaveBeenCalledTimes(3));
    expect(mockListRolesForHost.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2, 3]);
    expect(screen.queryByLabelText(/search hosts/i)).toBeNull();
    expect(screen.queryByText(/pick a host/i)).toBeNull();

    await waitFor(() => expect(roleOptionValues()).toHaveLength(4));
    toggleRole("ay");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["2/ay"]));
    toggleRole("zed");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/zed"]));
    await new Promise((r) => setTimeout(r, 20));
    expect(mockListRolesForHost).toHaveBeenCalledTimes(3);
  });
});

describe("NewConversationPane roles: Test 21 — roles render as rows in the pane", () => {
  it("Test 21: single host with two roles → bare-slug rows, no machine heading, host auto-selected", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("box-maintainer"), role("tina")] }));
    mockOpenBirthStream.mockReturnValueOnce(emptyStream());
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(roleOptionValues()).toEqual(["box-maintainer", "tina"]));
    expect(roleListRows()).toEqual([NO_ROLES_VALUE, "box-maintainer", "tina"]);
    expect(roleGroupHeaders()).toEqual([]);
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.queryByRole("combobox", { name: /roles/i })).toBeNull();
    toggleRole("tina");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["tina"]));
    expect(pickedRoleLabels()).toEqual(["Tina"]);
    typeCustomName();
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    fireEvent.click(createBtn());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.hostId).toBe(1);
    expect(payload.role).toBe("tina");
  });

  it("Test 21b: several hosts → groups alphabetical by host name (case-insensitive), a heading each, composite values; a zero-role host's group holds just \"No roles\"", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("zed")], 2: [role("ay"), role("bee")], 3: [] }));
    renderDefault({ hostTree: mixedTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    expect(roleListRows()).toEqual([
      "# Alpha", `2/${NO_ROLES_VALUE}`, "2/ay", "2/bee",
      "# mike", `3/${NO_ROLES_VALUE}`,
      "# zulu", `1/${NO_ROLES_VALUE}`, "1/zed",
    ]);
    expect(roleGroupHeaders()).toEqual(["Alpha", "mike", "zulu"]);
  });

  it("Test 21c: three hosts with roles → headings Alpha, mike, zulu in that order", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("zed")], 2: [role("ay")], 3: [role("em")] }));
    renderDefault({ hostTree: mixedTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    expect(roleListRows()).toEqual([
      "# Alpha", `2/${NO_ROLES_VALUE}`, "2/ay",
      "# mike", `3/${NO_ROLES_VALUE}`, "3/em",
      "# zulu", `1/${NO_ROLES_VALUE}`, "1/zed",
    ]);
  });

  it("Test 21d: a row shows the role's display name, \"· shared\" for an instance-wide role, and its one-line description; the picked row sits under its machine", async () => {
    mockListRolesForHost.mockImplementation(
      rolesByHost({
        1: [
          role("tina", { description: "Keeps the books tidy." }),
          role("ops", { displayName: "Ops Crew", instanceWide: true }),
        ],
        2: [role("tina")],
      }),
    );
    renderDefault();
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    expect(rowLabel(roleRow("1/tina")!)).toBe("Tina");
    expect(rowDescription(roleRow("1/tina")!)).toBe("Keeps the books tidy.");
    expect(rowDescription(roleRow("2/tina")!)).toBeNull();
    expect(rowLabel(roleRow("1/ops")!)).toBe("Ops Crew · shared");
    expect(rowLabel(roleRow(`1/${NO_ROLES_VALUE}`)!)).toBe("No roles");
    expect(rowDescription(roleRow(`1/${NO_ROLES_VALUE}`)!)).toMatch(/a plain agent/i);

    toggleRole("tina", "2");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["2/tina"]));
    expect(screen.getByTestId("role-pick-group-2").contains(roleRow("2/tina"))).toBe(true);
    toggleRole("ops");
    await waitFor(() => expect(pickedRoleLabels()).toEqual(["Ops Crew · shared"]));
  });

  it("Test 21e: a role with a picture shows it; one without shows its initial", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("tina", { avatar: "avatar.png" }), role("ops")] }));
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(roleOptionValues()).toEqual(["tina", "ops"]));
    const img = roleRow("tina")!.querySelector("img");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toMatch(/tina/);
    expect(roleRow("ops")!.querySelector("img")).toBeNull();
    expect(roleRow("ops")!.textContent).toContain("O");
  });
});

describe("NewConversationPane roles: search", () => {
  const names = ["ant", "bee", "cat", "dog", "eel", "fox", "gnu", "hen", "ibis"];

  // The dialog showed the search box past eight roles; in the pane it is
  // always there once there is a role to search.
  it("no roles → no search box; any roles → a search box", async () => {
    const pane = renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(roleListRows()).toEqual([NO_ROLES_VALUE]));
    expect(screen.queryByLabelText(/search roles/i)).toBeNull();
    pane.unmount();
    clearHostRolesCache();
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: names.slice(0, 2).map((n) => role(n)) }));
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(2));
    expect(screen.getByLabelText(/search roles/i)).toBeTruthy();
  });

  it("the search box narrows the list (No roles hidden while searching); a pick survives the filter", async () => {
    mockListRolesForHost.mockImplementation(
      rolesByHost({ 1: names.slice(0, 5).map((n) => role(n)), 2: names.slice(5).map((n) => role(n, { description: "a bird" })) }),
    );
    mockOpenBirthStream.mockReturnValueOnce(emptyStream());
    renderDefault();
    await waitFor(() => expect(roleOptionValues()).toHaveLength(9));
    const search = screen.getByLabelText(/search roles/i);
    toggleRole("cat");
    fireEvent.change(search, { target: { value: "bird" } });
    expect(roleOptionValues()).toEqual(["2/fox", "2/gnu", "2/hen", "2/ibis"]);
    expect(roleListRows()).not.toContain(`2/${NO_ROLES_VALUE}`);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(roleOptionValues()).toEqual([]);
    expect(screen.getByTestId("role-pick-no-matches")).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    expect(pickedRoleValues()).toEqual(["1/cat"]);
    typeCustomName();
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    fireEvent.click(createBtn());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    expect(mockOpenBirthStream.mock.calls[0][0]).toMatchObject({ hostId: 1, role: "cat" });
  });
});

describe("NewConversationPane roles: Test 22 — role from another host switches host", () => {
  it("Test 22: pick two of alpha's roles → pick one of bravo's → picks are just bravo's; birth goes to bravo", async () => {
    mockListRolesForHost.mockImplementation(
      rolesByHost({
        1: [role("box-maintainer"), role("tina")],
        2: [role("other-role"), role("another-role")],
      }),
    );
    mockOpenBirthStream.mockReturnValueOnce(emptyStream());
    renderDefault();
    await waitFor(() => expect(roleOptionValues()).toHaveLength(4));
    toggleRole("tina");
    toggleRole("box-maintainer");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/box-maintainer", "1/tina"]));
    toggleRole("other-role");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["2/other-role"]));
    toggleRole("another-role");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["2/other-role", "2/another-role"]));
    toggleRole("another-role");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["2/other-role"]));
    expect(mockListRolesForHost).toHaveBeenCalledTimes(2);

    typeCustomName();
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    fireEvent.click(createBtn());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.hostId).toBe(2);
    expect(payload.role).toBe("other-role");
    expect("roles" in payload).toBe(false);
  });

  it("Test 22b: exactly one role across all hosts → nothing auto-selects", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [], 2: [role("only-role")] }));
    renderDefault();
    await waitFor(() => expect(roleOptionValues()).toEqual(["2/only-role"]));
    await new Promise((r) => setTimeout(r, 20));
    expect(pickedRoleValues()).toEqual([]);
  });

  it("Test 22c: one role on each of two hosts → nothing auto-selects", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("tina")], 2: [role("tina")] }));
    renderDefault();
    await waitFor(() => expect(roleOptionValues()).toEqual(["1/tina", "2/tina"]));
    await new Promise((r) => setTimeout(r, 20));
    expect(pickedRoleValues()).toEqual([]);
  });
});

describe("NewConversationPane roles: Test 23 — Start blocked without a roles pick", () => {
  it("Test 23: multi-host, no role picked → Start disabled and the compose box says to pick one; pick a role + name → enabled", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("box-maintainer")], 2: [role("general-assistant")] }));
    renderDefault();
    await waitFor(() => expect(roleOptionValues()).toHaveLength(2));
    expect(composeText().placeholder).toBe("Pick a role above first…");
    expect(createBtn().disabled).toBe(true);
    toggleRole("box-maintainer");
    await waitFor(() => expect(composeText().placeholder).toBe("What should it do first? (optional)"));
    // Picked, but still no name: Start waits for one.
    expect(createBtn().disabled).toBe(true);
    typeCustomName();
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    expect(composeText().placeholder).toBe("What should Alicia do first? (optional)");
  });

  it("Test 23b: one host with a single role → \"No roles\" preselected, Start enabled without touching the roles", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("box-maintainer")] }));
    mockPickPoolName.mockResolvedValue({ name: "willow" });
    mockOpenBirthStream.mockReturnValueOnce(emptyStream());
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(roleOptionValues()).toEqual(["box-maintainer"]));
    expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]);
    expect(pickedRoleLabels()).toEqual(["No roles"]);
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    fireEvent.click(createBtn());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.hostId).toBe(1);
    expect(payload.name).toBe("willow");
    expect("role" in payload).toBe(false);
    expect("roles" in payload).toBe(false);
  });
});

describe("NewConversationPane roles: Test 24 — birth request carries the role", () => {
  it("Test 24: Start → openBirthStream request includes role: <picked>", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("box-maintainer")] }));
    mockOpenBirthStream.mockReturnValueOnce(emptyStream());
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(roleOptionValues()).toEqual(["box-maintainer"]));
    typeCustomName();
    toggleRole("box-maintainer");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["box-maintainer"]));
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    fireEvent.click(createBtn());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.role).toBe("box-maintainer");
    expect("roles" in payload).toBe(false);
  });
});

describe("NewConversationPane roles: several picks", () => {
  const threeRoles = [role("box-maintainer"), role("sky-uat"), role("tina")];

  // alpha holds the three roles; bravo holds one more so the tree stays
  // multi-host (composite values, groups).
  async function openTwoHosts() {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: threeRoles, 2: [role("bravo-only")] }));
    const utils = renderDefault();
    await waitFor(() => expect(roleOptionValues()).toHaveLength(4));
    return utils;
  }

  it("checking two roles sends the first pick as role and the second in roles[]", async () => {
    mockOpenBirthStream.mockReturnValueOnce(emptyStream());
    await openTwoHosts();
    toggleRole("tina");
    toggleRole("box-maintainer");
    await waitFor(() => expect(pickedRoleSlugs()).toEqual(["box-maintainer", "tina"]));
    typeCustomName();
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    fireEvent.click(createBtn());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.hostId).toBe(1);
    expect(payload.role).toBe("tina");
    expect(payload.roles).toEqual(["box-maintainer"]);
  });

  it("three picks keep their pick order on the wire, even after un-picking and re-picking one", async () => {
    mockOpenBirthStream.mockReturnValueOnce(emptyStream());
    await openTwoHosts();
    toggleRole("sky-uat");
    toggleRole("tina");
    toggleRole("box-maintainer");
    toggleRole("sky-uat"); // un-pick the first …
    toggleRole("sky-uat"); // … and pick it again: it is now last
    await waitFor(() => expect(pickedRoleSlugs()).toHaveLength(3));
    typeCustomName();
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    fireEvent.click(createBtn());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.role).toBe("tina");
    expect(payload.roles).toEqual(["box-maintainer", "sky-uat"]);
  });

  it("unchecking the last role falls back to \"No roles\" on that role's host", async () => {
    mockOpenBirthStream.mockReturnValueOnce(emptyStream());
    await openTwoHosts();
    expect(createBtn().disabled).toBe(true);
    toggleRole("tina");
    toggleRole("sky-uat");
    toggleRole("sky-uat");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/tina"]));
    typeCustomName();
    toggleRole("tina");
    await waitFor(() => expect(pickedRoleValues()).toEqual([`1/${NO_ROLES_VALUE}`]));
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    fireEvent.click(createBtn());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.hostId).toBe(1);
    expect("role" in payload).toBe(false);
    expect("roles" in payload).toBe(false);
  });

  it("unticking \"No roles\" with several hosts leaves nothing picked and Start disabled", async () => {
    await openTwoHosts();
    toggleNoRoles("2");
    await waitFor(() => expect(pickedRoleValues()).toEqual([`2/${NO_ROLES_VALUE}`]));
    typeCustomName();
    toggleNoRoles("2");
    await waitFor(() => expect(pickedRoleValues()).toEqual([]));
    expect(createBtn().disabled).toBe(true);
  });

  it("a single pick sends role only, with no roles key", async () => {
    mockOpenBirthStream.mockReturnValueOnce(emptyStream());
    await openTwoHosts();
    toggleRole("sky-uat");
    typeCustomName();
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    fireEvent.click(createBtn());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.role).toBe("sky-uat");
    expect("roles" in payload).toBe(false);
  });
});

describe("NewConversationPane roles: \"No roles\" entry", () => {
  async function openTwoHosts() {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("box-maintainer"), role("tina")], 2: [role("ops")] }));
    renderDefault();
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
  }

  it("several hosts: nothing preselected, Start disabled; \"No roles\" in bravo's group picks bravo and births there with no role", async () => {
    mockOpenBirthStream.mockReturnValueOnce(emptyStream());
    await openTwoHosts();
    expect(pickedRoleValues()).toEqual([]);
    expect(createBtn().disabled).toBe(true);
    toggleNoRoles("2");
    await waitFor(() => expect(pickedRoleValues()).toEqual([`2/${NO_ROLES_VALUE}`]));
    expect(pickedRoleLabels()).toEqual(["No roles"]);
    typeCustomName();
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    fireEvent.click(createBtn());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.hostId).toBe(2);
    expect("role" in payload).toBe(false);
    expect("roles" in payload).toBe(false);
  });

  it("\"No roles\" and roles are mutually exclusive", async () => {
    await openTwoHosts();
    toggleRole("tina");
    toggleRole("box-maintainer");
    await waitFor(() => expect(pickedRoleSlugs()).toEqual(["box-maintainer", "tina"]));
    toggleNoRoles("1");
    await waitFor(() => expect(pickedRoleValues()).toEqual([`1/${NO_ROLES_VALUE}`]));
    toggleRole("tina");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/tina"]));
    toggleNoRoles("2");
    await waitFor(() => expect(pickedRoleValues()).toEqual([`2/${NO_ROLES_VALUE}`]));
    toggleRole("box-maintainer");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/box-maintainer"]));
  });

  it("single host: picking a role clears \"No roles\"; picking \"No roles\" clears the role", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("tina")] }));
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(roleOptionValues()).toEqual(["tina"]));
    expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]);
    toggleRole("tina");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["tina"]));
    toggleNoRoles();
    await waitFor(() => expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]));
  });
});

describe("NewConversationPane roles: only machines that can host agents", () => {
  const notFleet = makeHost("2", "winbox", { canHostAgents: false, enableSsh: false });
  const noFlag = makeHost("3", "legacy", { canHostAgents: undefined });

  it("ineligible hosts get no group, no \"No roles\" entry and no roles request", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("tina")], 2: [role("ops")], 4: [role("em")] }));
    renderDefault({ hostTree: { name: "root", children: [makeHost("1", "alpha"), notFleet, noFlag, makeHost("4", "delta")] } });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(2));
    expect(roleListRows()).toEqual([
      "# alpha", `1/${NO_ROLES_VALUE}`, "1/tina",
      "# delta", `4/${NO_ROLES_VALUE}`, "4/em",
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockListRolesForHost.mock.calls.map((c) => c[0]).sort()).toEqual([1, 4]);
  });

  it("one eligible + one ineligible behaves as one machine: no heading, \"No roles\" preselected, Start goes to the eligible host", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("tina")], 2: [role("ops")] }));
    mockOpenBirthStream.mockReturnValueOnce(emptyStream());
    renderDefault({ hostTree: { name: "root", children: [makeHost("1", "alpha"), notFleet] } });
    await waitFor(() => expect(roleOptionValues()).toEqual(["tina"]));
    expect(roleListRows()).toEqual([NO_ROLES_VALUE, "tina"]);
    expect(roleGroupHeaders()).toEqual([]);
    expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]);
    expect(mockListRolesForHost.mock.calls.map((c) => c[0])).toEqual([1]);
    typeCustomName();
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    fireEvent.click(createBtn());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.hostId).toBe(1);
  });

  it("no eligible host → no \"No roles\" entry and nothing asked", async () => {
    renderDefault({ hostTree: { name: "root", children: [notFleet] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(roleListRows()).toEqual([]);
    expect(pickedRoleValues()).toEqual([]);
    expect(mockListRolesForHost).not.toHaveBeenCalled();
  });

  it("picks naming an ineligible host are no pre-fill in agent mode", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("tina")], 4: [role("em")] }));
    renderDefault({
      hostTree: { name: "root", children: [makeHost("1", "alpha"), notFleet, makeHost("4", "delta")] },
      picks: { hostId: 2, roles: ["ops"] },
    });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(2));
    expect(pickedRoleValues()).toEqual([]);
    expect(createBtn().disabled).toBe(true);
  });

  it("Shell still lists every non-RDP host", async () => {
    renderDefault({ hostTree: { name: "root", children: [makeHost("1", "alpha"), notFleet, makeHost("4", "delta")] } });
    chooseShell();
    await waitFor(() => expect(screen.getByText("winbox")).toBeTruthy());
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("delta")).toBeTruthy();
  });
});

describe("NewConversationPane roles: one-machine \"No roles\" default tracks the machine count", () => {
  it("a second machine appearing while open withdraws the untouched default; headings appear; Start disabled", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("tina")], 2: [role("ops")] }));
    const pane = renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]));
    expect(roleGroupHeaders()).toEqual([]);
    typeCustomName();
    await waitFor(() => expect(createBtn().disabled).toBe(false));

    pane.setHostTree(twoHostTree);
    await waitFor(() => expect(roleOptionValues()).toHaveLength(2));
    await waitFor(() => expect(pickedRoleValues()).toEqual([]));
    expect(roleGroupHeaders()).toEqual(["alpha", "bravo"]);
    expect(createBtn().disabled).toBe(true);
  });

  it("a machine appearing after mount (0 → 1) gets the default", async () => {
    const pane = renderDefault({ hostTree: { name: "root", children: [] } });
    pane.setHostTree(oneHostTree);
    await waitFor(() => expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]));
  });

  it("a user's own pick survives a second machine appearing", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("tina")], 2: [role("ops")] }));
    const pane = renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(roleOptionValues()).toEqual(["tina"]));
    toggleRole("tina");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["tina"]));
    pane.setHostTree(twoHostTree);
    await waitFor(() => expect(roleOptionValues()).toHaveLength(2));
    expect(pickedRoleValues()).toEqual(["1/tina"]);
  });

  it("unticking the default \"No roles\" on one machine is not re-seeded", async () => {
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]));
    toggleNoRoles();
    await waitFor(() => expect(pickedRoleValues()).toEqual([]));
    await new Promise((r) => setTimeout(r, 20));
    expect(pickedRoleValues()).toEqual([]);
  });

  it("switching to Shell and back to Agent re-seeds \"No roles\" on one machine; Start enabled", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("tina")] }));
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]));
    chooseShell();
    await waitFor(() => expect(queryRolesGroup()).toBeFalsy());
    chooseAgent();
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    await waitFor(() => expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]));
    typeCustomName();
    await waitFor(() => expect(createBtn().disabled).toBe(false));
  });

  it("one machine whose roles fail to load still shows its preselected \"No roles\" entry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockOpenBirthStream.mockReturnValueOnce(emptyStream());
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: new Error("boom") }));
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringMatching(/roles fetch failed hostId=1/)));
    await waitFor(() => expect(roleListRows()).toEqual([NO_ROLES_VALUE]));
    expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]);
    typeCustomName();
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    fireEvent.click(createBtn());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.hostId).toBe(1);
    expect("role" in payload).toBe(false);
  });
});

describe("NewConversationPane roles: Test 25 — zero roles is a normal choice", () => {
  it("Test 25: single host, listRolesForHost returns [] → no hint; \"No roles\" picked", async () => {
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]));
    expect(screen.queryByText(/no roles on this host/i)).toBeNull();
    expect(roleListRows()).toEqual([NO_ROLES_VALUE]);
  });

  it("Test 25b: several hosts, none with roles → no hint; each host offers \"No roles\"", async () => {
    renderDefault();
    await waitFor(() => expect(roleListRows()).toHaveLength(4));
    expect(screen.queryByText(/no roles (on this host )?yet/i)).toBeNull();
    expect(pickedRoleValues()).toEqual([]);
    expect(roleListRows()).toEqual([
      "# alpha", `1/${NO_ROLES_VALUE}`,
      "# bravo", `2/${NO_ROLES_VALUE}`,
    ]);
  });
});

describe("NewConversationPane roles: per-host loading and errors", () => {
  it("the list waits behind 'Loading roles…' until every host has answered, then shows at once", async () => {
    const alpha = deferred<ReturnType<typeof role>[]>();
    const bravo = deferred<ReturnType<typeof role>[]>();
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: alpha.promise, 2: bravo.promise }));
    renderDefault();
    await waitFor(() => expect(rolesLoading()).toBe(true));
    expect(roleListRows()).toEqual([]);

    bravo.resolve([role("tina"), role("ops")]);
    await waitFor(() => expect(mockListRolesForHost).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(roleListRows()).toEqual([]);
    expect(rolesLoading()).toBe(true);
    expect(screen.queryByText(/no roles (on this host )?yet/i)).toBeNull();

    alpha.resolve([role("box-maintainer")]);
    await waitFor(() => expect(rolesLoading()).toBe(false));
    expect(roleListRows()).toEqual([
      "# alpha", `1/${NO_ROLES_VALUE}`, "1/box-maintainer",
      "# bravo", `2/${NO_ROLES_VALUE}`, "2/tina", "2/ops",
    ]);
  });

  it("a slow host holds the list back only so long; its roles then join under the others", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const alpha = deferred<ReturnType<typeof role>[]>();
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: alpha.promise, 2: [role("tina")] }));
    renderDefault();
    await waitFor(() => expect(mockListRolesForHost).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(roleListRows()).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    await waitFor(() => expect(roleOptionValues()).toEqual(["2/tina"]));
    expect(rolesLoading()).toBe(true);
    const loadingLine = screen.getByTestId("role-pick-loading");
    const lastGroup = screen.getByTestId("role-pick-group-2");
    expect(lastGroup.compareDocumentPosition(loadingLine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    toggleRole("tina");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["2/tina"]));

    alpha.resolve([role("box-maintainer")]);
    await waitFor(() => expect(roleOptionValues()).toHaveLength(2));
    expect(rolesLoading()).toBe(false);
    expect(roleGroupHeaders()).toEqual(["alpha", "bravo"]);
    expect(pickedRoleValues()).toEqual(["2/tina"]);
  });

  it("a new pane shows the roles from last time straight away, then takes each host's fresh answer", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("box-maintainer")], 2: [role("tina")] }));
    const first = renderDefault();
    await waitFor(() => expect(roleOptionValues()).toEqual(["1/box-maintainer", "2/tina"]));
    first.unmount();

    const alpha = deferred<ReturnType<typeof role>[]>();
    const bravo = deferred<ReturnType<typeof role>[]>();
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: alpha.promise, 2: bravo.promise }));
    renderDefault();
    // Last time's roles on the very first paint — and no loading line under them.
    expect(roleOptionValues()).toEqual(["1/box-maintainer", "2/tina"]);
    expect(rolesLoading()).toBe(false);

    alpha.resolve([role("box-maintainer")]);
    bravo.resolve([role("tina"), role("ops")]);
    await waitFor(() => expect(roleOptionValues()).toEqual(["1/box-maintainer", "2/tina", "2/ops"]));
  });

  it("a host that failed last time doesn't hold a new pane's list behind 'Loading roles…'", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: new Error("connect ETIMEDOUT"), 2: [role("tina")] }));
    const first = renderDefault();
    await waitFor(() => expect(roleOptionValues()).toEqual(["2/tina"]));
    await waitFor(() => expect(rolesLoading()).toBe(false));
    first.unmount();

    const alpha = deferred<ReturnType<typeof role>[]>();
    const bravo = deferred<ReturnType<typeof role>[]>();
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: alpha.promise, 2: bravo.promise }));
    renderDefault();
    expect(roleOptionValues()).toEqual(["2/tina"]);
    expect(rolesLoading()).toBe(false);

    alpha.resolve([role("box-maintainer")]);
    bravo.resolve([role("tina")]);
    await waitFor(() => expect(roleOptionValues()).toEqual(["1/box-maintainer", "2/tina"]));
    warn.mockRestore();
  });

  it("one host failing still lists the other hosts' roles, with no error line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: new Error("connect ETIMEDOUT"), 2: [role("tina")] }));
    renderDefault();
    await waitFor(() => expect(roleOptionValues()).toEqual(["2/tina"]));
    expect(screen.queryByTestId("role-pick-group-1")).toBeNull();
    expect(roleListRows()).toEqual([`2/${NO_ROLES_VALUE}`, "2/tina"]);
    expect(screen.queryByText(/couldn't load roles/i)).toBeNull();
    expect(screen.queryByText(/ETIMEDOUT/)).toBeNull();
    expect(screen.queryByText(/no roles (on this host )?yet/i)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/roles fetch failed hostId=1/));
  });

  it("every host failing → no error lines and no zero-roles hint", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: new Error("boom-a"), 2: new Error("boom-b") }));
    renderDefault();
    await waitFor(() => expect(mockListRolesForHost).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rolesLoading()).toBe(false));
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(screen.queryByText(/couldn't load roles/i)).toBeNull();
    expect(screen.queryByText(/no roles (on this host )?yet/i)).toBeNull();
    expect(screen.queryByTestId("role-pick-no-matches")).toBeNull();
    expect(screen.getByTestId("role-pick-empty").textContent).toBe("No roles to pick from right now");
  });

  it("one machine: No roles is preselected while its roles are still loading, and shows with them", async () => {
    const alpha = deferred<ReturnType<typeof role>[]>();
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: alpha.promise }));
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(rolesLoading()).toBe(true));
    expect(roleListRows()).toEqual([]);
    expect(screen.queryByTestId("role-pick-empty")).toBeNull();
    alpha.resolve([role("tina")]);
    await waitFor(() => expect(rolesLoading()).toBe(false));
    expect(roleListRows()).toEqual([NO_ROLES_VALUE, "tina"]);
    expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]);
  });

  it("single host failing → no error line", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: new Error("boom") }));
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(roleListRows()).toEqual([NO_ROLES_VALUE]));
    expect(screen.queryByText("boom")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// "New role…" row at the bottom of the roles list. The dialog handed its
// context (host, roles, name) to an onNewRole callback; the pane opens the
// roles window itself on the picked machine and keeps its own picks (the
// back / created / ✕ outcomes are in NewConversationPane.pane.test.tsx).
// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane roles: New role… row", () => {
  const twoRoles = [role("box-maintainer"), role("tina")];

  it("is the last row; clicking it opens the roles window on the picked role's machine, picks kept", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: twoRoles, 2: [role("x")] }));
    renderDefault();
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    toggleRole("tina");
    toggleRole("box-maintainer");
    const row = queryNewRoleRow()!;
    expect(row.textContent).toMatch(/new role/i);
    const rows = Array.from(document.querySelectorAll('[data-testid^="role-pick-"]'));
    expect(rows[rows.length - 1]).toBe(row);
    fireEvent.click(row);
    expect(rolesWindow.props!.open).toBe(true);
    expect(rolesWindow.props!.start.view).toBe("new");
    expect(rolesWindow.props!.start.host!.id).toBe("1");
    expect(rolesWindow.props!.newRoleHop).toBeTruthy();
    expect(pickedRoleSlugs()).toEqual(["box-maintainer", "tina"]);
  });

  it("multi-host with nothing picked opens it with host: null", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: twoRoles, 2: [role("x")] }));
    renderDefault();
    await waitFor(() => expect(roleOptionValues()).toHaveLength(3));
    fireEvent.click(queryNewRoleRow()!);
    expect(rolesWindow.props!.open).toBe(true);
    expect(rolesWindow.props!.start.host).toBeNull();
  });

  it("is there when no host has roles", async () => {
    renderDefault();
    await waitFor(() => expect(roleListRows()).toHaveLength(4));
    expect(screen.queryByText(/no matching roles/i)).toBeNull();
    fireEvent.click(queryNewRoleRow()!);
    expect(rolesWindow.props!.open).toBe(true);
  });

  it("single host with zero roles → no nudge to create a role", async () => {
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(roleListRows()).toEqual([NO_ROLES_VALUE]));
    expect(screen.queryByText(/No roles (on this host )?yet/)).toBeNull();
    expect(queryNewRoleRow()).toBeTruthy();
  });

  it("a new hostTree object while mounted does not re-seed over the user's picks or refetch", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: twoRoles, 2: [] }));
    const pane = renderDefault({ picks: { hostId: 1, roles: ["tina"] } });
    await waitFor(() => expect(pickedRoleSlugs()).toEqual(["tina"]));
    toggleRole("box-maintainer");
    await waitFor(() => expect(pickedRoleSlugs()).toEqual(["box-maintainer", "tina"]));
    // Same hosts, fresh object (what a parent re-render can hand over).
    pane.setHostTree({ ...twoHostTree, children: [...twoHostTree.children] });
    await new Promise((r) => setTimeout(r, 20));
    expect(pickedRoleSlugs()).toEqual(["box-maintainer", "tina"]);
    expect(mockListRolesForHost).toHaveBeenCalledTimes(2);
  });

  it("a typed name is kept in the picks and comes back from them", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: twoRoles, 2: [] }));
    const first = renderDefault({ picks: { hostId: 1 } });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(2));
    typeName("alicia");
    await waitFor(() => expect(lastReportedPicks(first.updatePicks)?.name).toBe("alicia"));
    first.unmount();

    renderDefault({ picks: { hostId: 1, name: "alicia" } });
    await waitFor(() => expect(nameValue()).toBe("alicia"));
  });

  it("a suggested name is never kept as the user's name", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: twoRoles, 2: [] }));
    mockPickPoolName.mockResolvedValue({ name: "willow" });
    const pane = renderDefault({ picks: { hostId: 1 } });
    await waitFor(() => expect(nameValue()).toBe("willow"));
    toggleRole("tina");
    await waitFor(() => expect(lastReportedPicks(pane.updatePicks)?.roles).toEqual(["tina"]));
    expect(pane.updatePicks.mock.calls.every((c) => (c[1] as NewConversationPicks).name === undefined)).toBe(true);
  });

  it("picks with several roles seed several picks; birth keeps the seeded order", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: twoRoles, 2: [] }));
    mockOpenBirthStream.mockReturnValueOnce(emptyStream());
    renderDefault({ picks: { hostId: 1, roles: ["tina", "box-maintainer"] } });
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/box-maintainer", "1/tina"]));
    expect(pickedRoleLabels()).toEqual(["Box Maintainer", "Tina"]);
    typeCustomName();
    await waitFor(() => expect(createBtn().disabled).toBe(false));
    fireEvent.click(createBtn());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    expect(mockOpenBirthStream.mock.calls[0][0]).toMatchObject({
      hostId: 1,
      role: "tina",
      roles: ["box-maintainer"],
    });
  });
});

describe("NewConversationPane roles: Test 27 — hidden when an admin picks Shell", () => {
  it("Test 27: choose Shell → roles list absent from DOM; host list appears", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("box-maintainer")] }));
    renderDefault();
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    expect(screen.queryByLabelText(/search hosts/i)).toBeNull();
    chooseShell();
    await waitFor(() => expect(queryRolesGroup()).toBeFalsy());
    expect(screen.getByLabelText(/search hosts/i)).toBeTruthy();
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("bravo")).toBeTruthy();
  });
});
