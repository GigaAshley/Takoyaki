// ─── NewConversationPane name + task coverage (ported from NewSessionDialog.task-input.test.tsx)
//
// Covers:
//   1. No task field (birth sends a placeholder; the agent fills its own task)
//   2. The placeholder task wired into the birth request
//   3. poolPicked wire signal (true iff the name is the unedited suggestion)
//   4. pickPoolName suggestion as soon as a machine is known
//   5. A suggestion never overwrites a typed name (even one typed while the
//      suggestion was on its way)
//   6. The roles list shows with no host picked (no "pick a host" hint)
//
// Pane vs dialog: the name lives in the pill — pillName() reads it (the pill
// capitalises the first letter; pillName() undoes that), typeName() renames
// in place. The dialog's "Suggested — change it if you like." help line under
// its Name field has no counterpart in the pill, so those assertions are gone;
// whether a name counts as typed or suggested is read from the picks the pane
// reports (a suggestion is never reported) and the birth request.
//
// Mock scaffolding lifted from NewConversationPane.role-dropdown.test.tsx so
// this file is self-contained.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, waitFor, screen } from "@testing-library/react";

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

// Empty stream helper — resolves immediately so the start path can capture
// the request without running the actual birth loop.
async function* emptyStream() {
  // nothing
}

import { clearHostRolesCache } from "@/sidebar/host-roles-cache";
import {
  queryRolesGroup,
  pickedRoleValues,
  roleOptionValues,
  toggleRole,
  chooseShell,
  typeName,
  openRename,
  pillName,
  renderPane,
  makeHost,
  startButton,
  lastReportedPicks,
  NO_ROLES_VALUE,
} from "./NewConversationPane.roles-test-helpers";
import type { HostFolder } from "@/types/ui-types";

// Single-host tree — the pane picks the sole host, so most tests skip a host step.
const oneHostTree: HostFolder = {
  name: "root",
  children: [makeHost("1", "alpha", { username: "root", ip: "10.0.0.1" })],
};

const twoHostTree: HostFolder = {
  name: "root",
  children: [
    makeHost("1", "alpha", { username: "root", ip: "10.0.0.1" }),
    makeHost("2", "bravo", { username: "root", ip: "10.0.0.2" }),
  ],
};

// Defaults to isAdmin=true (the Agent / Shell switch is admin-only).
function renderDefault(overrides: { hostTree?: HostFolder; isAdmin?: boolean } = {}) {
  return renderPane({ hostTree: oneHostTree, isAdmin: true, ...overrides });
}

// Ensure `slug` is checked (clicking an already-checked row would UNcheck it).
function ensureRolePicked(slug: string) {
  if (!pickedRoleValues().includes(slug)) toggleRole(slug);
}

// Fill everything an agent needs, picking "box-maintainer".
async function fillFormForSubmit(opts: {
  name?: string;
  editNameAfterPrefill?: boolean;
  waitForPrefill?: boolean;
} = {}) {
  const { name = "alicia", editNameAfterPrefill, waitForPrefill } = opts;
  await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
  ensureRolePicked("box-maintainer");
  if (waitForPrefill) {
    await waitFor(() => expect(mockPickPoolName).toHaveBeenCalled());
    await waitFor(() => expect(pillName().length).toBeGreaterThan(0));
    if (editNameAfterPrefill) typeName(name);
  } else {
    typeName(name);
  }
  await waitFor(() => expect(startButton().disabled).toBe(false));
}

