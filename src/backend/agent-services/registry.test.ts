import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../utils/logger.js", () => {
  const stub = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  };
  return { systemLogger: stub, sshLogger: stub };
});

import { AGENT_SERVICES, DISCOVERED_SERVICES, SERVICES_DIR, discoverServices } from "./registry.js";
import { serviceCatalogRows } from "./distribution.js";
import { createAgentServiceEngine } from "./engine/engine.js";
import { FLEET_SUBSTRATE_CATALOG } from "../distributor/catalog.js";
import { FULL_SUBSTRATE_CATALOG, combineCatalog } from "../distributor/full-catalog.js";

const FIXTURES = path.join(__dirname, "test-fixtures");

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A services root holding `folders`, each a map of relative path → content. */
function makeRoot(folders: Record<string, Record<string, string | { exec: string }>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-services-"));
  tmpRoots.push(root);
  for (const [folder, files] of Object.entries(folders)) {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(root, folder, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (typeof content === "string") fs.writeFileSync(p, content);
      else fs.writeFileSync(p, content.exec, { mode: 0o755 });
    }
  }
  return root;
}

/** A plain-JS service file (no imports, so it loads from any folder). */
const serviceJs = (name: string, extra = "") => `export default {
  name: ${JSON.stringify(name)},
  description: "test",
  input: { safeParse() { return { success: true, data: {} }; } },
  ttlMs: 1000,
  async handle() { return { ok: true, result: {} }; },
  ${extra}
};
`;

