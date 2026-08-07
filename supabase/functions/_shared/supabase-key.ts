import { HttpError } from "./cors.ts";

interface DenoEnvLike {
  env?: {
    get(name: string): string | undefined;
  };
}

function readEnv(name: string) {
  const deno = (globalThis as typeof globalThis & { Deno?: DenoEnvLike }).Deno;
  return deno?.env?.get(name);
}

function unavailableKey(): never {
  throw new HttpError("Server authentication is unavailable.", 500);
}

function defaultKeyFromDictionary(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unavailableKey();
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return unavailableKey();
  }

  const key = (parsed as Record<string, unknown>).default;
  if (typeof key !== "string" || !key) {
    return unavailableKey();
  }
  return key;
}

export function resolveSupabaseKey(dictionaryName: string, directNames: readonly string[]) {
  const dictionary = readEnv(dictionaryName);
  if (dictionary !== undefined) {
    return defaultKeyFromDictionary(dictionary);
  }

  for (const directName of directNames) {
    const directKey = readEnv(directName);
    if (directKey) {
      return directKey;
    }
  }

  return unavailableKey();
}