beforeEach(() => {
  clearHostRolesCache();
  // Clear call history AND drain any leftover Once-values from a prior test.
  vi.clearAllMocks();
  mockListRolesForHost.mockReset();
  mockPickPoolName.mockReset();
  mockOpenBirthStream.mockReset();
  mockListIdentities.mockReset();
  mockGetIdentityExistsOnHost.mockReset();
  mockListRolesForHost.mockResolvedValue([{ name: "box-maintainer", description: "" }]);
  mockListIdentities.mockResolvedValue([]);
  mockGetIdentityExistsOnHost.mockResolvedValue(false);
  mockOpenBirthStream.mockReturnValue(emptyStream());
  // Default: no suggestion — individual tests override.
  mockPickPoolName.mockRejectedValue(new Error("no pool endpoint in this test"));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("NewConversationPane task input: there is none", () => {
  it("Task 1a: no task field in agent mode", async () => {
    renderDefault();
    // The roles list proves the agent fields rendered, so the absence means something.
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    expect(screen.queryByLabelText(/^task$/i)).toBeFalsy();
    expect(screen.queryByText(/what will this agent work on/i)).toBeFalsy();
  });

  it("Task 1b: no task field in shell mode either", async () => {
    renderDefault();
    chooseShell();
    await waitFor(() => expect(screen.queryByLabelText(/^task$/i)).toBeFalsy());
  });
});

describe("NewConversationPane task input: wiring into the birth request", () => {
  it("Task 1d: the birth request carries the placeholder task", async () => {
    renderDefault();
    await fillFormForSubmit({ name: "alicia" });
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.task).toBe("Untitled conversation");
  });

  it("Task 1e: the placeholder is sent unconditionally, never omitted", async () => {
    // A row shows `task` as its primary line; absent, it would be blank until
    // the agent's first wake.
    renderDefault();
    await fillFormForSubmit({ name: "bella" });
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.task).toBeDefined();
    expect(payload.task).not.toBe("");
  });
});

describe("NewConversationPane task input: poolPicked wire signal", () => {
  it("Task 1f: a typed name (no suggestion) → the birth request omits poolPicked", async () => {
    renderDefault();
    await fillFormForSubmit({ name: "alicia" });
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.poolPicked).toBeUndefined();
  });
});

