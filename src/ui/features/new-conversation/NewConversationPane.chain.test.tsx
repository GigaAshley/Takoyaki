// ─── NewConversationPane seeding coverage (ported from NewSessionDialog.chain.test.tsx)
//
// A pane starts from its `picks` (what a project / role entry, a return from
// the roles window or a reload hands it): `hostId` + `roles` seed both;
// without `hostId` nothing is seeded (there is no telling which machine's
// copy of a role was meant). The dialog took the same seed as
// initialHost / initialRole props.
//
//   - Test 1: hostId + roles → both pre-filled
//   - Test 2: no picks → one machine is picked for you (with "No roles"),
//             several are not
//   - Test 3: hostId only → host pre-filled, roles empty
//   - Test 4: roles only (no hostId) → not seeded
//   - Test 5: every machine's roles are fetched; the seeded role is among them
//   - Test 6: a seeded role the machine doesn't have is cleared
//   - Test 7: seeded picks are editable
//   - Test 9: Shell drops the seeded roles
//   - Test 10: the brief field stays gone
//   - Test 11: a seeded pane starts an agent on the seeded machine
//
// "Which machine is picked" is observed through what "New role…" hands the
// roles window (RolesWindow is stubbed and its props captured), as the dialog
// suite did through its onNewRole callback.
//
// Dropped from the dialog suite: Test 8 (seed doesn't persist across modal
// close / reopen — the pane has no close; a new pane is a new mount) and
// Test 10a (the initialBrief prop no longer exists).
//
// Host ids are numeric strings so rolesByHost() can answer per host.

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
// Suggested names aren't exercised here.
const mockPickPoolName = vi.fn().mockRejectedValue(
  new Error("pickPoolName not exercised in chain.test.tsx"),
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

// The roles window is stubbed: "New role…" opening it, and with which
// machine, is what these tests read.
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

import { clearHostRolesCache } from "@/sidebar/host-roles-cache";
import {
  queryRolesGroup,
  getRolesGroup,
  roleOptionValues,
  pickedRoleValues,
  pickedRoleSlugs,
  pickedRoleLabels,
  toggleRole,
  rolesByHost,
  roleRow,
  queryNewRoleRow,
  chooseShell,
  typeName,
  renderPane,
  makeHost,
  startButton,
  createMockStream,
  NO_ROLES_VALUE,
} from "./NewConversationPane.roles-test-helpers";
import type { HostFolder } from "@/types/ui-types";

const hostA = makeHost("1", "box-a", { username: "root", ip: "10.0.0.1" });
const hostB = makeHost("2", "box-b", { username: "root", ip: "10.0.0.2" });

const role = (name: string) => ({ name, description: "" });

// The machine the pane would hand to "New role…" right now — the observable
// stand-in for "which host is selected" when no role pins it (null = none).
// Goes back out of the roles window afterwards.
function selectedHostViaNewRole(): { id: string } | null {
  fireEvent.click(queryNewRoleRow()!);
  const props = rolesWindow.props!;
  expect(props.open).toBe(true);
  const host = props.start.host ?? null;
  act(() => props.newRoleHop!.onBack());
  return host;
}

const twoHostTree: HostFolder = { name: "root", children: [hostA, hostB] };
const singleHostTree: HostFolder = { name: "root", children: [hostA] };

beforeEach(() => {
  clearHostRolesCache();
  vi.clearAllMocks();
  rolesWindow.props = null;
  mockListRolesForHost.mockResolvedValue([{ name: "box-maintainer", description: "" }]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("NewConversationPane seed: Test 1 — hostId + roles pre-fill both", () => {
  it("Test 1: picks {hostId: box-a, roles: ['box-maintainer']} → host + role pre-selected", async () => {
    // Both hosts offer box-maintainer, so the composite value is what proves
    // box-a (not box-b) was seeded.
    mockListRolesForHost.mockImplementation(
      rolesByHost({ 1: [role("box-maintainer"), role("tina")], 2: [role("box-maintainer")] }),
    );
    renderPane({ hostTree: twoHostTree, isAdmin: false, picks: { hostId: 1, roles: ["box-maintainer"] } });
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/box-maintainer"]));
    expect(pickedRoleLabels()).toEqual(["Box Maintainer"]);
    const groupA = screen.getByTestId("role-pick-group-1");
    expect(groupA.contains(roleRow("1/box-maintainer"))).toBe(true);
    expect(groupA.querySelector(".k-group-title")?.textContent).toBe("box-a");
    // Every host was asked (the seed doesn't narrow the fetch), by numeric id.
    expect(mockListRolesForHost.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2]);
  });
});

describe("NewConversationPane seed: Test 2 — no picks", () => {
  it("Test 2a: one machine, no picks → it is picked, with \"No roles\"", async () => {
    mockListRolesForHost.mockResolvedValue([role("box-maintainer"), role("tina")]);
    renderPane({ hostTree: singleHostTree, isAdmin: false });
    await waitFor(() => expect(roleOptionValues()).toEqual(["box-maintainer", "tina"]));
    expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]);
    expect(selectedHostViaNewRole()?.id).toBe("1");
  });

  it("Test 2b: two machines, no picks → no host list, nothing picked; both machines' roles listed", async () => {
    renderPane({ hostTree: twoHostTree, isAdmin: false });
    expect(
      screen.queryAllByText("box-a").filter((el) => !el.closest('[data-testid="role-pick-list"]')),
    ).toEqual([]);
    await waitFor(() => expect(roleOptionValues()).toEqual(["1/box-maintainer", "2/box-maintainer"]));
    expect(pickedRoleValues()).toEqual([]);
    expect(selectedHostViaNewRole()).toBeNull();
  });
});

describe("NewConversationPane seed: Test 3 — hostId alone", () => {
  it("Test 3: picks {hostId: box-a} → host pre-filled, roles empty", async () => {
    mockListRolesForHost.mockResolvedValue([role("box-maintainer"), role("general-assistant")]);
    renderPane({ hostTree: twoHostTree, isAdmin: false, picks: { hostId: 1 } });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(4));
    expect(pickedRoleValues()).toEqual([]);
    expect(selectedHostViaNewRole()?.id).toBe("1");
  });

  it("Test 3b: hostId + a single available role anywhere → nothing is auto-selected", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("box-maintainer")], 2: [] }));
    renderPane({ hostTree: twoHostTree, isAdmin: false, picks: { hostId: 1 } });
    await waitFor(() => expect(roleOptionValues()).toEqual(["1/box-maintainer"]));
    expect(pickedRoleValues()).toEqual([]);
  });
});

