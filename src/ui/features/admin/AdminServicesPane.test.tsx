/**
 * Admin → Services as an admin drives it: the list with each service's
 * state, one service deeper (settings, keys, machines, activity, people's
 * keys), and back. The API is a small in-memory stand-in for the server, so
 * each change shows up the way the real panel reloads it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServiceDetail } from "@/api/agent-services-admin-api";
import { autoAnswerKitDialogs, __resetKitDialogsForTests } from "@/components/kit";

const server = vi.hoisted(() => ({ services: [] as ServiceDetail[], keys: new Map<string, string>() }));

vi.mock("@/api/agent-services-admin-api", () => {
  const keyStore = { kind: "the database", writable: true };
  const find = (name: string) => server.services.find((s) => s.name === name)!;
  /** Recompute what the server derives: needed keys, missing, state. */
  const derive = (s: ServiceDetail) => {
    const provider = s.settings.find((x) => x.name === "provider")?.value ?? "";
    for (const k of s.keys) {
      if (s.name === "stt") k.needed = k.name === `${provider.toUpperCase()}_API_KEY`;
      k.isSet = server.keys.has(`${s.name}/${k.name}`);
      k.updatedAt = k.isSet ? "2026-11-26T00:00:00Z" : null;
    }
    s.missing = [
      ...s.settings.filter((x) => x.required && !x.value).map((x) => x.label),
      ...s.keys.filter((k) => k.needed && !k.isSet).map((k) => k.label),
    ];
    if (s.missing.length > 0) s.state = "not_set_up";
    else if (s.state === "not_set_up") s.state = "ready";
    s.machinesOn = s.machines.filter((m) => m.enabled).length;
    s.machinesTotal = s.machines.length;
    return s;
  };
  return {
    listAgentServices: vi.fn(async () => ({ keyStore, services: server.services.map((s) => ({ ...derive(s) })) })),
    getAgentService: vi.fn(async (name: string) => ({ keyStore, service: structuredClone(derive(find(name))) })),
    setServiceKey: vi.fn(async (service: string, key: string, value: string) => {
      server.keys.set(`${service}/${key}`, value);
    }),
    removeServiceKey: vi.fn(async (service: string, key: string) => {
      server.keys.delete(`${service}/${key}`);
    }),
    setServiceSetting: vi.fn(async (service: string, setting: string, value: string) => {
      find(service).settings.find((x) => x.name === setting)!.value = value;
    }),
    setServiceMachine: vi.fn(async (service: string, machineId: string, enabled: boolean) => {
      find(service).machines.find((m) => m.machineId === machineId)!.enabled = enabled;
    }),
    setPersonKey: vi.fn(async (service: string, userId: string, key: string) => {
      find(service).personKeys!.people.find((p) => p.userId === userId)!.set[key] = "2026-11-26T00:00:00Z";
    }),
    removePersonKey: vi.fn(),
  };
});

import * as api from "@/api/agent-services-admin-api";
import { AdminServicesPane } from "./AdminServicesPane";

const usage = { sinceAt: "2026-10-27T00:00:00Z", requests: 0, failed: 0, byMachine: [], recentErrors: [] };
const machines = () => [
  { machineId: "1", name: "t1000", enabled: false, unreachableSince: null },
  { machineId: "2", name: "thenasty", enabled: false, unreachableSince: "2026-11-25T10:00:00Z" },
];

function seed() {
  server.keys = new Map([["agent-phone/TWILIO_AUTH_TOKEN", "tok"]]);
  server.services = [
    {
      name: "agent-phone",
      title: "Phone calls",
      description: "Ring a user's phone, speak a message, return their reply",
      state: "failing",
      missing: [],
      lastUsedAt: "2026-11-25T00:00:00Z",
      machinesOn: 0,
      machinesTotal: 0,
      keys: [{ name: "TWILIO_AUTH_TOKEN", label: "Twilio auth token", description: "Twilio console", needed: true, isSet: true, updatedAt: null }],
      settings: [],
      machines: machines(),
      lastFault: { at: "2026-11-25T00:00:00Z", code: "placement_error" },
      usage: {
        ...usage,
        requests: 3,
        failed: 1,
        byMachine: [{ machineId: "1", name: "t1000", requests: 3, failed: 1, lastAt: "2026-11-25T00:00:00Z" }],
        recentErrors: [{ at: "2026-11-25T00:00:00Z", machineId: "1", name: "t1000", code: "placement_error", fault: true }],
      },
      personKeys: null,
    },
    {
      name: "stt",
      title: "Speech to text",
      description: "Transcribe an audio file",
      state: "not_set_up",
      missing: [],
      lastUsedAt: null,
      machinesOn: 0,
      machinesTotal: 0,
      keys: [
        { name: "GROQ_API_KEY", label: "Groq API key", description: "console.groq.com", needed: false, isSet: false, updatedAt: null },
        { name: "MISTRAL_API_KEY", label: "Mistral API key", description: "console.mistral.ai", needed: false, isSet: false, updatedAt: null },
      ],
      settings: [
        {
          name: "provider",
          label: "Provider",
          description: "Who transcribes the audio.",
          options: [
            { value: "bedrock", label: "Amazon" },
            { value: "groq", label: "Groq" },
            { value: "mistral", label: "Mistral" },
          ],
          required: true,
          value: "",
        },
      ],
      machines: machines(),
      lastFault: null,
      usage,
      personKeys: null,
    },
    {
      name: "zoho",
      title: "Zoho",
      description: "CRM",
      state: "ready",
      missing: [],
      lastUsedAt: null,
      machinesOn: 0,
      machinesTotal: 0,
      keys: [],
      settings: [],
      machines: machines(),
      lastFault: null,
      usage,
      personKeys: {
        keys: [{ name: "ZOHO_TOKEN", label: "Zoho token", description: null, hasFallback: false }],
        people: [{ userId: "u-zoey", username: "zoey", set: { ZOHO_TOKEN: null } }],
      },
    },
  ];
}

