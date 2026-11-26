/**
 * stt/setup.ts — speech to text's own setup: which provider, an optional
 * backup, a language, and the provider keys. Set in Admin → Services, never
 * shared with the app's voice features (those keep the server settings).
 *
 * agent-phone transcribes the callee's reply with this same setup
 * (loadSttEnv), so neither service touches voice's provider or keys.
 *
 * The setup is handed to the voice STT code in its server-settings shape
 * (STT_PROVIDER, STT_FALLBACK_PROVIDER, STT_LANGUAGE, <PROVIDER>_API_KEY),
 * built from scratch, so nothing leaks in from the real server settings.
 * No STT_MODEL: each provider uses its default model.
 */

import type { InstanceKeySpec, ServiceSettingSpec } from "../../engine/types.js";
import { STT_PROVIDER_IDS, STT_PROVIDER_LABELS } from "../../../voice/stt-provider.js";
import { getKeyStore } from "../../admin/key-store.js";
import { effectiveSettings } from "../../admin/settings-store.js";

const providerOptions = STT_PROVIDER_IDS.map((id) => ({
  value: id,
  label: id === "bedrock" ? "Amazon (uses the server's own AWS access, no key)" : STT_PROVIDER_LABELS[id],
}));

/** Pinned-language choices; auto-detect misreads very short clips. */
const LANGUAGES: ReadonlyArray<[string, string]> = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["sv", "Swedish"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
  ["hi", "Hindi"],
  ["ar", "Arabic"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
];

export const STT_SETTINGS: Record<string, ServiceSettingSpec> = {
  provider: {
    label: "Provider",
    description: "Who transcribes the audio.",
    options: providerOptions,
    required: true,
  },
  backup: {
    label: "Backup provider",
    description: "Tried when the provider fails or is slow to answer.",
    options: [{ value: "none", label: "None" }, ...providerOptions],
    default: "none",
  },
  language: {
    label: "Language",
    description: "Auto-detect, or one language for every file.",
    options: [{ value: "auto", label: "Auto-detect" }, ...LANGUAGES.map(([value, label]) => ({ value, label }))],
    default: "auto",
  },
};

/** Provider → the key it needs (Amazon needs none). */
export const STT_PROVIDER_KEYS: Partial<Record<string, string>> = {
  elevenlabs: "ELEVENLABS_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
};

const usesProvider = (id: string) => (s: Record<string, string>) =>
  s.provider === id || s.backup === id;

export const STT_SECRETS: Record<string, InstanceKeySpec> = {
  ELEVENLABS_API_KEY: {
    label: "ElevenLabs API key",
    description: "elevenlabs.io → Developers → API keys",
    neededWhen: usesProvider("elevenlabs"),
  },
  MISTRAL_API_KEY: {
    label: "Mistral API key",
    description: "console.mistral.ai → API keys",
    neededWhen: usesProvider("mistral"),
  },
  GROQ_API_KEY: {
    label: "Groq API key",
    description: "console.groq.com → API keys",
    neededWhen: usesProvider("groq"),
  },
};

/** The setup in the shape the voice STT code reads. */
export function sttEnv(
  settings: Record<string, string>,
  secrets: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { STT_PROVIDER: settings.provider ?? "" };
  if (settings.backup && settings.backup !== "none") env.STT_FALLBACK_PROVIDER = settings.backup;
  if (settings.language && settings.language !== "auto") env.STT_LANGUAGE = settings.language;
  for (const name of Object.keys(STT_SECRETS)) {
    if (secrets[name]) env[name] = secrets[name];
  }
  return env;
}

/**
 * The stt service's current setup, read from the stores, for callers that
 * aren't the stt service itself (agent-phone). Null when no provider is
 * picked yet.
 */
export async function loadSttEnv(): Promise<NodeJS.ProcessEnv | null> {
  const settings = await effectiveSettings("stt", STT_SETTINGS);
  if (!settings.provider) return null;
  const store = getKeyStore();
  const secrets: Record<string, string> = {};
  for (const name of Object.keys(STT_SECRETS)) {
    const value = await store.get("stt", name);
    if (value) secrets[name] = value;
  }
  return sttEnv(settings, secrets);
}
