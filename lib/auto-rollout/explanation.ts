import { autoRolloutOutputSchema, type AutoRolloutOutput } from "@flagforge/contracts";
import type { RolloutDecision } from "./types";

export function deterministicExplanation(decision: RolloutDecision): AutoRolloutOutput {
  const explanation = decision.reasons.join(" ");
  return autoRolloutOutputSchema.parse({
    decision: decision.decision,
    explanation,
    breachedMetrics: decision.breachedMetrics,
    incidentNote:
      decision.decision === "ROLLBACK"
        ? `FlagForge Guard disabled the flag after a guardrail breach: ${decision.breachedMetrics.join(", ")}. ${explanation}`
        : decision.complete
          ? "Final healthy hold completed. No incident recorded."
          : "No rollback incident recorded.",
  });
}

function clean(value: string): string {
  return value
    .replace(/[#*0-9]\uFE0F?\u20E3/gu, "")
    .replace(
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u20E3\p{Cf}]/gu,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Optional Phase 4 boundary. An explainer never receives mutation authority or delays rollback. */
export async function explainRollout(
  decision: RolloutDecision,
  generate?: (facts: RolloutDecision) => Promise<unknown>,
): Promise<{ output: AutoRolloutOutput; source: "deterministic" | "generated" | "fallback" }> {
  const fallback = deterministicExplanation(decision);
  if (!generate) return { output: fallback, source: "deterministic" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      generate(structuredClone(decision)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Explanation timed out")), 3000);
      }),
    ]);
    const result = autoRolloutOutputSchema.safeParse(raw);
    if (!result.success) throw new Error("Invalid explanation");
    const output = result.data;
    if (
      output.decision !== decision.decision ||
      JSON.stringify([...output.breachedMetrics].sort()) !==
        JSON.stringify([...decision.breachedMetrics].sort())
    )
      throw new Error("Explanation contradicted the decision");
    output.explanation = clean(output.explanation).slice(0, 4000);
    output.incidentNote = clean(output.incidentNote).slice(0, 4000);
    if (!output.explanation || !output.incidentNote) throw new Error("Empty explanation");
    return { output, source: "generated" };
  } catch {
    return { output: fallback, source: "fallback" };
  } finally {
    clearTimeout(timer);
  }
}
