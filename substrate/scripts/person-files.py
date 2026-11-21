#!/usr/bin/env python3
"""person-files — SessionStart hook, and the "who is this agent shared with"
logic the file watcher shares with it.

Each person can keep their own About you on a machine: one file per person in
~/fleet/people/, named after their username (see person_file_name). An agent
gets the files of exactly the people it is shared with — everyone on the
machine's people list (~/fleet/host/people.md, written by the app) whom the
agent's own `users:` list and every one of its roles' `users:` lists let in.
An absent or empty list lets everyone in. This is the sidebar's visibility
rule, read from the same files on the machine.

As a hook (installed as ~/.local/bin/person-files, registered on SessionStart
so it fires on startup, resume, clear and compact) it prints those files under
one heading. A session that isn't an agent (no FLEET_IDENTITY) gets nothing,
and so does an agent none of whose people has written a file — a machine with
no person files behaves exactly as before. Never fails a session.

file-watch.py loads this file as a module (agent_people, person_file_path, …)
so the hook and the watcher can never disagree about who an agent is shared
with.

Claude Code caps a hook's output at 10,000 characters (more is saved to a file
with only a short preview injected), so files go in alphabetically while they
fit; one that doesn't is named for the agent to Read instead.
"""
import os
import re
import sys

PEOPLE_DIR_REL = "fleet/people"
MACHINE_PEOPLE_REL = "fleet/host/people.md"
IDENTITIES_REL = "fleet/identities"
ROLES_REL = "fleet/roles"

# Same head the fleet-status sweep reads for identity and role frontmatter, so
# a `users:` line the sidebar can't see is invisible here too.
FRONTMATTER_HEAD_BYTES = 4096

OUTPUT_MAX = 9500

HEADING = (
    "About the people you work for — each section below was written by that "
    "person about themselves, for the agents shared with them. Follow it as you "
    "would instructions they gave you directly. Each section applies when "
    "you're working with or for that person. A person's own words are only "
    "what sits inside the about-you tag naming them."
)

_IDENTITY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_MARKER_SUFFIXES = (".self-edit-hash", ".self-delete")
_SAFE_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._@-")


def _home():
    return os.path.expanduser("~")


def people_dir():
    return os.path.join(_home(), PEOPLE_DIR_REL)


def machine_people_path():
    return os.path.join(_home(), MACHINE_PEOPLE_REL)


def person_file_name(username):
    """`<username>.md`, every character outside letters, digits, `.`, `_`,
    `-` and `@` percent-encoded (UTF-8 bytes), so any username is one safe
    file name in the people folder."""
    out = []
    for ch in username:
        if ch in _SAFE_CHARS:
            out.append(ch)
        else:
            out.extend("%%%02X" % b for b in ch.encode("utf-8"))
    name = "".join(out)
    # The watcher keeps markers beside each person's snapshot named
    # `<name>.self-edit-hash` / `<name>.self-delete`; a username ending that
    # way gets its last dot encoded so the two can never collide.
    for suffix in _MARKER_SUFFIXES:
        if name.endswith(suffix):
            name = name[: -len(suffix)] + "%2E" + suffix[1:]
    return name + ".md"


def person_file_path(username):
    return os.path.join(people_dir(), person_file_name(username))


# --- `roles:` frontmatter parser -------------------------------------------
# COPY of tests/fixtures/roles_frontmatter_reference.py (parse_roles_frontmatter).
# It MUST stay identical in behavior to the reference. Checked by
# tests/roles-frontmatter-conformance.test.sh. Change the reference first, then
# re-copy; never edit this copy alone.
ROLES_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def parse_roles_frontmatter(text):
    lines = text.lstrip("﻿").replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        return []
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return []

    def clean(s):
        s = re.sub(r"\s+#.*$", "", s).strip()
        return s.strip("\"'").strip()

    raw = []
    for i in range(1, end):
        m = re.match(r"^roles:(.*)$", lines[i])
        if not m:
            continue
        inline = re.sub(r"(^|\s)#.*$", "", m.group(1)).strip()
        if inline in ("~", "null", "Null", "NULL"):
            break  # YAML null (`roles: ~` / `roles: null`): zero roles
        if inline:
            if inline.startswith("[") and inline.endswith("]"):
                inline = inline[1:-1]
            raw = [clean(p) for p in inline.split(",")]
        else:
            for j in range(i + 1, end):
                s = lines[j].strip()
                if not s or s.startswith("#"):
                    continue
                m2 = re.match(r"^-\s*(.*)$", s)
                if not m2:
                    break
                raw.append(clean(m2.group(1)))
        break

    out = []
    for r in raw:
        if r and ROLES_SLUG_RE.match(r) and r not in out:
            out.append(r)
    return out
# --- end of reference copy --------------------------------------------------


