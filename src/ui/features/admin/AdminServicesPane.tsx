/**
 * Admin → Services: every backend service agents can use, and whether it's
 * working. A service opens one level deeper, where an admin:
 *   - picks its settings (e.g. speech to text's provider);
 *   - sets, replaces or removes its keys (never shown back);
 *   - switches it on or off per machine (a machine switched off loses the
 *     service's skill and has its requests refused);
 *   - sees its usage and recent errors over the last 30 days;
 *   - sets each person's key, for services that need one per person.
 * Backing routes: src/backend/agent-services/admin/routes.ts.
 */

import { useCallback, useEffect, useState } from "react";
import {
  getAgentService,
  listAgentServices,
  removePersonKey,
  removeServiceKey,
  setPersonKey,
  setServiceKey,
  setServiceMachine,
  setServiceSetting,
  type KeyStoreInfo,
  type ServiceDetail,
  type ServiceState,
  type ServiceSummary,
} from "@/api/agent-services-admin-api";
import {
  KitBanner,
  KitChip,
  KitEmpty,
  KitLoading,
  KitSelect,
  KitSettingsGroup,
  KitSettingsRow,
  KitSwitch,
} from "@/components/kit";
import { AdminBack, adminErrorMessage, formatAdminDate, relativeAdminTime, useEscBack } from "./admin-ui";
import { ServiceKeyRow } from "./ServiceKeyRow";

const STATE_CHIP: Record<ServiceState, { text: string; tone: "warn" | "ok" | "danger" }> = {
  not_set_up: { text: "Not set up", tone: "warn" },
  ready: { text: "Ready", tone: "ok" },
  failing: { text: "Failing", tone: "danger" },
};

function StateChip({ state, testId }: { state: ServiceState; testId?: string }) {
  const c = STATE_CHIP[state];
  return (
    <KitChip tone={c.tone} dot data-testid={testId}>
      {c.text}
    </KitChip>
  );
}

/** Error codes an admin reads, in words; anything else shows as the code. */
const CODE_WORDS: Record<string, string> = {
  not_enabled: "not switched on for that machine",
  not_configured: "not set up",
  malformed: "a bad request",
  expired: "waited too long in the queue",
  queue_full: "too busy",
  internal: "an error in the server",
  provider_unavailable: "the provider was down or busy",
  provider_rejected: "the provider rejected the key",
  rate_limited: "the provider's rate limit",
  placement_error: "the call couldn't be placed",
  queue_error: "the call couldn't be connected",
  timeout: "took too long",
};
const codeWords = (code: string | null) => (code ? (CODE_WORDS[code] ?? code) : "unknown");

export function AdminServicesPane({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (name: string | null) => void;
}) {
  return selected ? (
    <AdminServiceView key={selected} name={selected} onBack={() => onSelect(null)} />
  ) : (
    <AdminServicesList onOpen={onSelect} />
  );
}

/** Where keys live, and whether that store can be used right now. */
function KeyStoreLine({ store }: { store: KeyStoreInfo }) {
  if (store.problem) {
    return (
      <KitBanner tone="danger" data-testid="admin-services-store">
        Keys can't be read or saved: {store.problem}
      </KitBanner>
    );
  }
  if (store.unreachableSince) {
    return (
      <KitBanner tone="warn" data-testid="admin-services-store">
        {store.label} hasn't answered since {formatAdminDate(store.unreachableSince)}. Services keep using the keys
        last read; this shows what was last read.
      </KitBanner>
    );
  }
  return (
    <p className="text-[13px] text-[var(--k-t3)]" data-testid="admin-services-store">
      Keys are kept in {store.label}.
    </p>
  );
}

