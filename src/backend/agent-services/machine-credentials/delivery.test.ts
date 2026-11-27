import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../../utils/logger.js", () => {
  const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { systemLogger: stub };
});

import {
  CREDENTIAL_REL_PATH,
  createCredentialDelivery,
  credentialWriteCommand,
  type DeliveryDeps,
  type DeliveryHost,
} from "./delivery.js";
import type { CurrentCredential } from "./store.js";

const host = (id: string, machineId?: string): DeliveryHost => ({ id, name: `h${id}`, machineId, _connDetails: {} });

function setup(opts: {
  hosts: DeliveryHost[];
  creds: Record<string, CurrentCredential>;
  failExec?: Set<string>;
  machineIds?: string[];
  clock?: { t: number };
}) {
  const exec = vi.fn<DeliveryDeps["exec"]>(async (h) =>
    opts.failExec?.has(h.id) ? null : "__SERVICE_CREDENTIAL_OK__\n",
  );
  const writeLocal = vi.fn(async () => {});
  const forgetOtherMachines = vi.fn(async () => 0);
  const currentCredential = vi.fn(async (m: string) => opts.creds[m]);
  let timerFn: (() => void) | null = null;
  const deps: DeliveryDeps = {
    listHosts: async () => opts.hosts,
    listMachineIds: async () => opts.machineIds ?? ["from-the-hosts-table"],
    currentCredential,
    forgetOtherMachines,
    isLocalHost: (h) => h.id === "1",
    writeLocal,
    exec,
    setInterval: vi.fn((fn: () => void) => {
      timerFn = fn;
      return 0 as unknown as ReturnType<typeof setInterval>;
    }),
    clearInterval: vi.fn(),
    now: () => opts.clock?.t ?? 0,
  };
  /** One timer tick (respects back-off). */
  const tick = () => timerFn!();
  return { delivery: createCredentialDelivery(deps), exec, writeLocal, forgetOtherMachines, currentCredential, tick };
}

const sentToken = (call: Parameters<DeliveryDeps["exec"]>) => call[2].toString("utf8");

