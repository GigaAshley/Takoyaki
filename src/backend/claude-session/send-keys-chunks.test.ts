import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSendKeysCommands,
  splitUtf8,
  SEND_KEYS_CHUNK_BYTES,
  SHELL_COMMAND_MAX_BYTES,
} from "./send-keys-chunks.js";

// Pull the typed text back out of the generated commands by running them with
// a stub `tmux`: send-keys prints its text, set-buffer (-a appends) fills a
// file, paste-buffer prints the file. Proves the quoting round-trips and the
// chunks reassemble to the original body.
function typedText(commands: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "send-keys-chunks-"));
  const stub = `B=${dir}/buf; tmux() {
    for a; do last=$a; done
    case "$1" in
      send-keys) printf %s "$last" ;;
      set-buffer) if [ "$2" = "-a" ]; then printf %s "$last" >> "$B"; else printf %s "$last" > "$B"; fi ;;
      paste-buffer) cat "$B"; rm -f "$B" ;;
    esac
  }; `;
  try {
    return commands
      .map((c) => execFileSync("sh", ["-c", stub + c], { encoding: "utf8" }))
      .join("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("splitUtf8", () => {
  it("keeps every chunk within the byte budget without splitting a character", () => {
    const body = "é😀a".repeat(5000);
    const chunks = splitUtf8(body, 1000);
    expect(chunks.join("")).toBe(body);
    for (const c of chunks) {
      expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(1000);
      expect(c).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });
});

describe("buildSendKeysCommands", () => {
  it("leaves a short body as the single send-keys command the send path always ran", () => {
    expect(buildSendKeysCommands("diamond", "hi 'there'")).toEqual([
      `tmux send-keys -l -t 'diamond' -- 'hi '\\''there'\\'''`,
    ]);
  });

  it("builds a long dictation up in a paste buffer and pastes it once", () => {
    const body = "-starts with a dash. So here's the thing, it's \"long\" — $HOME `x`\nline two. ".repeat(4000);
    const commands = buildSendKeysCommands("diamond", body, "skynet-send-t");
    expect(commands.length).toBeGreaterThan(1);
    const calls = commands.flatMap((c) => c.split(" && tmux ").map((x, i) => (i ? `tmux ${x}` : x)));
    expect(calls.filter((c) => c.startsWith("tmux send-keys"))).toHaveLength(0);
    expect(calls.filter((c) => c.startsWith("tmux paste-buffer"))).toEqual([
      "tmux paste-buffer -p -r -d -b 'skynet-send-t' -t 'diamond'",
    ]);
    expect(calls[calls.length - 1]).toMatch(/^tmux paste-buffer/);
    for (const c of commands) expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(SHELL_COMMAND_MAX_BYTES);
    // each tmux call stays well under tmux's ~16 KB command limit
    for (const call of calls) expect(Buffer.byteLength(call, "utf8")).toBeLessThan(16 * 1024);
    expect(typedText(commands)).toBe(body);
  });

  it("uses a fresh buffer name per send", () => {
    const body = "x".repeat(SEND_KEYS_CHUNK_BYTES + 1);
    expect(buildSendKeysCommands("s", body)[0]).not.toBe(buildSendKeysCommands("s", body)[0]);
  });

  it("chunks by bytes, not characters, for non-ASCII text", () => {
    const body = "日本語".repeat(SEND_KEYS_CHUNK_BYTES);
    expect(typedText(buildSendKeysCommands("s", body))).toBe(body);
  });

  it("leaves a body ending in ; as-is for tmux to keep (escaped trailing ;)", () => {
    expect(buildSendKeysCommands("s", "end;")).toEqual([`tmux send-keys -l -t 's' -- 'end\\;'`]);
  });
});

// The stub can't model tmux's own argument rules (it drops a trailing `;`), so
// round-trip through a real tmux server on a private socket when one exists.
const hasTmux = (() => {
  try {
    execFileSync("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTmux)("buildSendKeysCommands against real tmux", () => {
  function deliver(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "send-keys-tmux-"));
    const env = { ...process.env, TMUX_TMPDIR: dir, TMUX: "" };
    const out = join(dir, "out");
    const run = (args: string[]) => execFileSync("tmux", args, { env });
    try {
      run(["new-session", "-d", "-s", "t", `stty -echo -icanon; cat > ${out}`]);
      execFileSync("sleep", ["0.3"]);
      for (const c of buildSendKeysCommands("t", body)) execFileSync("sh", ["-c", c], { env });
      execFileSync("sleep", ["0.5"]);
      run(["kill-server"]);
      return readFileSync(out, "utf8");
    } finally {
      try {
        run(["kill-server"]);
      } catch {
        /* already gone */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("keeps a ; at the end of a short body", () => {
    expect(deliver("one; two;")).toBe("one; two;");
  });

  it("keeps a ; that lands at the end of every chunk of a long body", () => {
    const piece = "a".repeat(SEND_KEYS_CHUNK_BYTES - 2) + "\\;"; // ends in a literal backslash-semicolon
    const body = piece + "b".repeat(SEND_KEYS_CHUNK_BYTES - 1) + ";" + "tail;";
    expect(splitUtf8(body, SEND_KEYS_CHUNK_BYTES).every((c) => c.endsWith(";"))).toBe(true);
    expect(deliver(body)).toBe(body);
  });
});