function AdminServicesList({ onOpen }: { onOpen: (name: string) => void }) {
  const [data, setData] = useState<{ keyStore: KeyStoreInfo; services: ServiceSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAgentServices()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(adminErrorMessage(err, "Failed to load services.")));
  }, []);

  if (error) return <KitBanner tone="danger" data-testid="admin-services-error">{error}</KitBanner>;
  if (!data) return <KitLoading label="Loading services…" />;
  if (data.services.length === 0) {
    return <KitEmpty title="No services" body="This instance offers no backend services to agents." />;
  }
  const now = Date.now();
  return (
    <div className="flex flex-col gap-5" data-testid="admin-services-list">
      <KeyStoreLine store={data.keyStore} />
      <KitSettingsGroup
        footer="A service is off on every machine until you switch it on. Keys are kept encrypted and can never be read back."
      >
        {data.services.map((s) => (
          <KitSettingsRow
            key={s.name}
            label={s.title}
            description={
              s.state === "not_set_up"
                ? `Needs ${s.missing.join(", ")}`
                : s.keyProblem
                ? s.keyProblem
                : `On for ${s.machinesOn} of ${s.machinesTotal} machine${s.machinesTotal === 1 ? "" : "s"}${
                    s.lastUsedAt ? ` · last used ${relativeAdminTime(s.lastUsedAt, now)}` : ""
                  }`
            }
            control={<StateChip state={s.state} testId={`admin-service-state-${s.name}`} />}
            onClick={() => onOpen(s.name)}
            data-testid={`admin-service-row-${s.name}`}
          />
        ))}
      </KitSettingsGroup>
    </div>
  );
}

