/**
 * front-door.test.ts — the backend side of the machine's front door against
 * the real fleet-change (substrate/scripts/fleet-change) in a scratch home:
 * this backend's own machine through the "bind mount" (a temp dir), and a
 * remote machine through the short command (execCommand runs it locally with
 * HOME pointed at the scratch home).
 */

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client as SSHClientType } from "ssh2";

vi.mock("../utils/logger.js", () => ({
  databaseLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let home = "";
vi.mock("../ssh/tmux-helper.js", () => ({
  execCommand: (_conn: unknown, cmd: string) =>
    new Promise<string>((resolve, reject) => {
      execFile("bash", ["-c", cmd], { env: { ...process.env, HOME: home } }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    }),
}));

import { frontDoorHttp, frontDoorStatus, parseFrontDoorLine, requestIdFrom, submitFrontDoor } from "./front-door.js";

const FLEET_CHANGE = path.join(__dirname, "..", "..", "..", "substrate", "scripts", "fleet-change");
const remote = {} as SSHClientType;

const APP_UNITS = path.join(__dirname, "..", "..", "..", "substrate", "skills", "app-development", "app-units.sh");

function install(): void {
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.copyFileSync(FLEET_CHANGE, path.join(home, ".local", "bin", "fleet-change"));
  fs.mkdirSync(path.join(home, ".claude", "skills", "app-development"), { recursive: true });
  fs.copyFileSync(APP_UNITS, path.join(home, ".claude", "skills", "app-development", "app-units.sh"));
}

function project(slug: string, displayName: string): void {
  fs.mkdirSync(path.join(home, "fleet", "projects", slug), { recursive: true });
  fs.writeFileSync(path.join(home, "fleet", "projects", slug, "project.md"), `---\ndisplayName: ${displayName}\n---\n`);
}

/** Run the machine's listener until nothing is waiting. */
function serveOnce(): void {
  execFileSync("python3", [FLEET_CHANGE, "serve", "--until-idle"], {
    env: { ...process.env, HOME: home, FLEET_CHANGE_FLEET_DIR: path.join(home, "fleet"), FLEET_CHANGE_POLL_S: "0.02" },
    stdio: "pipe",
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "front-door-"));
  fs.mkdirSync(path.join(home, "fleet", "projects"), { recursive: true });
  process.env.HOME_HOST_DIR = home;
});

afterEach(() => {
  delete process.env.HOME_HOST_DIR;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("submitFrontDoor — this backend's own machine (bind mount)", () => {
  it("writes the request down, reports it pending, then returns the listener's outcome", async () => {
    install();
    project("garden", "Garden");
    const first = await submitFrontDoor(null, "project-contents", { slug: "garden" }, { id: "c1", waitS: 0.2 });
    expect(first).toEqual({ state: "pending", id: "c1", seq: null, stage: "received" });
    serveOnce();
    const again = await submitFrontDoor(null, "project-contents", { slug: "garden" }, { id: "c1", waitS: 1 });
    expect(again.state).toBe("done");
    expect(again).toMatchObject({ seq: 1, result: { project: "garden", projects: [{ slug: "garden", displayName: "Garden" }] } });
    // Sent twice, taken in once.
    expect(fs.readdirSync(path.join(home, "fleet", ".changes", "incoming"))).toEqual([]);
  });

  it("reports the machine still updating when fleet-change isn't installed", async () => {
    const r = await submitFrontDoor(null, "project-contents", { slug: "garden" }, { id: "c2", waitS: 0.1 });
    expect(r).toEqual({ state: "not_installed", id: "c2" });
  });
});

describe("archives on this backend's own machine", () => {
  function agent(name: string, roles = ""): void {
    fs.mkdirSync(path.join(home, "fleet", "identities", name), { recursive: true });
    fs.writeFileSync(path.join(home, "fleet", "identities", name, `${name}.md`), `---\nroles: [${roles}]\n---\n`);
  }

  it("an agent archive is done once claimed, and says it's still finishing until the folder moves", async () => {
    install();
    agent("finch");
    await submitFrontDoor(null, "agent-archive", { name: "finch" }, { id: "a1", waitS: 0 });
    serveOnce();
    const r = await submitFrontDoor(null, "agent-archive", { name: "finch" }, { id: "a1", waitS: 1 });
    expect(r).toMatchObject({ state: "done", finishing: { pending: ["finch"] } });
    // A claim failing for over ten minutes says why.
    const claim = path.join(home, "fleet", "identities", "finch", ".archiving");
    const c = JSON.parse(fs.readFileSync(claim, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(claim, JSON.stringify({ ...c, failing_since: Date.now() / 1000 - 700, last_error: "couldn't switch the chat account off" }));
    expect(await frontDoorStatus(null, "a1", 0)).toMatchObject({ finishing: { pending: ["finch"], stuck: { finch: "couldn't switch the chat account off" } } });
    fs.mkdirSync(path.join(home, "fleet", "identities-archive"), { recursive: true });
    fs.renameSync(path.join(home, "fleet", "identities", "finch"), path.join(home, "fleet", "identities-archive", "finch"));
    const after = await frontDoorStatus(null, "a1", 0);
    expect(after).toMatchObject({ state: "done" });
    expect(after && "finishing" in after ? after.finishing : undefined).toBeUndefined();
  });

  it("an agent un-archive reads as still finishing until the supervisor answers it", async () => {
    install();
    fs.mkdirSync(path.join(home, "fleet", "identities-archive", "wren"), { recursive: true });
    fs.writeFileSync(path.join(home, "fleet", "identities-archive", "wren", "wren.md"), "---\nroles: []\n---\n");
    await submitFrontDoor(null, "agent-unarchive", { name: "wren" }, { id: "u1", waitS: 0 });
    serveOnce();
    expect(await frontDoorStatus(null, "u1", 0)).toMatchObject({ state: "pending", stage: "finishing" });
    execFileSync("python3", [FLEET_CHANGE, "finish", "u1", "done", "--result", '{"name":"wren"}'], {
      env: { ...process.env, HOME: home, FLEET_CHANGE_FLEET_DIR: path.join(home, "fleet") },
      stdio: "pipe",
    });
    expect(await frontDoorStatus(null, "u1", 0)).toMatchObject({ state: "done", result: { name: "wren" } });
  });
});

describe("submitFrontDoor — a remote machine (the short command over SSH)", () => {
  it("returns a refusal with the machine's reason", async () => {
    install();
    fs.mkdirSync(path.join(home, "fleet", "projects", "archive", "garden"), { recursive: true });
    fs.writeFileSync(path.join(home, "fleet", "projects", "archive", "garden", "project.md"), "---\ndisplayName: Garden\n---\n");
    fs.mkdirSync(path.join(home, "fleet", "apps", "tally"), { recursive: true });
    const pending = await submitFrontDoor(remote, "app-move", { slug: "tally", to: "project", project: "garden" }, { id: "m1", waitS: 0 });
    expect(pending.state).toBe("pending");
    serveOnce();
    const r = await submitFrontDoor(remote, "app-move", { slug: "tally", to: "project", project: "garden" }, { id: "m1", waitS: 1 });
    expect(r).toMatchObject({ state: "refused", code: "project_archived", reason: '"Garden" is archived' });
  });

  it("reports the machine still updating when fleet-change isn't installed", async () => {
    const r = await submitFrontDoor(remote, "project-contents", { slug: "garden" }, { id: "c3", waitS: 0 });
    expect(r).toEqual({ state: "not_installed", id: "c3" });
  });
});

describe("parseFrontDoorLine / frontDoorHttp / requestIdFrom", () => {
  it("maps every state", () => {
    expect(frontDoorHttp(parseFrontDoorLine("a", '{"state":"done","seq":3,"result":{"x":1}}'))).toEqual({
      status: 200, body: { ok: true, requestId: "a", result: { x: 1 } },
    });
    expect(frontDoorHttp(parseFrontDoorLine("a", '{"state":"refused","seq":3,"code":"archived","reason":"it\'s archived"}'))).toEqual({
      status: 409, body: { error: "it's archived", code: "archived", requestId: "a" },
    });
    expect(frontDoorHttp(parseFrontDoorLine("a", '{"state":"failed","code":"move_failed","reason":"boom"}')).status).toBe(500);
    expect(frontDoorHttp(parseFrontDoorLine("a", '{"state":"running","seq":4}'))).toMatchObject({ status: 202, body: { pending: true, stage: "running" } });
    expect(frontDoorHttp(parseFrontDoorLine("a", '{"state":"not_installed"}')).status).toBe(503);
    expect(() => parseFrontDoorLine("a", '{"state":"unknown"}')).toThrow(/lost the request/);
    expect(() => parseFrontDoorLine("a", "not json")).toThrow(/unreadable/);
  });

  it("keeps a usable client id and replaces anything else", () => {
    expect(requestIdFrom("click-1")).toBe("click-1");
    expect(requestIdFrom("bad id; rm -rf")).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
