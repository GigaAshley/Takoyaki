/**
 * PreferencesAboutYouPane — the About-you section of Preferences.
 *
 * Covers:
 *   (1) ready to type at once (no Edit); Save greyed until changed, then writes
 *   (2) multi-machine: Machine row lists only agent-capable machines, preselects
 *       defaultHostId (else the first), and changing it refetches files
 *   (3) multi-file: switcher renders, first tab labeled "About you", switching lazy-loads
 *   (4) 409 conflict: reload confirm; on confirm editor resets; on cancel inline error
 *   (5) one machine → no Machine row; no agent-capable machines → empty state
 *   (6) single-file → no switcher
 *   (7) empty file → an empty editor, ready to type
 *   (8) Cancel with unsaved writing asks "Discard your changes?"
 *   (9) the registered leave guard asks only while there's unsaved writing
 *   (10) shared machine / own file with text → "Yours" above "Everyone on <machine>",
 *        each saving only its own file; a one-person machine shows neither
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import type { Host } from "@/types/ui-types";
import type { HostFolder } from "@/types/ui-types";
import { GlobalFileMtimeConflictError } from "@/api/global-files-api";

// ── Module mocks (hoisted — must appear before imports of the mocked modules) ──

// Stub MarkdownEditor with a controlled textarea so getByRole("textbox") works.
// Mirrors the mock in GlobalFilesModal.test.tsx.
vi.mock("@/features/pretty-view/MarkdownEditor", () => ({
  MarkdownEditor: (props: { content: string; onChange: (v: string) => void; disabled?: boolean; filename?: string }) => (
    <textarea
      data-testid="mock-editor"
      value={props.content}
      onChange={(e) => props.onChange(e.target.value)}
      disabled={props.disabled}
    />
  ),
}));

vi.mock("@/api/global-files-api", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    listAboutYouFiles: vi.fn(),
    readGlobalFile: vi.fn(),
    writeGlobalFile: vi.fn(),
  };
});

// ── Late imports (after mocks are registered) ────────────────────────────────

import { PreferencesAboutYouPane } from "./PreferencesAboutYouPane";
import { __resetKitDialogsForTests, autoAnswerKitDialogs } from "@/components/kit";
import {
  listAboutYouFiles,
  readGlobalFile,
  writeGlobalFile,
} from "@/api/global-files-api";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function host(id: string, name: string, canHostAgents = true): Host {
  return {
    id,
    name,
    enableRdp: false,
    enableSsh: true,
    enableTerminal: true,
    enableTunnel: false,
    enableFileManager: false,
    enableDocker: false,
    enableVnc: false,
    enableTelnet: false,
    username: "ubuntu",
    ip: `10.0.0.${id}`,
    port: 22,
    folder: "",
    online: true,
    cpu: null,
    ram: null,
    lastAccess: "",
    authType: "key",
    serverTunnels: [],
    quickActions: [],
    sshPort: 22,
    rdpPort: 3389,
    vncPort: 5900,
    telnetPort: 23,
    canHostAgents,
  } as Host;
}

const SINGLE_HOST_TREE: HostFolder = {
  name: "root",
  children: [host("1", "boreal")],
};

const MULTI_HOST_TREE: HostFolder = {
  name: "root",
  children: [host("1", "host-alpha"), host("2", "host-beta")],
};

const SINGLE_FILE_ENTRY = [{ path: "~/.claude/CLAUDE.md", label: "User CLAUDE.md" }];
const MULTI_FILE_ENTRIES = [
  { path: "~/.claude/CLAUDE.md", label: "User CLAUDE.md" },
  { path: "~/.claude/projects.md", label: "Projects" },
];

const PERSON_PATH = "~/fleet/people/amy.md";

function listing(files: { path: string; label?: string }[], extra: { personFile?: string | null; multiUser?: boolean } = {}) {
  return { files, personFile: extra.personFile === undefined ? PERSON_PATH : extra.personFile, multiUser: extra.multiUser ?? false };
}

/** Reads: the person's own file has `person` in it, everything else `machine`. */
function files(machine: string, person = ""): void {
  vi.mocked(readGlobalFile).mockImplementation(async (_hostId, path) => ({
    content: path === PERSON_PATH ? person : machine,
    mtime: 1_700_000_000,
    size: 10,
  }));
}