describe("the services that ship", () => {
  it("are found from their folders, with none skipped", async () => {
    const found = await discoverServices(SERVICES_DIR, () => {});
    expect(found.skipped).toEqual([]);
    // The four that existed before the move; new services just add to this.
    expect(found.services.map((s) => s.def.name)).toEqual(
      expect.arrayContaining(["agent-phone", "identity-reactivate", "image-gen", "stt"]),
    );
    expect(AGENT_SERVICES.map((s) => s.name)).toEqual(found.services.map((s) => s.def.name));
  });

  it("push the same skills and scripts, to the same places, as before the move", () => {
    const rows = serviceCatalogRows(DISCOVERED_SERVICES).map((r) => [r.slug, r.installPath]);
    // What machines got before the move; new services just add rows.
    expect(rows).toEqual(
      expect.arrayContaining([
        ["agent-phone-skill", "~/.claude/skills/agent-phone/SKILL.md"],
        ["agent-phone-helper", "~/.local/bin/agent-phone"],
        ["image-gen-skill", "~/.claude/skills/image-gen/SKILL.md"],
        ["image-gen-helper", "~/.local/bin/image-gen"],
        ["stt-skill", "~/.claude/skills/stt/SKILL.md"],
        ["stt-helper", "~/.local/bin/stt"],
      ]),
    );
    // identity-reactivate has nothing for hosts.
    expect(rows.some(([slug]) => slug.startsWith("identity-reactivate"))).toBe(false);
    for (const row of serviceCatalogRows(DISCOVERED_SERVICES)) {
      expect(fs.existsSync(row.bundledPath)).toBe(true);
      if (row.installPath.startsWith("~/.local/bin/")) {
        expect(fs.statSync(row.bundledPath).mode & 0o111).not.toBe(0);
      }
    }
  });

  it("are all in the distributor's full catalog, alongside the hand-kept one", () => {
    expect(FULL_SUBSTRATE_CATALOG.length).toBe(
      FLEET_SUBSTRATE_CATALOG.length + serviceCatalogRows(DISCOVERED_SERVICES).length,
    );
    const paths = FULL_SUBSTRATE_CATALOG.map((r) => r.installPath);
    expect(new Set(paths).size).toBe(paths.length);
    const slugs = FULL_SUBSTRATE_CATALOG.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("declare every key with a label and a where-to-get-it note", () => {
    for (const svc of AGENT_SERVICES) {
      for (const spec of Object.values(svc.secrets ?? {})) {
        expect(spec.label.length).toBeGreaterThan(0);
        expect(spec.description.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("adding a service is one folder", () => {
  it("a new folder is served by the engine and its skill and script are pushed, with nothing else changed", async () => {
    const shipped = await discoverServices(SERVICES_DIR, () => {});
    const added = await discoverServices(FIXTURES, () => {});
    expect(added.skipped).toEqual([]);
    const all = [...shipped.services, ...added.services];

    // The engine answers it.
    let answered: Record<string, unknown> | undefined;
    const engine = createAgentServiceEngine({
      services: all.map((s) => s.def),
      env: { SAMPLE_API_KEY: "abcd" },
      writeResponse: async (_host, _uuid, _files, _name, json) => {
        answered = JSON.parse(json);
      },
    });
    await engine.intake(
      { id: "7", idNum: 7 },
      { claim: async () => [], readAttachment: async () => "missing" },
      [
        {
          uuid: "0b5c2f9e-1a2b-4c3d-8e9f-001122334455",
          body: JSON.stringify({
            service: "sample",
            requested_at: new Date().toISOString(),
            input: { word: "hello" },
          }),
        },
      ],
    );
    await vi.waitFor(() => expect(answered).toBeDefined());
    expect(answered).toMatchObject({ ok: true, service: "sample", result: { word: "hello", keyLength: 4 } });
    engine.stop();

    // Its skill and script join the distributor's catalog; the hand-kept
    // catalog is untouched.
    const before = FLEET_SUBSTRATE_CATALOG.length;
    const full = combineCatalog(FLEET_SUBSTRATE_CATALOG, serviceCatalogRows(all), () => {});
    expect(FLEET_SUBSTRATE_CATALOG.length).toBe(before);
    expect(full.length).toBe(before + serviceCatalogRows(shipped.services).length + 2);
    expect(full.slice(-2).map((r) => [r.slug, r.installPath])).toEqual([
      ["sample-skill", "~/.claude/skills/sample/SKILL.md"],
      ["sample-helper", "~/.local/bin/sample"],
    ]);
  });

  it("skill companions install beside the SKILL.md", async () => {
    const root = makeRoot({
      multi: {
        "service.js": serviceJs("multi"),
        "skill/SKILL.md": "x",
        "skill/notes/more.md": "y",
      },
    });
    const { services } = await discoverServices(root, () => {});
    expect(serviceCatalogRows(services).map((r) => [r.slug, r.installPath])).toEqual([
      ["multi-skill", "~/.claude/skills/multi/SKILL.md"],
      ["multi-skill-notes-more-md", "~/.claude/skills/multi/notes/more.md"],
    ]);
  });
});

describe("a broken service folder", () => {
  const cases: [string, Record<string, string | { exec: string }>, RegExp][] = [
    ["has no service file", { "skill/SKILL.md": "x" }, /no service\.ts/],
    ["names itself after another folder", { "service.js": serviceJs("other") }, /named "other"/],
    ["fails to load", { "service.js": "throw new Error('boom');" }, /failed to load: boom/],
    ["has no default export", { "service.js": "export const x = 1;" }, /no default export/],
    [
      "lists keys the old way, without labels",
      { "service.js": serviceJs("broken", 'secrets: ["API_KEY"],') },
      /label and a description/,
    ],
    [
      "has a key without a description",
      { "service.js": serviceJs("broken", 'secrets: { API_KEY: { label: "x" } },') },
      /API_KEY needs a label and a description/,
    ],
    [
      "has a script that isn't executable",
      { "service.js": serviceJs("broken"), "bin/broken": "#!/bin/sh\n" },
      /not executable/,
    ],
    [
      "has a file where its bin folder should be",
      { "service.js": serviceJs("broken"), bin: "#!/bin/sh\n" },
      /bin is not a folder/,
    ],
    [
      "has a skill folder with no SKILL.md",
      { "service.js": serviceJs("broken"), "skill/notes.md": "x" },
      /no SKILL\.md/,
    ],
  ];

  it.each(cases)("is skipped and logged when it %s; the others still load", async (_what, files, reason) => {
    const root = makeRoot({ broken: files, good: { "service.js": serviceJs("good") } });
    const log = vi.fn();
    const { services, skipped } = await discoverServices(root, log);
    expect(services.map((s) => s.def.name)).toEqual(["good"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].folder).toBe("broken");
    expect(skipped[0].reason).toMatch(reason);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('service "broken" skipped'),
      expect.objectContaining({ operation: "agent_services_service_skipped", service: "broken" }),
    );
  });

  it("is skipped when a script is a symlink (it would never be pushed)", async () => {
    const root = makeRoot({ broken: { "service.js": serviceJs("broken"), "real/x": { exec: "#!/bin/sh\n" } } });
    fs.mkdirSync(path.join(root, "broken", "bin"));
    fs.symlinkSync(path.join(root, "broken", "real", "x"), path.join(root, "broken", "bin", "x"));
    const { services, skipped } = await discoverServices(root, () => {});
    expect(services).toEqual([]);
    expect(skipped[0].reason).toMatch(/bin\/x is a symlink/);
  });

  it("ignores hidden files like .DS_Store in skill/ and bin/", async () => {
    const root = makeRoot({
      tidy: {
        "service.js": serviceJs("tidy"),
        "skill/SKILL.md": "x",
        "skill/.DS_Store": "junk",
        "bin/tidy": { exec: "#!/bin/sh\n" },
        "bin/.DS_Store": "junk",
      },
    });
    const { services, skipped } = await discoverServices(root, () => {});
    expect(skipped).toEqual([]);
    expect(serviceCatalogRows(services).map((r) => r.installPath)).toEqual([
      "~/.claude/skills/tidy/SKILL.md",
      "~/.local/bin/tidy",
    ]);
  });

  it("is skipped when its folder name isn't kebab-case", async () => {
    const root = makeRoot({ Bad_Name: { "service.js": serviceJs("Bad_Name") } });
    const { services, skipped } = await discoverServices(root, () => {});
    expect(services).toEqual([]);
    expect(skipped[0].reason).toMatch(/kebab-case/);
  });

  it("can't overwrite a fleet file: a colliding row is dropped and logged", () => {
    const log = vi.fn();
    const full = combineCatalog(
      FLEET_SUBSTRATE_CATALOG,
      [
        {
          slug: "id-skill",
          sourceKind: "bundled",
          bundledPath: "/x/SKILL.md",
          installPath: "~/.claude/skills/id/SKILL.md",
          restartHook: null,
        },
      ],
      log,
    );
    expect(full.length).toBe(FLEET_SUBSTRATE_CATALOG.length);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("already in use"),
      expect.objectContaining({ operation: "agent_services_row_collision" }),
    );
  });
});
