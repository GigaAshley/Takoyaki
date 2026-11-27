import { useSyncExternalStore } from "react";

// ─── Each machine's open changes ─────────────────────────────────────────────
//
// Every change goes through its machine's front door and waits its turn there. Each
// machine's status report lists what's open (the server's `machine-changes` frame, one
// per machine, already cut down to what this person can see):
//
//   - waiting / running   a change still waiting its turn, or being carried out
//   - returning           an agent on its way back from the archive (`card` = its row)
//   - refused / failed    one of this person's changes that didn't happen, with why —
//   - unfiled             a new agent of theirs left in Conversations (its project went),
//   - stuck               an archive whose clean-up has failed for 10 minutes or more:
//                         notices for this person; each goes once it has been seen
//
// The sidebar marks what's waiting (moves, pins, archives), puts a failure mark on the
// row it's about, and pops up the notices that have no row (machine-notices.ts).
//
// It also tells a device when its own change has really finished: `afterMachineSettles`
// — so a change the device shows straight away stays shown until the machine says it's
// done or refused, with no timer guessing.

export type MachineChangeState = "waiting" | "running" | "returning" | "refused" | "failed" | "unfiled" | "stuck";

export type MachineChange = {
  id: string;
  kind: string;
  state: MachineChangeState;
  target: { type: "agent" | "app" | "project" | "role"; name: string | null; displayName?: string };
  /** Where a move goes; `hidden` = somewhere this person can't see. */
  to?: { project?: string | null; parent?: string | null; pinned?: boolean; hidden?: boolean };
  at: number | null;
  reason?: string;
  code?: string;
  /** This person asked for it. */
  mine: boolean;
  card?: { displayName: string; project: string | null };
};

const OPEN_STATES: ReadonlySet<MachineChangeState> = new Set(["waiting", "running", "returning"]);
const NOTICE_STATES: ReadonlySet<MachineChangeState> = new Set(["refused", "failed", "unfiled"]);

export function isOpen(c: MachineChange): boolean {
  return OPEN_STATES.has(c.state);
}

export function isNotice(c: MachineChange): boolean {
  return NOTICE_STATES.has(c.state);
}

let byHost: ReadonlyMap<string, readonly MachineChange[]> = new Map();
const serialized = new Map<string, string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** A machine's open changes as its latest report lists them (the whole list for that host). */
export function setMachineChanges(hostId: string, changes: readonly MachineChange[]): void {
  const s = JSON.stringify(changes);
  if (serialized.get(hostId) === s) return;
  serialized.set(hostId, s);
  const next = new Map(byHost);
  next.set(hostId, changes);
  byHost = next;
  settleWaiters(hostId, changes);
  notify();
}

export function getMachineChanges(): ReadonlyMap<string, readonly MachineChange[]> {
  return byHost;
}

export function useMachineChanges(): ReadonlyMap<string, readonly MachineChange[]> {
  return useSyncExternalStore(subscribe, getMachineChanges, getMachineChanges);
}

export type TargetType = MachineChange["target"]["type"];

function sameTarget(c: MachineChange, type: TargetType, name: string): boolean {
  return c.target.type === type && c.target.name !== null && c.target.name.toLowerCase() === name.toLowerCase();
}

/** Every entry about one thing on one machine, oldest first. */
export function changesFor(
  all: ReadonlyMap<string, readonly MachineChange[]>,
  hostId: number | string,
  type: TargetType,
  name: string,
): MachineChange[] {
  return (all.get(String(hostId)) ?? []).filter((c) => sameTarget(c, type, name));
}

/** The kinds that get a waiting mark: moves, pins and archives (renames and edits don't). */
const MOVE_KINDS = new Set(["agent-project", "agent-pin", "app-move", "project-move"]);
const ARCHIVE_KINDS = new Set(["agent-archive", "project-archive", "app-archive", "role-archive"]);

export type MachineMark =
  | { kind: "moving"; change: MachineChange }
  | { kind: "archiving"; change: MachineChange }
  | { kind: "failed"; change: MachineChange }
  | null;

/**
 * What a row shows for its thing: a failure of this person's (until dismissed) first,
 * then a waiting archive, then a waiting move or pin (the latest one, which is where it
 * ends up).
 */
