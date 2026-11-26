/**
 * agent-services/admin/choose-store.ts — the instance's choice of where
 * service keys live, from the server settings:
 *
 *   AGENT_SERVICES_PARAMETER_STORE_PATH     e.g. /takoyaki/t1000
 *   AGENT_SERVICES_PARAMETER_STORE_KMS_KEY  e.g. alias/fleet-secrets
 *   AGENT_SERVICES_AWS_REGION               optional; us-east-1 like the app's other AWS features
 *
 * Both set: AWS Parameter Store. Neither: the database. Only one, a path
 * Parameter Store won't take, or one of AWS's own KMS keys: a setup
 * mistake. Keys are then neither read nor written anywhere (no quiet
 * fallback to the database) and the panel says what to fix.
 */

import { systemLogger } from "../../utils/logger.js";
import { databaseKeyStore, KeyStoreRefusedError, type InstanceKeyStore } from "./key-store.js";
import { awsParameterStoreClient, createParameterStoreKeyStore, type ParameterStoreClient } from "./parameter-store.js";

export const PATH_SETTING = "AGENT_SERVICES_PARAMETER_STORE_PATH";
export const KMS_KEY_SETTING = "AGENT_SERVICES_PARAMETER_STORE_KMS_KEY";
export const REGION_SETTING = "AGENT_SERVICES_AWS_REGION";
const DEFAULT_REGION = "us-east-1";

type Env = Record<string, string | undefined>;

/** A path Parameter Store accepts as a hierarchy, without a trailing slash; or null. */
export function normalizePath(raw: string): string | null {
  const path = raw.replace(/\/+$/, "");
  if (!/^(\/[A-Za-z0-9_.-]+)+$/.test(path)) return null;
  // AWS reserves names beginning aws or ssm.
  if (/^\/(aws|ssm)/i.test(path)) return null;
  return path;
}

/** A store that can't be used, saying why. */
export function misconfiguredKeyStore(problem: string): InstanceKeyStore {
  const refuse = () => Promise.reject(new KeyStoreRefusedError(problem));
  return {
    info: () => ({ kind: "parameter_store", label: "AWS Parameter Store (not set up correctly)", problem, unreachableSince: null }),
    get: refuse,
    set: refuse,
    remove: refuse,
    status: async (_service, names) => names.map((name) => ({ name, isSet: null, updatedAt: null })),
  };
}

export function chooseKeyStore(
  env: Env = process.env,
  makeClient: (region: string) => ParameterStoreClient = awsParameterStoreClient,
): InstanceKeyStore {
  const rawPath = env[PATH_SETTING]?.trim() ?? "";
  const kmsKeyId = env[KMS_KEY_SETTING]?.trim() ?? "";
  if (!rawPath && !kmsKeyId) return databaseKeyStore;

  let problem: string | null = null;
  if (!rawPath || !kmsKeyId) {
    problem =
      `Parameter Store is only half set up: ${!rawPath ? PATH_SETTING : KMS_KEY_SETTING} is missing from the ` +
      `server settings. Set both ${PATH_SETTING} and ${KMS_KEY_SETTING} to use Parameter Store, or neither to keep ` +
      `keys in the database.`;
  }
  const path = rawPath ? normalizePath(rawPath) : null;
  if (!problem && !path) {
    problem =
      `${PATH_SETTING} (${rawPath}) isn't a Parameter Store path: it must start with /, use only letters, ` +
      `digits, _ . - and /, and not begin with aws or ssm.`;
  }
  // AWS's own keys (aws/ssm and friends) can be used by every managed
  // machine in the account: never lock service keys with one.
  if (!problem && /(^|:)alias\/aws\//i.test(kmsKeyId)) {
    problem =
      `${KMS_KEY_SETTING} names one of AWS's own keys (${kmsKeyId}), which every managed machine in the account ` +
      `can use. Name a key you set up for these secrets.`;
  }
  if (problem) {
    systemLogger.error(`agent-services: ${problem} Service keys can't be read or saved until it's fixed.`, {
      operation: "agent_services_key_store_misconfigured",
    });
    return misconfiguredKeyStore(problem);
  }

  const region = env[REGION_SETTING]?.trim() || DEFAULT_REGION;
  systemLogger.info("agent-services: service keys live in AWS Parameter Store", {
    operation: "agent_services_key_store_parameter_store",
    path,
    kmsKeyId,
    region,
  });
  return createParameterStoreKeyStore({ path: path!, kmsKeyId, client: makeClient(region) });
}
