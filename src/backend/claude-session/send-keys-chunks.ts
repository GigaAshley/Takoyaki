// Turns a compose body into the shell commands that type it into a tmux pane.
//
// tmux refuses a single command over ~16 KB ("command too long" — the client
// hands the whole argv to the server in one message). A body that fits one
// chunk is typed with the single `send-keys -l` command the send path always
// ran. A longer body is built up in a tmux paste buffer with `set-buffer -a`
// calls of at most SEND_KEYS_CHUNK_BYTES each, then pasted in one go with
// `paste-buffer -p` (bracketed paste, -r keeps newlines as typed, -d deletes
// the buffer). Typing it as several `send-keys -l` calls instead would make
// Claude Code record several pastes, which the parser rejoins with blank lines
// between them — the bubble would never match the send and the watchdog would
// re-send it.
//
// The tmux calls are joined with && into as few shell commands as fit under
// SHELL_COMMAND_MAX_BYTES (each runs as one `sh -c` argument, which Linux caps
// at 128 KB); run them in order.

import { randomBytes } from "node:crypto";

export const SEND_KEYS_CHUNK_BYTES = 8000;
export const SHELL_COMMAND_MAX_BYTES = 64 * 1024;

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

// tmux reads an argument ending in `;` as the end of a command and drops the
// `;` (and turns a trailing `\;` into `;`). Putting a backslash before a
// trailing `;` makes tmux keep exactly the original text.
const tmuxArg = (s: string): string => (s.endsWith(";") ? `${s.slice(0, -1)}\\;` : s);

/** Split on code-point boundaries so no chunk exceeds maxBytes of UTF-8. */
export function splitUtf8(body: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of body) {
    const n = Buffer.byteLength(ch, "utf8");
    if (currentBytes + n > maxBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += n;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function buildSendKeysCommands(
  tmuxTarget: string,
  body: string,
  bufferName = `skynet-send-${randomBytes(6).toString("hex")}`,
): string[] {
  const target = shellQuote(tmuxTarget);
  const chunks = splitUtf8(body, SEND_KEYS_CHUNK_BYTES);
  if (chunks.length <= 1) {
    return [`tmux send-keys -l -t ${target} -- ${shellQuote(tmuxArg(body))}`];
  }
  const buffer = shellQuote(bufferName);
  const calls = chunks.map(
    (chunk, i) => `tmux set-buffer ${i > 0 ? "-a " : ""}-b ${buffer} -- ${shellQuote(tmuxArg(chunk))}`,
  );
  calls.push(`tmux paste-buffer -p -r -d -b ${buffer} -t ${target}`);

  const commands: string[] = [];
  let batch = "";
  for (const call of calls) {
    if (batch.length > 0 && Buffer.byteLength(batch, "utf8") + 4 + Buffer.byteLength(call, "utf8") > SHELL_COMMAND_MAX_BYTES) {
      commands.push(batch);
      batch = "";
    }
    batch = batch.length > 0 ? `${batch} && ${call}` : call;
  }
  if (batch.length > 0) commands.push(batch);
  return commands;
}
