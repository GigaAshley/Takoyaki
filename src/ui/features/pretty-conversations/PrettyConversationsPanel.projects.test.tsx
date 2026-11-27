/**
 * Phase 117 Plan 117-08 Task 2 — PrettyConversationsPanel projects zone.
 *
 * Behavior surface (see 117-08-PLAN.md <behavior> Task 2):
 *   Test 1  — project sections render BETWEEN pinned zone and flat middle (D-09)
 *   Test 2  — "Projects" super-header wraps the project sections
 *   Test 3  — empty project section renders as header-only (D-11) + still droppable
 *   Test 4  — collapse state hides rows; click header calls toggle
 *   Test 5  — create-project header button exists + click opens placeholder modal
 *   Test 6  — drop on project section (identity row) → setSessionProject(hostId, key, slug)
 *   Test 7  — drop on project section (relay-room row) → setRelayRoomProject(roomId, mxid, slug)
 *   Test 8  — drop on flat middle clears identity row's project (D-22 gesture #2)
 *   Test 9  — drop on flat middle on unassigned row is a no-op
 *   Test 10 — RDP row drop refused (D-08 defense-in-depth at panel handleProjectDrop)
 *   Test 11 — project sections rendered in the derived-selector order (regression guard)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  fireEvent,
  createEvent,
  cleanup,
  screen,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// jsdom does not implement ResizeObserver; stub it so Radix's DropdownMenu
// (used by RowKebabMenu, which backs the project section header's kebab)
// doesn't throw when the portal mounts.
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// shape-sidebar-header-affordances: helper to open a project section header's
// kebab menu and click an item by name. Factored out because the old test
// pattern (fireEvent.contextMenu(header) + fireEvent.click(getByText(...)))
// no longer applies — right-click is retired on sidebar surfaces.
async function openProjectKebabAndClickItem(
  container: HTMLElement,
  slug: string,
  itemName: string,
): Promise<void> {
  const user = userEvent.setup();
  const trigger = container.querySelector(
    `[data-testid="pv-project-section-kebab-trigger-${slug}"]`,
  ) as HTMLElement | null;
  if (!trigger) {
    throw new Error(`kebab trigger not found for slug: ${slug}`);
  }
  await user.click(trigger);
  const item = screen.getByRole("menuitem", { name: itemName });
  await user.click(item);
}

// shape-sidebar-header-affordances task 6: helper to open a ROW's kebab menu
// (scoped to a specific row body) and click an item by name/regex. Parallel
// to openProjectKebabAndClickItem (which operates on section headers).
async function openRowKebabInBodyAndClickItem(
  body: HTMLElement,
  itemName: string | RegExp,
): Promise<void> {
  const user = userEvent.setup();
  const trigger = body.querySelector(
    '[data-testid="pv-row-kebab-trigger"]',
  ) as HTMLElement | null;
  if (!trigger) throw new Error("row kebab trigger not found in body");
  await user.click(trigger);
  const item = screen.getByRole("menuitem", { name: itemName });
  await user.click(item);
}

async function openRowKebabInBody(body: HTMLElement): Promise<HTMLElement> {
  const user = userEvent.setup();
  const trigger = body.querySelector(
    '[data-testid="pv-row-kebab-trigger"]',
  ) as HTMLElement | null;
  if (!trigger) throw new Error("row kebab trigger not found in body");
  await user.click(trigger);
  return screen.getByRole("menu");
}

import type { Host, HostFolder } from "@/types/ui-types";
import {
  autoAnswerKitDialogs,
  __resetKitDialogsForTests,
  type KitAlertOptions,
  type KitConfirmOptions,
  type KitPromptOptions,
} from "@/components/kit";

// ─── Global mocks ─────────────────────────────────────────────────────────────

// Archive confirms look up the agent's wake-ups first (default: none).
vi.mock("@/shell/archive-wakeup-check", async (o) =>
  (await import("@/shell/archive-wakeup-check.test-mocks")).archiveWakeupCheck(o),
);
beforeEach(() => resetWakeupCheckMock());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
    i18n: { language: "en", changeLanguage: () => Promise.resolve() },
  }),
}));

vi.mock("@/features/terminal/session-hue", () => ({
  sessionMatchKey: (name: string | null | undefined) =>
    name ? name.toLowerCase() : null,
}));

const refreshIdentitiesSpy = vi.fn(async (_extra?: Record<string, number>) => true);

// Pin is offered only on identity rows; pin tests seed the identity here.
let mockIdentitiesByKey = new Map<string, { identityKey: string }>();
vi.mock("@/state/identities-store", () => ({
  useIdentities: () => ({
    byKey: mockIdentitiesByKey,
    byHostKey: new Map(),
    identities: [],
    loaded: true,
    refresh: async () => {},
  }),
  deriveDiskPinnedIds: () => [],
  buildIdentityHostsFromFleet: () => ({}),
  applyIdentityChange: () => {},
  refreshIdentities: (extra?: Record<string, number>) =>
    refreshIdentitiesSpy(extra),
}));

vi.mock("@/state/trapped-work-store", () => ({
  useTrappedWork: () => undefined,
  startTrappedWorkPoller: () => () => {},
}));

vi.mock("@/hooks/use-is-touch-device", () => ({
  useIsTouchDevice: () => false,
}));

// ─── conversation-store mock — including the new derived-selector fields ────
type MockRow = {
  id: string;
  type: string;
  label: string;
  host?: Host | undefined;
  targetTmuxSession: string | null;
  fleetOnly?: boolean;
  rdpHostRow?: boolean;
  kind?: "harness" | "relay-room";
  roomId?: string;
  roomTitle?: string | null;
  unread?: boolean;
  dm?: boolean;
};

type MockGroup = {
  hostId: string;
  hostName: string;
  rows: MockRow[];
};

type MockSnapshot = {
  activeSet: MockRow[];
  pinned: MockRow[];
  middle: MockRow[];
  rdpGroup: MockGroup | null;
  pinnedUnassigned: MockRow[];
  projectSections: Array<{
    slug: string;
    hostId?: string;
    displayName: string;
    rows: MockRow[];
    parentKey?: string | null;
  }>;
  rdp: MockGroup | null;
  selectedId: string | null;
  pinnedIds: ReadonlySet<string>;
};

let snapshot: MockSnapshot = {
  activeSet: [],
  pinned: [],
  middle: [],
  rdpGroup: null,
  pinnedUnassigned: [],
  projectSections: [],
  rdp: null,
  selectedId: null,
  pinnedIds: new Set(),
};

function setSnapshot(next: Partial<MockSnapshot>): void {
  snapshot = {
    activeSet: next.activeSet ?? [],
    pinned: next.pinned ?? [],
    middle: next.middle ?? [],
    rdpGroup: next.rdpGroup ?? null,
    pinnedUnassigned: next.pinnedUnassigned ?? [],
    projectSections: next.projectSections ?? [],
    rdp: next.rdp ?? null,
    selectedId: next.selectedId ?? null,
    pinnedIds: next.pinnedIds ?? new Set(),
  };
}

// ProjectRow snapshot for useProjects() — the create-project button is
// state-only in this plan; the modal itself lands in 117-09. useProjects
// is consumed by the panel but never mutated in these tests.
let mockProjects: readonly {
  slug: string;
  displayName: string;
  hostId: string;
  hostname: string;
  archived: boolean;
}[] = [];

const selectConversationSpy = vi.fn();
const addToActiveSetSpy = vi.fn();
const removeFromActiveSetSpy = vi.fn();
const pinConversationSpy = vi.fn();
const unpinConversationSpy = vi.fn();
const hydratePinnedIdsFromServerSpy = vi.fn();

let mockActiveSet: ReadonlySet<string> = new Set();
const mergeProjectsForHostSpy = vi.fn<(hostId: string, rows: unknown[]) => void>();
let mockFleetSessionsLoaded = true;
const patchRoomPinnedSpy = vi.fn<(roomId: string, pinned: boolean) => void>();
let mockRoomPinnedIds: ReadonlySet<string> = new Set();

vi.mock("@/state/conversation-store", () => ({
  upsertFleetSession: () => {},
  patchRoomProjectAssignment: () => () => {},
  patchRoomPinned: (roomId: string, pinned: boolean) => {
    patchRoomPinnedSpy(roomId, pinned);
    return () => {};
  },
  useRoomPinnedIds: () => mockRoomPinnedIds,
  markPendingArchive: () => {},
  clearPendingArchive: () => {},
  removeFleetSession: () => {},
  useConversations: () => ({
    activeSet: snapshot.activeSet,
    pinned: snapshot.pinned,
    middle: snapshot.middle,
    rdpGroup: snapshot.rdpGroup,
    pinnedUnassigned: snapshot.pinnedUnassigned,
    projectSections: snapshot.projectSections,
    rdp: snapshot.rdp,
  }),
  useSelectedConversationId: () => snapshot.selectedId,
  usePinnedIds: () => snapshot.pinnedIds,
  useActiveSet: () => mockActiveSet,
  useFleetSessionsLoaded: () => mockFleetSessionsLoaded,
  getFleetSessionsSnapshot: () => [],
  useProjects: () => mockProjects,
  getProjectsSnapshot: () => mockProjects,
  mergeProjectsForHost: (hostId: string, rows: typeof mockProjects) => {
    mergeProjectsForHostSpy(hostId, rows);
    mockProjects = [...mockProjects.filter((p) => p.hostId !== hostId), ...rows];
  },
  selectConversation: (id: string | null) => selectConversationSpy(id),
  pinConversation: (id: string) => pinConversationSpy(id),
  unpinConversation: (id: string) => unpinConversationSpy(id),
  addToActiveSet: (id: string) => addToActiveSetSpy(id),
  removeFromActiveSet: (id: string) => removeFromActiveSetSpy(id),
  fleetRowId: (hostId: number, sessionName: string) =>
    `fleet::${hostId}::${sessionName}`,
  hydratePinnedIdsFromServer: (ids: string[]) =>
    hydratePinnedIdsFromServerSpy(ids),
}));

// use-collapsed-project-slugs mock — flexible per-test via mockCollapsed.
let mockCollapsed: Set<string> = new Set();
const toggleSpy = vi.fn((slug: string) => {
  if (mockCollapsed.has(slug)) mockCollapsed.delete(slug);
  else mockCollapsed.add(slug);
});
vi.mock("@/state/use-collapsed-project-slugs", () => ({
  useCollapsedProjectSlugs: () => ({
    collapsed: mockCollapsed as ReadonlySet<string>,
    toggle: toggleSpy,
  }),
}));

// session-project-api mocks
const setSessionProjectSpy = vi.fn<
  (hostId: number, key: string, slug: string | null) => Promise<{ ok: true }>
>(async () => ({ ok: true as const }));
const setRelayRoomPinnedSpy = vi.fn<
  (roomId: string, mxid: string, pinned: boolean) => Promise<{ ok: true }>
>(async () => ({ ok: true as const }));
const setRelayRoomProjectSpy = vi.fn<
  (roomId: string, mxid: string, slug: string | null) => Promise<{ ok: true }>
>(async () => ({ ok: true as const }));
vi.mock("@/api/session-project-api", () => ({
  setSessionProject: (hostId: number, key: string, slug: string | null) =>
    setSessionProjectSpy(hostId, key, slug),
  setRelayRoomProject: (roomId: string, mxid: string, slug: string | null) =>
    setRelayRoomProjectSpy(roomId, mxid, slug),
  setRelayRoomPinned: (roomId: string, mxid: string, pinned: boolean) =>
    setRelayRoomPinnedSpy(roomId, mxid, pinned),
}));

// Phase 117 Plan 117-09 — project-list-api mock. The CreateProjectModal
// (117-09 Task 1) imports createProject from this module; the modal only
// fires the API on Submit-click, so tests that never click Submit see no
// spy invocations. Stubbed to a successful envelope so any incidental
// click path lands cleanly.
const createProjectSpy = vi.fn<
  (hostId: number, displayName: string) => Promise<{ ok: true; slug: string }>
>(async (_hostId, name) => ({
  ok: true as const,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
}));
// What the machine says a project holds (archive preflight) — per test.
type Contents = {
  project: string;
  projects: Array<{ slug: string; displayName: string; parent: string | null }>;
  agents: Array<{ name: string; displayName: string; task: string; project: string }>;
  apps: Array<{ slug: string; title: string; project: string }>;
};
const contentsOf = (slug: string, agents: string[] = [], apps: Array<[string, string]> = []): Contents => ({
  project: slug,
  projects: [{ slug, displayName: slug, parent: null }],
  agents: agents.map((name) => ({ name, displayName: name, task: "", project: slug })),
  apps: apps.map(([a, title]) => ({ slug: a, title, project: slug })),
});
let mockPreflightRooms: Array<{ roomId: string; project: string }> = [];
let mockContents: (slug: string) => Contents = (slug) => contentsOf(slug);
const getArchivePreflightSpy = vi.fn(async (_hostId: number, slug: string) => ({
  done: true as const,
  requestId: "pre-1",
  result: { hiddenSubProjects: 0, contents: mockContents(slug), rooms: mockPreflightRooms, roomsUnknown: false },
}));
const archiveProjectSpy = vi.fn<
  (hostId: number, slug: string, expected: { projects: string[]; agents: string[]; apps: string[] }) => Promise<unknown>
>(async () => ({ done: true as const, requestId: "arch-1", result: { ok: true } }));
const getProjectFileSpy = vi.fn<
  (hostId: number, slug: string) => Promise<{ markdown: string }>
>(async () => ({ markdown: "---\ndisplayName: Alpha\n---\n" }));
const updateProjectFileSpy = vi.fn<
  (hostId: number, slug: string, contents: string) => Promise<{ markdown: string }>
>(async (_h, _s, contents) => ({ markdown: contents }));
vi.mock("@/api/project-list-api", () => ({
  createProject: (hostId: number, displayName: string) =>
    createProjectSpy(hostId, displayName),
  archiveProject: (hostId: number, slug: string, expected: { projects: string[]; agents: string[]; apps: string[] }) =>
    archiveProjectSpy(hostId, slug, expected),
  expectedFromContents: (c: Contents) => ({
    projects: c.projects.map((p) => p.slug),
    agents: c.agents.map((a) => a.name),
    apps: c.apps.map((a) => a.slug),
  }),
  getArchivePreflight: (hostId: number, slug: string) =>
    getArchivePreflightSpy(hostId, slug),
  getProjectFile: (hostId: number, slug: string) =>
    getProjectFileSpy(hostId, slug),
  updateProjectFile: (hostId: number, slug: string, contents: string) =>
    updateProjectFileSpy(hostId, slug, contents),
  listProjects: vi.fn(async () => ({ projects: [] })),
  listRelayRoomProjectTags: vi.fn(async () => ({ assignments: [] })),
}));

// viewing-user-store mock — panel-level handleProjectDrop uses userMxid for
// the relay-room path.
vi.mock("@/state/viewing-user-store", () => ({
  useViewingUserMxid: vi.fn(() => "@user:matrix.example"),
  useViewingUserId: vi.fn(() => "u-user"),
}));

vi.mock("@/api/user-preferences-api", () => ({
  putPinnedIds: vi.fn().mockResolvedValue([]),
  setIdentityPinned: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/api/identity-archive-api", () => ({
  archiveIdentity: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/api/user-management-api", () => ({
  getUsersListBasic: vi.fn(async () => []),
}));
vi.mock("@/api/relay-room-create-api", () => ({
  createRelayRoom: vi.fn(async () => ({
    ok: true,
    roomId: "!r:s",
    sessionId: "s1",
    roomTitle: "T",
  })),
}));

vi.mock("@/state/session-working-store", () => ({
  useSessionIsWorking: () => false,
  useSessionLastMessageAt: () => null,
  getSessionLastMessageAt: () => null,
  subscribeSessionWorkingStore: () => () => {},
  useSessionAiTitle: () => null,
  getSessionWorkingSnapshot: () => new Map(),
  useSessionIsDormant: () => false,
  useSessionIsCondensing: () => false,
}));

vi.mock("@/state/session-queue-pending-store", () => ({
  useSessionQueuePending: () => false,
}));

// Phase 137 D-29: GlobalFilesModal retired — mock removed.

vi.mock("@/features/pretty-view/SkillsEditorModal", () => ({
  default: () => null,
}));

vi.mock("@/features/pretty-view/roles-window/RolesWindow", () => ({
  RolesWindow: () => null,
}));

vi.mock("@/api/global-files-api", () => ({
  listGlobalFiles: vi.fn().mockResolvedValue([]),
  readGlobalFile: vi.fn().mockResolvedValue({ content: "", mtime: 0, size: 0 }),
  writeGlobalFile: vi.fn().mockResolvedValue({ mtime: 0 }),
  GlobalFileMtimeConflictError: class GlobalFileMtimeConflictError extends Error {},
}));

// ─── Component under test ───────────────────────────────────────────────────

import { PrettyConversationsPanel } from "./PrettyConversationsPanel";
import { MachineChangeError } from "@/api/machine-changes-api";
import { resetWakeupCheckMock, wakeupCheckMock } from "@/shell/archive-wakeup-check.test-mocks";

// ─── Fixture helpers ────────────────────────────────────────────────────────

function makeHost(id: string, name: string, overrides: Partial<Host> = {}): Host {
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

function makeRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: "row-x",
    type: "terminal",
    label: "session-x",
    host: makeHost("1", "hostA"),
    targetTmuxSession: null,
    ...overrides,
  };
}

const HOST_TREE: HostFolder = {
  name: "root",
  children: [makeHost("1", "hostA")],
};

// DataTransfer stub — mirrors the shape in PrettyProjectSectionHeader.test.tsx.
function makeDataTransferStub(entries: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(entries));
  return {
    setData: (type: string, value: string) => {
      store.set(type, value);
    },
    getData: (type: string) => store.get(type) ?? "",
    effectAllowed: "none" as string,
    get types() {
      return Array.from(store.keys());
    },
  };
}

function dispatchDragOverAt(
  el: Element,
  clientX: number,
  clientY: number,
  dt: ReturnType<typeof makeDataTransferStub>,
): void {
  const evt = createEvent.dragOver(el, { dataTransfer: dt });
  Object.defineProperty(evt, "clientX", { value: clientX, configurable: true });
  Object.defineProperty(evt, "clientY", { value: clientY, configurable: true });
  fireEvent(el, evt);
}

function dispatchDrop(
  el: Element,
  dt: ReturnType<typeof makeDataTransferStub>,
): void {
  const evt = createEvent.drop(el, { dataTransfer: dt });
  fireEvent(el, evt);
}

beforeEach(() => {
  mockIdentitiesByKey = new Map();
  cleanup();
  vi.clearAllMocks();
  setSnapshot({});
  mockCollapsed = new Set();
  mockProjects = [];
  mockActiveSet = new Set();
  mockRoomPinnedIds = new Set();
  mockFleetSessionsLoaded = true;
  localStorage.removeItem("pv-projects-section-collapsed");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — project sections render BETWEEN pinned zone and flat middle (D-09)
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: projects zone position (D-09)", () => {
  it("Test 1: project sections render between pinned zone and flat middle", () => {
    const hostA = makeHost("1", "hostA");
    const rowPinned = makeRow({
      id: "pinned-1",
      label: "pinned-row",
      host: hostA,
      targetTmuxSession: "pinned-sess",
    });
    const rowAlpha = makeRow({
      id: "alpha-1",
      label: "alpha-row",
      host: hostA,
      targetTmuxSession: "alpha-sess",
    });
    const rowMiddle = makeRow({
      id: "middle-1",
      label: "middle-row",
      host: hostA,
      targetTmuxSession: "middle-sess",
    });
    setSnapshot({
      pinned: [rowPinned],
      pinnedUnassigned: [rowPinned],
      projectSections: [
        { slug: "alpha", displayName: "Alpha", rows: [rowAlpha] },
      ],
      middle: [rowMiddle],
      pinnedIds: new Set(["pinned-1"]),
    });
    mockProjects = [
      {
        slug: "alpha",
        displayName: "Alpha",
        hostId: "1",
        hostname: "hostA",
        archived: false,
      },
    ];

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    // Rows should appear in DOM order: pinned → project section → middle.
    const pinnedRow = container.querySelector('[data-conversation-id="pinned-1"]');
    const alphaSection = container.querySelector('[data-testid="pv-project-section-alpha"]');
    const middleRow = container.querySelector('[data-conversation-id="middle-1"]');
    expect(pinnedRow).not.toBeNull();
    expect(alphaSection).not.toBeNull();
    expect(middleRow).not.toBeNull();

    // Compare by DocumentPosition — pinned BEFORE alpha section BEFORE middle.
    const posAlpha = pinnedRow!.compareDocumentPosition(alphaSection!);
    expect(posAlpha & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const posMiddle = alphaSection!.compareDocumentPosition(middleRow!);
    expect(posMiddle & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — "Projects" super-header wraps the project sections
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: 'Projects' super-header", () => {
  it("Test 2: a 'Projects' super-header wraps every project section", () => {
    const hostA = makeHost("1", "hostA");
    const rowA = makeRow({
      id: "a-1",
      host: hostA,
      targetTmuxSession: "a-sess",
    });
    const rowB = makeRow({
      id: "b-1",
      host: hostA,
      targetTmuxSession: "b-sess",
    });
    setSnapshot({
      projectSections: [
        { slug: "alpha", displayName: "Alpha", rows: [rowA] },
        { slug: "beta", displayName: "Beta", rows: [rowB] },
      ],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
      { slug: "beta", displayName: "Beta", hostId: "1", hostname: "hostA", archived: false },
    ];

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    // Both individual project section headers exist.
    expect(container.querySelector('[data-testid="pv-project-section-header-alpha"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pv-project-section-header-beta"]')).not.toBeNull();

    // A "Projects" super-header wraps every project section, indented beneath it.
    const superSection = container.querySelector('[data-testid="pv-projects-super-section"]') as HTMLElement;
    expect(superSection).not.toBeNull();
    const superHeader = container.querySelector('[data-testid="pv-projects-super-header"]') as HTMLElement;
    expect(superHeader.querySelector(".pv-section-label")!.textContent!.trim()).toBe("Projects");
    expect(superSection.querySelector('[data-testid="pv-project-section-header-alpha"]')).not.toBeNull();
    expect(superSection.querySelector('[data-testid="pv-project-section-header-beta"]')).not.toBeNull();
  });
});

describe("PrettyConversationsPanel: 'Projects' super-header new-project button", () => {
  it("Test 2b: the super-header renders with zero projects, and its '+' opens the create-project modal", async () => {
    setSnapshot({ projectSections: [] });
    mockProjects = [];
    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
    expect(container.querySelector('[data-testid="pv-projects-super-header"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pv-header-create-project-button"]')).toBeNull();
    const plus = container.querySelector('[data-testid="pv-projects-new-project-button"]') as HTMLButtonElement;
    expect(plus.getAttribute("aria-label")).toBe("New project");
    fireEvent.click(plus);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });
});

describe("PrettyConversationsPanel: 'Projects' super-header collapse", () => {
  function seedAlpha() {
    const hostA = makeHost("1", "hostA");
    const rowA = makeRow({ id: "alpha-row", label: "needle-session", host: hostA, targetTmuxSession: "a-sess" });
    setSnapshot({ projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [rowA] }] });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];
  }
  function renderPanel() {
    return render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
  }
  const sectionSel = '[data-testid="pv-project-section-header-alpha"]';
  const headerSel = '[data-testid="pv-projects-super-header"]';

  it("Test 2c: expanded by default; clicking the header hides every project and persists", () => {
    seedAlpha();
    const { container } = renderPanel();
    const header = container.querySelector(headerSel) as HTMLElement;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(sectionSel)).not.toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(sectionSel)).toBeNull();
    expect(localStorage.getItem("pv-projects-section-collapsed")).toBe("1");

    fireEvent.keyDown(header, { key: "Enter" });
    expect(container.querySelector(sectionSel)).not.toBeNull();
    expect(localStorage.getItem("pv-projects-section-collapsed")).toBeNull();
  });

  it("Test 2d: the '+' button does not toggle the section", () => {
    seedAlpha();
    const { container } = renderPanel();
    fireEvent.click(container.querySelector('[data-testid="pv-projects-new-project-button"]') as HTMLElement);
    expect(container.querySelector(sectionSel)).not.toBeNull();
    expect(localStorage.getItem("pv-projects-section-collapsed")).toBeNull();
  });

  it("Test 2e: collapsed state hydrates from storage and force-expands during a sidebar search", () => {
    localStorage.setItem("pv-projects-section-collapsed", "1");
    seedAlpha();
    const { container } = renderPanel();
    expect(container.querySelector(sectionSel)).toBeNull();

    const searchInput = container.querySelector('[data-testid="pv-sidebar-search-input"]') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "needle" } });
    expect(container.querySelector(sectionSel)).not.toBeNull();

    fireEvent.change(searchInput, { target: { value: "" } });
    expect(container.querySelector(sectionSel)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 — empty project section renders as header-only (D-11) + still droppable
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: empty projects visible (D-11)", () => {
  it("Test 3: empty project section renders header-only; section wrapper is droppable", () => {
    setSnapshot({
      projectSections: [
        { slug: "empty", displayName: "Empty", rows: [] },
      ],
    });
    mockProjects = [
      { slug: "empty", displayName: "Empty", hostId: "1", hostname: "hostA", archived: false },
    ];

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const section = container.querySelector('[data-testid="pv-project-section-empty"]');
    expect(section).not.toBeNull();
    // Header exists (it's inside section).
    expect(container.querySelector('[data-testid="pv-project-section-header-empty"]')).not.toBeNull();
    // No rows inside (the section rendered no children rows).
    const rowsRegion = section!.querySelector('#pv-project-section-content-empty');
    // rowsRegion may be empty div — but its content should have no PrettyConversationRow elements.
    if (rowsRegion) {
      expect(rowsRegion.querySelectorAll('[data-conversation-id]').length).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4 — collapse state hides rows; click header calls toggle
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: collapse state (D-13)", () => {
  it("Test 4: collapsed slug hides rows; header click fires toggle(slug)", () => {
    const hostA = makeHost("1", "hostA");
    const rowA = makeRow({ id: "alpha-row", host: hostA, targetTmuxSession: "a-sess" });
    setSnapshot({
      projectSections: [
        { slug: "alpha", displayName: "Alpha", rows: [rowA] },
      ],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];
    mockCollapsed = new Set(["alpha"]);

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    // Rows NOT in DOM inside the collapsed section.
    const section = container.querySelector('[data-testid="pv-project-section-alpha"]');
    expect(section).not.toBeNull();
    expect(section!.querySelector('[data-conversation-id="alpha-row"]')).toBeNull();

    // Click header → toggle called with the host-scoped key; the bare-slug
    // entry migrates to it.
    const header = container.querySelector('[data-testid="pv-project-section-header-alpha"]') as HTMLElement;
    fireEvent.click(header);
    expect(toggleSpy).toHaveBeenCalledWith("::alpha", { legacy: "alpha", keys: ["::alpha"] });
  });

  it("Test 4b: user-collapsed project force-expands when sidebar search is active and has matches", async () => {
    const hostA = makeHost("1", "hostA");
    const rowA = makeRow({ id: "alpha-row", label: "needle-session", host: hostA, targetTmuxSession: "a-sess" });
    setSnapshot({
      projectSections: [
        { slug: "alpha", displayName: "Alpha", rows: [rowA] },
      ],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];
    mockCollapsed = new Set(["alpha"]);

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    // Baseline: collapsed section hides the row.
    const section = container.querySelector('[data-testid="pv-project-section-alpha"]');
    expect(section).not.toBeNull();
    expect(section!.querySelector('[data-conversation-id="alpha-row"]')).toBeNull();

    // Type into the sidebar search — matches the row's label.
    const searchInput = container.querySelector('[data-testid="pv-sidebar-search-input"]') as HTMLInputElement;
    expect(searchInput).not.toBeNull();
    fireEvent.change(searchInput, { target: { value: "needle" } });

    // The matching row is now visible even though the project is still
    // marked collapsed in the persisted collapse set.
    expect(mockCollapsed.has("alpha")).toBe(true);
    const sectionAfter = container.querySelector('[data-testid="pv-project-section-alpha"]');
    expect(sectionAfter).not.toBeNull();
    expect(sectionAfter!.querySelector('[data-conversation-id="alpha-row"]')).not.toBeNull();

    // Clearing the query restores the collapsed view.
    fireEvent.change(searchInput, { target: { value: "" } });
    const sectionCleared = container.querySelector('[data-testid="pv-project-section-alpha"]');
    expect(sectionCleared!.querySelector('[data-conversation-id="alpha-row"]')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5 — create-project header button opens placeholder modal
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: create-project header button", () => {
  it("Test 5: 'Create project' button in header cluster; click toggles modal state (placeholder visible)", () => {
    const { getByLabelText, queryByTestId } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
    // Placeholder modal NOT visible before click.
    expect(queryByTestId("create-project-modal-placeholder")).toBeNull();
    // Click the header create-project button.
    const btn = getByLabelText("New project");
    fireEvent.click(btn);
    // Placeholder modal visible (state toggled to true).
    expect(queryByTestId("create-project-modal-placeholder")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6 — drop on project section (identity row) → setSessionProject
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: project drop (identity row)", () => {
  it("Test 6: drop on project section fires setSessionProject(hostId, key, slug)", () => {
    setSnapshot({
      projectSections: [
        { slug: "alpha", displayName: "Alpha", rows: [] },
      ],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const section = container.querySelector('[data-testid="pv-project-section-alpha"]') as HTMLElement;
    expect(section).not.toBeNull();

    const payload = {
      id: "wren-row",
      host: { id: "1" },
      targetTmuxSession: "wren-session",
      identityKey: "wren",
      rdpHostRow: false,
    };
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify(payload),
    });
    dispatchDragOverAt(section, 200, 200, dt);
    dispatchDrop(section, dt);

    expect(setSessionProjectSpy).toHaveBeenCalledTimes(1);
    expect(setSessionProjectSpy).toHaveBeenCalledWith(1, "wren", "alpha");
    expect(setRelayRoomProjectSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7 — drop on project section (relay-room row) → setRelayRoomProject
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: project drop (relay-room row)", () => {
  it("Test 7: drop on project section fires setRelayRoomProject(roomId, mxid, slug)", () => {
    setSnapshot({
      projectSections: [
        { slug: "alpha", displayName: "Alpha", rows: [] },
      ],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const section = container.querySelector('[data-testid="pv-project-section-alpha"]') as HTMLElement;
    const payload = {
      id: "relay-row-1",
      matrixRoomId: "!abc:matrix.example",
      rdpHostRow: false,
    };
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify(payload),
    });
    dispatchDragOverAt(section, 200, 200, dt);
    dispatchDrop(section, dt);

    expect(setRelayRoomProjectSpy).toHaveBeenCalledTimes(1);
    expect(setRelayRoomProjectSpy).toHaveBeenCalledWith(
      "!abc:matrix.example",
      "@user:matrix.example",
      "alpha",
    );
    expect(setSessionProjectSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8 — drop on flat middle clears identity row's project (D-22 gesture #2)
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: flat-middle clear-project (D-22 gesture #2)", () => {
  it("Test 8: drop on flat middle for row currently in a project fires setSessionProject(host, key, null)", async () => {
    const hostA = makeHost("1", "hostA");
    const alphaRow = makeRow({
      id: "in-alpha",
      host: hostA,
      targetTmuxSession: "wren-session",
    });
    const middleRow = makeRow({
      id: "in-middle",
      host: hostA,
      targetTmuxSession: "other-session",
    });
    setSnapshot({
      middle: [middleRow],
      projectSections: [
        { slug: "alpha", displayName: "Alpha", rows: [alphaRow] },
      ],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const flatMiddle = container.querySelector('[data-middle-group="true"]') as HTMLElement;
    expect(flatMiddle).not.toBeNull();

    // Drop the alphaRow's payload on the flat middle → should clear.
    const payload = {
      id: "in-alpha",
      host: { id: "1" },
      targetTmuxSession: "wren-session",
      identityKey: "wren",
      rdpHostRow: false,
    };
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify(payload),
    });
    dispatchDragOverAt(flatMiddle, 100, 100, dt);
    dispatchDrop(flatMiddle, dt);

    expect(setSessionProjectSpy).toHaveBeenCalledTimes(1);
    expect(setSessionProjectSpy).toHaveBeenCalledWith(1, "wren", null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9 — drop on flat middle for unassigned row is a no-op
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: flat-middle no-op on unassigned", () => {
  it("Test 9: drop of a row NOT in any project on flat middle is a no-op", () => {
    const hostA = makeHost("1", "hostA");
    const middleRow = makeRow({
      id: "in-middle",
      host: hostA,
      targetTmuxSession: "other-session",
    });
    setSnapshot({
      middle: [middleRow],
      projectSections: [], // no projects → no possible current assignment
    });

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const flatMiddle = container.querySelector('[data-middle-group="true"]') as HTMLElement;
    expect(flatMiddle).not.toBeNull();

    const payload = {
      id: "in-middle",
      host: { id: "1" },
      targetTmuxSession: "other-session",
      identityKey: "other",
      rdpHostRow: false,
    };
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify(payload),
    });
    dispatchDragOverAt(flatMiddle, 100, 100, dt);
    dispatchDrop(flatMiddle, dt);

    // Row is not in any project section → clear is a no-op.
    expect(setSessionProjectSpy).not.toHaveBeenCalled();
    expect(setRelayRoomProjectSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10 — RDP row drop refused (D-08 defense-in-depth)
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: RDP drop refused (D-08)", () => {
  it("Test 10: dropping an RDP row (rdpHostRow=true) on a project section is refused", () => {
    setSnapshot({
      projectSections: [
        { slug: "alpha", displayName: "Alpha", rows: [] },
      ],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const section = container.querySelector('[data-testid="pv-project-section-alpha"]') as HTMLElement;
    const payload = {
      id: "rdp-1",
      rdpHostRow: true,
    };
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify(payload),
    });
    dispatchDragOverAt(section, 200, 200, dt);
    dispatchDrop(section, dt);

    expect(setSessionProjectSpy).not.toHaveBeenCalled();
    expect(setRelayRoomProjectSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 11 (117-09 Task 1) — CreateProjectModal is wired to the header button
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: CreateProjectModal wire (117-09 Task 1)", () => {
  it("Test 11: clicking Create project button renders the real CreateProjectModal (data-testid='create-project-modal')", () => {
    const { getByLabelText, queryByTestId } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
    // Real modal not visible before click.
    expect(queryByTestId("create-project-modal")).toBeNull();
    fireEvent.click(getByLabelText("New project"));
    // Real modal now visible (data-testid matches CreateProjectModal.tsx).
    expect(queryByTestId("create-project-modal")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pin-drop parity tests (2026-09-23) — Pinned zone is a drop target for the
// pin gesture, flat middle also unpins on drop. Mirrors the project-drop
// gesture pair (drop on section = assign; drop on flat middle = clear).
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: pin-drop on Pinned zone", () => {
  it("PinDrop-1: drop unpinned row on Pinned zone fires pinConversation with shadowFleetId", () => {
    mockIdentitiesByKey = new Map([["wren-session", { identityKey: "wren-session" }]]);
    const hostA = makeHost("1", "hostA");
    const middleRow = makeRow({
      id: "wren-row",
      host: hostA,
      targetTmuxSession: "wren-session",
    });
    setSnapshot({
      middle: [middleRow],
      pinnedIds: new Set(),
    });

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const pinnedZone = container.querySelector('[data-pinned-group="true"]') as HTMLElement;
    expect(pinnedZone).not.toBeNull();

    const payload = {
      id: "wren-row",
      host: { id: "1" },
      targetTmuxSession: "wren-session",
      identityKey: "wren",
      rdpHostRow: false,
    };
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify(payload),
    });
    dispatchDragOverAt(pinnedZone, 100, 20, dt);
    dispatchDrop(pinnedZone, dt);

    expect(pinConversationSpy).toHaveBeenCalledTimes(1);
    // The mocked fleetRowId returns `fleet::${hostId}::${sessionName}`.
    expect(pinConversationSpy).toHaveBeenCalledWith("fleet::1::wren-session");
    expect(unpinConversationSpy).not.toHaveBeenCalled();
  });

  it("PinDrop-1b: dropping a non-identity row on Pinned zone does NOT pin", () => {
    mockIdentitiesByKey = new Map();
    const hostA = makeHost("1", "hostA");
    setSnapshot({
      middle: [makeRow({ id: "plain-row", host: hostA, targetTmuxSession: "plain-shell" })],
      pinnedIds: new Set(),
    });
    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
    const pinnedZone = container.querySelector('[data-pinned-group="true"]') as HTMLElement;
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify({
        id: "plain-row",
        host: { id: "1" },
        targetTmuxSession: "plain-shell",
        rdpHostRow: false,
      }),
    });
    dispatchDragOverAt(pinnedZone, 100, 20, dt);
    dispatchDrop(pinnedZone, dt);
    expect(pinConversationSpy).not.toHaveBeenCalled();
  });

  it("PinDrop-2: drop already-pinned row (via shadow id) on Pinned zone is a no-op", () => {
    const hostA = makeHost("1", "hostA");
    const pinnedRow = makeRow({
      id: "wren-row",
      host: hostA,
      targetTmuxSession: "wren-session",
    });
    setSnapshot({
      pinned: [pinnedRow],
      pinnedUnassigned: [pinnedRow],
      pinnedIds: new Set(["fleet::1::wren-session"]),
    });

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const pinnedZone = container.querySelector('[data-pinned-group="true"]') as HTMLElement;
    const payload = {
      id: "wren-row",
      host: { id: "1" },
      targetTmuxSession: "wren-session",
      identityKey: "wren",
      rdpHostRow: false,
    };
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify(payload),
    });
    dispatchDragOverAt(pinnedZone, 100, 20, dt);
    dispatchDrop(pinnedZone, dt);

    expect(pinConversationSpy).not.toHaveBeenCalled();
    expect(unpinConversationSpy).not.toHaveBeenCalled();
  });

  it("PinDrop-3: drop of RDP row (rdpHostRow=true) on Pinned zone is refused (D-08)", () => {
    setSnapshot({});
    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const pinnedZone = container.querySelector('[data-pinned-group="true"]') as HTMLElement;
    const payload = { id: "rdp-1", rdpHostRow: true };
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify(payload),
    });
    dispatchDragOverAt(pinnedZone, 100, 20, dt);
    dispatchDrop(pinnedZone, dt);

    expect(pinConversationSpy).not.toHaveBeenCalled();
  });

  it("PinDrop-4: Pinned zone renders empty-state placeholder when nothing is pinned", () => {
    setSnapshot({});
    const { container, getByTestId } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    // Header + empty-state placeholder both render even when displayedPinned is empty.
    expect(container.querySelector('[data-testid="pretty-conversations-pinned-header"]')).not.toBeNull();
    const emptyLine = getByTestId("pretty-conversations-pinned-empty");
    expect(emptyLine.textContent).toContain("Drag a conversation here to pin");
  });
});

describe("PrettyConversationsPanel: unpin-drop on flat middle", () => {
  it("UnpinDrop-1: drop pinned-via-shadow row on flat middle fires unpinConversation on shadow id", () => {
    const hostA = makeHost("1", "hostA");
    const pinnedRow = makeRow({
      id: "wren-row",
      host: hostA,
      targetTmuxSession: "wren-session",
    });
    const middleRow = makeRow({
      id: "other-row",
      host: hostA,
      targetTmuxSession: "other-session",
    });
    setSnapshot({
      pinned: [pinnedRow],
      pinnedUnassigned: [pinnedRow],
      middle: [middleRow],
      pinnedIds: new Set(["fleet::1::wren-session"]),
    });

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const flatMiddle = container.querySelector('[data-middle-group="true"]') as HTMLElement;
    expect(flatMiddle).not.toBeNull();

    const payload = {
      id: "wren-row",
      host: { id: "1" },
      targetTmuxSession: "wren-session",
      identityKey: "wren",
      rdpHostRow: false,
    };
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify(payload),
    });
    dispatchDragOverAt(flatMiddle, 100, 100, dt);
    dispatchDrop(flatMiddle, dt);

    expect(unpinConversationSpy).toHaveBeenCalledTimes(1);
    expect(unpinConversationSpy).toHaveBeenCalledWith("fleet::1::wren-session");
    // Row was not in any project → project clear is a no-op branch.
    expect(setSessionProjectSpy).not.toHaveBeenCalled();
  });

  it("UnpinDrop-2: drop pinned-via-openTab row on flat middle fires unpinConversation on openTab id", () => {
    const hostA = makeHost("1", "hostA");
    const pinnedRow = makeRow({
      id: "wren-row",
      host: hostA,
      targetTmuxSession: "wren-session",
    });
    const filler = makeRow({
      id: "filler-row",
      host: hostA,
      targetTmuxSession: "filler-session",
    });
    setSnapshot({
      pinned: [pinnedRow],
      pinnedUnassigned: [pinnedRow],
      middle: [filler], // flat-middle wrapper only renders when non-empty
      pinnedIds: new Set(["wren-row"]), // pinned via openTab id, not shadow
    });

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const flatMiddle = container.querySelector('[data-middle-group="true"]') as HTMLElement;
    const payload = {
      id: "wren-row",
      host: { id: "1" },
      targetTmuxSession: "wren-session",
      identityKey: "wren",
      rdpHostRow: false,
    };
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify(payload),
    });
    dispatchDragOverAt(flatMiddle, 100, 100, dt);
    dispatchDrop(flatMiddle, dt);

    expect(unpinConversationSpy).toHaveBeenCalledTimes(1);
    expect(unpinConversationSpy).toHaveBeenCalledWith("wren-row");
  });

  it("UnpinDrop-3: drop pinned row that is ALSO in a project on flat middle fires BOTH unpin and clear-project", () => {
    const hostA = makeHost("1", "hostA");
    const alphaPinnedRow = makeRow({
      id: "wren-row",
      host: hostA,
      targetTmuxSession: "wren-session",
    });
    setSnapshot({
      pinned: [alphaPinnedRow],
      projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [alphaPinnedRow] }],
      middle: [],
      pinnedIds: new Set(["fleet::1::wren-session"]),
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const flatMiddle = container.querySelector('[data-middle-group="true"]') as HTMLElement;
    const payload = {
      id: "wren-row",
      host: { id: "1" },
      targetTmuxSession: "wren-session",
      identityKey: "wren",
      rdpHostRow: false,
    };
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify(payload),
    });
    dispatchDragOverAt(flatMiddle, 100, 100, dt);
    dispatchDrop(flatMiddle, dt);

    expect(unpinConversationSpy).toHaveBeenCalledWith("fleet::1::wren-session");
    expect(setSessionProjectSpy).toHaveBeenCalledWith(1, "wren", null);
  });

  it("UnpinDrop-4: drop of unpinned non-project row on flat middle remains a no-op (regression guard)", () => {
    const hostA = makeHost("1", "hostA");
    const middleRow = makeRow({
      id: "other-row",
      host: hostA,
      targetTmuxSession: "other-session",
    });
    setSnapshot({
      middle: [middleRow],
      pinnedIds: new Set(),
    });

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const flatMiddle = container.querySelector('[data-middle-group="true"]') as HTMLElement;
    const payload = {
      id: "other-row",
      host: { id: "1" },
      targetTmuxSession: "other-session",
      identityKey: "other",
      rdpHostRow: false,
    };
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify(payload),
    });
    dispatchDragOverAt(flatMiddle, 100, 100, dt);
    dispatchDrop(flatMiddle, dt);

    expect(unpinConversationSpy).not.toHaveBeenCalled();
    expect(setSessionProjectSpy).not.toHaveBeenCalled();
    expect(setRelayRoomProjectSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 117-09 Task 2 — archive-project cascade + section context menu + new-conv wire
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: archive-project cascade (117-09 Task 2)", () => {
  // A9 — kit dialogs (kitConfirm / kitPrompt / kitAlert) are auto-answered
  // per test; tests set confirmAnswer / promptAnswer before clicking.
  let dialogs: ReturnType<typeof autoAnswerKitDialogs>;
  let confirmAnswer = false;
  let promptAnswer: string | null = null;
  const kitCalls = (kind: "confirm" | "prompt" | "alert") =>
    dialogs.calls.filter((c) => c.kind === kind).map((c) => c.opts);
  beforeEach(() => {
    confirmAnswer = false;
    promptAnswer = null;
    mockContents = (slug) => contentsOf(slug);
    mockPreflightRooms = [];
    dialogs = autoAnswerKitDialogs({
      confirm: () => confirmAnswer,
      prompt: () => promptAnswer,
    });
  });
  afterEach(() => {
    __resetKitDialogsForTests();
  });

  const renderPanel = (onDeactivateRow: (r: unknown) => void = () => {}) =>
    render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={onDeactivateRow}
      />,
    );
  const settle = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const alpha = { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false };

  it("A9 Test 1 (confirm copy): names the project, counts the agents the machine says are in it, says it can't be undone", async () => {
    const hostA = makeHost("1", "hostA");
    setSnapshot({ projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [makeRow({ id: "in-alpha", host: hostA, targetTmuxSession: "wren" })] }] });
    mockProjects = [alpha];
    mockContents = (slug) => contentsOf(slug, ["wren"]);
    confirmAnswer = false;

    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "alpha", "Archive project");

    await waitFor(() => expect(kitCalls("confirm")).toHaveLength(1));
    expect(getArchivePreflightSpy).toHaveBeenCalledWith(1, "alpha");
    const opts = kitCalls("confirm")[0] as KitConfirmOptions;
    expect(opts.title).toBe('Archive "Alpha"?');
    expect(opts.body).toBe(
      "This also archives the 1 agent in it.\n\nThis can't be undone. Move conversations and apps out first to keep them.",
    );
    expect(opts.destructive).toBe(true);
  });

  it("A9 Test 1a (machine decides): an agent the sidebar doesn't show is counted; the apps are named", async () => {
    setSnapshot({ projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [] }] });
    mockProjects = [alpha];
    mockContents = (slug) => contentsOf(slug, ["unseen"], [["ai-spend", "AI Spend"], ["ai-cost", "AI Cost"]]);
    mockPreflightRooms = [{ roomId: "!abc:host", project: "alpha" }];
    confirmAnswer = false;

    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "alpha", "Archive project");

    await waitFor(() => expect(kitCalls("confirm")).toHaveLength(1));
    expect((kitCalls("confirm")[0] as KitConfirmOptions).body).toBe(
      "This also archives the 1 agent in it.\n\n" +
        'Its 2 apps "AI Spend" and "AI Cost" are archived with it.\n\n' +
        "1 relay room will move back to Conversations.\n\n" +
        "This can't be undone. Move conversations and apps out first to keep them.",
    );
    mockPreflightRooms = [];
  });

  it("A9 Test 1b (wake-ups): the confirm names the agents whose wake-ups would stop, and any it couldn't check", async () => {
    setSnapshot({ projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [] }] });
    mockProjects = [alpha];
    mockContents = (slug) => contentsOf(slug, ["wren", "sparrow", "finch"]);
    wakeupCheckMock.impl = async (_hostId, identityKey) =>
      identityKey === "wren"
        ? {
            status: "checked",
            active: [
              { slug: "a", name: "A", scheduleHuman: "Daily at 09:00" },
              { slug: "b", name: "B", scheduleHuman: "Every 2h" },
            ],
          }
        : identityKey === "finch"
          ? { status: "unknown", reason: "timeout" }
          : { status: "checked", active: [] };
    confirmAnswer = false;

    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "alpha", "Archive project");

    await waitFor(() => expect(kitCalls("confirm")).toHaveLength(1));
    expect(wakeupCheckMock.calls.map(([, k]) => k).sort()).toEqual(["finch", "sparrow", "wren"]);
    const opts = kitCalls("confirm")[0] as KitConfirmOptions;
    expect(opts.body).toBe(
      "This also archives the 3 agents in it.\n\n" +
        "1 of these agents has scheduled wake-ups that will stop: wren (2).\n\n" +
        "Couldn't check the scheduled wake-ups of finch — any they have will stop.\n\n" +
        "If this work should keep running, set it up as a scheduled conversation (clock icon) first.\n\n" +
        "This can't be undone. Move conversations and apps out first to keep them.",
    );
    expect(archiveProjectSpy).not.toHaveBeenCalled();
  });

  it("A9 Test 2 (one request): Archive sends the confirmed list to the machine; it, not the sidebar, archives the agents and rooms", async () => {
    const hostA = makeHost("1", "hostA");
    const relayRow = makeRow({ id: "relay-1", host: undefined, targetTmuxSession: null, kind: "relay-room", roomId: "!abc:host" });
    setSnapshot({
      projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [makeRow({ id: "r1", host: hostA, targetTmuxSession: "wren" }), relayRow] }],
    });
    mockProjects = [alpha];
    mockContents = (slug) => contentsOf(slug, ["wren", "sparrow"]);
    mockPreflightRooms = [{ roomId: "!abc:host", project: "alpha" }];
    confirmAnswer = true;

    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "alpha", "Archive project");
    await settle();

    expect(archiveProjectSpy).toHaveBeenCalledTimes(1);
    expect(archiveProjectSpy).toHaveBeenCalledWith(1, "alpha", { projects: ["alpha"], agents: ["wren", "sparrow"], apps: [] });
    const { archiveIdentity } = await import("@/api/identity-archive-api");
    expect(archiveIdentity).not.toHaveBeenCalled();
    expect(setRelayRoomProjectSpy).not.toHaveBeenCalled();
    // Shown archived at once: the project leaves this host's list.
    expect(mergeProjectsForHostSpy).toHaveBeenCalledWith("1", []);
    mockPreflightRooms = [];
  });

  it("A9 Test 2a (open member pane): archiving the project closes a member's open pane", async () => {
    const hostA = makeHost("1", "hostA");
    setSnapshot({
      projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [makeRow({ id: "r1", host: hostA, targetTmuxSession: "wren" }), makeRow({ id: "r2", host: hostA, targetTmuxSession: "sparrow" })] }],
    });
    mockProjects = [alpha];
    mockContents = (slug) => contentsOf(slug, ["wren", "sparrow"]);
    mockActiveSet = new Set(["r1"]);
    confirmAnswer = true;
    const onDeactivateRow = vi.fn();

    const { container } = renderPanel(onDeactivateRow);
    await openProjectKebabAndClickItem(container, "alpha", "Archive project");
    await settle();

    expect(onDeactivateRow).toHaveBeenCalledTimes(1);
    expect(onDeactivateRow).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }));
    expect(removeFromActiveSetSpy).toHaveBeenCalledWith("r1");
    mockActiveSet = new Set();
  });

  it("A9 Test 2b (refused): everything is put back and the machine's reason is shown", async () => {
    setSnapshot({ projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [] }] });
    mockProjects = [alpha];
    confirmAnswer = true;
    archiveProjectSpy.mockRejectedValueOnce(new MachineChangeError("that project doesn't exist or is already archived", 409, "not_found", null));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "alpha", "Archive project");
    await settle();

    await waitFor(() => expect(kitCalls("alert")).toHaveLength(1));
    expect(String((kitCalls("alert")[0] as KitAlertOptions).body)).toBe(
      "That project doesn't exist or is already archived. Nothing was archived.",
    );
    expect(mergeProjectsForHostSpy).toHaveBeenLastCalledWith("1", [alpha]);
    warnSpy.mockRestore();
  });

  it("A9 Test 3 (contents changed): the confirm shows what it holds now, and Archive sends that list", async () => {
    setSnapshot({ projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [] }] });
    mockProjects = [alpha];
    confirmAnswer = true;
    archiveProjectSpy.mockRejectedValueOnce(
      new MachineChangeError("what's in \"Alpha\" changed since you looked; check the list again", 409, "contents_changed", contentsOf("alpha", ["finch"])),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "alpha", "Archive project");
    await settle();

    await waitFor(() => expect(kitCalls("confirm")).toHaveLength(2));
    expect((kitCalls("confirm")[1] as KitConfirmOptions).body).toBe(
      'What\'s in "Alpha" changed since you looked. This is what it holds now.\n\n' +
        "This also archives the 1 agent in it.\n\n" +
        "This can't be undone. Move conversations and apps out first to keep them.",
    );
    await waitFor(() => expect(archiveProjectSpy).toHaveBeenCalledTimes(2));
    expect(archiveProjectSpy).toHaveBeenLastCalledWith(1, "alpha", { projects: ["alpha"], agents: ["finch"], apps: [] });
    expect(kitCalls("alert")).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("A9 Test 3a (machine busy): the check before the confirm says to try again; nothing is archived", async () => {
    setSnapshot({ projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [] }] });
    mockProjects = [alpha];
    getArchivePreflightSpy.mockResolvedValueOnce({ done: false, requestId: "pre-2" } as never);

    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "alpha", "Archive project");
    await settle();

    await waitFor(() => expect(kitCalls("alert")).toHaveLength(1));
    expect((kitCalls("alert")[0] as KitAlertOptions).title).toBe('Couldn\'t check "Alpha" yet');
    expect(kitCalls("confirm")).toHaveLength(0);
    expect(archiveProjectSpy).not.toHaveBeenCalled();
  });

  it("A9 Test 3b (same slug on two hosts): archiving host 2's section only asks host 2", async () => {
    const hostA = makeHost("1", "hostA");
    const hostB = makeHost("2", "hostB");
    setSnapshot({
      projectSections: [
        { slug: "ops", hostId: "1", displayName: "Ops", rows: [makeRow({ id: "rA", host: hostA, targetTmuxSession: "wren" })] },
        { slug: "ops", hostId: "2", displayName: "Ops", rows: [makeRow({ id: "rB", host: hostB, targetTmuxSession: "finch" })] },
      ],
    });
    mockProjects = [
      { slug: "ops", displayName: "Ops", hostId: "1", hostname: "hostA", archived: false },
      { slug: "ops", displayName: "Ops", hostId: "2", hostname: "hostB", archived: false },
    ];
    mockContents = (slug) => contentsOf(slug, ["finch"]);
    confirmAnswer = true;
    const { container } = renderPanel();
    const user = userEvent.setup();
    const triggers = container.querySelectorAll('[data-testid="pv-project-section-kebab-trigger-ops"]');
    expect(triggers).toHaveLength(2);
    await user.click(triggers[1] as HTMLElement);
    await user.click(screen.getByRole("menuitem", { name: "Archive project" }));
    await settle();

    expect(getArchivePreflightSpy).toHaveBeenCalledWith(2, "ops");
    expect(archiveProjectSpy).toHaveBeenCalledTimes(1);
    expect(archiveProjectSpy).toHaveBeenCalledWith(2, "ops", { projects: ["ops"], agents: ["finch"], apps: [] });
    expect(mergeProjectsForHostSpy).toHaveBeenCalledWith("2", []);
  });

  it("A9 Test 4 (cancel): user clicks Cancel in confirm → nothing sent", async () => {
    setSnapshot({ projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [] }] });
    mockProjects = [alpha];
    confirmAnswer = false;

    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "alpha", "Archive project");
    await waitFor(() => expect(kitCalls("confirm")).toHaveLength(1));
    await settle();

    expect(archiveProjectSpy).not.toHaveBeenCalled();
    expect(mergeProjectsForHostSpy).not.toHaveBeenCalled();
  });

  it("A9 Test 5 (empty project): the archive carries empty lists", async () => {
    setSnapshot({ projectSections: [{ slug: "empty", displayName: "Empty", rows: [] }] });
    mockProjects = [{ slug: "empty", displayName: "Empty", hostId: "1", hostname: "hostA", archived: false }];
    confirmAnswer = true;

    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "empty", "Archive project");
    await settle();

    expect(archiveProjectSpy).toHaveBeenCalledWith(1, "empty", { projects: ["empty"], agents: [], apps: [] });
  });

  // Phase 117 M7 fix (2026-09-18): if projectsList doesn't contain the slug,
  // never fall back to another host — log and return without asking anything.
  it("A9 Test 5a (M7 fix): project missing from projectsList → nothing asked or archived (defensive early-return, not host-fallback)", async () => {
    setSnapshot({ projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [] }] });
    mockProjects = [];
    confirmAnswer = true;
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "alpha", "Archive project");
    await settle();

    expect(getArchivePreflightSpy).not.toHaveBeenCalled();
    expect(archiveProjectSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "archive_project_skipped_no_host", slug: "alpha" }),
    );
    consoleWarnSpy.mockRestore();
  });

  it("A9 Test 6 (kebab menu items): project header kebab shows Edit project + New-conversation + Rename + Archive project", async () => {
    setSnapshot({
      projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [] }],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];

    const user = userEvent.setup();
    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
    const kebabTrigger = container.querySelector(
      '[data-testid="pv-project-section-kebab-trigger-alpha"]',
    ) as HTMLElement;
    await user.click(kebabTrigger);

    expect(screen.queryByRole("menuitem", { name: "New conversation in this project" })).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Rename project" })).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Edit project" })).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Edit project file" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Archive project" })).not.toBeNull();
  });

  it("A9 Test 6b (Edit project): opens the project modal against the project's own host", async () => {
    setSnapshot({
      projectSections: [{ slug: "alpha", displayName: "Alpha", hostId: "3", rows: [] }],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "3", hostname: "hostC", archived: false },
    ];
    getProjectFileSpy.mockResolvedValueOnce({ markdown: "# Alpha" });

    const user = userEvent.setup();
    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
    await user.click(
      container.querySelector('[data-testid="pv-project-section-kebab-trigger-alpha"]') as HTMLElement,
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit project" }));

    expect(await screen.findByTestId("project-modal")).toBeTruthy();
    await waitFor(() => expect(getProjectFileSpy).toHaveBeenCalledWith(3, "alpha"));
  });

  it("A9 Test 7 (Rename flow): prompt with current name → getProjectFile → PUT rewritten markdown", async () => {
    setSnapshot({
      projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [] }],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];
    getProjectFileSpy.mockResolvedValueOnce({
      markdown: "---\ndisplayName: Alpha\n---\n\n# body\n",
    });
    promptAnswer = "Bravo";

    const { container, getByText } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
    await openProjectKebabAndClickItem(container, "alpha", "Rename project");

    // prompt is seeded with the current displayName so the user can edit it.
    await waitFor(() => expect(kitCalls("prompt")).toHaveLength(1));
    const promptOpts = kitCalls("prompt")[0] as KitPromptOptions;
    expect(promptOpts.title).toBe("Rename project");
    expect(promptOpts.defaultValue).toBe("Alpha");
    // Over-length names are blocked in the field (formerly a window.alert).
    expect(promptOpts.validate?.("x".repeat(81))).toBe("Name must be 80 characters or fewer.");
    expect(promptOpts.validate?.("x".repeat(80))).toBeFalsy();

    // Await microtasks so the async handler's fetch + PUT complete.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(getProjectFileSpy).toHaveBeenCalledWith(1, "alpha");
    expect(updateProjectFileSpy).toHaveBeenCalledTimes(1);
    const [hostId, slug, contents] = updateProjectFileSpy.mock.calls[0];
    expect(hostId).toBe(1);
    expect(slug).toBe("alpha");
    expect(contents).toBe("---\ndisplayName: Bravo\n---\n\n# body\n");
  });

  it("A9 Test 8 (Rename cancel): prompt returns null → no PUT", async () => {
    setSnapshot({
      projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [] }],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];
    promptAnswer = null;

    const { container, getByText } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
    await openProjectKebabAndClickItem(container, "alpha", "Rename project");

    await waitFor(() => expect(kitCalls("prompt")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));

    expect(getProjectFileSpy).not.toHaveBeenCalled();
    expect(updateProjectFileSpy).not.toHaveBeenCalled();
  });

  it("A9 Test 9 (Rename empty / whitespace-only): no PUT", async () => {
    setSnapshot({
      projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [] }],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];
    promptAnswer = "   ";

    const { container, getByText } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
    await openProjectKebabAndClickItem(container, "alpha", "Rename project");

    await waitFor(() => expect(kitCalls("prompt")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));

    expect(updateProjectFileSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rewriteDisplayNameInFrontmatter helper — pure function tests
// ─────────────────────────────────────────────────────────────────────────────

describe("rewriteDisplayNameInFrontmatter", () => {
  it("swaps the displayName value when the key exists inside the fence", async () => {
    const { rewriteDisplayNameInFrontmatter } = await import(
      "./PrettyConversationsPanel"
    );
    const input = "---\ndisplayName: Alpha\nother: keep\n---\n\nbody\n";
    const out = rewriteDisplayNameInFrontmatter(input, "Bravo");
    expect(out).toBe("---\ndisplayName: Bravo\nother: keep\n---\n\nbody\n");
  });

  it("injects displayName into an existing fence when the key is absent", async () => {
    const { rewriteDisplayNameInFrontmatter } = await import(
      "./PrettyConversationsPanel"
    );
    const input = "---\nother: keep\n---\n\nbody\n";
    const out = rewriteDisplayNameInFrontmatter(input, "Bravo");
    expect(out).toBe("---\nother: keep\ndisplayName: Bravo\n---\n\nbody\n");
  });

  it("prepends a fresh fence when the file has no frontmatter", async () => {
    const { rewriteDisplayNameInFrontmatter } = await import(
      "./PrettyConversationsPanel"
    );
    const input = "just body\n";
    const out = rewriteDisplayNameInFrontmatter(input, "Bravo");
    expect(out).toBe("---\ndisplayName: Bravo\n---\njust body\n");
  });

  it("YAML-quotes values with colon / special chars", async () => {
    const { rewriteDisplayNameInFrontmatter } = await import(
      "./PrettyConversationsPanel"
    );
    const input = "---\ndisplayName: Alpha\n---\n";
    const out = rewriteDisplayNameInFrontmatter(input, "Team: East");
    expect(out).toBe('---\ndisplayName: "Team: East"\n---\n');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A9 Test 9 — a project's "New conversation in this project" asks AppShell for
// a new-conversation pane born into that project, on the project's machine
// (onNewConversation(start, "project")). The pane narrows its machine list to
// the project's machine and sends the project in the birth request, so the
// panel no longer tags the newborn itself (setSessionProject) — those wires
// are the pane's now.
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: new-conversation-in-project wire", () => {
  it("Test 9: kebab 'New conversation in this project' calls onNewConversation with the project and its machine", async () => {
    setSnapshot({
      projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [] }],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];
    const onNewConversation = vi.fn();

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={onNewConversation}
        onDeactivateRow={() => {}}
      />,
    );
    const kebabTrigger = container.querySelector('[data-testid="pv-project-section-kebab-trigger-alpha"]') as HTMLElement;
    expect(kebabTrigger).not.toBeNull();
    await openProjectKebabAndClickItem(container, "alpha", "New conversation in this project");

    expect(onNewConversation).toHaveBeenCalledTimes(1);
    expect(onNewConversation).toHaveBeenCalledWith({ project: { slug: "alpha", hostId: 1 }, hostId: 1 }, "project");
    // The panel no longer tags the newborn — the birth request carries the project.
    expect(setSessionProjectSpy).not.toHaveBeenCalled();
  });

  it("Test 9g: in a multi-host fleet the start names the project's own machine (the pane narrows to it)", async () => {
    setSnapshot({
      projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [] }],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "2", hostname: "hostB", archived: false },
    ];
    const multiHostTree: HostFolder = {
      name: "root",
      children: [makeHost("1", "hostA"), makeHost("2", "hostB")],
    };
    const onNewConversation = vi.fn();

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={multiHostTree}
        onNewConversation={onNewConversation}
        onDeactivateRow={() => {}}
      />,
    );
    await openProjectKebabAndClickItem(container, "alpha", "New conversation in this project");

    expect(onNewConversation).toHaveBeenCalledWith({ project: { slug: "alpha", hostId: 2 }, hostId: 2 }, "project");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 12 — project sections rendered in selector order (regression guard)
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: project sections preserve selector order", () => {
  it("Test 11: DOM order matches the derived selector's projectSections order", () => {
    setSnapshot({
      projectSections: [
        { slug: "aaa", displayName: "AAA", rows: [] },
        { slug: "mmm", displayName: "MMM", rows: [] },
        { slug: "zzz", displayName: "ZZZ", rows: [] },
      ],
    });
    mockProjects = [
      { slug: "aaa", displayName: "AAA", hostId: "1", hostname: "hostA", archived: false },
      { slug: "mmm", displayName: "MMM", hostId: "1", hostname: "hostA", archived: false },
      { slug: "zzz", displayName: "ZZZ", hostId: "1", hostname: "hostA", archived: false },
    ];

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const aaa = container.querySelector('[data-testid="pv-project-section-aaa"]');
    const mmm = container.querySelector('[data-testid="pv-project-section-mmm"]');
    const zzz = container.querySelector('[data-testid="pv-project-section-zzz"]');
    expect(aaa).not.toBeNull();
    expect(mmm).not.toBeNull();
    expect(zzz).not.toBeNull();
    // Order: aaa → mmm → zzz.
    expect(aaa!.compareDocumentPosition(mmm!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mmm!.compareDocumentPosition(zzz!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M-J: flat-middle section header — the "Conversations" section is a
// permanent sidebar fixture. Wrapper + header always
// render; when the middle is empty a placeholder row communicates emptiness.
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: flat-middle section header (M-J)", () => {
  it("Test 12 (M-J): renders 'Conversations' header above flat middle when middle is non-empty", () => {
    const middleRow = makeRow({ id: "middle-1", label: "flat-1" });
    setSnapshot({
      middle: [middleRow],
    });

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const header = container.querySelector('[data-testid="pv-flat-middle-section-header"]');
    expect(header).not.toBeNull();
    expect(header!.textContent).toMatch(/conversations/i);
    // Empty-state placeholder should NOT appear when the middle has rows.
    expect(
      container.querySelector('[data-testid="pv-flat-middle-empty"]'),
    ).toBeNull();
  });

  it("Test 12b (M-J): header + empty-state placeholder render when flat middle has no rows", () => {
    // Section is now a permanent fixture even on an empty middle with no
    // projects — the header labels the zone and a placeholder row signals
    // emptiness.
    setSnapshot({
      middle: [],
    });

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    // Wrapper, header, and empty-state placeholder all render.
    expect(
      container.querySelector('[data-testid="pv-panel-flat-middle"]'),
    ).not.toBeNull();
    const header = container.querySelector(
      '[data-testid="pv-flat-middle-section-header"]',
    );
    expect(header).not.toBeNull();
    expect(header!.textContent).toMatch(/conversations/i);
    expect(
      container.querySelector('[data-testid="pv-flat-middle-empty"]'),
    ).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Move-to context menu — per-row host filtering
// ─────────────────────────────────────────────────────────────────────────────
//
// The "Move to" drill-in submenu (Pinned + projects; renamed from "Move to
// project" when pinned and in-a-project became mutually exclusive) must list only projects that live on
// the row's host for IDENTITY rows: projects live under a specific host's
// ~/fleet/projects/ tree (D-01), and setSessionProject writes to that host's
// identity file. Offering a cross-host project would fire
// setSessionProject(rowHostId, key, foreign-slug) which the writer can't
// satisfy — the project directory doesn't exist on the row's host.
//
// RELAY-ROOM rows are cross-host by design (the setRelayRoomProject payload
// has no hostId), so their submenu keeps the full projects list.

describe("PrettyConversationsPanel: Move-to host filtering", () => {
  it("identity row on host 1 sees only host-1 projects in the drill-in submenu", async () => {
    const hostA = makeHost("1", "hostA");
    const identityRow = makeRow({
      id: "id-row-a",
      host: hostA,
      targetTmuxSession: "wren-session",
    });
    setSnapshot({
      middle: [identityRow],
      projectSections: [
        { slug: "alpha", displayName: "Alpha", rows: [] },
        { slug: "beta", displayName: "Beta", rows: [] },
      ],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
      { slug: "beta", displayName: "Beta", hostId: "2", hostname: "hostB", archived: false },
    ];

    const HOST_TREE_MULTI: HostFolder = {
      name: "root",
      children: [makeHost("1", "hostA"), makeHost("2", "hostB")],
    };

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE_MULTI}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const rowWrapper = container.querySelector(
      '[data-conversation-id="id-row-a"]',
    ) as HTMLElement;
    expect(rowWrapper).not.toBeNull();
    const body = rowWrapper.querySelector('[role="button"]') as HTMLElement;
    await openRowKebabInBody(body);

    const menu = screen.getByRole("menu");
    await userEvent.setup().click(
      within(menu).getByRole("menuitem", { name: /^move to$/i }),
    );

    // Alpha (host 1) present; Beta (host 2) filtered out.
    // Radix renders the submenu in a SEPARATE portal, so use screen (global)
    // not within(menu) to query.
    expect(
      screen.queryByRole("menuitem", { name: /^Alpha$/ }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /^Beta$/ }),
    ).toBeNull();
  });

  it("identity row on host 2 sees only host-2 projects in the drill-in submenu (symmetric case)", async () => {
    const hostB = makeHost("2", "hostB");
    const identityRow = makeRow({
      id: "id-row-b",
      host: hostB,
      targetTmuxSession: "quill-session",
    });
    setSnapshot({
      middle: [identityRow],
      projectSections: [
        { slug: "alpha", displayName: "Alpha", rows: [] },
        { slug: "beta", displayName: "Beta", rows: [] },
      ],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
      { slug: "beta", displayName: "Beta", hostId: "2", hostname: "hostB", archived: false },
    ];

    const HOST_TREE_MULTI: HostFolder = {
      name: "root",
      children: [makeHost("1", "hostA"), makeHost("2", "hostB")],
    };

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE_MULTI}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const rowWrapper = container.querySelector(
      '[data-conversation-id="id-row-b"]',
    ) as HTMLElement;
    const body = rowWrapper.querySelector('[role="button"]') as HTMLElement;
    await openRowKebabInBody(body);
    const menu = screen.getByRole("menu");
    await userEvent.setup().click(
      within(menu).getByRole("menuitem", { name: /^move to$/i }),
    );

    // Submenu lives in a separate Radix portal — query via screen (global).
    expect(
      screen.queryByRole("menuitem", { name: /^Beta$/ }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /^Alpha$/ }),
    ).toBeNull();
  });

  it("identity row on a host with zero projects offers no project destinations in the 'Move to' submenu (hide-not-grey)", async () => {
    const hostZ = makeHost("9", "hostZ");
    const identityRow = makeRow({
      id: "id-row-z",
      host: hostZ,
      targetTmuxSession: "sess-z",
    });
    setSnapshot({
      middle: [identityRow],
      projectSections: [
        { slug: "alpha", displayName: "Alpha", rows: [] },
      ],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];

    const HOST_TREE_MULTI: HostFolder = {
      name: "root",
      children: [makeHost("1", "hostA"), hostZ],
    };

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE_MULTI}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const rowWrapper = container.querySelector(
      '[data-conversation-id="id-row-z"]',
    ) as HTMLElement;
    const body = rowWrapper.querySelector('[role="button"]') as HTMLElement;
    await openRowKebabInBody(body);
    const menu = screen.getByRole("menu");
    expect(
      within(menu).queryByRole("menuitem", { name: /move to project/i }),
    ).toBeNull();
    // "Move to" may still render (it carries Pinned for pinnable rows), but
    // it must never list a project from another host, nor offer Remove.
    const moveTo = within(menu).queryByTestId("pv-row-kebab-item-move-to");
    if (moveTo) await userEvent.setup().click(moveTo);
    expect(screen.queryByRole("menuitem", { name: /^Alpha$/ })).toBeNull();
    expect(screen.queryByTestId("pv-row-kebab-item-move-to-alpha")).toBeNull();
    expect(
      screen.queryByTestId("pv-row-kebab-item-remove-from-project"),
    ).toBeNull();
  });

  it("relay-room row sees ALL projects (cross-host) in the drill-in submenu — no host filtering", async () => {
    const relayRow: MockRow = {
      id: "relay-row",
      type: "terminal",
      label: "Room A",
      host: undefined,
      targetTmuxSession: null,
      kind: "relay-room",
      roomId: "!room-a:matrix.example",
      roomTitle: "Room A",
    };
    setSnapshot({
      middle: [relayRow],
      projectSections: [
        { slug: "alpha", displayName: "Alpha", rows: [] },
        { slug: "beta", displayName: "Beta", rows: [] },
      ],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
      { slug: "beta", displayName: "Beta", hostId: "2", hostname: "hostB", archived: false },
    ];

    const HOST_TREE_MULTI: HostFolder = {
      name: "root",
      children: [makeHost("1", "hostA"), makeHost("2", "hostB")],
    };

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE_MULTI}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const rowWrapper = container.querySelector(
      '[data-conversation-id="relay-row"]',
    ) as HTMLElement;
    const body = rowWrapper.querySelector('[role="button"]') as HTMLElement;
    await openRowKebabInBody(body);
    const menu = screen.getByRole("menu");
    await userEvent.setup().click(
      within(menu).getByRole("menuitem", { name: /^move to$/i }),
    );

    // Submenu lives in a separate Radix portal — query via screen (global).
    // Relay-room rows see cross-host projects (no host filtering).
    expect(
      screen.queryByRole("menuitem", { name: /^Alpha$/ }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /^Beta$/ }),
    ).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Move to → New project…
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: Move to → New project…", () => {
  it("identity row on a host with zero projects: creates the project on the row's host (no host picker) and moves the row into it", async () => {
    const hostZ = makeHost("9", "hostZ");
    const identityRow = makeRow({
      id: "id-row-z",
      host: hostZ,
      targetTmuxSession: "sess-z",
    });
    setSnapshot({ middle: [identityRow], projectSections: [] });
    mockProjects = [];

    const HOST_TREE_MULTI: HostFolder = {
      name: "root",
      children: [makeHost("1", "hostA"), hostZ],
    };

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE_MULTI}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const rowWrapper = container.querySelector(
      '[data-conversation-id="id-row-z"]',
    ) as HTMLElement;
    const body = rowWrapper.querySelector('[role="button"]') as HTMLElement;
    await openRowKebabInBody(body);
    const menu = screen.getByRole("menu");
    await userEvent.setup().click(within(menu).getByTestId("pv-row-kebab-item-move-to"));
    await userEvent.setup().click(screen.getByTestId("pv-row-kebab-item-new-project"));

    const dialog = await screen.findByTestId("create-project-modal");
    // Host is implied by the row — two hosts exist, but no picker.
    expect(
      within(dialog).queryByTestId("create-project-host-listbox"),
    ).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/^name$/i), {
      target: { value: "Trip Planning" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(setSessionProjectSpy).toHaveBeenCalledWith(9, "sess-z", "trip-planning");
    });
    expect(createProjectSpy).toHaveBeenCalledWith(9, "Trip Planning");
    await waitFor(() => {
      expect(screen.queryByTestId("create-project-modal")).toBeNull();
    });
  });

  it("relay-room row: the modal keeps its host picker, and the room is tagged with the new project", async () => {
    const relayRow: MockRow = {
      id: "relay-row",
      type: "terminal",
      label: "Room A",
      host: undefined,
      targetTmuxSession: null,
      kind: "relay-room",
      roomId: "!room-a:matrix.example",
      roomTitle: "Room A",
    };
    setSnapshot({ middle: [relayRow], projectSections: [] });
    mockProjects = [];

    const HOST_TREE_MULTI: HostFolder = {
      name: "root",
      children: [makeHost("1", "hostA"), makeHost("2", "hostB")],
    };

    const { container } = render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE_MULTI}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );

    const rowWrapper = container.querySelector(
      '[data-conversation-id="relay-row"]',
    ) as HTMLElement;
    const body = rowWrapper.querySelector('[role="button"]') as HTMLElement;
    await openRowKebabInBody(body);
    const menu = screen.getByRole("menu");
    await userEvent.setup().click(within(menu).getByTestId("pv-row-kebab-item-move-to"));
    await userEvent.setup().click(screen.getByTestId("pv-row-kebab-item-new-project"));

    const dialog = await screen.findByTestId("create-project-modal");
    fireEvent.change(within(dialog).getByLabelText(/^name$/i), {
      target: { value: "Trip Planning" },
    });
    fireEvent.click(within(dialog).getByTestId("create-project-host-option-2"));
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(setRelayRoomProjectSpy).toHaveBeenCalledWith(
        "!room-a:matrix.example",
        expect.any(String),
        "trip-planning",
      );
    });
    expect(createProjectSpy).toHaveBeenCalledWith(2, "Trip Planning");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pinned XOR project — menu-path unpin timing
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: pinned and in-a-project are exclusive (Move-to menu)", () => {
  const HOST_TREE_ONE: HostFolder = { name: "root", children: [makeHost("1", "hostA")] };

  async function openMoveTo(container: HTMLElement, rowId: string): Promise<void> {
    const rowWrapper = container.querySelector(
      `[data-conversation-id="${rowId}"]`,
    ) as HTMLElement;
    const body = rowWrapper.querySelector('[role="button"]') as HTMLElement;
    await openRowKebabInBody(body);
    await userEvent.setup().click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: /^move to$/i }),
    );
  }

  it("Remove from project on a stale-pinned project member also unpins it (lands in Conversations, not Pinned)", async () => {
    unpinConversationSpy.mockClear();
    setSessionProjectSpy.mockClear();
    const row = makeRow({ id: "id-row-a", host: makeHost("1", "hostA"), targetTmuxSession: "wren-session" });
    setSnapshot({
      projectSections: [{ slug: "alpha", hostId: "1", displayName: "Alpha", rows: [row] }],
      pinnedIds: new Set(["fleet::1::wren-session"]),
    });
    mockProjects = [{ slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false }];
    const { container } = render(
      <PrettyConversationsPanel isAdmin variant="desktop" hostTree={HOST_TREE_ONE} onNewConversation={() => {}} onDeactivateRow={() => {}} />,
    );
    await openMoveTo(container, "id-row-a");
    await userEvent.setup().click(screen.getByRole("menuitem", { name: /^Remove from project$/ }));
    expect(unpinConversationSpy).toHaveBeenCalledWith("fleet::1::wren-session");
    expect(setSessionProjectSpy).toHaveBeenCalledWith(1, expect.any(String), null);
  });

  it("moving a pinned row into a project unpins only after the write lands; a failed write keeps the pin", async () => {
    unpinConversationSpy.mockClear();
    setSessionProjectSpy.mockClear();
    const row = makeRow({ id: "id-row-a", host: makeHost("1", "hostA"), targetTmuxSession: "wren-session" });
    setSnapshot({
      pinnedUnassigned: [row],
      pinned: [row],
      projectSections: [{ slug: "alpha", hostId: "1", displayName: "Alpha", rows: [] }],
      pinnedIds: new Set(["fleet::1::wren-session"]),
    });
    mockProjects = [{ slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false }];
    setSessionProjectSpy.mockRejectedValueOnce(new Error("500"));
    const { container } = render(
      <PrettyConversationsPanel isAdmin variant="desktop" hostTree={HOST_TREE_ONE} onNewConversation={() => {}} onDeactivateRow={() => {}} />,
    );
    await openMoveTo(container, "id-row-a");
    await userEvent.setup().click(screen.getByRole("menuitem", { name: /^Alpha$/ }));
    expect(setSessionProjectSpy).toHaveBeenCalledWith(1, expect.any(String), "alpha");
    await new Promise((r) => setTimeout(r, 0));
    expect(unpinConversationSpy).not.toHaveBeenCalled();

    // Second attempt succeeds → unpin follows.
    await openMoveTo(container, "id-row-a");
    await userEvent.setup().click(screen.getByRole("menuitem", { name: /^Alpha$/ }));
    await vi.waitFor(() =>
      expect(unpinConversationSpy).toHaveBeenCalledWith("fleet::1::wren-session"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity badges dropped on sidebar sections file the conversation like its
// row would (closing a badge moved to the BadgeDropLane).
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: badge drops file the conversation", () => {
  // The tab id an open pane carries differs from its fleet row id — the
  // badge resolves to the row by host + session.
  const badgePayload = {
    tabId: "Skynet-terminal-123",
    dragId: "d1",
    identityKey: "wren",
    hostId: 1,
    descriptor: { tabType: "terminal", sessionKind: "harness", targetTmuxSession: "wren-session" },
  };
  const badgeDt = () =>
    makeDataTransferStub({
      "text/plain": badgePayload.tabId,
      "application/x-skynet-badge": JSON.stringify(badgePayload),
    });
  function startBadgeDrag(dt: ReturnType<typeof makeDataTransferStub>) {
    const evt = new Event("dragstart", { bubbles: true });
    Object.defineProperty(evt, "dataTransfer", { value: dt, configurable: true });
    act(() => {
      window.dispatchEvent(evt);
    });
  }
  afterEach(() => {
    act(() => {
      window.dispatchEvent(new Event("dragend"));
    });
  });

  function renderWith(rows: { middle?: MockRow[]; alpha?: MockRow[] }) {
    mockIdentitiesByKey = new Map([["wren-session", { identityKey: "wren-session" }]]);
    setSnapshot({
      middle: rows.middle ?? [],
      pinnedIds: new Set(),
      projectSections: [{ slug: "alpha", displayName: "Alpha", rows: rows.alpha ?? [] }],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];
    return render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
  }
  const wrenRow = () =>
    makeRow({ id: "fleet::1::wren-session", host: makeHost("1", "hostA"), targetTmuxSession: "wren-session" });

  it("badge on a project section → setSessionProject for the badge's identity", () => {
    const { container } = renderWith({ middle: [wrenRow()] });
    const section = container.querySelector('[data-testid="pv-project-section-alpha"]') as HTMLElement;
    const dt = badgeDt();
    startBadgeDrag(dt);
    const evt = createEvent.dragOver(section, { dataTransfer: dt });
    fireEvent(section, evt);
    expect(evt.defaultPrevented).toBe(true);
    dispatchDrop(section, dt);
    expect(setSessionProjectSpy).toHaveBeenCalledExactlyOnceWith(1, "wren-session", "alpha");
  });

  it("badge on the Pinned zone → pins the badge's conversation", () => {
    const { container } = renderWith({ middle: [wrenRow()] });
    const pinnedZone = container.querySelector('[data-pinned-group="true"]') as HTMLElement;
    const dt = badgeDt();
    startBadgeDrag(dt);
    dispatchDragOverAt(pinnedZone, 100, 20, dt);
    dispatchDrop(pinnedZone, dt);
    expect(pinConversationSpy).toHaveBeenCalledExactlyOnceWith("fleet::1::wren-session");
  });

  it("badge on Conversations → takes its conversation out of the project", () => {
    const { container } = renderWith({ alpha: [wrenRow()] });
    const flatMiddle = container.querySelector('[data-middle-group="true"]') as HTMLElement;
    const dt = badgeDt();
    startBadgeDrag(dt);
    dispatchDragOverAt(flatMiddle, 100, 100, dt);
    dispatchDrop(flatMiddle, dt);
    expect(setSessionProjectSpy).toHaveBeenCalledExactlyOnceWith(1, "wren-session", null);
  });

  it("a badge with no sidebar row isn't accepted anywhere — and nothing in the sidebar closes it", () => {
    const { container, getByTestId } = renderWith({ middle: [] });
    const section = container.querySelector('[data-testid="pv-project-section-alpha"]') as HTMLElement;
    const dt = badgeDt();
    startBadgeDrag(dt);
    const over = createEvent.dragOver(section, { dataTransfer: dt });
    fireEvent(section, over);
    expect(over.defaultPrevented).toBe(false);
    const panelOver = createEvent.dragOver(getByTestId("pretty-conversations-panel"), { dataTransfer: dt });
    fireEvent(getByTestId("pretty-conversations-panel"), panelOver);
    expect(panelOver.defaultPrevented).toBe(false);
    dispatchDrop(section, dt);
    expect(setSessionProjectSpy).not.toHaveBeenCalled();
    expect(pinConversationSpy).not.toHaveBeenCalled();
  });
});

describe("PrettyConversationsPanel: unread marks show through collapsed headers", () => {
  function seedNested() {
    const hostA = makeHost("1", "hostA");
    const quiet = makeRow({ id: "alpha-row", host: hostA, targetTmuxSession: "a-sess" });
    const loud = { ...makeRow({ id: "beta-row", host: hostA, targetTmuxSession: "b-sess" }), unread: true };
    setSnapshot({
      projectSections: [
        { slug: "alpha", hostId: "1", displayName: "Alpha", rows: [quiet], parentKey: null },
        { slug: "beta", hostId: "1", displayName: "Beta", rows: [loud], parentKey: "1::alpha" },
        { slug: "gamma", hostId: "1", displayName: "Gamma", rows: [quiet], parentKey: null },
      ],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
      { slug: "beta", displayName: "Beta", hostId: "1", hostname: "hostA", archived: false },
      { slug: "gamma", displayName: "Gamma", hostId: "1", hostname: "hostA", archived: false },
    ];
  }
  function renderPanel() {
    return render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
  }

  it("a collapsed parent shows the dot when a sub-project inside it has an unread conversation", () => {
    seedNested();
    mockCollapsed = new Set(["alpha", "gamma"]);
    const { queryByTestId } = renderPanel();
    expect(queryByTestId("pv-project-section-unread-alpha")).not.toBeNull();
    expect(queryByTestId("pv-project-section-unread-gamma")).toBeNull();
  });

  it("the collapsed Projects super-header shows the dot when anything in any project is unread", () => {
    seedNested();
    localStorage.setItem("pv-projects-section-collapsed", "1");
    const { queryByTestId } = renderPanel();
    expect(queryByTestId("pv-projects-super-header-unread")).not.toBeNull();
  });

  it("no super-header dot while expanded, or when nothing is unread", () => {
    seedNested();
    const first = renderPanel();
    expect(first.queryByTestId("pv-projects-super-header-unread")).toBeNull();
    first.unmount();
    setSnapshot({ projectSections: [{ slug: "gamma", hostId: "1", displayName: "Gamma", rows: [], parentKey: null }] });
    localStorage.setItem("pv-projects-section-collapsed", "1");
    const second = renderPanel();
    expect(second.queryByTestId("pv-projects-super-header-unread")).toBeNull();
  });

  it("an unread row renders with the unread class", () => {
    seedNested();
    mockCollapsed = new Set();
    const { container } = renderPanel();
    const row = container.querySelector('[data-conversation-id="beta-row"]');
    expect(row?.getAttribute("data-unread")).toBe("true");
    expect(row?.querySelector(".pv-row--unread")).not.toBeNull();
    const quietRow = container.querySelector('[data-conversation-id="alpha-row"]');
    expect(quietRow?.getAttribute("data-unread")).toBeNull();
  });
});

describe("PrettyConversationsPanel: DM marks", () => {
  function seedNested() {
    const hostA = makeHost("1", "hostA");
    const quiet = makeRow({ id: "alpha-row", host: hostA, targetTmuxSession: "a-sess" });
    const unread = { ...makeRow({ id: "gamma-row", host: hostA, targetTmuxSession: "g-sess" }), unread: true };
    const dmd = { ...makeRow({ id: "beta-row", host: hostA, targetTmuxSession: "b-sess" }), unread: true, dm: true };
    setSnapshot({
      projectSections: [
        { slug: "alpha", hostId: "1", displayName: "Alpha", rows: [quiet], parentKey: null },
        { slug: "beta", hostId: "1", displayName: "Beta", rows: [dmd], parentKey: "1::alpha" },
        { slug: "gamma", hostId: "1", displayName: "Gamma", rows: [unread], parentKey: null },
      ],
    });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
      { slug: "beta", displayName: "Beta", hostId: "1", hostname: "hostA", archived: false },
      { slug: "gamma", displayName: "Gamma", hostId: "1", hostname: "hostA", archived: false },
    ];
  }
  function renderPanel() {
    return render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
  }

  it("a collapsed parent shows the envelope when a sub-project inside has a DM; unread-only shows the dot", () => {
    seedNested();
    mockCollapsed = new Set(["alpha", "gamma"]);
    const { queryByTestId } = renderPanel();
    expect(queryByTestId("pv-project-section-dm-alpha")).not.toBeNull();
    expect(queryByTestId("pv-project-section-unread-alpha")).toBeNull();
    expect(queryByTestId("pv-project-section-dm-gamma")).toBeNull();
    expect(queryByTestId("pv-project-section-unread-gamma")).not.toBeNull();
  });

  it("the collapsed Projects super-header shows the envelope over the dot", () => {
    seedNested();
    localStorage.setItem("pv-projects-section-collapsed", "1");
    const { queryByTestId } = renderPanel();
    expect(queryByTestId("pv-projects-super-header-dm")).not.toBeNull();
    expect(queryByTestId("pv-projects-super-header-unread")).toBeNull();
  });

  it("a DM'd row renders the DM class and the red envelope badge", () => {
    seedNested();
    mockCollapsed = new Set();
    const { container } = renderPanel();
    const row = container.querySelector('[data-conversation-id="beta-row"]');
    expect(row?.getAttribute("data-dm")).toBe("true");
    expect(row?.querySelector(".pv-row--dm")).not.toBeNull();
    expect(row?.querySelector('[data-testid="pv-dm-badge"]')).not.toBeNull();
    expect(row?.querySelector('[data-testid="pv-dm-badge"]')?.getAttribute("title")).toBe("Notified you");
    expect(row?.querySelector('.pv-avatar [data-testid="pv-dm-badge"]')).toBeNull();
    expect(row?.querySelector('[data-testid="pv-unread-dot"]')).toBeNull();
    const unreadRow = container.querySelector('[data-conversation-id="gamma-row"]');
    expect(unreadRow?.querySelector('[data-testid="pv-dm-badge"]')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shape-sidebar: section-heading look (classes, chevron data-open, folder
// icon, "+" class) and the empty Conversations note's copy.
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel (shape-sidebar): section headings", () => {
  function seedAlpha(collapsed: string[] = []) {
    const hostA = makeHost("1", "hostA");
    const rowA = makeRow({ id: "alpha-row", label: "a", host: hostA, targetTmuxSession: "a-sess" });
    setSnapshot({ projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [rowA] }] });
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];
    mockCollapsed = new Set(collapsed);
  }
  function renderPanel() {
    return render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
  }

  it("top-level headings carry pv-section-head; the Projects '+' carries pv-section-add", () => {
    seedAlpha();
    const { container } = renderPanel();
    for (const id of [
      "pretty-conversations-apps-header",
      "pv-projects-super-header",
      "pv-flat-middle-section-header",
    ]) {
      const el = container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
      expect(el, id).not.toBeNull();
      expect(el.classList.contains("pv-section-head"), id).toBe(true);
    }
    const plus = container.querySelector('[data-testid="pv-projects-new-project-button"]') as HTMLElement;
    expect(plus.classList.contains("pv-section-add")).toBe(true);
  });

  it("project headings are pv-project-head with a chevron then a folder icon", () => {
    seedAlpha();
    const { container } = renderPanel();
    const head = container.querySelector('[data-testid="pv-project-section-header-alpha"]') as HTMLElement;
    expect(head.classList.contains("pv-project-head")).toBe(true);
    const chevron = head.querySelector(".pv-section-chevron") as Element;
    const folder = head.querySelector(".pv-project-folder") as Element;
    expect(chevron).not.toBeNull();
    expect(folder).not.toBeNull();
    expect(chevron.compareDocumentPosition(folder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chevron.getAttribute("data-open")).toBe("true");
  });

  it("a collapsed project's chevron has data-open=false", () => {
    seedAlpha(["alpha"]);
    const { container } = renderPanel();
    const head = container.querySelector('[data-testid="pv-project-section-header-alpha"]') as HTMLElement;
    expect(head.querySelector(".pv-section-chevron")!.getAttribute("data-open")).toBe("false");
  });

  it("the Projects chevron's data-open toggles when the section collapses and expands", () => {
    seedAlpha();
    const { container } = renderPanel();
    const header = container.querySelector('[data-testid="pv-projects-super-header"]') as HTMLElement;
    const chevron = () => header.querySelector(":scope > .pv-section-chevron") as Element;
    expect(chevron().getAttribute("data-open")).toBe("true");
    fireEvent.click(header);
    expect(chevron().getAttribute("data-open")).toBe("false");
    fireEvent.click(header);
    expect(chevron().getAttribute("data-open")).toBe("true");
    expect(container.querySelector(".rotate-180")).toBeNull();
  });

  it("the empty Conversations note reads the new copy", () => {
    setSnapshot({ middle: [] });
    const { container } = renderPanel();
    const empty = container.querySelector('[data-testid="pv-flat-middle-empty"]') as HTMLElement;
    expect(empty).not.toBeNull();
    expect(empty.textContent).toBe("Start a conversation with the pencil at the top.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pinning relay rooms — the favourite tag on the user's own account
// ─────────────────────────────────────────────────────────────────────────────

describe("PrettyConversationsPanel: pinning relay rooms", () => {
  const ROOM_ID = "!room-p:matrix.example";
  const roomRow = (): MockRow => ({
    id: "relay-row-p",
    type: "terminal",
    label: "Room P",
    host: undefined,
    targetTmuxSession: null,
    kind: "relay-room",
    roomId: ROOM_ID,
    roomTitle: "Room P",
  });
  const renderPanel = () =>
    render(
      <PrettyConversationsPanel isAdmin
        variant="desktop"
        hostTree={HOST_TREE}
        onNewConversation={() => {}}
        onDeactivateRow={() => {}}
      />,
    );
  const openMoveTo = async (container: HTMLElement) => {
    const rowWrapper = container.querySelector(
      '[data-conversation-id="relay-row-p"]',
    ) as HTMLElement;
    const body = rowWrapper.querySelector('[role="button"]') as HTMLElement;
    await openRowKebabInBody(body);
    await userEvent.setup().click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: /^move to$/i }),
    );
  };

  it("Move to → Pinned pins the room as the user", async () => {
    setSnapshot({ middle: [roomRow()] });
    const { container } = renderPanel();
    await openMoveTo(container);
    await userEvent.setup().click(screen.getByTestId("pv-row-kebab-item-move-to-pinned"));
    expect(patchRoomPinnedSpy).toHaveBeenCalledWith(ROOM_ID, true);
    expect(setRelayRoomPinnedSpy).toHaveBeenCalledWith(ROOM_ID, "@user:matrix.example", true);
    expect(pinConversationSpy).not.toHaveBeenCalled();
  });

  it("a pinned room's Move to shows Pinned checked and offers Unpin", async () => {
    mockRoomPinnedIds = new Set([ROOM_ID]);
    setSnapshot({ pinned: [roomRow()], pinnedUnassigned: [roomRow()] });
    const { container } = renderPanel();
    await openMoveTo(container);
    await userEvent.setup().click(screen.getByTestId("pv-row-kebab-item-unpin"));
    expect(patchRoomPinnedSpy).toHaveBeenCalledWith(ROOM_ID, false);
    expect(setRelayRoomPinnedSpy).toHaveBeenCalledWith(ROOM_ID, "@user:matrix.example", false);
    expect(unpinConversationSpy).not.toHaveBeenCalled();
  });

  it("a room in a project: Move to → Pinned pins it (the backend takes it out of the project)", async () => {
    mockProjects = [
      { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "hostA", archived: false },
    ];
    setSnapshot({
      projectSections: [{ slug: "alpha", displayName: "Alpha", rows: [roomRow()] }],
    });
    const { container } = renderPanel();
    await openMoveTo(container);
    await userEvent.setup().click(screen.getByTestId("pv-row-kebab-item-move-to-pinned"));
    expect(setRelayRoomPinnedSpy).toHaveBeenCalledWith(ROOM_ID, "@user:matrix.example", true);
    expect(setRelayRoomProjectSpy).not.toHaveBeenCalled();
  });

  it("dropping a room on Pinned pins it", () => {
    setSnapshot({ middle: [roomRow()] });
    const { container } = renderPanel();
    const zone = container.querySelector('[data-pinned-group="true"]') as HTMLElement;
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify({
        id: "relay-row-p",
        matrixRoomId: ROOM_ID,
        rdpHostRow: false,
      }),
    });
    dispatchDragOverAt(zone, 10, 10, dt);
    dispatchDrop(zone, dt);
    expect(setRelayRoomPinnedSpy).toHaveBeenCalledWith(ROOM_ID, "@user:matrix.example", true);
    expect(pinConversationSpy).not.toHaveBeenCalled();
  });

  it("dropping a pinned room on Conversations unpins it", () => {
    mockRoomPinnedIds = new Set([ROOM_ID]);
    setSnapshot({ pinned: [roomRow()], pinnedUnassigned: [roomRow()] });
    const { container } = renderPanel();
    const zone = container.querySelector('[data-testid="pv-panel-flat-middle"]') as HTMLElement;
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify({
        id: "relay-row-p",
        matrixRoomId: ROOM_ID,
        rdpHostRow: false,
      }),
    });
    dispatchDragOverAt(zone, 10, 10, dt);
    dispatchDrop(zone, dt);
    expect(setRelayRoomPinnedSpy).toHaveBeenCalledWith(ROOM_ID, "@user:matrix.example", false);
    expect(setRelayRoomProjectSpy).not.toHaveBeenCalled();
  });
});
