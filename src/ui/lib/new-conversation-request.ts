// "Start a conversation with this role" — asked for from wherever a role is
// shown (the roles window opens from the sidebar AND from an agent's window),
// answered by the content area, which opens a new-conversation pane with the
// role picked. The request is also held until it can be answered: the shell
// waits for the machine list before opening the pane on the role's machine.

export const NEW_CONVERSATION_REQUEST_EVENT = "skynet:new-conversation-request";

export interface NewConversationRequest {
  hostId: number;
  role: string;
}

let pending: NewConversationRequest | null = null;

/** The request not yet answered, if any — taking it answers it. */
export function takeNewConversationRequest(): NewConversationRequest | null {
  const p = pending;
  pending = null;
  return p;
}

export function requestNewConversation(detail: NewConversationRequest): void {
  console.info({ operation: "new_conversation_requested", hostId: detail.hostId, role: detail.role });
  pending = detail;
  window.dispatchEvent(new CustomEvent<NewConversationRequest>(NEW_CONVERSATION_REQUEST_EVENT, { detail }));
}
