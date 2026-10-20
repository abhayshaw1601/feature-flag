import type { Condition, FlagCreationOutput, FlagType } from "@flagforge/contracts";
import { FlagCreationError, type FlagCreationContext } from "./types";
import { validateFlagDraft } from "./validation";

type Fixture = {
  sentence: string;
  draft: FlagCreationOutput;
};

function fixture(
  sentence: string,
  key: string,
  name: string,
  type: FlagType,
  environmentKey: string,
  percent: number,
  conditions: Condition[] = [],
  assumptions: string[] = [],
  enabled = true,
): Fixture {
  return {
    sentence,
    draft: {
      key,
      name,
      type,
      description:
        key === "payments_kill_switch"
          ? "When enabled, stop payment processing. Initially disabled."
          : sentence,
      environments: [
        {
          environmentKey,
          enabled,
          rules: {
            rules: conditions.length
              ? [
                  {
                    id: `rule_${key}`,
                    description: "Requested target audience",
                    conditions,
                    serve: { rolloutPercent: percent },
                  },
                ]
              : [],
            defaultServe: { rolloutPercent: conditions.length ? 0 : percent },
          },
        },
      ],
      assumptions,
      warnings: ["Mock draft: deterministic fixture output, not a live model response."],
    },
  };
}

/**
 * The entire mock vocabulary: ten representative sentences, not an NL classifier.
 * Matching ignores case, repeated whitespace, and one terminal period only.
 * Required environment keys/attributes are visible in each draft. Sentence 10
 * requires allowProduction=true. These fixtures do not measure Gemini accuracy.
 */
export const flagCreationFixtures: readonly Fixture[] = [
  fixture(
    "Roll out new checkout to 10% of users in India on the pro plan, staging first.",
    "new_checkout",
    "New checkout",
    "RELEASE",
    "staging",
    10,
    [
      { attribute: "country", operator: "equals", values: ["IN"] },
      { attribute: "plan", operator: "equals", values: ["pro"] },
    ],
    [
      "Interpreted staging first as Staging only; Production left off.",
      "Interpreted India as the country code IN.",
    ],
  ),
  fixture(
    "Kill switch for payments",
    "payments_kill_switch",
    "Payments kill switch",
    "OPS",
    "staging",
    100,
    [],
    [
      "No environment was specified; selected Staging only.",
      "The application must implement stopping payments when this flag is true; the switch starts disabled.",
    ],
    false,
  ),
  fixture(
    "Enable the new search for everyone in development.",
    "new_search",
    "New search",
    "RELEASE",
    "development",
    100,
  ),
  fixture(
    "Roll out the new dashboard to 25% of users in staging.",
    "new_dashboard",
    "New dashboard",
    "RELEASE",
    "staging",
    25,
  ),
  fixture(
    "Enable beta reports for pro and enterprise plans in staging.",
    "beta_reports",
    "Beta reports",
    "PERMISSION",
    "staging",
    100,
    [{ attribute: "plan", operator: "in", values: ["pro", "enterprise"] }],
  ),
  fixture(
    "Enable priority support for enterprise customers in staging.",
    "priority_support",
    "Priority support",
    "PERMISSION",
    "staging",
    100,
    [{ attribute: "plan", operator: "equals", values: ["enterprise"] }],
  ),
  fixture(
    "Enable the onboarding experiment for 50% of users in staging.",
    "onboarding_experiment",
    "Onboarding experiment",
    "EXPERIMENT",
    "staging",
    50,
    [],
    [
      "This is a traffic gate only; experiment variants and metrics require separate configuration.",
    ],
  ),
  fixture(
    "Enable regional pricing for users in India or Canada in staging.",
    "regional_pricing",
    "Regional pricing",
    "RELEASE",
    "staging",
    100,
    [{ attribute: "country", operator: "in", values: ["IN", "CA"] }],
    ["Interpreted India and Canada as country codes IN and CA."],
  ),
  fixture(
    "Enable verbose logging for internal users in development.",
    "verbose_logging",
    "Verbose logging",
    "OPS",
    "development",
    100,
    [{ attribute: "isInternal", operator: "equals", values: [true] }],
  ),
  fixture(
    "Enable the status page for everyone in production.",
    "status_page",
    "Status page",
    "OPS",
    "production",
    100,
  ),
];

function canonicalSentence(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase();
}

export function generateMockFlagDraft(
  prompt: string,
  context: FlagCreationContext,
): FlagCreationOutput {
  const match = flagCreationFixtures.find(
    (candidate) => canonicalSentence(candidate.sentence) === canonicalSentence(prompt),
  );
  if (!match) throw new FlagCreationError("INSUFFICIENT_CONTEXT");
  const draft = structuredClone(match.draft);
  const existing = new Set(context.existingFlagKeys);
  for (let suffix = 2; existing.has(draft.key); suffix++)
    draft.key = `${match.draft.key}_${suffix}`;
  if (draft.key !== match.draft.key)
    draft.assumptions.push("Added a numeric suffix to avoid an existing or archived flag key.");
  if (
    draft.environments.some(
      (environment) =>
        !context.environments.some((known) => known.key === environment.environmentKey) ||
        environment.rules.rules.some((rule) =>
          rule.conditions.some(
            (condition) => !context.knownUserAttributes.includes(condition.attribute),
          ),
        ),
    )
  )
    throw new FlagCreationError("INSUFFICIENT_CONTEXT");
  return validateFlagDraft(draft, context, prompt);
}
