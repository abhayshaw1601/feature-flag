export interface SdkOptions {
  baseUrl: string;
  sdkKey: string;
  keyType: "SERVER";
}

export type Environment =
  | { ok: true; options: SdkOptions; flagKey: string }
  | { ok: false; message: string };

export function readEnvironment(env: Record<string, string | undefined>): Environment {
  const sdkKey = env.FLAGFORGE_SDK_KEY?.trim();
  if (!sdkKey || /^(?:replace[_-]|your[_-]|<)/i.test(sdkKey)) {
    return {
      ok: false,
      message:
        "Set FLAGFORGE_SDK_KEY to a server key in this example's .env.local, then restart it.",
    };
  }
  if (sdkKey.length > 512 || /\s/.test(sdkKey)) {
    return {
      ok: false,
      message: "FLAGFORGE_SDK_KEY is invalid. Replace it and restart the example.",
    };
  }

  let baseUrl: string;
  try {
    const url = new URL(env.FLAGFORGE_URL ?? "http://localhost:3000");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid URL");
    }
    baseUrl = url.toString().replace(/\/$/, "");
  } catch {
    return {
      ok: false,
      message: "Set FLAGFORGE_URL to an HTTP(S) URL without credentials, a query, or a fragment.",
    };
  }

  const flagKey = env.FLAGFORGE_FLAG_KEY ?? "checkout_refresh";
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(flagKey)) {
    return {
      ok: false,
      message:
        "FLAGFORGE_FLAG_KEY must be 1–80 lowercase letters, digits, or underscores, starting with a letter.",
    };
  }

  return { ok: true, options: { baseUrl, sdkKey, keyType: "SERVER" }, flagKey };
}
