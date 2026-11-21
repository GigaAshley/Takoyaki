import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MicWaveform, levelToFill } from "./MicWaveform";

describe("levelToFill", () => {
  it("maps silence / zero / NaN to empty and loud speech to full", () => {
    expect(levelToFill(0)).toBe(0);
    expect(levelToFill(Number.NaN)).toBe(0);
    expect(levelToFill(0.000005)).toBe(0); // ≈ −106 dBFS dead feed
    expect(levelToFill(0.5)).toBe(1);
    const mid = levelToFill(0.03); // ≈ −30 dBFS speech
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(1);
  });
});

describe("MicWaveform", () => {
  let now = 0;
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    now = 0;
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  function step(ms: number) {
    now += ms;
    const run = frames;
    frames = [];
    act(() => { for (const cb of run) cb(now); });
  }

  it("stays invisible (keeping its space) while the level reads exact zeros, shows once input arrives", () => {
    let level: number | null = 0;
    render(<MicWaveform read={() => level} />);
    const canvas = screen.getByTestId("mic-waveform");
    for (let i = 0; i < 5; i++) step(60);
    expect(canvas.dataset.live).toBe("false");
    expect(canvas.className).toContain("invisible");
    level = 0.00001; // a dead mic's open blip is still non-zero
    step(60);
    expect(canvas.dataset.live).toBe("true");
    expect(canvas.className).not.toContain("invisible");
  });

  it("stays invisible when the level can't be read", () => {
    render(<MicWaveform read={() => null} />);
    for (let i = 0; i < 5; i++) step(60);
    expect(screen.getByTestId("mic-waveform").dataset.live).toBe("false");
  });
});
