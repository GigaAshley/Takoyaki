import { describe, it, expect, vi } from "vitest";
import { askFirstAnsweringHost } from "./ask-first-answering-host";

describe("askFirstAnsweringHost", () => {
  it("asks only the first host when it answers", async () => {
    const ask = vi.fn(async (id: number) => `answer from ${id}`);
    expect(await askFirstAnsweringHost([3, 6, 7], ask)).toBe("answer from 3");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("moves on past hosts that fail", async () => {
    const ask = vi.fn(async (id: number) => {
      if (id !== 7) throw new Error("down");
      return "seven";
    });
    expect(await askFirstAnsweringHost([3, 6, 7], ask)).toBe("seven");
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("gives null when no host answers", async () => {
    expect(await askFirstAnsweringHost([3], async () => { throw new Error("x"); })).toBeNull();
    expect(await askFirstAnsweringHost([], async () => 1)).toBeNull();
  });

  it("stops asking once cancelled", async () => {
    let cancelled = false;
    const ask = vi.fn(async () => { cancelled = true; throw new Error("x"); });
    expect(await askFirstAnsweringHost([3, 6], ask, () => cancelled)).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
