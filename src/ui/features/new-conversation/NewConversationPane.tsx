// ─── NewConversationPane — a conversation that hasn't started yet ──────────
//
// Replaces the old new-conversation dialog. It is a conversation pane in
// every way it can be before there's an agent: the conversation's own pill on
// top, its own compose box at the bottom, and — where the messages would be —
// the choices the dialog used to offer:
//   - admins: Agent / Shell
//   - agents: roles from every machine that can host agents, grouped by
//     machine with "No roles" first in each (the roles decide the machine),
//     New role… at the end
//   - a shell: the machine, an optional session name, and the folder
// The pill shows who it will be: the first picked role's picture and a
// suggested name (picked to be free on that machine); clicking the name
// renames it in place.
//
// Send (or Enter, a skill, a dictation) starts it. The words typed, if any,
// go along as the agent's first message (the server drops them into the
// newborn's inbox). On success the content area puts the new conversation
// where this pane was; on failure the pane stays, with its picks and words,
// and says so.
//
// Picks are reported up as they change (they live on the pane's tab, so a
// reload or a move to another window brings them back). A starting point
// set from outside — a project or role entry, a return from the roles window —
// arrives as new picks with a new seed: AppShell remounts the form then.
//
// The pick rules (one machine per agent, No roles exclusive, the one-machine
// default, the stale-role guard, the suggested name never overwriting a typed
// one, the collision check never reporting on birth's own folder) are the
// dialog's, carried over unchanged.

import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { useTranslation } from "react-i18next";
import { Bot, CircleDashed, Terminal } from "lucide-react";

import {
  kitAlert,
  KitField,
  KitHostPicker,
  KitInput,
  KitSearch,
  KitSegmented,
} from "@/components/kit";
import { RolePickList, type RolePickGroup } from "@/sidebar/RolePickList";
import { cachedHostRoles, rememberHostRoles } from "@/sidebar/host-roles-cache";
import type { Host, HostFolder, NewConversationPicks } from "@/types/ui-types";
import {
  listIdentities,
  getIdentityExistsOnHost,
  openBirthStream,
  listRolesForHost,
  pickPoolName,
  roleAvatarUrl,
  type BirthEvent,
  type RoleSummary,
} from "@/api/identities-api";
import { refreshOneIdentity } from "@/state/identities-store";
import { roleDisplayName } from "@/lib/role-display-name";
import { previewSlugFromPrettyName } from "@/lib/pretty-name-slug-preview";
import { submitOnEnter } from "@/lib/submit-on-enter";
import { useBrandingConfig } from "@/branding/branding-store";
import { useIsMobile } from "@/hooks/use-mobile";
import { useIsTouchDevice } from "@/hooks/use-is-touch-device";
import { ComposeBox } from "@/features/pretty-view/ComposeBox";
import { PillFrame } from "@/features/pretty-view/PillFrame";
import { RolesWindow } from "@/features/pretty-view/roles-window/RolesWindow";
import type { RowKebabMenuItem } from "@/features/pretty-conversations/RowKebabMenu";
import { isCoarsePointer } from "@/features/pretty-conversations/row-touch-gestures";
import { writeBadgeDragData } from "@/shell/badge-drag";
import { encodeWorkspaceSpec, specForTab } from "@/lib/tab-url";
import { picksToWire, samePicks } from "@/lib/new-conversation-picks";
import { useNewConversationHost, type NewConversationStarted } from "./new-conversation-context";

// Client-side session-name pattern — defense-in-depth. Word characters and
// dashes, 0-64 chars. Empty is allowed (the server names the session).
export const SESSION_NAME_PATTERN = /^[\w-]{0,64}$/;

/**
 * Stand-in written to a new identity's `task:` frontmatter at birth. The agent
 * replaces it with the real task on first wake (id skill § the task field).
 * USER-VISIBLE: a row shows it until then. Kept deliberately plain.
 */
export const TASK_PLACEHOLDER = "Untitled conversation";

// Path normalization: backslashes to forward slashes; empty/whitespace → "~".
export function normalizePath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return "~";
  return trimmed.replace(/\\/g, "/");
}

const NO_ROLES: RoleSummary[] = [];

// Option value of the "No roles" entry. Role names are kebab-case
// ([a-z0-9-]), so a leading colon can never collide with a real role.
const NO_ROLES_OPTION = ":no-roles";

type HostRolesState = {
  roles: RoleSummary[];
  /** The request to the machine hasn't answered yet. */
  loading: boolean;
  error: string | null;
  /** `roles` can be shown: the machine answered, or it answered before and
   *  `roles` is that answer from the cache. */
  known: boolean;
};

// The roles list stays behind "Loading roles…" until every machine's roles
// are known, so groups don't appear and push each other around one by one.
// A slow or offline machine holds it back no longer than this.
const ROLES_SETTLE_MS = 2500;

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

const BIRTH_FAILED = "Couldn't create the agent — something went wrong while setting it up. Try again in a moment.";

export interface NewConversationPaneProps {
  tabId: string;
  picks: NewConversationPicks;
  isVisible: boolean;
  /** Clicking the pane selects it (split focus). */
  onSelectPane?: (tabId: string) => void;
}

