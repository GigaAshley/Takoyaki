import { kitConfirm } from "@/components/kit/dialogs";
import type { FileChangedError } from "@/api/file-changed-error";

// ─── The one question every whole-file editor asks when its file changed ─────
// Same choice as About you and the skill editors: reload the newer version, or keep the
// edits — after which saving again overwrites the newer version on purpose.

/** The line an editor shows after "Keep my edits". */
export const KEPT_EDITS_NOTE =
  "Not saved — it changed since you started editing. Save again to overwrite it with your edits.";
/** The line an editor shows when its file was deleted or moved meanwhile. */
export const GONE_NOTE = "Not saved — it was deleted or moved since you opened it. Save again to put it back with your edits.";

/**
 * Ask reload-or-keep. "reload": show the newer version (the edits are dropped). "keep": the
 * edits stay, and `err.version` is what the next save goes over. A file that's gone has
 * nothing to reload: "keep", with the gone note.
 */
export async function askReloadOrKeep(err: FileChangedError): Promise<"reload" | "keep"> {
  if (err.version === null) return "keep";
  const reload = await kitConfirm({
    title: "This file changed on disk",
    body: "It changed since you started editing. Reload it, or keep your edits? Reloading loses your edits.",
    confirmLabel: "Reload",
    cancelLabel: "Keep my edits",
    destructive: true,
  });
  return reload ? "reload" : "keep";
}

/** The note for a kept draft. */
export function keptNote(err: FileChangedError): string {
  return err.version === null ? GONE_NOTE : KEPT_EDITS_NOTE;
}
