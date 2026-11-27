/**
 * Nested projects (shape-nested-projects-structure) — in-process tests that
 * drive the sidebar panel through the user paths: a sub-project renders inside
 * its parent above the parent's conversations, collapsing a parent hides the
 * subtree, the project menu's "New sub-project" and "Move to", dragging a
 * project header onto another project or the Projects header, archiving a
 * parent with its subtree, and project-name search revealing a subtree.
 *
 * Harness copied from PrettyConversationsPanel.projects.test.tsx.
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
import { autoAnswerKitDialogs, __resetKitDialogsForTests } from "@/components/kit";

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
    depth?: number;
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
  parent?: string | null;
}[] = [];
const mergeProjectsForHostSpy = vi.fn();

const selectConversationSpy = vi.fn();
const addToActiveSetSpy = vi.fn();
const removeFromActiveSetSpy = vi.fn();
const pinConversationSpy = vi.fn();
const unpinConversationSpy = vi.fn();
const hydratePinnedIdsFromServerSpy = vi.fn();

let mockActiveSet: ReadonlySet<string> = new Set();
let mockFleetSessionsLoaded = true;

vi.mock("@/state/conversation-store", () => ({
  upsertFleetSession: () => {},
  patchRoomProjectAssignment: () => () => {},
  patchRoomPinned: () => () => {},
  useRoomPinnedIds: () => new Set<string>(),
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
  mergeProjectsForHost: (hostId: string, rows: unknown) =>
    mergeProjectsForHostSpy(hostId, rows),
  // The move hold, as the store does it: the new place at once, the old one back on a refusal.
  startProjectMoveIntent: (hostId: string, slug: string, parent: string | null) => {
    mergeProjectsForHostSpy(
      hostId,
      mockProjects.filter((p) => p.hostId === hostId).map((p) => (p.slug === slug ? { ...p, parent } : p)),
    );
    return 1;
  },
  settleProjectMoveIntent: (hostId: string, slug: string, _seq: number, outcome: { done: boolean; previous?: string | null }) => {
    if ("previous" in outcome) {
      mergeProjectsForHostSpy(
        hostId,
        mockProjects.filter((p) => p.hostId === hostId).map((p) => (p.slug === slug ? { ...p, parent: outcome.previous } : p)),
      );
    }
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
const setRelayRoomProjectSpy = vi.fn<
  (roomId: string, mxid: string, slug: string | null) => Promise<{ ok: true }>
>(async () => ({ ok: true as const }));
vi.mock("@/api/session-project-api", () => ({
  setSessionProject: (hostId: number, key: string, slug: string | null) =>
    setSessionProjectSpy(hostId, key, slug),
  setRelayRoomProject: (roomId: string, mxid: string, slug: string | null) =>
    setRelayRoomProjectSpy(roomId, mxid, slug),
}));

// Phase 117 Plan 117-09 — project-list-api mock. The CreateProjectModal
// (117-09 Task 1) imports createProject from this module; the modal only
// fires the API on Submit-click, so tests that never click Submit see no
// spy invocations. Stubbed to a successful envelope so any incidental
// click path lands cleanly.
const createProjectSpy = vi.fn<
  (hostId: number, displayName: string, parent?: string | null) => Promise<{ ok: true; slug: string }>
>(async (_hostId, name) => ({
  ok: true as const,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
}));
// What the machine says SKYNET's subtree holds (archive preflight).
const skynetContents = {
  project: "skynet",
  projects: [
    { slug: "skynet", displayName: "SKYNET", parent: null },
    { slug: "design", displayName: "Design", parent: "skynet" },
    { slug: "ops", displayName: "Ops", parent: "skynet" },
    { slug: "ui", displayName: "UI", parent: "design" },
  ],
  agents: ["s-agent", "d-agent", "o-agent"].map((name) => ({ name, displayName: name, task: "", project: "skynet" })),
  apps: [{ slug: "beds", title: "Beds", project: "ops" }],
};
const getArchivePreflightSpy = vi.fn(async (_hostId: number, _slug: string) => ({
  done: true as const,
  requestId: "pre-1",
  result: { hiddenSubProjects: 0, contents: skynetContents, rooms: [{ roomId: "!room:matrix.example", project: "ops" }], roomsUnknown: false },
}));
const archiveProjectSpy = vi.fn<
  (hostId: number, slug: string, expected: unknown) => Promise<unknown>
>(async () => ({ done: true as const, requestId: "arch-1", result: { ok: true } }));
const getProjectFileSpy = vi.fn<
  (hostId: number, slug: string) => Promise<{ markdown: string }>
>(async () => ({ markdown: "---\ndisplayName: Alpha\n---\n" }));
const updateProjectFileSpy = vi.fn<
  (hostId: number, slug: string, contents: string) => Promise<{ markdown: string }>
>(async (_h, _s, contents) => ({ markdown: contents }));
const setProjectParentSpy = vi.fn<
  (hostId: number, slug: string, parent: string | null) => Promise<{ ok: true }>
>(async () => ({ ok: true as const }));
vi.mock("@/api/project-list-api", () => ({
  createProject: (hostId: number, displayName: string, parent?: string | null) =>
    createProjectSpy(hostId, displayName, parent),
  setProjectParent: (hostId: number, slug: string, parent: string | null) =>
    setProjectParentSpy(hostId, slug, parent),
  archiveProject: (hostId: number, slug: string, expected: unknown) =>
    archiveProjectSpy(hostId, slug, expected),
  expectedFromContents: (c: typeof skynetContents) => ({
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
import { publishAppSnapshot, __resetForTest as resetAppTiles } from "@/state/app-tiles-store";
import { startAppDrag, endAppDrag } from "./app-drag";
import type { AppState } from "@/api/fleet-status-types";
import { requestAppMove } from "@/api/apps-move-api";

vi.mock("@/api/apps-move-api", () => ({
  requestAppMove: vi.fn().mockResolvedValue({ ok: true }),
}));
import { resetWakeupCheckMock } from "@/shell/archive-wakeup-check.test-mocks";

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
  mockFleetSessionsLoaded = true;
  localStorage.removeItem("pv-projects-section-collapsed");
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetKitDialogsForTests();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture: one host with a tree
//   SKYNET            rows: s-row
//     Design          rows: d-row
//       UI            (empty)
//     Ops             rows: o-row, room
//   Other             (empty)
// Sections arrive in tree order with resolved parentKey/depth, as the store
// emits them.
// ─────────────────────────────────────────────────────────────────────────────

const hostA = makeHost("1", "hostA");
const sRow = makeRow({ id: "s-row", label: "s-agent", host: hostA, targetTmuxSession: "s-agent" });
const dRow = makeRow({ id: "d-row", label: "d-agent", host: hostA, targetTmuxSession: "d-agent" });
const oRow = makeRow({ id: "o-row", label: "o-agent", host: hostA, targetTmuxSession: "o-agent" });
const roomRow = makeRow({
  id: "room-row",
  label: "ops-room",
  host: undefined,
  targetTmuxSession: null,
  kind: "relay-room",
  roomId: "!room:matrix.example",
  roomTitle: "ops-room",
});

function seedTree(): void {
  setSnapshot({
    projectSections: [
      { slug: "skynet", hostId: "1", displayName: "SKYNET", rows: [sRow], parentKey: null, depth: 0 },
      { slug: "design", hostId: "1", displayName: "Design", rows: [dRow], parentKey: "1::skynet", depth: 1 },
      { slug: "ui", hostId: "1", displayName: "UI", rows: [], parentKey: "1::design", depth: 2 },
      { slug: "ops", hostId: "1", displayName: "Ops", rows: [oRow, roomRow], parentKey: "1::skynet", depth: 1 },
      { slug: "other", hostId: "1", displayName: "Other", rows: [], parentKey: null, depth: 0 },
    ],
  });
  mockProjects = [
    { slug: "skynet", displayName: "SKYNET", hostId: "1", hostname: "hostA", archived: false, parent: null },
    { slug: "design", displayName: "Design", hostId: "1", hostname: "hostA", archived: false, parent: "skynet" },
    { slug: "ui", displayName: "UI", hostId: "1", hostname: "hostA", archived: false, parent: "design" },
    { slug: "ops", displayName: "Ops", hostId: "1", hostname: "hostA", archived: false, parent: "skynet" },
    { slug: "other", displayName: "Other", hostId: "1", hostname: "hostA", archived: false, parent: null },
  ];
}

function renderPanel(variant: "desktop" | "mobile" = "desktop") {
  return render(
    <PrettyConversationsPanel isAdmin
      variant={variant}
      hostTree={HOST_TREE}
      onNewConversation={() => {}}
      onDeactivateRow={() => {}}
    />,
  );
}

const sectionEl = (c: HTMLElement, slug: string) =>
  c.querySelector(`[data-testid="pv-project-section-${slug}"]`) as HTMLElement | null;
const contentEl = (c: HTMLElement, slug: string) =>
  c.querySelector(`#pv-project-section-content-${slug}`) as HTMLElement | null;

async function openProjectMoveTo(container: HTMLElement, slug: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(
    container.querySelector(`[data-testid="pv-project-section-kebab-trigger-${slug}"]`) as HTMLElement,
  );
  await user.click(screen.getByRole("menuitem", { name: "Move to" }));
  const menus = await screen.findAllByRole("menu");
  return menus[menus.length - 1];
}

describe("nested projects: sidebar tree", () => {
  it("renders sub-projects inside their parent, above the parent's own conversations, at any depth", () => {
    seedTree();
    const { container } = renderPanel();
    const skynetContent = contentEl(container, "skynet")!;
    const design = sectionEl(container, "design")!;
    expect(skynetContent.contains(design)).toBe(true);
    expect(contentEl(container, "design")!.contains(sectionEl(container, "ui"))).toBe(true);
    expect(skynetContent.contains(sectionEl(container, "ops"))).toBe(true);
    // Other stays at top level.
    expect(skynetContent.contains(sectionEl(container, "other"))).toBe(false);
    // Sub-projects come before SKYNET's own row.
    const sRowEl = skynetContent.querySelector('[data-conversation-id="s-row"]')!;
    expect(sRowEl).not.toBeNull();
    expect(design.compareDocumentPosition(sRowEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The empty-state hint shows for a project with no rows AND no sub-projects only.
    expect(contentEl(container, "ui")!.textContent).toContain("Create a new conversation");
    expect(within(skynetContent).queryAllByTestId("pretty-conversations-project-empty")).toHaveLength(1);
  });

  it("collapsing a parent hides its whole subtree; siblings elsewhere stay", () => {
    seedTree();
    mockCollapsed = new Set(["skynet"]);
    const { container } = renderPanel();
    expect(sectionEl(container, "skynet")).not.toBeNull();
    expect(sectionEl(container, "design")).toBeNull();
    expect(sectionEl(container, "ui")).toBeNull();
    expect(sectionEl(container, "other")).not.toBeNull();
  });

  it("same-slug projects on different hosts collapse independently", () => {
    setSnapshot({
      projectSections: [
        { slug: "skynet", hostId: "1", displayName: "SKYNET", rows: [], parentKey: null, depth: 0 },
        { slug: "later", hostId: "1", displayName: "Later", rows: [sRow], parentKey: "1::skynet", depth: 1 },
        { slug: "work", hostId: "2", displayName: "Work", rows: [], parentKey: null, depth: 0 },
        { slug: "later", hostId: "2", displayName: "Later", rows: [dRow], parentKey: "2::work", depth: 1 },
      ],
    });
    mockProjects = [
      { slug: "skynet", displayName: "SKYNET", hostId: "1", hostname: "hostA", archived: false, parent: null },
      { slug: "later", displayName: "Later", hostId: "1", hostname: "hostA", archived: false, parent: "skynet" },
      { slug: "work", displayName: "Work", hostId: "2", hostname: "hostB", archived: false, parent: null },
      { slug: "later", displayName: "Later", hostId: "2", hostname: "hostB", archived: false, parent: "work" },
    ];
    mockCollapsed = new Set(["2::later"]);
    const { container } = renderPanel();
    const workLater = sectionEl(container, "work")!.querySelector('[data-testid="pv-project-section-later"]')!;
    const skynetLater = sectionEl(container, "skynet")!.querySelector('[data-testid="pv-project-section-later"]')!;
    expect(workLater.querySelector('[data-conversation-id="d-row"]')).toBeNull();
    expect(skynetLater.querySelector('[data-conversation-id="s-row"]')).not.toBeNull();

    toggleSpy.mockClear();
    fireEvent.click(skynetLater.querySelector('[data-testid="pv-project-section-header-later"]')!);
    expect(toggleSpy).toHaveBeenCalledWith("1::later", undefined);
  });

  it("a pre-keying bare-slug entry migrates to every same-slug key on toggle", () => {
    setSnapshot({
      projectSections: [
        { slug: "later", hostId: "1", displayName: "Later", rows: [], parentKey: null, depth: 0 },
        { slug: "later", hostId: "2", displayName: "Later", rows: [], parentKey: null, depth: 0 },
      ],
    });
    mockProjects = [
      { slug: "later", displayName: "Later", hostId: "1", hostname: "hostA", archived: false, parent: null },
      { slug: "later", displayName: "Later", hostId: "2", hostname: "hostB", archived: false, parent: null },
    ];
    mockCollapsed = new Set(["later"]);
    const { container } = renderPanel();
    toggleSpy.mockClear();
    fireEvent.click(container.querySelectorAll('[data-testid="pv-project-section-header-later"]')[0]!);
    expect(toggleSpy).toHaveBeenCalledWith("1::later", { legacy: "later", keys: ["1::later", "2::later"] });
  });

  it("a section whose parent isn't present renders at top level", () => {
    setSnapshot({
      projectSections: [
        { slug: "orphan", hostId: "1", displayName: "Orphan", rows: [], parentKey: "1::gone", depth: 1 },
      ],
    });
    mockProjects = [
      { slug: "orphan", displayName: "Orphan", hostId: "1", hostname: "hostA", archived: false, parent: "gone" },
    ];
    const { container } = renderPanel();
    expect(sectionEl(container, "orphan")).not.toBeNull();
  });
});

describe("nested projects: project menu", () => {
  it("Move to lists Top level plus eligible parents, indented, without the project's own subtree", async () => {
    seedTree();
    const { container } = renderPanel();
    const menu = await openProjectMoveTo(container, "design");
    const labels = within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim());
    expect(labels).toEqual(["Top level", "SKYNET", "Ops", "Other"]);
    // Current parent carries the checkmark (an svg in the item).
    const skynetItem = within(menu).getByRole("menuitem", { name: "SKYNET" });
    expect(skynetItem.querySelector("svg")).not.toBeNull();
  });

  it("picking a project from Move to re-parents it (optimistic patch + write)", async () => {
    seedTree();
    const { container } = renderPanel();
    const menu = await openProjectMoveTo(container, "design");
    await userEvent.setup().click(within(menu).getByRole("menuitem", { name: "Other" }));
    expect(setProjectParentSpy).toHaveBeenCalledWith(1, "design", "other");
    const [hostId, rows] = mergeProjectsForHostSpy.mock.calls[0] as [string, Array<{ slug: string; parent?: string | null }>];
    expect(hostId).toBe("1");
    expect(rows.find((r) => r.slug === "design")?.parent).toBe("other");
  });

  it("Move to → Top level un-nests it", async () => {
    seedTree();
    const { container } = renderPanel();
    const menu = await openProjectMoveTo(container, "ui");
    await userEvent.setup().click(within(menu).getByRole("menuitem", { name: "Top level" }));
    expect(setProjectParentSpy).toHaveBeenCalledWith(1, "ui", null);
  });

  it("a failed move restores the previous list and says why", async () => {
    seedTree();
    const dialogs = autoAnswerKitDialogs();
    setProjectParentSpy.mockRejectedValueOnce(new Error("parent project not found"));
    // After the optimistic patch the store would show the new parent.
    mergeProjectsForHostSpy.mockImplementationOnce((_h: string, rows: typeof mockProjects) => {
      mockProjects = rows;
    });
    const { container } = renderPanel();
    const menu = await openProjectMoveTo(container, "design");
    await userEvent.setup().click(within(menu).getByRole("menuitem", { name: "Other" }));
    await waitFor(() => expect(dialogs.calls).toHaveLength(1));
    const lastRows = mergeProjectsForHostSpy.mock.calls.at(-1)![1] as Array<{ slug: string; parent?: string | null }>;
    expect(lastRows.find((r) => r.slug === "design")?.parent).toBe("skynet");
    expect(dialogs.calls[0].kind).toBe("alert");
    expect(String(dialogs.calls[0].opts.body)).toBe("Parent project not found.");
  });

  it("New sub-project creates the project inside the parent on the parent's host", async () => {
    seedTree();
    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "skynet", "New sub-project");
    const dialog = await screen.findByTestId("create-project-modal");
    expect(within(dialog).getByText("New sub-project")).toBeTruthy();
    // The name field has focus once the menu has closed, ready to type into.
    const user = userEvent.setup();
    await user.type(within(dialog).getByRole("textbox"), "Research");
    await user.click(within(dialog).getByRole("button", { name: /create/i }));
    await waitFor(() =>
      expect(createProjectSpy).toHaveBeenCalledWith(1, "Research", "skynet"),
    );
  });

  it.each(["menu button", "right-click"])("New sub-project from the %s opens with the name field focused", async (how) => {
    seedTree();
    const { container } = renderPanel();
    if (how === "menu button") {
      await openProjectKebabAndClickItem(container, "skynet", "New sub-project");
    } else {
      const user = userEvent.setup();
      await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("pv-project-section-header-skynet") });
      await new Promise((r) => setTimeout(r, 500)); // past the menu's open-settle window
      await user.click(screen.getByRole("menuitem", { name: "New sub-project" }));
    }
    const dialog = await screen.findByTestId("create-project-modal");
    const input = within(dialog).getByRole("textbox");
    // Still focused once the menu has finished closing.
    await new Promise((r) => setTimeout(r, 100));
    expect(document.activeElement).toBe(input);
  });
});

describe("nested projects: the project window", () => {
  it("Edit project shows what the sidebar shows directly inside it, and a sub-project's parents", async () => {
    seedTree();
    getProjectFileSpy.mockResolvedValue({ markdown: "---\ndisplayName: X\n---\n" });
    const { container } = renderPanel();

    await openProjectKebabAndClickItem(container, "skynet", "Edit project");
    expect((await screen.findByTestId("project-modal-count")).textContent).toBe("1 conversation · 2 sub-projects");
    expect(screen.queryByTestId("project-modal-lineage")).toBeNull();
    fireEvent.click(screen.getByTestId("project-modal-close"));
    await waitFor(() => expect(screen.queryByTestId("project-modal")).toBeNull());

    await openProjectKebabAndClickItem(container, "ui", "Edit project");
    expect((await screen.findByTestId("project-modal-lineage")).textContent).toBe("In SKYNET › Design");
    expect(screen.getByTestId("project-modal-count").textContent).toBe("0 conversations");
  });
});

describe("nested projects: archive takes the subtree", () => {
  it("confirm names the project and counts what the machine says is in its subtree; one archive request takes it all", async () => {
    seedTree();
    const dialogs = autoAnswerKitDialogs({ confirm: () => true });
    const { archiveIdentity } = await import("@/api/identity-archive-api");
    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "skynet", "Archive project");
    await waitFor(() => expect(dialogs.calls).toHaveLength(1));
    expect(dialogs.calls[0].kind).toBe("confirm");
    expect(dialogs.calls[0].opts.title).toBe('Archive "SKYNET"?');
    expect(dialogs.calls[0].opts.body).toBe(
      'This also archives its 3 sub-projects and the 3 agents across them.\n\nIts app "Beds" is archived with it.\n\n1 relay room will move back to Conversations.\n\nThis can\'t be undone. Move conversations and apps out first to keep them.',
    );
    await waitFor(() => expect(archiveProjectSpy).toHaveBeenCalledTimes(1));
    expect(archiveProjectSpy).toHaveBeenCalledWith(1, "skynet", {
      projects: ["skynet", "design", "ops", "ui"],
      agents: ["s-agent", "d-agent", "o-agent"],
      apps: ["beds"],
    });
    // The machine and the server do the agents and rooms; the sidebar only shows it.
    expect(archiveIdentity).not.toHaveBeenCalled();
    expect(setRelayRoomProjectSpy).not.toHaveBeenCalled();
    // Shown archived at once: the subtree leaves the host's list, Other stays.
    const [, rows] = mergeProjectsForHostSpy.mock.calls[0] as [string, Array<{ slug: string }>];
    expect(rows.map((r) => r.slug)).toEqual(["other"]);
  });

  it("refuses up front when a sub-project inside is hidden from the user", async () => {
    seedTree();
    const dialogs = autoAnswerKitDialogs({ confirm: () => true });
    getArchivePreflightSpy.mockResolvedValueOnce({
      done: true,
      requestId: "pre-2",
      result: { hiddenSubProjects: 2, contents: skynetContents, rooms: [], roomsUnknown: false },
    });
    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "skynet", "Archive project");
    await waitFor(() => expect(dialogs.calls).toHaveLength(1));
    expect(getArchivePreflightSpy).toHaveBeenCalledWith(1, "skynet");
    expect(dialogs.calls[0].kind).toBe("alert");
    expect(dialogs.calls[0].opts.title).toBe('Can\'t archive "SKYNET"');
    expect(dialogs.calls[0].opts.body).toBe(
      "2 sub-projects inside it are hidden from you. Nothing was archived.",
    );
    expect(archiveProjectSpy).not.toHaveBeenCalled();
  });

  it("cancelling the confirm archives nothing", async () => {
    seedTree();
    const dialogs = autoAnswerKitDialogs({ confirm: () => false });
    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "design", "Archive project");
    await waitFor(() => expect(dialogs.calls).toHaveLength(1));
    expect(archiveProjectSpy).not.toHaveBeenCalled();
  });

  it("a failed archive puts the whole subtree back and says why", async () => {
    seedTree();
    const dialogs = autoAnswerKitDialogs({ confirm: () => true });
    archiveProjectSpy.mockRejectedValueOnce(new MachineChangeError("couldn't stop the app 'beds': unit busy", 500, "app_stop_failed", null));
    const keepList = (h: string, rows: typeof mockProjects) => {
      mockProjects = [...mockProjects.filter((p) => p.hostId !== h), ...rows];
    };
    mergeProjectsForHostSpy.mockImplementationOnce(keepList).mockImplementationOnce(keepList);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = renderPanel();
    await openProjectKebabAndClickItem(container, "skynet", "Archive project");
    await waitFor(() => expect(dialogs.calls.filter((c) => c.kind === "alert")).toHaveLength(1));
    const alert = dialogs.calls.find((c) => c.kind === "alert")!;
    expect(String(alert.opts.body)).toBe("Couldn't stop the app 'beds': unit busy. Nothing was archived.");
    // Hidden first, then put back: the last list has every project of the subtree again.
    const lastRows = mergeProjectsForHostSpy.mock.calls.at(-1)![1] as Array<{ slug: string }>;
    expect(lastRows.map((r) => r.slug).sort()).toEqual(["design", "ops", "other", "skynet", "ui"]);
    warnSpy.mockRestore();
  });
});

describe("nested projects: dragging a project header", () => {
  function dragHeader(container: HTMLElement, slug: string) {
    const dt = makeDataTransferStub();
    const header = container.querySelector(`[data-testid="pv-project-section-header-${slug}"]`) as HTMLElement;
    expect(header.getAttribute("draggable")).toBe("true");
    fireEvent.dragStart(header, { dataTransfer: dt });
    return dt;
  }

  it("dropping on another project nests it there", () => {
    seedTree();
    const { container } = renderPanel();
    const dt = dragHeader(container, "design");
    const other = sectionEl(container, "other")!;
    dispatchDragOverAt(other, 1, 1, dt);
    expect(container.querySelector('[data-testid="pv-project-drop-overlay-other"]')).not.toBeNull();
    dispatchDrop(other, dt);
    expect(setProjectParentSpy).toHaveBeenCalledWith(1, "design", "other");
  });

  it("its own subtree never lights up — not even the ancestor around it — and a drop there does nothing", () => {
    seedTree();
    const { container } = renderPanel();
    const dt = dragHeader(container, "design");
    const ui = sectionEl(container, "ui")!;
    dispatchDragOverAt(ui, 1, 1, dt);
    expect(container.querySelector('[data-testid="pv-project-drop-overlay-ui"]')).toBeNull();
    expect(container.querySelector('[data-testid="pv-project-drop-overlay-design"]')).toBeNull();
    expect(container.querySelector('[data-testid="pv-project-drop-overlay-skynet"]')).toBeNull();
    dispatchDrop(ui, dt);
    expect(setProjectParentSpy).not.toHaveBeenCalled();
  });

  it("moving from a lit ancestor into the dragged project's own subtree turns the ancestor's highlight off", () => {
    seedTree();
    const { container } = renderPanel();
    const dt = dragHeader(container, "design");
    dispatchDragOverAt(sectionEl(container, "skynet")!, 1, 1, dt);
    expect(container.querySelector('[data-testid="pv-project-drop-overlay-skynet"]')).not.toBeNull();
    dispatchDragOverAt(sectionEl(container, "ui")!, 1, 1, dt);
    expect(container.querySelector('[data-testid="pv-project-drop-overlay-skynet"]')).toBeNull();
  });

  it("dropping on the Projects header returns it to top level", () => {
    seedTree();
    const { container } = renderPanel();
    const dt = dragHeader(container, "ui");
    const superHeader = container.querySelector('[data-testid="pv-projects-super-header"]') as HTMLElement;
    dispatchDragOverAt(superHeader, 1, 1, dt);
    dispatchDrop(superHeader, dt);
    expect(setProjectParentSpy).toHaveBeenCalledWith(1, "ui", null);
  });

  it("a conversation dropped inside a sub-project lands in the innermost project", () => {
    seedTree();
    const { container } = renderPanel();
    const dt = makeDataTransferStub({
      "application/x-skynet-row": JSON.stringify({
        id: "s-row",
        host: { id: "1" },
        targetTmuxSession: "s-agent",
        identityKey: "s-agent",
      }),
    });
    const ui = sectionEl(container, "ui")!;
    dispatchDragOverAt(ui, 1, 1, dt);
    dispatchDrop(ui, dt);
    expect(setSessionProjectSpy).toHaveBeenCalledWith(1, "s-agent", "ui");
  });

  it("on a phone, project headers aren't draggable (Move to is the way)", () => {
    seedTree();
    const { container } = renderPanel("mobile");
    const header = container.querySelector('[data-testid="pv-project-section-header-design"]') as HTMLElement;
    expect(header.getAttribute("draggable")).toBeNull();
  });
});

describe("nested projects: conversation Move to mirrors the tree", () => {
  it("indents sub-projects in a conversation's Move to list", async () => {
    seedTree();
    setSnapshot({
      ...snapshot,
      middle: [makeRow({ id: "loose", label: "loose-agent", host: hostA, targetTmuxSession: "loose-agent" })],
    });
    const { container } = renderPanel();
    const loose = container.querySelector('[data-conversation-id="loose"]') as HTMLElement;
    const user = userEvent.setup();
    await user.click(loose.querySelector('[data-testid="pv-row-kebab-trigger"]') as HTMLElement);
    await user.click(screen.getByRole("menuitem", { name: "Move to" }));
    const ui = await screen.findByTestId("pv-row-kebab-item-move-to-ui");
    const skynet = screen.getByTestId("pv-row-kebab-item-move-to-skynet");
    const indentOf = (el: HTMLElement) =>
      parseInt((el.querySelector('span[style]') as HTMLElement | null)?.style.width ?? "0", 10);
    expect(indentOf(skynet)).toBe(0);
    expect(indentOf(ui)).toBe(24);
  });
});

describe("nested projects: search by project name", () => {
  it("a name match shows the project, its subtree and all their conversations, with ancestors as the path", () => {
    seedTree();
    const { container } = renderPanel();
    const input = container.querySelector('[data-testid="pv-sidebar-search-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "design" } });
    expect(sectionEl(container, "skynet")).not.toBeNull(); // path
    expect(sectionEl(container, "design")).not.toBeNull();
    expect(sectionEl(container, "ui")).not.toBeNull(); // subtree, though empty
    expect(sectionEl(container, "ops")).toBeNull();
    expect(sectionEl(container, "other")).toBeNull();
    expect(container.querySelector('[data-conversation-id="d-row"]')).not.toBeNull();
    // SKYNET is only the path — its own row doesn't match "design".
    expect(container.querySelector('[data-conversation-id="s-row"]')).toBeNull();
  });
});

describe("nested projects: getting out of a hand-edited loop from the menu", () => {
  it("a looped project (drawn at top level) can be cleared with Move to → Top level", async () => {
    // a ↔ b: both drawn at top level, both files name a parent.
    setSnapshot({
      projectSections: [
        { slug: "a", hostId: "1", displayName: "A", rows: [], parentKey: null, depth: 0 },
        { slug: "b", hostId: "1", displayName: "B", rows: [], parentKey: null, depth: 0 },
      ],
    });
    mockProjects = [
      { slug: "a", displayName: "A", hostId: "1", hostname: "hostA", archived: false, parent: "b" },
      { slug: "b", displayName: "B", hostId: "1", hostname: "hostA", archived: false, parent: "a" },
    ];
    const { container } = renderPanel("mobile");
    const menu = await openProjectMoveTo(container, "a");
    const top = within(menu).getByRole("menuitem", { name: "Top level" });
    // The file names b, so Top level is not the current place…
    expect(top.querySelector("svg")).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "B" }).querySelector("svg")).not.toBeNull();
    // …and choosing it clears the parent line.
    await userEvent.setup().click(top);
    expect(setProjectParentSpy).toHaveBeenCalledWith(1, "a", null);
  });

  it("a project whose parent is gone can be cleared with Top level too", async () => {
    setSnapshot({
      projectSections: [
        { slug: "orphan", hostId: "1", displayName: "Orphan", rows: [], parentKey: null, depth: 0 },
      ],
    });
    mockProjects = [
      { slug: "orphan", displayName: "Orphan", hostId: "1", hostname: "hostA", archived: false, parent: "gone" },
    ];
    const { container } = renderPanel();
    const menu = await openProjectMoveTo(container, "orphan");
    await userEvent.setup().click(within(menu).getByRole("menuitem", { name: "Top level" }));
    expect(setProjectParentSpy).toHaveBeenCalledWith(1, "orphan", null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// project-scoped apps: a project's apps are rows under it — below its
// sub-projects, above its conversations — and never in the Apps grid.
// ─────────────────────────────────────────────────────────────────────────────

describe("project apps in the sidebar", () => {
  const projectApp = (slug: string, title: string, project: string): AppState => ({
    hostId: "1",
    slug,
    title,
    description: "",
    port: 9500,
    hasIcon: false,
    createdAtMs: 0,
    isHealthy: true,
    healthMessage: null,
    owner: null,
    project,
  });

  beforeEach(() => {
    resetAppTiles();
    vi.mocked(requestAppMove).mockClear();
  });
  afterEach(() => {
    resetAppTiles();
    endAppDrag();
  });

  it("sit between the project's sub-projects and its conversations, only in their own project", () => {
    seedTree();
    publishAppSnapshot([projectApp("beds", "Beds", "skynet"), { ...projectApp("side", "Side", "skynet"), project: null }]);
    const { container } = renderPanel();
    const skynetContent = contentEl(container, "skynet")!;
    const row = within(skynetContent).getByTestId("pv-project-app-row");
    expect(row.textContent).toContain("Beds");
    const ops = sectionEl(container, "ops")!;
    const sRowEl = skynetContent.querySelector('[data-conversation-id="s-row"]')!;
    expect(ops.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(sRowEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Only in SKYNET itself, not in its sub-projects.
    expect(within(contentEl(container, "design")!).queryAllByTestId("pv-project-app-row")).toHaveLength(0);
    // The Apps grid holds the sidebar app only.
    fireEvent.click(screen.getByTestId("pretty-conversations-apps-header"));
    const tiles = screen.getAllByTestId("pv-app-tile").map((t) => t.getAttribute("data-app-key"));
    expect(tiles).toEqual(["1:side"]);
  });

  it("a project holding only an app shows no empty-state hint", () => {
    seedTree();
    publishAppSnapshot([projectApp("beds", "Beds", "ui")]);
    const { container } = renderPanel();
    expect(within(contentEl(container, "ui")!).queryByTestId("pretty-conversations-project-empty")).toBeNull();
  });

  it("search finds a project app by title, showing its project and the path down to it", () => {
    seedTree();
    publishAppSnapshot([projectApp("beds", "Seed beds", "ui"), projectApp("other-app", "Ledger", "ops")]);
    const { container } = renderPanel();
    const input = container.querySelector('[data-testid="pv-sidebar-search-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "seed" } });
    expect(sectionEl(container, "skynet")).not.toBeNull();
    expect(sectionEl(container, "ui")).not.toBeNull();
    expect(sectionEl(container, "ops")).toBeNull();
    expect(screen.getAllByTestId("pv-project-app-row").map((r) => r.textContent)).toEqual([
      expect.stringContaining("Seed beds"),
    ]);
  });

  it("dropping a project app on the Apps section moves it to the sidebar", () => {
    seedTree();
    publishAppSnapshot([projectApp("beds", "Beds", "skynet")]);
    const { container } = renderPanel();
    const appsSection = container.querySelector(".pv-apps-section") as HTMLElement;
    const store = new Map<string, string>();
    const dt = {
      setData: (t: string, v: string) => store.set(t, v),
      getData: (t: string) => store.get(t) ?? "",
      effectAllowed: "none",
      dropEffect: "none",
      get types() {
        return Array.from(store.keys());
      },
    };
    startAppDrag(dt as unknown as DataTransfer, { hostId: "1", slug: "beds", title: "Beds", owner: null, project: "skynet" });
    const over = createEvent.dragOver(appsSection, { dataTransfer: dt });
    fireEvent(appsSection, over);
    expect(over.defaultPrevented).toBe(true);
    expect(screen.queryByTestId("pv-apps-zone-drop-overlay")).not.toBeNull();
    fireEvent(appsSection, createEvent.drop(appsSection, { dataTransfer: dt }));
    expect(requestAppMove).toHaveBeenCalledWith(1, "beds", { to: "sidebar" }, expect.any(Function));
    // Shown in the sidebar at once.
    expect(within(contentEl(container, "skynet")!).queryAllByTestId("pv-project-app-row")).toHaveLength(0);
  });
});
