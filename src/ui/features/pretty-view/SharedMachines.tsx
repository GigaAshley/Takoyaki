// Which machines a shared role or skill goes to, and which of them write it
// back. Admins only — the lists say where an item reaches, and only an admin
// can choose that.
//
// MachineListsEditor is the picker: an "Every machine" switch (which includes
// machines added later), then every machine with two ticks, Gets it and
// Writes back. It's shown inside the app's confirm dialogs, by the sharing
// flow (shareWithMachines) and the Machines… flow on a shared item
// (editSharedMachines), which also ask the follow-up questions: every machine
// ticked one by one, machines losing it, same-named folders being replaced.

import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { KitCell, KitCheckbox, KitChip, KitSettingsGroup, KitSettingsRow, KitSwitch, kitAlert, kitConfirm } from "@/components/kit";
import {
  clashLines,
  listSharedMachines,
  previewMachines,
  previewPromote,
  promote,
  promoteConfirmText,
  saveMachines,
  type InstanceWideKind,
  type SharedLists,
  type SharedMachine,
} from "@/api/instance-wide-api";

function byName(a: SharedMachine, b: SharedMachine): number {
  return a.hostName.localeCompare(b.hostName, undefined, { sensitivity: "base" });
}

function sameLists(a: SharedLists, b: SharedLists): boolean {
  const key = (l: SharedLists) =>
    JSON.stringify([l.targets === "all" ? "all" : [...l.targets].sort(), [...l.writeBack].sort()]);
  return key(a) === key(b);
}

function gets(lists: SharedLists, id: string): boolean {
  return lists.targets === "all" || lists.targets.includes(id);
}

const COLUMNS = [
  { label: "Gets it", icon: <Download />, hint: "The machine has a copy, kept in step" },
  { label: "Writes back", icon: <Upload />, hint: "Edits made on the machine reach the item's other machines" },
];

export function MachineListsEditor({
  machines,
  initial,
  onChange,
  pinnedMachineId,
}: {
  machines: SharedMachine[];
  initial: SharedLists;
  onChange: (lists: SharedLists) => void;
  /** Always gets it (the machine it's being shared from). */
  pinnedMachineId?: string;
}): JSX.Element {
  const [lists, setLists] = useState<SharedLists>(initial);
  const sorted = [...machines].sort(byName);
  const update = (next: SharedLists): void => {
    setLists(next);
    onChange(next);
  };
  const everyMachine = lists.targets === "all";
  const ticked = everyMachine ? sorted.map((m) => m.machineId) : (lists.targets as string[]);

  const setEvery = (on: boolean): void => {
    // Turning it off starts from every machine ticked, to untick from.
    update({ ...lists, targets: on ? "all" : sorted.map((m) => m.machineId) });
  };
  const setGets = (id: string, on: boolean): void => {
    const targets = on ? [...new Set([...ticked, id])] : ticked.filter((t) => t !== id);
    update({ targets, writeBack: on ? lists.writeBack : lists.writeBack.filter((w) => w !== id) });
  };
  const setWriteBack = (id: string, on: boolean): void => {
    update({ ...lists, writeBack: on ? [...new Set([...lists.writeBack, id])] : lists.writeBack.filter((w) => w !== id) });
  };

  return (
    <div className="flex flex-col gap-3 text-left" data-testid="shared-machines-editor">
      <KitSettingsGroup>
        <KitSettingsRow
          label="Every machine"
          description="Includes machines added later"
          control={
            <KitSwitch
              checked={everyMachine}
              onCheckedChange={setEvery}
              aria-label="Every machine"
              data-testid="shared-machines-every"
            />
          }
        />
      </KitSettingsGroup>
      <KitSettingsGroup columns={COLUMNS}>
        {sorted.map((m) => {
          const on = gets(lists, m.machineId);
          const pinned = m.machineId === pinnedMachineId;
          // A fixed list keeps at least one machine.
          const last = !everyMachine && on && ticked.length === 1;
          return (
            <KitSettingsRow
              key={m.machineId}
              label={m.hostName}
              description={
                pinned ? "Shared from here" : m.offline ? <KitChip>offline</KitChip> : undefined
              }
              control={
                <>
                  <KitCell>
                    <KitCheckbox
                      checked={on}
                      disabled={everyMachine || pinned || last}
                      onCheckedChange={(v) => setGets(m.machineId, v)}
                      aria-label={`${m.hostName} gets it`}
                      data-testid={`shared-machines-gets-${m.machineId}`}
                    />
                  </KitCell>
                  <KitCell>
                    <KitCheckbox
                      checked={on && lists.writeBack.includes(m.machineId)}
                      disabled={!on}
                      onCheckedChange={(v) => setWriteBack(m.machineId, v)}
                      aria-label={`${m.hostName} writes back`}
                      data-testid={`shared-machines-writeback-${m.machineId}`}
                    />
                  </KitCell>
                </>
              }
              data-testid={`shared-machines-row-${m.machineId}`}
            />
          );
        })}
      </KitSettingsGroup>
    </div>
  );
}

