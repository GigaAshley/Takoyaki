/**
 * person-file-name.ts — where a person's About you file lives on a machine.
 *
 * Mirrors substrate/scripts/person-files.py (the SessionStart hook that hands
 * these files to the agents shared with each person): `~/fleet/people/<name>.md`,
 * every character outside letters, digits, `.`, `_`, `-` and `@`
 * percent-encoded as UTF-8 bytes, and a name ending `.self-edit-hash` or
 * `.self-delete` getting that last dot encoded. The username is the one the
 * machine's people list carries (plainField), since that's what the hook reads.
 * Imports nothing, so the routes that use it stay light.
 */
export const PEOPLE_DIR_PATH = "~/fleet/people";

const FIELD_MAX = 128;

/**
 * One plain line: control characters (newlines included) become spaces,
 * length capped. How the machine's people list writes every username.
 */
export function plainField(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim().slice(0, FIELD_MAX);
}

const SAFE = /^[A-Za-z0-9._@-]$/;
const MARKER_SUFFIXES = [".self-edit-hash", ".self-delete"];

export function personFileName(username: string): string {
  let name = "";
  for (const ch of plainField(username)) {
    if (SAFE.test(ch)) {
      name += ch;
    } else {
      for (const b of Buffer.from(ch, "utf-8")) {
        name += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  for (const suffix of MARKER_SUFFIXES) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length) + "%2E" + suffix.slice(1);
    }
  }
  return `${name}.md`;
}

export function personFilePath(username: string): string {
  return `${PEOPLE_DIR_PATH}/${personFileName(username)}`;
}

/**
 * True for any person file path — one file name, nothing that climbs out of
 * the people folder. Which person's file it is isn't checked: people sharing a
 * machine is organization, not access control.
 */
export function isPersonFilePath(p: string): boolean {
  const prefix = `${PEOPLE_DIR_PATH}/`;
  if (!p.startsWith(prefix)) return false;
  const name = p.slice(prefix.length);
  return /^[A-Za-z0-9._@%-]+\.md$/.test(name);
}