/** The machine's file in its editor, once loaded. */
async function machineEditor(expected = "My preferences content"): Promise<HTMLTextAreaElement> {
  const area = await screen.findByTestId("preferences-about-you-editor");
  const editor = area.querySelector("textarea") as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toBe(expected));
  return editor;
}

async function personEditor(expected: string): Promise<HTMLTextAreaElement> {
  const area = await screen.findByTestId("preferences-about-you-person-editor");
  const editor = area.querySelector("textarea") as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toBe(expected));
  return editor;
}

/** A user edit: the pane only counts changes after the user touches the
 *  editor (the rich editor re-serialises the file on load). */
function typeInto(editor: HTMLTextAreaElement, value: string): void {
  fireEvent.keyDown(editor, { key: "a" });
  fireEvent.change(editor, { target: { value } });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PreferencesAboutYouPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAboutYouFiles).mockResolvedValue(listing(SINGLE_FILE_ENTRY));
    files("My preferences content");
    vi.mocked(writeGlobalFile).mockResolvedValue({ mtime: 1_700_000_001 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetKitDialogsForTests();
  });

  // ── Case 1: ready to type → Save ───────────────────────────────────────────

  it("(1) opens ready to type, no Edit; Save stays greyed until changed, then writes", async () => {
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);

    const editor = await machineEditor();
    expect(screen.queryByTestId("preferences-about-you-edit")).toBeNull();
    const saveBtn = screen.getByTestId("preferences-about-you-save") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    expect((screen.getByTestId("preferences-about-you-cancel") as HTMLButtonElement).disabled).toBe(true);

    typeInto(editor, "Updated content");
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(vi.mocked(writeGlobalFile)).toHaveBeenCalledWith({
        hostId: 1,
        path: "~/.claude/CLAUDE.md",
        content: "Updated content",
        expectedMtime: 1_700_000_000,
      }),
    );
    // Still ready to type, now with nothing unsaved.
    await waitFor(() => expect(saveBtn.disabled).toBe(true));
    expect(editor.value).toBe("Updated content");
  });

  it("(1b) the editor's own re-write of the file on load doesn't count as a change", async () => {
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);
    const editor = await machineEditor();
    // Untouched: the editor normalising the text isn't the user's change.
    fireEvent.change(editor, { target: { value: "My preferences content\n" } });
    expect((screen.getByTestId("preferences-about-you-save") as HTMLButtonElement).disabled).toBe(true);
  });

  // ── Case 2: multi-machine ──────────────────────────────────────────────────

  it("(2) Machine row: preselects defaultHostId; changing it refetches files", async () => {
    vi.mocked(listAboutYouFiles).mockImplementation(async (hostId: number) =>
      listing(hostId === 1 ? [{ path: "~/.claude/CLAUDE.md" }] : [{ path: "~/.config/notes.md" }]),
    );
    render(<PreferencesAboutYouPane hostTree={MULTI_HOST_TREE} defaultHostId={2} />);

    const picker = await screen.findByTestId("preferences-about-you-host-picker");
    const select = picker.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("2");
    await waitFor(() => expect(vi.mocked(listAboutYouFiles)).toHaveBeenCalledWith(2));
    expect(vi.mocked(listAboutYouFiles)).not.toHaveBeenCalledWith(1);

    fireEvent.change(select, { target: { value: "1" } });
    await waitFor(() => expect(vi.mocked(listAboutYouFiles)).toHaveBeenCalledWith(1));
  });

  it("(2b) without defaultHostId the first machine is chosen — never an empty picker", async () => {
    render(<PreferencesAboutYouPane hostTree={MULTI_HOST_TREE} defaultHostId={null} />);
    const picker = await screen.findByTestId("preferences-about-you-host-picker");
    expect((picker.querySelector("select") as HTMLSelectElement).value).toBe("1");
    await waitFor(() => expect(vi.mocked(listAboutYouFiles)).toHaveBeenCalledWith(1));
    await machineEditor();
  });

  it("(2c) lists only machines that can run agents; a defaultHostId that can't is ignored", async () => {
    const tree: HostFolder = {
      name: "root",
      children: [
        host("1", "nas", false),
        { name: "lab", children: [host("2", "agent-a"), { ...host("3", "printer"), canHostAgents: undefined }] },
        host("4", "agent-b"),
      ],
    };
    render(<PreferencesAboutYouPane hostTree={tree} defaultHostId={1} />);
    const picker = await screen.findByTestId("preferences-about-you-host-picker");
    const select = picker.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["agent-a", "agent-b"]);
    expect(select.value).toBe("2");
    await waitFor(() => expect(vi.mocked(listAboutYouFiles)).toHaveBeenCalledWith(2));
    expect(vi.mocked(listAboutYouFiles)).not.toHaveBeenCalledWith(1);
  });

  it("(2d) switching machine with unsaved writing asks first; Keep editing stays", async () => {
    const dialogs = autoAnswerKitDialogs({ confirm: false });
    render(<PreferencesAboutYouPane hostTree={MULTI_HOST_TREE} defaultHostId={1} />);
    const editor = await machineEditor();
    typeInto(editor, "draft");
    const select = screen
      .getByTestId("preferences-about-you-host-picker")
      .querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "2" } });
    await waitFor(() => expect(dialogs.calls).toHaveLength(1));
    expect(dialogs.calls[0].opts.title).toBe("Discard your changes?");
    expect(vi.mocked(listAboutYouFiles)).not.toHaveBeenCalledWith(2);
    expect(editor.value).toBe("draft");
  });

  // ── Case 3: multi-file ─────────────────────────────────────────────────────

  it("(3) multi-file: switcher renders; first tab labeled 'About you'; switching lazy-loads", async () => {
    vi.mocked(listAboutYouFiles).mockResolvedValue(listing(MULTI_FILE_ENTRIES));
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);

    const firstTab = await screen.findByTestId(
      `preferences-about-you-tab-${MULTI_FILE_ENTRIES[0].path}`,
    );
    expect(firstTab.textContent).toBe("About you");
    const secondTab = screen.getByTestId(`preferences-about-you-tab-${MULTI_FILE_ENTRIES[1].path}`);
    expect(secondTab.textContent).toBe("Projects");

    fireEvent.click(secondTab);
    await waitFor(() =>
      expect(vi.mocked(readGlobalFile)).toHaveBeenCalledWith(1, "~/.claude/projects.md"),
    );
  });

  // ── Case 4: 409 conflict ───────────────────────────────────────────────────

  it("(4) 409 conflict: asks to reload; on confirm the editor resets to the disk version", async () => {
    vi.mocked(writeGlobalFile).mockRejectedValue(
      new GlobalFileMtimeConflictError(1_700_000_002, "Server version of the file"),
    );
    const dialogs = autoAnswerKitDialogs({ confirm: true });
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);

    const editor = await machineEditor();
    typeInto(editor, "My local edits");
    fireEvent.click(screen.getByTestId("preferences-about-you-save"));

    await waitFor(() => expect(dialogs.calls).toHaveLength(1));
    expect(dialogs.calls[0].kind).toBe("confirm");
    expect(dialogs.calls[0].opts.title).toBe("Reload from disk?");
    expect(String(dialogs.calls[0].opts.body)).toMatch(/changed on disk.*loses your local edits/);
    await waitFor(() => expect(editor.value).toBe("Server version of the file"));
  });

  it("(4b) 409 conflict, keep my edits: the draft stays and an inline note shows", async () => {
    vi.mocked(writeGlobalFile).mockRejectedValue(
      new GlobalFileMtimeConflictError(1_700_000_002, "Server version of the file"),
    );
    const dialogs = autoAnswerKitDialogs({ confirm: false });
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);

    const editor = await machineEditor();
    typeInto(editor, "My local edits");
    fireEvent.click(screen.getByTestId("preferences-about-you-save"));

    await waitFor(() => expect(dialogs.calls).toHaveLength(1));
    await screen.findByTestId("preferences-about-you-save-error");
    expect(editor.value).toBe("My local edits");
  });

  it("(4c) keep my edits, then Save again: overwrites the newer file", async () => {
    vi.mocked(writeGlobalFile)
      .mockRejectedValueOnce(new GlobalFileMtimeConflictError(1_700_000_002, "Server version of the file"))
      .mockResolvedValueOnce({ mtime: 1_700_000_003 });
    autoAnswerKitDialogs({ confirm: false });
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);

    const editor = await machineEditor();
    typeInto(editor, "My local edits");
    fireEvent.click(screen.getByTestId("preferences-about-you-save"));
    await screen.findByTestId("preferences-about-you-save-error");

    fireEvent.click(screen.getByTestId("preferences-about-you-save"));
    await waitFor(() =>
      expect(vi.mocked(writeGlobalFile)).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: "My local edits", expectedMtime: 1_700_000_002 }),
      ),
    );
    await waitFor(() => expect(screen.queryByTestId("preferences-about-you-save-error")).toBeNull());
  });

  it("(4d) the machine changes under a draft (list refreshed): the draft goes, nothing is saved", async () => {
    vi.mocked(readGlobalFile).mockImplementation(async (hostId) => ({
      content: hostId === 2 ? "beta file" : "alpha file",
      mtime: 1_700_000_000,
      size: 10,
    }));
    const { rerender } = render(
      <PreferencesAboutYouPane hostTree={MULTI_HOST_TREE} defaultHostId={2} />,
    );
    const editor = await machineEditor("beta file");
    typeInto(editor, "Written for host-beta");
    // host-beta can no longer run agents → the window falls back to host-alpha.
    rerender(
      <PreferencesAboutYouPane
        hostTree={{ name: "root", children: [host("1", "host-alpha"), host("2", "host-beta", false)] }}
        defaultHostId={2}
      />,
    );
    await waitFor(() => expect(vi.mocked(listAboutYouFiles)).toHaveBeenCalledWith(1));
    await machineEditor("alpha file");
    expect((screen.getByTestId("preferences-about-you-save") as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(writeGlobalFile)).not.toHaveBeenCalled();
  });

  // ── Case 5: machine row visibility ─────────────────────────────────────────

  it("(5) one machine: no Machine row", async () => {
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);
    await machineEditor();
    expect(screen.queryByTestId("preferences-about-you-host-picker")).toBeNull();
  });

  it("(5b) no machine can run agents: says so instead of a picker", async () => {
    const tree: HostFolder = { name: "root", children: [host("1", "nas", false)] };
    render(<PreferencesAboutYouPane hostTree={tree} defaultHostId={null} />);
    expect(screen.getByText("No machines can run agents yet")).toBeTruthy();
    expect(screen.queryByTestId("preferences-about-you-host-picker")).toBeNull();
    expect(vi.mocked(listAboutYouFiles)).not.toHaveBeenCalled();
  });

  // ── Case 6: single file ────────────────────────────────────────────────────

  it("(6) single-file: no switcher", async () => {
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);
    await machineEditor();
    expect(
      screen.queryByTestId(`preferences-about-you-tab-${SINGLE_FILE_ENTRY[0].path}`),
    ).toBeNull();
  });

  // ── Case 7: empty file ─────────────────────────────────────────────────────

  it("(7) empty file: an empty editor, ready to type", async () => {
    files("");
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);
    const editor = await machineEditor("");
    expect(screen.queryByText("Nothing written yet")).toBeNull();
    typeInto(editor, "I like tea");
    fireEvent.click(screen.getByTestId("preferences-about-you-save"));
    await waitFor(() =>
      expect(vi.mocked(writeGlobalFile)).toHaveBeenCalledWith(
        expect.objectContaining({ content: "I like tea" }),
      ),
    );
  });

  // ── Case 8: discard prompt ─────────────────────────────────────────────────

  it("(8) Cancel with unsaved writing asks; Keep editing stays, Discard puts back what's saved", async () => {
    const answers = [false, true];
    const dialogs = autoAnswerKitDialogs({ confirm: () => answers.shift() ?? false });
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);
    const editor = await machineEditor();
    typeInto(editor, "half a thought");

    fireEvent.click(screen.getByTestId("preferences-about-you-cancel"));
    await waitFor(() => expect(dialogs.calls).toHaveLength(1));
    expect(dialogs.calls[0].opts.title).toBe("Discard your changes?");
    expect(editor.value).toBe("half a thought");

    fireEvent.click(screen.getByTestId("preferences-about-you-cancel"));
    await waitFor(() => expect(editor.value).toBe("My preferences content"));
    expect(vi.mocked(writeGlobalFile)).not.toHaveBeenCalled();
  });

  // ── Case 9: leave guard ────────────────────────────────────────────────────

  it("(9) the leave guard lets the window go freely unless there's unsaved writing", async () => {
    const dialogs = autoAnswerKitDialogs({ confirm: false });
    const guardRef: { current: (() => Promise<boolean>) | null } = { current: null };
    const registerLeaveGuard = vi.fn((g: (() => Promise<boolean>) | null) => {
      guardRef.current = g;
    });
    const { unmount } = render(
      <PreferencesAboutYouPane
        hostTree={SINGLE_HOST_TREE}
        defaultHostId={1}
        registerLeaveGuard={registerLeaveGuard}
      />,
    );
    const editor = await machineEditor();
    expect(guardRef.current).not.toBeNull();
    // Nothing typed: nothing to lose.
    await act(async () => expect(await guardRef.current!()).toBe(true));
    expect(dialogs.calls).toHaveLength(0);

    typeInto(editor, "draft");
    await act(async () => expect(await guardRef.current!()).toBe(false));
    expect(dialogs.calls).toHaveLength(1);
    expect(dialogs.calls[0].opts.title).toBe("Discard your changes?");

    unmount();
    expect(registerLeaveGuard).toHaveBeenLastCalledWith(null);
  });

  // ── Case 10: the person's own area ─────────────────────────────────────────

  it("(10) a one-person machine with no file of your own: one area, nothing about other people", async () => {
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);
    await machineEditor();
    await waitFor(() => expect(vi.mocked(readGlobalFile)).toHaveBeenCalledWith(1, PERSON_PATH));
    expect(screen.queryByTestId("preferences-about-you-person")).toBeNull();
    expect(screen.queryByText("Yours")).toBeNull();
    expect(screen.queryByText(/Everyone on/)).toBeNull();
    expect(screen.getByTestId("preferences-about-you-save")).toBeTruthy();
  });

  it("(10b) a shared machine: Yours above Everyone on <machine>, each saving only its own file", async () => {
    vi.mocked(listAboutYouFiles).mockResolvedValue(listing(SINGLE_FILE_ENTRY, { multiUser: true }));
    files("Machine-wide notes", "Amy likes tea");
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);

    const mine = await personEditor("Amy likes tea");
    const machine = await machineEditor("Machine-wide notes");
    const person = screen.getByTestId("preferences-about-you-person");
    const everyone = screen.getByTestId("preferences-about-you-machine");
    expect(person.compareDocumentPosition(everyone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("preferences-about-you-person-heading").textContent).toBe(
      "YoursRead by the agents shared with you on this machine.",
    );
    expect(screen.getByTestId("preferences-about-you-machine-heading").textContent).toBe(
      "Everyone on borealRead by every agent on this machine, whoever they work for.",
    );

    typeInto(mine, "Amy likes coffee now");
    const personSave = screen.getByTestId("preferences-about-you-person-save") as HTMLButtonElement;
    const machineSave = screen.getByTestId("preferences-about-you-save") as HTMLButtonElement;
    expect(machineSave.disabled).toBe(true);
    fireEvent.click(personSave);
    await waitFor(() =>
      expect(vi.mocked(writeGlobalFile)).toHaveBeenCalledWith({
        hostId: 1,
        path: PERSON_PATH,
        content: "Amy likes coffee now",
        expectedMtime: 1_700_000_000,
      }),
    );
    expect(vi.mocked(writeGlobalFile)).toHaveBeenCalledTimes(1);
    expect(machine.value).toBe("Machine-wide notes");

    typeInto(machine, "Everyone: be kind");
    fireEvent.click(machineSave);
    await waitFor(() =>
      expect(vi.mocked(writeGlobalFile)).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: "~/.claude/CLAUDE.md", content: "Everyone: be kind" }),
      ),
    );
  });

  it("(10c) a one-person machine where your own file says something: both areas", async () => {
    files("Machine-wide notes", "Left over from when this was shared");
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);
    await personEditor("Left over from when this was shared");
    expect(screen.getByTestId("preferences-about-you-machine-heading").textContent).toContain(
      "Everyone on boreal",
    );
  });

  it("(10d) clearing your own file and saving keeps the area until you next open About you", async () => {
    files("Machine-wide notes", "Something");
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);
    const mine = await personEditor("Something");
    typeInto(mine, "");
    fireEvent.click(screen.getByTestId("preferences-about-you-person-save"));
    await waitFor(() => expect(vi.mocked(writeGlobalFile)).toHaveBeenCalled());
    expect(screen.getByTestId("preferences-about-you-person")).toBeTruthy();
  });

  it("(10e) unsaved writing in your own area holds the window", async () => {
    vi.mocked(listAboutYouFiles).mockResolvedValue(listing(SINGLE_FILE_ENTRY, { multiUser: true }));
    files("Machine-wide notes", "");
    const dialogs = autoAnswerKitDialogs({ confirm: false });
    const guardRef: { current: (() => Promise<boolean>) | null } = { current: null };
    render(
      <PreferencesAboutYouPane
        hostTree={SINGLE_HOST_TREE}
        defaultHostId={1}
        registerLeaveGuard={(g) => (guardRef.current = g)}
      />,
    );
    const mine = await personEditor("");
    typeInto(mine, "draft");
    await act(async () => expect(await guardRef.current!()).toBe(false));
    expect(dialogs.calls[0].opts.title).toBe("Discard your changes?");
  });

  it("(10f) no person file known (username unreadable): the machine's file alone", async () => {
    vi.mocked(listAboutYouFiles).mockResolvedValue(
      listing(SINGLE_FILE_ENTRY, { personFile: null, multiUser: true }),
    );
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);
    await machineEditor();
    expect(screen.queryByTestId("preferences-about-you-person")).toBeNull();
    expect(vi.mocked(readGlobalFile)).not.toHaveBeenCalledWith(1, PERSON_PATH);
  });

  it("(10h) nothing to type in until your own file has loaded, so the layout never swaps mid-typing", async () => {
    let finishPerson: (v: { content: string; mtime: number; size: number }) => void = () => {};
    vi.mocked(readGlobalFile).mockImplementation((_hostId, path) =>
      path === PERSON_PATH
        ? new Promise((r) => (finishPerson = r))
        : Promise.resolve({ content: "Machine-wide notes", mtime: 1, size: 5 }),
    );
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);
    await waitFor(() => expect(vi.mocked(readGlobalFile)).toHaveBeenCalledWith(1, PERSON_PATH));
    expect(screen.queryByTestId("preferences-about-you-editor")).toBeNull();
    await act(async () => finishPerson({ content: "Mine", mtime: 1, size: 4 }));
    await personEditor("Mine");
    await machineEditor("Machine-wide notes");
  });

  it("(10i) a save still running when another file opens doesn't land on that file", async () => {
    vi.mocked(listAboutYouFiles).mockResolvedValue(listing(MULTI_FILE_ENTRIES));
    vi.mocked(readGlobalFile).mockImplementation(async (_hostId, path) => ({
      content: path === PERSON_PATH ? "" : `content of ${path}`,
      mtime: 1_700_000_000,
      size: 20,
    }));
    let finishSave: (v: { mtime: number }) => void = () => {};
    vi.mocked(writeGlobalFile).mockImplementation(() => new Promise((r) => (finishSave = r)));
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);
    const editor = await machineEditor("content of ~/.claude/CLAUDE.md");
    typeInto(editor, "first file, edited");
    fireEvent.click(screen.getByTestId("preferences-about-you-save"));
    // The file tabs are locked while the save runs.
    const second = screen.getByTestId(`preferences-about-you-tab-${MULTI_FILE_ENTRIES[1].path}`);
    await waitFor(() => expect((second as HTMLButtonElement).disabled).toBe(true));
    await act(async () => finishSave({ mtime: 1_700_000_005 }));
    await waitFor(() => expect((second as HTMLButtonElement).disabled).toBe(false));
  });

  // ── Header ─────────────────────────────────────────────────────────────────

  it("opens with a header saying what the section is for", () => {
    render(<PreferencesAboutYouPane hostTree={SINGLE_HOST_TREE} defaultHostId={1} />);
    const hero = screen.getByTestId("preferences-section-hero");
    expect(hero.textContent).toContain("About you");
    expect(hero.textContent).toContain("Every agent you start on this machine reads this first");
  });
});
