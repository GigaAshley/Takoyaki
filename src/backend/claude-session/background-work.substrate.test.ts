/**
 * Puts the background-work substrate suite inside `npx vitest run` — the
 * full-suite gate before every deploy:
 *
 *   - agent-supervisor-background-work.test.sh: the supervisor's reminders to
 *     an agent whose background commands or monitors have run 15 minutes or
 *     more, and monitors counting as busy for dormancy.
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

describe("background-work substrate suite", () => {
  it("agent-supervisor-background-work.test.sh passes", () => {
    const r = run("agent-supervisor-background-work.test.sh");
    expect(r.output).toMatch(/ 0 failed/);
    expect(r.ok).toBe(true);
  }, 70_000);
});
