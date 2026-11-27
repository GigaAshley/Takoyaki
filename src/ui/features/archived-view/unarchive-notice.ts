// What to tell the user when an un-archive is refused or fails, in the
// archived conversation tab.

import { UnarchiveError } from "@/api/identity-unarchive-api";
import { reasonSentence } from "@/api/machine-changes-api";

export function unarchiveFailureNotice(err: unknown): { title: string; body: string } {
  if (err instanceof UnarchiveError && err.reason === "missing_roles") {
    return {
      title: `Un-archive role ${err.missingRoles?.join(", ") ?? "(unknown)"} first`,
      body: "This conversation depends on it.",
    };
  }
  if (err instanceof UnarchiveError && err.reason === "refused") {
    return { title: "Couldn't un-archive this conversation", body: reasonSentence(err.message) };
  }
  if (err instanceof UnarchiveError && err.reason === "name_collision") {
    return { title: "Couldn't un-archive this conversation", body: "There's already a live conversation with the same name." };
  }
  if (err instanceof UnarchiveError && err.reason === "archive_not_found") {
    return {
      title: "Couldn't un-archive this conversation",
      body: "The archive may have already been reactivated. Try again in a moment.",
    };
  }
  if (err instanceof UnarchiveError && err.reason === "connection_lost") {
    return {
      title: "Lost the connection while un-archiving",
      body: "It may still be coming back. If it isn't back in a minute, try again.",
    };
  }
  return { title: "Couldn't un-archive this conversation", body: "Try again in a moment." };
}