describe("NewConversationPane seed: Test 4 — roles alone", () => {
  it("Test 4a: picks {roles: ['box-maintainer']} on two machines → not seeded", async () => {
    renderPane({ hostTree: twoHostTree, isAdmin: false, picks: { roles: ["box-maintainer"] } });
    await waitFor(() => expect(roleOptionValues()).toHaveLength(2));
    expect(pickedRoleValues()).toEqual([]);
  });

  it("Test 4b: picks {roles: ['box-maintainer']} on one machine → the machine is picked; no role seeded", async () => {
    // The roles deliberately EXCLUDE box-maintainer: if the seed wrongly
    // applied, the stale-role guard would also clear it, so only "never
    // seeded" explains the one-machine default here.
    mockListRolesForHost.mockResolvedValue([role("general-assistant"), role("video-producer")]);
    renderPane({ hostTree: singleHostTree, isAdmin: false, picks: { roles: ["box-maintainer"] } });
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]);
  });
});

describe("NewConversationPane seed: Test 5 — roles fetched for the seeded host", () => {
  it("Test 5: hostId + roles → listRolesForHost fired per host; the seeded role is in the list", async () => {
    mockListRolesForHost.mockImplementation(
      rolesByHost({ 1: [role("box-maintainer"), role("tina")], 2: [role("other-role")] }),
    );
    renderPane({ hostTree: twoHostTree, isAdmin: false, picks: { hostId: 1, roles: ["box-maintainer"] } });
    await waitFor(() => expect(mockListRolesForHost).toHaveBeenCalledWith(1));
    expect(mockListRolesForHost).toHaveBeenCalledWith(2);
    await waitFor(() => expect(roleOptionValues()).toContain("1/box-maintainer"));
    expect(pickedRoleValues()).toEqual(["1/box-maintainer"]);
  });
});

describe("NewConversationPane seed: Test 6 — stale seeded role is cleared", () => {
  it("Test 6: roles: ['ghost-role'] the seeded machine doesn't have → cleared", async () => {
    // ghost-role exists on box-b but NOT on the seeded box-a — the guard
    // validates against the seeded host.
    mockListRolesForHost.mockImplementation(
      rolesByHost({ 1: [role("box-maintainer"), role("tina")], 2: [role("ghost-role")] }),
    );
    renderPane({ hostTree: twoHostTree, isAdmin: false, picks: { hostId: 1, roles: ["ghost-role"] } });
    await waitFor(() => expect(mockListRolesForHost).toHaveBeenCalled());
    await waitFor(() => {
      expect(roleOptionValues()).toEqual(["1/box-maintainer", "1/tina", "2/ghost-role"]);
      expect(pickedRoleValues()).toEqual([]);
    });
  });
});

