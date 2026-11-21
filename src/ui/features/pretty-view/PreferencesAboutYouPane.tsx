/**
 * Preferences → About you: what the agents on a machine read first.
 *
 *   - Machine row only when more than one machine can run agents; it's set to
 *     the machine the window was opened for, else the first — never empty.
 *   - One area normally: the machine's file (the user's ~/.claude/CLAUDE.md,
 *     plus any other global files the server lists for that machine, with a
 *     switcher between them).
 *   - Two areas when the machine is shared (more than one person on its people
 *     list) or the signed-in person's own file there has text in it: "Yours"
 *     (their person file, read by the agents shared with them) above
 *     "Everyone on <machine>" (the machine's file). A machine only one person
 *     uses shows nothing about other people.
 *   - Always ready to type — no Edit button. Each area has its own Save (lit
 *     once it has changed) and Cancel (puts back what's saved, asking first).
 *   - Unsaved writing asks "Discard your changes?" before any way out —
 *     switching machine or file, and (through the leave guard it registers
 *     with the window) switching section or closing.
 *   - Saves are mtime-checked: a file changed on disk since typing began asks
 *     to reload, or keeps the draft with an inline note.
 *
 * Lays out its own body and foot (the editor fills the height).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Sparkles } from "lucide-react";
import type { Host, HostFolder } from "@/types/ui-types";
import {
  listAboutYouFiles,
  readGlobalFile,
  writeGlobalFile,
  GlobalFileMtimeConflictError,
  type AboutYouFiles,
} from "@/api/global-files-api";
import { ModalBody, ModalFoot } from "@/components/modal";
import type { TabState } from "./IdentityFileTab";
import { MarkdownEditor } from "./MarkdownEditor";
import type { LeaveGuard } from "./PreferencesModal";
import {
  KitBanner,
  KitButton,
  KitEmpty,
  KitLoading,
  KitSectionHero,
  KitSegmented,
  KitSelect,
  KitSettingsGroup,
  KitSettingsRow,
  kitConfirm,
} from "@/components/kit";

// The path the backend always lists for a machine; its tab reads "About you".
const IMPLICIT_ABOUT_YOU_PATH = "~/.claude/CLAUDE.md";

const PLACEHOLDER =
  "Tell your agents how you work, what you like, and anything they should know before they start.";

function isFolder(item: Host | HostFolder): item is HostFolder {
  return "children" in item;
}
function collectAllHosts(children: (Host | HostFolder)[]): Host[] {
  const out: Host[] = [];
  for (const child of children) {
    if (isFolder(child)) out.push(...collectAllHosts(child.children));
    else out.push(child);
  }
  return out;
}

function fileLabel(file: { path: string; label?: string }, isFirst: boolean): string {
  if (isFirst && file.path === IMPLICIT_ABOUT_YOU_PATH) return "About you";
  return file.label ?? file.path.split("/").pop() ?? file.path;
}

async function confirmDiscard(): Promise<boolean> {
  return kitConfirm({
    title: "Discard your changes?",
    body: "What you've written here hasn't been saved.",
    confirmLabel: "Discard",
    cancelLabel: "Keep editing",
    destructive: true,
  });
}

type Loaded = {
  content: string;
  mtime: number;
  /** Had text when it was loaded — keeps a person's own area from vanishing
   *  the moment they clear it and save. */
  hadText: boolean;
};

