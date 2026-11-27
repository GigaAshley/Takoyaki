// A whole-file save refused because the file isn't what the editor opened any more: it
// changed (an agent, another device), was deleted, or — for a new file — one of that name
// is already there. `version` is the file's version now (null: there's no file), which a
// deliberate second save sends to overwrite it.
export class FileChangedError extends Error {
  constructor(
    readonly version: string | null,
    readonly exists = false,
  ) {
    super(exists ? "there's already a file of that name" : "it changed since you opened it");
    this.name = "FileChangedError";
  }
}

/** What an editor sends for a file that isn't there yet. */
export const ABSENT_VERSION = "absent";
