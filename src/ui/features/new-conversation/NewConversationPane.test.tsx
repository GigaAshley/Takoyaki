// ─── NewConversationPane — Vitest coverage ───────────────────────────────────
//
// Ported from the old new-conversation dialog's suite (NewSessionDialog.test.tsx)
// when the dialog became a pane. The pick logic is the dialog's, carried over;
// what changed is how it is driven:
//   - no modal: no open/close, no Cancel, no title — the pane is mounted in
//     NewConversationHostContext (renderPane, with vi.fn() spies for
//     updatePicks / started / close);
//   - the name is in the pill (rename in place) — typeName() opens it, types,
//     commits; name errors show as `new-conversation-name-error`;
//   - "Create" is the compose box's main button ("Start the conversation"),
//     or Enter in its textarea; success calls started(tabId, …) (was onCreate +
//     onClose), failure keeps the pane with a `new-conversation-failure` line
//     (was a kit alert + close).
//
// Dropped from the dialog suite (behaviour gone): Test 2 / 2b (Close / Cancel
// buttons), Test U (modal state resets on close — the pane resets by
// unmounting), the D2 modal-title check, 106B's Escape / ✕ / Cancel lock (no
// modal to lock). Test 10 (the sidebar pencil precedes the rows) is a panel
// test and lives in PrettyConversationsPanel.test.tsx now.
//
// Fixtures: a small in-test hostTree (ids "h1".."h3"). react-i18next is
// mocked to a passthrough t(key, {defaultValue}).

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
// Every machine that can host agents is asked for its roles at mount. One
// role per host — on the three-host tree there are three copies, so tests pick
// alpha's (pickRoleFromAlpha).
const mockListRolesForHost = vi.fn().mockResolvedValue([
  { name: "box-maintainer", description: "" },
]);
// The pane asks for a suggested name as soon as a machine is known. Rejecting
// by default keeps the name empty unless a test types one.
const mockPickPoolName = vi.fn().mockRejectedValue(
  new Error("pickPoolName not exercised in this test file"),
);

vi.mock("@/api/identities-api", async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    listIdentities: (...args: unknown[]) => mockListIdentities(...args),
    getIdentityExistsOnHost: (...args: unknown[]) => mockGetIdentityExistsOnHost(...args),
    openBirthStream: (...args: unknown[]) => mockOpenBirthStream(...args),
    listRolesForHost: (...args: unknown[]) => mockListRolesForHost(...args),
    pickPoolName: (...args: unknown[]) => mockPickPoolName(...args),
  };
});

vi.mock("@/api/voice-api", () => ({
  SAMPLE_PHRASE: "Hi, this is your voice.",
  postSpeak: vi.fn().mockResolvedValue(new Blob(["audio"], { type: "audio/mpeg" })),
  postSpeakStream: vi.fn(),
}));
vi.mock("@/features/terminal/session-hue", () => ({
  sessionMatchKey: () => null,
  useSessionIdentity: () => ({ identity: null, identityHue: null }),
}));
// `refreshOneIdentity` is exposed so the success path can assert the newborn
// is fetched BEFORE started() hands the pane over.
const mockRefreshOneIdentity = vi.fn().mockResolvedValue(true);
vi.mock("@/state/identities-store", () => ({
  useIdentities: () => ({ byKey: new Map() }),
  refreshOneIdentity: (...args: unknown[]) => mockRefreshOneIdentity(...args),
}));
vi.mock("@/hooks/use-is-touch-device", () => ({
  useIsTouchDevice: () => false,
}));
// The pane's compose box is the real ComposeBox; keep its drafts / skills
// requests inert.
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

