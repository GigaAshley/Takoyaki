# Agent services

An agent service is something an agent on a managed host asks the Skynet
backend to do for it, using credentials only the backend holds: place a phone
call, generate an image, and so on. Agents never see the keys. They drop a
request file on their own host, and the backend picks it up over SSH, does the
work, and writes the answer back next to it.

```
host: ~/fleet/service-requests/            backend
  agent ──fleet-service──▶ <uuid>.json ──scan (10s)──▶ engine ──▶ service.handle()
  agent ◀── result ── <uuid>.response.json ◀──SSH write── engine ◀──┘
```

Services today: `agent-phone` (Twilio calls), `image-gen` (OpenAI
gpt-image-1.5), `stt` (speech to text, with its own provider). Admins run
them from **Admin → Services**: keys, settings, which machines may use each
one, usage and errors (`admin/`).

Identity reactivate (`src/backend/matrix/identity-reactivate.ts`) rides the
same request files but is not a service: it's the app's own machinery (the
agent-supervisor asks it to bring an archived agent's chat account back). The
engine answers it as a core handler, for every machine, never switched,
listed or recorded. Identity births (`spawn-requests/`) predate this and
still have their own scanner.

## Layout

| Path                          | What it is                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `engine/types.ts`             | The service contract: `defineService`, `ok`, `fail`                          |
| `engine/protocol.ts`          | Wire format: scan command, envelope, filenames                               |
| `engine/engine.ts`            | Validation, queueing, TTL, secrets, rate limits, responses                   |
| `engine/queue.ts`             | Per-service queue (concurrency plus optional serialization key)              |
| `engine/host-io.ts`           | Claim and attachment reads over SSH or the local bind mount; response writer |
| `engine/scan-orchestrator.ts` | The one scan loop over every substrate host                                  |
| `boot.ts`                     | Wiring, called from `starter.ts`                                             |
| `registry.ts`                 | Finds the services by reading `services/`                                    |
| `distribution.ts`             | Turns each service's `skill/` and `bin/` into distributor rows               |
| `services/<name>/`            | One service each: everything about it lives in its folder                    |
| `user-secrets/`               | Per-person keys: encrypted store, acting-user resolution                     |
| `admin/key-store.ts`          | Where instance keys live (swappable; the database today), encrypted          |
| `admin/settings-store.ts`     | Services' settings (e.g. which provider)                                     |
| `admin/grants.ts`             | Which machines each service is switched on for (none, until an admin says)   |
| `admin/usage.ts`              | One record per answer (no content), for state, usage and recent errors       |
| `admin/upgrade.ts`            | The one-time move of service keys out of the server settings                 |
| `admin/routes.ts`             | Admin → Services' routes (`/users/admin/services…`)                          |

Host side: `substrate/scripts/fleet-service` is the shared client every
service's wrapper calls. It belongs to no service, so it stays in the
general substrate.

## A service is one folder

```
services/<name>/
  service.ts        default-exports defineService({ name: "<name>", ... })
  skill/SKILL.md    optional: tells agents when and how to use it
  skill/...         optional companions, installed beside SKILL.md
  bin/<command>     optional: friendly wrapper over fleet-service (executable)
  *.ts              anything else the service needs (adapters, tests)
```

- **The server finds it.** `registry.ts` loads every folder under
  `services/`. Nothing else in the app lists services.
- **Switched-on machines get its skill and wrapper.** The distributor pushes
  `skill/` to `~/.claude/skills/<name>/` and each file in `bin/` to
  `~/.local/bin/<file>` on every machine the service is switched on for,
  next to its hand-kept catalog (`src/backend/distributor/full-catalog.ts`),
  and removes them from the rest. Requests from a machine it isn't switched
  on for are refused with `not_enabled`. Every service starts off on every
  machine. The backend build copies these files beside the compiled code
  (`scripts/copy-service-assets.mjs`).
- **A broken folder is skipped, never fatal.** Examples: no `service.ts`,
  a `name` that isn't the folder name, a script that isn't executable, a
  key without a label. The server starts without that service and logs
  `agent_services_service_skipped` with the reason. `registry.test.ts`
  fails on any broken folder in the repo, so one shouldn't ship.
- **A service's keys are its own.** An admin sets them in Admin → Services;
  they are never read from the environment. A service never shares a key or
  a setting with the app's own voice features: an operator who wants one
  account behind both enters it in both places. (`stt` runs through the
  voice STT code with its own setup, and agent-phone transcribes replies
  with `stt`'s setup.)
- **Wrapper headers say `substrate/scripts/<name>`.** That's where the
  wrappers used to live. Leave the line alone: changing a wrapper's bytes
  re-pushes it to every host.

## Adding a service

Say you want agents to be able to send an SMS through Twilio.

**1. Backend: `services/sms/service.ts`**

```ts
import { z } from "zod";
import { defineService, fail, ok } from "../../engine/types.js";

export default defineService({
  name: "sms",
  title: "Text messages",
  description: "Text a Skynet user",
  input: z.strictObject({
    to_user: z.string().min(1).max(200),
    body: z.string().min(1).max(1600),
  }),
  secrets: {
    TWILIO_ACCOUNT_SID: {
      label: "Twilio account SID",
      description: "Twilio console → Account info (starts with AC)",
    },
    TWILIO_AUTH_TOKEN: {
      label: "Twilio auth token",
      description: "Twilio console → Account info",
    },
  },
  // Twilio's own trouble, so Admin → Services shows the service as failing.
  faultCodes: ["provider_error"],
  ttlMs: 2 * 60 * 1000,
  concurrency: 4,

  async handle(input, ctx) {
    // ctx.secrets.TWILIO_AUTH_TOKEN, ctx.host.idNum (who's asking), ctx.log
    const res = await sendSms(ctx.secrets, input);
    if (!res.ok) return fail("provider_error", res.message);
    return ok({ sid: res.sid });
  },
});
```

That's the service: the server picks it up on its next start, and it shows
in Admin → Services, off on every machine, until an admin sets its keys and
switches it on.

**2. Host side.** Agents can call it right away with the shared client:

```
fleet-service call sms --input '{"to_user":"alice","body":"Deploy done"}'
```

For a nicer interface, add a wrapper at `services/sms/bin/sms` (copy
`services/agent-phone/bin/agent-phone`; it's about 40 lines past the usage
text; make it executable) and a skill at `services/sms/skill/SKILL.md`. The
distributor installs both on every managed host. There is nothing to
register, and nothing to document elsewhere: each key's label and note in
`secrets` say what it is and where to get it, in Admin → Services.

**3. Test it.** Call `handle()` directly with a fake context (see
`services/agent-phone/service.test.ts`). `end-to-end.test.ts` shows how to
drive a real wrapper script against the real engine.

### What the contract gives you

| Field                | Effect                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`              | Zod schema. Failures go back as `malformed` with the field path. Use `z.strictObject` so typos are caught.                                                                       |
| `attachments`        | Named file slots (`{ ref: { extensions, maxBytes, required? } }`). The agent sends them with `--attach ref=path`; the handler gets `ctx.attachments.ref.bytes`.                  |
| `title`              | What an admin calls it in Admin → Services ("Text messages").                                                                                                                     |
| `secrets`            | Instance keys, `{ NAME: { label, description, neededWhen? } }`: the label an admin recognises and one line on where to get it. Set in Admin → Services, never read from the environment. A needed one unset → `not_configured`, handler not called. `neededWhen(settings)` makes a key needed only for some settings (stt: only the chosen provider's). |
| `settings`           | Admin choices, `{ name: { label, description, options, default?, required? } }`. The handler gets `ctx.settings`; a required one unset → `not_configured`.                       |
| `faultCodes`         | Failure codes that mean the service itself is at fault (rejected key, provider down), so Admin → Services shows it failing until the next success. `internal` always counts.   |
| `userSecrets`        | Per-person keys (see below). The handler gets `ctx.user` and `ctx.userSecrets`.                                                                                                  |
| `ttlMs`              | Requests older than this when they reach the front of the queue → `expired`. Keep it at or under the wrapper's timeout so the backend never does work for a caller that gave up. |
| `concurrency`        | Max simultaneous requests for this service (default 1).                                                                                                                          |
| `serializeBy`        | Requests with the same key never overlap (agent-phone: one call per recipient).                                                                                                  |
| `rateLimitPerMinute` | Fleet-wide token bucket, read once at boot.                                                                                                                                      |
| `maxQueueDepth`      | Pending cap (default 1000) → `queue_full`.                                                                                                                                       |

Return `ok(result, files?)` or `fail(code, message?, details?)`. Output files
(`{ ext, bytes }`) are written to the host before the response and moved by
the client to `--out-dir`. If `handle()` throws, the agent gets `internal`.

`ctx.host.idNum` is the requesting host's row id. Use it for permission
checks, as agent-phone does with `userHasRegisteredHost`. The backend knows
which host a request came from because it read the file off that host itself;
there is no credential for an agent to forge.

## Per-person keys

Some services need a key per person rather than one for the whole instance:
a company-issued Zoho token, say. Declare them on the service:

```ts
export default defineService({
  name: "zoho",
  title: "Zoho CRM",
  description: "Read and update Zoho CRM records",
  input: z.strictObject({ query: z.string() }),
  userSecrets: {
    ZOHO_TOKEN: { label: "Zoho API token" },
  },
  ttlMs: 2 * 60 * 1000,
  async handle(input, ctx) {
    // ctx.user = { id, username }; ctx.userSecrets.ZOHO_TOKEN is theirs
  },
});
```

That's all the service does. The rest is automatic:

- **Admins only.** An admin sets, replaces or removes each person's key in
  Admin → Services, on the service's page. People never see or set their
  own; there is no user-facing screen or route for it.
- **Storage.** `agent_service_user_secrets`, encrypted with the backend's
  system key (not the user's login-derived key) so agents can use it while
  the user is logged out. Each value is bound to its user, service and name.
- **Write-only everywhere.** No route returns a value, to admins either. The
  panel shows "Set · updated <date>" and offers Replace and Remove.
- **`fallbackKey`.** Optional: one of the service's own instance keys used
  for people with no value of their own (a company-wide default). Declare it
  in `secrets` with `neededWhen: () => false`.
- **Missing value.** The agent gets `no_user_secret`, with a message saying
  an admin can set it in Admin → Services.

### Whose request is it?

A request comes from a host, not a person, so for services with
`userSecrets` the engine works out who it acts for. The candidates are the
host's registrants: everyone with a host row for the same machine.

- `fleet-service call zoho --as alice ...` acts for `alice` if she
  registered this host (`not_permitted` if not, `unknown_user` if there's
  no such user). Agents on a shared host may act for any of its
  registrants, the same trust agent-phone uses for who it may call.
- Without `--as`, a host with a single registrant acts for that person.
- Without `--as` on a shared host, the agent gets `ambiguous_user` naming the
  registrants, and retries with `--as`.

Wrapper scripts for such services should pass `--as` through (e.g. an
`--as` flag or an `AS_USER` env var) and the skill should tell agents when
to use it.

## Wire protocol

All files live in `~/fleet/service-requests/` on the host.

| File                     | Written by                | Meaning                                                                                   |
| ------------------------ | ------------------------- | ----------------------------------------------------------------------------------------- |
| `<uuid>.in.<slot>.<ext>` | agent, first              | Attachment                                                                                |
| `<uuid>.json`            | agent, atomically         | Request: `{service, requested_at, input, attachments?, as_user?}`                         |
| `<uuid>.claimed.json`    | backend (rename)          | Accepted; the agent can tell "queued" from "nobody home"                                  |
| `<uuid>.out.<i>.<ext>`   | backend                   | Output files                                                                              |
| `<uuid>.response.json`   | backend, atomically, last | `{ok:true, service, result, files}` or `{ok:false, service, error:{code, message?, ...}}` |

The client removes every `<uuid>.*` file when it exits, including on a
signal, so an abandoned request is never picked up later. The scan deletes
leftovers older than a day.

Error codes any service can return, from the engine: `malformed`,
`unknown_service`, `not_enabled` (not switched on for this machine),
`expired`, `queue_full`, `not_configured` (a key or required setting
missing), `internal`;
for services with `userSecrets`, also `ambiguous_user`, `unknown_user`,
`not_permitted` and `no_user_secret`.
From the client: `not_picked_up` (never claimed) and `timeout` (claimed, no
answer in time).

## Why file drops rather than HTTP or MCP

- **No host credential.** The backend reaches into hosts it already trusts
  over SSH. An HTTP endpoint would need a per-host token, readable by the
  same processes that can write `~/fleet/` today.
- **Long requests.** A phone call takes minutes. File drops are already
  asynchronous and survive a backend restart without a job-id API.
- **Agents can debug it.** A skill plus a script is readable; an agent can
  look in the folder, rerun with `bash -x`, and work around problems. An MCP
  tool is a black box to it.

If an MCP server or HTTP transport is ever wanted, it can sit in front of the
same engine and schemas without changing any service.
