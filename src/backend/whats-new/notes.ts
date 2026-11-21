// What's new — the user-facing notes shown once to each person after an
// instance updates (see whats-new-state.ts for who sees what, and
// src/ui/features/whats-new/ for the pop-up).
//
// Rules for adding a note:
//   - Only for a change an ordinary user would notice. No notes for internal,
//     agent-only or admin-only changes.
//   - One or two short, plain sentences — just what is different. Not a
//     commit message.
//   - The instance owner approves the exact text before it is committed.
//   - Append to the END of the list (the pop-up shows newest first).
//   - `id` is a short lowercase slug (e.g. "unread-marks"), unique and
//     permanent: never reuse or rename an id, and never rewrite a shipped
//     note into something different — people's "seen" records refer to it.
//   - To withdraw a shipped note, delete it from the list and add its id to
//     RETIRED_NOTE_IDS so it is never reused. Seen records keep the old id
//     harmlessly. notes.test.ts checks ids are unique, not retired, and the
//     text is short.

export interface WhatsNewNote {
  id: string;
  text: string;
}

export const WHATS_NEW_NOTES: readonly WhatsNewNote[] = [
  {
    id: "voice-send-phrase-over",
    text: "If you've set voice mode to send when you say a phrase: the default phrase is now \"over\" instead of \"send it\". You can change it under Preferences → Voice.",
  },
  {
    id: "quote-to-reply",
    text: "Quote to reply: select any words in a message and tap Quote to add them to your reply as a quote.",
  },
  {
    id: "project-apps",
    text: "Apps can now belong to a project: they appear under the project in the sidebar and in the project window's new Apps tab. Any app's menu has Move to, for putting it in the sidebar or a project.",
  },
  {
    id: "voice-pause-button",
    text: "Voice mode and dictation now have a pause button instead of mute. Pausing voice mode holds everything — a reply being read stops mid-sentence and picks up where it left off — and tapping the voice-mode chip no longer skips a reply.",
  },
];

// Ids of withdrawn notes. Never reuse one: people who saw the old note would
// never be shown the new one.
export const RETIRED_NOTE_IDS: readonly string[] = ["logout-clears-app", "voice-bail-soft-sound"];