function AdminServiceView({ name, onBack }: { name: string; onBack: () => void }) {
  const [data, setData] = useState<{ keyStore: KeyStoreInfo; service: ServiceDetail } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  useEscBack(true, onBack);

  const load = useCallback(async () => {
    try {
      setData(await getAgentService(name));
      setError(null);
    } catch (err) {
      setError(adminErrorMessage(err, "Failed to load the service."));
    }
  }, [name]);
  useEffect(() => {
    void load();
  }, [load]);

  /** Run a change, then reload; a failure shows above the page. */
  const act = async (fn: () => Promise<void>, what: string) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(adminErrorMessage(err, `Failed to ${what}.`));
    }
    await load();
  };

  const back = <AdminBack label="Services" onBack={onBack} testId="admin-service-back" />;
  if (error) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <KitBanner tone="danger">{error}</KitBanner>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <KitLoading label="Loading…" />
      </div>
    );
  }

  const { service: s, keyStore } = data;
  const now = Date.now();
  // Keys this setup uses, plus any others still set (so they can be removed).
  const keys = s.keys.filter((k) => k.needed || k.isSet);

  return (
    <div className="flex flex-col gap-5" data-testid={`admin-service-view-${s.name}`}>
      <div className="flex flex-col gap-1.5">
        {back}
        <div className="flex items-center gap-2.5 flex-wrap">
          <h2 className="text-[20px] font-semibold text-[var(--k-t1)]">{s.title}</h2>
          <StateChip state={s.state} testId="admin-service-state" />
        </div>
        <p className="text-[13.5px] text-[var(--k-t2)]">{s.description}</p>
        {s.state === "not_set_up" && (
          <p className="text-[13px] text-[var(--k-warn)]">Needs {s.missing.join(", ")} before agents can use it.</p>
        )}
        {s.keyProblem && (
          <p className="text-[13px] text-[var(--k-danger-text)]" data-testid="admin-service-key-problem">
            {s.keyProblem}
          </p>
        )}
        {s.state === "failing" && !s.keyProblem && s.lastFault && (
          <p className="text-[13px] text-[var(--k-danger-text)]" data-testid="admin-service-fault">
            Last failed {relativeAdminTime(s.lastFault.at, now)}: {codeWords(s.lastFault.code)}. It clears with the next
            request that works.
          </p>
        )}
      </div>

      {actionError && <KitBanner tone="danger">{actionError}</KitBanner>}
      <KeyStoreLine store={keyStore} />

      {s.settings.length > 0 && (
        <KitSettingsGroup title="Settings" data-testid="admin-service-settings">
          {s.settings.map((setting) => (
            <KitSettingsRow
              key={setting.name}
              label={setting.label}
              description={setting.description}
              control={
                <KitSelect
                  size="sm"
                  aria-label={setting.label}
                  data-testid={`admin-service-setting-${setting.name}`}
                  value={setting.value}
                  onChange={(e) =>
                    void act(() => setServiceSetting(s.name, setting.name, e.target.value), "save the setting")
                  }
                >
                  {!setting.value && <option value="">Choose…</option>}
                  {setting.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </KitSelect>
              }
            />
          ))}
        </KitSettingsGroup>
      )}

      {keys.length > 0 && (
        <KitSettingsGroup title="Keys" footer="Saved keys can't be viewed, only replaced or removed." data-testid="admin-service-keys">
          <div className="flex flex-col px-3.5">
            {keys.map((k) => (
              <ServiceKeyRow
                key={k.name}
                id={`${s.name}-${k.name}`}
                label={k.label}
                description={k.description}
                isSet={k.isSet}
                updatedAt={k.updatedAt}
                chip={k.needed ? undefined : { text: "Not used with these settings", tone: "neutral" }}
                removeBody={`${s.title} stops working until a new one is saved.`}
                onSave={async (value) => {
                  await setServiceKey(s.name, k.name, value);
                  await load();
                }}
                onClear={async () => {
                  await removeServiceKey(s.name, k.name);
                  await load();
                }}
              />
            ))}
          </div>
        </KitSettingsGroup>
      )}

      <KitSettingsGroup
        title="Machines"
        footer="Switched on: the machine's agents get the service's skill within a minute. Switched off: the skill is removed and requests are refused."
        data-testid="admin-service-machines"
      >
        {s.machines.length === 0 ? (
          <KitSettingsRow label="No machines run agents yet" />
        ) : (
          s.machines.map((m) => (
            <KitSettingsRow
              key={m.machineId}
              label={m.name}
              description={m.unreachableSince ? `Not reachable since ${relativeAdminTime(m.unreachableSince, now)}` : undefined}
              control={
                <KitSwitch
                  checked={m.enabled}
                  aria-label={`${s.title} on ${m.name}`}
                  data-testid={`admin-service-machine-${m.machineId}`}
                  onCheckedChange={(on) =>
                    void act(() => setServiceMachine(s.name, m.machineId, on), "switch the machine")
                  }
                />
              }
            />
          ))
        )}
      </KitSettingsGroup>

      <KitSettingsGroup
        title="Recent activity"
        note={
          s.usage.requests === 0
            ? "No requests in the last 30 days."
            : `${s.usage.requests} request${s.usage.requests === 1 ? "" : "s"} in the last 30 days, ${s.usage.failed} failed.`
        }
        data-testid="admin-service-usage"
      >
        {s.usage.byMachine.map((m) => (
          <KitSettingsRow
            key={m.machineId}
            label={m.name}
            description={`Last ${relativeAdminTime(m.lastAt, now)}`}
            value={`${m.requests}${m.failed ? ` · ${m.failed} failed` : ""}`}
          />
        ))}
        {s.usage.recentErrors.length > 0 && (
          <div className="flex flex-col gap-1 px-3.5 py-2.5 border-t border-[var(--k-hair)]" data-testid="admin-service-errors">
            <span className="text-[12.5px] font-[550] text-[var(--k-t2)]">Recent errors</span>
            {s.usage.recentErrors.map((e, i) => (
              <span key={i} className="text-[12.5px] text-[var(--k-t3)]">
                {relativeAdminTime(e.at, now)} · {e.name} · {codeWords(e.code)}
              </span>
            ))}
          </div>
        )}
      </KitSettingsGroup>

      {s.personKeys && (
        <KitSettingsGroup
          title="People's keys"
          footer="Each person's agents use their own key. Only admins can set them, and people never see them."
          data-testid="admin-service-people"
        >
          <div className="flex flex-col px-3.5">
            {s.personKeys.people.flatMap((p) =>
              s.personKeys!.keys.map((k) => (
                <ServiceKeyRow
                  key={`${p.userId}-${k.name}`}
                  id={`${s.name}-${p.userId}-${k.name}`}
                  label={`${p.username} · ${k.label}`}
                  description={k.description}
                  isSet={p.set[k.name] !== null}
                  updatedAt={p.set[k.name]}
                  unsetNote={k.hasFallback ? "the default key is used" : undefined}
                  removeBody={`${p.username}'s agents will no longer be able to use it.`}
                  onSave={async (value) => {
                    await setPersonKey(s.name, p.userId, k.name, value);
                    await load();
                  }}
                  onClear={async () => {
                    await removePersonKey(s.name, p.userId, k.name);
                    await load();
                  }}
                />
              )),
            )}
          </div>
        </KitSettingsGroup>
      )}
    </div>
  );
}
