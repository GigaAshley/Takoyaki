// Spoken lines for wealthy text (shape-wealthy-text): every chart, table,
// diagram, formula and collapsed section is read as one short line built from
// what's in it — never a model, never anything the agent has to write.
//
// Two readers use these: the bubble's speak button (which reads the drawn
// bubble; each block carries its line as screen-reader text) and voice mode
// (which reads the reply's markdown; `richSpeakable` rewrites the markdown).
import { unified, type PluggableList } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CHART_LANGS, article, chartSpeech, parseChartBlock, stripStop } from "./chart-spec";
import { remarkStrictMath } from "./remark-rich";

// ── Diagrams ──

export const MERMAID_LANGS = new Set(["mermaid", "mmd"]);
export const GRAPHVIZ_LANGS = new Set(["dot", "graphviz", "gv"]);

const MERMAID_KINDS: [RegExp, string][] = [
  [/^(flowchart|graph)\b/, "flowchart"],
  [/^sequenceDiagram\b/, "sequence diagram"],
  [/^classDiagram\b/, "class diagram"],
  [/^stateDiagram\b/, "state diagram"],
  [/^erDiagram\b/, "relationship diagram"],
  [/^journey\b/, "journey diagram"],
  [/^gantt\b/, "schedule chart"],
  [/^pie\b/, "pie chart"],
  [/^quadrantChart\b/, "quadrant chart"],
  [/^requirementDiagram\b/, "requirement diagram"],
  [/^gitGraph\b/, "branch diagram"],
  [/^mindmap\b/, "mind map"],
  [/^timeline\b/, "timeline"],
  [/^xychart\b/, "chart"],
  [/^sankey\b/, "flow chart"],
  [/^block\b/, "block diagram"],
  [/^architecture\b/, "architecture diagram"],
  [/^kanban\b/, "board"],
  [/^packet\b/, "packet diagram"],
];

/** "flowchart", "timeline", … from the diagram's opening keyword. */
export function diagramKindWord(lang: string, source: string): string {
  if (GRAPHVIZ_LANGS.has(lang)) return "graph diagram";
  const lines = source.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = lines.findIndex((l, j) => j > 0 && l.trim() === "---") + 1;
  }
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("%%")) continue;
    for (const [re, word] of MERMAID_KINDS) if (re.test(line)) return word;
    return "diagram";
  }
  return "diagram";
}