import { clearHostRolesCache } from "@/sidebar/host-roles-cache";
import { autoAnswerKitDialogs, __resetKitDialogsForTests } from "@/components/kit";
import {
  queryRolesGroup,
  getRolesGroup,
  pickedRoleValues,
  toggleRole,
  chooseShell,
  chooseAgent,
  shellChosen,
  queryModeSwitch,
  roleGroupHeaders,
  renderPane,
  makeHost,
  startButton,
  composeText,
  pressEnterInCompose,
  typeName,
  openRename,
  queryNameInput,
  pillLabel,
  nameValue,
  nameErrorText,
  createMockStream,
  hangingStream,
  TAB_ID,
} from "./NewConversationPane.roles-test-helpers";
import type { HostFolder } from "@/types/ui-types";

const threeHostTree: HostFolder = {
  name: "root",
  children: [
    {
      name: "folderA",
      children: [
        makeHost("h1", "alpha", { username: "root", ip: "10.0.0.1" }),
        makeHost("h2", "bravo", { username: "root", ip: "10.0.0.2" }),
      ],
    } as HostFolder,
    makeHost("h3", "charlie", { username: "root", ip: "10.0.0.3" }),
  ],
};

const oneHostTree: HostFolder = {
  name: "root",
  children: [makeHost("only", "sole-host")],
};

beforeEach(() => {
  clearHostRolesCache();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  __resetKitDialogsForTests();
});

// Agent mode has no host step: the host is whichever one the picked role
// comes from. Every host in threeHostTree offers "box-maintainer", so pick
// alpha's (h1) copy.
async function pickRoleFromAlpha() {
  await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
  toggleRole("box-maintainer", "h1");
  await waitFor(() => expect(pickedRoleValues()).toEqual(["h1/box-maintainer"]));
}

// Defaults to isAdmin=true (the admin surface is a superset); tests of the
// non-admin path pass isAdmin:false.
function renderDefault(overrides: Parameters<typeof renderPane>[0] = {}) {
  return renderPane({ hostTree: threeHostTree, isAdmin: true, ...overrides });
}

