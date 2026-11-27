import { describe, it, expect, vi } from "vitest";
import { createJobStore } from "./jobs.js";
import type { ServiceAnswer } from "./engine.js";

const answer = (n: number, fileBytes = 0): ServiceAnswer => ({
  body: { ok: true, service: "echo", result: { n }, files: [] },
  files: fileBytes > 0 ? [{ ext: "png", bytes: Buffer.alloc(fileBytes) }] : [],
});

/** A job whose answer arrives when `finish` is called. */
function deferred() {
  let finish!: (a: ServiceAnswer) => void;
  const run = vi.fn(() => new Promise<ServiceAnswer>((r) => (finish = r)));
  return { run, finish: (a: ServiceAnswer) => finish(a) };
}

describe("job store", () => {
  it("runs a new ID once and answers when it's done", async () => {
    const jobs = createJobStore();
    const d = deferred();
    expect(jobs.start("m1", "id-1", d.run)).toEqual({ joined: false });
    const waiting = jobs.wait("m1", "id-1", 5_000);
    d.finish(answer(1));
    expect(await waiting).toEqual({ state: "done", answer: answer(1) });
    expect(d.run).toHaveBeenCalledOnce();
  });

  it("joins an ID that's already running instead of running it again", async () => {
    const jobs = createJobStore();
    const d = deferred();
    const again = vi.fn(async () => answer(2));
    jobs.start("m1", "id-1", d.run);
    expect(jobs.start("m1", "id-1", again)).toEqual({ joined: true });
    d.finish(answer(1));
    expect(await jobs.wait("m1", "id-1", 1_000)).toEqual({ state: "done", answer: answer(1) });
    expect(again).not.toHaveBeenCalled();
  });

  it("keeps machines apart: the same ID on another machine is its own job, and unknown to the first", async () => {
    const jobs = createJobStore();
    jobs.start("m1", "id-1", async () => answer(1));
    expect(jobs.start("m2", "id-1", async () => answer(2))).toEqual({ joined: false });
    expect(await jobs.wait("m2", "id-1", 1_000)).toEqual({ state: "done", answer: answer(2) });
    expect(await jobs.wait("m3", "id-1", 0)).toEqual({ state: "unknown" });
  });

  it("says running when the wait ends first", async () => {
    const jobs = createJobStore();
    jobs.start("m1", "id-1", deferred().run);
    expect(await jobs.wait("m1", "id-1", 10)).toEqual({ state: "running" });
  });

  it("answers unknown for an ID it never saw (e.g. after a restart)", async () => {
    expect(await createJobStore().wait("m1", "nope", 0)).toEqual({ state: "unknown" });
  });

  it("keeps a finished answer for a caller to come back to, until it's collected", async () => {
    const jobs = createJobStore();
    jobs.start("m1", "id-1", async () => answer(1, 3));
    await jobs.wait("m1", "id-1", 1_000);
    expect(jobs.answerOf("m1", "id-1")?.files[0].bytes.byteLength).toBe(3);
    jobs.forget("m1", "id-1");
    expect(jobs.answerOf("m1", "id-1")).toBeNull();
    expect(await jobs.wait("m1", "id-1", 0)).toEqual({ state: "unknown" });
  });

  it("never forgets a job that's still running", async () => {
    const jobs = createJobStore();
    const d = deferred();
    jobs.start("m1", "id-1", d.run);
    jobs.forget("m1", "id-1");
    expect(await jobs.wait("m1", "id-1", 0)).toEqual({ state: "running" });
  });

  it("drops answers nobody collected after the retention time", async () => {
    let clock = 0;
    const jobs = createJobStore({ now: () => clock, retainMs: 1_000 });
    jobs.start("m1", "id-1", async () => answer(1));
    await jobs.wait("m1", "id-1", 1_000);
    clock = 999;
    jobs.sweep();
    expect(jobs.answerOf("m1", "id-1")).not.toBeNull();
    clock = 1_000;
    jobs.sweep();
    expect(jobs.answerOf("m1", "id-1")).toBeNull();
  });

  it("drops the oldest finished answers past the size or count caps, never running or just-finished ones", async () => {
    let clock = 0;
    const jobs = createJobStore({ now: () => clock, maxRetainedBytes: 10, maxRetainedJobs: 2 });
    const running = deferred();
    jobs.start("m1", "running", running.run);
    for (const id of ["a", "b", "c"]) {
      clock += 120_000;
      jobs.start("m1", id, async () => answer(0, 4));
      await jobs.wait("m1", id, 1_000);
    }
    // 12 bytes over a 10-byte cap: the oldest goes.
    expect(jobs.answerOf("m1", "a")).toBeNull();
    expect(jobs.answerOf("m1", "b")).not.toBeNull();
    expect(jobs.answerOf("m1", "c")).not.toBeNull();
    expect(jobs.snapshot()).toEqual({ running: 1, finished: 2, retainedBytes: 8 });
    clock += 120_000;
    jobs.start("m1", "d", async () => answer(0));
    await jobs.wait("m1", "d", 1_000);
    // Three finished over a cap of two.
    expect(jobs.answerOf("m1", "b")).toBeNull();
    expect(await jobs.wait("m1", "running", 0)).toEqual({ state: "running" });
  });

  it("keeps a just-finished answer bigger than the cap long enough to be fetched", async () => {
    let clock = 0;
    const jobs = createJobStore({ now: () => clock, maxRetainedBytes: 10 });
    jobs.start("m1", "big", async () => answer(0, 50));
    await jobs.wait("m1", "big", 1_000);
    jobs.sweep();
    expect(jobs.answerOf("m1", "big")?.files[0].bytes.byteLength).toBe(50);
    clock = 61_000;
    jobs.sweep();
    expect(jobs.answerOf("m1", "big")).toBeNull();
  });
});
