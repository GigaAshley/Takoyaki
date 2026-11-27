# Agent services

An agent service is something an agent on a managed host asks the Skynet
backend to do for it, using credentials only the backend holds: place a phone
call, generate an image, and so on. Agents never see the keys. The agent's
command sends the request straight to the backend, which does the work and
answers on the same connection.

```
host                                          backend (/agent-services)
  agent ──fleet-service── POST jobs/<id> ──▶ credential → machine ──▶ engine ──▶ service.handle()
  agent ◀── result ────── 200 answer ◀────── job store ◀──────────────────────┘
                          (202 "running" → GET jobs/<id> until the answer)
```

The request goes to the app's own address (`~/fleet/host/parent`, which the
distributor already writes), with the machine's credential
(`~/fleet/host/service-credential`, which the backend writes). A quick call
costs one round trip, tens of milliseconds.

Services today: `agent-phone` (Twilio calls), `image-gen` (OpenAI
gpt-image-1.5), `stt` (speech to text, with its own provider). Admins run
them from **Admin → Services**: keys, settings, which machines may use each
one, usage and errors (`admin/`).

Identity reactivate (`src/backend/matrix/identity-reactivate.ts`) rides the
same requests but is not a service: it's the app's own machinery (the
agent-supervisor asks it to bring an archived agent's chat account back). The
engine answers it as a core handler, for every machine, never switched,
listed or recorded. Identity births (`spawn-requests/`) predate this and
still have their own scanner.

## Layout

| Path                          | What it is                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `engine/types.ts`             | The service contract: `defineService`, `ok`, `fail`                          |
| `engine/protocol.ts`          | Wire format: request, attachments, answer                                    |
| `engine/engine.ts`            | Validation, queueing, TTL, secrets, rate limits, answers                     |
| `engine/queue.ts`             | Per-service queue (concurrency plus optional serialization key)              |
| `engine/jobs.ts`              | Requests by their caller's ID: join, wait, keep the answer, forget           |
| `http/routes.ts`              | `/agent-services/v1`: where machines send requests (mounted in database.ts)  |
| `http/production.ts`          | That router wired to the real stores; which host row a machine runs as       |
| `machine-credentials/`        | Each machine's credential: issue, daily replacement, revoke, delivery        |
| `boot.ts`                     | Wiring, called from `starter.ts`                                             |
| `registry.ts`                 | Finds the services by reading `services/`                                    |
| `distribution.ts`             | Turns each service's `skill/` and `bin/` into distributor rows               |
| `services/<name>/`            | One service each: everything about it lives in its folder                    |
| `user-secrets/`               | Per-person keys: encrypted store, acting-user resolution                     |
| `admin/key-store.ts`          | The key store contract, and the encrypted database store                     |
| `admin/parameter-store.ts`    | The AWS Parameter Store key store: cache, outage fallback, refusals          |
| `admin/choose-store.ts`       | Picks the store from the server settings at start                            |
| `admin/settings-store.ts`     | Services' settings (e.g. which provider)                                     |
| `admin/grants.ts`             | Which machines each service is switched on for (none, until an admin says)   |
| `admin/usage.ts`              | One record per answer (no content), for state, usage and recent errors       |
| `admin/overview.ts`           | What Admin → Services shows, including each machine's credential state       |
| `admin/orphaned-grants.ts`    | Start-up warning for switches left on for machines that no longer exist      |
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
  they are never read from the environment, and nothing carries them over
  from it. A service never shares a key or
  a setting with the app's own voice features: an operator who wants one
  account behind both enters it in both places. (`stt` runs through the
  voice STT code with its own setup, and agent-phone transcribes replies
  with `stt`'s setup.)
- **Keys live in the database or in AWS Parameter Store**, as the instance
  chooses in its server settings (see below). Services never know which.
- **Wrapper headers say `substrate/scripts/<name>`.** That's where the
  wrappers used to live. Leave the line alone: changing a wrapper's bytes
  re-pushes it to every host.

## Where instance keys live

Set in the server settings (`skynet.env`):

- **Neither setting: the database**, encrypted under the instance's system
  key.
- **`AGENT_SERVICES_PARAMETER_STORE_PATH` and
  `AGENT_SERVICES_PARAMETER_STORE_KMS_KEY`: AWS Parameter Store.** Each key
  is a SecureString at `<path>/<service>/<KEY_NAME>`, always encrypted with
  the named KMS key (never AWS's default `aws/ssm` key: naming it as
  `alias/aws/…` is refused at start; named by its key id it can't be told
  apart, so don't). The operator sets
  up the path, the key and who may use them. The machine's role needs
  `ssm:GetParameters`, `ssm:PutParameter` and `ssm:DeleteParameter` on the
  path, plus `kms:Decrypt`, `kms:Encrypt` and `kms:GenerateDataKey` on the
  key. `AGENT_SERVICES_AWS_REGION` defaults to `us-east-1`.
  - Writing is required. A write AWS refuses is reported in the panel with
    the permission it needs.
  - Values are cached. Panel changes take effect at once. A change made
    directly in AWS is picked up within an hour.
  - While AWS can't be reached, the last value read is served; a key never
    read fails the request, and the panel says AWS can't be reached.
- **Only one of the two, or a path Parameter Store won't take:** a setup
  mistake. Keys are neither read nor saved anywhere until it's fixed, and
  the panel says what's wrong.

Switching stores moves nothing: keys in the old store are ignored, and an
admin enters them again. Per-person keys always stay in the database.

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
| `uses`               | Other services whose setup this one relies on (agent-phone: `["stt"]`, to transcribe replies). Admin → Services lists one that isn't set up as missing. Requests aren't refused over it. |
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

## Machine credentials

Each machine (`hosts.machine_id`, or the row id for a row without one) has
one credential, shared by every login and agent on it. It says which machine
is asking and nothing else; each entry point decides what a machine may do,
and today the only one is service calls. Requests run as the machine's
lowest-numbered host row set to run agents, and every person registered on
any of the machine's rows counts as one of its registrants.

- **Issued and delivered by the backend.** Every 30 seconds
  (`machine-credentials/delivery.ts`) each agent host gets its machine's
  credential written to `~/fleet/host/service-credential`, mode 600, when it
  differs from what was last written there. It travels on the write
  command's input, never its command line. A host that can't be reached is
  retried with back-off, a few hosts at a time. No person ever sees or types
  one.
- **Replaced daily.** The replaced one keeps working for ten minutes so calls
  in flight finish.
- **Stored** encrypted under the system key (so it can be written to a login
  that missed a delivery), and checked by its SHA-256. No route returns it.
- **Revoke** (Admin → Services → Machines) cuts the machine off from every
  service; its calls get `revoked`. Only **Issue new** brings it back, and
  it asks the admin to confirm it's them. Nothing automatic ever overwrites
  a revoke: issuing and daily replacement only land on an unrevoked row.
- **A machine that stops running agents** loses its credential, unless it
  was revoked: that stays in force if the machine is set up again.

## Wire protocol

`fleet-service` talks to `<app address>/agent-services/v1` with
`Authorization: Bearer <machine credential>`:

| Call                          | Meaning                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST /jobs/<id>`             | Start the request, multipart: `request` = `{service, input, as_user?}`, `attachment.<slot>` = a file  |
| `GET /jobs/<id>`              | Wait for its answer                                                                                    |
| `GET /jobs/<id>/files/<i>`    | One output file                                                                                        |
| `DELETE /jobs/<id>`           | The caller has the answer; drop it                                                                     |

`<id>` is a UUID the caller picks (`fleet-service call --id`). The same ID
again on the same machine joins the existing request instead of running it
twice. A wait holds up to 50 seconds (less with `?wait=<seconds>`): `200` with
the answer, or `202 {state:"running"}`, after which the client asks again.
The answer is `{ok:true, service, result, files:[{ext, size}]}` or
`{ok:false, service, error:{code, message?, ...}}`. Finished answers are kept
until collected, or an hour (the oldest go early past 128 MB or 10,000 of
them); jobs live in memory only, so after a restart an
ID is `lost` (404), and is never run again on the caller's behalf.
`fleet-service collect <id>` waits for an answer without ever sending the
request again.

The client sends a request again only while the backend clearly hasn't taken
it (no connection, or `503 starting`); once it may have it, it only asks by
ID.

Attachments are refused while they upload unless the service has their
slot, and queued requests hold at most 256 MB of attachments between them
(past that, `queue_full`), so a burst can't exhaust a small host's memory.

Error codes any service can return, from the engine: `malformed`,
`unknown_service`, `not_enabled` (not switched on for this machine),
`expired`, `queue_full`, `not_configured` (a key or required setting
missing), `internal`;
for services with `userSecrets`, also `ambiguous_user`, `unknown_user`,
`not_permitted` and `no_user_secret`.
From the door: `unauthorized` (a credential the backend didn't issue, or a
replaced one past its grace), `revoked`, `lost`, `starting`.
From the client: `unreachable` (couldn't reach the backend), `not_set_up`
(no credential or address on the machine yet) and `timeout` (accepted, no
answer in time; `collect <id>` gets it later).

## Why direct requests

- **Speed.** A request reaches the backend at once, and a quick one costs a
  round trip. The file drop waited for a ten-second scan, which made bursts of
  small calls (a database service's opening queries) take over a minute.
- **The answer survives the caller.** It's kept by ID, so a command that died
  or timed out can collect it.
- **Same trust.** The file drop's identity came from the backend reading the
  machine's own folder. The credential gives the same: anything on the machine
  that could write that folder can read the credential, and nothing off the
  machine gets it. It's revocable, replaced daily, and good only for service
  calls.

Machines already reach the instance (every agent logs into its chat server),
and the app's address reaches the backend over the instance's private
network.