export function diagramTitle(lang: string, source: string): string {
  if (GRAPHVIZ_LANGS.has(lang)) {
    // The graph's own label: a top-level label=, not one inside a node's [ ].
    const topLevel = source.replace(/\[[^\]]*\]/g, "");
    const graphAttr = source.match(/\bgraph\s*\[[^\]]*\blabel\s*=\s*"([^"]+)"/)?.[1];
    return (graphAttr ?? topLevel.match(/(?:^|[{;\s])label\s*=\s*"([^"]+)"/)?.[1] ?? "").trim();
  }
  const front = source.match(/^---\r?\n[\s\S]*?^title:\s*(.+)$[\s\S]*?^---/m)?.[1];
  if (front) return front.trim().replace(/^["']|["']$/g, "");
  return source.match(/^\s*(?:pie\s+)?title\s+(.+)$/m)?.[1]?.trim() ?? "";
}

/** "A flowchart: deploy steps." */
export function diagramSpeech(lang: string, source: string): string {
  const kind = diagramKindWord(lang, source);
  const title = diagramTitle(lang, source);
  return `${article(kind)} ${kind}${title ? `: ${stripStop(title)}` : ""}.`;
}

// ── Tables ──

/**
 * "A table of 2 rows. Host thenasty, Disk 62%. Host workstation, Disk 80%."
 * Every row, in the agent's order, each cell after its column heading. Cells
 * are read as written (shape-tables-in-full).
 */
export function tableSpeech(headings: string[], rows: string[][]): string {
  const one = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const count = `${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
  const spoken = rows
    .map((cells) =>
      cells
        .map((cell, i) => `${one(headings[i])} ${one(cell)}`.trim())
        .filter(Boolean)
        .join(", "),
    )
    .filter(Boolean)
    .map((row) => ` ${/[.!?]$/.test(row) ? row : `${row}.`}`);
  return `A table of ${count}.${spoken.join("")}`;
}

// ── Math ──

const GREEK = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi chi psi omega".split(" ");
const MAX_SPOKEN_FORMULA = 40;

/** A short formula read out in words; anything longer or stranger is "a formula". */
export function mathSpeech(tex: string): string {
  let s = tex.trim();
  const words: [RegExp, string][] = [
    [/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, " $1 over $2 "],
    [/\\sqrt\{([^{}]*)\}/g, " the square root of $1 "],
    [/\^\{?2\}?/g, " squared "],
    [/\^\{?3\}?/g, " cubed "],
    [/\^\{([^{}]*)\}/g, " to the power of $1 "],
    [/\^(\w)/g, " to the power of $1 "],
    [/_\{([^{}]*)\}/g, " sub $1 "],
    [/_(\w)/g, " sub $1 "],
    [/\\(times|cdot)\b/g, " times "],
    [/\\div\b/g, " divided by "],
    [/\\pm\b/g, " plus or minus "],
    [/\\(leq|le)\b|≤/g, " is at most "],
    [/\\(geq|ge)\b|≥/g, " is at least "],
    [/\\(neq|ne)\b|≠/g, " is not "],
    [/\\approx\b/g, " is about "],
    [/\\infty\b/g, " infinity "],
    [new RegExp(`\\\\(${GREEK.join("|")})\\b`, "gi"), " $1 "],
    [/\\[,;!: ]/g, " "],
    [/<=/g, " is at most "],
    [/>=/g, " is at least "],
    [/=/g, " equals "],
    [/</g, " is less than "],
    [/>/g, " is more than "],
    [/\+/g, " plus "],
    [/(?<=\s|^)-(?=\s*\w)/g, " minus "],
    [/\//g, " over "],
  ];
  for (const [re, rep] of words) s = s.replace(re, rep);
  s = s.replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || /\\/.test(s) || s.length > MAX_SPOKEN_FORMULA) return "a formula";
  return s;
}

// ── Markdown → speech (voice mode) ──

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*$/;

interface Segment {
  fence: boolean;
  lang: string;
  body: string;
  raw: string;
}

/** Splits markdown into fenced code blocks and the prose between them. */
export function splitFences(markdown: string): Segment[] {
  const lines = markdown.split("\n");
  const out: Segment[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) out.push({ fence: false, lang: "", body: prose.join("\n"), raw: prose.join("\n") });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE_OPEN);
    if (!open) {
      prose.push(lines[i]);
      continue;
    }
    const marker = open[1];
    let j = i + 1;
    const closeRe = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
    while (j < lines.length && !closeRe.test(lines[j])) j++;
    flush();
    out.push({
      fence: true,
      lang: open[2].toLowerCase(),
      body: lines.slice(i + 1, j).join("\n"),
      raw: lines.slice(i, Math.min(j + 1, lines.length)).join("\n"),
    });
    i = j;
  }
  flush();
  return out;
}

// Tables are found and split into cells by the same markdown parser that
// draws them, so voice mode hears exactly the cells the speak button does.
const tableParser = unified()
  .use(remarkParse)
  .use([remarkGfm, remarkMath, remarkStrictMath] as PluggableList);

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** A cell's words as the drawn table shows them: text, code and formulas as written, pictures silent. */
function cellText(n: MdNode): string {
  switch (n.type) {
    case "text":
    case "inlineCode":
    case "inlineMath":
    case "html":
      return n.value ?? "";
    case "break":
      return " ";
    case "image":
    case "imageReference":
    case "footnoteReference":
      return "";
    default:
      return (n.children ?? []).map(cellText).join("");
  }
}

function collectTables(n: MdNode, out: MdNode[]): void {
  for (const c of n.children ?? []) {
    if (c.type === "table") out.push(c);
    else collectTables(c, out);
  }
}

/**
 * Replaces each table in `prose` with its spoken line. With `held`, the line
 * goes into `held` and a marker takes its place, so later clean-up of the
 * reply's markdown can't reach into the cells (see `restoreHeld`).
 */
function speakTables(prose: string, held?: string[]): string {
  if (!prose.includes("|")) return prose;
  const tables: MdNode[] = [];
  const tree = tableParser.parse(prose);
  collectTables(tableParser.runSync(tree, prose) as unknown as MdNode, tables);
  let out = prose;
  for (const table of tables.reverse()) {
    const start = table.position?.start.offset;
    const end = table.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const [head, ...body] = (table.children ?? []).map((row) => (row.children ?? []).map(cellText));
    const width = head?.length ?? 0;
    // The drawn table pads short rows and drops extra cells; so does this.
    const rows = body.map((cells) => Array.from({ length: width }, (_, i) => cells[i] ?? ""));
    let line = tableSpeech(head ?? [], rows);
    if (held) {
      held.push(line);
      line = `\uE000${held.length - 1}\uE001`;
    }
    out = `${out.slice(0, start)}${line}${out.slice(end)}`;
  }
  return out;
}

/** Puts back the table lines `richSpeakable` held aside. */
export function restoreHeld(text: string, held: readonly string[]): string {
  return text.replace(/\uE000(\d+)\uE001/g, (m, i: string) => held[Number(i)] ?? m);
}

function speakMath(prose: string): string {
  return prose
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => ` ${mathSpeech(tex)} `)
    .replace(/\$(?=\S)([^$\n]*?\S)\$(?![\w/:])/g, (_m, tex: string) => mathSpeech(tex));
}

const SECTION_TAG = /<details(\s[^>]*)?>|<\/details\s*>|<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary\s*>/gi;

function plainSummary(html: string): string {
  return stripStop(html.replace(/<[^>]+>/g, "").trim()) || "Details";
}

function speakFence(seg: Segment): string {
  if (CHART_LANGS.has(seg.lang)) {
    const res = parseChartBlock(seg.body);
    return res.ok ? ` ${chartSpeech(res.option)} ` : seg.raw;
  }
  if (MERMAID_LANGS.has(seg.lang) || GRAPHVIZ_LANGS.has(seg.lang)) return ` ${diagramSpeech(seg.lang, seg.body)} `;
  return seg.raw;
}

/**
 * Voice mode's view of wealthy text: charts and diagrams become their spoken
 * line, tables every row read under its headings, formulas their words. A closed
 * section is just its summary — everything inside it, code blocks and charts
 * included, stays silent; one written to start open is read in full. Other
 * code blocks are left for the caller. Pass `held` to get table lines back as
 * markers (put back with `restoreHeld` once the caller's clean-up is done).
 */
export function richSpeakable(markdown: string, held?: string[]): string {
  const sections: boolean[] = []; // open flag per enclosing section, outermost first
  const hidden = (depth = sections.length) => sections.slice(0, depth).some((open) => !open);
  const parts: string[] = [];
  for (const seg of splitFences(markdown)) {
    if (seg.fence) {
      if (!hidden()) parts.push(speakFence(seg));
      continue;
    }
    let out = "";
    let last = 0;
    for (const m of seg.raw.matchAll(SECTION_TAG)) {
      if (!hidden()) out += seg.raw.slice(last, m.index);
      last = (m.index ?? 0) + m[0].length;
      const tag = m[0].toLowerCase();
      if (tag.startsWith("</details")) {
        sections.pop();
        out += " ";
      } else if (tag.startsWith("<details")) {
        sections.push(/\bopen\b/i.test(m[1] ?? ""));
      } else if (!hidden(sections.length - 1)) {
        // A summary is heard whenever the section around it can be seen.
        out += ` ${plainSummary(m[2] ?? "")}. `;
      }
    }
    if (!hidden()) out += seg.raw.slice(last);
    parts.push(speakMath(speakTables(out, held)));
  }
  return parts.join("\n");
}