// Fill what an agent needs (a role — which picks the host — and a name) so
// Start becomes enabled.
async function fillIdentityForm() {
  await pickRoleFromAlpha();
  typeName("alicia");
  await waitFor(() => expect(startButton().disabled).toBe(false));
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: host list renders all hosts from tree (across folders) — shell only
// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: host list render", () => {
  it("Test 3: shell mode renders all hosts across folders (flattened)", () => {
    renderDefault();
    chooseShell();
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("bravo")).toBeTruthy();
    expect(screen.getByText("charlie")).toBeTruthy();
  });

  it("Test 3a: agent mode (default) renders no host list or host search", () => {
    renderDefault();
    expect(screen.queryByLabelText(/search hosts/i)).toBeNull();
    // Machine names only appear as the roles list's group headings, never as
    // a host picker.
    const outsideRoles = (name: string) =>
      screen.queryAllByText(name).filter((el) => !el.closest('[data-testid="role-pick-list"]'));
    expect(outsideRoles("alpha")).toEqual([]);
    expect(outsideRoles("bravo")).toEqual([]);
    expect(outsideRoles("charlie")).toEqual([]);
    expect(screen.queryByText(/pick a host/i)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: search input filters the host list
// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: search filter", () => {
  it("Test 4: shell mode — typing filters the host list to matching entries", () => {
    renderDefault();
    chooseShell();
    fireEvent.change(screen.getByLabelText(/search hosts/i), { target: { value: "alp" } });
    expect(screen.queryByText("alpha")).toBeTruthy();
    expect(screen.queryByText("bravo")).toBeNull();
    expect(screen.queryByText("charlie")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests 5-9: the shell's session name + host
// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: shell — empty name accepted", () => {
  it("Test 5: empty name → Start enabled after host select → started({kind:'shell', host, sessionName: undefined})", () => {
    const pane = renderDefault();
    chooseShell();
    // No host yet: Start is disabled.
    expect(startButton().disabled).toBe(true);
    fireEvent.click(screen.getByText("bravo"));
    // Empty name is valid.
    expect(startButton().disabled).toBe(false);
    fireEvent.click(startButton());
    expect(pane.started).toHaveBeenCalledTimes(1);
    const [tabId, what] = pane.started.mock.calls[0];
    expect(tabId).toBe(TAB_ID);
    expect(what.kind).toBe("shell");
    expect(what.host.id).toBe("h2");
    // Empty name → undefined (the server names the session).
    expect(what.sessionName).toBeUndefined();
  });
});

describe("NewConversationPane: shell — non-empty name passthrough", () => {
  it("Test 6: valid name → started({kind:'shell', host, sessionName: 'my-session'})", () => {
    const pane = renderDefault();
    chooseShell();
    fireEvent.click(screen.getByText("alpha"));
    fireEvent.change(screen.getByLabelText(/^name \(optional\)$/i), { target: { value: "my-session" } });
    expect(startButton().disabled).toBe(false);
    fireEvent.click(startButton());
    expect(pane.started).toHaveBeenCalledTimes(1);
    expect(pane.started.mock.calls[0][1]).toMatchObject({
      kind: "shell",
      host: expect.objectContaining({ id: "h1", name: "alpha" }),
      sessionName: "my-session",
    });
  });
});

describe("NewConversationPane: shell — invalid name disables Start", () => {
  it("Test 7: name with shell-metachars disables Start + surfaces error message", () => {
    const pane = renderDefault();
    chooseShell();
    fireEvent.click(screen.getByText("alpha"));
    fireEvent.change(screen.getByLabelText(/^name \(optional\)$/i), { target: { value: "bad;name`chars" } });
    expect(startButton().disabled).toBe(true);
    expect(screen.queryByText(/letters, numbers, underscores/i)).toBeTruthy();
    fireEvent.click(startButton());
    expect(pane.started).not.toHaveBeenCalled();
  });
});

describe("NewConversationPane: no host disables Start", () => {
  it("Test 8: fresh pane with no host picked → Start disabled", () => {
    renderPane({ hostTree: threeHostTree, isAdmin: false });
    expect(startButton().disabled).toBe(true);
  });
});

describe("NewConversationPane: single-host auto-select", () => {
  it("Test 9: one host → pre-selected in Shell, Start enabled, started() gets the sole host", () => {
    const pane = renderDefault({ hostTree: oneHostTree });
    chooseShell();
    expect(startButton().disabled).toBe(false);
    fireEvent.click(startButton());
    expect(pane.started).toHaveBeenCalledTimes(1);
    expect(pane.started.mock.calls[0][1].host.id).toBe("only");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests A-C: the shell's path field
// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: Test A — path field visible only in shell mode", () => {
  it("Test A: path input hidden in default agent mode; appears after an admin chooses Shell", () => {
    renderDefault();
    expect(screen.queryByLabelText(/^path$/i)).toBeNull();
    chooseShell();
    expect(screen.getByLabelText(/^path$/i)).toBeTruthy();
  });
});

describe("NewConversationPane: Test B — path defaults to empty (shell mode)", () => {
  it("Test B: shell-mode path input starts empty (normalizePath('') → '~')", () => {
    const pane = renderDefault({ hostTree: oneHostTree });
    chooseShell();
    expect((screen.getByLabelText(/^path$/i) as HTMLInputElement).value).toBe("");
    fireEvent.click(startButton());
    expect(pane.started.mock.calls[0][1].path).toBe("~");
  });
});

describe("NewConversationPane: Test C — path normalizes backslashes", () => {
  it("Test C: path with backslashes → started() gets the normalized path", () => {
    const pane = renderDefault();
    chooseShell();
    fireEvent.change(screen.getByLabelText(/^path$/i), { target: { value: "\\home\\ubuntu\\test\\dir" } });
    fireEvent.click(screen.getByText("bravo"));
    fireEvent.click(startButton());
    expect(pane.started).toHaveBeenCalledTimes(1);
    expect(pane.started.mock.calls[0][1].path).toBe("/home/ubuntu/test/dir");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test D: Agent / Shell switch defaults to Agent (admin-only)
// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: Test D — Agent / Shell switch defaults to Agent (admin-only)", () => {
  it("Test D: isAdmin=true → the switch is there with Agent pressed", () => {
    renderDefault({ isAdmin: true });
    expect(queryModeSwitch()).toBeTruthy();
    expect(screen.getByTestId("new-session-mode-agent").getAttribute("aria-pressed")).toBe("true");
    expect(shellChosen()).toBe(false);
    expect(screen.queryByRole("checkbox", { name: /just a shell/i })).toBeNull();
  });

  it("Test D2: the hello line and the pill say what each mode opens; switching back to Agent restores the agent fields", async () => {
    renderDefault({ isAdmin: true });
    expect(pillLabel()).toBe("New conversation");
    expect(screen.getByTestId("new-conversation-hello").textContent).toBe(
      "Pick who you'd like to talk to, then say what you'd like done — or just press send.",
    );
    chooseShell();
    expect(shellChosen()).toBe(true);
    expect(pillLabel()).toBe("New shell");
    expect(screen.getByTestId("new-conversation-hello").textContent).toBe(
      "A terminal on one of your machines, with no agent in it.",
    );
    // No agent name in Shell: the pill doesn't rename.
    fireEvent.click(screen.getByTestId("pv-task-pill-open"));
    expect(queryNameInput()).toBeNull();
    chooseAgent();
    expect(shellChosen()).toBe(false);
    expect(screen.queryByLabelText(/^path$/i)).toBeNull();
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    expect(pillLabel()).toBe("New conversation");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test E / F: what each mode shows
// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: Test E — shell mode hides the agent fields", () => {
  it("Test E: choose Shell → roles list (and the cosmetic residue) absent", () => {
    renderDefault();
    chooseShell();
    expect(screen.queryByLabelText(/^task$/i)).toBeNull();
    expect(queryRolesGroup()).toBeNull();
    expect(screen.queryByLabelText(/^title$/i)).toBeNull();
    expect(screen.queryByLabelText(/^brief$/i)).toBeNull();
  });
});

describe("NewConversationPane: Test F — agent mode shows the roles", () => {
  it("Test F: default (agent mode) → roles list + the name in the pill (no tick-box); task and cosmetic controls absent", async () => {
    renderDefault();
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    expect(getRolesGroup()).toBeTruthy();
    // The name is the pill; no tick-box in front of it.
    expect(screen.getByTestId("pv-task-pill-label")).toBeTruthy();
    expect(screen.queryByLabelText(/choose a custom agent name/i)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // Several machines, nothing picked yet: the compose box says to pick a role.
    expect(composeText().placeholder).toBe("Pick a role above first…");
    expect(roleGroupHeaders()).toEqual(["alpha", "bravo", "charlie"]);
    // The task field was removed (birth sends a placeholder).
    expect(screen.queryByLabelText(/^task$/i)).toBeNull();
    expect(screen.queryByLabelText(/^title$/i)).toBeNull();
    expect(screen.queryByLabelText(/^brief$/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^generate$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /upload avatar/i })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests G-K2: name + role + host, name validation, collision precheck
// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: Test G — name + role + host enables Start", () => {
  it("Test G: pick a role from alpha, name it → Start enabled", async () => {
    renderDefault();
    await pickRoleFromAlpha();
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    expect(nameValue()).toBe("alicia");
  });
});

describe("NewConversationPane: Test H — unslugifiable name disables Start + shows error", () => {
  it("Test H: name='🎉🎉🎉' → inline error 'at least one letter'; Start disabled", async () => {
    renderDefault();
    await pickRoleFromAlpha();
    typeName("🎉🎉🎉");
    expect(startButton().disabled).toBe(true);
    expect(nameErrorText()).toMatch(/at least one letter/i);
  });
});

describe("NewConversationPane: Test I — collision in the app blocks Start", () => {
  it("Test I: listIdentities returns matching key → 'Already exists in Takoyaki' + Start disabled", async () => {
    mockListIdentities.mockResolvedValue([
      { identityKey: "alicia", displayName: "Alicia", title: null, colorHue: null, voice: null,
        role: null, avatarMime: "", avatarUrl: "", avatarEtag: "", coordinator: false },
    ]);
    mockGetIdentityExistsOnHost.mockResolvedValue(false);
    renderDefault();
    await pickRoleFromAlpha();
    typeName("alicia");
    // Debounce (300ms) + async collision checks.
    await waitFor(() => expect(nameErrorText()).toMatch(/already exists in takoyaki/i), { timeout: 2000 });
    expect(startButton().disabled).toBe(true);
    mockListIdentities.mockResolvedValue([]);
  });
});

describe("NewConversationPane: Test J — host collision blocks Start", () => {
  it("Test J: getIdentityExistsOnHost returns true → 'Already exists on <hostname>' + Start disabled", async () => {
    mockListIdentities.mockResolvedValue([]);
    mockGetIdentityExistsOnHost.mockResolvedValue(true);
    renderDefault();
    await pickRoleFromAlpha();
    typeName("new-agent");
    await waitFor(() => expect(nameErrorText()).toBe("Already exists on alpha"), { timeout: 2000 });
    expect(startButton().disabled).toBe(true);
    mockGetIdentityExistsOnHost.mockResolvedValue(false);
  });
});

describe("NewConversationPane: Test K — collision clears when name changes", () => {
  it("Test K: after collision, rename to a unique one → error clears", async () => {
    mockListIdentities
      .mockResolvedValueOnce([
        { identityKey: "alicia", displayName: "Alicia", title: null, colorHue: null,
          voice: null, role: null, avatarMime: "", avatarUrl: "", avatarEtag: "", coordinator: false },
      ])
      .mockResolvedValue([]);
    mockGetIdentityExistsOnHost.mockResolvedValue(false);
    renderDefault();
    await pickRoleFromAlpha();
    typeName("alicia");
    await waitFor(() => expect(nameErrorText()).toMatch(/already exists in takoyaki/i), { timeout: 2000 });
    typeName("alicia2");
    await waitFor(() => expect(nameErrorText()).toBeNull(), { timeout: 2000 });
  });
});

// The host arrives with the role pick; a typed name is re-checked whenever
// the host changes. (The dialog also let a name be typed before any role; the
// pill only renames once a machine is picked, so that half is gone.)
describe("NewConversationPane: Test K2 — collision precheck follows the role's host", () => {
  it("Test K2: name typed on alpha → checked on h1; switch to bravo's role → re-checked on h2", async () => {
    mockListIdentities.mockResolvedValue([]);
    mockGetIdentityExistsOnHost.mockImplementation(async (hostId: unknown) => hostId === "h2");
    renderDefault();
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    // No host yet → a typed name has nothing to be checked against.
    typeName("new-agent");
    await new Promise((r) => setTimeout(r, 350));
    expect(mockGetIdentityExistsOnHost).not.toHaveBeenCalled();

    toggleRole("box-maintainer", "h1");
    await waitFor(() => expect(pickedRoleValues()).toEqual(["h1/box-maintainer"]));
    typeName("new-agent");
    await waitFor(
      () => expect(mockGetIdentityExistsOnHost).toHaveBeenCalledWith("h1", "new-agent"),
      { timeout: 2000 },
    );
    expect(nameErrorText()).toBeNull();

    toggleRole("box-maintainer", "h2");
    await waitFor(
      () => expect(mockGetIdentityExistsOnHost).toHaveBeenCalledWith("h2", "new-agent"),
      { timeout: 2000 },
    );
    await waitFor(() => expect(nameErrorText()).toMatch(/already exists on/i));
    mockGetIdentityExistsOnHost.mockResolvedValue(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test R: the started() payload for an agent
// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: Test R — started() payload for an agent", () => {
  it("Test R: start a valid agent → started({kind:'agent', host, name, project}) after a successful birth; name comes from the ended event, NOT the typed name", async () => {
    mockListIdentities.mockResolvedValue([]);
    mockGetIdentityExistsOnHost.mockResolvedValue(false);
    // The user types "alicia" but the server derives the folder + session
    // name ("alicia-box-maintainer-2"). started() must carry the DERIVED name.
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([
      { type: "ended", ok: true, identityId: "alicia-box-maintainer-2", sessionName: "alicia-box-maintainer-2" },
    ]));
    const pane = renderDefault();
    await fillIdentityForm();
    fireEvent.click(startButton());
    await waitFor(() => expect(pane.started).toHaveBeenCalledTimes(1));
    const [tabId, what] = pane.started.mock.calls[0];
    expect(tabId).toBe(TAB_ID);
    expect(what).toEqual({
      kind: "agent",
      host: expect.objectContaining({ id: "h1", name: "alpha" }),
      name: "alicia-box-maintainer-2",
      project: null,
    });
    expect(pane.close).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test S / GG: shell mode
// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: Test S — started() payload for a shell", () => {
  it("Test S: choose Shell, pick bravo, start → started({kind:'shell', host, path}) with no agent fields", () => {
    const pane = renderDefault();
    chooseShell();
    fireEvent.click(screen.getByText("bravo"));
    fireEvent.click(startButton());
    expect(pane.started).toHaveBeenCalledTimes(1);
    const what = pane.started.mock.calls[0][1];
    expect(what.kind).toBe("shell");
    expect(what.path).toBeDefined();
    expect(what.host).toBeDefined();
    expect(what.name).toBeUndefined();
    expect(what.title).toBeUndefined();
  });
});

describe("NewConversationPane: Test GG — shell mode does NOT call openBirthStream", () => {
  it("Test GG: choose Shell, start → openBirthStream NOT called; started() with kind:'shell'", () => {
    const pane = renderDefault();
    chooseShell();
    fireEvent.click(screen.getByText("bravo"));
    fireEvent.click(startButton());
    expect(mockOpenBirthStream).not.toHaveBeenCalled();
    expect(pane.started).toHaveBeenCalledTimes(1);
    expect(pane.started.mock.calls[0][1].kind).toBe("shell");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test V: the birth request
// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: Test V — Start for an agent calls openBirthStream", () => {
  it("Test V: Start calls openBirthStream with the right request (no cosmetic fields)", async () => {
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([]));
    renderDefault();
    await fillIdentityForm();
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    // A typed name goes on the wire as `displayName`; `name` is the
    // suggested-name path.
    expect(payload).toMatchObject({
      hostId: expect.anything(),
      displayName: "alicia",
      role: "box-maintainer",
    });
    expect(payload.name).toBeUndefined();
    expect(payload.title).toBeUndefined();
    expect(payload.avatarCandidateId).toBeUndefined();
    expect(payload.colorHue).toBeNull();
    expect(payload.voice).toBeNull();
    expect(payload).not.toHaveProperty("identityMode");
    expect(payload).not.toHaveProperty("sessionName");
  });
});

// The dialog's Enter-in-the-name-field submit is now Enter in the compose box
// (Enter in the pill's rename field just commits the name).
describe("NewConversationPane: Enter", () => {
  it("Enter in the compose box starts like the main button", async () => {
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([]));
    renderDefault();
    await fillIdentityForm();
    pressEnterInCompose();
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    expect(mockOpenBirthStream.mock.calls[0][0]).toMatchObject({ displayName: "alicia" });
  });

  it("Enter in the Name field doesn't start", async () => {
    renderDefault();
    await pickRoleFromAlpha();
    const input = openRename();
    fireEvent.change(input, { target: { value: "alicia" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(nameValue()).toBe("alicia");
    expect(mockOpenBirthStream).not.toHaveBeenCalled();
  });

  it("Enter does nothing while Start is disabled (no role picked)", () => {
    renderDefault();
    pressEnterInCompose();
    expect(mockOpenBirthStream).not.toHaveBeenCalled();
  });
});

describe("NewConversationPane: born into a project", () => {
  it("project pick → birth request carries the project slug", async () => {
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([]));
    // The fixture ids aren't numeric, so the project's machine (1) narrows
    // nothing here — see the pane suite for the narrowing itself.
    renderDefault({ picks: { project: { slug: "ops", hostId: 1 } } });
    await fillIdentityForm();
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.project).toBe("ops");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Starting: busy, success chain, failure
// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: Test 106A — Start shows a spinner while starting", () => {
  it("Test 106A: while the birth stream is open, the main button is busy (spinner, 'Starting the conversation')", async () => {
    const hanging = hangingStream();
    mockOpenBirthStream.mockReturnValueOnce(hanging.stream);
    renderDefault();
    await fillIdentityForm();
    const btn = startButton();
    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute("aria-label")).toBe("Starting the conversation"));
    expect(btn.querySelector("svg")).toBeTruthy();
    expect(btn.disabled).toBe(true);
    hanging.release();
  });
});

describe("NewConversationPane: Test 106B — the pane is locked while starting", () => {
  it("Test 106B: while starting → Start disabled, the mode switch, the roles and the name can't change, menu items disabled", async () => {
    const hanging = hangingStream();
    mockOpenBirthStream.mockReturnValueOnce(hanging.stream);
    const pane = renderDefault();
    await fillIdentityForm();
    const btn = startButton();
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    // A second Enter can't start twice.
    pressEnterInCompose();
    expect(mockOpenBirthStream).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("new-session-mode-shell") as HTMLButtonElement).disabled).toBe(true);
    // The name can't change mid-birth.
    expect(queryNameInput()!.disabled).toBe(true);
    toggleRole("box-maintainer", "h2");
    expect(pickedRoleValues()).toEqual(["h1/box-maintainer"]);
    expect(pane.close).not.toHaveBeenCalled();
    hanging.release();
  });
});

describe("NewConversationPane: Test 106C — success: refreshOneIdentity, then started()", () => {
  it("Test 106C: on ended:ok:true, refreshOneIdentity is called BEFORE started(); started() carries the agent", async () => {
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([
      { type: "ended", ok: true, identityId: "alicia", sessionName: "alicia" },
    ]));
    const pane = renderDefault();
    await fillIdentityForm();
    fireEvent.click(startButton());
    await waitFor(() => expect(pane.started).toHaveBeenCalledTimes(1));
    // The newborn alone is fetched, by name + host.
    expect(mockRefreshOneIdentity).toHaveBeenCalledWith("alicia", expect.any(Number));
    expect(mockRefreshOneIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      pane.started.mock.invocationCallOrder[0],
    );
    expect(pane.started.mock.calls[0][1]).toEqual(
      expect.objectContaining({ kind: "agent", name: "alicia" }),
    );
    expect(pane.close).not.toHaveBeenCalled();
  });
});

describe("NewConversationPane: Test 106D — ended:ok:false keeps the pane with a failure line", () => {
  it("Test 106D: on ended:ok:false, the failure line shows, started() does NOT fire, no kit alert, the picks stay", async () => {
    const dialogs = autoAnswerKitDialogs();
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([
      { type: "ended", ok: false, failedStep: 6, reason: "supervisor_wait_timeout" },
    ]));
    const pane = renderDefault();
    await fillIdentityForm();
    fireEvent.click(startButton());
    await waitFor(() => expect(screen.getByTestId("new-conversation-failure")).toBeTruthy());
    expect(screen.getByTestId("new-conversation-failure").textContent).toMatch(/couldn't create the agent/i);
    expect(pane.started).not.toHaveBeenCalled();
    expect(pane.close).not.toHaveBeenCalled();
    expect(dialogs.calls).toHaveLength(0);
    expect(pickedRoleValues()).toEqual(["h1/box-maintainer"]);
    expect(nameValue()).toBe("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
  });
});

describe("NewConversationPane: Test 106E — a stream throw is the same failure", () => {
  it("Test 106E: openBirthStream throwing → the same failure line; started() does NOT fire", async () => {
    const dialogs = autoAnswerKitDialogs();
    async function* throwingStream(): AsyncGenerator<never> {
      throw new Error("Network error");
      // eslint-disable-next-line no-unreachable
      yield {} as never;
    }
    mockOpenBirthStream.mockReturnValueOnce(throwingStream());
    const pane = renderDefault();
    await fillIdentityForm();
    fireEvent.click(startButton());
    await waitFor(() =>
      expect(screen.getByTestId("new-conversation-failure").textContent).toMatch(/couldn't create the agent/i),
    );
    expect(pane.started).not.toHaveBeenCalled();
    expect(pane.close).not.toHaveBeenCalled();
    expect(dialogs.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin gate + the agent's path on the wire
// ─────────────────────────────────────────────────────────────────────────────
describe("NewConversationPane: admin gate + backend path substitution", () => {
  it("T1: isAdmin=false → no Path input AND no Agent / Shell switch, nor any other way to a shell", async () => {
    renderPane({ hostTree: threeHostTree, isAdmin: false });
    expect(screen.queryByLabelText(/^path$/i)).toBeNull();
    expect(queryModeSwitch()).toBeNull();
    expect(screen.queryByTestId("new-session-mode-shell")).toBeNull();
    expect(screen.queryByTestId("new-session-mode-agent")).toBeNull();
    expect(screen.queryByRole("button", { name: /^shell$/i })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /just a shell/i })).toBeNull();
    expect(screen.queryByText(/a terminal on one of your machines/i)).toBeNull();
    expect(screen.queryByLabelText(/search hosts/i)).toBeNull();
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
  });

  it("T1-b: a non-admin whose picks say shell still gets an agent", async () => {
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([]));
    const pane = renderPane({ hostTree: oneHostTree, isAdmin: false, picks: { shell: true } });
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    expect(pillLabel()).toBe("New conversation");
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    expect(pane.started.mock.calls.every((c) => c[1].kind !== "shell")).toBe(true);
  });

  it("T1b: non-admin with one machine never sees the switch, and Start births an agent", async () => {
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([]));
    const pane = renderPane({ hostTree: oneHostTree, isAdmin: false });
    await waitFor(() => expect(queryRolesGroup()).toBeTruthy());
    expect(queryModeSwitch()).toBeNull();
    typeName("alicia");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    expect(pane.started.mock.calls.every((c) => c[1].kind !== "shell")).toBe(true);
  });

  it("T2: isAdmin=true → the switch is on Agent AND no Path field (agent mode default)", () => {
    renderDefault({ isAdmin: true });
    expect(screen.queryByLabelText(/^path$/i)).toBeNull();
    expect(queryModeSwitch()).toBeTruthy();
    expect(shellChosen()).toBe(false);
  });

  it("T3: a non-admin's birth sends path:'' — the server fills in the workspace", async () => {
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([]));
    renderPane({ hostTree: threeHostTree, isAdmin: false });
    await fillIdentityForm();
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.path).toBe("");
    expect(payload.displayName).toBe("alicia");
  });

  it("T4: an admin's agent birth sends path:'' too (never normalizePath's '~')", async () => {
    mockOpenBirthStream.mockReturnValueOnce(createMockStream([]));
    renderDefault({ isAdmin: true });
    await fillIdentityForm();
    expect(screen.queryByLabelText(/^path$/i)).toBeNull();
    expect(startButton().disabled).toBe(false);
    fireEvent.click(startButton());
    await waitFor(() => expect(mockOpenBirthStream).toHaveBeenCalledTimes(1));
    const [payload] = mockOpenBirthStream.mock.calls[0] as [Record<string, unknown>];
    expect(payload.path).toBe("");
  });
});
