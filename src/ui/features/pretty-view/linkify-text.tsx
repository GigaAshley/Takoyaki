import type { ReactNode } from "react";

// linkifyText — turns bare web addresses in plain message text into links.
//
// Relay messages from other people render as plain text (not markdown), so
// GFM's autolinker never sees them; this gives them the same clickable links
// the user's own markdown-rendered messages get. Everything else stays a
// React text child — no HTML is ever interpreted.

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

// Punctuation that usually ends the sentence rather than the address.
const TRAILING_PUNCT = /[.,;:!?'"*_~]+$/;

/** Trims sentence punctuation and an unbalanced closing bracket off a match. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const before = url;
    url = url.replace(TRAILING_PUNCT, "");
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
      if (url.endsWith(close) && url.split(close).length > url.split(open).length) {
        url = url.slice(0, -1);
      }
    }
    if (url === before) return url;
  }
}

export function linkifyText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const url = trimUrl(m[0]);
    // A bare scheme ("https://") with nothing after it isn't a link.
    if (url.length <= url.indexOf("//") + 2) continue;
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <a key={start} href={url} target="_blank" rel="noopener noreferrer" className="underline">
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
