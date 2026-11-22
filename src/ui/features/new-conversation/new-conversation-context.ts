// What a new-conversation pane needs from the content area that holds it —
// provided by AppShell around every pane, read by the pane. A context rather
// than more renderer arguments: only this pane uses it.

import { createContext, useContext } from "react";
import type { Host, HostFolder, NewConversationPicks } from "@/types/ui-types";

/** What was started — the agent's (or shell's) machine and session. */
export type NewConversationStarted =
  | { kind: "agent"; host: Host; name: string; project: string | null }
  | { kind: "shell"; host: Host; sessionName?: string; path: string };

export interface NewConversationHost {
  hostTree: HostFolder | null;
  isAdmin: boolean;
  /** isAdmin has been answered (it arrives after the first paint). Absent =
   *  known. A pane restored as a shell waits for it before seeding. */
  adminKnown?: boolean;
  /** Creation started / ended — a pane being created isn't closed when the
   *  user clicks away, so the conversation can still take its place. */
  setStarting: (tabId: string, starting: boolean) => void;
  /** The pane's picks changed (kept on its tab, so in the URL). */
  updatePicks: (tabId: string, picks: NewConversationPicks) => void;
  /** The conversation started: it takes the pane's place (without pulling
   *  the view to it if the user has clicked away meanwhile). */
  started: (tabId: string, what: NewConversationStarted) => void;
  /** Close the pane. */
  close: (tabId: string) => void;
}

export const NewConversationHostContext = createContext<NewConversationHost | null>(null);

export function useNewConversationHost(): NewConversationHost | null {
  return useContext(NewConversationHostContext);
}