/**
 * Every machine ticked one by one is still a fixed list: machines added later
 * won't get it. Say so, and offer to switch to every machine. Not asked with
 * a single machine. Cancel keeps the machines as picked.
 */
export async function settleEveryMachineTicked(lists: SharedLists, machines: SharedMachine[]): Promise<SharedLists> {
  if (lists.targets === "all" || machines.length < 2) return lists;
  const picked = new Set(lists.targets);
  if (!machines.every((m) => picked.has(m.machineId))) return lists;
  const include = await kitConfirm({
    title: "Include machines added later?",
    body: "You've picked every machine, but machines added later won't get this.",
    confirmLabel: "Include new machines too",
    cancelLabel: "Just these machines",
  });
  console.info({ operation: "shared_machines_every_ticked", include });
  return include ? { ...lists, targets: "all" } : lists;
}

/** The picker in a dialog. Resolves the lists, or null when cancelled. */
async function askForLists(opts: {
  title: string;
  intro: string;
  machines: SharedMachine[];
  initial: SharedLists;
  confirmLabel: string;
  pinnedMachineId?: string;
}): Promise<SharedLists | null> {
  let picked = opts.initial;
  const ok = await kitConfirm({
    title: opts.title,
    body: (
      <div className="flex flex-col gap-3">
        <p>{opts.intro}</p>
        <MachineListsEditor
          machines={opts.machines}
          initial={opts.initial}
          pinnedMachineId={opts.pinnedMachineId}
          onChange={(l) => (picked = l)}
        />
      </div>
    ),
    confirmLabel: opts.confirmLabel,
  });
  return ok ? picked : null;
}

async function loadMachines(): Promise<SharedMachine[] | null> {
  try {
    return await listSharedMachines();
  } catch (err) {
    void kitAlert({ title: "Couldn't list the machines", body: err instanceof Error ? err.message : undefined });
    return null;
  }
}

/**
 * "Make instance-wide…": pick the machines, then preview what gets copied and
 * which same-named folders get replaced on them, then share. The machine it's
 * shared from always gets it; nothing writes back until picked. Resolves true
 * once shared.
 */
export async function shareWithMachines(opts: {
  kind: InstanceWideKind;
  name: string;
  label: string;
  hostId: number;
}): Promise<boolean> {
  const kindLabel = opts.kind;
  const machines = await loadMachines();
  if (!machines) return false;
  const source = machines.find((m) => m.hostRowIds.includes(String(opts.hostId)));
  let lists = await askForLists({
    title: `Make ${opts.label} instance-wide?`,
    intro: `Pick the machines that get this ${kindLabel}, and which of them write back — edits made there reach the others. You can change both later.`,
    machines,
    initial: { targets: "all", writeBack: [] },
    pinnedMachineId: source?.machineId,
    confirmLabel: "Continue",
  });
  if (!lists) return false;
  lists = await settleEveryMachineTicked(lists, machines);
  try {
    const preview = await previewPromote(opts.kind, opts.name, opts.hostId, lists.targets);
    if (preview.tooLarge) {
      void kitAlert({
        title: `${opts.label} is too big to make instance-wide`,
        body: `It has ${preview.files} files. Clean up its folder first.`,
      });
      return false;
    }
    if (
      !(await kitConfirm({
        title: `Make ${opts.label} instance-wide?`,
        body: promoteConfirmText(kindLabel, opts.name, preview, lists.targets).replace(/^[^\n]*\n\n?/, ""),
        confirmLabel: "Make instance-wide",
      }))
    )
      return false;
    await promote(opts.kind, opts.name, opts.hostId, lists);
    console.info({
      operation: "shared_item_promoted",
      kind: opts.kind,
      name: opts.name,
      hostId: opts.hostId,
      targets: lists.targets === "all" ? "all" : lists.targets.join(","),
      writeBack: lists.writeBack.join(","),
    });
    return true;
  } catch (err) {
    void kitAlert({ title: "Couldn't make it instance-wide", body: err instanceof Error ? err.message : undefined });
    return false;
  }
}