describe("NewConversationPane seed: Test 7 — seeded picks are editable", () => {
  it("Test 7: change the roles — and the host, via another host's role — after the seed", async () => {
    mockListRolesForHost.mockImplementation(
      rolesByHost({
        1: [role("box-maintainer"), role("tina")],
        2: [role("other-role"), role("another-role")],
      }),
    );
    renderPane({ hostTree: twoHostTree, isAdmin: false, picks: { hostId: 1, roles: ["box-maintainer"] } });
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/box-maintainer"]));
    expect(getRolesGroup()).toBeTruthy();
    expect(roleRow("1/tina")!.dataset.disabled).toBeUndefined();

    toggleRole("tina");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/box-maintainer", "1/tina"]));

    toggleRole("other-role");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["2/other-role"]));
    expect(pickedRoleLabels()).toEqual(["Other Role"]);
    expect(screen.getByTestId("role-pick-group-2").contains(roleRow("2/other-role"))).toBe(true);
  });
});

describe("NewConversationPane seed: Test 10 — the brief field stays gone", () => {
  it("Test 10b: no brief field in agent mode (regression guard)", async () => {
    renderPane({ hostTree: twoHostTree, isAdmin: false });
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    expect(screen.queryByLabelText(/^brief$/i)).toBeFalsy();
  });

  it("Test 10c: no brief field in shell mode either", async () => {
    renderPane({ hostTree: twoHostTree, isAdmin: true, picks: { hostId: 1 } });
    chooseShell();
    await waitFor(() => expect(screen.queryByLabelText(/^brief$/i)).toBeFalsy());
  });
});

describe("NewConversationPane seed: Test 9 — Shell drops the seeded roles", () => {
  it("Test 9: seeded roles listed; choose Shell → roles list gone; the roles aren't in the shell's picks", async () => {
    const pane = renderPane({ hostTree: twoHostTree, isAdmin: true, picks: { hostId: 1, roles: ["box-maintainer"] } });
    await waitFor(() => expect(pickedRoleSlugs()).toEqual(["box-maintainer"]));
    chooseShell();
    await waitFor(() => expect(queryRolesGroup()).toBeFalsy());
    await waitFor(() => expect(pane.updatePicks).toHaveBeenCalled());
    const last = pane.updatePicks.mock.calls[pane.updatePicks.mock.calls.length - 1][1];
    expect(last).toEqual({ shell: true, hostId: 1 });
  });
});

describe("NewConversationPane seed: Test 11 — a seeded pane starts on the seeded machine", () => {
  it("Test 11: seeded pane + name + Start (single ended:ok:true) → refreshOneIdentity, then started({kind:'agent', name}) on box-a", async () => {
    async function* singleEndedOkStream() {
      await Promise.resolve();
      yield { type: "ended" as const, ok: true, identityId: "alicia", sessionName: "alicia" };
    }
    mockOpenBirthStream.mockReturnValueOnce(singleEndedOkStream());
    const pane = renderPane({ hostTree: twoHostTree, isAdmin: false, picks: { hostId: 1, roles: ["box-maintainer"] } });
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/box-maintainer"]));
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(startButton());
    await waitFor(() => expect(pane.started).toHaveBeenCalledTimes(1));
    expect(mockRefreshOneIdentity).toHaveBeenCalled();
    expect(pane.started.mock.calls[0][1]).toEqual(
      expect.objectContaining({ kind: "agent", name: "alicia", host: expect.objectContaining({ id: "1" }) }),
    );
    expect(mockOpenBirthStream).toHaveBeenCalledTimes(1);
    expect((mockOpenBirthStream.mock.calls[0][0] as { hostId: unknown }).hostId).toBe(1);
  });

  it("Test 11b: a seed of a create-and-come-back — hostId + roles + name — fills the Name field too", async () => {
    mockListRolesForHost.mockImplementation(rolesByHost({ 1: [role("box-maintainer")], 2: [] }));
    renderPane({ hostTree: twoHostTree, isAdmin: false, picks: { hostId: 1, roles: ["box-maintainer"], name: "alicia" } });
    await waitFor(() => expect(pickedRoleValues()).toEqual(["1/box-maintainer"]));
    expect((screen.getByTestId("new-conversation-name") as HTMLInputElement).value).toBe("alicia");
    // The pill names the kind of thing, never the agent.
    expect(screen.getByTestId("pv-task-pill-label").textContent).toBe("New conversation");
    await waitFor(() => expect(startButton().disabled).toBe(false));
  });
});
