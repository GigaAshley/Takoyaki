/**
 * agent-services/engine/jobs.ts — requests by the ID their caller chose, so
 * a call can be waited on again, retried, or come back for after its caller
 * died.
 *
 * A job is keyed by (machine, ID): one machine never sees another's. Starting
 * an ID that's already known joins the existing job instead of running the
 * work again. A finished answer is kept until its caller says it has it, or
 * RETAIN_MS after it finished; the oldest finished answers go first if the
 * kept output files pass MAX_RETAINED_BYTES or there are more than
 * MAX_RETAINED_JOBS of them.
 *
 * Memory only. After a restart every ID is unknown, and the caller is told
 * so rather than the work being run again.
 */

import type { ServiceAnswer } from "./engine.js";

export const RETAIN_MS = 60 * 60 * 1000;
export const MAX_RETAINED_BYTES = 128 * 1024 * 1024;
/** A just-finished answer is never evicted for size before its caller can fetch it. */
const FRESH_MS = 60_000;
export const MAX_RETAINED_JOBS = 10_000;

export type JobWait =
  | { state: "done"; answer: ServiceAnswer }
  | { state: "running" }
  | { state: "unknown" };

interface Job {
  answer: ServiceAnswer | null;
  finishedAt: number | null;
  done: Promise<ServiceAnswer>;
  bytes: number;
}

export interface JobStoreOptions {
  now?: () => number;
  retainMs?: number;
  maxRetainedBytes?: number;
  maxRetainedJobs?: number;
}

export interface JobStore {
  /** Start the job, or join it if this machine already started this ID. */
  start(machineId: string, id: string, run: () => Promise<ServiceAnswer>): { joined: boolean };
  /** The answer once it's ready, waiting up to `timeoutMs` for it. */
  wait(machineId: string, id: string, timeoutMs: number): Promise<JobWait>;
  /** The finished answer, or null while running or unknown. */
  answerOf(machineId: string, id: string): ServiceAnswer | null;
  /** Drop a finished job (its caller has the answer). Running jobs stay. */
  forget(machineId: string, id: string): void;
  /** Drop expired answers and keep within the caps. */
  sweep(): void;
  snapshot(): { running: number; finished: number; retainedBytes: number };
}

const keyOf = (machineId: string, id: string) => `${machineId}\n${id}`;

export function createJobStore(opts: JobStoreOptions = {}): JobStore {
  const now = opts.now ?? Date.now;
  const retainMs = opts.retainMs ?? RETAIN_MS;
  const maxBytes = opts.maxRetainedBytes ?? MAX_RETAINED_BYTES;
  const maxJobs = opts.maxRetainedJobs ?? MAX_RETAINED_JOBS;
  // Insertion order is start order; finished jobs are evicted oldest first.
  const jobs = new Map<string, Job>();
  let retainedBytes = 0;

  function drop(key: string): void {
    const job = jobs.get(key);
    if (!job || job.answer === null) return;
    retainedBytes -= job.bytes;
    jobs.delete(key);
  }

  function sweep(): void {
    const t = now();
    let finished = 0;
    for (const [key, job] of jobs) {
      if (job.finishedAt === null) continue;
      if (t - job.finishedAt >= retainMs) drop(key);
      else finished++;
    }
    for (const [key, job] of jobs) {
      if (retainedBytes <= maxBytes && finished <= maxJobs) break;
      if (job.finishedAt === null || t - job.finishedAt < FRESH_MS) continue;
      drop(key);
      finished--;
    }
  }

  return {
    start(machineId, id, run) {
      const key = keyOf(machineId, id);
      if (jobs.has(key)) return { joined: true };
      const job: Job = { answer: null, finishedAt: null, bytes: 0, done: null as unknown as Promise<ServiceAnswer> };
      job.done = run().then((answer) => {
        job.answer = answer;
        job.finishedAt = now();
        job.bytes = answer.files.reduce((n, f) => n + f.bytes.byteLength, 0);
        if (jobs.get(key) === job) {
          retainedBytes += job.bytes;
          sweep();
        }
        return answer;
      });
      jobs.set(key, job);
      return { joined: false };
    },

    async wait(machineId, id, timeoutMs) {
      const job = jobs.get(keyOf(machineId, id));
      if (!job) return { state: "unknown" };
      if (job.answer) return { state: "done", answer: job.answer };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)));
      const answer = await Promise.race([job.done, timedOut]);
      clearTimeout(timer);
      return answer ? { state: "done", answer } : { state: "running" };
    },

    answerOf(machineId, id) {
      return jobs.get(keyOf(machineId, id))?.answer ?? null;
    },

    forget(machineId, id) {
      drop(keyOf(machineId, id));
    },

    sweep,

    snapshot() {
      let running = 0;
      for (const job of jobs.values()) if (job.answer === null) running++;
      return { running, finished: jobs.size - running, retainedBytes };
    },
  };
}