/**
 * "Machines…" on a shared item: change the lists. Machines taken off are
 * named first (with the agents there holding the role); machines added that
 * already have a same-named folder are named before it's replaced. Resolves
 * the saved lists — and whether the machine `hostId` reaches lost the item —
 * or null when nothing changed.
 */
export async function editSharedMachines(opts: {
  kind: InstanceWideKind;
  name: string;
  label: string;
  /** The host the item is being looked at on. */
  hostId: number | null;
  current: SharedLists;
  /** Names of the agents on a machine holding this role (roles only). */
  agentsOn?: (machine: SharedMachine) => string[];
}): Promise<{ saved: SharedLists; leftHere: boolean } | null> {
  const machines = await loadMachines();
  if (!machines) return null;
  let lists = await askForLists({
    title: `Machines for ${opts.label}`,
    intro: `Which machines get this ${opts.kind}, and which of them write back — edits made there reach the others.`,
    machines,
    initial: opts.current,
    confirmLabel: "Save",
  });
  if (!lists || sameLists(lists, opts.current)) return null;
  // Only asked when the machines changed, so a write-back tweak doesn't nag.
  if (!sameLists({ ...lists, writeBack: [] }, { ...opts.current, writeBack: [] })) {
    lists = await settleEveryMachineTicked(lists, machines);
  }

  const losing = machines.filter((m) => gets(opts.current, m.machineId) && !gets(lists!, m.machineId)).sort(byName);
  if (losing.length > 0) {
    const lines = losing.map((m) => {
      const agents = opts.agentsOn?.(m) ?? [];
      return agents.length === 0
        ? `${m.hostName}`
        : `${m.hostName}: ${agents.length} agent${agents.length === 1 ? " holds" : "s hold"} this role there (${agents.join(", ")}) — they'll keep running without it`;
    });
    const body = [
      `It will be deleted from ${losing.length === 1 ? "this machine" : "these machines"}, along with anything agents saved in it there:`,
      "",
      ...lines.map((l) => `• ${l}`),
    ].join("\n");
    if (
      !(await kitConfirm({
        title: `Take ${opts.label} off ${losing.length === 1 ? losing[0].hostName : `${losing.length} machines`}?`,
        body,
        confirmLabel: "Take it off",
        destructive: true,
      }))
    )
      return null;
  }

  try {
    const clashes = await previewMachines(opts.kind, opts.name, lists.targets);
    const warn = clashLines(opts.kind, opts.name, clashes);
    if (
      warn.length > 0 &&
      !(await kitConfirm({
        title: `Replace same-named ${opts.kind}s?`,
        body: warn.join("\n").trim(),
        confirmLabel: "Replace them",
        destructive: true,
      }))
    )
      return null;
    const saved = await saveMachines(opts.kind, opts.name, lists);
    const here = opts.hostId == null ? undefined : machines.find((m) => m.hostRowIds.includes(String(opts.hostId)));
    console.info({
      operation: "shared_item_machines_saved",
      kind: opts.kind,
      name: opts.name,
      targets: saved.targets === "all" ? "all" : saved.targets.join(","),
      writeBack: saved.writeBack.join(","),
      removedFrom: losing.map((m) => m.machineId).join(","),
    });
    return { saved, leftHere: here !== undefined && losing.includes(here) };
  } catch (err) {
    void kitAlert({ title: "Couldn't save the machines", body: err instanceof Error ? err.message : undefined });
    return null;
  }
}
