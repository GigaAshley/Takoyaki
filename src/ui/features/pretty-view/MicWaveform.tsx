// Live level trace — a scrolling bar trace of an input level, filling the
// width it is given. Shown in the composer's mic pill so a dead mic (a flat
// line) is obvious while the user is still talking; in voice mode it also
// shows the reply's audio while it is read aloud.
//
// Samples `read()` (windowed RMS 0–1) every SAMPLE_MS on an animation frame
// and draws the latest samples onto a canvas, newest on the right. Stays
// invisible (keeping its space, so nothing beside it moves) until `read()`
// returns something other than null or an exact 0: an analyser that never
// receives the stream (seen on iPhone Safari) reads pure zeros while the
// recording itself is fine, and a flat line there would cry wolf. A real dead
// mic still shows — its feed carries a non-zero blip as it opens, then
// flatlines. Bars take the canvas's text colour.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const SAMPLE_MS = 50;
/** Enough history for the widest pill. */
const HISTORY = 240;
const BAR_WIDTH = 2;
const BAR_GAP = 1.5;
const HEIGHT = 20;
/** dBFS mapped to an empty bar / a full bar. Speech sits around −35 to −15. */
const FLOOR_DB = -60;
const CEIL_DB = -15;
const MIN_BAR_PX = 1.5;

/** RMS (0–1) → bar fill 0–1 on a dB scale. */
export function levelToFill(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB)));
}

export interface MicWaveformProps {
  read: () => number | null;
  className?: string;
}

export function MicWaveform({ read, className }: MicWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const fills: number[] = new Array(HISTORY).fill(0);
    let seen = false;
    let last = 0;
    let raf = 0;

    const draw = () => {
      const canvas = canvasRef.current;
      const g = canvas?.getContext("2d");
      if (!canvas || !g) return;
      const width = canvas.clientWidth;
      if (width <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== HEIGHT * dpr) {
        canvas.width = Math.round(width * dpr);
        canvas.height = HEIGHT * dpr;
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, width, HEIGHT);
      g.fillStyle = getComputedStyle(canvas).color;
      const count = Math.min(HISTORY, Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP)));
      // Right-align so the newest bar sits at the right edge.
      const x0 = width - count * (BAR_WIDTH + BAR_GAP) + BAR_GAP;
      for (let i = 0; i < count; i++) {
        const h = Math.max(MIN_BAR_PX, fills[HISTORY - count + i] * HEIGHT);
        g.fillRect(x0 + i * (BAR_WIDTH + BAR_GAP), (HEIGHT - h) / 2, BAR_WIDTH, h);
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < SAMPLE_MS) return;
      last = now;
      const rms = readRef.current();
      // Unreadable for now: keep the trace as it is (redrawn, in case the
      // width changed) rather than inventing silence.
      if (rms === null) {
        if (seen) draw();
        return;
      }
      if (!seen) {
        if (rms === 0) return;
        seen = true;
        setVisible(true);
      }
      fills.shift();
      fills.push(levelToFill(rms));
      draw();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      data-testid="mic-waveform"
      data-live={visible ? "true" : "false"}
      aria-hidden="true"
      style={{ height: HEIGHT }}
      className={cn("block w-full min-w-0", visible ? "visible" : "invisible", className)}
    />
  );
}
