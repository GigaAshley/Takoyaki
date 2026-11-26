/**
 * ServiceKeyRow — one key in Admin → Services (a service's own key, or one
 * person's key): status, a write-only input, Save, and Remove.
 *
 * The value is never shown: the API never returns it, and the input always
 * starts empty. Saving replaces whatever is stored.
 */

import { useState } from "react";
import { adminErrorMessage, formatAdminDate } from "./admin-ui";
import {
  KitBanner,
  KitButton,
  KitChip,
  KitInput,
  kitConfirm,
} from "@/components/kit";

export interface ServiceKeyRowProps {
  /** Unique within the page; prefixes the test ids. */
  id: string;
  label: string;
  /** e.g. where to get it. */
  description?: string | null;
  isSet: boolean;
  updatedAt: string | null;
  /** Shown when not set, e.g. "the company default is used". */
  unsetNote?: string;
  /** A chip beside the label, e.g. "Not needed with this provider". */
  chip?: { text: string; tone: "neutral" | "warn" };
  /** What removing it means, for the confirm. */
  removeBody?: string;
  /** Read-only store: status only. */
  readOnly?: boolean;
  onSave: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
}

export function ServiceKeyRow({
  id: rawId,
  label,
  description,
  isSet,
  updatedAt,
  unsetNote,
  chip,
  removeBody = "Agents will no longer be able to use it.",
  readOnly = false,
  onSave,
  onClear,
}: ServiceKeyRowProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"saving" | "removing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const id = `service-key-${rawId}`;

  const status = isSet
    ? `Set${updatedAt ? ` · updated ${formatAdminDate(updatedAt)}` : ""}`
    : unsetNote
      ? `Not set · ${unsetNote}`
      : "Not set";

  const save = async () => {
    const value = draft.trim();
    if (!value) return;
    setBusy("saving");
    setError(null);
    setSaved(false);
    try {
      await onSave(value);
      setDraft("");
      setSaved(true);
    } catch (err) {
      setError(adminErrorMessage(err, "Failed to save."));
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    const ok = await kitConfirm({
      title: `Remove ${label}?`,
      body: removeBody,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setBusy("removing");
    setError(null);
    setSaved(false);
    try {
      await onClear();
    } catch (err) {
      setError(adminErrorMessage(err, "Failed to remove."));
    } finally {
      setBusy(null);
    }
  };

  // A block that sits inside a kit settings group; hairline between
  // consecutive rows.
  return (
    <div
      className="flex flex-col gap-1.5 py-2.5 border-b border-[var(--k-hair)] last:border-b-0"
      data-testid={id}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <label htmlFor={`${id}-input`} className="text-[14px] text-[var(--k-t1)]">
          {label}
        </label>
        {chip && <KitChip tone={chip.tone}>{chip.text}</KitChip>}
        <span
          className="text-[12.5px] text-[var(--k-t3)]"
          data-testid={`${id}-status`}
        >
          {status}
        </span>
      </div>
      {description && (
        <span className="text-[12.5px] leading-[1.4] text-[var(--k-t3)]">
          {description}
        </span>
      )}
      {!readOnly && (
      <form
        className="flex gap-2 flex-wrap items-center"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <KitInput
          id={`${id}-input`}
          data-testid={`${id}-input`}
          size="sm"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          disabled={busy !== null}
          placeholder={
            isSet ? "Enter a new value to replace it" : "Paste the value"
          }
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
            setSaved(false);
          }}
          className="flex-1 min-w-[200px] w-auto"
        />
        <KitButton
          type="submit"
          size="sm"
          variant="primary"
          data-testid={`${id}-save`}
          disabled={!draft.trim() || busy === "removing"}
          busy={busy === "saving"}
        >
          {busy === "saving" ? "Saving…" : isSet ? "Replace" : "Save"}
        </KitButton>
        {isSet && (
          <KitButton
            size="sm"
            variant="danger-quiet"
            data-testid={`${id}-remove`}
            disabled={busy === "saving"}
            busy={busy === "removing"}
            onClick={() => void clear()}
          >
            {busy === "removing" ? "Removing…" : "Remove"}
          </KitButton>
        )}
      </form>
      )}
      {error && (
        <KitBanner tone="danger" data-testid={`${id}-error`}>
          {error}
        </KitBanner>
      )}
      {saved && !error && (
        <span className="text-[12.5px] text-[var(--k-ok)]" role="status">
          ✓ Saved
        </span>
      )}
    </div>
  );
}
