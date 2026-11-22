// A new-conversation pane's picks on the wire — the URL fragment
// (`new:<payload>`) and the pane's drag descriptor for a move to another
// window. Compact JSON so the address stays short; every field is checked on
// the way in, and anything that doesn't fit is dropped rather than trusted
// (the pane then just starts without it).

import type { NewConversationPicks } from "@/types/ui-types";

const HOST_ID_RE = /^[1-9][0-9]{0,9}$/;
const ROLE_RE = /^[a-z0-9-]{1,64}$/;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const MAX_ROLES = 32;
const MAX_NAME = 80;
const MAX_PATH = 1024;

type Wire = {
  s?: 1;
  h?: number;
  r?: string[];
  n?: 1;
  m?: string;
  p?: [string, number];
  d?: string;
};

function validHostId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && HOST_ID_RE.test(String(v));
}

/** Picks → the compact wire object (empty picks → `{}`). */
export function picksToWire(picks: NewConversationPicks): Wire {
  const w: Wire = {};
  if (picks.shell) w.s = 1;
  if (picks.hostId !== undefined) w.h = picks.hostId;
  if (picks.roles && picks.roles.length > 0) w.r = picks.roles;
  if (picks.noRoles) w.n = 1;
  if (picks.name) w.m = picks.name;
  if (picks.project) w.p = [picks.project.slug, picks.project.hostId];
  if (picks.path) w.d = picks.path;
  return w;
}

/** Anything → picks, keeping only what checks out. Never throws. */
export function picksFromWire(raw: unknown): NewConversationPicks {
  const picks: NewConversationPicks = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return picks;
  const w = raw as Record<string, unknown>;
  if (w.s === 1) picks.shell = true;
  if (validHostId(w.h)) picks.hostId = w.h;
  if (Array.isArray(w.r)) {
    const roles = w.r.filter((r): r is string => typeof r === "string" && ROLE_RE.test(r));
    const unique = [...new Set(roles)].slice(0, MAX_ROLES);
    if (unique.length > 0) picks.roles = unique;
  }
  if (w.n === 1 && !picks.roles) picks.noRoles = true;
  if (typeof w.m === "string" && w.m.trim() !== "" && w.m.length <= MAX_NAME) picks.name = w.m;
  if (
    Array.isArray(w.p) &&
    w.p.length === 2 &&
    typeof w.p[0] === "string" &&
    SLUG_RE.test(w.p[0]) &&
    validHostId(w.p[1])
  ) {
    picks.project = { slug: w.p[0], hostId: w.p[1] };
  }
  if (typeof w.d === "string" && w.d.length <= MAX_PATH) picks.path = w.d;
  return picks;
}

/** Same picks? (Field by field — key order doesn't matter.) */
export function samePicks(a: NewConversationPicks, b: NewConversationPicks): boolean {
  return JSON.stringify(picksToWire(a)) === JSON.stringify(picksToWire(b));
}