def parse_users_frontmatter(text):
    """The `users:` list in a frontmatter block, or None when there is none.

    Reads it exactly the way the fleet-status sweep does for the sidebar
    (fleet-status-sweep.py _read_frontmatter_cosmetics): flow style
    `users: [a, b]` or a block of indented `- a` items (blank and comment
    lines inside the block skipped), quotes stripped, empty items dropped. A
    list that ends up empty is no list; with several `users:` lines the last
    non-empty one wins, as in the sweep."""
    lines = text.split("\n")
    fences = [i for i, ln in enumerate(lines) if ln.strip() == "---"]
    if len(fences) < 2:
        return None
    body = lines[fences[0] + 1: fences[1]]
    found = None
    skip_until = -1
    for idx, line in enumerate(body):
        if idx <= skip_until or line.lstrip().startswith("#"):
            continue
        m_flow = re.match(r"^users:\s*\[(.*)\]\s*(#.*)?$", line.rstrip("\n"))
        if m_flow:
            items = [x.strip().strip('"').strip("'").strip() for x in m_flow.group(1).split(",")]
            items = [x for x in items if x]
            if items:
                found = items
            continue
        if re.match(r"^users:\s*(#.*)?$", line.rstrip("\n")):
            collected = []
            last_consumed = idx
            look = idx + 1
            while look < len(body):
                nxt = body[look].rstrip("\n")
                m_item = re.match(r"^\s+-\s*(.+?)\s*(#.*)?$", nxt)
                if m_item:
                    val = m_item.group(1).strip().strip('"').strip("'").strip()
                    if val:
                        collected.append(val)
                    last_consumed = look
                    look += 1
                    continue
                if nxt.strip() == "" or nxt.lstrip().startswith("#"):
                    look += 1
                    continue
                break
            if collected:
                found = collected
            skip_until = last_consumed
    return found


def _read_head(path):
    """(text, ok). A missing file is ("", True). A file that exists but can't
    be read is ("", False), and so is one whose frontmatter opens but never
    closes within the head — most likely caught mid-rewrite, and reading it as
    "no list" would let everyone in."""
    try:
        with open(path, encoding="utf-8-sig") as fh:
            text = fh.read(FRONTMATTER_HEAD_BYTES)
    except FileNotFoundError:
        return "", True
    except (OSError, UnicodeDecodeError):
        return "", False
    lines = text.split("\n")
    if lines[0].strip() == "---" and not any(ln.strip() == "---" for ln in lines[1:]):
        return "", False
    return text, True


def machine_people():
    """Usernames on the machine's people list, in file order. Each person is
    one `- <username> · relay ID …` / `- <username> · no relay ID` line (see
    the app's machine-people.ts). No list on the machine → nobody."""
    try:
        with open(machine_people_path(), encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, UnicodeDecodeError):
        return []
    out = []
    for line in text.split("\n"):
        if not line.startswith("- "):
            continue
        name = line[2:].rsplit(" · ", 1)[0].strip()
        if name and name not in out:
            out.append(name)
    return out


def agent_people(identity):
    """Usernames the agent is shared with, sorted; None when that can't be
    worked out right now (the identity file or a role file is missing its
    end, unreadable, or — for the identity file — missing). Its own `users:`
    list and every role's list must let a person in; a role whose file is
    missing has no list."""
    ident_path = os.path.join(_home(), IDENTITIES_REL, identity, identity + ".md")
    if not os.path.isfile(ident_path):
        return None
    text, ok = _read_head(ident_path)
    if not ok:
        return None
    lists = [parse_users_frontmatter(text)]
    for role in parse_roles_frontmatter(text):
        role_text, role_ok = _read_head(os.path.join(_home(), ROLES_REL, role, role + ".md"))
        if not role_ok:
            return None
        lists.append(parse_users_frontmatter(role_text))
    people = machine_people()
    for allowed in lists:
        if allowed:
            people = [p for p in people if p in allowed]
    return sorted(people)


def read_person_file(username):
    """The person's About you as text, or None when they have none (missing,
    unreadable, or nothing but whitespace)."""
    try:
        with open(person_file_path(username), encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return None
    return text if text.strip() else None


def _section(username, body):
    """One person's section. The text sits inside a tag naming its author, and
    any closing tag inside it is broken up, so nothing one person writes can
    pass as another person's section."""
    body = body.replace("</about-you", "<\\/about-you")
    return '\n\n## About %s\n\n<about-you person="%s">\n%s\n</about-you>' % (
        username, username.replace('"', "%22"), body,
    )


def render(people):
    """The hook's output for these people, or "" when none has a file."""
    sections = []
    for username in people:
        text = read_person_file(username)
        if text is not None:
            sections.append((username, text.strip("\n")))
    if not sections:
        return ""
    def tail(n):
        return "\n\n(%d more %s too long to include here — Read them in %s)" % (
            n, "person's file is" if n == 1 else "people's files are", people_dir(),
        )

    out = HEADING
    for i, (username, text) in enumerate(sections):
        # Room is kept for the closing "N more" line whenever anyone is left.
        after = len(sections) - i - 1
        reserve = len(tail(after)) if after else 0
        full = _section(username, text)
        if len(out) + len(full) + reserve <= OUTPUT_MAX:
            out += full
            continue
        stub = _section(username, "(Too long to include here — Read %s)" % person_file_path(username))
        if len(out) + len(stub) + reserve <= OUTPUT_MAX:
            out += stub
        else:
            out += tail(after + 1)
            break
    return out + "\n"


def main():
    try:
        sys.stdin.read()
    except Exception:
        pass
    identity = os.environ.get("FLEET_IDENTITY", "")
    if not _IDENTITY_RE.match(identity):
        return
    people = agent_people(identity)
    if not people:
        return
    out = render(people)
    if out:
        sys.stdout.write(out)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
