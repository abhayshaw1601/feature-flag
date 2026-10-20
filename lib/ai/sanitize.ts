import { AiError } from "./errors";

// Include full keycap, flag, modifier, tag, and ZWJ sequences; keep ordinary digits and #/*.
const emojiPattern =
  /[\d#*]\uFE0F?\u20E3|[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu;

export function sanitizeAiText(text: string): string {
  return text.replace(emojiPattern, "").trim();
}

/** Sanitize values, not keys: changing a key could change the meaning of a structured result. */
export function sanitizeAiOutput(value: unknown): unknown {
  if (typeof value === "string") return sanitizeAiText(value);
  if (Array.isArray(value)) return value.map(sanitizeAiOutput);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key.replace(emojiPattern, "") !== key) {
          throw new AiError(
            "AI_INVALID_OUTPUT",
            "The generated response contained an invalid field name.",
          );
        }
        return [key, sanitizeAiOutput(child)];
      }),
    );
  }
  return value;
}

/** Defense in depth, not a license to log raw prompts. Callers supply safe logInput metadata. */
export function redactAiLog(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeAiText(value)
      .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(
        /\b(?:AIza[\w-]{20,}|gh[pousr]_[\w]+|github_pat_[\w]+|ff_(?:server|client)_[\w-]+)/g,
        "[REDACTED]",
      );
  }
  if (Array.isArray(value)) return value.map(redactAiLog);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        /secret|token|password|authorization|cookie|api.?key|sdk.?key|private.?key/i.test(key)
          ? "[REDACTED]"
          : redactAiLog(child),
      ]),
    );
  }
  return value;
}
