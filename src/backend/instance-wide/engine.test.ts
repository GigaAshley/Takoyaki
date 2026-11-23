/**
 * Engine tests run the real shell host-ops against temp folders: each fake
 * machine is a bash child whose $HOME is its own temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";
import { promises as fs, existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { InstanceWideEngine, PromoteError, type SyncMachine } from "./engine.js";
import { InstanceWideStore } from "./store.js";
import type { SshChannel } from "../fleet-status/ssh-poll-orchestrator.js";

function bashChannel(home: string): SshChannel {
  return {
    exec(command: string, stdin?: Buffer): Promise<string | null> {
      return new Promise((resolve) => {
        const child = spawn("bash", ["-c", command], {
          env: { ...process.env, HOME: home },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString("utf-8")));
        child.on("error", () => resolve(null));
        child.stdin.on("error", () => {});
        child.on("close", (code) => resolve(code !== 0 && out === "" ? null : out.trim()));
        child.stdin.end(stdin ?? Buffer.alloc(0));
      });
    },
  };
}

let tmp: string;
let homes: Record<string, string>;
let offline: Set<string>;
let machines: SyncMachine[];
let engine: InstanceWideEngine;

function skillDir(m: string, name = "demo"): string {
  return path.join(homes[m], ".claude/skills", name);
}
async function put(m: string, rel: string, content: string, name = "demo"): Promise<void> {
  const p = path.join(skillDir(m, name), rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}
function read(m: string, rel: string, name = "demo"): string | null {
  const p = path.join(skillDir(m, name), rel);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "iw-engine-"));
  homes = {};
  for (const m of ["a", "b", "c"]) {
    homes[m] = path.join(tmp, m);
    await fs.mkdir(homes[m], { recursive: true });
  }
  offline = new Set();
  machines = [
    { machineId: "1", hostName: "alpha", adminOwned: true, hostRowIds: ["1"] },
    { machineId: "2", hostName: "beta", adminOwned: true, hostRowIds: ["2"] },
    { machineId: "3", hostName: "gamma", adminOwned: false, hostRowIds: ["3"] },
  ];
  const homeOf: Record<string, string> = { "1": "a", "2": "b", "3": "c" };
  engine = new InstanceWideEngine({
    store: new InstanceWideStore(path.join(tmp, "store")),
    listMachines: async () => machines,
    acquireChannel: async (m) => (offline.has(m.machineId) ? null : bashChannel(homes[homeOf[m.machineId]])),
    immediateDelayMs: 60_000,
  });
  await put("a", "SKILL.md", "---\nname: demo\n---\nv1\n");
  await put("a", "scripts/run.sh", "echo hi\n");
});

afterEach(async () => {
  engine.stop();
  await fs.rm(tmp, { recursive: true, force: true });
});

// Every machine, with alpha and beta writing back — how items behaved before
// per-item lists, which most of these tests exercise.
function share() {
  return engine.promote("skill", "demo", machines[0], { targets: "all", writeBack: ["1", "2"] });
}

describe("InstanceWideEngine", () => {
  it("promotes a folder and distributes it to every machine", async () => {
    const res = await share();
    expect(res.files).toBe(2);
    await engine.syncNow();
    for (const m of ["b", "c"]) {
      expect(read(m, "SKILL.md")).toContain("v1");
      expect(read(m, "scripts/run.sh")).toBe("echo hi\n");
    }
    const [status] = await engine.status();
    expect(status.behind).toBe(0);
    expect(status.hosts.every((h) => h.state === "current")).toBe(true);
  });

  it("a write-back machine's native edit flows to the master and everyone else", async () => {
    await share();
    await engine.syncNow();
    await put("b", "SKILL.md", "edited on beta\n");
    await put("b", "notes.md", "new file\n");
    await fs.rm(path.join(skillDir("b"), "scripts/run.sh"));
    await engine.syncNow();
    for (const m of ["a", "c"]) {
      expect(read(m, "SKILL.md")).toBe("edited on beta\n");
      expect(read(m, "notes.md")).toBe("new file\n");
      expect(read(m, "scripts/run.sh")).toBeNull();
    }
  });

  it("an edit on a machine that doesn't write back is put back", async () => {
    await share();
    await engine.syncNow();
    await put("c", "SKILL.md", "tampered\n");
    await put("c", "extra.md", "x\n");
    await engine.syncNow();
    expect(read("c", "SKILL.md")).toContain("v1");
    expect(read("c", "extra.md")).toBeNull();
    expect(read("a", "extra.md")).toBeNull();
  });

  it("conflicting write-back edits: first arrival wins, the other is set aside", async () => {
    await share();
    await engine.syncNow();
    await put("a", "SKILL.md", "alpha version\n");
    await put("b", "SKILL.md", "beta version\n");
    await engine.syncNow();
    expect(read("a", "SKILL.md")).toBe("alpha version\n");
    expect(read("b", "SKILL.md")).toBe("alpha version\n");
    expect(read("c", "SKILL.md")).toBe("alpha version\n");
    const aside = (await fs.readdir(skillDir("b"))).find((f) => f.startsWith("SKILL.md.conflict-beta-"));
    expect(aside).toBeDefined();
    expect(read("b", aside!)).toBe("beta version\n");
    // Conflict copies never travel.
    expect(await fs.readdir(skillDir("c"))).not.toContain(aside);
    const [status] = await engine.status();
    expect(status.conflicts).toBe(1);
    expect(status.hosts.find((h) => h.hostName === "beta")?.state).toBe("conflict");
    // Deleting the conflict copy clears the conflict.
    await fs.rm(path.join(skillDir("b"), aside!));
    await engine.syncNow();
    expect((await engine.status())[0].conflicts).toBe(0);
  });

  it("a missing folder is restored, never treated as a removal", async () => {
    await share();
    await engine.syncNow();
    await fs.rm(skillDir("a"), { recursive: true });
    await engine.syncNow();
    expect(read("a", "SKILL.md")).toContain("v1");
    expect(read("b", "SKILL.md")).toContain("v1");
  });

  it("editor-backup and cache files do not travel", async () => {
    await put("a", "SKILL.md~", "backup\n");
    await put("a", "__pycache__/x.pyc", "bin\n");
    await share();
    await engine.syncNow();
    expect(read("b", "SKILL.md~")).toBeNull();
    expect(read("b", "__pycache__/x.pyc")).toBeNull();
  });

  it("removal deletes the folder everywhere; an offline machine catches up later", async () => {
    await share();
    await engine.syncNow();
    offline.add("3");
    const { hostCount } = await engine.removeItem("skill", "demo");
    expect(hostCount).toBe(3);
    // Until the sync reaches a machine, its copy is still on the way out.
    expect(await engine.pendingRemovalNames("skill", "1")).toEqual(["demo"]);
    expect(await engine.pendingRemovalNames("role", "1")).toEqual([]);
    await engine.syncNow();
    expect(await engine.pendingRemovalNames("skill", "1")).toEqual([]);
    expect(await engine.pendingRemovalNames("skill", "3")).toEqual(["demo"]);
    expect(existsSync(skillDir("a"))).toBe(false);
    expect(existsSync(skillDir("b"))).toBe(false);
    expect(existsSync(skillDir("c"))).toBe(true);
    offline.delete("3");
    await engine.syncNow();
    expect(existsSync(skillDir("c"))).toBe(false);
  });

  it("an app edit to the master reaches every machine", async () => {
    await share();
    await engine.syncNow();
    await engine.editMaster("skill", "demo", (s) =>
      s.writeFile("skill", "demo", "SKILL.md", Buffer.from("from the app\n")),
    );
    await engine.syncNow();
    for (const m of ["a", "b", "c"]) expect(read(m, "SKILL.md")).toBe("from the app\n");
  });

  it("an admin-sourced app edit on a non-admin machine flows back", async () => {
    await share();
    await engine.syncNow();
    await put("c", "SKILL.md", "admin edited via gamma\n");
    engine.requestSync({ adminSourcedMachineId: "3" });
    await engine.syncNow();
    expect(read("a", "SKILL.md")).toBe("admin edited via gamma\n");
  });

  it("finds same-name folders on other machines before promotion", async () => {
    await put("b", "SKILL.md", "beta's own demo\n");
    offline.add("3");
    const res = await engine.findClashes("skill", "demo", "1");
    expect(res.clashes).toEqual(["beta"]);
    expect(res.unreachable).toEqual(["gamma"]);
    // After promotion the clashing copy is replaced (first contact → master wins).
    offline.delete("3");
    await share();
    await engine.syncNow();
    expect(read("b", "SKILL.md")).toContain("v1");
  });

  it("refuses to promote an oversized folder", async () => {
    const big = Buffer.alloc(26 * 1024 * 1024, 1);
    await fs.writeFile(path.join(skillDir("a"), "big.bin"), big);
    await expect(share()).rejects.toBeInstanceOf(PromoteError);
    expect(await engine.isInstanceWide("skill", "demo")).toBe(false);
  });

  it("offline machines are not counted as behind", async () => {
    offline.add("3");
    await share();
    await engine.syncNow();
    const [status] = await engine.status();
    expect(status.hosts.find((h) => h.hostName === "gamma")?.state).toBe("offline");
    expect(status.behind).toBe(0);
  });

  it("quick check carries a write-back machine's edit to everyone", async () => {
    await share();
    await engine.syncNow();
    await put("b", "SKILL.md", "quick edit\n");
    await engine.quickWriteBackCheck();
    // The master changed, so a full pass is requested; run it now.
    await engine.syncNow();
    expect(read("c", "SKILL.md")).toBe("quick edit\n");
  });

  it("quick check never touches machines that don't write back", async () => {
    await share();
    await engine.syncNow();
    await put("c", "SKILL.md", "tampered\n");
    await engine.quickWriteBackCheck();
    expect(read("c", "SKILL.md")).toBe("tampered\n");
  });

  it("keeps permission bits: private files stay private, scripts stay executable", async () => {
    await fs.chmod(path.join(skillDir("a"), "scripts/run.sh"), 0o755);
    await put("a", "creds.json", "{}\n");
    await fs.chmod(path.join(skillDir("a"), "creds.json"), 0o600);
    await share();
    await engine.syncNow();
    const mode = async (m: string, rel: string) =>
      ((await fs.stat(path.join(skillDir(m), rel))).mode & 0o777).toString(8);
    expect(await mode("b", "creds.json")).toBe("600");
    expect(await mode("b", "scripts/run.sh")).toBe("755");
  });

  it("never follows a symlinked item folder out of the home folder", async () => {
    await share();
    await engine.syncNow();
    // Replace beta's copy with a link to a folder outside its home.
    const outside = path.join(tmp, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "secret.key"), "TOP SECRET\n");
    await fs.rm(skillDir("b"), { recursive: true });
    await fs.symlink(outside, skillDir("b"));
    await engine.syncNow();
    // Nothing from outside reached the master or anyone else; the outside
    // folder was not written to.
    expect(read("a", "secret.key")).toBeNull();
    expect(read("c", "secret.key")).toBeNull();
    expect(await fs.readdir(outside)).toEqual(["secret.key"]);
    const [status] = await engine.status();
    expect(status.hosts.find((h) => h.hostName === "beta")?.state).toBe("behind");
  });

  it("never follows a symlinked file inside an item", async () => {
    await share();
    await engine.syncNow();
    const outside = path.join(tmp, "outside.txt");
    await fs.writeFile(outside, "TOP SECRET\n");
    await fs.symlink(outside, path.join(skillDir("b"), "link.txt"));
    await engine.syncNow();
    expect(read("a", "link.txt")).toBeNull();
    // Overwriting a file that has been swapped for a link replaces the link,
    // never the file it points to.
    await fs.rm(path.join(skillDir("c"), "SKILL.md"));
    await fs.symlink(outside, path.join(skillDir("c"), "SKILL.md"));
    await engine.syncNow();
    expect(readFileSync(outside, "utf-8")).toBe("TOP SECRET\n");
    expect(read("c", "SKILL.md")).toContain("v1");
  });

  it("an emptied folder on a write-back host is restored, not spread as deletes", async () => {
    await share();
    await engine.syncNow();
    await fs.rm(path.join(skillDir("b"), "SKILL.md"));
    await fs.rm(path.join(skillDir("b"), "scripts"), { recursive: true });
    await engine.syncNow();
    expect(read("a", "SKILL.md")).toContain("v1");
    expect(read("b", "SKILL.md")).toContain("v1");
  });

  it("git repos and dependency folders never travel", async () => {
    await put("a", ".git/HEAD", "ref: refs/heads/main\n");
    await put("a", "node_modules/x/index.js", "x\n");
    await share();
    await engine.syncNow();
    expect(read("b", ".git/HEAD")).toBeNull();
    expect(read("b", "node_modules/x/index.js")).toBeNull();
  });

  it("refuses names the app's built-in files use", async () => {
    const reserved = new InstanceWideEngine({
      store: new InstanceWideStore(path.join(tmp, "store2")),
      listMachines: async () => machines,
      acquireChannel: async () => bashChannel(homes.a),
      isReservedName: (kind, name) => kind === "skill" && name === "demo",
      immediateDelayMs: 60_000,
    });
    await expect(reserved.promote("skill", "demo", machines[0])).rejects.toMatchObject({ code: "reserved" });
    reserved.stop();
  });

  it("leaves alone an existing item whose name has since become built in", async () => {
    await share();
    await engine.syncNow();
    engine.stop();
    // The app now distributes its own "demo"; the distributor rewrote b's copy.
    await put("b", "SKILL.md", "---\nname: demo\n---\nbuilt-in\n");
    const homeOf: Record<string, string> = { "1": "a", "2": "b", "3": "c" };
    engine = new InstanceWideEngine({
      store: new InstanceWideStore(path.join(tmp, "store")),
      listMachines: async () => machines,
      acquireChannel: async (m) => bashChannel(homes[homeOf[m.machineId]]),
      isReservedName: (kind, name) => kind === "skill" && name === "demo",
      immediateDelayMs: 60_000,
    });
    await engine.syncNow();
    expect(read("b", "SKILL.md")).toContain("built-in");
    expect(read("a", "SKILL.md")).toContain("v1");
  });

  it("remove counts only machines still in the fleet", async () => {
    await share();
    await engine.syncNow();
    machines = machines.slice(0, 2);
    expect(await engine.hostCount("skill", "demo")).toBe(2);
  });

  it("syncs roles into ~/fleet/roles and binary files intact", async () => {
    const roleDir = path.join(homes.a, "fleet/roles/helper");
    await fs.mkdir(roleDir, { recursive: true });
    await fs.writeFile(path.join(roleDir, "helper.md"), "# helper\n");
    const bin = Buffer.from([0, 1, 2, 255, 10, 13, 0]);
    await fs.writeFile(path.join(roleDir, "avatar.webp"), bin);
    await engine.promote("role", "helper", machines[0], { targets: "all", writeBack: [] });
    await engine.syncNow();
    expect(readFileSync(path.join(homes.c, "fleet/roles/helper/helper.md"), "utf-8")).toBe("# helper\n");
    expect(readFileSync(path.join(homes.c, "fleet/roles/helper/avatar.webp")).equals(bin)).toBe(true);
  });
});

describe("InstanceWideEngine — per-item machines", () => {
  it("a newly shared item writes back from nowhere, not even the machine it came from", async () => {
    await engine.promote("skill", "demo", machines[0]);
    await engine.syncNow();
    expect(await engine.machinesFor("skill", "demo")).toEqual({ targets: "all", writeBack: [] });
    await put("a", "SKILL.md", "native edit on alpha\n");
    await engine.syncNow();
    expect(read("a", "SKILL.md")).toContain("v1");
    expect(read("b", "SKILL.md")).toContain("v1");
  });

  it("goes only to the machines picked; others never get it and keep their own", async () => {
    await put("c", "SKILL.md", "gamma's own demo\n");
    await engine.promote("skill", "demo", machines[0], { targets: ["1", "2"], writeBack: [] });
    await engine.syncNow();
    expect(read("b", "SKILL.md")).toContain("v1");
    expect(read("c", "SKILL.md")).toBe("gamma's own demo\n");
    expect(await engine.isSharedOn("skill", "demo", "2")).toBe(true);
    expect(await engine.isSharedOn("skill", "demo", "3")).toBe(false);
    expect(await engine.namesOn("skill", "3")).toEqual([]);
    expect(await engine.namesOn("skill", "1")).toEqual(["demo"]);
    expect(await engine.pendingRemovalNames("skill", "3")).toEqual([]);
    const [status] = await engine.status();
    expect(status.hosts.map((h) => h.hostName)).toEqual(["alpha", "beta"]);
    expect(await engine.hostCount("skill", "demo")).toBe(2);
  });

  it("the machine it is shared from is always on the list", async () => {
    await engine.promote("skill", "demo", machines[0], { targets: ["2"], writeBack: [] });
    await engine.syncNow();
    expect((await engine.machinesFor("skill", "demo")).targets).toEqual(["1", "2"]);
    expect(read("a", "SKILL.md")).toContain("v1");
  });

  it("only the picked write-back machines flow back", async () => {
    await engine.promote("skill", "demo", machines[0], { targets: "all", writeBack: ["3"] });
    await engine.syncNow();
    // gamma isn't admin-owned, but it was picked.
    await put("c", "SKILL.md", "from gamma\n");
    await engine.syncNow();
    for (const m of ["a", "b", "c"]) expect(read(m, "SKILL.md")).toBe("from gamma\n");
    // beta is admin-owned, but wasn't picked.
    await put("b", "SKILL.md", "from beta\n");
    await engine.syncNow();
    expect(read("b", "SKILL.md")).toBe("from gamma\n");
    expect(await engine.writesBackFrom("skill", "demo", "3")).toBe(true);
    expect(await engine.writesBackFrom("skill", "demo", "2")).toBe(false);
  });

  it("taking a machine off deletes its copy; an offline one deletes it when it returns", async () => {
    await engine.promote("skill", "demo", machines[0], { targets: "all", writeBack: [] });
    await engine.syncNow();
    offline.add("3");
    await engine.setMachines("skill", "demo", { targets: ["1"], writeBack: [] });
    expect(await engine.pendingRemovalNames("skill", "2")).toEqual(["demo"]);
    expect(await engine.isSharedOn("skill", "demo", "2")).toBe(false);
    await engine.syncNow();
    expect(existsSync(skillDir("b"))).toBe(false);
    expect(await engine.pendingRemovalNames("skill", "2")).toEqual([]);
    expect(existsSync(skillDir("c"))).toBe(true);
    expect(await engine.pendingRemovalNames("skill", "3")).toEqual(["demo"]);
    offline.delete("3");
    await engine.syncNow();
    expect(existsSync(skillDir("c"))).toBe(false);
    expect(read("a", "SKILL.md")).toContain("v1");
    // Once gone, a same-named folder there is the machine's own.
    await put("b", "SKILL.md", "beta's own now\n");
    await engine.syncNow();
    expect(read("b", "SKILL.md")).toBe("beta's own now\n");
  });

  it("a machine added later gets it, replacing its same-named folder", async () => {
    await engine.promote("skill", "demo", machines[0], { targets: ["1"], writeBack: [] });
    await engine.syncNow();
    await put("c", "SKILL.md", "gamma's own demo\n");
    expect((await engine.findClashes("skill", "demo", undefined, ["3"])).clashes).toEqual(["gamma"]);
    expect((await engine.findClashes("skill", "demo", undefined, ["2"])).clashes).toEqual([]);
    await engine.setMachines("skill", "demo", { targets: ["1", "3"], writeBack: [] });
    await engine.syncNow();
    expect(read("c", "SKILL.md")).toContain("v1");
    expect(existsSync(skillDir("b"))).toBe(false);
  });

  it("re-adding a machine after its copy was removed installs it fresh", async () => {
    await engine.promote("skill", "demo", machines[0], { targets: "all", writeBack: [] });
    await engine.syncNow();
    await engine.setMachines("skill", "demo", { targets: ["1"], writeBack: [] });
    await engine.syncNow();
    await engine.setMachines("skill", "demo", { targets: "all", writeBack: [] });
    await engine.syncNow();
    expect(read("b", "SKILL.md")).toContain("v1");
  });

  it("refuses lists that don't hold together", async () => {
    await engine.promote("skill", "demo", machines[0]);
    const bad = (lists: Parameters<typeof engine.setMachines>[2]) =>
      expect(engine.setMachines("skill", "demo", lists)).rejects.toMatchObject({ code: "bad_machines" });
    await bad({ targets: [], writeBack: [] });
    await bad({ targets: ["1"], writeBack: ["2"] });
    await bad({ targets: ["1", "99"], writeBack: [] });
    await bad({ targets: "all", writeBack: ["99"] });
    await expect(
      engine.promote("role", "nope", machines[0], { targets: ["1"], writeBack: ["3"] }),
    ).rejects.toMatchObject({ code: "bad_machines" });
    await expect(engine.setMachines("skill", "missing", { targets: "all", writeBack: [] })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("every machine includes machines that join later; a fixed list doesn't", async () => {
    await engine.promote("skill", "demo", machines[0], { targets: "all", writeBack: [] });
    const roleDir = path.join(homes.a, "fleet/roles/helper");
    await fs.mkdir(roleDir, { recursive: true });
    await fs.writeFile(path.join(roleDir, "helper.md"), "# helper\n");
    await engine.promote("role", "helper", machines[0], { targets: ["1", "2", "3"], writeBack: [] });
    homes.d = path.join(tmp, "d");
    await fs.mkdir(homes.d, { recursive: true });
    machines = [...machines, { machineId: "4", hostName: "delta", adminOwned: true, hostRowIds: ["4"] }];
    engine.stop();
    const homeOf: Record<string, string> = { "1": "a", "2": "b", "3": "c", "4": "d" };
    engine = new InstanceWideEngine({
      store: new InstanceWideStore(path.join(tmp, "store")),
      listMachines: async () => machines,
      acquireChannel: async (m) => bashChannel(homes[homeOf[m.machineId]]),
      immediateDelayMs: 60_000,
    });
    await engine.syncNow();
    expect(read("d", "SKILL.md")).toContain("v1");
    expect(existsSync(path.join(homes.d, "fleet/roles/helper"))).toBe(false);
  });

  it("items shared before per-item lists keep every machine and the admin machines of the day", async () => {
    await share();
    // Rewrite the state the way an older version stored it.
    const statePath = path.join(tmp, "store", "state.json");
    const st = JSON.parse(readFileSync(statePath, "utf-8"));
    st.items["skill/demo"] = { createdAt: 1, updatedAt: 1 };
    await fs.writeFile(statePath, JSON.stringify(st));
    await engine.syncNow();
    expect(await engine.machinesFor("skill", "demo")).toEqual({ targets: "all", writeBack: ["1", "2"] });
    // A machine that becomes admin-owned later doesn't start writing back.
    machines[2] = { ...machines[2], adminOwned: true };
    await engine.syncNow();
    expect((await engine.machinesFor("skill", "demo")).writeBack).toEqual(["1", "2"]);
    await put("b", "SKILL.md", "beta still writes back\n");
    await engine.syncNow();
    expect(read("c", "SKILL.md")).toBe("beta still writes back\n");
  });

  it("the quick check looks at write-back machines, whoever owns them", async () => {
    await engine.promote("skill", "demo", machines[0], { targets: "all", writeBack: ["3"] });
    await engine.syncNow();
    await put("c", "SKILL.md", "quick from gamma\n");
    await put("b", "SKILL.md", "beta tamper\n");
    await engine.quickWriteBackCheck();
    // beta wasn't visited by the quick check; the full pass then puts it back.
    expect(read("b", "SKILL.md")).toBe("beta tamper\n");
    await engine.syncNow();
    expect(read("a", "SKILL.md")).toBe("quick from gamma\n");
    expect(read("b", "SKILL.md")).toBe("quick from gamma\n");
  });
});
