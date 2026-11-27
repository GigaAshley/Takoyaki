/**
 * In-process flow: a machine's status reports arrive (the machine-changes frame), and the
 * sidebar pieces show what the person should see — waiting marks, a failure mark they can
 * open and dismiss, one-time pop-ups for notices with no row (claimed first), and greyed
 * "Coming back…" rows that give way to the real row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";

const http = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/main-axios", () => ({
  authApi: { post: http.post, get: vi.fn(), put: vi.fn() },
  handleApiError: (e: unknown) => {
    throw e;
  },
}));

const ids = vi.hoisted(() => ({ byHostKey: new Map<string, unknown>(), loaded: true }));
vi.mock("@/state/identities-store", () => ({
  useIdentities: () => ({ identities: [], byKey: new Map(), byHostKey: ids.byHostKey, loaded: ids.loaded, refresh: async () => {} }),
}));

import { __resetKitDialogsForTests, autoAnswerKitDialogs } from "@/components/kit/dialogs";
import { __resetMachineChangesForTest, setMachineChanges, useMachineMark, type MachineChange } from "@/state/machine-changes-store";
import { __resetProjectsForTest, setProjects } from "@/state/conversation-store";
import { MachineChangeMark } from "./MachineChangeMark";
import { MachineNoticePopups } from "./MachineNoticePopups";
import { ComingBackRows } from "./ComingBackRows";

const change = (over: Partial<MachineChange>): MachineChange => ({
  id: "r1",
  kind: "agent-project",
  state: "waiting",
  target: { type: "agent", name: "finch" },
  at: 1,
  mine: false,
  ...over,
});

function AgentMark({ name }: { name: string }) {
  const mark = useMachineMark(1, "agent", name);
  return (
    <div data-testid={`row-${name}`} data-machine-mark={mark?.kind}>
      <MachineChangeMark mark={mark} hostId={1} thing={name === "finch" ? "Finch" : name} />
    </div>
  );
}

beforeEach(() => {
  __resetMachineChangesForTest();
  __resetProjectsForTest();
  setProjects([
    { slug: "garden", displayName: "Garden", hostId: "1", hostname: "box", archived: false, parent: null },
  ]);
  ids.byHostKey = new Map();
  ids.loaded = true;
  http.post.mockReset();
  http.post.mockResolvedValue({ data: { first: true } });
});

afterEach(() => {
  cleanup();
  __resetKitDialogsForTests();
});

describe("waiting marks", () => {
  it("a waiting move says where it's going; a waiting archive greys the row; both go once the machine is done", () => {
    render(<><AgentMark name="finch" /><AgentMark name="wren" /></>);
    act(() =>
      setMachineChanges("1", [
        change({ to: { project: "garden" } }),
        change({ id: "r2", kind: "agent-archive", target: { type: "agent", name: "wren" } }),
      ]),
    );
    expect(screen.getByTestId("row-finch").textContent).toBe("Moving to Garden…");
    expect(screen.getByTestId("row-wren").getAttribute("data-machine-mark")).toBe("archiving");
    expect(screen.getByTestId("row-wren").textContent).toBe("Archiving…");
    act(() => setMachineChanges("1", []));
    expect(screen.getByTestId("row-finch").textContent).toBe("");
    expect(screen.getByTestId("row-wren").getAttribute("data-machine-mark")).toBeNull();
  });

  it("a destination hidden from them is never named; a pin goes to Pinned", () => {
    render(<><AgentMark name="finch" /><AgentMark name="wren" /></>);
    act(() =>
      setMachineChanges("1", [
        change({ to: { hidden: true } }),
        change({ id: "p", kind: "agent-pin", to: { pinned: true }, target: { type: "agent", name: "wren" } }),
      ]),
    );
    expect(screen.getByTestId("row-finch").textContent).toBe("Moving…");
    expect(screen.getByTestId("row-wren").textContent).toBe("Moving to Pinned…");
  });

  it("a rename waiting its turn shows nothing", () => {
    render(<AgentMark name="finch" />);
    act(() => setMachineChanges("1", [change({ kind: "agent-edit" })]));
    expect(screen.getByTestId("row-finch").textContent).toBe("");
  });
});

describe("failure marks", () => {
  it("tapping shows why; Dismiss clears it on every device (the server is told)", async () => {
    const dialogs = autoAnswerKitDialogs({ confirm: true });
    render(<AgentMark name="finch" />);
    act(() => setMachineChanges("1", [change({ state: "refused", mine: true, reason: "that project is gone" })]));
    const mark = screen.getByTestId("pv-machine-mark-failed");
    expect(mark.textContent).toBe("Couldn't move");
    fireEvent.click(mark);
    await waitFor(() => expect(http.post).toHaveBeenCalledWith("/machine-changes/1/r1/seen", {}));
    expect(dialogs.calls[0].opts.title).toBe("Couldn't move Finch");
    expect(dialogs.calls[0].opts.body).toBe("That project is gone.");
    // The server sends the list again without it.
    act(() => setMachineChanges("1", []));
    expect(screen.queryByTestId("pv-machine-mark-failed")).toBeNull();
  });

  it("Keep leaves it", async () => {
    const dialogs = autoAnswerKitDialogs({ confirm: false });
    render(<AgentMark name="finch" />);
    act(() => setMachineChanges("1", [change({ state: "failed", mine: true, reason: "disk full" })]));
    fireEvent.click(screen.getByTestId("pv-machine-mark-failed"));
    await waitFor(() => expect(dialogs.calls).toHaveLength(1));
    expect(http.post).not.toHaveBeenCalled();
  });

  it("a new agent left out of its project says so", async () => {
    const dialogs = autoAnswerKitDialogs({ confirm: false });
    render(<AgentMark name="finch" />);
    act(() => setMachineChanges("1", [change({ state: "unfiled", mine: true, reason: "that project is gone" })]));
    expect(screen.getByTestId("pv-machine-mark-failed").textContent).toBe("Not filed");
    fireEvent.click(screen.getByTestId("pv-machine-mark-failed"));
    await waitFor(() => expect(dialogs.calls).toHaveLength(1));
    expect(dialogs.calls[0].opts.title).toBe("Finch is in Conversations");
  });
});

describe("pop-ups for notices with no row", () => {
  it("a project that was never made pops up once, after this device claims it", async () => {
    const dialogs = autoAnswerKitDialogs({});
    render(<MachineNoticePopups />);
    const failed = change({
      id: "c1",
      kind: "project-create",
      state: "refused",
      mine: true,
      target: { type: "project", name: null, displayName: "Ops" },
      reason: "that name is too long",
    });
    act(() => setMachineChanges("1", [failed]));
    await waitFor(() => expect(dialogs.calls).toHaveLength(1));
    expect(http.post).toHaveBeenCalledWith("/machine-changes/1/c1/seen", {});
    expect(dialogs.calls[0].opts.title).toBe('Couldn\'t make the project "Ops"');
    // Re-sent unchanged: never asked or shown twice.
    act(() => setMachineChanges("1", [failed, change({ id: "x" })]));
    await Promise.resolve();
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(dialogs.calls).toHaveLength(1);
  });

  it("another device claimed it first: nothing shows here", async () => {
    http.post.mockResolvedValue({ data: { first: false } });
    const dialogs = autoAnswerKitDialogs({});
    render(<MachineNoticePopups />);
    act(() =>
      setMachineChanges("1", [
        change({ id: "u1", kind: "agent-unarchive", state: "refused", mine: true, target: { type: "agent", name: "wren" } }),
      ]),
    );
    await waitFor(() => expect(http.post).toHaveBeenCalled());
    await Promise.resolve();
    expect(dialogs.calls).toHaveLength(0);
  });

  it("a failure about something with a row is that row's mark, not a pop-up", async () => {
    ids.byHostKey = new Map([["1::finch", {}]]);
    autoAnswerKitDialogs({});
    render(<MachineNoticePopups />);
    act(() => setMachineChanges("1", [change({ state: "refused", mine: true })]));
    await Promise.resolve();
    expect(http.post).not.toHaveBeenCalled();
  });

  it("an archive stuck 10 minutes: one pop-up for everything it took, with why", async () => {
    const dialogs = autoAnswerKitDialogs({});
    render(<MachineNoticePopups />);
    act(() =>
      setMachineChanges("1", [
        change({ id: "a1", kind: "project-archive", state: "stuck", mine: true, target: { type: "agent", name: "finch" }, reason: "couldn't switch the chat account off" }),
        change({ id: "a1", kind: "project-archive", state: "stuck", mine: true, target: { type: "agent", name: "wren" }, reason: "couldn't switch the chat account off" }),
      ]),
    );
    await waitFor(() => expect(dialogs.calls).toHaveLength(1));
    expect(http.post).toHaveBeenCalledWith("/machine-changes/1/a1%3Astuck/seen", {});
    expect(dialogs.calls[0].opts.title).toBe("Archiving finch and wren is still finishing");
    expect(dialogs.calls[0].opts.body).toBe("Couldn't switch the chat account off. It keeps retrying on its own.");
  });

  it("waits for the agent list before deciding a row is missing", async () => {
    ids.loaded = false;
    render(<MachineNoticePopups />);
    act(() => setMachineChanges("1", [change({ state: "refused", mine: true })]));
    await Promise.resolve();
    expect(http.post).not.toHaveBeenCalled();
  });
});

describe("coming back", () => {
  const back = (project: string | null) =>
    change({ id: "u1", kind: "agent-unarchive", state: "returning", target: { type: "agent", name: "wren" }, card: { displayName: "Wren", project } });

  it("a greyed row where it'll land, until it's back", () => {
    const { rerender } = render(
      <>
        <div data-testid="garden"><ComingBackRows project="garden" hostId="1" variant="desktop" /></div>
        <div data-testid="conversations"><ComingBackRows project={null} variant="desktop" /></div>
      </>,
    );
    act(() => setMachineChanges("1", [back("garden")]));
    expect(screen.getByTestId("garden").textContent).toContain("Wren");
    expect(screen.getByTestId("garden").textContent).toContain("Coming back…");
    expect(screen.getByTestId("conversations").textContent).toBe("");
    // Back: its real row takes over.
    ids.byHostKey = new Map([["1::wren", {}]]);
    rerender(
      <>
        <div data-testid="garden"><ComingBackRows project="garden" hostId="1" variant="desktop" /></div>
        <div data-testid="conversations"><ComingBackRows project={null} variant="desktop" /></div>
      </>,
    );
    expect(screen.getByTestId("garden").textContent).toBe("");
  });

  it("a project that's gone or hidden lands it in Conversations", () => {
    render(<div data-testid="conversations"><ComingBackRows project={null} variant="desktop" /></div>);
    act(() => setMachineChanges("1", [back("secret")]));
    expect(screen.getByTestId("conversations").textContent).toContain("Coming back…");
    // Refused partway: it drops out of the machine's list, and the row goes.
    act(() => setMachineChanges("1", []));
    expect(screen.getByTestId("conversations").textContent).toBe("");
  });
});
