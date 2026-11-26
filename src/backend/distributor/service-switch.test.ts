/**
 * An agent service's skill and helper reach only the machines it is
 * switched on for: catalogForMachine withdraws the rest, and both sweeps
 * (over SSH and the local one) remove a withdrawn file.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("./log-tags.js", () => ({
  logSweepResult: vi.fn(),
  logItemChanged: vi.fn(),
  logItemFailed: vi.fn(),
  logSweepHookError: vi.fn(),
}));
vi.mock("./run-bootstrap.js", () => ({
  runBootstrapForHost: vi.fn(async () => ({ rolesKeyMigrationOk: true, roleSkillsMigrationOk: true })),
}));
vi.mock("../utils/logger.js", () => {
  const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), debug: vi.fn() };
  return { sshLogger: stub, systemLogger: stub, databaseLogger: stub };
});

import type { SshChannel } from "../fleet-status/ssh-poll-orchestrator.js";
import type { BundledCatalogEntry, CatalogEntry } from "./catalog.js";
import { FLEET_SUBSTRATE_CATALOG } from "./catalog.js";
import { FULL_SUBSTRATE_CATALOG, catalogForMachine } from "./full-catalog.js";
import { runSweepForHost } from "./run-sweep.js";
import { installFleetSubstrateLocally } from "./local-fleet-install.js";

const serviceRows = () =>
  FULL_SUBSTRATE_CATALOG.filter((r): r is BundledCatalogEntry => r.sourceKind === "bundled" && !!r.service);

describe("catalogForMachine", () => {
  it("withdraws the rows of every service not switched on, and leaves the rest alone", () => {
    const catalog = catalogForMachine(new Set(["image-gen"]));
    expect(catalog).toHaveLength(FULL_SUBSTRATE_CATALOG.length);
    const byPath = new Map(catalog.map((r) => [r.installPath, r]));
    for (const row of serviceRows()) {
      const got = byPath.get(row.installPath) as BundledCatalogEntry;
      expect(got.withdrawn ?? false).toBe(row.service !== "image-gen");
    }
    for (const row of FLEET_SUBSTRATE_CATALOG) {
      expect((byPath.get(row.installPath) as BundledCatalogEntry).withdrawn).toBeUndefined();
    }
  });

  it("with nothing switched on, every service's skill and helper are withdrawn", () => {
    const withdrawn = catalogForMachine(new Set()).filter(
      (r) => r.sourceKind === "bundled" && r.withdrawn,
    );
    expect(withdrawn.map((r) => r.installPath)).toEqual(serviceRows().map((r) => r.installPath));
    expect(withdrawn.map((r) => r.installPath)).toEqual(
      expect.arrayContaining(["~/.claude/skills/image-gen/SKILL.md", "~/.local/bin/agent-phone"]),
    );
  });
});

const withdrawnRow: CatalogEntry = {
  slug: "image-gen-helper",
  sourceKind: "bundled",
  bundledPath: "/nonexistent/image-gen",
  installPath: "~/.local/bin/image-gen",
  restartHook: null,
  service: "image-gen",
  withdrawn: true,
};

describe("the SSH sweep", () => {
  it("removes a withdrawn file from the user's home, without sudo, and never reads its bytes", async () => {
    const commands: string[] = [];
    const channel = {
      exec: vi.fn(async (cmd: string) => {
        commands.push(cmd);
        return "__REMOVE_DID__\n";
      }),
    } as unknown as SshChannel;
    const readBundledBytes = vi.fn(async () => null);
    const result = await runSweepForHost(
      channel,
      { id: "2", name: "thenasty", username: "ubuntu" },
      [withdrawnRow],
      { readBundledBytes },
    );
    expect(result).toMatchObject({ itemsChecked: 1, itemsChanged: 1, itemsFailed: 0 });
    expect(readBundledBytes).not.toHaveBeenCalled();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("~/'.local/bin/image-gen'");
    expect(commands[0]).not.toContain("sudo");
  });

  it("is quiet when the file was never there", async () => {
    const channel = { exec: vi.fn(async () => "__REMOVE_ALREADY__\n") } as unknown as SshChannel;
    const result = await runSweepForHost(
      channel,
      { id: "2", name: "thenasty", username: "ubuntu" },
      [withdrawnRow],
      { readBundledBytes: async () => null },
    );
    expect(result).toMatchObject({ itemsChanged: 0, itemsFailed: 0 });
  });
});

describe("the local sweep", () => {
  let home: string | null = null;
  const saved = process.env.HOME_HOST_DIR;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = null;
    if (saved === undefined) delete process.env.HOME_HOST_DIR;
    else process.env.HOME_HOST_DIR = saved;
  });

  it("removes a withdrawn file from this machine's home", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "service-switch-"));
    process.env.HOME_HOST_DIR = home;
    const installed = path.join(home, ".local/bin/image-gen");
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, "#!/bin/sh\n");
    const result = await installFleetSubstrateLocally({ id: "1", name: "t1000" }, [withdrawnRow], {
      readBundledBytes: async () => null,
    });
    expect(result).toMatchObject({ itemsChanged: 1, itemsFailed: 0 });
    expect(fs.existsSync(installed)).toBe(false);
  });
});