export function NewConversationPane({ tabId, picks, isVisible, onSelectPane }: NewConversationPaneProps) {
  const host = useNewConversationHost();
  const { t } = useTranslation();
  const brandingConfig = useBrandingConfig();
  const isMobile = useIsMobile();
  const isTouchDevice = useIsTouchDevice();
  const isAdmin = host?.isAdmin ?? false;
  const adminKnown = host?.adminKnown ?? true;
  const project = picks.project?.slug ?? null;

  // Started from a project: only that project's machine is offered — an agent
  // in a project must live where the project does.
  const hostTree = useMemo<HostFolder | null>(() => {
    const full = host?.hostTree ?? null;
    if (!picks.project || !full) return full;
    const projectHost = collectAllHosts(full.children).find(
      (h) => parseInt(String(h.id), 10) === picks.project!.hostId,
    );
    return projectHost ? { name: full.name, children: [projectHost] } : full;
  }, [host?.hostTree, picks.project]);

  const [selectedHost, setSelectedHost] = useState<Host | null>(null);
  const [sessionName, setSessionName] = useState("");
  const [search, setSearch] = useState("");
  // The shell's folder; agents always get their workspace (the server's).
  const [path, setPath] = useState(picks.path ?? "");
  const [shellOnly, setShellOnly] = useState(isAdmin && picks.shell === true);

  const [name, setName] = useState(picks.name ?? "");
  const [poolPickedName, setPoolPickedName] = useState<string | null>(null);
  // Current-value mirrors read when an async answer RESOLVES (see the name
  // suggestion effect): a closure would see the render that started it.
  const nameRef = useRef(name);
  nameRef.current = name;
  const poolPickedNameRef = useRef(poolPickedName);
  poolPickedNameRef.current = poolPickedName;
  const selectedRoleRef = useRef("");

  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Collision precheck state
  const [skynetCollision, setSkynetCollision] = useState(false);
  const [hostCollision, setHostCollision] = useState(false);
  const [collisionChecking, setCollisionChecking] = useState(false);
  const collisionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (collisionTimerRef.current) clearTimeout(collisionTimerRef.current);
    },
    [],
  );
  // Latched the moment a birth starts; the collision precheck never runs or
  // reports after that (it would find the folder the birth itself made).
  const birthStartedRef = useRef(false);

  // Roles, in pick order — the first is the identity's first role. Empty when
  // "No roles" is picked; the two are mutually exclusive.
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [noRoles, setNoRoles] = useState(false);
  selectedRoleRef.current = selectedRoles[0] ?? "";
  const [hostRoles, setHostRoles] = useState<Record<string, HostRolesState>>({});
  const [rolesShown, setRolesShown] = useState(false);

  const [birthing, setBirthing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortControllerRef.current?.abort(), []);
  // While it's being created the pane is kept even if the user clicks away.
  useEffect(() => {
    host?.setStarting(tabId, birthing);
    // Gone mid-creation (e.g. moved to another window): nothing to keep.
    return () => {
      if (birthing) host?.setStarting(tabId, false);
    };
  }, [host, tabId, birthing]);
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;

  // "New role…": the roles window opens on top; the pane stays underneath.
  const [hop, setHop] = useState<{ open: boolean; host: Host | null }>({ open: false, host: null });

  const flatHosts = useMemo(
    // RDP-enabled hosts are their own sidebar rows; not offered here.
    () => collectAllHosts(hostTree?.children ?? []).filter((h) => h.enableRdp !== true),
    [hostTree],
  );
  // Agents only go on machines that run the fleet.
  const agentHosts = useMemo(() => flatHosts.filter((h) => h.canHostAgents === true), [flatHosts]);

  const filteredHosts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return flatHosts;
    return flatHosts.filter((h) => `${h.name} ${h.username ?? ""} ${h.ip ?? ""}`.toLowerCase().includes(q));
  }, [flatHosts, search]);

  const sortedHosts = useMemo(
    () => [...agentHosts].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [agentHosts],
  );
  const multiHost = agentHosts.length > 1;
  // Roles per host as shown: this pane's answers, else an earlier answer from
  // the cache — so a fresh pane shows its roles on its first paint.
  const shownHostRoles: Record<string, HostRolesState> = { ...hostRoles };
  if (!shellOnly) {
    for (const h of agentHosts) {
      if (shownHostRoles[h.id]) continue;
      const cached = cachedHostRoles(String(h.id));
      if (cached) shownHostRoles[h.id] = { ...cached, loading: true, known: true };
    }
  }
  const anyRolesLoading = agentHosts.some(
    (h) => shownHostRoles[h.id] === undefined || shownHostRoles[h.id].loading,
  );
  const selectedHostRoles = selectedHost ? shownHostRoles[selectedHost.id] : undefined;
  const rolesForHost = selectedHostRoles?.roles ?? NO_ROLES;
  const rolesLoading = selectedHost
    ? selectedHostRoles === undefined || selectedHostRoles.loading
    : anyRolesLoading;

  // Seeding from the picks — once, as soon as the picked machine is known
  // (the machine list can arrive after the pane does). Without a picked
  // machine, a sole machine is picked.
  const seededRef = useRef(false);
  // The same, as state: it lands in the same update as the seeded picks, so
  // the picks report below never sees a half-seeded pane.
  const [seeded, setSeeded] = useState(false);
  // The user (or the seed) has made a roles pick, so the one-machine "No
  // roles" default must not override it.
  const rolesTouchedRef = useRef(false);
  // The current "No roles" pick is the untouched one-machine default — it is
  // withdrawn if a second machine appears.
  const noRolesIsDefaultRef = useRef(false);
  useEffect(() => {
    // A shell pane (only admins have those) can't seed until we know the user
    // is an admin — seeding it as an agent first would drop its picks.
    if (!seededRef.current && picks.shell && !adminKnown) return;
    if (!seededRef.current && picks.shell && isAdmin && !shellOnly) {
      setShellOnly(true);
      return; // seeds on the next run, in shell mode
    }
    const pool = shellOnly ? flatHosts : agentHosts;
    if (!seededRef.current) {
      const wanted = picks.hostId;
      if (wanted !== undefined) {
        const seedHost = pool.find((h) => parseInt(String(h.id), 10) === wanted) ?? null;
        // Not known yet — wait for the machine list (a host that never turns
        // up simply leaves the pane unpicked).
        if (seedHost === null && pool.length === 0) return;
        seededRef.current = true;
        setSeeded(true);
        if (seedHost) {
          setSelectedHost(seedHost);
          if (!shellOnly) {
            if (picks.roles && picks.roles.length > 0) {
              setSelectedRoles(picks.roles);
              rolesTouchedRef.current = true;
            } else if (picks.noRoles) {
              setNoRoles(true);
              rolesTouchedRef.current = true;
            }
          }
          console.info(
            `[new-conversation] seeded tabId=${tabId} hostId=${wanted} roles=${picks.roles?.join(",") || "-"} noRoles=${picks.noRoles === true} shell=${shellOnly}`,
          );
          return;
        }
      } else {
        seededRef.current = true;
        setSeeded(true);
      }
    }
    setSelectedHost((prev) => prev ?? (pool.length === 1 ? pool[0] : null));
    // Seeding reads the picks it was born with; later changes come back as a
    // new seed (a remount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatHosts, agentHosts, adminKnown, isAdmin, shellOnly]);

  // Agent ↔ shell (admins): the two offer different machines. Entering shell
  // mode with a single machine picks it; entering agent mode drops a picked
  // machine that can't host agents (or swaps in the sole one that can).
  const firstModeRunRef = useRef(true);
  useEffect(() => {
    if (firstModeRunRef.current) {
      firstModeRunRef.current = false;
      return;
    }
    if (shellOnly) {
      if (flatHosts.length === 1) setSelectedHost(flatHosts[0]);
      return;
    }
    setSelectedHost((prev) =>
      prev && !agentHosts.some((h) => h.id === prev.id) ? (agentHosts.length === 1 ? agentHosts[0] : null) : prev,
    );
  }, [shellOnly, flatHosts, agentHosts]);

  // Roles — every machine that can host agents is asked once; answers land
  // per machine. A shell drops the picked roles.
  const rolesRequestedRef = useRef<Set<string>>(new Set());
  const requestRoles = (hosts: Host[]): void => {
    for (const h of hosts) {
      const hostIdNum = parseInt(String(h.id), 10);
      listRolesForHost(hostIdNum)
        .then((roles) => ({ roles, error: null }))
        .catch((err: unknown) => {
          const error = err instanceof Error ? err.message : "role fetch failed";
          console.warn(`[new-conversation] roles fetch failed hostId=${h.id} host=${h.name}: ${error}`);
          return { roles: [] as RoleSummary[], error };
        })
        .then((result) => {
          rememberHostRoles(String(h.id), result);
          setHostRoles((prev) => ({ ...prev, [h.id]: { ...result, loading: false, known: true } }));
        });
    }
  };
  useEffect(() => {
    if (shellOnly) {
      setSelectedRoles((prev) => (prev.length > 0 ? [] : prev));
      setNoRoles(false);
      rolesTouchedRef.current = false;
      noRolesIsDefaultRef.current = false;
      return;
    }
    const pending = agentHosts.filter((h) => !rolesRequestedRef.current.has(h.id));
    if (pending.length === 0) return;
    for (const h of pending) rolesRequestedRef.current.add(h.id);
    setHostRoles((prev) => {
      const next = { ...prev };
      for (const h of pending) {
        const cached = cachedHostRoles(String(h.id));
        next[h.id] = cached
          ? { ...cached, loading: true, known: true }
          : { roles: [], error: null, loading: true, known: false };
      }
      return next;
    });
    requestRoles(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellOnly, agentHosts]);

  const allRolesKnown = agentHosts.every((h) => shownHostRoles[h.id]?.known === true);
  const rolesReady = rolesShown || allRolesKnown;
  useEffect(() => {
    if (shellOnly || rolesShown) return;
    if (allRolesKnown) {
      setRolesShown(true);
      return;
    }
    const timer = setTimeout(() => {
      console.log(`[new-conversation] roles shown hosts=${agentHosts.length} reason=settle-timeout`);
      setRolesShown(true);
    }, ROLES_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [shellOnly, rolesShown, allRolesKnown, agentHosts.length]);

  // One-machine "No roles" default: with exactly one machine and nothing
  // picked, "No roles" is preselected so Send works straight away. A second
  // machine appearing while it's still the untouched default withdraws it.
  useEffect(() => {
    if (shellOnly) return;
    if (agentHosts.length === 1) {
      if (!rolesTouchedRef.current && !noRoles && selectedRoles.length === 0) {
        noRolesIsDefaultRef.current = true;
        setNoRoles(true);
      }
    } else if (noRolesIsDefaultRef.current) {
      noRolesIsDefaultRef.current = false;
      setNoRoles(false);
      setSelectedHost(null);
    }
  }, [shellOnly, agentHosts, noRoles, selectedRoles]);

  // Stale-role guard: a seeded role the machine turns out not to have is
  // dropped once its roles land, so nothing is started with a phantom role.
  useEffect(() => {
    if (selectedRoles.length === 0 || rolesLoading) return;
    if (rolesForHost.length === 0) return;
    const valid = selectedRoles.filter((sel) => rolesForHost.some((r) => r.name === sel));
    if (valid.length !== selectedRoles.length) {
      setSelectedRoles(valid);
      if (valid.length === 0 && !multiHost) {
        noRolesIsDefaultRef.current = true;
        setNoRoles(true);
      }
    }
  }, [rolesForHost, rolesLoading, selectedRoles, multiHost]);

  // Roles list wiring. With several machines an option's value is
  // `<hostId>/<role>` (a role can be on more than one); with one, the bare
  // role name. Each machine's entries start with "No roles".
  const roleOptionValue = (h: Host, role: string) => (multiHost ? `${h.id}/${role}` : role);
  const noRolesLabel = t("nav.newSessionNoRoles", { defaultValue: "No roles" });
  const onEveryHost = t("nav.newSessionOnEveryHost", { defaultValue: "· shared" });
  const roleGroups: RolePickGroup[] = !rolesReady
    ? []
    : sortedHosts.flatMap((h) => {
        if (shownHostRoles[h.id]?.error && multiHost) return [];
        const hostIdNum = parseInt(String(h.id), 10);
        return [
          {
            key: String(h.id),
            title: h.name,
            items: [
              { value: roleOptionValue(h, NO_ROLES_OPTION), label: noRolesLabel, noRoles: true },
              ...(shownHostRoles[h.id]?.roles ?? []).map((role) => ({
                value: roleOptionValue(h, role.name),
                label: roleDisplayName(role.name, role.displayName) + (role.instanceWide ? ` ${onEveryHost}` : ""),
                description: role.description,
                avatarSrc: role.avatar && Number.isFinite(hostIdNum) ? roleAvatarUrl(hostIdNum, role.name) : null,
                hue: role.colorHue ?? undefined,
              })),
            ],
          },
        ];
      });
  const pickedRoleValues = selectedHost
    ? (noRoles ? [NO_ROLES_OPTION] : selectedRoles).map((r) => roleOptionValue(selectedHost, r))
    : [];
  function handleRolesChange(next: string[]) {
    rolesTouchedRef.current = true;
    noRolesIsDefaultRef.current = false;
    setFailure(null);
    const parse = (v: string) => {
      if (!multiHost) return { hostId: selectedHost?.id ?? "", role: v };
      const slash = v.indexOf("/");
      return { hostId: v.slice(0, slash), role: v.slice(slash + 1) };
    };
    const added = next.find((v) => !pickedRoleValues.includes(v));
    if (added) {
      const { hostId, role } = parse(added);
      if (multiHost && selectedHost?.id !== hostId) {
        // An entry from another machine: the agent will live there instead,
        // and roles picked on the previous machine can't come along.
        const h = agentHosts.find((x) => x.id === hostId);
        if (!h) return;
        console.log(
          `[new-conversation] role host switch tabId=${tabId} from=${selectedHost?.id ?? "-"} to=${hostId} role=${role} dropped=${selectedRoles.join(",") || "-"}`,
        );
        setSelectedHost(h);
        setNoRoles(role === NO_ROLES_OPTION);
        setSelectedRoles(role === NO_ROLES_OPTION ? [] : [role]);
        return;
      }
      if (role === NO_ROLES_OPTION) {
        setNoRoles(true);
        setSelectedRoles([]);
        return;
      }
    }
    const roles = next.map((v) => parse(v).role).filter((r) => r !== NO_ROLES_OPTION);
    if (roles.length === 0 && selectedRoles.length > 0 && !noRoles) {
      // Unticked the last role: fall back to "No roles" on its machine.
      setNoRoles(true);
      setSelectedRoles([]);
      return;
    }
    setNoRoles(false);
    setSelectedRoles(roles);
    if (roles.length === 0 && multiHost) setSelectedHost(null);
  }

  // The agent's machine changed: a suggestion still sitting untouched was
  // picked to be free on the PREVIOUS machine, so it goes; the new machine's
  // suggestion (below) fills in. A typed name never matches and stays.
  const suggestionHostIdRef = useRef<string | null>(null);
  useEffect(() => {
    const hostId = selectedHost ? String(selectedHost.id) : null;
    const prev = suggestionHostIdRef.current;
    suggestionHostIdRef.current = hostId;
    if (prev === null || prev === hostId) return;
    const suggestion = poolPickedNameRef.current;
    if (suggestion !== null && nameRef.current === suggestion) {
      nameRef.current = "";
      poolPickedNameRef.current = null;
      setName("");
      setPoolPickedName(null);
    }
  }, [selectedHost]);

  // Suggested name: asked for as soon as the machine is known. Applied only
  // when the name is empty or still our own untouched suggestion — read
  // through refs, so a name typed while the answer was on its way wins.
  useEffect(() => {
    if (shellOnly || !selectedHost) return;
    const hostIdNum = parseInt(String(selectedHost.id), 10);
    if (!Number.isFinite(hostIdNum)) return;
    let cancelled = false;
    (async () => {
      try {
        const { name: poolName } = await pickPoolName(hostIdNum, selectedRoleRef.current || undefined);
        if (cancelled) return;
        const current = nameRef.current;
        if (current === "" || current === poolPickedNameRef.current) {
          setName(poolName);
          setPoolPickedName(poolName);
        }
      } catch {
        // No suggestion — the user names it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHost, shellOnly]);

  function runCollisionPrecheck(currentName: string) {
    if (collisionTimerRef.current) clearTimeout(collisionTimerRef.current);
    if (birthStartedRef.current) return;
    const previewSlug = previewSlugFromPrettyName(currentName ?? "");
    if (!previewSlug || !selectedHost) {
      setSkynetCollision(false);
      setHostCollision(false);
      return;
    }
    collisionTimerRef.current = setTimeout(async () => {
      if (birthStartedRef.current) return;
      setCollisionChecking(true);
      try {
        const [identities, existsOnHost] = await Promise.all([
          listIdentities(),
          getIdentityExistsOnHost(selectedHost.id as unknown as number, previewSlug),
        ]);
        if (birthStartedRef.current) return;
        setSkynetCollision(identities.some((id) => id.identityKey === previewSlug));
        setHostCollision(existsOnHost);
      } catch {
        setSkynetCollision(false);
        setHostCollision(false);
      } finally {
        setCollisionChecking(false);
      }
    }, 300);
  }

  // A typed name is checked against the machine it will be born on — again
  // whenever that machine changes (it follows the roles).
  useEffect(() => {
    if (shellOnly || name.trim() === "" || name.trim() === poolPickedNameRef.current) return;
    runCollisionPrecheck(name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHost?.id]);

  // A pick seeded from outside (a role's Start a conversation, a reload) can
  // sit below the fold — bring it into view once, when the list shows.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrolledToSeedRef = useRef(false);
  useEffect(() => {
    if (scrolledToSeedRef.current || !rolesReady || !selectedHost || !picks.roles?.length) return;
    scrolledToSeedRef.current = true;
    const value = multiHost ? `${selectedHost.id}/${picks.roles[0]}` : picks.roles[0];
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value;
    const row = scrollRef.current?.querySelector(`[data-testid="role-pick-${escaped}"]`);
    if (row instanceof HTMLElement) row.scrollIntoView?.({ block: "center" });
  }, [rolesReady, selectedHost, picks.roles, multiHost]);

  // ── Picks reported up (kept on the tab, so in the URL) ────────────────
  const typedName = name.trim() !== "" && name !== poolPickedName ? name : null;
  const currentPicks = useMemo<NewConversationPicks>(() => {
    const p: NewConversationPicks = {};
    if (shellOnly) p.shell = true;
    if (selectedHost) p.hostId = parseInt(String(selectedHost.id), 10);
    if (!shellOnly && selectedRoles.length > 0) p.roles = selectedRoles;
    if (!shellOnly && noRoles) p.noRoles = true;
    if (!shellOnly && typedName) p.name = typedName;
    if (picks.project) p.project = picks.project;
    if (shellOnly && path.trim() !== "") p.path = path;
    return p;
  }, [shellOnly, selectedHost, selectedRoles, noRoles, typedName, picks.project, path]);
  const reportedRef = useRef<NewConversationPicks>(picks);
  useEffect(() => {
    // Before the seed has landed the picks are the seed's own; don't report
    // a half-seeded state back.
    if (!seeded) return;
    if (samePicks(currentPicks, reportedRef.current)) return;
    reportedRef.current = currentPicks;
    host?.updatePicks(tabId, currentPicks);
  }, [seeded, currentPicks, host, tabId]);

  // ── Starting it ──────────────────────────────────────────────────────
  async function handleBirth(firstMessage: string) {
    if (!selectedHost) return;
    birthStartedRef.current = true;
    if (collisionTimerRef.current) {
      clearTimeout(collisionTimerRef.current);
      collisionTimerRef.current = null;
    }
    setFailure(null);
    setBirthing(true);
    abortControllerRef.current = new AbortController();
    const hostIdNum = parseInt(String(selectedHost.id), 10);
    const isPoolPicked = poolPickedName !== null && name.trim() === poolPickedName;
    console.info(
      `[new-conversation] start tabId=${tabId} hostId=${hostIdNum} roles=${selectedRoles.join(",") || "-"} project=${project ?? "-"} poolPicked=${isPoolPicked} firstMessageLen=${firstMessage.length}`,
    );
    try {
      const stream = openBirthStream(
        {
          hostId: hostIdNum,
          ...(isPoolPicked ? { name: name.toLowerCase() } : { displayName: name.trim() }),
          // Agents always get their workspace; the server fills it in.
          path: "",
          colorHue: null,
          voice: null,
          ...(selectedRoles.length > 0 ? { role: selectedRoles[0] } : {}),
          ...(selectedRoles.length > 1 ? { roles: selectedRoles.slice(1) } : {}),
          task: TASK_PLACEHOLDER,
          poolPicked: isPoolPicked ? true : undefined,
          ...(project ? { project } : {}),
          ...(firstMessage !== "" ? { firstMessage } : {}),
        },
        abortControllerRef.current.signal,
      );
      let endedEvent: BirthEvent | null = null;
      for await (const evt of stream) {
        if (evt.type === "ended") {
          endedEvent = evt;
          break;
        }
      }
      if (endedEvent && endedEvent.type === "ended" && endedEvent.ok) {
        // The folder (= session) name is the server's, not the typed one.
        const bornName = endedEvent.sessionName ?? endedEvent.identityId ?? name.toLowerCase();
        // The newborn must be in the store before its conversation opens,
        // or it opens as a plain terminal.
        await refreshOneIdentity(bornName, hostIdNum);
        console.info(`[new-conversation] started tabId=${tabId} name=${bornName} hostId=${hostIdNum}`);
        // Its project was gone by the time it was filed: it's in Conversations instead.
        const notFiled = endedEvent.notFiled;
        const what: NewConversationStarted = {
          kind: "agent",
          host: selectedHost,
          name: bornName,
          project: notFiled === undefined ? project : null,
        };
        host?.started(tabId, what);
        if (notFiled !== undefined) {
          console.info(`[new-conversation] not filed tabId=${tabId} name=${bornName} project=${project} reason=${notFiled}`);
          void kitAlert({
            title: "It's in Conversations",
            body: `The agent was made, but ${notFiled}, so it isn't in that project.`,
          });
        }
        return;
      }
      console.warn(`[new-conversation] start failed tabId=${tabId} hostId=${hostIdNum} reason=ended-not-ok`);
    } catch (err) {
      console.warn(
        `[new-conversation] start failed tabId=${tabId} hostId=${hostIdNum} reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Failed: the pane stays with everything as it was; try again. If the
    // user has clicked away meanwhile, say so where they are — the pane goes
    // once nothing keeps it.
    birthStartedRef.current = false;
    setBirthing(false);
    setFailure(BIRTH_FAILED);
    // The name may have been taken a moment ago (two made at once): check it again, so the
    // field says so before the next try.
    if (name.trim() !== "") runCollisionPrecheck(name);
    if (!isVisibleRef.current) {
      void kitAlert({ title: "Couldn't create the agent", body: "Something went wrong while setting it up. Try again in a moment." });
    }
  }

  const nameSlugPreview = previewSlugFromPrettyName(name);
  const nameValid = !shellOnly
    ? name.trim().length > 0 && name.trim().length <= 80 && nameSlugPreview.length > 0
    : SESSION_NAME_PATTERN.test(sessionName);
  // A non-admin never gets a shell, whatever the state says.
  const effectiveShellOnly = isAdmin && shellOnly;

  const canStart =
    !birthing &&
    (!shellOnly
      ? selectedHost !== null &&
        nameValid &&
        !skynetCollision &&
        !hostCollision &&
        !collisionChecking &&
        (noRoles || selectedRoles.length > 0)
      : selectedHost !== null && nameValid);

  function handleStart(firstMessage: string) {
    if (!canStart || !selectedHost) return;
    if (!effectiveShellOnly) {
      void handleBirth(firstMessage);
      return;
    }
    console.info(`[new-conversation] start shell tabId=${tabId} hostId=${selectedHost.id}`);
    host?.started(tabId, {
      kind: "shell",
      host: selectedHost,
      sessionName: sessionName.length > 0 ? sessionName : undefined,
      path: normalizePath(path),
    });
  }

  // ── The pill ────────────────────────────────────────────────────────
  const firstRole = !shellOnly && selectedHost ? rolesForHost.find((r) => r.name === selectedRoles[0]) : undefined;
  const ringHue = firstRole?.colorHue ?? 220;
  const shownName = name.trim() !== "" ? name.trim().charAt(0).toUpperCase() + name.trim().slice(1) : "";
  // The pill is where a conversation's task shows, so it names the kind of
  // thing being started, not the agent; the name has its own field.
  const pillLabel = shellOnly
    ? t("nav.newShellTitle", { defaultValue: "New shell" })
    : t("nav.newSessionTitle", { defaultValue: "New conversation" });
  const picture =
    firstRole && selectedHost ? (
      <img
        alt=""
        draggable={false}
        src={roleAvatarUrl(parseInt(String(selectedHost.id), 10), firstRole.name)}
        className="shrink-0 object-cover"
        style={{
          width: 26,
          height: 26,
          borderRadius: "50%",
          boxShadow: `0 0 0 1.5px hsla(${ringHue}, 60%, 60%, 0.55)`,
        }}
      />
    ) : (
      <span
        data-testid="new-conversation-pill-empty"
        className="shrink-0 inline-flex items-center justify-center text-[var(--k-t3)]"
        style={{ width: 26, height: 26 }}
      >
        <CircleDashed width={22} height={22} aria-hidden="true" />
      </span>
    );
  const menuItems = useMemo<RowKebabMenuItem[]>(() => {
    const items: RowKebabMenuItem[] = [];
    if (isMobile || !host) return items;
    items.push({
      label: "Move to new tab",
      testId: "new-conversation-menu-move-new-window",
      disabled: birthing,
      onClick: () => {
        const spec = specForTab({ type: "new-conversation", newConversation: currentPicks });
        if (spec === null) return;
        const w = window.open("#" + encodeWorkspaceSpec({ tabs: [spec], activeIndex: 0, only: true }), "_blank");
        console.info(`[new-conversation] move to new tab tabId=${tabId} opened=${w !== null}`);
        // Popup blocked → keep this pane.
        if (w !== null) host.close(tabId);
      },
    });
    items.push({
      label: "Close",
      testId: "new-conversation-menu-close",
      disabled: birthing,
      onClick: () => host.close(tabId),
    });
    return items;
  }, [isMobile, host, birthing, currentPicks, tabId]);
  const isDragSource = !isMobile && !isCoarsePointer() && !birthing;
  const onDragStart = isDragSource
    ? (e: ReactDragEvent<HTMLElement>) => {
        const dragId = writeBadgeDragData(e.dataTransfer, {
          tabId,
          identityKey: null,
          hostId: null,
          descriptor: { tabType: "new-conversation", newConversation: picksToWire(currentPicks), label: pillLabel },
        });
        console.info(`[new-conversation-drag] tabId=${tabId} dragId=${dragId}`);
      }
    : undefined;

  const nameError =
    name.trim().length > 0 && !nameValid && !shellOnly
      ? name.trim().length > 80
        ? "Name must be 80 characters or fewer"
        : "Name must contain at least one letter"
      : skynetCollision
        ? `Already exists in ${brandingConfig.appName}`
        : hostCollision && selectedHost
          ? `Already exists on ${selectedHost.name}`
          : null;

  // ── The compose box ─────────────────────────────────────────────────
  const composeHostId = selectedHost ? parseInt(String(selectedHost.id), 10) : 0;
  const composePlaceholder = shellOnly
    ? "Press send to open the shell"
    : noRoles || selectedRoles.length > 0
      ? `What should ${shownName || "it"} do first? (optional)`
      : "Pick a role above first…";

  const hello = shellOnly
    ? t("nav.newSessionShellDescription", { defaultValue: "A terminal on one of your machines, with no agent in it." })
    : t("nav.newConversationHello", {
        defaultValue: "Pick who you'd like to talk to, then say what you'd like done — or just press send.",
      });

  return (
    <div
      data-testid="new-conversation-pane"
      onMouseDown={() => onSelectPane?.(tabId)}
      className="h-full w-full flex flex-col relative overflow-hidden text-[var(--color-pv-fg)]"
      style={{ backgroundColor: "rgb(11, 12, 15)" }}
    >
      <PillFrame
        picture={picture}
        label={pillLabel}
        onOpen={() => {
          if (!shellOnly) nameInputRef.current?.focus();
        }}
        openAriaLabel="New conversation"
        menuItems={menuItems}
        menuAriaLabel="Conversation menu"
        onDragStart={onDragStart}
        sideButtons={false}
      />
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-3">
        <div className="mx-auto max-w-[780px] flex flex-col gap-4" style={{ paddingBottom: 190 }}>
          <div aria-hidden="true" style={{ height: 52 }} />
          <div className="flex flex-row items-center gap-3 flex-wrap">
            <p className="flex-1 min-w-[200px] text-[15px] leading-relaxed text-[var(--k-t2)]" data-testid="new-conversation-hello">
              {hello}
            </p>
            {isAdmin && (
              <KitSegmented
                aria-label="What to open"
                value={shellOnly ? "shell" : "agent"}
                onValueChange={(v) => !birthing && setShellOnly(v === "shell")}
                options={[
                  { value: "agent", label: "Agent", Icon: Bot, disabled: birthing },
                  { value: "shell", label: "Shell", Icon: Terminal, disabled: birthing },
                ]}
                testIdPrefix="new-session-mode"
                data-testid="new-session-identity-mode"
              />
            )}
          </div>
          {!effectiveShellOnly && (
            // The name is always shown: a suggestion fills it (picked to be
            // free on the agent's machine); typing replaces it.
            <div className="flex flex-col gap-1.5" data-testid="new-conversation-name-field">
              <KitField
                label="Name"
                htmlFor={`new-identity-name-${tabId}`}
                help={
                  !nameError && poolPickedName !== null && name.trim() === poolPickedName
                    ? t("nav.newSessionNameSuggested", { defaultValue: "Suggested — change it if you like." })
                    : undefined
                }
              >
                <KitInput
                  ref={nameInputRef}
                  id={`new-identity-name-${tabId}`}
                  aria-label="Name"
                  data-testid="new-conversation-name"
                  value={name}
                  maxLength={120}
                  onChange={(e) => {
                    setName(e.target.value);
                    // Re-checked on blur.
                    setSkynetCollision(false);
                    setHostCollision(false);
                  }}
                  onBlur={() => runCollisionPrecheck(name)}
                  placeholder={selectedHost ? "e.g. alicia" : t("nav.newSessionNamePickRoleFirst", { defaultValue: "Pick a role first" })}
                  disabled={birthing}
                  invalid={nameError !== null}
                />
              </KitField>
              {nameError && (
                <p role="alert" className="text-[13px] text-[var(--k-danger,#f87171)]" data-testid="new-conversation-name-error">
                  {nameError}
                </p>
              )}
            </div>
          )}

          {effectiveShellOnly ? (
            <div className="flex flex-col gap-4">
              {flatHosts.length !== 1 && (
                <div className="flex flex-col gap-2 min-w-0">
                  <KitSearch
                    value={search}
                    onValueChange={setSearch}
                    placeholder={t("nav.newSessionSearchHosts", { defaultValue: "Search hosts" })}
                    aria-label="Search hosts"
                    disabled={birthing}
                  />
                  <KitHostPicker
                    hosts={filteredHosts.map((h) => ({
                      id: String(h.id),
                      name: h.name,
                      detail: h.username ? `${h.username}@${h.ip}` : h.ip,
                      status: h.online ? "ok" : "off",
                    }))}
                    selectedId={selectedHost ? String(selectedHost.id) : null}
                    onSelect={(id) => {
                      const h = filteredHosts.find((x) => String(x.id) === id);
                      if (h) setSelectedHost(h);
                    }}
                    searchable={false}
                    emptyText={t("nav.newSessionNoHosts", { defaultValue: "No hosts available" })}
                  />
                </div>
              )}
              <KitField
                label={t("nav.newSessionNameLabel", { defaultValue: "Name (optional)" })}
                htmlFor={`new-session-name-${tabId}`}
                error={
                  !nameValid && sessionName.length > 0
                    ? "Use letters, numbers, underscores, or dashes (max 64 characters)."
                    : undefined
                }
              >
                <KitInput
                  id={`new-session-name-${tabId}`}
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                  onKeyDown={submitOnEnter(canStart, () => handleStart(""))}
                  placeholder="auto"
                  invalid={!nameValid}
                />
              </KitField>
              <KitField label="Path" htmlFor={`new-session-path-${tabId}`}>
                <KitInput
                  id={`new-session-path-${tabId}`}
                  aria-label="Path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  onKeyDown={submitOnEnter(canStart, () => handleStart(""))}
                  placeholder="Working directory (blank = ~/)"
                />
              </KitField>
            </div>
          ) : (
            <div data-testid="new-identity-roles">
              <RolePickList
                variant="pane"
                groups={roleGroups}
                value={pickedRoleValues}
                onChange={handleRolesChange}
                loading={!rolesReady || agentHosts.some((h) => !shownHostRoles[h.id]?.known)}
                disabled={birthing}
                onNewRole={() => {
                  console.log(
                    `[new-conversation] new-role hop tabId=${tabId} hostId=${selectedHost?.id ?? "-"} roles=${selectedRoles.join(",") || "-"}`,
                  );
                  setHop({ open: true, host: selectedHost });
                }}
              />
            </div>
          )}
        </div>
      </div>

      <div className="pv-fade-top" aria-hidden="true" />
      <div className="pv-dock" data-touch={isTouchDevice ? "true" : undefined} data-testid="pv-dock">
        {failure && (
          <div className="pv-compose-error text-center" role="alert" data-testid="new-conversation-failure">
            {failure}
          </div>
        )}
        <ComposeBox
          onSend={() => false}
          hostId={composeHostId}
          tmuxSession={null}
          isTouchDevice={isTouchDevice}
          showPaperclip={false}
          starter={{
            placeholder: composePlaceholder,
            // A shell has nowhere to put words; nothing to type.
            allowText: !shellOnly,
            canStart,
            busy: birthing,
            onStart: handleStart,
          }}
        />
      </div>

      <RolesWindow
        open={hop.open}
        onOpenChange={(o) => {
          if (o) return;
          // Closed with the ✕ partway through: the pane goes with it.
          console.log(`[new-conversation] new-role hop closed tabId=${tabId} — closing the pane`);
          setHop({ open: false, host: null });
          host?.close(tabId);
        }}
        start={{ view: "new", host: hop.host }}
        hostTree={hostTree}
        newRoleHop={
          hop.open
            ? {
                onBack: () => {
                  console.log(`[new-conversation] new-role hop back tabId=${tabId}`);
                  setHop({ open: false, host: null });
                },
                onCreated: ({ role, host: roleHost }) => {
                  setHop({ open: false, host: null });
                  const sameHost = selectedHost === null || selectedHost.id === roleHost.id;
                  const nextRoles = sameHost ? [...selectedRoles.filter((r) => r !== role), role] : [role];
                  console.log(
                    `[new-conversation] new-role hop created tabId=${tabId} role=${role} hostId=${roleHost.id} roles=${nextRoles.join(",")}`,
                  );
                  // The new role has to be in the list to show as picked.
                  const h = agentHosts.find((x) => x.id === roleHost.id) ?? roleHost;
                  // Loading again until the fresh list lands, so the
                  // stale-role guard doesn't drop the role the old list lacks.
                  setHostRoles((prev) => ({
                    ...prev,
                    [h.id]: { ...(prev[h.id] ?? { roles: [], error: null, known: false }), loading: true },
                  }));
                  requestRoles([h]);
                  rolesTouchedRef.current = true;
                  noRolesIsDefaultRef.current = false;
                  setSelectedHost(h);
                  setNoRoles(false);
                  setSelectedRoles(nextRoles);
                },
              }
            : null
        }
      />
    </div>
  );
}