function Harness() {
  const [selected, setSelected] = useState<string | null>(null);
  return <AdminServicesPane selected={selected} onSelect={setSelected} />;
}

beforeEach(() => {
  seed();
  vi.clearAllMocks();
  __resetKitDialogsForTests();
});

describe("Admin → Services", () => {
  it("lists every service with its state and what it still needs", async () => {
    render(<Harness />);
    const phone = await screen.findByTestId("admin-service-row-agent-phone");
    expect(within(phone).getByText("Phone calls")).toBeTruthy();
    expect(screen.getByTestId("admin-service-state-agent-phone").textContent).toBe("Failing");
    expect(screen.getByTestId("admin-service-state-stt").textContent).toBe("Not set up");
    expect(screen.getByTestId("admin-service-row-stt").textContent).toContain("Needs Provider");
    expect(screen.getByTestId("admin-service-row-agent-phone").textContent).toContain("On for 0 of 2 machines");
  });

  it("sets speech to text up: pick a provider, its key is asked for, save it, and it's ready", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await screen.findByTestId("admin-service-row-stt"));
    await screen.findByTestId("admin-service-view-stt");
    // Nothing picked yet: no key is asked for.
    expect(screen.queryByTestId("admin-service-keys")).toBeNull();

    await user.selectOptions(screen.getByTestId("admin-service-setting-provider"), "groq");
    expect(api.setServiceSetting).toHaveBeenCalledWith("stt", "provider", "groq");
    const input = (await screen.findByTestId("service-key-stt-GROQ_API_KEY-input")) as HTMLInputElement;
    // Only the chosen provider's key.
    expect(screen.queryByTestId("service-key-stt-MISTRAL_API_KEY")).toBeNull();
    expect(screen.getByTestId("admin-service-state").textContent).toBe("Not set up");

    expect(input.type).toBe("password");
    await user.type(input, "gq-secret");
    await user.click(screen.getByTestId("service-key-stt-GROQ_API_KEY-save"));
    expect(api.setServiceKey).toHaveBeenCalledWith("stt", "GROQ_API_KEY", "gq-secret");
    await waitFor(() => expect(screen.getByTestId("admin-service-state").textContent).toBe("Ready"));
    expect(screen.getByTestId("service-key-stt-GROQ_API_KEY-status").textContent).toMatch(/^Set/);
    expect((screen.getByTestId("service-key-stt-GROQ_API_KEY-input") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("gq-secret");
  });

  it("switches a machine on, and says when one can't be reached", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await screen.findByTestId("admin-service-row-agent-phone"));
    const machinesGroup = await screen.findByTestId("admin-service-machines");
    expect(machinesGroup.textContent).toContain("Not reachable since");
    const t1000 = screen.getByTestId("admin-service-machine-1") as HTMLInputElement;
    expect(t1000.checked).toBe(false);
    await user.click(t1000);
    expect(api.setServiceMachine).toHaveBeenCalledWith("agent-phone", "1", true);
    await waitFor(() => expect((screen.getByTestId("admin-service-machine-1") as HTMLInputElement).checked).toBe(true));
  });

  it("shows why a service is failing, and its recent use by machine", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await screen.findByTestId("admin-service-row-agent-phone"));
    expect((await screen.findByTestId("admin-service-fault")).textContent).toContain("the call couldn't be placed");
    const activity = screen.getByTestId("admin-service-usage");
    expect(activity.textContent).toContain("3 requests in the last 30 days, 1 failed.");
    expect(within(activity).getByText("t1000")).toBeTruthy();
    expect(screen.getByTestId("admin-service-errors").textContent).toContain("the call couldn't be placed");
  });

  it("removes a key after asking", async () => {
    const dialogs = autoAnswerKitDialogs({ confirm: true });
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await screen.findByTestId("admin-service-row-agent-phone"));
    await user.click(await screen.findByTestId("service-key-agent-phone-TWILIO_AUTH_TOKEN-remove"));
    expect(dialogs.calls[0].opts.title).toBe("Remove Twilio auth token?");
    expect(api.removeServiceKey).toHaveBeenCalledWith("agent-phone", "TWILIO_AUTH_TOKEN");
    await waitFor(() => expect(screen.getByTestId("admin-service-state").textContent).toBe("Not set up"));
  });

  it("sets a person's key for a service that needs one per person", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await screen.findByTestId("admin-service-row-zoho"));
    const people = await screen.findByTestId("admin-service-people");
    expect(people.textContent).toContain("zoey · Zoho token");
    await user.type(screen.getByTestId("service-key-zoho-u-zoey-ZOHO_TOKEN-input"), "zt");
    await user.click(screen.getByTestId("service-key-zoho-u-zoey-ZOHO_TOKEN-save"));
    expect(api.setPersonKey).toHaveBeenCalledWith("zoho", "u-zoey", "ZOHO_TOKEN", "zt");
    await waitFor(() =>
      expect(screen.getByTestId("service-key-zoho-u-zoey-ZOHO_TOKEN-status").textContent).toMatch(/^Set/),
    );
  });

  it("‹ Services and Esc go back to the list", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await screen.findByTestId("admin-service-row-agent-phone"));
    await user.click(await screen.findByTestId("admin-service-back"));
    await screen.findByTestId("admin-services-list");
    await user.click(screen.getByTestId("admin-service-row-stt"));
    await screen.findByTestId("admin-service-view-stt");
    await user.keyboard("{Escape}");
    await screen.findByTestId("admin-services-list");
  });
});
