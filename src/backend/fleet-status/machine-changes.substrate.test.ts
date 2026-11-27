/**
 * End to end on a scratch machine: the real front door (fleet-change) and the real status
 * sweep make the `changes` line; the server parses, adapts and filters it for two people;
 * the app's store turns each person's list into what their sidebar shows.
 *
 * Ann and Bob share the machine. Finch is visible to both; the project "secret" only to Ann.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger.js", () => ({
  sshLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  databaseLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  systemLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { parseSweepJsonl } from "./sweep-schema.js";
import { adaptChangeEntry } from "./ssh-poll-orchestrator.js";
import { filterAppFrame } from "./app-frame-filter.js";
import { makeMachineChangesFrame, type MachineChange } from "./wire-protocol.js";
import { changesFor, markFor } from "../../ui/state/machine-changes-store.js";

const repo = path.join(__dirname, "..", "..", "..");
const FC = path.join(repo, "substrate", "scripts", "fleet-change");
const SWEEP = path.join(repo, "substrate", "scripts", "fleet-status-sweep.py");

let home: string;
const people: Record<string, string> = { "u-ann": "ann", "u-bob": "bob" };
const seen = new Set<string>();

function write(rel: string, text: string): void {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function fc(...args: string[]): string {
  return execFileSync("python3", [FC, ...args], {
    env: { ...process.env, FLEET_CHANGE_FLEET_DIR: path.join(home, "fleet"), FLEET_CHANGE_POLL_S: "0.02" },
    encoding: "utf8",
  });
}

async function viewFor(userId: string): Promise<MachineChange[]> {
  const raw = execFileSync("python3", [SWEEP], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  const parsed = parseSweepJsonl(raw);
  expect(parsed.changes).not.toBeNull();
  const frame = makeMachineChangesFrame("1", parsed.changes!.map(adaptChangeEntry));
  const out = await filterAppFrame(
    frame,
    {
      userId,
      resolveHostOwnerById: async () => ({ hostIdNum: 1, hostUserId: "owner" }),
      resolveIdentityGate: async () => true,
      resolveCallerUsername: async (u) => people[u] ?? null,
      noticeSeen: (u, h, k) => seen.has(`${u}:${h}:${k}`),
      beingAsked: () => false,
    },
    undefined,
    async () => true,
  );
  return (out as { changes: MachineChange[] }).changes;
}

const sidebar = (list: MachineChange[], type: "agent" | "project", name: string) =>
  markFor(changesFor(new Map([["1", list]]), 1, type, name));

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "machine-changes-e2e-"));
  write("fleet/projects/garden/project.md", "---\ndisplayName: Garden\n---\n");
  write("fleet/projects/secret/project.md", "---\ndisplayName: Secret\nusers: [ann]\n---\n");
  for (const name of ["finch", "wren", "robin"]) {
    write(`fleet/identities/${name}/${name}.md`, "---\nroles: []\n---\n");
  }
  write("fleet/identities-archive/kite/kite.md", "---\nroles: []\ndisplayName: Kite\nproject: secret\n---\n");
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("waiting and failed changes, end to end", () => {
  it("a waiting move: everyone who can see the agent gets the mark; only Ann learns a hidden destination's name", async () => {
    fc("submit", "agent-project", '{"name":"finch","project":"garden"}', "--id", "m1", "--by", "user:u-ann", "--wait", "0");
    fc("submit", "agent-project", '{"name":"wren","project":"secret"}', "--id", "m2", "--by", "user:u-ann", "--wait", "0");
    const ann = await viewFor("u-ann");
    const bob = await viewFor("u-bob");
    expect(sidebar(ann, "agent", "finch")).toMatchObject({ kind: "moving", change: { mine: true, to: { project: "garden" } } });
    expect(sidebar(bob, "agent", "finch")).toMatchObject({ kind: "moving", change: { mine: false, to: { project: "garden" } } });
    expect(sidebar(ann, "agent", "wren")?.change.to).toEqual({ project: "secret" });
    expect(sidebar(bob, "agent", "wren")?.change.to).toEqual({ hidden: true });
    expect(JSON.stringify(bob)).not.toContain("secret");
  });

  it("carried out: the marks go; a refusal is Ann's alone, until she has had it", async () => {
    fc("submit", "agent-project", '{"name":"robin","project":"gone"}', "--id", "m3", "--by", "user:u-ann", "--wait", "0");
    fc("serve", "--until-idle");
    const ann = await viewFor("u-ann");
    const bob = await viewFor("u-bob");
    expect(sidebar(ann, "agent", "finch")).toBeNull();
    expect(sidebar(bob, "agent", "finch")).toBeNull();
    expect(sidebar(ann, "agent", "robin")).toMatchObject({ kind: "failed", change: { reason: "that project is gone" } });
    expect(sidebar(bob, "agent", "robin")).toBeNull();
    seen.add("u-ann:1:m3");
    expect(sidebar(await viewFor("u-ann"), "agent", "robin")).toBeNull();
  });

  it("an archive stuck 10 minutes is told to whoever archived it", async () => {
    fc("submit", "agent-archive", '{"name":"robin"}', "--id", "a1", "--by", "user:u-bob", "--wait", "0");
    fc("serve", "--until-idle");
    const claim = path.join(home, "fleet/identities/robin/.archiving");
    const c = JSON.parse(fs.readFileSync(claim, "utf8"));
    fs.writeFileSync(claim, JSON.stringify({ ...c, failing_since: Date.now() / 1000 - 700, last_error: "couldn't switch the chat account off" }));
    const bob = await viewFor("u-bob");
    expect(bob.filter((x) => x.state === "stuck")).toMatchObject([{ id: "a1", reason: "couldn't switch the chat account off", mine: true }]);
    expect((await viewFor("u-ann")).filter((x) => x.state === "stuck")).toEqual([]);
  });

  it("an agent coming back lands where each person can see it", async () => {
    fc("submit", "agent-unarchive", '{"name":"kite"}', "--id", "u1", "--by", "user:u-ann", "--wait", "0");
    fc("serve", "--until-idle");
    const ann = (await viewFor("u-ann")).find((x) => x.state === "returning");
    const bob = (await viewFor("u-bob")).find((x) => x.state === "returning");
    expect(ann?.card).toEqual({ displayName: "Kite", project: "secret" });
    expect(bob?.card).toEqual({ displayName: "Kite", project: null });
  });
});