describe("NewConversationPane task input: pickPoolName suggestion", () => {
  it("Task 2a: the suggestion request fires once when the machine is known and fills the name; picking a role doesn't ask again", async () => {
    mockListRolesForHost.mockResolvedValue([
      { name: "box-maintainer", description: "" },
      { name: "tina", description: "" },
    ]);
    mockPickPoolName.mockResolvedValueOnce({ name: "willow" });
    renderDefault();
    await waitFor(() => expect(mockPickPoolName).toHaveBeenCalled());
    const [hostId] = mockPickPoolName.mock.calls[0] as [number, string | undefined];
    expect(typeof hostId).toBe("number");
    await waitFor(() => expect(pillName()).toBe("willow"));

    const callsBefore = mockPickPoolName.mock.calls.length;
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    toggleRole("box-maintainer");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["box-maintainer"]));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockPickPoolName.mock.calls.length).toBe(callsBefore);
  });

  it("Task 2b: a typed name is NOT overwritten when a suggestion arrives later", async () => {
    mockPickPoolName
      .mockResolvedValueOnce({ name: "willow" })
      .mockResolvedValueOnce({ name: "cinder" });
    mockListRolesForHost.mockResolvedValue([
      { name: "box-maintainer", description: "" },
      { name: "tina", description: "" },
    ]);
    renderDefault();
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    typeName("custom-name");
    toggleRole("box-maintainer");
    await waitFor(() => expect(mockPickPoolName).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(pillName()).toBe("custom-name");
  });

  it("Task 2b-race: a name typed WHILE a suggestion is in flight is not overwritten", async () => {
    let releasePick: (v: { name: string }) => void = () => {};
    mockPickPoolName.mockImplementation(
      () => new Promise((resolve) => { releasePick = resolve; }),
    );
    mockListRolesForHost.mockResolvedValue([
      { name: "box-maintainer", description: "" },
      { name: "general-assistant", description: "" },
    ]);
    renderDefault();
    // Request in flight, name still empty.
    await waitFor(() => expect(mockPickPoolName).toHaveBeenCalled());
    expect(pillName()).toBe("");
    // The user names it while the suggestion is pending.
    typeName("sample");
    expect(pillName()).toBe("sample");
    // The suggestion lands — the user's name wins.
    releasePick({ name: "willow" });
    await new Promise((r) => setTimeout(r, 50));
    expect(pillName()).toBe("sample");
  });

  it("Task 2e: switching hosts (via another host's role) re-suggests, replacing an unedited suggestion", async () => {
    mockPickPoolName
      .mockResolvedValueOnce({ name: "willow" })
      .mockResolvedValueOnce({ name: "aster" });
    mockListRolesForHost.mockResolvedValue([
      { name: "box-maintainer", description: "" },
      { name: "general-assistant", description: "" },
    ]);
    renderDefault({ hostTree: twoHostTree });
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    // No host yet → no suggestion yet.
    expect(mockPickPoolName).not.toHaveBeenCalled();
    toggleRole("box-maintainer", "1");
    await waitFor(() => expect(pillName()).toBe("willow"));
    expect(mockPickPoolName.mock.calls[0][0]).toBe(1);

    toggleRole("box-maintainer", "2");
    await waitFor(() => expect(pillName()).toBe("aster"));
    expect(mockPickPoolName.mock.calls[1][0]).toBe(2);
  });

  it("Task 2c: pickPoolName failure is silent — the user can name it", async () => {
    mockPickPoolName.mockRejectedValueOnce(new Error("pool endpoint down"));
    renderDefault();
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    ensureRolePicked("box-maintainer");
    await waitFor(() => expect(mockPickPoolName).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/pool endpoint down/i)).toBeFalsy();
    expect(pillName()).toBe("");
    expect(openRename()).toBeTruthy();
  });

  it("Task 2d: the name is suggested with NO role picked", async () => {
    mockListRolesForHost.mockResolvedValue([
      { name: "box-maintainer", description: "" },
      { name: "general-assistant", description: "" },
    ]);
    mockPickPoolName.mockResolvedValue({ name: "willow" });
    renderDefault();
    await waitFor(() => expect(pillName()).toBe("willow"));
    // "No roles" is the one-host default; the request carried role undefined.
    expect(pickedRoleValues()).toEqual([NO_ROLES_VALUE]);
    const [hostId, role] = mockPickPoolName.mock.calls[0] as [number, string | undefined];
    expect(typeof hostId).toBe("number");
    expect(role).toBeUndefined();
  });
});

describe("NewConversationPane task input: poolPicked wire signal end-to-end", () => {
  it("Task 3a: unedited suggestion → the birth request has poolPicked: true and name", async () => {
    mockPickPoolName.mockResolvedValueOnce({ name: "willow" });
    renderDefault();
    await fillFormForSubmit({ waitForPrefill: true });
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.poolPicked).toBe(true);
    expect(payload.name).toBe("willow");
  });

  it("Task 3b: renamed after the suggestion → no poolPicked; displayName instead of name", async () => {
    mockPickPoolName.mockResolvedValueOnce({ name: "willow" });
    renderDefault();
    await fillFormForSubmit({ waitForPrefill: true, editNameAfterPrefill: true, name: "willow-my-custom" });
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.poolPicked).toBeUndefined();
    expect(payload.name).toBeUndefined();
    expect(payload.displayName).toBe("willow-my-custom");
  });
});

describe("NewConversationPane: no host step for agents", () => {
  it("Task 3c: several hosts, none picked → the roles list shows every host's roles; no 'Pick a host' hint", async () => {
    renderDefault({ hostTree: twoHostTree });
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    expect(roleOptionValues()).toEqual(["1/box-maintainer", "2/box-maintainer"]);
    expect(pickedRoleValues()).toEqual([]);
    expect(screen.queryByText(/pick a host/i)).toBeFalsy();
  });

  it("Task 3d: one host auto-picked → no hint + roles list shows", async () => {
    renderDefault({ hostTree: oneHostTree });
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    expect(screen.queryByText(/pick a host to see available roles/i)).toBeFalsy();
  });

  it("Task 3e: Shell with no host picked → no hint", async () => {
    renderDefault({ hostTree: twoHostTree });
    chooseShell();
    await waitFor(() => expect(screen.queryByText(/pick a host to see available roles/i)).toBeFalsy());
  });
});