/** One file on one machine: loaded, typed into, saved. */
function useAboutYouFile(hostId: number | null, path: string | null) {
  const [state, setState] = useState<TabState<Loaded> | { status: "idle" }>({ status: "idle" });
  const [draft, setDraft] = useState("");
  // What the editor shows before the user touches it — the rich editor
  // re-serialises the file on load, so that (not the raw file) is "unchanged".
  const [baseline, setBaseline] = useState("");
  const interacted = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Bumped whenever another file (or machine) loads, so a save still in
  // flight for the previous one can't land its result on this one.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setSaveError(null);
    setSaving(false);
    if (hostId == null || !path) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    readGlobalFile(hostId, path)
      .then((result) => {
        if (cancelled) return;
        interacted.current = false;
        setDraft(result.content);
        setBaseline(result.content);
        setState({
          status: "ready",
          data: {
            content: result.content,
            mtime: result.mtime,
            hadText: result.content.trim() !== "",
          },
        });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            status: "error",
            error: err instanceof Error ? err.message : "Failed to load",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [hostId, path]);

  const dirty = state.status === "ready" && draft !== baseline;

  const onChange = useCallback((md: string) => {
    if (!interacted.current) setBaseline(md);
    setDraft(md);
  }, []);

  const markInteracted = useCallback(() => {
    interacted.current = true;
  }, []);

  /** Put back what's saved. */
  const revert = useCallback(() => {
    if (state.status !== "ready") return;
    interacted.current = false;
    setDraft(state.data.content);
    setBaseline(state.data.content);
    setSaveError(null);
  }, [state]);

  const save = useCallback(async (): Promise<void> => {
    if (hostId == null || !path || saving || state.status !== "ready") return;
    const loaded = state.data;
    const gen = generation.current;
    const stale = (): boolean => gen !== generation.current;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await writeGlobalFile({
        hostId,
        path,
        content: draft,
        expectedMtime: loaded.mtime,
      });
      if (stale()) return;
      setState({ status: "ready", data: { ...loaded, content: draft, mtime: result.mtime } });
      setBaseline(draft);
      console.info({ operation: "about_you_saved", hostId, path });
    } catch (err) {
      if (stale()) return;
      if (err instanceof GlobalFileMtimeConflictError) {
        const shouldReload = await kitConfirm({
          title: "Reload from disk?",
          body: "The file changed on disk since you started typing. Reloading loses your local edits.",
          confirmLabel: "Reload",
          cancelLabel: "Keep my edits",
          destructive: true,
        });
        if (stale()) return;
        // Either way the newer file is what a save replaces now, so Save
        // again really overwrites it (and Cancel shows the newer one).
        setState({
          status: "ready",
          data: { ...loaded, content: err.currentContent, mtime: err.currentMtime },
        });
        if (shouldReload) {
          interacted.current = false;
          setDraft(err.currentContent);
          setBaseline(err.currentContent);
          return;
        }
        setSaveError(
          "Not saved — the file changed since you started typing. Save again to overwrite it, or Cancel to see the newer version.",
        );
        return;
      }
      setSaveError("Save failed — please try again.");
      console.warn({
        operation: "about_you_save_failed",
        hostId,
        path,
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (!stale()) setSaving(false);
    }
  }, [hostId, path, saving, state, draft]);

  return { state, draft, dirty, saving, saveError, onChange, markInteracted, revert, save };
}

type AboutYouFile = ReturnType<typeof useAboutYouFile>;

function AreaEditor({
  file,
  filename,
  testId,
  minHeight,
}: {
  file: AboutYouFile;
  filename: string;
  testId: string;
  minHeight: string;
}): JSX.Element {
  const { state } = file;
  if (state.status === "idle" || state.status === "loading") return <KitLoading />;
  if (state.status === "error") return <KitBanner tone="danger">{state.error}</KitBanner>;
  return (
    <div
      className={`flex flex-col flex-1 ${minHeight}`}
      data-testid={testId}
      onKeyDownCapture={file.markInteracted}
      onPointerDownCapture={file.markInteracted}
      onPasteCapture={file.markInteracted}
      onDropCapture={file.markInteracted}
      onBeforeInputCapture={file.markInteracted}
    >
      <MarkdownEditor
        filename={filename}
        content={file.draft}
        onChange={file.onChange}
        disabled={file.saving}
        placeholder={PLACEHOLDER}
      />
    </div>
  );
}

function AreaButtons({ file, testId }: { file: AboutYouFile; testId: string }): JSX.Element {
  return (
    <>
      <KitButton
        disabled={!file.dirty || file.saving}
        onClick={() => void confirmDiscard().then((ok) => ok && file.revert())}
        data-testid={`${testId}-cancel`}
      >
        Cancel
      </KitButton>
      <KitButton
        variant="primary"
        onClick={() => void file.save()}
        disabled={!file.dirty || file.saving}
        busy={file.saving}
        data-testid={`${testId}-save`}
      >
        {file.saving ? "Saving…" : "Save"}
      </KitButton>
    </>
  );
}

function SaveError({ file, testId }: { file: AboutYouFile; testId: string }): JSX.Element | null {
  if (file.saveError === null) return null;
  return (
    <p className="m-0 mt-2 k-err" role="alert" data-testid={testId}>
      {file.saveError}
    </p>
  );
}

export interface PreferencesAboutYouPaneProps {
  hostTree: HostFolder | null;
  /** The machine the window was opened for, if any. */
  defaultHostId: number | null;
  /** Tells the window to ask before leaving while there's unsaved writing. */
  registerLeaveGuard?: (guard: LeaveGuard | null) => void;
}

export function PreferencesAboutYouPane({
  hostTree,
  defaultHostId,
  registerLeaveGuard,
}: PreferencesAboutYouPaneProps): JSX.Element {
  const [selectedHostId, setSelectedHostId] = useState<number | null>(null);
  const [listing, setListing] = useState<TabState<AboutYouFiles>>({ status: "loading" });
  const [activeFile, setActiveFile] = useState<string | null>(null);

  // The list normally lands in a moment; if it never does (the load failed
  // with nothing cached), say so rather than spin.
  const [machinesSlow, setMachinesSlow] = useState(false);
  useEffect(() => {
    if (hostTree !== null) return;
    const t = setTimeout(() => setMachinesSlow(true), 15_000);
    return () => clearTimeout(t);
  }, [hostTree]);

  const agentHosts = useMemo(
    () =>
      collectAllHosts(hostTree?.children ?? []).filter((h) => h.canHostAgents === true),
    [hostTree],
  );

  // Always land on a machine: the one asked for, else the first.
  useEffect(() => {
    if (agentHosts.length === 0) {
      setSelectedHostId(null);
      return;
    }
    setSelectedHostId((cur) => {
      if (cur != null && agentHosts.some((h) => Number(h.id) === cur)) return cur;
      if (defaultHostId != null && agentHosts.some((h) => Number(h.id) === defaultHostId)) {
        return defaultHostId;
      }
      return Number(agentHosts[0].id);
    });
  }, [defaultHostId, agentHosts]);

  // Files for the machine. A machine change the user didn't ask for (the
  // list refreshed) reloads both areas, so no draft carries over to another
  // machine's file.
  useEffect(() => {
    if (selectedHostId == null) return;
    let cancelled = false;
    setListing({ status: "loading" });
    setActiveFile(null);
    listAboutYouFiles(selectedHostId)
      .then((result) => {
        if (cancelled) return;
        setListing({ status: "ready", data: result });
        if (result.files.length > 0) setActiveFile(result.files[0].path);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setListing({
            status: "error",
            error: err instanceof Error ? err.message : "Failed to load files",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedHostId]);

  const listed = listing.status === "ready" ? listing.data : null;
  const machine = useAboutYouFile(listed ? selectedHostId : null, activeFile);
  const person = useAboutYouFile(listed ? selectedHostId : null, listed?.personFile ?? null);

  // The person's own area shows on a shared machine, or wherever their own
  // file already says something — nothing their agents read is hidden here.
  const showPerson =
    listed !== null &&
    listed.personFile !== null &&
    (listed.multiUser ||
      (person.state.status === "ready" && person.state.data.hadText));
  // Until the person's own file has loaded, which layout is right isn't known
  // yet — wait rather than swap the editor out from under someone typing.
  const personSettling =
    listed?.personFile != null &&
    (person.state.status === "idle" || person.state.status === "loading");

  const saving = machine.saving || person.saving;
  const anyDirtyRef = useRef(false);
  anyDirtyRef.current = machine.dirty || person.dirty;
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const revertAllRef = useRef<() => void>(() => {});
  revertAllRef.current = () => {
    machine.revert();
    person.revert();
  };

  /** May the user leave what's on screen? Asks first when there's unsaved writing. */
  const mayLeave = useCallback(async (dirty: boolean, revert: () => void): Promise<boolean> => {
    if (!dirty) return true;
    if (!(await confirmDiscard())) return false;
    revert();
    return true;
  }, []);

  // The window asks this before switching section or closing.
  useEffect(() => {
    if (!registerLeaveGuard) return;
    registerLeaveGuard(async () =>
      savingRef.current ? false : mayLeave(anyDirtyRef.current, () => revertAllRef.current()),
    );
    return () => registerLeaveGuard(null);
  }, [registerLeaveGuard, mayLeave]);

  const switchHost = useCallback(
    async (next: number) => {
      if (next === selectedHostId) return;
      if (!(await mayLeave(anyDirtyRef.current, () => revertAllRef.current()))) return;
      setSelectedHostId(next);
    },
    [selectedHostId, mayLeave],
  );

  const switchFile = useCallback(
    async (next: string) => {
      if (next === activeFile) return;
      if (!(await mayLeave(machine.dirty, machine.revert))) return;
      setActiveFile(next);
    },
    [activeFile, mayLeave, machine.dirty, machine.revert],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  const fileList = listed?.files ?? [];
  const machineName =
    agentHosts.find((h) => Number(h.id) === selectedHostId)?.name ?? "this machine";

  const hero = (
    <KitSectionHero
      icon={<Sparkles />}
      title="About you"
      description="Every agent you start on this machine reads this first — how you work, what you like, anything."
      className="mb-5"
      data-testid="preferences-section-hero"
    />
  );

  const machineRow =
    agentHosts.length > 1 ? (
      <KitSettingsGroup className="mb-5" data-testid="preferences-about-you-host-picker">
        <KitSettingsRow
          label="Machine"
          description="Each machine keeps its own copy."
          control={
            <KitSelect
              aria-label="Machine"
              value={selectedHostId ?? ""}
              disabled={saving}
              onChange={(e) => void switchHost(Number(e.target.value))}
              className="w-[190px] max-sm:w-[150px]"
            >
              {agentHosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </KitSelect>
          }
        />
      </KitSettingsGroup>
    ) : null;

  const fileSwitcher =
    fileList.length > 1 ? (
      <KitSegmented
        className="mb-4 self-start max-w-full overflow-x-auto"
        aria-label="Files"
        value={activeFile ?? ""}
        onValueChange={(next) => void switchFile(next)}
        options={fileList.map((file, index) => ({
          value: file.path,
          label: <span className="truncate">{fileLabel(file, index === 0)}</span>,
          Icon: FileText,
          disabled: saving,
          testId: `preferences-about-you-tab-${file.path}`,
        }))}
      />
    ) : null;

  const areaHeading = (title: string, hint: string, testId: string): JSX.Element => (
    <div className="mb-2" data-testid={testId}>
      <h3 className="m-0 text-[15px] font-semibold text-[var(--k-t1)]">{title}</h3>
      <p className="m-0 mt-0.5 k-help">{hint}</p>
    </div>
  );

  let main: React.ReactNode;
  if (hostTree === null && !machinesSlow) {
    // The machine list hasn't arrived yet (first load, nothing cached).
    main = <KitLoading label="Loading machines…" className="py-10" />;
  } else if (hostTree === null) {
    main = (
      <KitEmpty
        className="py-10"
        title="Couldn't load your machines"
        body="Reload the page to try again."
      />
    );
  } else if (agentHosts.length === 0) {
    main = (
      <KitEmpty
        className="py-10"
        title="No machines can run agents yet"
        body="Once one can, what you write here is what its agents read first."
      />
    );
  } else if (listing.status === "loading" || selectedHostId == null || personSettling) {
    main = <KitLoading />;
  } else if (listing.status === "error") {
    main = <KitBanner tone="danger">{listing.error}</KitBanner>;
  } else if (fileList.length === 0 && !showPerson) {
    main = (
      <KitEmpty
        className="py-10"
        title="No global files configured for this host."
        body={
          <>
            Edit <code>/app/data/global-files.json</code> on the server to add entries.
          </>
        }
      />
    );
  } else if (!showPerson) {
    main = (
      <>
        {fileSwitcher}
        <AreaEditor
          file={machine}
          filename={activeFile ?? "about-you.md"}
          testId="preferences-about-you-editor"
          minHeight="min-h-[320px]"
        />
        <SaveError file={machine} testId="preferences-about-you-save-error" />
      </>
    );
  } else {
    main = (
      <>
        <section className="flex flex-col flex-1 mb-6" data-testid="preferences-about-you-person">
          {areaHeading(
            "Yours",
            "Read by the agents shared with you on this machine.",
            "preferences-about-you-person-heading",
          )}
          <AreaEditor
            file={person}
            filename="about-you.md"
            testId="preferences-about-you-person-editor"
            minHeight="min-h-[240px]"
          />
          <SaveError file={person} testId="preferences-about-you-person-save-error" />
          <div className="mt-3 flex justify-end gap-2">
            <AreaButtons file={person} testId="preferences-about-you-person" />
          </div>
        </section>
        <section className="flex flex-col flex-1" data-testid="preferences-about-you-machine">
          {areaHeading(
            `Everyone on ${machineName}`,
            "Read by every agent on this machine, whoever they work for.",
            "preferences-about-you-machine-heading",
          )}
          {fileSwitcher}
          {fileList.length === 0 ? (
            <KitEmpty className="py-6" title="No global files configured for this host." />
          ) : (
            <>
              <AreaEditor
                file={machine}
                filename={activeFile ?? "about-you.md"}
                testId="preferences-about-you-editor"
                minHeight="min-h-[240px]"
              />
              <SaveError file={machine} testId="preferences-about-you-save-error" />
              <div className="mt-3 flex justify-end gap-2">
                <AreaButtons file={machine} testId="preferences-about-you" />
              </div>
            </>
          )}
        </section>
      </>
    );
  }

  const showFoot = !showPerson && machine.state.status === "ready";

  return (
    <>
      <ModalBody
        data-testid="preferences-modal-pane"
        className="pt-1 pb-6 flex flex-col"
      >
        <div className="w-full max-w-[720px] mx-auto flex flex-col flex-1 min-h-0">
          {hero}
          {machineRow}
          {main}
        </div>
      </ModalBody>
      {showFoot && (
        <ModalFoot>
          <AreaButtons file={machine} testId="preferences-about-you" />
        </ModalFoot>
      )}
    </>
  );
}
