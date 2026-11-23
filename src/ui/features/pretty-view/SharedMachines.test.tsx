/**
 * The machine picker for shared roles and skills, and the dialogs around it:
 * every machine ticked one by one, machines losing it (with the agents there),
 * same-named folders being replaced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

const kit = vi.hoisted(() => ({
  confirm: vi.fn<(opts: { title: ReactNode; body?: ReactNode; confirmLabel?: string; cancelLabel?: string }) => Promise<boolean>>(),
  alert: vi.fn(async () => {}),
}));
vi.mock("@/components/kit", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  kitConfirm: (opts: Parameters<typeof kit.confirm>[0]) => kit.confirm(opts),
  kitAlert: (...a: unknown[]) => kit.alert(...(a as [])),
}));

const api = vi.hoisted(() => ({
  listSharedMachines: vi.fn(),
  previewMachines: vi.fn(),
  saveMachines: vi.fn(),
  previewPromote: vi.fn(),
  promote: vi.fn(),
}));
vi.mock("@/api/instance-wide-api", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  listSharedMachines: (...a: unknown[]) => api.listSharedMachines(...a),
  previewMachines: (...a: unknown[]) => api.previewMachines(...a),
  saveMachines: (...a: unknown[]) => api.saveMachines(...a),
  previewPromote: (...a: unknown[]) => api.previewPromote(...a),
  promote: (...a: unknown[]) => api.promote(...a),
}));

import { MachineListsEditor, editSharedMachines, shareWithMachines } from "./SharedMachines";
import type { SharedLists, SharedMachine } from "@/api/instance-wide-api";

const MACHINES: SharedMachine[] = [
  { machineId: "1", hostName: "alpha", hostRowIds: ["1"], offline: false },
  { machineId: "2", hostName: "beta", hostRowIds: ["2", "5"], offline: false },
  { machineId: "3", hostName: "gamma", hostRowIds: ["3"], offline: true },
];

const gets = (id: string) => screen.getByTestId(`shared-machines-gets-${id}`) as HTMLInputElement;
const writes = (id: string) => screen.getByTestId(`shared-machines-writeback-${id}`) as HTMLInputElement;
const every = () => screen.getByTestId("shared-machines-every") as HTMLInputElement;

/** Answer the picker dialog by rendering it and running `pick` on it. */
function answerPicker(pick: () => void): void {
  kit.confirm.mockImplementationOnce(async (opts) => {
    render(<>{opts.body}</>);
    pick();
    return true;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  kit.confirm.mockReset();
  api.listSharedMachines.mockResolvedValue(MACHINES);
  api.previewMachines.mockResolvedValue({ clashes: [], unreachable: [] });
  api.saveMachines.mockImplementation(async (_k: string, _n: string, lists: SharedLists) => lists);
  api.previewPromote.mockResolvedValue({ files: 1, bytes: 10, tooLarge: false, clashes: [], unreachable: [], sourceHostName: "alpha" });
  api.promote.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe("MachineListsEditor", () => {
  function renderEditor(initial: SharedLists, pinnedMachineId?: string) {
    const onChange = vi.fn();
    render(<MachineListsEditor machines={MACHINES} initial={initial} onChange={onChange} pinnedMachineId={pinnedMachineId} />);
    return onChange;
  }

  it("every machine: every Gets it is ticked and fixed; Writes back is free; offline machines say so", () => {
    const onChange = renderEditor({ targets: "all", writeBack: [] });
    expect(every().checked).toBe(true);
    for (const id of ["1", "2", "3"]) {
      expect(gets(id).checked).toBe(true);
      expect(gets(id).disabled).toBe(true);
    }
    expect(screen.getByTestId("shared-machines-row-3").textContent).toContain("offline");
    fireEvent.click(writes("3"));
    expect(onChange).toHaveBeenLastCalledWith({ targets: "all", writeBack: ["3"] });
  });

  it("turning every machine off starts from every machine ticked; unticking one drops its write-back", () => {
    const onChange = renderEditor({ targets: "all", writeBack: ["2"] });
    fireEvent.click(every());
    expect(onChange).toHaveBeenLastCalledWith({ targets: ["1", "2", "3"], writeBack: ["2"] });
    fireEvent.click(gets("2"));
    expect(onChange).toHaveBeenLastCalledWith({ targets: ["1", "3"], writeBack: [] });
    expect(writes("2").disabled).toBe(true);
  });

  it("a fixed list keeps at least one machine", () => {
    renderEditor({ targets: ["2"], writeBack: [] });
    expect(gets("2").disabled).toBe(true);
    expect(gets("1").disabled).toBe(false);
  });

  it("the machine it's shared from can't be unticked", () => {
    renderEditor({ targets: ["1", "2"], writeBack: [] }, "1");
    expect(gets("1").disabled).toBe(true);
    expect(screen.getByTestId("shared-machines-row-1").textContent).toContain("Shared from here");
  });
});

describe("editSharedMachines", () => {
  it("taking machines off names the agents holding the role there, then saves", async () => {
    answerPicker(() => {
      fireEvent.click(every());
      fireEvent.click(gets("2"));
    });
    kit.confirm.mockResolvedValueOnce(true);
    const res = await editSharedMachines({
      kind: "role",
      name: "helper",
      label: "Helper",
      hostId: 5,
      current: { targets: "all", writeBack: [] },
      agentsOn: (m) => (m.machineId === "2" ? ["Sam", "Ola"] : []),
    });
    const removal = kit.confirm.mock.calls[1][0];
    expect(removal.title).toBe("Take Helper off beta?");
    expect(String(removal.body)).toContain("beta: 2 agents hold this role there (Sam, Ola) — they'll keep running without it");
    expect(removal.confirmLabel).toBe("Take it off");
    expect(api.saveMachines).toHaveBeenCalledWith("role", "helper", { targets: ["1", "3"], writeBack: [] });
    // Host row 5 reaches beta, which lost it.
    expect(res).toEqual({ saved: { targets: ["1", "3"], writeBack: [] }, leftHere: true });
  });

  it("declining the removal saves nothing", async () => {
    answerPicker(() => {
      fireEvent.click(every());
      fireEvent.click(gets("3"));
    });
    kit.confirm.mockResolvedValueOnce(false);
    const res = await editSharedMachines({
      kind: "skill",
      name: "demo",
      label: '"demo"',
      hostId: 1,
      current: { targets: "all", writeBack: [] },
    });
    expect(res).toBeNull();
    expect(api.saveMachines).not.toHaveBeenCalled();
  });

  it("every machine ticked one by one asks about machines added later", async () => {
    answerPicker(() => {
      fireEvent.click(gets("1"));
      fireEvent.click(gets("3"));
    });
    kit.confirm.mockResolvedValueOnce(true); // Include new machines too
    await editSharedMachines({
      kind: "skill",
      name: "demo",
      label: '"demo"',
      hostId: 2,
      current: { targets: ["2"], writeBack: [] },
    });
    const ask = kit.confirm.mock.calls[1][0];
    expect(ask.body).toBe("You've picked every machine, but machines added later won't get this.");
    expect(ask.confirmLabel).toBe("Include new machines too");
    expect(ask.cancelLabel).toBe("Just these machines");
    expect(api.saveMachines).toHaveBeenCalledWith("skill", "demo", { targets: "all", writeBack: [] });
  });

  it("'Just these machines' keeps the fixed list", async () => {
    answerPicker(() => {
      fireEvent.click(gets("1"));
      fireEvent.click(gets("3"));
    });
    kit.confirm.mockResolvedValueOnce(false);
    await editSharedMachines({
      kind: "skill",
      name: "demo",
      label: '"demo"',
      hostId: 2,
      current: { targets: ["2"], writeBack: [] },
    });
    expect(api.saveMachines).toHaveBeenCalledWith("skill", "demo", { targets: ["2", "1", "3"], writeBack: [] });
  });

  it("only a write-back change: no every-machine question, no removal, saved", async () => {
    answerPicker(() => fireEvent.click(writes("1")));
    await editSharedMachines({
      kind: "skill",
      name: "demo",
      label: '"demo"',
      hostId: 2,
      current: { targets: ["1", "2", "3"], writeBack: [] },
    });
    expect(kit.confirm).toHaveBeenCalledTimes(1);
    expect(api.saveMachines).toHaveBeenCalledWith("skill", "demo", { targets: ["1", "2", "3"], writeBack: ["1"] });
  });

  it("names machines being added that already have their own, before replacing them", async () => {
    api.previewMachines.mockResolvedValue({ clashes: ["alpha"], unreachable: [] });
    answerPicker(() => fireEvent.click(gets("1")));
    kit.confirm.mockResolvedValueOnce(false);
    const res = await editSharedMachines({
      kind: "skill",
      name: "demo",
      label: '"demo"',
      hostId: 2,
      current: { targets: ["2"], writeBack: [] },
    });
    expect(api.previewMachines).toHaveBeenCalledWith("skill", "demo", ["2", "1"]);
    expect(String(kit.confirm.mock.calls[1][0].body)).toContain('These machines already have a skill named "demo", which will be replaced: alpha');
    expect(res).toBeNull();
    expect(api.saveMachines).not.toHaveBeenCalled();
  });

  it("nothing changed: nothing saved", async () => {
    kit.confirm.mockResolvedValueOnce(true);
    expect(
      await editSharedMachines({ kind: "skill", name: "demo", label: '"demo"', hostId: 2, current: { targets: "all", writeBack: [] } }),
    ).toBeNull();
    expect(api.saveMachines).not.toHaveBeenCalled();
  });
});

describe("shareWithMachines", () => {
  it("shares to the machines picked, the source machine always among them, nothing writing back by default", async () => {
    answerPicker(() => {
      fireEvent.click(every());
      fireEvent.click(gets("3"));
    });
    kit.confirm.mockResolvedValueOnce(true);
    expect(await shareWithMachines({ kind: "role", name: "helper", label: "Helper", hostId: 1 })).toBe(true);
    // The source (alpha, host row 1) was pinned in the picker.
    expect(kit.confirm.mock.calls[0][0].confirmLabel).toBe("Continue");
    expect(api.previewPromote).toHaveBeenCalledWith("role", "helper", 1, ["1", "2"]);
    expect(String(kit.confirm.mock.calls[1][0].body)).toContain("copied to the 2 machines you picked");
    expect(api.promote).toHaveBeenCalledWith("role", "helper", 1, { targets: ["1", "2"], writeBack: [] });
  });

  it("cancelling the picker shares nothing", async () => {
    kit.confirm.mockResolvedValueOnce(false);
    expect(await shareWithMachines({ kind: "skill", name: "demo", label: '"demo"', hostId: 1 })).toBe(false);
    expect(api.previewPromote).not.toHaveBeenCalled();
    expect(api.promote).not.toHaveBeenCalled();
  });
});