// A suggested name must never overwrite one the user typed.
describe("NewConversationPane name: in the pill, filled with the suggestion", () => {
  it("the suggestion lands in the pill, no tick-box needed", async () => {
    mockPickPoolName.mockResolvedValue({ name: "willow" });
    renderDefault();
    // The pill is there before the suggestion arrives.
    expect(screen.getByTestId("pv-task-pill-label")).toBeTruthy();
    expect(screen.queryByLabelText(/choose a custom agent name/i)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await waitFor(() => expect(pillName()).toBe("willow"));
  });

  it("a typed name replaces the suggestion and is kept in the picks; typing the suggestion back counts as the suggestion again", async () => {
    mockPickPoolName.mockResolvedValue({ name: "willow" });
    const pane = renderDefault();
    await waitFor(() => expect(pillName()).toBe("willow"));
    typeName("Alicia Smith");
    expect(pillName()).toBe("Alicia Smith");
    await waitFor(() => expect(lastReportedPicks(pane.updatePicks)?.name).toBe("Alicia Smith"));
    typeName("willow");
    await waitFor(() => expect(lastReportedPicks(pane.updatePicks)?.name).toBeUndefined());
    ensureRolePicked("box-maintainer");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    expect(mockOpenBirthStream.mock.calls[0][0]).toMatchObject({ name: "willow", poolPicked: true });
  });

  it("a later suggestion (host switch) never overwrites a typed name", async () => {
    mockPickPoolName
      .mockResolvedValueOnce({ name: "willow" })
      .mockResolvedValueOnce({ name: "aster" });
    mockListRolesForHost.mockResolvedValue([{ name: "box-maintainer", description: "" }]);
    renderDefault({ hostTree: twoHostTree });
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    toggleRole("box-maintainer", "1");
    await waitFor(() => expect(pillName()).toBe("willow"));
    typeName("my-own");
    toggleRole("box-maintainer", "2");
    await waitFor(() => expect(mockPickPoolName).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(pillName()).toBe("my-own");
  });

  it("a machine change drops the previous machine's untouched suggestion; the new machine's fills in", async () => {
    let resolveSecond!: (v: { name: string }) => void;
    mockPickPoolName
      .mockResolvedValueOnce({ name: "willow" })
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
    mockListRolesForHost.mockResolvedValue([{ name: "box-maintainer", description: "" }]);
    renderDefault({ hostTree: twoHostTree });
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    toggleRole("box-maintainer", "1");
    await waitFor(() => expect(pillName()).toBe("willow"));
    // Picking on the other machine: willow was checked on machine 1 only.
    toggleRole("box-maintainer", "2");
    await waitFor(() => expect(mockPickPoolName).toHaveBeenCalledTimes(2));
    expect(pillName()).toBe("");
    resolveSecond({ name: "aster" });
    await waitFor(() => expect(pillName()).toBe("aster"));
  });

  it("a machine change whose suggestion fails leaves no name, not the old machine's", async () => {
    mockPickPoolName
      .mockResolvedValueOnce({ name: "willow" })
      .mockRejectedValueOnce(new Error("pool down"));
    mockListRolesForHost.mockResolvedValue([{ name: "box-maintainer", description: "" }]);
    renderDefault({ hostTree: twoHostTree });
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    toggleRole("box-maintainer", "1");
    await waitFor(() => expect(pillName()).toBe("willow"));
    toggleRole("box-maintainer", "2");
    await waitFor(() => expect(mockPickPoolName).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(pillName()).toBe("");
    // Still renameable.
    expect(openRename()).toBeTruthy();
  });

  it("no suggestion (pool down) → no name, renameable, no error; naming it enables Start", async () => {
    renderDefault();
    await waitFor(() => expect(mockPickPoolName).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(pillName()).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
  });
});
