/**
 * Puts the app-scope substrate suites inside `npx vitest run` — the full-suite
 * gate before every deploy:
 *
 *   - app-units.test.sh: where apps live (sidebar, project, conversation),
 *     slugs and ports they reserve, and move-app.sh (Move to) with rollback.
 *   - agent-supervisor-app-move.test.sh: the supervisor handing a leftover
 *     move note to the front door, its turn at the change lock, and stopping
 *     the apps of an archived project.
 *   - fleet-change.test.sh: the front door — requests in arrival order, one
 *     at a time under the change lock; app moves and project archives.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const tests = join(repoRoot, "substrate", "scripts", "tests");

function run(script: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync("bash", [join(tests, script)], { cwd: repoRoot, timeout: 60_000, encoding: "utf-8", stdio: "pipe" });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message}`.slice(-4000) };
  }
}

describe("app-scope substrate suites", () => {
  it("app-units.test.sh passes", () => {
    const r = run("app-units.test.sh");
    expect(r.output).toMatch(/ 0 failed/);
    expect(r.ok).toBe(true);
  }, 70_000);

  it("fleet-change.test.sh passes", () => {
    const r = run("fleet-change.test.sh");
    expect(r.output).toMatch(/ 0 failed/);
    expect(r.ok).toBe(true);
  }, 70_000);

  it("agent-supervisor-app-move.test.sh passes", () => {
    const r = run("agent-supervisor-app-move.test.sh");
    expect(r.output).toMatch(/ 0 failed/);
    expect(r.ok).toBe(true);
  }, 70_000);
});