export function markFor(changes: readonly MachineChange[]): MachineMark {
  const notice = changes.find((c) => isNotice(c));
  if (notice) return { kind: "failed", change: notice };
  const archive = changes.find((c) => (c.state === "waiting" || c.state === "running") && ARCHIVE_KINDS.has(c.kind));
  if (archive) return { kind: "archiving", change: archive };
  const moves = changes.filter((c) => (c.state === "waiting" || c.state === "running") && MOVE_KINDS.has(c.kind));
  if (moves.length > 0) return { kind: "moving", change: moves[moves.length - 1] };
  return null;
}

export function useMachineMark(hostId: number | string | null | undefined, type: TargetType, name: string | null | undefined): MachineMark {
  const all = useMachineChanges();
  const local = useSyncExternalStore(subscribe, getLocalArchiving, getLocalArchiving);
  if (hostId === null || hostId === undefined || !name) return null;
  const mark = markFor(changesFor(all, hostId, type, name));
  if (mark === null && local.has(localKey(hostId, type, name))) {
    return {
      kind: "archiving",
      change: { id: "here", kind: `${type}-archive`, state: "waiting", target: { type, name }, at: null, mine: true },
    };
  }
  return mark;
}

// ─── An archive this device just sent ────────────────────────────────────────
//
// The device that clicked Archive shows the row greyed with "Archiving…" — like every
// other device — from the click until the machine has taken it (the row then goes) or
// refused it (the row stays, ungreyed). The machine's own report may not list it yet,
// so the device marks it here meanwhile.
let localArchiving: ReadonlySet<string> = new Set();
const localKey = (hostId: number | string, type: TargetType, name: string) => `${hostId}::${type}::${name.toLowerCase()}`;

function getLocalArchiving(): ReadonlySet<string> {
  return localArchiving;
}

/** Grey this row with "Archiving…" until the returned function is called. */
export function markArchivingHere(hostId: number | string, type: TargetType, name: string): () => void {
  const k = localKey(hostId, type, name);
  const next = new Set(localArchiving);
  next.add(k);
  localArchiving = next;
  notify();
  let cleared = false;
  return () => {
    if (cleared) return;
    cleared = true;
    const after = new Set(localArchiving);
    after.delete(k);
    localArchiving = after;
    notify();
  };
}

// ─── A device's own changes: after the machine settles them ──────────────────

type Waiter = { id: string; seenOpen: boolean; resolve: (r: "done" | "failed") => void };
const waiters = new Map<string, Waiter[]>();

function settleWaiters(hostId: string, changes: readonly MachineChange[]): void {
  const list = waiters.get(hostId);
  if (!list) return;
  const keep: Waiter[] = [];
  for (const w of list) {
    const mine = changes.filter((c) => c.id === w.id);
    if (mine.some((c) => c.state === "refused" || c.state === "failed")) {
      w.resolve("failed");
    } else if (mine.some((c) => isOpen(c) || c.state === "stuck")) {
      w.seenOpen = true;
      keep.push(w);
    } else if (w.seenOpen || mine.some((c) => c.state === "unfiled")) {
      w.resolve("done");
    } else {
      keep.push(w);
    }
  }
  if (keep.length > 0) waiters.set(hostId, keep);
  else waiters.delete(hostId);
}

/**
 * For a change this device sent that was still waiting when it stopped asking: resolves
 * "done" once the machine's report has listed it open and then no longer does, or "failed"
 * when the report shows it refused or failed. Until then whatever the device shows for it
 * stays as it is.
 */
export function afterMachineSettles(hostId: number | string, requestId: string): Promise<"done" | "failed"> {
  const key = String(hostId);
  return new Promise((resolve) => {
    const w: Waiter = { id: requestId, seenOpen: false, resolve };
    waiters.set(key, [...(waiters.get(key) ?? []), w]);
    const now = byHost.get(key);
    if (now) settleWaiters(key, now);
  });
}

export function __resetMachineChangesForTest(): void {
  byHost = new Map();
  localArchiving = new Set();
  serialized.clear();
  waiters.clear();
  notify();
}
