/**
 * Puts the archive / un-archive substrate suites inside `npx vitest run` — the
 * full-suite gate before every deploy:
 *
 *   - agent-supervisor-archive-scan.sh: finishing a claimed agent archive
 *     (stop the agent, switch its chat account off, move its folder) and the
 *     180-day sleep sweep's guards.
 *   - agent-supervisor-role-archive.test.sh: a claimed role's folder follows its
 *     agents; a failing archive says why in its claim and is retried.
 *   - agent-supervisor-unarchive.test.sh: an accepted agent un-archive brought
 *     back by the supervisor (the chat account's rules included) and answered.
 *   - agent-supervisor-archive-notes.test.sh: notes left the old way handed to
 *     the front door; claimed agents never launched; the early wake.
 *   - agent-supervisor-convo-apps.test.sh: a conversation's apps stopped with it
 *     and restored with it.
 *   - roles-frontmatter-conformance.test.sh: every copy of the roles parser,
 *     the front door's included, reads `roles:` the same way.
 *   - agent-supervisor-retire-monitor-first.test.sh, agent-supervisor-stray-procs.test.sh,
 *     agent-supervisor-desktop-teardown.test.sh: the retire's order — the agent stops first
 *     and stays stopped; strays and the desktop go before the folder moves.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const tests = join(repoRoot, "substrate", "scripts", "tests");

function run(script: string, timeout: number): { ok: boolean; output: string } {
  try {
    const output = execFileSync("bash", [join(tests, script)], { cwd: repoRoot, timeout, encoding: "utf-8", stdio: "pipe" });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message}`.slice(-4000) };
  }
}

describe("archive substrate suites", () => {
  for (const [script, timeout] of [
    ["agent-supervisor-archive-scan.sh", 240_000],
    ["agent-supervisor-role-archive.test.sh", 120_000],
    ["agent-supervisor-unarchive.test.sh", 180_000],
    ["agent-supervisor-archive-notes.test.sh", 60_000],
    ["agent-supervisor-convo-apps.test.sh", 60_000],
    ["roles-frontmatter-conformance.test.sh", 60_000],
    ["agent-supervisor-retire-monitor-first.test.sh", 120_000],
    ["agent-supervisor-stray-procs.test.sh", 120_000],
    ["agent-supervisor-desktop-teardown.test.sh", 120_000],
  ] as const) {
    it(`${script} passes`, () => {
      const r = run(script, timeout);
      expect(r.output).toMatch(/FAIL: 0|\b0 failed/);
      expect(r.ok).toBe(true);
    }, timeout + 10_000);
  }
});