describe("credential delivery", () => {
  it("writes each login its machine's credential, the local one through the bind mount", async () => {
    const { delivery, exec, writeLocal } = setup({
      hosts: [host("1", "m1"), host("2", "m2"), host("3", "m2")],
      creds: { m1: { kind: "active", token: "tsc_one" }, m2: { kind: "active", token: "tsc_two" } },
    });
    await delivery.deliverNow();
    expect(writeLocal).toHaveBeenCalledWith("tsc_one");
    expect(exec.mock.calls.map((c) => [c[0].id, sentToken(c)])).toEqual([
      ["2", "tsc_two\n"],
      ["3", "tsc_two\n"],
    ]);
  });

  it("sends the credential on the command's input, never in the command itself", async () => {
    const { delivery, exec } = setup({ hosts: [host("2", "m2")], creds: { m2: { kind: "active", token: "tsc_secret" } } });
    await delivery.deliverNow();
    expect(exec.mock.calls[0][1]).not.toContain("tsc_secret");
    expect(sentToken(exec.mock.calls[0])).toBe("tsc_secret\n");
  });

  it("takes the machines that still run agents from the hosts table, not the SSH list", async () => {
    const { delivery, forgetOtherMachines } = setup({
      hosts: [],
      creds: {},
      machineIds: ["m1", "m2"],
    });
    await delivery.deliverNow();
    expect(forgetOtherMachines).toHaveBeenCalledWith(["m1", "m2"]);
  });

  it("writes again only when the credential changes", async () => {
    const creds: Record<string, CurrentCredential> = { m2: { kind: "active", token: "tsc_a" } };
    const { delivery, exec } = setup({ hosts: [host("2", "m2")], creds });
    await delivery.deliverNow();
    await delivery.deliverNow();
    expect(exec).toHaveBeenCalledTimes(1);
    creds.m2 = { kind: "active", token: "tsc_b" };
    await delivery.deliverNow();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(sentToken(exec.mock.calls[1])).toBe("tsc_b\n");
  });

  it("leaves a revoked machine's file alone, so its calls are told it was revoked", async () => {
    const creds: Record<string, CurrentCredential> = { m2: { kind: "active", token: "tsc_a" } };
    const { delivery, exec } = setup({ hosts: [host("2", "m2")], creds });
    await delivery.deliverNow();
    creds.m2 = { kind: "revoked" };
    await delivery.deliverNow();
    expect(exec).toHaveBeenCalledTimes(1);
    creds.m2 = { kind: "active", token: "tsc_new" };
    await delivery.deliverNow();
    expect(sentToken(exec.mock.calls[1])).toBe("tsc_new\n");
  });

  it("backs off from a machine it can't write to; an explicit push tries it anyway", async () => {
    const clock = { t: 0 };
    const failExec = new Set(["2"]);
    const { delivery, exec, tick } = setup({
      hosts: [host("2", "m2")],
      creds: { m2: { kind: "active", token: "tsc_a" } },
      failExec,
      clock,
    });
    delivery.start();
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    // The timer leaves it alone for a minute, then tries again.
    clock.t = 30_000;
    tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(exec).toHaveBeenCalledTimes(1);
    clock.t = 61_000;
    tick();
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
    // Its next wait is longer (two minutes).
    clock.t = 120_000;
    tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(exec).toHaveBeenCalledTimes(2);
    delivery.stop();
    // An explicit push (an admin's change) ignores the back-off.
    await delivery.deliverNow();
    expect(exec).toHaveBeenCalledTimes(3);
    failExec.clear();
    await delivery.deliverNow();
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it("writes a few machines at once, so a slow one doesn't hold up the rest", async () => {
    let release!: () => void;
    const stuck = new Promise<void>((r) => (release = r));
    const done: string[] = [];
    const d = createCredentialDelivery({
      listHosts: async () => [host("2", "m"), host("3", "m"), host("4", "m")],
      listMachineIds: async () => ["m"],
      currentCredential: async () => ({ kind: "active", token: "tsc_a" }),
      forgetOtherMachines: async () => 0,
      isLocalHost: () => false,
      writeLocal: async () => {},
      exec: async (h) => {
        if (h.id === "2") await stuck;
        done.push(h.id);
        return "__SERVICE_CREDENTIAL_OK__";
      },
      setInterval: vi.fn(() => 0 as unknown as ReturnType<typeof setInterval>),
      clearInterval: vi.fn(),
    });
    const pass = d.deliverNow();
    await vi.waitFor(() => expect(done).toEqual(["3", "4"]));
    release();
    await pass;
    expect(done).toEqual(["3", "4", "2"]);
  });

  it("names a row without a machine id by its own id", async () => {
    const { delivery, currentCredential } = setup({ hosts: [host("9")], creds: { "9": { kind: "active", token: "tsc_a" } } });
    await delivery.deliverNow();
    expect(currentCredential).toHaveBeenCalledWith("9");
  });
});

describe("credential write command", () => {
  const run = (home: string, token: string) =>
    execFileSync("bash", ["-c", credentialWriteCommand()], {
      env: { ...process.env, HOME: home },
      input: `${token}\n`,
    }).toString();

  it("writes the credential from its input, owner-only, and leaves an unchanged file be", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cred-write-"));
    try {
      expect(run(home, "tsc_abc")).toContain("__SERVICE_CREDENTIAL_OK__");
      const file = path.join(home, CREDENTIAL_REL_PATH);
      expect(fs.readFileSync(file, "utf8")).toBe("tsc_abc\n");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      fs.chmodSync(file, 0o644);
      const inode = fs.statSync(file).ino;
      run(home, "tsc_abc");
      expect(fs.statSync(file).ino).toBe(inode);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      run(home, "tsc_new");
      expect(fs.readFileSync(file, "utf8")).toBe("tsc_new\n");
      expect(fs.existsSync(`${file}.new`)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
